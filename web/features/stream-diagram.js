import { esc, duration, VALUE_RATINGS } from '../lib/core.js';

const diagramLayouts = new Map();

export function createStreamDiagram({
  getState,
  getSession,
  getSelected,
  assignedTags,
  editProcess,
  editStep,
  canEdit,
  modal,
  stepFields,
  $,
}) {
  return class StreamDiagram {
    constructor(svg, items) {
      this.svg = svg;
      this.frame = svg.closest('.diagram-frame');
      this.scene = svg.querySelector('.diagram-scene');
      this.storageKey = `vsm-diagram-v2:${getSession().user.id}:${getSession().environment.id}:${getSelected()}`;
      this.legacyStorageKey =
        getSession().environment.id === 1
          ? `vsm-diagram-v1:${getSession().user.id}:${getSelected()}`
          : null;
      this.nodes = new Map();
      this.edges = [];
      this.pointers = new Map();
      this.gesture = null;
      this.camera = { x: 0, y: 0, scale: 1 };
      this.listeners = new AbortController();
      const stream = getState().streams.find((s) => s.id === getSelected());
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
          h: step.tag_ids?.length ? 259 : 224,
          lead: step.work_minutes + step.wait_minutes,
          cva: step.cva,
          bva: step.bva,
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
        processes = new Map(getState().processes.map((p) => [p.id, p]));
      const stepIndexes = new Map(items.map((s, i) => [s.id, i]));
      const links = getState().step_processes.filter(
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
        <text class="node-timing" x="20" y="147">Cycle ${duration(node.work)}</text>
        <text class="node-timing" x="140" y="147">Wait ${duration(node.wait)}</text>
        <text class="node-timing" x="20" y="172">Lead ${duration(node.lead)}</text>
        <text class="node-owner" x="20" y="196">${esc(['cva', 'bva'].map((key) => `${key.toUpperCase()}: ${node[key] ? `${node[key]} - ${VALUE_RATINGS[node[key]]}` : 'Not rated'}`).join(' · '))}</text>`;
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
      const arrows = {
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
      };
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
          const step = getState().steps.find((s) => s.id === node.id);
          modal('Step details', stepFields(step), null, true);
        }
      }
    }
    destroy() {
      this.listeners.abort();
      this.observer.disconnect();
    }
  };
}
