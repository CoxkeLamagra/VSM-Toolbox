const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
let state,
  view = 'streams',
  selected = null,
  saveForm,
  session = {},
  accounts = [],
  updateStatus = {},
  updateTimer;
let brandSettings = {},
  brandDefaults = {};
let backupState = { backups: [], operation: {} };
let streamMode = 'diagram',
  diagramController = null;
const canEdit = () => ['Admin', 'Editor'].includes(session.environment?.role);
const environmentAdmin = () => session.environment?.role === 'Admin';
const MAINTENANCE_BUSY = new Set([
  'queued',
  'checking',
  'downloading',
  'installing',
  'restarting',
  'backing-up',
  'restoring',
  'cleaning',
  'clearing',
]);
const EDIT_ACTIONS = new Set([
  'new-stream',
  'edit-stream',
  'new-step',
  'edit-step',
  'new-process',
  'import-bpmn',
  'link',
  'delete-stream',
  'delete-step',
  'delete-process',
]);
async function readResponse(response) {
  let body;
  try {
    body = JSON.parse(await response.text());
  } catch {
    throw new Error(
      `Server returned an unexpected response (HTTP ${response.status}). The application may be restarting or a proxy may be unavailable. Try again shortly.`,
    );
  }
  return body;
}
function pollMaintenance() {
  const pollingView = view;
  clearTimeout(updateTimer);
  updateTimer = setTimeout(async () => {
    if (view !== pollingView || !session.user) return;
    try {
      await refresh();
    } catch (e) {
      if (view === pollingView && session.user) {
        error(e);
        pollMaintenance();
      }
    }
  }, 2000);
}
async function refreshMaintenance() {
  // Poll even if this first read overlaps an update or restore restart.
  pollMaintenance();
  try {
    await refresh();
  } catch (e) {
    error(e);
  }
}
async function api(path, method = 'GET', data) {
  const r = await fetch('/api/' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(session.csrf_token ? { 'X-CSRF-Token': session.csrf_token } : {}),
      ...(session.environment ? { 'X-Environment-ID': String(session.environment.id) } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await readResponse(r);
  if (!r.ok) {
    if (r.status === 401 && session.user) {
      session = {};
      pcfImportState = null;
      state = null;
      $('#editor').close();
      render();
    }
    throw new Error(body.error || 'Request failed');
  }
  return body;
}
function error(e) {
  $('#error').textContent = e.message;
  $('#error').hidden = false;
  setTimeout(() => ($('#error').hidden = true), 7000);
}
async function refresh() {
  const brandResponse = await api('branding');
  brandSettings = brandResponse.branding;
  brandDefaults = brandResponse.defaults;
  session = await api('session');
  if (!session.user) {
    state = null;
    applyBranding();
    render();
    return;
  }
  environmentList = await api('environments');
  if (!canAccessView(view)) view = session.environment ? 'streams' : 'environments';
  state = session.environment ? await api('data') : null;
  applyBranding();
  await VIEWS[view].load?.();
  render();
}
const steps = (id) =>
  state.steps
    .filter((s) => s.stream_id === id)
    .sort((a, b) => a.position - b.position || a.id - b.id);
const duration = (n) => `${Number(n.toFixed(1))} min`;
// One registry owns page access, optional loading, rendering, and navigation.
const VIEWS = {
  streams: { render: renderContent },
  environments: {
    render: renderEnvironments,
    load: async () => {
      environmentMembers = environmentAdmin()
        ? await api('environments/' + session.environment.id + '/members')
        : [];
    },
  },
  processes: { render: renderContent },
  pcf: { render: renderPCF },
  tags: { environmentAdminOnly: true, render: renderTags },
  branding: { adminOnly: true, render: renderBranding },
  maintenance: {
    adminOnly: true,
    render: renderDataManagement,
    load: async () => {
      maintenanceState = await api('maintenance');
    },
  },
  accounts: {
    adminOnly: true,
    render: renderAccounts,
    load: async () => {
      accounts = await api('users');
    },
  },
  backups: {
    adminOnly: true,
    render: renderBackups,
    load: async () => {
      backupState = await api('backups');
    },
  },
  updates: {
    adminOnly: true,
    render: renderUpdates,
    load: async () => {
      updateStatus = await api('updates');
    },
  },
};
function canAccessView(name) {
  const page = VIEWS[name];
  if (!page || !session.user) return false;
  if (page.adminOnly) return session.user.role === 'Admin';
  if (page.environmentAdminOnly) return environmentAdmin();
  return name === 'environments' || Boolean(session.environment);
}
function navigationButton(name) {
  return $(name === 'processes' ? '#processNav' : '#' + name + 'Nav');
}
function navigate(nextView) {
  view = canAccessView(nextView) ? nextView : 'environments';
  selected = null;
  if (VIEWS[view].adminOnly || VIEWS[view].environmentAdminOnly || view === 'environments')
    refresh().catch(error);
  else render();
}
function syncThemeStylesheet() {
  const signature = JSON.stringify([
    brandSettings.primary,
    brandSettings.sidebar,
    brandSettings.background,
    (state?.tags || []).map((tag) => [tag.id, tag.color]),
  ]);
  // A bounded cache key avoids a growing URL as the tag catalog expands.
  let hash = 2166136261;
  for (let i = 0; i < signature.length; i++)
    hash = Math.imul(hash ^ signature.charCodeAt(i), 16777619);
  const href = '/branding.css?v=' + (hash >>> 0).toString(16);
  if ($('#brandingStyles').getAttribute('href') !== href) $('#brandingStyles').href = href;
}
function formValues(form) {
  const data = Object.fromEntries(new FormData(form));
  if (data._tag_picker) {
    data.tag_ids = Object.keys(data)
      .filter((key) => key.startsWith('_tag_') && key !== '_tag_picker')
      .map((key) => Number(key.slice(5)));
    for (const key of Object.keys(data)) if (key.startsWith('_tag_')) delete data[key];
  }
  if (data._pcf_picker) {
    data.pcf_ids = Object.keys(data)
      .filter((key) => key.startsWith('_pcf_') && key !== '_pcf_picker')
      .map((key) => Number(key.slice(5)));
    for (const key of Object.keys(data)) if (key.startsWith('_pcf_')) delete data[key];
  }
  return data;
}
function stats(items) {
  const work = items.reduce((n, s) => n + s.work_minutes, 0),
    wait = items.reduce((n, s) => n + s.wait_minutes, 0);
  return /* HTML */ `
    <div class="stats">
      <div class="stat">
        <div class="label">Total lead time</div>
        <strong>${duration(work + wait)}</strong>
        <span>Work time + waiting time</span>
      </div>
      <div class="stat">
        <div class="label">Work time</div>
        <strong>${duration(work)}</strong>
        <span>Time spent actively delivering</span>
      </div>
      <div class="stat">
        <div class="label">Flow efficiency</div>
        <strong>${work + wait ? Math.round((work / (work + wait)) * 100) : 0}%</strong>
        <span>Work time / total lead time</span>
      </div>
    </div>
  `;
}
let environmentList = [],
  environmentMembers = [];
function resetEnvironmentView() {
  selected = null;
  pcfFocus = null;
  pcfImportState = null;
  pcfImportOpen = false;
  streamMode = 'diagram';
}
async function switchEnvironment(id) {
  await api('environments/' + id + '/switch', 'POST', {});
  resetEnvironmentView();
  await refresh();
}
function editEnvironment(id) {
  const entry = environmentList.find((environment) => environment.id === id) || {};
  modal(
    id ? 'Edit environment' : 'Create environment',
    field('name', 'Environment name', entry.name) +
      field('description', 'Description', entry.description, 'textarea'),
    async (data) => {
      await api('environments' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data);
      if (!id) resetEnvironmentView();
      view = 'environments';
    },
  );
}
function renderEnvironments() {
  const active = environmentList.find((environment) => environment.id === session.environment?.id);
  $('#breadcrumb').textContent = 'Environments';
  const countLabels = {
    streams: 'Value streams',
    steps: 'Delivery steps',
    processes: 'Processes',
    pcf_entries: 'PCF entries',
    tags: 'Tags',
    members: 'Members',
  };
  $('#content').innerHTML =
    `<div class="eyebrow">ENVIRONMENT MANAGEMENT</div><div class="title-row"><div><h1>Environments</h1><p>Separate your value streams, processes, PCF classifications, and tags into independent workspaces.</p></div><button class="primary" data-action="new-environment">+ Create environment</button></div>${
      active
        ? `<section class="environment-dashboard"><div class="section-row"><div><span class="pill">Current environment · ${esc(active.role)}</span><h2>${esc(active.name)}</h2><p>${esc(active.description)}</p></div>${active.role === 'Admin' ? `<div class="detail-actions"><button data-action="edit-environment" data-id="${active.id}">Edit environment</button><button class="danger" data-action="delete-environment" data-id="${active.id}">Delete environment</button></div>` : ''}</div><div class="environment-counts">${Object.entries(
            countLabels,
          )
            .map(
              ([key, label]) =>
                `<div class="stat"><span>${label}</span><strong>${active.counts[key]}</strong></div>`,
            )
            .join(
              '',
            )}</div><div class="detail-actions"><button data-action="environment-content" data-target="streams">Value streams</button><button data-action="environment-content" data-target="processes">Processes</button><button data-action="environment-content" data-target="pcf">PCF framework</button></div></section>`
        : '<div class="empty"><h2>Create your first environment</h2><p>Its creator becomes the environment Admin and can invite existing local accounts.</p></div>'
    }<div class="section-row"><h2>Your environments</h2><span class="label">${environmentList.length} environments</span></div><div class="grid">${environmentList.map((environment) => `<article class="environment-card"><span class="pill">${esc(environment.role)}${environment.id === active?.id ? ' · Active' : ''}</span><h3>${esc(environment.name)}</h3><p>${esc(environment.description || 'An independent local workspace.')}</p><p>${environment.counts.streams} value streams · ${environment.counts.processes} processes · ${environment.counts.pcf_entries} PCF entries</p><button data-action="switch-environment" data-id="${environment.id}" ${environment.id === active?.id ? 'disabled' : ''}>Switch environment</button></article>`).join('')}</div>${active?.role === 'Admin' ? `<section class="environment-members"><h2>Environment members</h2><p>Add existing local accounts and set their role in this environment.</p><form id="addEnvironmentMember"><label>Local username<input name="username" aria-label="Local username" required maxlength="64"></label><label>Environment role<select name="role" aria-label="Environment role"><option>Viewer</option><option>Editor</option><option>Admin</option></select></label><button type="submit">Add member</button></form><div class="table-wrap"><table><thead><tr><th>Username</th><th>Environment role</th><th>Actions</th></tr></thead><tbody>${environmentMembers.map((member) => `<tr><td>${esc(member.username)}</td><td>${esc(member.role)}</td><td><button data-action="edit-environment-member" data-id="${member.user_id}">Edit role</button><button class="danger" data-action="remove-environment-member" data-id="${member.user_id}">Remove member</button></td></tr>`).join('')}</tbody></table></div><p class="hint">The last environment Admin cannot be removed or demoted. Application accounts and other environments are unaffected by membership changes.</p></section>` : ''}`;
  if (active?.role === 'Admin')
    $('#addEnvironmentMember').onsubmit = async (event) => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      try {
        await api(
          'environments/' + active.id + '/members',
          'POST',
          Object.fromEntries(new FormData(event.target)),
        );
        await refresh();
      } catch (e) {
        error(e);
        button.disabled = false;
      }
    };
}

function renderContent() {
  $('#breadcrumb').textContent =
    view === 'processes' ? 'Process library' : selected ? 'Value stream map' : 'Value streams';
  if (view === 'processes') return renderProcesses();
  if (selected) return renderStream();
  $('#content').innerHTML = /* HTML */ `
    <div class="eyebrow">SEE THE BIGGER PICTURE</div>
    <div class="title-row">
      <div>
        <h1>Value streams</h1>
        <p>Connect the work you do to the value your customers receive.</p>
      </div>
      <button class="primary" data-action="new-stream">+ Create value stream</button>
    </div>
    <div class="stats">
      <div class="stat">
        <div class="label">Value streams</div>
        <strong>${state.streams.length}</strong>
        <span>Customer journeys mapped</span>
      </div>
      <div class="stat">
        <div class="label">Delivery steps</div>
        <strong>${state.steps.length}</strong>
        <span>Across your value streams</span>
      </div>
      <div class="stat">
        <div class="label">Processes</div>
        <strong>${state.processes.length}</strong>
        <span>In your process library</span>
      </div>
    </div>
    <div class="section-row">
      <h2>Your value streams</h2>
      <span class="label">${state.streams.length} streams</span>
    </div>
    ${state.streams.length
      ? /* HTML */ `
          <div class="grid">
            ${state.streams
              .map(
                (s) => /* HTML */ `
                  <article class="stream-card" data-action="open-stream" data-id="${s.id}">
                    <div class="card-head">
                      <span
                        class="icon ${assignedTags(s)[0]
                          ? 'tagged-icon tag-color-' + assignedTags(s)[0].id
                          : ''}"
                      >
                        ▱
                      </span>
                      <span class="pill">${steps(s.id).length} steps</span>
                    </div>
                    <div>
                      <h3>${esc(s.name)}</h3>
                      <p>
                        ${esc(
                          s.outcome || s.description || 'Define the outcome this stream delivers.',
                        )}
                      </p>
                      ${tagBadges(s)}
                    </div>
                    <div class="card-meta">
                      <span>${esc(s.customer || 'Customer not defined')}</span>
                      <button class="text-button" data-action="open-stream" data-id="${s.id}">
                        Open map →
                      </button>
                    </div>
                  </article>
                `,
              )
              .join('')}
          </div>
        `
      : /* HTML */ `
          <div class="empty">
            <span class="icon">▱</span>
            <h2>Start with a customer outcome</h2>
            <p>
              Map how your team turns a request into a valuable service.
              <br />
              Try employee onboarding, incident resolution, or a cloud service request.
            </p>
            <button class="primary" data-action="new-stream">+ Create your first stream</button>
          </div>
        `}
  `;
}
function renderStream() {
  const stream = state.streams.find((s) => s.id === selected);
  if (!stream) {
    selected = null;
    return render();
  }
  const items = steps(selected);
  const flowMarkup = /* HTML */ `
    <div class="canvas">
      <div class="flow">
        ${items.length
          ? items
              .map(
                (s, i) =>
                  `${i ? '<div class="arrow">→</div>' : ''}<article class="step" draggable="true" data-id="${s.id}"><div class="step-number">STEP ${String(i + 1).padStart(2, '0')} · DRAG TO REORDER</div><h3>${esc(s.name)}</h3><p>${esc(s.owner || 'No owner assigned')}</p>${tagBadges(s)}<div class="timing"><div>Work time<b>${duration(s.work_minutes)}</b></div><div>Wait time<b>${duration(s.wait_minutes)}</b></div></div>${state.step_processes
                    .filter((l) => l.step_id === s.id)
                    .map(
                      (l) => /* HTML */ `
                        <div class="linked">
                          ☷ ${esc(state.processes.find((p) => p.id === l.process_id)?.name)}
                        </div>
                      `,
                    )
                    .join(
                      '',
                    )}<div class="step-actions"><button class="text-button" data-action="edit-step" data-id="${s.id}">Edit</button><button class="text-button" data-action="link" data-id="${s.id}">Link processes</button><button class="text-button danger" data-action="delete-step" data-id="${s.id}" aria-label="Delete ${esc(s.name)}">×</button></div></article>`,
              )
              .join('')
          : '<p>No steps yet. Add the first activity in your service delivery journey.</p>'}
        <div class="arrow">→</div>
        <button data-action="new-step">+ Add step</button>
      </div>
    </div>
    <p class="hint">
      Drag cards to change the sequence. Link reusable processes to explain how each step is
      delivered. All times are measured in minutes.
    </p>
  `;
  $('#content').innerHTML = /* HTML */ `
    <button class="text-button" data-action="back">← All value streams</button>
    <div class="title-row">
      <div>
        <h1>${esc(stream.name)}</h1>
        <p>
          ${esc(stream.description || 'Follow the journey from customer need to delivered value.')}
        </p>
        ${tagBadges(stream)}
      </div>
      <div class="detail-actions">
        <button data-action="edit-stream">Edit details</button>
        <button class="primary" data-action="new-step">+ Add step</button>
        <button class="danger" data-action="delete-stream">Delete</button>
      </div>
    </div>
    <div class="context">
      <div>
        <b>CUSTOMER / BENEFICIARY</b>
        ${esc(stream.customer || 'Not defined')}
      </div>
      <div>
        <b>DESIRED VALUE</b>
        ${esc(stream.outcome || 'Not defined')}
      </div>
    </div>
    ${stats(items)}
    <div class="section-row">
      <h2>${streamMode === 'diagram' ? 'Value stream diagram' : 'Delivery flow'}</h2>
      <div class="view-switch" role="group" aria-label="Stream view">
        <button data-action="diagram-view" aria-pressed="${streamMode === 'diagram'}">
          Diagram
        </button>
        <button data-action="flow-view" aria-pressed="${streamMode === 'flow'}">Edit flow</button>
      </div>
    </div>
    ${streamMode === 'diagram' ? diagramShell(items) : flowMarkup} ${pcfStreamLinks(stream)}
    <section class="voc-panel" aria-label="Voice of the Customer">
      <div class="section-row">
        <h2>Voice of the Customer (VOC)</h2>
        ${canEdit()
          ? '<button class="text-button" data-action="edit-stream">' +
            (stream.voc ? 'Edit customer request' : 'Add customer request') +
            '</button>'
          : ''}
      </div>
      <p>${esc(stream.voc || 'No customer request recorded yet.')}</p>
    </section>
  `;
  if (streamMode === 'diagram' && items.length)
    diagramController = new StreamDiagram($('#streamDiagram'), items);
}
let bpmnProcessId = null;
function importBPMN(id) {
  const process = state.processes.find((p) => p.id === id);
  modal(
    process ? 'Replace BPMN diagram' : 'Import BPMN process',
    (process
      ? `<p>Replace the diagram for ${esc(process.name)}. Process links and tags are retained.</p>`
      : field('name', 'Process name')) +
      '<label>BPMN XML file<input id="bpmnFile" type="file" accept=".bpmn,.xml,text/xml,application/xml" required></label><p>Up to 256 KiB. Imports diagram data only; no workflow execution.</p>',
    async (values) => {
      const file = $('#bpmnFile').files[0];
      if (!file || file.size > 262144)
        throw new Error('Choose a BPMN XML file of at most 256 KiB.');
      const bpmn_xml = await file.text();
      const result = await api(
        'processes' + (process ? '/' + process.id : ''),
        process ? 'PUT' : 'POST',
        process
          ? { bpmn_xml }
          : { name: values.name || file.name.replace(/\.(bpmn|xml)$/i, ''), bpmn_xml },
      );
      bpmnProcessId = process?.id || result.id;
    },
  );
}
function bpmnTextLines(text, width, maxLines, measure) {
  const lines = [];
  let line = '';
  for (const word of String(text).trim().split(/\s+/)) {
    if (line && measure(line + ' ' + word) <= width) {
      line += ' ' + word;
      continue;
    }
    if (line) lines.push(line);
    line = '';
    for (const character of word) {
      if (line && measure(line + character) > width) {
        lines.push(line);
        line = '';
      }
      line += character;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && measure(last + '…') > width) last = Array.from(last).slice(0, -1).join('');
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}
function bpmnMarkup(process) {
  if (!process?.bpmn) return '';
  const { nodes, edges, omitted_flows } = process.bpmn;
  const context = document.createElement('canvas').getContext('2d');
  context.font = '12px sans-serif';
  const measure = (text) => context.measureText(text).width;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const routes = edges.map((edge) => {
    if (edge.waypoints.length) return edge.waypoints;
    const a = byId.get(edge.source),
      b = byId.get(edge.target);
    const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const dx = end.x - start.x,
      dy = end.y - start.y;
    const from = Math.max(Math.abs(dx) / (a.width / 2), Math.abs(dy) / (a.height / 2), 1);
    const to = Math.max(Math.abs(dx) / (b.width / 2), Math.abs(dy) / (b.height / 2), 1);
    return [
      { x: start.x + dx / from, y: start.y + dy / from },
      { x: end.x - dx / to, y: end.y - dy / to },
    ];
  });
  const segments = routes.flatMap((points) =>
    points.slice(1).map((end, index) => ({ start: points[index], end })),
  );
  const labels = [];
  const overlap = (a, b) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const place = (text, candidates, width = 150) => {
    if (!text.trim()) return '';
    const lines = bpmnTextLines(text, width, 4, measure);
    const box = { width: Math.max(...lines.map(measure)) + 8, height: lines.length * 16 + 4 };
    const boxes = candidates.map((point, index) => {
      const candidate = { x: point.x - box.width / 2, y: point.y - box.height / 2, ...box };
      // Prefer clear space around nodes and previously placed labels. Penalize
      // flow crossings too, using their bounding boxes with a small stroke margin.
      const cost =
        nodes.reduce(
          (sum, node) =>
            sum +
            overlap(candidate, {
              x: node.x - 5,
              y: node.y - 5,
              width: node.width + 10,
              height: node.height + 10,
            }) *
              100,
          0,
        ) +
        labels.reduce((sum, label) => sum + overlap(candidate, label) * 20, 0) +
        segments.reduce(
          (sum, { start, end }) =>
            sum +
            overlap(candidate, {
              x: Math.min(start.x, end.x) - 2,
              y: Math.min(start.y, end.y) - 2,
              width: Math.abs(end.x - start.x) + 4,
              height: Math.abs(end.y - start.y) + 4,
            }),
          0,
        ) +
        index * 0.01;
      return { candidate, cost };
    });
    boxes.sort((a, b) => a.cost - b.cost);
    const boxPosition = boxes[0].candidate;
    labels.push(boxPosition);
    const x = boxPosition.x + boxPosition.width / 2;
    return `<text class="bpmn-external-label" x="${x}" y="${boxPosition.y + 14}" text-anchor="middle"><title>${esc(text)}</title>${lines.map((line, index) => `<tspan x="${x}" dy="${index ? 16 : 0}">${esc(line)}</tspan>`).join('')}</text>`;
  };
  const externalLabels = [];
  const shapes = nodes
    .map((node) => {
      const x = node.x + node.width / 2,
        y = node.y + node.height / 2;
      const event = node.kind.endsWith('Event'),
        gateway = node.kind.endsWith('Gateway');
      let shape;
      if (event)
        shape = `<ellipse cx="${x}" cy="${y}" rx="${node.width / 2}" ry="${node.height / 2}" stroke-width="${node.kind === 'endEvent' ? 4 : 2}"/>`;
      else if (gateway)
        shape = `<polygon points="${x},${node.y} ${node.x + node.width},${y} ${x},${node.y + node.height} ${node.x},${y}"/>`;
      else
        shape = `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="10"/>`;
      let text = '';
      if (event || gateway) {
        const candidates = [];
        for (const gap of [28, 48, 68, 88]) {
          const above = { x, y: node.y - gap },
            below = { x, y: node.y + node.height + gap };
          candidates.push(...(gateway ? [above, below] : [below, above]));
        }
        externalLabels.push(place(node.name, candidates));
        const marker = {
          exclusiveGateway: '×',
          parallelGateway: '+',
          inclusiveGateway: '○',
          eventBasedGateway: '◇',
          complexGateway: '*',
        }[node.kind];
        if (marker)
          text = `<text class="bpmn-gateway-marker" x="${x}" y="${y}" dominant-baseline="central" text-anchor="middle">${marker}</text>`;
      } else {
        const lines = bpmnTextLines(
          node.name,
          Math.max(8, node.width - 20),
          Math.max(1, Math.floor((node.height - 16) / 16)),
          measure,
        );
        text = `<text class="bpmn-task-label" x="${x}" y="${y - lines.length * 8 + 12}" text-anchor="middle">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? 16 : 0}">${esc(line)}</tspan>`).join('')}</text>`;
      }
      return `<g class="bpmn-node"><title>${esc(node.kind + ': ' + node.name)}</title>${shape}${text}</g>`;
    })
    .join('');
  const flows = edges
    .map((edge, index) => {
      const points = routes[index];
      const path = points.map((point, i) => `${i ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ');
      const candidates = points
        .slice(1)
        .map((end, i) => ({ start: points[i], end }))
        .sort(
          (a, b) =>
            Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y) -
            Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y),
        )
        .flatMap(({ start, end }) => {
          const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.y - start.y);
          return [18, -18, 36, -36, 54, -54].map((offset) => ({
            x: (start.x + end.x) / 2 + (horizontal ? 0 : offset),
            y: (start.y + end.y) / 2 + (horizontal ? -offset : 0),
          }));
        });
      externalLabels.push(place(edge.name, candidates, 120));
      return `<path d="${path}" fill="none" stroke="#64748b" stroke-width="2" ${edge.kind === 'messageFlow' ? 'stroke-dasharray="6 4"' : ''} marker-end="url(#bpmnArrow)"/>`;
    })
    .join('');
  const bounds = [
    ...nodes,
    ...labels,
    ...routes.flat().map((point) => ({ ...point, width: 0, height: 0 })),
  ];
  const left = Math.min(...bounds.map((box) => box.x)) - 24;
  const top = Math.min(...bounds.map((box) => box.y)) - 24;
  const width = Math.max(...bounds.map((box) => box.x + box.width)) - left + 24;
  const height = Math.max(...bounds.map((box) => box.y + box.height)) - top + 24;
  return `<section class="bpmn-panel"><h2>${esc(process.name)} · BPMN</h2><p>Scroll or drag to pan. Adjust zoom to inspect the diagram. Pools, lanes, and extension graphics are not displayed; nested subprocess nodes are shown together.</p>${omitted_flows ? `<p>${omitted_flows} flow(s) to unsupported elements omitted.</p>` : ''}<label>Diagram zoom <input id="bpmnZoom" aria-label="Diagram zoom" type="range" min="25" max="200" value="100"></label><div id="bpmnCanvas" class="bpmn-canvas" tabindex="0" aria-label="BPMN process diagram"><svg role="img" aria-label="${esc(process.name)} BPMN diagram" viewBox="${left} ${top} ${width} ${height}" width="${width}" height="${height}" data-width="${width}" data-height="${height}"><defs><marker id="bpmnArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"/></marker></defs>${flows}${shapes}<g class="bpmn-labels">${externalLabels.join('')}</g></svg></div></section>`;
}
function renderProcesses() {
  $('#content').innerHTML = /* HTML */ `
    <div class="eyebrow">MAKE DELIVERY REPEATABLE</div>
    <div class="title-row">
      <div>
        <h1>Process library</h1>
        <p>Document how your services are delivered, then connect processes to your maps.</p>
      </div>
      <div class="detail-actions">
        <button data-action="import-bpmn">Import BPMN XML</button>
        <button class="primary" data-action="new-process">+ Create process</button>
      </div>
    </div>
    ${bpmnMarkup(state.processes.find((p) => p.id === bpmnProcessId))}
    ${state.processes.length
      ? /* HTML */ `
          <div class="grid">
            ${state.processes
              .map(
                (p) => /* HTML */ `
                  <article class="process-card">
                    <div class="card-head">
                      <span class="icon">☷</span>
                      <span class="pill">
                        ${state.step_processes.filter((l) => l.process_id === p.id).length} linked
                        steps
                      </span>
                    </div>
                    <div>
                      <h3>${esc(p.name)}</h3>
                      <p>${esc(p.description || 'No description yet')}</p>
                      ${tagBadges(p)}
                    </div>
                    <div class="detail-actions">
                      ${p.bpmn
                        ? `<button data-action="view-bpmn" data-id="${p.id}">View BPMN diagram</button>`
                        : ''}
                      <button data-action="import-bpmn" data-id="${p.id}">
                        ${p.bpmn ? 'Replace' : 'Import'} BPMN XML
                      </button>
                    </div>
                    <div class="card-meta">
                      <span>${esc(p.owner || 'No owner assigned')}</span>
                      <button class="text-button" data-action="edit-process" data-id="${p.id}">
                        View / edit →
                      </button>
                    </div>
                    <button
                      class="text-button danger"
                      data-action="delete-process"
                      data-id="${p.id}"
                    >
                      Delete process
                    </button>
                  </article>
                `,
              )
              .join('')}
          </div>
        `
      : '<div class="empty"><h2>Your shared process library</h2><p>Create processes such as incident triage, change approval, or access provisioning.<br>A process can support multiple steps across value streams.</p></div>'}
  `;
  const canvas = $('#bpmnCanvas');
  if (canvas) {
    $('#bpmnZoom').oninput = (event) => {
      const svg = canvas.querySelector('svg'),
        scale = Number(event.target.value) / 100;
      svg.setAttribute('width', Number(svg.dataset.width) * scale);
      svg.setAttribute('height', Number(svg.dataset.height) * scale);
    };
    let drag;
    canvas.onpointerdown = (event) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
      canvas.setPointerCapture(event.pointerId);
    };
    canvas.onpointermove = (event) => {
      if (!drag) return;
      canvas.scrollLeft = drag.left - event.clientX + drag.x;
      canvas.scrollTop = drag.top - event.clientY + drag.y;
    };
    canvas.onpointerup = canvas.onpointercancel = () => {
      drag = null;
    };
  }
}
const field = (name, label, value = '', type = 'text') => /* HTML */ `
  <label>
    ${label}${type === 'textarea'
      ? /* HTML */ `
          <textarea name="${name}" aria-label="${esc(label)}">${esc(value)}</textarea>
        `
      : /* HTML */ `
          <input
            name="${name}"
            type="${type}"
            value="${esc(value)}"
            ${name === 'name' ? 'required maxlength="200"' : ''}
            ${type === 'number' ? 'min="0" step="any" required' : ''}
          />
        `}
  </label>
`;
function modal(title, html, save, readOnly = false) {
  $('#dialogTitle').textContent = title;
  $('#fields').innerHTML = html;
  saveForm = readOnly ? null : save;
  $('#form button[type="submit"]').hidden = readOnly;
  if (readOnly)
    $('#fields')
      .querySelectorAll('input,textarea,select')
      .forEach((el) => (el.disabled = true));
  $('#editor').showModal();
}
function assignedTags(entity) {
  return (state.tags || [])
    .filter((t) => (entity.tag_ids || []).includes(t.id))
    .sort(
      (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id,
    );
}
function tagBadges(entity) {
  const badges = assignedTags(entity).map((tag) => {
    const category =
      state.tag_categories.find((item) => item.id === tag.category_id)?.name || 'Uncategorized';
    return `<span class="tag-badge tag-color-${tag.id}" title="${esc(category)}">${esc(tag.name)}</span>`;
  });
  return `<div class="tag-badges">${badges.join('')}</div>`;
}
function tagPicker(entity) {
  const groups = [
    ...state.tag_categories.map((c) => ({ id: c.id, name: c.name })),
    { id: null, name: 'Uncategorized' },
  ];
  return /* HTML */ `
    <fieldset class="tag-picker">
      <legend>Tags</legend>
      <input type="hidden" name="_tag_picker" value="1" />
      ${groups
        .map((c) => {
          const tags = state.tags
            .filter((t) => t.category_id === c.id)
            .sort((a, b) => a.name.localeCompare(b.name));
          return tags.length
            ? /* HTML */ `
                <div class="tag-group">
                  <b>${esc(c.name)}</b>
                  ${tags
                    .map(
                      (t) => /* HTML */ `
                        <label class="check">
                          <input
                            type="checkbox"
                            name="_tag_${t.id}"
                            ${(entity.tag_ids || []).includes(t.id) ? 'checked' : ''}
                          />
                          <span class="tag-badge tag-color-${t.id}">${esc(t.name)}</span>
                        </label>
                      `,
                    )
                    .join('')}
                </div>
              `
            : '';
        })
        .join('') || '<p>No tags available. An Admin can create tags under Tags & categories.</p>'}
    </fieldset>
  `;
}
function renderTags() {
  $('#breadcrumb').textContent = 'Administrator / Tags & categories';
  $('#content').innerHTML = /* HTML */ `
    <div class="eyebrow">ADMINISTRATOR</div>
    <div class="title-row">
      <div>
        <h1>Tags & categories</h1>
        <p>
          Manage tags and categories for ${esc(session.environment.name)}. Names are unique within
          this environment. Environment Admins manage this catalog; Admins and Editors can assign
          tags to streams, steps, and processes.
        </p>
      </div>
      <div class="detail-actions">
        <button data-action="new-category">+ Create category</button>
        <button class="primary" data-action="new-tag">+ Create tag</button>
      </div>
    </div>
    ${[...state.tag_categories, { id: null, name: 'Uncategorized' }]
      .map(
        (c) => /* HTML */ `
          <section class="tag-management">
            <div class="section-row">
              <h2>${esc(c.name)}</h2>
              ${c.id
                ? /* HTML */ `
                    <div class="detail-actions">
                      <button data-action="edit-category" data-id="${c.id}">Edit category</button>
                      <button class="danger" data-action="delete-category" data-id="${c.id}">
                        Delete category
                      </button>
                    </div>
                  `
                : ''}
            </div>
            <div class="tag-list">
              ${state.tags
                .filter((t) => t.category_id === c.id)
                .map(
                  (t) => /* HTML */ `
                    <div class="tag-management-row">
                      <span class="tag-badge tag-color-${t.id}">${esc(t.name)}</span>
                      <code>${esc(t.color)}</code>
                      <button data-action="edit-tag" data-id="${t.id}">Edit</button>
                      <button class="danger" data-action="delete-tag" data-id="${t.id}">
                        Remove
                      </button>
                    </div>
                  `,
                )
                .join('') || '<p>No tags in this category.</p>'}
            </div>
          </section>
        `,
      )
      .join('')}
    <p class="hint">
      Deleting a category moves its tags to Uncategorized. Deleting a tag removes its assignments.
      For a stream with several tags, its icon uses the first tag alphabetically.
    </p>
  `;
}
function editTag(id) {
  const tag = state.tags.find((t) => t.id === id) || { color: '#e6404d' };
  modal(
    id ? 'Edit tag' : 'Create tag',
    field('name', 'Tag name', tag.name) +
      field('color', 'Tag color', tag.color, 'color') +
      /* HTML */ `
        <label>
          Category
          <select name="category_id" aria-label="Category">
            <option value="">Uncategorized</option>
            ${state.tag_categories
              .map(
                (c) => /* HTML */ `
                  <option value="${c.id}" ${c.id === tag.category_id ? 'selected' : ''}>
                    ${esc(c.name)}
                  </option>
                `,
              )
              .join('')}
          </select>
        </label>
      `,
    (data) => {
      data.category_id = data.category_id ? Number(data.category_id) : null;
      return api('tags' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data);
    },
  );
}
function editCategory(id) {
  const category = state.tag_categories.find((c) => c.id === id) || {};
  modal(
    id ? 'Edit category' : 'Create category',
    field('name', 'Category name', category.name),
    (data) => api('tag_categories' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data),
  );
}
let pcfMode = 'tiles',
  pcfFocus = null;
const PCF_TYPES = ['Category', 'Process Group', 'Process', 'Activity', 'Task'];
function pcfChildren(parentId) {
  return state.pcf_entries
    .filter((entry) => entry.parent_id === parentId)
    .sort((a, b) => a.number - b.number);
}
function pcfLabel(entry) {
  return `${entry.index} ${entry.name}`;
}
function pcfPicker(stream) {
  return /* HTML */ `
    <fieldset class="tag-picker pcf-picker">
      <legend>Linked PCF entries</legend>
      <input type="hidden" name="_pcf_picker" value="1" />
      <label>
        Find PCF entries
        <input type="search" id="pcfLinkSearch" placeholder="Search by index, name, or reference" />
      </label>
      <div id="pcfLinkOptions">
        ${state.pcf_entries
          .map(
            (entry) => /* HTML */ `
              <label
                class="check pcf-option"
                data-pcf-search="${esc((pcfLabel(entry) + ' ' + entry.reference).toLowerCase())}"
              >
                <input
                  type="checkbox"
                  name="_pcf_${entry.id}"
                  ${(stream.pcf_ids || []).includes(entry.id) ? 'checked' : ''}
                />
                <span>
                  <b>${esc(pcfLabel(entry))}</b>
                  <small>${esc(entry.entry_type)}</small>
                </span>
              </label>
            `,
          )
          .join('') || '<p>No PCF entries yet. Create them in the PCF framework screen.</p>'}
      </div>
    </fieldset>
  `;
}
function pcfStreamLinks(stream) {
  const entries = state.pcf_entries.filter((entry) => (stream.pcf_ids || []).includes(entry.id));
  return /* HTML */ `
    <section class="pcf-linked context">
      <div>
        <b>PCF CLASSIFICATIONS</b>
        <div class="pcf-link-list">
          ${entries
            .map(
              (entry) => /* HTML */ `
                <button class="text-button" data-action="open-pcf" data-id="${entry.id}">
                  ${esc(pcfLabel(entry))}
                </button>
              `,
            )
            .join('') || '<p>No PCF classifications linked.</p>'}
        </div>
      </div>
      ${canEdit()
        ? '<button class="text-button" data-action="edit-stream">Manage PCF links</button>'
        : ''}
    </section>
  `;
}
function pcfActions(entry) {
  if (!canEdit()) return '';
  return /* HTML */ `
    <div class="detail-actions">
      ${entry.entry_type !== 'Task'
        ? /* HTML */ `
            <button data-action="new-pcf" data-parent="${entry.id}">
              + Add ${PCF_TYPES[PCF_TYPES.indexOf(entry.entry_type) + 1]}
            </button>
          `
        : ''}
      <button data-action="edit-pcf" data-id="${entry.id}">Edit entry</button>
      <button class="danger" data-action="delete-pcf" data-id="${entry.id}">Delete entry</button>
    </div>
  `;
}
function pcfIndex(entries) {
  return /* HTML */ `
    <ul class="pcf-index">
      ${entries
        .map((entry) => {
          const children = pcfChildren(entry.id);
          return /* HTML */ `
            <li>
              ${children.length ? '<details open><summary>' : '<div class="pcf-leaf">'}
              <span class="pcf-number">${esc(entry.index)}</span>
              <strong>${esc(entry.name)}</strong>
              <span class="pill">${esc(entry.entry_type)}</span>
              ${children.length ? '</summary>' : ''}
              <div class="pcf-index-actions">
                <button class="text-button" data-action="open-pcf" data-id="${entry.id}">
                  Details / drill down
                </button>
                ${canEdit()
                  ? /* HTML */ `
                      <button class="text-button" data-action="edit-pcf" data-id="${entry.id}">
                        Edit
                      </button>
                    `
                  : ''}
              </div>
              ${children.length ? pcfIndex(children) + '</details>' : '</div>'}
            </li>
          `;
        })
        .join('')}
    </ul>
  `;
}
let pcfImportState = null;
let pcfImportOpen = false;
function pcfImportPanel() {
  if (!canEdit()) return '';
  return /* HTML */ `
    <section id="pcfImportPanel" class="pcf-import" ${pcfImportOpen ? '' : 'hidden'}>
      <h2>Import PCF from CSV</h2>
      <p>
        Columns: PCF ID, Hierarchy ID, Name, and optional Description. Hierarchy IDs determine
        levels and parents (for example 1, 1.1, 1.1.1). UTF-8 CSV, up to 256 KiB / 5000 entries.
      </p>
      <label>
        PCF CSV file
        <input id="pcfCSVFile" type="file" accept=".csv,text/csv" />
      </label>
      <button data-action="pcf-import-preview">Upload and preview</button>
      <div id="pcfImportPreview"></div>
    </section>
  `;
}
function renderPCFImportPreview() {
  const panel = $('#pcfImportPreview');
  if (!panel || !pcfImportState) return;
  const { preview, decisions } = pcfImportState;
  pcfImportOpen = true;
  panel.closest('.pcf-import').hidden = false;
  $('[data-action="pcf-import-toggle"]').setAttribute('aria-expanded', 'true');
  panel.innerHTML = /* HTML */ `
    <h2>Review CSV import</h2>
    <p>
      ${preview.total} entries: ${preview.new} new and ${preview.duplicates.length} duplicate APQC
      reference IDs. No changes have been saved.
    </p>
    ${preview.duplicates.length
      ? /* HTML */ `
          <p>
            Yes overwrites the existing name, number, and parent. No keeps the existing entry. For
            Yes, the Description column also replaces the description (including blank values). Omit
            that column to keep existing descriptions. Value stream links are preserved.
          </p>
          <div class="detail-actions">
            <button data-action="pcf-import-all-yes">Overwrite ALL</button>
            <button data-action="pcf-import-all-no">Skip ALL</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>APQC reference ID</th>
                  <th>Existing entry</th>
                  <th>CSV entry</th>
                  <th>Overwrite?</th>
                </tr>
              </thead>
              <tbody>
                ${preview.duplicates
                  .map(
                    (row) => /* HTML */ `
                      <tr>
                        <td>${esc(row.reference)}</td>
                        <td>${esc(row.existing_index)} ${esc(row.existing_name)}</td>
                        <td>${esc(row.index)} ${esc(row.name)}</td>
                        <td>
                          <select
                            data-pcf-decision="${esc(row.reference)}"
                            aria-label="Overwrite ${esc(row.reference)}"
                          >
                            <option value="">Choose…</option>
                            <option
                              value="yes"
                              ${decisions[row.reference] === 'yes' ? 'selected' : ''}
                            >
                              Yes
                            </option>
                            <option
                              value="no"
                              ${decisions[row.reference] === 'no' ? 'selected' : ''}
                            >
                              No
                            </option>
                          </select>
                        </td>
                      </tr>
                    `,
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        `
      : ''}
    <p class="hint">
      Missing parents, incompatible levels, and occupied indexes stop the entire import. A skipped
      parent stays in its current location; imported children follow that retained parent.
    </p>
    <button
      class="primary"
      data-action="pcf-import-apply"
      ${preview.duplicates.some((row) => !decisions[row.reference]) ? 'disabled' : ''}
    >
      Import entries
    </button>
    <button data-action="pcf-import-cancel">Cancel import</button>
  `;
}
async function previewPCFImport(button) {
  const file = $('#pcfCSVFile').files[0];
  pcfImportState = null;
  $('#pcfImportPreview').replaceChildren();
  if (!file) throw new Error('Choose a CSV file first.');
  if (file.size > 256 * 1024) throw new Error('CSV must be up to 256 KiB.');
  button.disabled = true;
  try {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    } catch {
      throw new Error('The CSV must use UTF-8 encoding.');
    }
    const preview = await api('pcf_import/preview', 'POST', { csv: text });
    if (view !== 'pcf' || !canEdit()) return;
    pcfImportState = { text, preview, decisions: Object.create(null) };
    renderPCFImportPreview();
  } finally {
    button.disabled = false;
  }
}
async function applyPCFImport(button) {
  if (!pcfImportState) return;
  button.disabled = true;
  try {
    const { text, preview, decisions } = pcfImportState;
    const result = await api('pcf_import/apply', 'POST', {
      csv: text,
      fingerprint: preview.fingerprint,
      decisions,
    });
    pcfImportState = null;
    pcfImportOpen = false;
    pcfFocus = null;
    await refresh();
    if (view === 'pcf') {
      const message = document.createElement('p');
      message.className = 'pcf-import-result';
      message.setAttribute('role', 'status');
      message.textContent = `CSV import complete: ${result.created} created, ${result.updated} overwritten, ${result.skipped} skipped.`;
      $('#content').prepend(message);
    }
  } finally {
    button.disabled = false;
  }
}

function renderPCF() {
  const focused = state.pcf_entries.find((entry) => entry.id === pcfFocus);
  if (!focused) pcfFocus = null;
  const entries = pcfChildren(pcfFocus),
    ancestors = [];
  let current = focused;
  while (current) {
    ancestors.unshift(current);
    current = state.pcf_entries.find((entry) => entry.id === current.parent_id);
  }
  const linked = focused
    ? state.streams.filter((stream) => (stream.pcf_ids || []).includes(focused.id))
    : [];
  $('#breadcrumb').textContent = 'PCF framework';
  $('#content').innerHTML = /* HTML */ `
    <div class="eyebrow">PROCESS CLASSIFICATION FRAMEWORK</div>
    <div class="title-row">
      <div>
        <h1>PCF framework</h1>
        <p>Document your APQC classifications from category to task.</p>
      </div>
      ${canEdit()
        ? `<div class="detail-actions"><button data-action="pcf-import-toggle" aria-controls="pcfImportPanel" aria-expanded="${pcfImportOpen}">Import from CSV</button><button class="primary" data-action="new-pcf">+ Add PCF entry</button></div>`
        : ''}
    </div>
    ${pcfImportPanel()}
    <nav class="pcf-breadcrumb" aria-label="PCF hierarchy">
      <button class="text-button" data-action="pcf-root">All categories</button>
      ${ancestors
        .map(
          (entry) => /* HTML */ `
            <span aria-hidden="true">/</span>
            <button class="text-button" data-action="open-pcf" data-id="${entry.id}">
              ${esc(pcfLabel(entry))}
            </button>
          `,
        )
        .join('')}
    </nav>
    ${focused
      ? /* HTML */ `
          <section class="pcf-detail">
            <span class="pill">${esc(focused.entry_type)}</span>
            <h2>${esc(pcfLabel(focused))}</h2>
            ${focused.reference
              ? /* HTML */ `
                  <p>APQC reference: ${esc(focused.reference)}</p>
                `
              : ''}
            <p class="pcf-description">${esc(focused.description || 'No description provided.')}</p>
            ${pcfActions(focused)}
            <div class="pcf-associated">
              <b>Linked value streams</b>
              ${linked
                .map(
                  (stream) => /* HTML */ `
                    <button class="text-button" data-action="pcf-stream" data-id="${stream.id}">
                      ${esc(stream.name)}
                    </button>
                  `,
                )
                .join('') || '<p>No value streams linked directly to this entry.</p>'}
            </div>
          </section>
        `
      : ''}
    <div class="section-row">
      <h2>
        ${focused
          ? focused.entry_type === 'Task'
            ? 'Task details'
            : 'Child entries'
          : 'Categories'}
      </h2>
      <div class="view-switch" role="group" aria-label="PCF view">
        <button data-action="pcf-tiles" aria-pressed="${pcfMode === 'tiles'}">Tiles</button>
        <button data-action="pcf-index" aria-pressed="${pcfMode === 'index'}">Index</button>
      </div>
    </div>
    ${entries.length
      ? pcfMode === 'index'
        ? pcfIndex(entries)
        : /* HTML */ `
            <div class="grid pcf-grid">
              ${entries
                .map(
                  (entry) => /* HTML */ `
                    <article class="pcf-tile" data-action="open-pcf" data-id="${entry.id}">
                      <span class="pill">${esc(entry.entry_type)}</span>
                      <h3>
                        <button class="pcf-tile-open" data-action="open-pcf" data-id="${entry.id}">
                          <span class="pcf-number">${esc(entry.index)}</span>
                          ${esc(entry.name)}
                        </button>
                      </h3>
                      <p>
                        ${esc(
                          entry.description ||
                            entry.reference ||
                            'Open to explore this classification.',
                        )}
                      </p>
                      <div class="card-meta">
                        <span>${pcfChildren(entry.id).length} child entries</span>
                        <button class="text-button" data-action="open-pcf" data-id="${entry.id}">
                          Drill down →
                        </button>
                      </div>
                    </article>
                  `,
                )
                .join('')}
            </div>
          `
      : /* HTML */ `
          <div class="empty">
            <h2>${focused ? 'No child entries' : 'Start your PCF framework'}</h2>
            <p>
              ${focused?.entry_type === 'Task'
                ? 'Task is the final classification level.'
                : 'Add entries manually to build your numbered process hierarchy.'}
            </p>
            ${canEdit() && (!focused || focused.entry_type !== 'Task')
              ? /* HTML */ `
                  <button data-action="new-pcf" ${focused ? `data-parent="${focused.id}"` : ''}>
                    + Add
                    ${focused ? PCF_TYPES[PCF_TYPES.indexOf(focused.entry_type) + 1] : 'Category'}
                  </button>
                `
              : ''}
          </div>
        `}
  `;
  renderPCFImportPreview();
}
function editPCF(id, parentId) {
  const entry = state.pcf_entries.find((item) => item.id === id);
  const parent = state.pcf_entries.find((item) => item.id === parentId);
  const kind =
    entry?.entry_type ||
    (parent ? PCF_TYPES[PCF_TYPES.indexOf(parent.entry_type) + 1] : 'Category');
  modal(
    entry ? 'Edit PCF entry' : 'Add PCF entry',
    field('name', 'Entry name', entry?.name) +
      /* HTML */ `
        <label>
          Entry type
          <select name="entry_type" id="pcfEntryType" aria-label="Entry type">
            ${PCF_TYPES.map(
              (type) => /* HTML */ `
                <option ${type === kind ? 'selected' : ''}>${type}</option>
              `,
            ).join('')}
          </select>
        </label>
        <label>
          Parent entry
          <select name="parent_id" id="pcfParent" aria-label="Parent entry"></select>
        </label>
      ` +
      field('number', 'Index number', entry?.number || 1, 'number') +
      '<p class="hint">A positive number unique among siblings. The full index is built from the parent chain.</p>' +
      field('reference', 'APQC reference ID (optional)', entry?.reference) +
      field('description', 'Description', entry?.description, 'textarea'),
    async (data) => {
      data.number = Number(data.number);
      data.parent_id = data.parent_id ? Number(data.parent_id) : null;
      await api('pcf_entries' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data);
      if (!id && parentId) pcfFocus = parentId;
    },
  );
  const updateParents = (selectedParent) => {
    const level = PCF_TYPES.indexOf($('#pcfEntryType').value);
    const options = state.pcf_entries.filter(
      (item) => item.entry_type === PCF_TYPES[level - 1] && item.id !== id,
    );
    $('#pcfParent').innerHTML = level
      ? '<option value="">Choose a parent</option>' +
        options
          .map(
            (item) => /* HTML */ `
              <option value="${item.id}" ${item.id === selectedParent ? 'selected' : ''}>
                ${esc(pcfLabel(item))}
              </option>
            `,
          )
          .join('')
      : '<option value="">No parent (top level)</option>';
    $('#pcfParent').required = level > 0;
    $('#pcfParent').disabled = level === 0;
    if (!entry)
      $('#fields [name=number]').value =
        Math.max(0, ...pcfChildren(selectedParent || null).map((item) => item.number)) + 1;
  };
  updateParents(entry?.parent_id || parentId || null);
  $('#pcfEntryType').onchange = () => updateParents(null);
  $('#pcfParent').onchange = () => {
    if (!entry)
      $('#fields [name=number]').value =
        Math.max(
          0,
          ...pcfChildren(Number($('#pcfParent').value) || null).map((item) => item.number),
        ) + 1;
  };
  $('#fields [name=number]').min = '1';
  $('#fields [name=number]').step = '1';
  $('#fields [name=number]').max = '999999';
}

function editStream(id) {
  const s = state.streams.find((s) => s.id === id) || {};
  modal(
    id ? 'Edit value stream' : 'Create value stream',
    field('name', 'Stream name', s.name) +
      field('customer', 'Customer / beneficiary', s.customer) +
      field('outcome', 'Desired value', s.outcome) +
      field('description', 'Description', s.description, 'textarea') +
      field('voc', 'Voice of the Customer (VOC)', s.voc, 'textarea') +
      '<p class="hint">What is the customer actually asking us to deliver? Use their own words where possible, for example: “Give every new starter working access to their tools on day one.”</p>' +
      tagPicker(s) +
      pcfPicker(s),
    async (data) => {
      const result = await api('streams' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data);
      selected = result.id;
    },
  );
}
function editStep(id) {
  const s = state.steps.find((s) => s.id === id) || { work_minutes: 0, wait_minutes: 0 };
  modal(
    id ? 'Edit step' : 'Add delivery step',
    field('name', 'Step name', s.name) +
      field('owner', 'Responsible team / owner', s.owner) +
      field('work_minutes', 'Active work time (minutes)', s.work_minutes, 'number') +
      field('wait_minutes', 'Waiting time (minutes)', s.wait_minutes, 'number') +
      tagPicker(s),
    async (data) => {
      data.work_minutes = Number(data.work_minutes);
      data.wait_minutes = Number(data.wait_minutes);
      if (!id) {
        data.stream_id = selected;
        data.position = Math.max(-1, ...steps(selected).map((s) => s.position)) + 1;
      }
      await api('steps' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data);
    },
  );
}
function editProcess(id) {
  const p = state.processes.find((p) => p.id === id) || {};
  modal(
    id ? 'Process details' : 'Create process',
    field('name', 'Process name', p.name) +
      field('owner', 'Process owner', p.owner) +
      field('description', 'Purpose / description', p.description, 'textarea') +
      field('procedure', 'Procedure / work instructions', p.procedure, 'textarea') +
      tagPicker(p),
    (data) => api('processes' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data),
    !canEdit(),
  );
}
$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!saveForm) return;
  const button = e.submitter;
  button.disabled = true;
  try {
    await saveForm(formValues(e.target));
    $('#editor').close();
    await refresh();
  } catch (e) {
    error(e);
  } finally {
    button.disabled = false;
  }
});
$('#fields').addEventListener('input', (event) => {
  if (event.target.id === 'pcfLinkSearch') {
    const query = event.target.value.toLowerCase();
    $('#fields')
      .querySelectorAll('[data-pcf-search]')
      .forEach((option) => (option.hidden = !option.dataset.pcfSearch.includes(query)));
  }
});
$('#closeDialog').onclick = $('#cancelDialog').onclick = () => $('#editor').close();
$('#editor').addEventListener('close', () => {
  $('#fields').replaceChildren();
  saveForm = null;
});
$('#content').addEventListener('change', (event) => {
  const reference = event.target.dataset.pcfDecision;
  if (reference && pcfImportState) {
    pcfImportState.decisions[reference] = event.target.value;
    const button = $('[data-action="pcf-import-apply"]');
    if (button)
      button.disabled = pcfImportState.preview.duplicates.some(
        (row) => !pcfImportState.decisions[row.reference],
      );
  }
});
$('#content').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = Number(el.dataset.id);
  try {
    if (el.dataset.action === 'new-environment') return editEnvironment();
    if (el.dataset.action === 'switch-environment') return await switchEnvironment(id);
    if (el.dataset.action === 'environment-content') return navigate(el.dataset.target);
    if (
      [
        'edit-environment',
        'delete-environment',
        'edit-environment-member',
        'remove-environment-member',
      ].includes(el.dataset.action)
    ) {
      if (!environmentAdmin()) return;
      if (el.dataset.action === 'edit-environment') return editEnvironment(id);
      if (el.dataset.action === 'delete-environment') {
        const environment = environmentList.find((item) => item.id === id);
        if (!environment) return;
        if (
          !confirm(
            `Delete environment "${environment.name}" and ALL its value streams, delivery steps, processes, PCF entries, tags, categories, and links? This cannot be undone without a backup.`,
          )
        )
          return;
        await api('environments/' + id, 'DELETE', { confirmation: environment.name });
        resetEnvironmentView();
        view = 'environments';
        await refresh();
        return;
      }
      const member = environmentMembers.find((item) => item.user_id === id);
      if (el.dataset.action === 'edit-environment-member')
        return modal(
          'Edit environment role',
          `<label>Environment role<select name="role" aria-label="Environment role">${['Admin', 'Editor', 'Viewer'].map((role) => `<option ${role === member.role ? 'selected' : ''}>${role}</option>`).join('')}</select></label>`,
          (data) => api('environments/' + session.environment.id + '/members/' + id, 'PUT', data),
        );
      if (!confirm('Remove this account from the environment?')) return;
      await api('environments/' + session.environment.id + '/members/' + id, 'DELETE', {});
      await refresh();
      return;
    }
    if (EDIT_ACTIONS.has(el.dataset.action) && !canEdit()) return;
    if (el.dataset.action.startsWith('pcf-import-')) {
      if (!canEdit()) return;
      if (el.dataset.action === 'pcf-import-toggle') {
        pcfImportOpen = !pcfImportOpen;
        $('#pcfImportPanel').hidden = !pcfImportOpen;
        el.setAttribute('aria-expanded', String(pcfImportOpen));
        if (pcfImportOpen) $('#pcfCSVFile').focus();
        return;
      }
      if (el.dataset.action === 'pcf-import-preview') return await previewPCFImport(el);
      if (el.dataset.action === 'pcf-import-apply') return await applyPCFImport(el);
      if (el.dataset.action === 'pcf-import-cancel') {
        pcfImportState = null;
        $('#pcfImportPreview').replaceChildren();
        return;
      }
      if (
        pcfImportState &&
        ['pcf-import-all-yes', 'pcf-import-all-no'].includes(el.dataset.action)
      ) {
        const choice = el.dataset.action === 'pcf-import-all-yes' ? 'yes' : 'no';
        pcfImportState.decisions = Object.fromEntries(
          pcfImportState.preview.duplicates.map((row) => [row.reference, choice]),
        );
        renderPCFImportPreview();
        return;
      }
    }

    if (el.dataset.action === 'pcf-index' || el.dataset.action === 'pcf-tiles') {
      pcfMode = el.dataset.action === 'pcf-index' ? 'index' : 'tiles';
      return render();
    }
    if (el.dataset.action === 'pcf-root') {
      pcfFocus = null;
      return render();
    }
    if (el.dataset.action === 'open-pcf') {
      view = 'pcf';
      pcfFocus = id;
      return render();
    }
    if (el.dataset.action === 'pcf-stream') {
      view = 'streams';
      selected = id;
      streamMode = 'diagram';
      return render();
    }
    if (['new-pcf', 'edit-pcf', 'delete-pcf'].includes(el.dataset.action)) {
      if (!canEdit()) return;
      if (el.dataset.action === 'new-pcf') return editPCF(null, Number(el.dataset.parent) || null);
      if (el.dataset.action === 'edit-pcf') return editPCF(id);
      if (
        !confirm(
          'Delete this PCF entry? Its value stream links will be removed. Entries with children must have their children moved or removed first.',
        )
      )
        return;
      await api('pcf_entries/' + id, 'DELETE');
      if (pcfFocus === id) pcfFocus = null;
      await refresh();
      return;
    }

    if (
      [
        'new-tag',
        'edit-tag',
        'delete-tag',
        'new-category',
        'edit-category',
        'delete-category',
      ].includes(el.dataset.action)
    ) {
      if (!environmentAdmin()) return;
      if (el.dataset.action === 'new-tag') return editTag();
      if (el.dataset.action === 'edit-tag') return editTag(id);
      if (el.dataset.action === 'new-category') return editCategory();
      if (el.dataset.action === 'edit-category') return editCategory(id);
      const category = el.dataset.action === 'delete-category';
      if (
        !confirm(
          category
            ? 'Delete this category? Its tags will move to Uncategorized.'
            : 'Remove this tag from the application and all assigned items?',
        )
      )
        return;
      await api((category ? 'tag_categories/' : 'tags/') + id, 'DELETE');
      await refresh();
      return;
    }
    if (el.dataset.action === 'new-account') return editAccount();
    if (el.dataset.action === 'edit-account') return editAccount(id);
    if (el.dataset.action === 'delete-account') {
      if (!confirm('Remove this account? Its sessions will be revoked.')) return;
      await api('users/' + id, 'DELETE');
      await refresh();
      return;
    }
    if (el.dataset.action === 'create-backup') {
      await api('backups/create', 'POST', {});
      await refreshMaintenance();
      return;
    }
    if (el.dataset.action === 'restore-backup') {
      if (
        !confirm(
          'Restore application code, accounts and data from this trusted backup? Current data will be replaced. A safety backup is created first, and you must sign in again using an account from the backup.',
        )
      )
        return;
      await api('backups/restore', 'POST', { id: el.dataset.backup });
      await refreshMaintenance();
      return;
    }
    if (el.dataset.action === 'cleanup-backups') {
      const ids = [...document.querySelectorAll('[name="backup-select"]:checked')].map(
        (el) => el.value,
      );
      if (!ids.length) {
        error(new Error('Select backups to remove.'));
        return;
      }
      if (!confirm(`Permanently delete ${ids.length} selected backup(s)?`)) return;
      await api('backups/cleanup', 'POST', { ids });
      await refresh();
      return;
    }
    if (el.dataset.action === 'check-update' || el.dataset.action === 'install-update') {
      if (
        el.dataset.action === 'install-update' &&
        !confirm(
          'Update to the latest GitHub main revision? A database backup will be made and the application will briefly restart.',
        )
      )
        return;
      await api(
        'updates/' + (el.dataset.action === 'check-update' ? 'check' : 'install'),
        'POST',
        {},
      );
      await refreshMaintenance();
      return;
    }
    switch (el.dataset.action) {
      case 'diagram-view':
        streamMode = 'diagram';
        return render();
      case 'flow-view':
        streamMode = 'flow';
        return render();
      case 'new-stream':
        return editStream();
      case 'edit-stream':
        return editStream(selected);
      case 'open-stream':
        selected = id;
        streamMode = 'diagram';
        return render();
      case 'back':
        selected = null;
        return render();
      case 'new-step':
        return editStep();
      case 'edit-step':
        return editStep(id);
      case 'import-bpmn':
        return importBPMN(id);
      case 'view-bpmn':
        bpmnProcessId = id;
        render();
        return $('#bpmnCanvas')?.focus();
      case 'new-process':
        return editProcess();
      case 'edit-process':
        return editProcess(id);
      case 'link':
        return modal(
          'Link processes',
          state.processes.length
            ? state.processes
                .map(
                  (p) => /* HTML */ `
                    <label class="check">
                      <input
                        type="checkbox"
                        name="process_${p.id}"
                        ${state.step_processes.some(
                          (l) => l.step_id === id && l.process_id === p.id,
                        )
                          ? 'checked'
                          : ''}
                      />
                      ${esc(p.name)}
                    </label>
                  `,
                )
                .join('')
            : '<p>Create a process in the Process library first.</p>',
          async (data) =>
            api(`steps/${id}/processes`, 'PUT', {
              process_ids: Object.keys(data).map((k) => Number(k.slice(8))),
            }),
        );
      case 'delete-stream':
        if (!confirm('Delete this stream and all its steps? Processes will remain in the library.'))
          return;
        await api('streams/' + selected, 'DELETE');
        selected = null;
        break;
      case 'delete-step':
        if (!confirm('Delete this step?')) return;
        await api('steps/' + id, 'DELETE');
        break;
      case 'delete-process':
        if (!confirm('Delete this process and remove all its links?')) return;
        await api('processes/' + id, 'DELETE');
        break;
    }
    await refresh();
  } catch (e) {
    error(e);
  }
});
let dragged;
$('#content').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.step');
  if (card && canEdit()) {
    dragged = Number(card.dataset.id);
    e.dataTransfer.setData('text/plain', String(dragged));
  }
});
$('#content').addEventListener('dragover', (e) => {
  if (e.target.closest('.step')) e.preventDefault();
});
$('#content').addEventListener('drop', async (e) => {
  const target = e.target.closest('.step');
  if (!target || !dragged || !canEdit()) return;
  e.preventDefault();
  const items = steps(selected),
    from = items.findIndex((s) => s.id === dragged),
    to = items.findIndex((s) => s.id === Number(target.dataset.id));
  if (from < 0 || to < 0 || from === to) return;
  items.splice(to, 0, items.splice(from, 1)[0]);
  try {
    for (let i = 0; i < items.length; i++)
      await api('steps/' + items[i].id, 'PUT', { position: i });
    await refresh();
  } catch (e) {
    error(e);
    await refresh();
  } finally {
    dragged = null;
  }
});
function render() {
  diagramController?.destroy();
  diagramController = null;
  clearTimeout(updateTimer);
  const user = session.user;
  document.body.classList.toggle('signed-out', !user);
  $('#adminMenu').hidden = user?.role !== 'Admin' && !environmentAdmin();
  for (const [name, page] of Object.entries(VIEWS)) {
    if (page.adminOnly || page.environmentAdminOnly)
      navigationButton(name).hidden = !canAccessView(name);
  }
  $('#identity').innerHTML = user
    ? /* HTML */ `
        <span>
          ${esc(user.username)}
          <span class="pill" title="Application role">App ${esc(user.role)}</span>
        </span>
        <button id="logout" class="text-button">Sign out</button>
      `
    : '';
  if (user) {
    const identity = $('#identity');
    const selector = document.createElement('label');
    selector.className = 'environment-switch';
    selector.textContent = 'Environment';
    selector.innerHTML += `<select id="environmentSwitcher" aria-label="Active environment">${environmentList.length ? environmentList.map((environment) => `<option value="${environment.id}" ${environment.id === session.environment?.id ? 'selected' : ''}>${esc(environment.name)}</option>`).join('') : '<option value="">No environment</option>'}</select>`;
    identity.prepend(selector);
    $('#environmentSwitcher').disabled = !environmentList.length;
    $('#environmentSwitcher').onchange = (event) =>
      switchEnvironment(Number(event.target.value)).catch(error);
  }
  if (user)
    $('#logout').onclick = async () => {
      try {
        await api('auth/logout', 'POST', {});
        pcfImportState = null;
        session = {};
        selected = null;
        view = 'streams';
        await refresh();
      } catch (e) {
        error(e);
      }
    };
  if (!user) return renderAuth();
  for (const name of Object.keys(VIEWS)) {
    const button = navigationButton(name);
    button.classList.toggle('active', view === name);
    button.disabled = !canAccessView(name);
  }
  VIEWS[view].render();
  if (!canEdit()) {
    $('#content')
      .querySelectorAll('[data-action]')
      .forEach((el) => {
        if (EDIT_ACTIONS.has(el.dataset.action)) el.remove();
      });
    $('#content')
      .querySelectorAll('[draggable]')
      .forEach((el) => (el.draggable = false));
    $('#content')
      .querySelectorAll('.step-number')
      .forEach((el) => (el.textContent = el.textContent.replace(' · DRAG TO REORDER', '')));
    $('#content')
      .querySelectorAll('.hint:not(.diagram-help)')
      .forEach((el) => (el.textContent = 'Read-only access. All times are measured in minutes.'));
    $('#content')
      .querySelectorAll('[data-action="edit-process"]')
      .forEach((el) => (el.textContent = 'View details →'));
  }
}
function applyBranding() {
  document.title = brandSettings.name;
  syncThemeStylesheet();
  $('.brand').innerHTML = `${
    brandSettings.logo
      ? /* HTML */ `
          <img class="brand-logo" src="${esc(brandSettings.logo)}" alt="" />
        `
      : '<b aria-hidden="true">◈</b>'
  }<span>${esc(brandSettings.name)}</span>`;
  $('.aside-bottom').innerHTML =
    `<div class="footer-details">${esc(brandSettings.tagline)}<br><span>● Data stays on your server</span></div><a class="app-version" href="https://github.com/CoxkeLamagra/VSM-Toolbox" target="_blank" rel="noopener noreferrer" title="${esc('GitHub repository · Revision: ' + (session.revision || 'local'))}">v${esc(session.version || 'development')}</a>`;
}
let maintenanceState = { operation: {}, supported: false };
function renderDataManagement() {
  const operation = maintenanceState.operation || {},
    busy = MAINTENANCE_BUSY.has(operation.state);
  const disabled = busy || !operation.available || !maintenanceState.supported;
  $('#breadcrumb').textContent = 'Administrator / Data management';
  $('#content').innerHTML =
    `<div class="eyebrow">ADMINISTRATOR</div><div class="title-row"><div><h1>Data management</h1><p>Clear business content after creating a local safety backup.</p></div></div><section class="data-danger-panel"><h2>Clear all business data</h2><p class="data-warning" role="note"><strong>Warning: this removes content in ALL environments: value streams, delivery steps / process flows, processes, PCF entries, and their links.</strong> Accounts, branding, tag definitions, tag categories, and existing backups remain.</p><p>A full local application and database backup is required before deletion. If backup creation fails, nothing is deleted. The application restarts briefly; failed startup restores the backup. You can restore the saved backup from Backups & restore.</p><p role="status">${esc(operation.message || 'Ready')}</p>${operation.backup ? `<p>Latest operation backup: <code>${esc(operation.backup)}</code></p>` : ''}${!maintenanceState.supported ? '<p class="hint">Rerun the updated Debian installer or rebuild the Docker image once to enable safe data clearing.</p>' : ''}<form id="clearDataForm"><label>Type DELETE ALL BUSINESS DATA to confirm<input name="confirmation" aria-label="Confirmation text" autocomplete="off" required pattern="DELETE ALL BUSINESS DATA" ${disabled ? 'disabled' : ''}></label><button class="danger" type="submit" ${disabled ? 'disabled' : ''}>Create backup and clear all data</button></form></section>`;
  $('#clearDataForm').onsubmit = async (event) => {
    event.preventDefault();
    if (
      !confirm(
        'FINAL WARNING: delete every value stream, delivery step / process flow, process, and PCF entry? A full local backup must be created first. Accounts, branding, tag definitions, tag categories, and backup files will remain. Continue?',
      )
    )
      return;
    const button = event.submitter;
    button.disabled = true;
    try {
      await api('maintenance/clear-data', 'POST', Object.fromEntries(new FormData(event.target)));
      await refreshMaintenance();
    } catch (e) {
      error(e);
      button.disabled = false;
    }
  };
  if (busy) pollMaintenance();
}
function renderBranding() {
  $('#breadcrumb').textContent = 'Administrator / Branding & theme';
  $('#content').innerHTML = /* HTML */ `
    <div class="eyebrow">ADMINISTRATOR</div>
    <div class="title-row">
      <div>
        <h1>Branding & theme</h1>
        <p>Make this workspace your own. Settings apply to all users and the sign-in page.</p>
      </div>
    </div>
    <form id="brandingForm" class="branding-panel">
      <h2>Workspace identity</h2>
      <label>
        Application name
        <input name="name" value="${esc(brandSettings.name)}" required maxlength="64" />
      </label>
      <label>
        Workspace tagline
        <input name="tagline" value="${esc(brandSettings.tagline)}" required maxlength="120" />
      </label>
      <label>
        Logo (PNG or JPEG, up to 128 KiB)
        <input id="brandLogoFile" type="file" accept="image/png,image/jpeg" />
      </label>
      ${brandSettings.logo
        ? /* HTML */ `
            <img
              class="logo-preview"
              src="${esc(brandSettings.logo)}"
              alt="Current workspace logo"
            />
          `
        : ''}
      <label class="check">
        <input id="removeBrandLogo" type="checkbox" />
        Remove current logo
      </label>
      <h2>Theme colors</h2>
      <div class="brand-colors">
        ${[
          ['primary', 'Accent / buttons'],
          ['sidebar', 'Navigation background'],
          ['background', 'Page background'],
        ]
          .map(
            ([key, label]) => /* HTML */ `
              <label>
                ${label}
                <input name="${key}" type="color" value="${esc(brandSettings[key])}" />
              </label>
            `,
          )
          .join('')}
      </div>
      <p class="hint">
        Button and navigation text automatically use a contrasting color. All assets stay on this
        server.
      </p>
      <p id="brandingStatus" role="status"></p>
      <div class="detail-actions">
        <button class="primary" type="submit">Save branding</button>
        <button id="resetBranding" type="button">Restore default theme</button>
      </div>
    </form>
  `;
  async function save(theme) {
    await api('branding', 'PUT', theme);
    await refresh();
    $('#brandingStatus').textContent = 'Branding saved.';
  }
  $('#brandingForm').onsubmit = async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const theme = {
        ...Object.fromEntries(new FormData(event.target)),
        logo: $('#removeBrandLogo').checked ? '' : brandSettings.logo,
      };
      const file = $('#brandLogoFile').files[0];
      if (file) {
        if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 131072)
          throw new Error('Choose a PNG or JPEG up to 128 KiB.');
        theme.logo = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Could not read logo.'));
          reader.readAsDataURL(file);
        });
      }
      await save(theme);
    } catch (e) {
      error(e);
    } finally {
      button.disabled = false;
    }
  };
  $('#resetBranding').onclick = async () => {
    if (confirm('Restore the default name, logo, and theme for all users?'))
      try {
        await save({ ...brandDefaults });
      } catch (e) {
        error(e);
      }
  };
}
function credentialFields(username = '', passwordRequired = true) {
  return /* HTML */ `
    <label>
      Username
      <input
        name="username"
        aria-label="Username"
        value="${esc(username)}"
        required
        minlength="3"
        maxlength="64"
        autocomplete="username"
      />
      <span class="hint">3–64 letters, numbers, dots, underscores or hyphens.</span>
    </label>
    <label>
      ${passwordRequired ? 'Password' : 'New password (leave blank to keep current)'}
      <input
        name="password"
        aria-label="${passwordRequired ? 'Password' : 'New password'}"
        type="password"
        ${passwordRequired ? 'required' : ''}
        minlength="12"
        maxlength="128"
        autocomplete="new-password"
      />
      <span class="hint">Use 12–128 characters.</span>
    </label>
  `;
}
function renderAuth() {
  $('#breadcrumb').textContent = 'Local accounts';
  const setup = session.setup_required;
  $('#content').innerHTML = /* HTML */ `
    <div class="auth-card">
      <span class="icon">◈</span>
      <h1>${setup ? 'Create your Admin account' : 'Welcome back'}</h1>
      <p>
        ${setup
          ? 'The first account administers this local workspace. Additional accounts are created by an Admin.'
          : `Sign in to your local ${esc(brandSettings.name)} workspace.`}
      </p>
      <form id="authForm">
        ${setup
          ? credentialFields()
          : /* HTML */ `
              <label>
                Username
                <input name="username" autocomplete="username" required maxlength="64" />
              </label>
              <label>
                Password
                <input
                  name="password"
                  type="password"
                  autocomplete="current-password"
                  required
                  maxlength="128"
                />
              </label>
            `}
        <button class="primary" type="submit">${setup ? 'Create Admin account' : 'Sign in'}</button>
        <p id="authError" role="alert"></p>
      </form>
    </div>
  `;
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const button = e.submitter;
    button.disabled = true;
    try {
      session = await api(
        'auth/' + (setup ? 'register' : 'login'),
        'POST',
        Object.fromEntries(new FormData(e.target)),
      );
      await refresh();
    } catch (e) {
      $('#authError').textContent = e.message;
    } finally {
      button.disabled = false;
    }
  };
}
function renderAccounts() {
  $('#breadcrumb').textContent = 'Administrator / Accounts';
  $('#content').innerHTML = /* HTML */ `
    <div class="eyebrow">ADMINISTRATOR</div>
    <div class="title-row">
      <div>
        <h1>Account administration</h1>
        <p>Manage local accounts and their access to this workspace.</p>
      </div>
      <button class="primary" data-action="new-account">+ Create Account</button>
    </div>
    <div class="role-guide">
      <div>
        <b>Admin</b>
        <p>Manage application accounts, backups, branding, and updates.</p>
      </div>
      <div>
        <b>Editor</b>
        <p>Edit content in environments where this role applies.</p>
      </div>
      <div>
        <b>Viewer</b>
        <p>Read content in assigned environments.</p>
      </div>
    </div>
    <div class="section-row">
      <h2>Account Overview</h2>
      <span class="label">${accounts.length} accounts</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${accounts
            .map(
              (u) => /* HTML */ `
                <tr>
                  <td>
                    ${esc(u.username)}
                    ${u.id === session.user.id ? '<span class="pill">You</span>' : ''}
                  </td>
                  <td><span class="pill">${esc(u.role)}</span></td>
                  <td>
                    <button class="text-button" data-action="edit-account" data-id="${u.id}">
                      Edit
                    </button>
                    <button
                      class="text-button danger"
                      data-action="delete-account"
                      data-id="${u.id}"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              `,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <p class="hint">
      The last Admin cannot be removed or demoted. Editing an account revokes its existing sessions.
    </p>
  `;
}
function editAccount(id) {
  const u = accounts.find((u) => u.id === id) || { role: 'Viewer' };
  modal(
    id ? 'Edit account' : 'Create Account',
    credentialFields(u.username, !id) +
      /* HTML */ `
        <label>
          Role
          <select name="role" aria-label="Role">
            ${['Admin', 'Editor', 'Viewer']
              .map(
                (role) => /* HTML */ `
                  <option ${u.role === role ? 'selected' : ''}>${role}</option>
                `,
              )
              .join('')}
          </select>
        </label>
      `,
    async (data) => {
      if (id && !data.password) delete data.password;
      await api('users' + (id ? '/' + id : ''), id ? 'PUT' : 'POST', data);
    },
  );
}
function renderUpdates() {
  $('#breadcrumb').textContent = 'Administrator / Updates';
  const busy = MAINTENANCE_BUSY.has(updateStatus.state);
  $('#content').innerHTML = /* HTML */ `
    <div class="eyebrow">ADMINISTRATOR</div>
    <div class="title-row">
      <div>
        <h1>Application updates</h1>
        <p>Install the latest published revision of the GitHub main branch.</p>
      </div>
      <button data-action="check-update" ${busy || !updateStatus.available ? 'disabled' : ''}>
        Check for updates
      </button>
    </div>
    <div class="context update-panel">
      <div>
        <b>INSTALLED REVISION</b>
        <code>${esc(updateStatus.current_revision || 'Local checkout')}</code>
      </div>
      <div>
        <b>LATEST MAIN REVISION</b>
        <code>${esc(updateStatus.latest_revision || 'Not checked')}</code>
      </div>
      <div>
        <b>STATUS</b>
        <p role="status">${esc(updateStatus.message || 'Ready to check for updates.')}</p>
      </div>
      <button
        class="primary"
        data-action="install-update"
        ${busy || !updateStatus.available || updateStatus.backup_protocol !== 1 ? 'disabled' : ''}
      >
        Update from main
      </button>
    </div>
    <p class="hint">
      A complete application and database backup is made before installation. The application
      restarts briefly and checks its health; failed updates restore the previous code and database.
      Existing sessions are revoked after an update, so you may need to sign in again. GitHub
      connectivity is required only when checking or installing updates.
    </p>
    ${updateStatus.available && updateStatus.backup_protocol !== 1
      ? '<p>Install the updated supervisor using the Debian installer or Docker image to guarantee full application backups before updating.</p>'
      : ''}${!updateStatus.available
      ? '<p>Web updates require the update supervisor. Install this version using the Debian installer or rebuild the Docker image once to enable them.</p>'
      : ''}
  `;
  if (busy) pollMaintenance();
}
function renderBackups() {
  $('#breadcrumb').textContent = 'Administrator / Backups & restore';
  const operation = backupState.operation || {},
    busy = MAINTENANCE_BUSY.has(operation.state);
  const disabled = busy || !operation.available || !backupState.supported;
  const size = (n) =>
    n < 1024 * 1024 ? (n / 1024).toFixed(1) + ' KiB' : (n / 1024 / 1024).toFixed(1) + ' MiB';
  $('#content').innerHTML = /* HTML */ `
    <div class="eyebrow">ADMINISTRATOR</div>
    <div class="title-row">
      <div>
        <h1>Backups & restore</h1>
        <p>Protect your application, accounts, and value stream data.</p>
      </div>
      <button class="primary" data-action="create-backup" ${disabled ? 'disabled' : ''}>
        Create manual backup
      </button>
    </div>
    <div class="context update-panel">
      <div>
        <b>OPERATION STATUS</b>
        <p role="status">${esc(operation.message || 'Ready')}</p>
      </div>
      <div>
        <b>RESTORE AN UPLOADED BACKUP</b>
        <p>
          Upload a trusted .vsm-backup.zip file (up to 128 MiB). The file is validated before
          restoration. Backups contain application code and account data.
        </p>
        <label>
          Backup file
          <input id="backupUpload" type="file" accept=".zip" ${disabled ? 'disabled' : ''} />
        </label>
        <button id="uploadBackup" ${disabled ? 'disabled' : ''}>Upload and restore</button>
      </div>
      ${!backupState.supported
        ? '<p>Enable the updated supervisor with the Debian installer or Docker image before using backup management.</p>'
        : ''}
    </div>
    <div class="section-row">
      <h2>Saved backups</h2>
      <button class="danger" data-action="cleanup-backups" ${disabled ? 'disabled' : ''}>
        Delete selected backups
      </button>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Select</th>
            <th>Created / reason</th>
            <th>Revision</th>
            <th>Size</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${backupState.backups
            .map(
              (b) => /* HTML */ `
                <tr>
                  <td>
                    <input
                      aria-label="Select ${esc(b.id)}"
                      type="checkbox"
                      name="backup-select"
                      value="${esc(b.id)}"
                      ${disabled || b.protected ? 'disabled' : ''}
                    />
                  </td>
                  <td>
                    ${esc(new Date(b.created_at * 1000).toLocaleString())}
                    <p>${esc(b.reason || 'Backup')}</p>
                  </td>
                  <td><code>${esc(b.revision || 'Legacy database backup')}</code></td>
                  <td>${size(b.size)}</td>
                  <td>
                    <a href="/api/backups/${encodeURIComponent(b.id)}/download" download>
                      Download
                    </a>
                    <button
                      class="text-button"
                      data-action="restore-backup"
                      data-backup="${esc(b.id)}"
                      ${disabled || !b.restorable ? 'disabled' : ''}
                    >
                      Restore
                    </button>
                  </td>
                </tr>
              `,
            )
            .join('') ||
          '<tr><td colspan="5">No backups yet. Create a manual backup to get started.</td></tr>'}
        </tbody>
      </table>
    </div>
    <p class="hint">
      Every update and restore creates a safety backup before changing the application. Backups
      needed by an active recovery cannot be deleted. Download important backups to another system;
      local backups do not protect against disk loss. Restoring revokes sessions and restores the
      accounts and passwords contained in that backup.
    </p>
  `;
  $('#uploadBackup').onclick = async () => {
    const file = $('#backupUpload').files[0];
    if (!file) {
      error(new Error('Choose a backup file first.'));
      return;
    }
    if (file.size > 128 * 1024 * 1024) {
      error(new Error('Backup exceeds 128 MiB.'));
      return;
    }
    if (
      !confirm(
        'Only restore a trusted application backup. This installs its application code and replaces current accounts and data. A safety backup will be created first. Continue?',
      )
    )
      return;
    const button = $('#uploadBackup');
    button.disabled = true;
    try {
      const response = await fetch('/api/backups/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': session.csrf_token },
        body: file,
      });
      const result = await readResponse(response);
      if (!response.ok) throw new Error(result.error || 'Upload failed');
      await api('backups/restore', 'POST', { id: result.id });
      await refreshMaintenance();
    } catch (e) {
      error(e);
      button.disabled = false;
    }
  };
  if (busy) pollMaintenance();
}
// Diagram positions are a personal view; they never change delivery order or process links.
const diagramLayouts = new Map();
function diagramShell(items) {
  if (!items.length)
    return '<div class="empty"><h2>No delivery steps yet</h2><p>Add a step to start mapping your value stream and its processes.</p><button data-action="new-step">+ Add step</button></div>';
  const ids = new Set(items.map((s) => s.id));
  const linked = new Set(
    state.step_processes.filter((l) => ids.has(l.step_id)).map((l) => l.process_id),
  );
  return /* HTML */ `
    <div class="diagram-frame">
      <div class="diagram-toolbar">
        <div class="diagram-legend">
          <span>
            <i class="legend-step"></i>
            Delivery steps
            <b>${items.length}</b>
          </span>
          <span>
            <i class="legend-process"></i>
            Linked processes
            <b>${linked.size}</b>
          </span>
        </div>
        <div class="diagram-controls" role="group" aria-label="Diagram controls">
          <button data-diagram="zoom-out" aria-label="Zoom out" title="Zoom out (−)">−</button>
          <output id="diagramZoom" aria-label="Zoom level">100%</output>
          <button data-diagram="zoom-in" aria-label="Zoom in" title="Zoom in (+)">+</button>
          <button data-diagram="fit">Fit to screen</button>
          <button data-diagram="reset">Reset layout</button>
        </div>
      </div>
      <svg
        id="streamDiagram"
        class="stream-diagram"
        role="region"
        aria-label="Interactive value stream diagram"
        aria-describedby="diagramHelp"
        tabindex="0"
      >
        <defs>
          <pattern id="diagramGrid" width="24" height="24" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="1" class="diagram-dot" />
          </pattern>
          <marker
            id="flowArrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        <rect width="100%" height="100%" fill="url(#diagramGrid)" />
        <g class="diagram-scene">
          <g class="diagram-edges"></g>
          <g class="diagram-nodes"></g>
        </g>
      </svg>
    </div>
    <p id="diagramHelp" class="hint diagram-help">
      Drag the background to pan; drag a card to arrange it. Scroll or pinch to zoom. Double-click a
      step or process for details. With the diagram focused, use + / − to zoom and 0 to fit; use
      arrow keys to pan, or to move a focused card. Layout is saved in this browser. Delivery order
      is managed in Edit flow.
    </p>
  `;
}

class StreamDiagram {
  constructor(svg, items) {
    this.svg = svg;
    this.frame = svg.closest('.diagram-frame');
    this.scene = svg.querySelector('.diagram-scene');
    this.storageKey = `vsm-diagram-v2:${session.user.id}:${session.environment.id}:${selected}`;
    this.legacyStorageKey =
      session.environment.id === 1 ? `vsm-diagram-v1:${session.user.id}:${selected}` : null;
    this.nodes = new Map();
    this.edges = [];
    this.pointers = new Map();
    this.gesture = null;
    this.camera = { x: 0, y: 0, scale: 1 };
    this.listeners = new AbortController();
    const stream = state.streams.find((s) => s.id === selected);
    this.addNode({
      key: 'customer',
      kind: 'terminal',
      x: 40,
      y: 100,
      w: 220,
      h: 130,
      name: stream.customer || 'Customer need',
      caption: 'CUSTOMER / BENEFICIARY',
    });
    items.forEach((step, i) =>
      this.addNode({
        key: `step-${step.id}`,
        kind: 'step',
        id: step.id,
        x: 340 + i * 340,
        y: 80,
        w: 260,
        h: step.tag_ids?.length ? 205 : 170,
        tags: assignedTags(step),
        name: step.name,
        owner: step.owner,
        caption: `STEP ${String(i + 1).padStart(2, '0')}`,
        work: step.work_minutes,
        wait: step.wait_minutes,
      }),
    );
    this.addNode({
      key: 'outcome',
      kind: 'terminal',
      x: 340 + items.length * 340,
      y: 100,
      w: 220,
      h: 130,
      name: stream.outcome || 'Value delivered',
      caption: 'CUSTOMER VALUE',
    });
    const sequence = ['customer', ...items.map((s) => `step-${s.id}`), 'outcome'];
    if (stream.voc) {
      this.addNode({
        key: 'voc',
        kind: 'terminal',
        x: 680 + items.length * 340,
        y: 100,
        w: 280,
        h: 130,
        name: stream.voc,
        caption: 'VOICE OF THE CUSTOMER (VOC)',
      });
      sequence.push('voc');
    }
    sequence
      .slice(1)
      .forEach((key, i) => this.edges.push({ from: sequence[i], to: key, kind: 'flow' }));
    const rows = new Map(),
      processes = new Map(state.processes.map((p) => [p.id, p]));
    const stepIndexes = new Map(items.map((s, i) => [s.id, i]));
    const links = state.step_processes.filter(
      (l) => stepIndexes.has(l.step_id) && processes.has(l.process_id),
    );
    const processLinkCounts = new Map();
    for (const link of links)
      processLinkCounts.set(link.process_id, (processLinkCounts.get(link.process_id) || 0) + 1);
    links.forEach((link) => {
      const key = `process-${link.process_id}`;
      if (!this.nodes.has(key)) {
        const p = processes.get(link.process_id),
          column = stepIndexes.get(link.step_id),
          row = rows.get(column) || 0,
          count = processLinkCounts.get(p.id);
        rows.set(column, row + 1);
        this.addNode({
          key,
          kind: 'process',
          id: p.id,
          x: 350 + column * 340,
          y: 350 + row * 180,
          w: 240,
          h: p.tag_ids?.length ? 175 : 140,
          tags: assignedTags(p),
          name: p.name,
          owner: p.owner,
          description: p.description,
          caption: `PROCESS · ${count} LINKED ${count === 1 ? 'STEP' : 'STEPS'}`,
        });
      }
      this.edges.push({ from: `step-${link.step_id}`, to: key, kind: 'process' });
    });
    this.defaults = new Map([...this.nodes].map(([key, n]) => [key, { x: n.x, y: n.y }]));
    const saved = this.load();
    for (const [key, position] of Object.entries(saved.positions || {})) {
      if (this.nodes.has(key) && this.validPoint(position))
        Object.assign(this.nodes.get(key), { x: position.x, y: position.y });
    }
    this.restoreCamera =
      this.validPoint(saved.camera) &&
      Number.isFinite(saved.camera.scale) &&
      saved.camera.scale >= 0.02 &&
      saved.camera.scale <= 2.5;
    if (this.restoreCamera)
      this.camera = { x: saved.camera.x, y: saved.camera.y, scale: saved.camera.scale };
    this.draw();
    const signal = this.listeners.signal;
    svg.addEventListener('pointerdown', (e) => this.pointerDown(e), { signal });
    svg.addEventListener('pointermove', (e) => this.pointerMove(e), { signal });
    svg.addEventListener('pointerup', (e) => this.pointerUp(e), { signal });
    svg.addEventListener('pointercancel', (e) => this.pointerUp(e), { signal });
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom(Math.exp(-Math.max(-200, Math.min(200, e.deltaY)) * 0.003), this.point(e));
        this.save();
      },
      { passive: false, signal },
    );
    svg.addEventListener(
      'dblclick',
      (e) => {
        const node = e.target.closest('[data-node-key]');
        if (node) this.details(this.nodes.get(node.dataset.nodeKey));
      },
      { signal },
    );
    svg.addEventListener('keydown', (e) => this.keyDown(e), { signal });
    this.frame.querySelector('.diagram-controls').addEventListener(
      'click',
      (e) => {
        const action = e.target.closest('[data-diagram]')?.dataset.diagram;
        if (action === 'zoom-in') this.zoom(1.2);
        if (action === 'zoom-out') this.zoom(1 / 1.2);
        if (action === 'fit') this.fit();
        if (action === 'reset') {
          for (const [key, p] of this.defaults) Object.assign(this.nodes.get(key), p);
          this.drawPositions();
          this.fit();
        }
        if (action) this.save();
      },
      { signal },
    );
    this.observer = new ResizeObserver(() => {
      this.svg.setAttribute('viewBox', `0 0 ${this.svg.clientWidth} ${this.svg.clientHeight}`);
      if (!this.sized) {
        this.sized = true;
        if (this.restoreCamera) this.applyCamera();
        else this.fit();
      }
    });
    this.observer.observe(svg);
  }
  addNode(node) {
    this.nodes.set(node.key, node);
  }
  validPoint(p) {
    return (
      p &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y) &&
      Math.abs(p.x) <= 1e7 &&
      Math.abs(p.y) <= 1e7
    );
  }
  load() {
    try {
      return (
        diagramLayouts.get(this.storageKey) ||
        JSON.parse(
          localStorage.getItem(this.storageKey) ||
            (this.legacyStorageKey ? localStorage.getItem(this.legacyStorageKey) : null),
        ) ||
        {}
      );
    } catch {
      return {};
    }
  }
  save() {
    const data = {
      positions: Object.fromEntries([...this.nodes].map(([key, n]) => [key, { x: n.x, y: n.y }])),
      camera: { ...this.camera },
    };
    diagramLayouts.set(this.storageKey, data);
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch {
      /* Private browsing or full storage: retain the view for this session. */
    }
  }
  textLines(text, limit, maxLines) {
    const words = String(text || '')
        .split(/\s+/)
        .filter(Boolean),
      lines = [];
    let line = '';
    for (const word of words) {
      if ((line + ' ' + word).trim().length <= limit) line = (line + ' ' + word).trim();
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    const result = lines
      .slice(0, maxLines)
      .map((s) => (s.length > limit ? s.slice(0, limit - 1) + '…' : s));
    if (lines.length > maxLines)
      result[maxLines - 1] = result[maxLines - 1].slice(0, limit - 1) + '…';
    return result;
  }
  title(node) {
    return this.textLines(node.name, node.kind === 'step' ? 25 : 23, 2)
      .map(
        (line, i) => /* HTML */ `
          <tspan x="20" dy="${i ? 21 : 0}">${esc(line)}</tspan>
        `,
      )
      .join('');
  }
  draw() {
    this.svg.querySelector('.diagram-edges').innerHTML = this.edges
      .map(
        (e, i) => /* HTML */ `
          <path
            data-edge-index="${i}"
            class="diagram-edge ${e.kind}"
            ${e.kind === 'flow' ? 'marker-end="url(#flowArrow)"' : ''}
          >
            <title>
              ${e.kind === 'flow' ? 'Delivery sequence' : 'Linked process'}:
              ${esc(this.nodes.get(e.from).name)} → ${esc(this.nodes.get(e.to).name)}
            </title>
          </path>
        `,
      )
      .join('');
    this.svg.querySelector('.diagram-nodes').innerHTML = [...this.nodes.values()]
      .map((node) => this.nodeMarkup(node))
      .join('');
    this.drawPositions();
    this.applyCamera();
  }
  // SVG text is kept adjacent to its tags: formatting whitespace is visible here.
  nodeDetailsMarkup(node) {
    if (node.kind === 'step') {
      return `<text class="node-owner" x="20" y="104">${esc(this.textLines(node.owner || 'No owner assigned', 32, 1)[0])}</text>
        <path class="node-divider" d="M20 120 H${node.w - 20}"/>
        <text class="node-timing" x="20" y="147">Work ${duration(node.work)}</text>
        <text class="node-timing" x="140" y="147">Wait ${duration(node.wait)}</text>`;
    }
    if (node.kind === 'process') {
      return `<text class="node-owner" x="20" y="103">${esc(this.textLines(node.owner || 'No owner assigned', 30, 1)[0])}</text>
        <text class="node-description" x="20" y="124">${esc(this.textLines(node.description || 'Open for process details', 31, 1)[0])}</text>`;
    }
    return '<text class="node-owner" x="20" y="105">Value stream boundary</text>';
  }
  nodeTagsMarkup(node) {
    return (node.tags || [])
      .slice(0, 2)
      .map((tag, index) => {
        const x = 20 + index * 108;
        return `<g class="tag-color-${tag.id}"><rect class="svg-tag-bg" x="${x}" y="${node.h - 32}" width="100" height="22" rx="11"/>
        <text class="svg-tag-text" x="${x + 8}" y="${node.h - 17}">${esc(this.textLines(tag.name, 11, 1)[0])}</text></g>`;
      })
      .join('');
  }
  nodeMarkup(node) {
    const kind = node.kind === 'step' ? 'delivery-step' : node.kind;
    const label =
      node.caption +
      ': ' +
      node.name +
      '. Drag or use arrow keys to move.' +
      (node.kind !== 'terminal' ? ' Enter for details.' : '');
    const title =
      node.name +
      (node.owner ? ' — ' + node.owner : '') +
      (node.tags?.length ? ' · Tags: ' + node.tags.map((tag) => tag.name).join(', ') : '');
    return `<g class="diagram-node ${kind}" data-node-key="${node.key}" tabindex="0" role="button" aria-label="${esc(label)}">
      <title>${esc(title)}</title>
      <rect class="node-shadow" x="0" y="4" width="${node.w}" height="${node.h}" rx="12"/>
      <rect class="node-body" width="${node.w}" height="${node.h}" rx="12"/>
      <rect class="node-accent" x="0" y="12" width="4" height="${node.h - 24}" rx="2"/>
      <text class="node-caption" x="20" y="29">${esc(node.caption)}</text>
      <text class="node-title" x="20" y="57">${this.title(node)}</text>
      ${this.nodeDetailsMarkup(node)}${this.nodeTagsMarkup(node)}</g>`;
  }
  drawPositions() {
    this.svg.querySelectorAll('[data-node-key]').forEach((el) => {
      const n = this.nodes.get(el.dataset.nodeKey);
      el.setAttribute('transform', `translate(${n.x} ${n.y})`);
    });
    this.svg.querySelectorAll('[data-edge-index]').forEach((el) => {
      const e = this.edges[Number(el.dataset.edgeIndex)],
        a = this.nodes.get(e.from),
        b = this.nodes.get(e.to);
      let x1, y1, x2, y2, c1x, c1y, c2x, c2y;
      if (e.kind === 'flow') {
        const forward = b.x + b.w / 2 >= a.x + a.w / 2;
        x1 = a.x + (forward ? a.w : 0);
        y1 = a.y + a.h / 2;
        x2 = b.x + (forward ? 0 : b.w);
        y2 = b.y + b.h / 2;
        const curve = Math.max(45, Math.abs(x2 - x1) / 2);
        c1x = x1 + (forward ? curve : -curve);
        c1y = y1;
        c2x = x2 + (forward ? -curve : curve);
        c2y = y2;
      } else {
        const below = b.y + b.h / 2 >= a.y + a.h / 2,
          side = a.x + a.w / 2 > b.x + b.w / 2 ? 1 : -1;
        x1 = a.x + a.w / 2;
        y1 = a.y + (below ? a.h : 0);
        x2 = b.x + (side === 1 ? b.w : 0);
        y2 = b.y + b.h / 2;
        const lane = x2 + side * 36,
          bend = y1 + (below ? 50 : -50),
          approach = y2 >= bend ? 1 : -1;
        // Route beside stacked processes so a link never implies a process-to-process chain.
        el.setAttribute(
          'd',
          `M${x1} ${y1} C${x1} ${bend} ${lane} ${bend} ${lane} ${bend + (below ? 20 : -20)} L${lane} ${y2 - approach * 20} Q${lane} ${y2} ${x2} ${y2}`,
        );
        return;
      }
      el.setAttribute('d', `M${x1} ${y1} C${c1x} ${c1y} ${c2x} ${c2y} ${x2} ${y2}`);
    });
  }
  point(e) {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  world(point) {
    return {
      x: (point.x - this.camera.x) / this.camera.scale,
      y: (point.y - this.camera.y) / this.camera.scale,
    };
  }
  applyCamera() {
    this.scene.setAttribute(
      'transform',
      `translate(${this.camera.x} ${this.camera.y}) scale(${this.camera.scale})`,
    );
    $('#diagramZoom').textContent = Math.round(this.camera.scale * 100) + '%';
  }
  zoom(factor, anchor = { x: this.svg.clientWidth / 2, y: this.svg.clientHeight / 2 }) {
    const world = this.world(anchor),
      scale = Math.max(0.02, Math.min(2.5, this.camera.scale * factor));
    this.camera = { x: anchor.x - world.x * scale, y: anchor.y - world.y * scale, scale };
    this.applyCamera();
  }
  fit() {
    const nodes = [...this.nodes.values()],
      left = Math.min(...nodes.map((n) => n.x)),
      top = Math.min(...nodes.map((n) => n.y));
    const width = Math.max(...nodes.map((n) => n.x + n.w)) - left,
      height = Math.max(...nodes.map((n) => n.y + n.h)) - top;
    const scale = Math.max(
      0.02,
      Math.min(1, (this.svg.clientWidth - 64) / width, (this.svg.clientHeight - 64) / height),
    );
    this.camera = {
      x: (this.svg.clientWidth - width * scale) / 2 - left * scale,
      y: (this.svg.clientHeight - height * scale) / 2 - top * scale,
      scale,
    };
    this.applyCamera();
  }
  pointerDown(e) {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    const point = this.point(e);
    this.pointers.set(e.pointerId, point);
    const nodeElement = e.target.closest('[data-node-key]');
    (nodeElement || this.svg).setPointerCapture(e.pointerId);
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()],
        center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.gesture = {
        type: 'pinch',
        distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        scale: this.camera.scale,
        world: this.world(center),
      };
    } else if (this.pointers.size === 1) {
      const node =
        e.button === 0 && nodeElement ? this.nodes.get(nodeElement.dataset.nodeKey) : null;
      this.gesture = {
        type: node ? 'node' : 'pan',
        start: point,
        camera: { ...this.camera },
        node,
        nodeStart: node ? { x: node.x, y: node.y } : null,
      };
      (nodeElement || this.svg).focus({ preventScroll: true });
    }
    this.svg.classList.add('is-dragging');
  }
  pointerMove(e) {
    if (!this.pointers.has(e.pointerId) || !this.gesture) return;
    const point = this.point(e);
    this.pointers.set(e.pointerId, point);
    const g = this.gesture;
    if (g.type === 'pinch' && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()],
        center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const scale = Math.max(
        0.02,
        Math.min(2.5, (g.scale * Math.hypot(b.x - a.x, b.y - a.y)) / g.distance),
      );
      this.camera = { x: center.x - g.world.x * scale, y: center.y - g.world.y * scale, scale };
      this.applyCamera();
    } else if (g.type === 'node') {
      g.node.x = Math.max(
        -1e6,
        Math.min(1e6, g.nodeStart.x + (point.x - g.start.x) / this.camera.scale),
      );
      g.node.y = Math.max(
        -1e6,
        Math.min(1e6, g.nodeStart.y + (point.y - g.start.y) / this.camera.scale),
      );
      this.drawPositions();
    } else if (g.type === 'pan') {
      this.camera.x = g.camera.x + point.x - g.start.x;
      this.camera.y = g.camera.y + point.y - g.start.y;
      this.applyCamera();
    }
  }
  pointerUp(e) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 1)
      this.gesture = {
        type: 'pan',
        start: [...this.pointers.values()][0],
        camera: { ...this.camera },
      };
    else {
      this.gesture = null;
      this.svg.classList.remove('is-dragging');
    }
    this.save();
  }
  keyDown(e) {
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const key = e.target.closest('[data-node-key]')?.dataset.nodeKey,
      node = this.nodes.get(key);
    if (arrows[e.key]) {
      e.preventDefault();
      const [dx, dy] = arrows[e.key],
        distance = e.shiftKey ? 100 : 20;
      if (node) {
        node.x += dx * distance;
        node.y += dy * distance;
        this.drawPositions();
      } else {
        this.camera.x -= dx * distance;
        this.camera.y -= dy * distance;
        this.applyCamera();
      }
      this.save();
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      this.zoom(1.2);
      this.save();
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      this.zoom(1 / 1.2);
      this.save();
    } else if (e.key === '0') {
      e.preventDefault();
      this.fit();
      this.save();
    } else if ((e.key === 'Enter' || e.key === ' ') && node) {
      e.preventDefault();
      this.details(node);
    }
  }
  details(node) {
    if (node.kind === 'process') editProcess(node.id);
    if (node.kind === 'step') {
      if (canEdit()) editStep(node.id);
      else {
        const step = state.steps.find((s) => s.id === node.id);
        modal(
          'Step details',
          field('name', 'Step name', step.name) +
            field('owner', 'Responsible team / owner', step.owner) +
            field('work_minutes', 'Active work time (minutes)', step.work_minutes) +
            field('wait_minutes', 'Waiting time (minutes)', step.wait_minutes),
          null,
          true,
        );
      }
    }
  }
  destroy() {
    this.listeners.abort();
    this.observer.disconnect();
  }
}

$('#adminToggle').onclick = () => {
  const expanded = $('#adminToggle').getAttribute('aria-expanded') !== 'true';
  $('#adminToggle').setAttribute('aria-expanded', String(expanded));
  $('#adminEntries').hidden = !expanded;
};
$('#sidebarToggle').onclick = () => {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  const label = collapsed ? 'Expand menu' : 'Collapse menu';
  $('#sidebarToggle').setAttribute('aria-expanded', String(!collapsed));
  $('#sidebarToggle').setAttribute('aria-label', label);
  $('#sidebarToggle').title = label;
  $('#sidebarToggle span').textContent = label;
};

for (const name of Object.keys(VIEWS)) {
  navigationButton(name).onclick = () => navigate(name);
}

refresh().catch(error);
