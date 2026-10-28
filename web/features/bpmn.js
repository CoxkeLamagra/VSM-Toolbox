import { esc } from '../lib/core.js';

export function bpmnTextLines(text, width, maxLines, measure) {
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
export function bpmnRoutes(nodes, edges) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return edges.map((edge) => {
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
}
export function bpmnLabelLayout(nodes, routes, measure) {
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
  return { labels, place };
}
export function bpmnMarkup(process) {
  if (!process?.bpmn) return '';
  const { nodes, edges, omitted_flows } = process.bpmn;
  const context = document.createElement('canvas').getContext('2d');
  context.font = '12px sans-serif';
  const measure = (text) => context.measureText(text).width;
  const routes = bpmnRoutes(nodes, edges);
  const { labels, place } = bpmnLabelLayout(nodes, routes, measure);
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
