(async () => {
  const common = await import('../web/lib/core.js');
  const bpmn = await import('../web/features/bpmn.js');
  // Shared form serialization and stylesheet refresh behavior, without browser dependencies.
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync('web/app.js', 'utf8');
  let href = '/branding.css',
    changes = 0;
  const link = {
    getAttribute: () => href,
    set href(value) {
      href = value;
      changes++;
    },
  };
  const context = vm.createContext({
    $: () => link,
    brandSettings: { primary: '#e6404d', sidebar: '#151d44', background: '#f5f6fa' },
    state: { tags: [] },
    FormData: class {
      constructor(entries) {
        return entries;
      }
    },
  });
  vm.runInContext(
    source.slice(
      source.indexOf('function syncThemeStylesheet()'),
      source.indexOf('function stats('),
    ),
    context,
  );
  context.formValues = common.formValues;
  const previousFormData = global.FormData;
  global.FormData = context.FormData;
  const values = (entries) => JSON.parse(JSON.stringify(context.formValues(entries)));
  assert.deepEqual(
    values([
      ['name', 'Service'],
      ['_tag_picker', '1'],
      ['_tag_12', 'on'],
      ['_tag_3', 'on'],
    ]),
    { name: 'Service', tag_ids: [12, 3] },
  );
  assert.deepEqual(
    values([
      ['name', 'Service'],
      ['_tag_picker', '1'],
    ]),
    { name: 'Service', tag_ids: [] },
  );
  assert.deepEqual(values([['name', 'Category']]), { name: 'Category' });
  assert.deepEqual(
    values([
      ['name', 'Service'],
      ['_pcf_picker', '1'],
      ['_pcf_4', 'on'],
      ['_pcf_8', 'on'],
      ['_tag_picker', '1'],
    ]),
    { name: 'Service', tag_ids: [], pcf_ids: [4, 8] },
  );
  assert.deepEqual(
    values([
      ['name', 'Service'],
      ['_pcf_picker', '1'],
    ]),
    { name: 'Service', pcf_ids: [] },
  );
  context.syncThemeStylesheet();
  const initial = href;
  context.syncThemeStylesheet();
  assert.equal(changes, 1, 'An unchanged refresh must not reload the stylesheet');
  context.state.tags = Array.from({ length: 5000 }, (_, id) => ({ id, color: '#123456' }));
  context.syncThemeStylesheet();
  assert.notEqual(href, initial);
  assert.ok(href.length < 40, 'Large tag catalogs must not create oversized stylesheet URLs');
  const previous = href;
  context.state.tags[0].color = '#abcdef';
  context.syncThemeStylesheet();
  assert.notEqual(href, previous);
  context.state = null;
  context.syncThemeStylesheet();
  assert.equal(href, initial, 'Sign-in branding must work without workspace data');
  console.log(
    'Frontend helper tests passed: tag form encoding, stable stylesheet loading, large catalogs, color changes, and sign-in.',
  );

  // Application administration and environment permissions are independent.
  const access = vm.createContext({
    VIEWS: {
      streams: {},
      environments: {},
      tags: { environmentAdminOnly: true },
      accounts: { adminOnly: true },
    },
    session: {},
    environmentAdmin: () => access.session.environment?.role === 'Admin',
  });
  vm.runInContext(
    source.slice(
      source.indexOf('function canAccessView('),
      source.indexOf('function navigationButton('),
    ),
    access,
  );
  assert.equal(access.canAccessView('environments'), false);
  access.session = { user: { role: 'Admin' } };
  assert.equal(
    access.canAccessView('accounts'),
    true,
    'App Admin retains global pages with no environment',
  );
  assert.equal(access.canAccessView('streams'), false);
  assert.equal(access.canAccessView('tags'), false);
  assert.equal(access.canAccessView('environments'), true);
  for (const role of ['Viewer', 'Editor', 'Admin']) {
    access.session = { user: { role: 'Viewer' }, environment: { role } };
    assert.equal(access.canAccessView('streams'), true);
    assert.equal(access.canAccessView('accounts'), false);
    assert.equal(access.canAccessView('tags'), role === 'Admin');
  }
  assert.equal(access.canAccessView('unknown'), false);
  console.log(
    'Page access checks passed: signed out, no environment, application and environment roles.',
  );

  const bpmnText = bpmn;
  for (const name of [
    'Register Problem',
    'Document as Known Error',
    'AReallyLongUnbrokenTaskName',
    '审批服务请求',
  ]) {
    const lines = bpmnText.bpmnTextLines(name, 80, 3, (value) => Array.from(value).length * 7);
    assert.ok(lines.length <= 3);
    assert.ok(lines.every((line) => Array.from(line).length * 7 <= 80));
  }
  assert.deepEqual(
    Array.from(
      bpmnText.bpmnTextLines(
        'A long task title that must be truncated',
        40,
        1,
        (value) => value.length * 7,
      ),
    ),
    ['A…'],
  );
  console.log('BPMN wrapping checks passed: box widths, long words, Unicode, and truncation.');

  const serviceTimes = common;
  const metrics = (steps, stream) =>
    JSON.parse(JSON.stringify(serviceTimes.serviceTimeMetrics(steps, stream)));
  assert.deepEqual(
    metrics(
      [
        { work_minutes: 10, wait_minutes: 20 },
        { work_minutes: 5, wait_minutes: 10 },
      ],
      { takt_available_minutes: 420, takt_demand: 35 },
    ),
    { cycle: 15, wait: 30, lead: 45, takt: 12, efficiency: 33 },
  );
  assert.deepEqual(metrics([], {}), { cycle: 0, wait: 0, lead: 0, takt: null, efficiency: 0 });
  assert.equal(metrics([], { takt_available_minutes: 420, takt_demand: 0 }).takt, null);
  assert.equal(metrics([], { takt_available_minutes: 420, takt_demand: null }).takt, null);
  assert.deepEqual(
    values([
      ['takt_available_minutes', '420'],
      ['takt_demand', ''],
      ['takt_period', 'day'],
    ]),
    { takt_available_minutes: 420, takt_demand: null, takt_period: 'day' },
  );
  console.log(
    'Service timing checks passed: active cycle, elapsed lead, takt, empty streams, and optional inputs.',
  );

  const workspace = common;
  const input = {
    steps: [
      { id: 2, stream_id: 1, position: 1 },
      { id: 1, stream_id: 1, position: 0 },
    ],
    step_processes: [{ step_id: 1, process_id: 7 }],
    processes: [{ id: 7, name: 'Support' }],
    tags: [{ id: 9, name: 'Critical' }],
  };
  const indexed = workspace.buildWorkspaceIndex(input);
  assert.deepEqual(
    Array.from(indexed.stepsByStream.get(1), (step) => step.id),
    [1, 2],
  );
  assert.deepEqual(
    input.steps.map((step) => step.id),
    [2, 1],
    'Indexing must not reorder the API snapshot',
  );
  assert.equal(indexed.linksByStep.get(1).length, 1);
  assert.equal(indexed.linksByProcess.get(7).length, 1);
  assert.equal(indexed.tags.get(9).name, 'Critical');
  assert.equal(workspace.buildWorkspaceIndex(null).stepsByStream.size, 0);
  console.log(
    'Workspace indexing checks passed: ordering, links, catalogs, empty state, and unchanged snapshots.',
  );

  global.FormData = previousFormData;
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
