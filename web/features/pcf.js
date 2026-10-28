import { esc } from '../lib/core.js';

export function createPCFFeature({ getState, getView, canEdit, api, refresh, modal, field, $ }) {
  let pcfMode = 'tiles',
    pcfFocus = null;
  const PCF_TYPES = ['Category', 'Process Group', 'Process', 'Activity', 'Task'];
  function pcfChildren(parentId) {
    return getState()
      .pcf_entries.filter((entry) => entry.parent_id === parentId)
      .sort((a, b) => a.number - b.number);
  }
  function pcfLabel(entry) {
    return `${entry.index} ${entry.name}`;
  }
  function pcfPicker(stream) {
    return `
      <fieldset class="tag-picker pcf-picker">
        <legend>Linked PCF entries</legend>
        <input type="hidden" name="_pcf_picker" value="1" />
        <label>
          Find PCF entries
          <input
            type="search"
            id="pcfLinkSearch"
            placeholder="Search by index, name, or reference"
          />
        </label>
        <div id="pcfLinkOptions">
          ${
            getState()
              .pcf_entries.map(
                (entry) => `
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
              .join('') || '<p>No PCF entries yet. Create them in the PCF framework screen.</p>'
          }
        </div>
      </fieldset>
    `;
  }
  function pcfStreamLinks(stream) {
    const entries = getState().pcf_entries.filter((entry) =>
      (stream.pcf_ids || []).includes(entry.id),
    );
    return `
      <section class="pcf-linked context">
        <div>
          <b>PCF CLASSIFICATIONS</b>
          <div class="pcf-link-list">
            ${
              entries
                .map(
                  (entry) => `
                  <button class="text-button" data-action="open-pcf" data-id="${entry.id}">
                    ${esc(pcfLabel(entry))}
                  </button>
                `,
                )
                .join('') || '<p>No PCF classifications linked.</p>'
            }
          </div>
        </div>
        ${
          canEdit()
            ? '<button class="text-button" data-action="edit-stream">Manage PCF links</button>'
            : ''
        }
      </section>
    `;
  }
  function pcfActions(entry) {
    if (!canEdit()) return '';
    return `
      <div class="detail-actions">
        ${
          entry.entry_type !== 'Task'
            ? `
              <button data-action="new-pcf" data-parent="${entry.id}">
                + Add ${PCF_TYPES[PCF_TYPES.indexOf(entry.entry_type) + 1]}
              </button>
            `
            : ''
        }
        <button data-action="edit-pcf" data-id="${entry.id}">Edit entry</button>
        <button class="danger" data-action="delete-pcf" data-id="${entry.id}">Delete entry</button>
      </div>
    `;
  }
  function pcfIndex(entries) {
    return `
      <ul class="pcf-index">
        ${entries
          .map((entry) => {
            const children = pcfChildren(entry.id);
            return `
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
                  ${
                    canEdit()
                      ? `
                        <button class="text-button" data-action="edit-pcf" data-id="${entry.id}">
                          Edit
                        </button>
                      `
                      : ''
                  }
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
    return `
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
    panel.innerHTML = `
      <h2>Review CSV import</h2>
      <p>
        ${preview.total} entries: ${preview.new} new and ${preview.duplicates.length} duplicate APQC
        reference IDs. No changes have been saved.
      </p>
      ${
        preview.duplicates.length
          ? `
            <p>
              Yes overwrites the existing name, number, and parent. No keeps the existing entry. For
              Yes, the Description column also replaces the description (including blank values).
              Omit that column to keep existing descriptions. Value stream links are preserved.
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
                      (row) => `
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
          : ''
      }
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
      if (getView() !== 'pcf' || !canEdit()) return;
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
      if (getView() === 'pcf') {
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
    const focused = getState().pcf_entries.find((entry) => entry.id === pcfFocus);
    if (!focused) pcfFocus = null;
    const entries = pcfChildren(pcfFocus),
      ancestors = [];
    let current = focused;
    while (current) {
      ancestors.unshift(current);
      current = getState().pcf_entries.find((entry) => entry.id === current.parent_id);
    }
    const linked = focused
      ? getState().streams.filter((stream) => (stream.pcf_ids || []).includes(focused.id))
      : [];
    $('#breadcrumb').textContent = 'PCF framework';
    $('#content').innerHTML = `
      <div class="eyebrow">PROCESS CLASSIFICATION FRAMEWORK</div>
      <div class="title-row">
        <div>
          <h1>PCF framework</h1>
          <p>Document your APQC classifications from category to task.</p>
        </div>
        ${
          canEdit()
            ? `<div class="detail-actions"><button data-action="pcf-import-toggle" aria-controls="pcfImportPanel" aria-expanded="${pcfImportOpen}">Import from CSV</button><button class="primary" data-action="new-pcf">+ Add PCF entry</button></div>`
            : ''
        }
      </div>
      ${pcfImportPanel()}
      <nav class="pcf-breadcrumb" aria-label="PCF hierarchy">
        <button class="text-button" data-action="pcf-root">All categories</button>
        ${ancestors
          .map(
            (entry) => `
              <span aria-hidden="true">/</span>
              <button class="text-button" data-action="open-pcf" data-id="${entry.id}">
                ${esc(pcfLabel(entry))}
              </button>
            `,
          )
          .join('')}
      </nav>
      ${
        focused
          ? `
            <section class="pcf-detail">
              <span class="pill">${esc(focused.entry_type)}</span>
              <h2>${esc(pcfLabel(focused))}</h2>
              ${
                focused.reference
                  ? `
                    <p>APQC reference: ${esc(focused.reference)}</p>
                  `
                  : ''
              }
              <p class="pcf-description">${esc(focused.description || 'No description provided.')}</p>
              ${pcfActions(focused)}
              <div class="pcf-associated">
                <b>Linked value streams</b>
                ${
                  linked
                    .map(
                      (stream) => `
                      <button class="text-button" data-action="pcf-stream" data-id="${stream.id}">
                        ${esc(stream.name)}
                      </button>
                    `,
                    )
                    .join('') || '<p>No value streams linked directly to this entry.</p>'
                }
              </div>
            </section>
          `
          : ''
      }
      <div class="section-row">
        <h2>
          ${
            focused
              ? focused.entry_type === 'Task'
                ? 'Task details'
                : 'Child entries'
              : 'Categories'
          }
        </h2>
        <div class="view-switch" role="group" aria-label="PCF view">
          <button data-action="pcf-tiles" aria-pressed="${pcfMode === 'tiles'}">Tiles</button>
          <button data-action="pcf-index" aria-pressed="${pcfMode === 'index'}">Index</button>
        </div>
      </div>
      ${
        entries.length
          ? pcfMode === 'index'
            ? pcfIndex(entries)
            : `
              <div class="grid pcf-grid">
                ${entries
                  .map(
                    (entry) => `
                      <article class="pcf-tile" data-action="open-pcf" data-id="${entry.id}">
                        <span class="pill">${esc(entry.entry_type)}</span>
                        <h3>
                          <button
                            class="pcf-tile-open"
                            data-action="open-pcf"
                            data-id="${entry.id}"
                          >
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
          : `
            <div class="empty">
              <h2>${focused ? 'No child entries' : 'Start your PCF framework'}</h2>
              <p>
                ${
                  focused?.entry_type === 'Task'
                    ? 'Task is the final classification level.'
                    : 'Add entries manually to build your numbered process hierarchy.'
                }
              </p>
              ${
                canEdit() && (!focused || focused.entry_type !== 'Task')
                  ? `
                    <button data-action="new-pcf" ${focused ? `data-parent="${focused.id}"` : ''}>
                      + Add
                      ${focused ? PCF_TYPES[PCF_TYPES.indexOf(focused.entry_type) + 1] : 'Category'}
                    </button>
                  `
                  : ''
              }
            </div>
          `
      }
    `;
    renderPCFImportPreview();
  }
  function editPCF(id, parentId) {
    const entry = getState().pcf_entries.find((item) => item.id === id);
    const parent = getState().pcf_entries.find((item) => item.id === parentId);
    const kind =
      entry?.entry_type ||
      (parent ? PCF_TYPES[PCF_TYPES.indexOf(parent.entry_type) + 1] : 'Category');
    modal(
      entry ? 'Edit PCF entry' : 'Add PCF entry',
      field('name', 'Entry name', entry?.name) +
        `
          <label>
            Entry type
            <select name="entry_type" id="pcfEntryType" aria-label="Entry type">
              ${PCF_TYPES.map(
                (type) => `
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
      const options = getState().pcf_entries.filter(
        (item) => item.entry_type === PCF_TYPES[level - 1] && item.id !== id,
      );
      $('#pcfParent').innerHTML = level
        ? '<option value="">Choose a parent</option>' +
          options
            .map(
              (item) => `
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

  return {
    pcfChildren,
    pcfLabel,
    pcfPicker,
    pcfStreamLinks,
    pcfActions,
    pcfIndex,
    pcfImportPanel,
    renderPCFImportPreview,
    previewPCFImport,
    applyPCFImport,
    renderPCF,
    editPCF,
    get mode() {
      return pcfMode;
    },
    set mode(value) {
      pcfMode = value;
    },
    get focus() {
      return pcfFocus;
    },
    set focus(value) {
      pcfFocus = value;
    },
    get importState() {
      return pcfImportState;
    },
    set importState(value) {
      pcfImportState = value;
    },
    get importOpen() {
      return pcfImportOpen;
    },
    set importOpen(value) {
      pcfImportOpen = value;
    },
  };
}
