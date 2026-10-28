export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

export function buildWorkspaceIndex(data) {
  const group = (items, key) => {
    const groups = new Map();
    for (const item of items || []) {
      if (!groups.has(item[key])) groups.set(item[key], []);
      groups.get(item[key]).push(item);
    }
    return groups;
  };
  const stepsByStream = group(data?.steps, 'stream_id');
  for (const items of stepsByStream.values())
    items.sort((a, b) => a.position - b.position || a.id - b.id);
  return {
    stepsByStream,
    linksByStep: group(data?.step_processes, 'step_id'),
    linksByProcess: group(data?.step_processes, 'process_id'),
    processes: new Map((data?.processes || []).map((process) => [process.id, process])),
    tags: new Map((data?.tags || []).map((tag) => [tag.id, tag])),
  };
}

export const duration = (n) => `${Number(n.toFixed(1))} min`;

export function formValues(form) {
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
  for (const key of ['cva', 'bva', 'takt_available_minutes', 'takt_demand']) {
    if (key in data) data[key] = data[key] === '' ? null : Number(data[key]);
  }
  return data;
}
export function serviceTimeMetrics(items, stream = {}) {
  const cycle = items.reduce((total, step) => total + step.work_minutes, 0);
  const wait = items.reduce((total, step) => total + step.wait_minutes, 0);
  const takt =
    stream.takt_available_minutes > 0 && stream.takt_demand > 0
      ? stream.takt_available_minutes / stream.takt_demand
      : null;
  return {
    cycle,
    wait,
    lead: cycle + wait,
    takt,
    efficiency: cycle + wait ? Math.round((cycle / (cycle + wait)) * 100) : 0,
  };
}

export const VALUE_RATINGS = { 1: 'Low', 2: 'Medium', 3: 'High' };
