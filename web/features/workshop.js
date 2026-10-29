import { esc } from '../lib/core.js';

const TYPES = {
  step: 'Process step',
  customer: 'Customer / VOC',
  wait: 'Wait / queue',
  decision: 'Decision',
  handoff: 'Handoff',
  pain: 'Pain point',
  improvement: 'Improvement',
  note: 'Sticky note',
};
const NS = 'http://www.w3.org/2000/svg';

export function createWorkshop({ api, canEdit, root, report }) {
  let boards = [],
    board = null,
    selection = null,
    timer,
    generation = 0;
  let svg,
    panel,
    status,
    presence,
    picker,
    dragging = null,
    busy = false;
  let camera = { x: 0, y: 0, w: 1500, h: 850 };
  const el = (name, attrs = {}, text) => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function stop() {
    generation++;
    clearTimeout(timer);
    dragging = null;
    svg = null;
    board = null;
    selection = null;
  }
  function message(text) {
    if (status) status.textContent = text;
  }
  function cameraView() {
    svg?.setAttribute('viewBox', `${camera.x} ${camera.y} ${camera.w} ${camera.h}`);
  }
  function point(event) {
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
  }
  function inspector() {
    const item = board?.items.find((i) => i.id === selection);
    if (!item) {
      panel.innerHTML =
        '<h2>Workshop notes</h2><p>Select a block to read or edit its details. Add blocks from the palette, then drag them into place.</p><p>Drag empty paper to pan. Scroll or use the zoom buttons. Use Connect blocks to draw the flow.</p><p>Changes are saved to this environment and shared with other participants.</p>';
      return;
    }
    const readonly = !canEdit();
    panel.innerHTML = `<h2>${esc(TYPES[item.kind] || 'Connector')}</h2><form id="workshopEdit"><label>Text<textarea name="text" rows="6" maxlength="2000" ${readonly ? 'readonly' : ''}>${esc(item.text)}</textarea></label><label>Owner<input name="owner" maxlength="160" value="${esc(item.owner)}" ${readonly ? 'readonly' : ''}></label><label>Map state<select name="phase" ${readonly ? 'disabled' : ''}>${['', 'Current state', 'Future state'].map((p) => `<option ${p === item.phase ? 'selected' : ''}>${p}</option>`).join('')}</select></label><label>Work time (minutes)<input name="work" type="number" min="0" max="1000000" step="any" value="${item.work}" ${readonly ? 'readonly' : ''}></label><label>Wait time (minutes)<input name="wait" type="number" min="0" max="1000000" step="any" value="${item.wait}" ${readonly ? 'readonly' : ''}></label>${readonly ? '<p>Read-only access</p>' : '<button type="submit">Save block</button><label><input type="checkbox" name="confirmDelete"> Confirm removal</label><button type="button" id="workshopRemove" class="danger">Remove block</button>'}</form>`;
    if (readonly) return;
    // Capture the version shown to the editor, never the latest polled version.
    const original = { ...item };
    panel.querySelector('form').onsubmit = (event) => {
      event.preventDefault();
      const values = new FormData(event.target);
      mutate(
        `items/${item.id}`,
        'PUT',
        {
          ...payload(original),
          revision: original.revision,
          text: values.get('text'),
          owner: values.get('owner'),
          phase: values.get('phase'),
          work: Number(values.get('work')),
          wait: Number(values.get('wait')),
        },
        true,
      );
    };
    panel.querySelector('#workshopRemove').onclick = () => {
      if (!panel.querySelector('[name=confirmDelete]').checked)
        return message('Check Confirm removal first.');
      mutate(`items/${item.id}`, 'DELETE', { revision: original.revision }, true);
    };
  }
  function payload(item) {
    const { id, revision, ...data } = item;
    return data;
  }
  function draw() {
    if (!svg || !board) return;
    const focused = svg.contains(document.activeElement)
      ? document.activeElement.closest('[data-item]')?.dataset.item
      : null;
    svg.replaceChildren();
    const defs = el('defs');
    const marker = el('marker', {
      id: 'workshopArrow',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse',
    });
    marker.append(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#334155' }));
    defs.append(marker);
    svg.append(defs);
    svg.append(el('rect', { x: 0, y: 0, width: 6000, height: 6000, class: 'workshop-paper' }));
    for (const i of board.items.filter((i) => i.kind === 'connector')) {
      const a = board.items.find((n) => n.id === i.source),
        b = board.items.find((n) => n.id === i.target);
      if (!a || !b) continue;
      const group = el('g', {
        'data-item': i.id,
        tabindex: 0,
        role: 'button',
        'aria-label': `Connector: ${i.text || 'Flow'}`,
      });
      // Choose attachment edges instead of drawing through the middle of blocks.
      const dx = b.x - a.x,
        dy = b.y - a.y;
      let x1 = a.x + 110,
        y1 = a.y + 65,
        x2 = b.x + 110,
        y2 = b.y + 65;
      if (Math.abs(dx) >= Math.abs(dy)) {
        x1 += dx >= 0 ? 110 : -110;
        x2 += dx >= 0 ? -110 : 110;
      } else {
        y1 += dy >= 0 ? 65 : -65;
        y2 += dy >= 0 ? -65 : 65;
      }
      group.append(
        el('line', {
          x1,
          y1,
          x2,
          y2,
          class: selection === i.id ? 'workshop-line selected' : 'workshop-line',
          'marker-end': 'url(#workshopArrow)',
        }),
      );
      group.append(
        el(
          'text',
          { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 10, class: 'workshop-arrow-label' },
          i.text.slice(0, 70),
        ),
      );
      svg.append(group);
    }
    for (const i of board.items.filter((i) => i.kind !== 'connector')) {
      const group = el('g', {
        transform: `translate(${i.x} ${i.y})`,
        'data-item': i.id,
        tabindex: 0,
        role: 'button',
        'aria-label': `${TYPES[i.kind]}: ${i.text}`,
        class: `workshop-block workshop-${i.kind}${selection === i.id ? ' selected' : ''}`,
      });
      group.append(el('rect', { width: 220, height: 130, rx: i.kind === 'decision' ? 30 : 5 }));
      group.append(el('text', { x: 12, y: 22, class: 'workshop-kind' }, TYPES[i.kind]));
      // Bound and wrap labels; full text remains in the inspector and tooltip.
      const words = i.text.replace(/\n/g, ' ').match(/\S{1,27}/g) || [];
      let line = '',
        lines = [];
      for (const word of words) {
        if ((line + ' ' + word).trim().length > 27) {
          lines.push(line);
          line = word;
        } else line = (line + ' ' + word).trim();
      }
      if (line) lines.push(line);
      lines
        .slice(0, 3)
        .forEach((text, n) =>
          group.append(
            el('text', { x: 12, y: 46 + n * 18 }, text + (n === 2 && lines.length > 3 ? '…' : '')),
          ),
        );
      group.append(
        el(
          'text',
          { x: 12, y: 118, class: 'workshop-meta' },
          `${i.phase ? i.phase + ' · ' : ''}${i.work || i.wait ? `Work ${i.work}m / Wait ${i.wait}m` : i.owner.slice(0, 27)}`,
        ),
      );
      group.append(el('title', {}, `${i.text}\nOwner: ${i.owner}\n${i.phase}`));
      svg.append(group);
    }
    presence.textContent = board.participants?.length
      ? `Present: ${board.participants.map((p) => p.username).join(', ')}`
      : 'Connecting participants…';
    cameraView();
    if (focused) svg.querySelector(`[data-item="${focused}"]`)?.focus();
  }
  async function mutate(path, method, data, resetInspector = false) {
    if (busy || !board) return;
    busy = true;
    const token = generation,
      id = board.id;
    message('Saving…');
    try {
      const result = await api(`workshops/${id}/${path}`, method, data);
      if (token !== generation) return;
      board = result;
      if (!board.items.some((i) => i.id === selection)) selection = null;
      draw();
      if (resetInspector) inspector();
      message('Saved · Shared canvas');
    } catch (e) {
      if (token !== generation) return;
      // Refresh after a conflict; never automatically retry an old write.
      try {
        board = await api(`workshops/${id}`);
      } catch {
        /* retain existing board */
      }
      if (token !== generation) return;
      selection = null;
      draw();
      inspector();
      message(e.message);
      report(e);
    } finally {
      if (token === generation) busy = false;
    }
  }
  async function tick(token) {
    if (token !== generation || !board) return;
    try {
      if (!dragging && !busy && !document.hidden) {
        await api(`workshops/${board.id}/presence`, 'POST', {});
        const result = await api(`workshops/${board.id}`);
        if (token !== generation) return;
        // A response begun before a local write must not replace its newer result.
        if (!busy && !dragging && result.revision >= board.revision) {
          board = result;
          if (selection && !board.items.some((i) => i.id === selection)) {
            selection = null;
            inspector();
          }
          draw();
          message('Connected · Changes sync every 2 seconds');
        }
      }
    } catch (e) {
      if (token === generation) message(`Connection interrupted: ${e.message}. Retrying…`);
    }
    if (token === generation) timer = setTimeout(() => tick(token), 2000);
  }
  async function open(id) {
    const token = ++generation;
    clearTimeout(timer);
    busy = false;
    selection = null;
    board = null;
    svg.replaceChildren();
    inspector();
    message('Opening workshop…');
    try {
      const result = await api(`workshops/${id}`);
      if (token !== generation) return;
      board = result;
      picker.value = String(id);
      camera = { x: 0, y: 0, w: 1500, h: 850 };
      draw();
      inspector();
      tick(token);
    } catch (e) {
      if (token === generation) {
        board = null;
        svg.replaceChildren();
        message(e.message);
      }
    }
  }
  function connectForm() {
    if (!board || !canEdit()) return;
    const nodes = board.items.filter((i) => i.kind !== 'connector');
    const options = nodes
      .map(
        (i) =>
          `<option value="${i.id}">${esc((i.text || TYPES[i.kind]).slice(0, 65))} (#${i.id})</option>`,
      )
      .join('');
    panel.innerHTML = `<h2>Connect blocks</h2><form><label>From<select name="source">${options}</select></label><label>To<select name="target">${options}</select></label><label>Label<input name="text" maxlength="70"></label><button ${nodes.length < 2 ? 'disabled' : ''}>Add connector</button></form>`;
    panel.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      mutate('items', 'POST', {
        kind: 'connector',
        source: Number(f.get('source')),
        target: Number(f.get('target')),
        text: f.get('text'),
      });
    };
  }
  function mount() {
    stop();
    busy = false;
    const container = root();
    container.innerHTML = `<div class="title-row"><div><h1>Value Stream Mapping</h1><p>Brown paper workshops · Map the current state and design the future together.</p></div></div><div class="workshop-toolbar"><label>Workshop<select id="workshopPicker"><option value="">Select a workshop</option></select></label><button id="refreshWorkshops">Refresh workshops</button>${canEdit() ? '<form id="newWorkshop"><input name="name" aria-label="New workshop name" placeholder="New workshop name" maxlength="160" required><button>Create workshop</button></form><button id="deleteWorkshop" class="danger">Delete workshop</button>' : '<span class="pill">Read-only access</span>'}</div><div class="workshop-palette" aria-label="Building blocks">${
      canEdit()
        ? Object.entries(TYPES)
            .map(([kind, label]) => `<button data-block="${kind}">+ ${label}</button>`)
            .join('') + '<button id="connectWorkshop">Connect blocks →</button>'
        : ''
    }<button id="workshopOut" aria-label="Zoom out">−</button><button id="workshopIn" aria-label="Zoom in">+</button><button id="workshopHome">Reset view</button></div><p id="workshopPresence" class="hint"></p><p id="workshopStatus" role="status">Choose or create a workshop.</p><div class="workshop-layout"><svg id="workshopCanvas" aria-label="Shared value stream mapping canvas" role="group" tabindex="0"></svg><aside id="workshopInspector" class="workshop-inspector"></aside></div>`;
    svg = container.querySelector('#workshopCanvas');
    panel = container.querySelector('#workshopInspector');
    status = container.querySelector('#workshopStatus');
    presence = container.querySelector('#workshopPresence');
    picker = container.querySelector('#workshopPicker');
    inspector();
    const token = generation;
    api('workshops')
      .then((result) => {
        if (token !== generation) return;
        boards = result;
        picker.innerHTML += boards
          .map((b) => `<option value="${b.id}">${esc(b.name)}</option>`)
          .join('');
        if (boards.length) open(boards[0].id);
      })
      .catch((e) => {
        if (token === generation) report(e);
      });
    container.querySelector('#refreshWorkshops').onclick = async () => {
      const token = generation;
      try {
        const result = await api('workshops');
        if (token !== generation) return;
        boards = result;
        picker.innerHTML =
          '<option value="">Select a workshop</option>' +
          boards.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
        if (board && boards.some((b) => b.id === board.id)) picker.value = String(board.id);
        else if (boards.length) open(boards[0].id);
        else {
          generation++;
          clearTimeout(timer);
          board = null;
          selection = null;
          busy = false;
          svg.replaceChildren();
          inspector();
          presence.textContent = '';
          message('No workshops. Create one to start a shared session.');
        }
      } catch (e) {
        if (token === generation) report(e);
      }
    };
    picker.onchange = () => {
      if (picker.value) open(Number(picker.value));
      else picker.value = board ? String(board.id) : '';
    };
    const form = container.querySelector('#newWorkshop');
    if (form)
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (busy) return;
        const token = generation;
        busy = true;
        try {
          const b = await api('workshops', 'POST', { name: new FormData(form).get('name') });
          if (token !== generation) return;
          picker.add(new Option(b.name, String(b.id)));
          form.reset();
          open(b.id);
        } catch (e) {
          if (token === generation) report(e);
        } finally {
          if (token === generation) busy = false;
        }
      };
    container.querySelector('#deleteWorkshop')?.addEventListener('click', () => {
      if (!board || busy) return;
      const original = board;
      panel.innerHTML = `<h2>Delete workshop</h2><p>This removes all blocks and connectors. Type ${esc(original.name)} to confirm.</p><form><input name="confirmation" aria-label="Workshop deletion confirmation" required><button class="danger">Delete permanently</button></form>`;
      panel.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const token = generation;
        try {
          await api(`workshops/${original.id}`, 'DELETE', {
            confirmation: new FormData(e.target).get('confirmation'),
          });
          if (token === generation) mount();
        } catch (e) {
          if (token === generation) report(e);
        }
      };
    });
    container.querySelectorAll('[data-block]').forEach(
      (button) =>
        (button.onclick = () => {
          if (!board) return message('Create or select a workshop first.');
          let x = Math.max(0, Math.min(5780, camera.x + camera.w / 2 - 110));
          let y = Math.max(0, Math.min(5870, camera.y + camera.h / 2 - 65));
          for (
            let n = 0;
            n < 1000 &&
            board.items.some(
              (i) => i.kind !== 'connector' && Math.abs(i.x - x) < 230 && Math.abs(i.y - y) < 140,
            );
            n++
          ) {
            x += 250;
            if (x > Math.min(5780, camera.x + camera.w - 220)) {
              x = Math.max(0, Math.min(5780, camera.x + 30));
              y = Math.min(5870, y + 160);
            }
          }
          mutate('items', 'POST', {
            kind: button.dataset.block,
            text: TYPES[button.dataset.block],
            x,
            y,
          });
        }),
    );
    container.querySelector('#connectWorkshop')?.addEventListener('click', connectForm);
    function zoom(factor) {
      const w = Math.max(450, Math.min(6500, camera.w * factor)),
        h = (w * camera.h) / camera.w;
      camera.x += (camera.w - w) / 2;
      camera.y += (camera.h - h) / 2;
      camera.w = w;
      camera.h = h;
      cameraView();
    }
    container.querySelector('#workshopIn').onclick = () => zoom(0.8);
    container.querySelector('#workshopOut').onclick = () => zoom(1.25);
    container.querySelector('#workshopHome').onclick = () => {
      camera = { x: 0, y: 0, w: 1500, h: 850 };
      cameraView();
    };
    svg.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        zoom(e.deltaY > 0 ? 1.1 : 0.9);
      },
      { passive: false },
    );
    svg.onpointerdown = (e) => {
      if (!board || busy || e.button !== 0) return;
      const node = e.target.closest('[data-item]'),
        item = board.items.find((i) => i.id === Number(node?.dataset.item));
      if (item) {
        selection = item.id;
        inspector();
        draw();
      }
      const p = point(e);
      dragging = {
        pointer: e.pointerId,
        point: p,
        camera: { ...camera },
        item: canEdit() && item?.kind !== 'connector' ? item : null,
        moved: false,
      };
      svg.setPointerCapture(e.pointerId);
    };
    svg.onpointermove = (e) => {
      if (!dragging || dragging.pointer !== e.pointerId) return;
      const p = point(e),
        d = dragging;
      const dx = p.x - d.point.x,
        dy = p.y - d.point.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.item) {
        const x = Math.max(0, Math.min(5780, d.item.x + dx)),
          y = Math.max(0, Math.min(5870, d.item.y + dy));
        d.next = { x, y };
        svg
          .querySelector(`[data-item="${d.item.id}"]`)
          ?.setAttribute('transform', `translate(${x} ${y})`);
      } else {
        // Screen deltas avoid feedback when the viewBox changes during panning.
        const rect = svg.getBoundingClientRect();
        if (!d.screen) d.screen = { x: e.clientX, y: e.clientY };
        camera.x = d.camera.x - ((e.clientX - d.screen.x) * camera.w) / rect.width;
        camera.y = d.camera.y - ((e.clientY - d.screen.y) * camera.h) / rect.height;
        cameraView();
      }
    };
    const finish = (e) => {
      const d = dragging;
      if (!d || d.pointer !== e.pointerId) return;
      dragging = null;
      if (e.type === 'pointercancel') {
        draw();
        return;
      }
      if (d.item && d.moved && d.next)
        mutate(
          `items/${d.item.id}`,
          'PUT',
          { ...payload(d.item), ...d.next, revision: d.item.revision },
          true,
        );
    };
    svg.onpointerup = finish;
    svg.onpointercancel = finish;
    svg.onkeydown = (e) => {
      const id = Number(e.target.closest('[data-item]')?.dataset.item);
      if ((e.key === 'Enter' || e.key === ' ') && id) {
        e.preventDefault();
        selection = id;
        inspector();
        draw();
      }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const item = board?.items.find((i) => i.id === id);
        const dx = e.key === 'ArrowLeft' ? -20 : e.key === 'ArrowRight' ? 20 : 0;
        const dy = e.key === 'ArrowUp' ? -20 : e.key === 'ArrowDown' ? 20 : 0;
        if (item && canEdit() && item.kind !== 'connector')
          mutate(
            `items/${id}`,
            'PUT',
            {
              ...payload(item),
              x: Math.max(0, Math.min(5780, item.x + dx)),
              y: Math.max(0, Math.min(5870, item.y + dy)),
              revision: item.revision,
            },
            true,
          );
        else {
          camera.x += dx * 5;
          camera.y += dy * 5;
          cameraView();
        }
      }
    };
  }
  return { mount, stop };
}
