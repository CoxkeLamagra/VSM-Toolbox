const { chromium } = require('playwright');
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const { spawn } = require('node:child_process');
(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsm-branding-'));
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.env.PYTHON || 'python3', ['updater.py'], {
    env: {
      ...process.env,
      VSM_HOST: '127.0.0.1',
      VSM_PORT: String(port),
      VSM_DATABASE: path.join(temp, 'workspace.sqlite3'),
    },
    stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + '/api/health')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    browser = await chromium.launch({
      executablePath: process.env.VSM_CHROMIUM || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base);
    await page.getByLabel('Username', { exact: true }).fill('environment-admin');
    await page.getByLabel('Password', { exact: true }).fill('environment-password-123');
    await page.getByRole('button', { name: 'Create Admin account' }).click();
    await page.getByRole('heading', { name: 'Value streams', exact: true }).waitFor();
    const screenshots = '/tmp/vsm-visual-review';
    fs.mkdirSync(screenshots, { recursive: true });
    await page.evaluate(
      async (bpmn) => {
        const session = await (await fetch('/api/session')).json();
        const headers = {
          'Content-Type': 'application/json',
          'X-CSRF-Token': session.csrf_token,
          'X-Environment-ID': String(session.environment.id),
        };
        async function create(path, data) {
          const response = await fetch('/api/' + path, {
            method: 'POST',
            headers,
            body: JSON.stringify(data),
          });
          if (!response.ok) throw Error(await response.text());
          return response.json();
        }
        const category = await create('tag_categories', { name: 'Service classification' });
        const tag = await create('tags', {
          name: 'Customer-facing',
          color: '#e6404d',
          category_id: category.id,
        });
        const classification = await create('pcf_entries', {
          name: 'Manage IT services',
          entry_type: 'Category',
          number: 1,
          reference: '10001',
        });
        await create('pcf_entries', {
          name: 'Fulfil service requests',
          entry_type: 'Process Group',
          parent_id: classification.id,
          number: 1,
        });
        const stream = await create('streams', {
          name: 'Service request delivery',
          customer: 'Managed service customer',
          outcome: 'Working access to business tools',
          description: 'Request intake through fulfilment and confirmation.',
          voc: 'Give new starters access on their first day.',
          cva: 3,
          bva: 2,
          takt_available_minutes: 420,
          takt_demand: 35,
          tag_ids: [tag.id],
          pcf_ids: [classification.id],
        });
        const step = await create('steps', {
          name: 'Validate and fulfil request',
          stream_id: stream.id,
          owner: 'Service desk',
          work_minutes: 15,
          wait_minutes: 30,
          cva: 3,
          bva: 2,
          tag_ids: [tag.id],
        });
        const process = await create('processes', {
          name: 'Incident handling',
          owner: 'Service operations',
          description: 'A documented local process with its BPMN flow.',
          bpmn_xml: bpmn,
          tag_ids: [tag.id],
        });
        const response = await fetch('/api/steps/' + step.id + '/processes', {
          method: 'PUT',
          headers,
          body: JSON.stringify({ process_ids: [process.id] }),
        });
        if (!response.ok) throw Error(await response.text());
      },
      fs.readFileSync('tests/fixtures/problem-flow.bpmn', 'utf8'),
    );
    await page.reload();
    const pages = [
      ['streams', 'Value streams'],
      ['environments', 'Environments'],
      ['process', 'Process library'],
      ['pcf', 'PCF framework'],
      ['tags', 'Tags & categories'],
      ['accounts', 'Account administration'],
      ['branding', 'Branding & theme'],
      ['backups', 'Backups & restore'],
      ['updates', 'Application updates'],
      ['maintenance', 'Data management'],
    ];
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [name, heading] of pages) {
        if (
          ['tags', 'accounts', 'branding', 'backups', 'updates', 'maintenance'].includes(name) &&
          (await page.locator('#adminToggle').getAttribute('aria-expanded')) !== 'true'
        )
          await page.locator('#adminToggle').click();
        await page.locator('#' + name + 'Nav').click();
        await page.getByRole('heading', { name: heading, exact: true }).waitFor();
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          name + ' must fit at ' + width + 'px',
        );
        await page.screenshot({ path: `${screenshots}/${name}-${width}.png`, fullPage: true });
      }
      await page.locator('#streamsNav').click();
      await page.locator('.stream-card').click();
      await page.getByRole('heading', { name: 'Service request delivery', exact: true }).waitFor();
      await page.screenshot({ path: `${screenshots}/stream-map-${width}.png`, fullPage: true });
      await page.locator('[data-action="edit-stream"]').first().click();
      await page.getByLabel('Stream name', { exact: true }).waitFor();
      assert.ok(await page.getByRole('button', { name: 'Save changes', exact: true }).isVisible());
      await page.screenshot({ path: `${screenshots}/stream-form-${width}.png`, fullPage: true });
      await page.locator('#cancelDialog').click();
      await page.locator('#processNav').click();
      await page.getByRole('button', { name: 'View BPMN diagram', exact: true }).click();
      await page.locator('#bpmnCanvas svg').waitFor();
      await page.screenshot({ path: `${screenshots}/bpmn-${width}.png`, fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log(
      'Visual review passed: 10 screens, stream map/forms and BPMN at desktop and mobile widths.',
    );
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
