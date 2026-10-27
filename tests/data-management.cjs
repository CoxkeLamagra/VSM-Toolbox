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
    await page.getByLabel('Username', { exact: true }).fill('reset-admin');
    await page.getByLabel('Password', { exact: true }).fill('reset-password-123');
    await page.getByRole('button', { name: 'Create Admin account' }).click();
    await page.getByRole('heading', { name: 'Value streams', exact: true }).waitFor();
    await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token };
      async function api(path, data, method = 'POST') {
        const r = await fetch('/api/' + path, { method, headers, body: JSON.stringify(data) });
        const result = await r.json();
        if (!r.ok) throw Error(result.error);
        return result;
      }
      await api('users', {
        username: 'reset-viewer',
        password: 'reset-password-123',
        role: 'Viewer',
      });
      const tag = await api('tags', { name: 'Keep tag', color: '#336699' });
      let parent = null;
      const pcf = [];
      for (const entry_type of ['Category', 'Process Group', 'Process', 'Activity', 'Task']) {
        const e = await api('pcf_entries', {
          name: entry_type,
          entry_type,
          parent_id: parent,
          number: 1,
        });
        parent = e.id;
        pcf.push(e.id);
      }
      const stream = await api('streams', {
        name: 'Preserve via backup',
        pcf_ids: pcf,
        tag_ids: [tag.id],
      });
      const step = await api('steps', { name: 'Triage', stream_id: stream.id, tag_ids: [tag.id] });
      const process = await api('processes', { name: 'Incident procedure', tag_ids: [tag.id] });
      await api('steps/' + step.id + '/processes', { process_ids: [process.id] }, 'PUT');
      const branding = (await (await fetch('/api/branding')).json()).branding;
      await api('branding', { ...branding, name: 'Retained workspace' }, 'PUT');
    });
    let approve = false;
    page.on('dialog', (dialog) => (approve ? dialog.accept() : dialog.dismiss()));
    if ((await page.locator('#adminToggle').getAttribute('aria-expanded')) !== 'true')
      await page.locator('#adminToggle').click();
    await page.locator('#maintenanceNav').click();
    await page.getByRole('heading', { name: 'Data management', exact: true }).waitFor();
    await page.getByLabel('Confirmation text', { exact: true }).fill('DELETE ALL BUSINESS DATA');
    await page
      .getByRole('button', { name: 'Create backup and clear all data', exact: true })
      .click();
    assert.equal(
      await page.evaluate(async () => (await (await fetch('/api/data')).json()).streams.length),
      1,
      'Canceling must retain data',
    );
    assert.equal(
      await page.evaluate(async () => (await (await fetch('/api/backups')).json()).backups.length),
      0,
      'Canceling must not queue work',
    );
    approve = true;
    await page
      .getByRole('button', { name: 'Create backup and clear all data', exact: true })
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: 'PCF entries cleared' })
      .waitFor({ timeout: 40000 });
    const after = await page.evaluate(async () => ({
      data: await (await fetch('/api/data')).json(),
      users: await (await fetch('/api/users')).json(),
      branding: (await (await fetch('/api/branding')).json()).branding,
      backups: (await (await fetch('/api/backups')).json()).backups,
    }));
    for (const name of ['streams', 'steps', 'processes', 'pcf_entries'])
      assert.equal(after.data[name].length, 0, name);
    assert.equal(after.data.tags.length, 1);
    assert.equal(after.users.length, 2);
    assert.equal(after.branding.name, 'Retained workspace');
    const backup = after.backups.find((e) => e.reason === 'pre-data-clear');
    assert.ok(backup, 'A safety backup must exist');
    if ((await page.locator('#adminToggle').getAttribute('aria-expanded')) !== 'true')
      await page.locator('#adminToggle').click();
    await page.locator('#backupsNav').click();
    await page.locator(`[data-action="restore-backup"][data-backup="${backup.id}"]`).click();
    await page
      .getByRole('heading', { name: 'Welcome back', exact: true })
      .waitFor({ timeout: 40000 });
    await page.getByLabel('Username', { exact: true }).fill('reset-admin');
    await page.getByLabel('Password', { exact: true }).fill('reset-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Backups & restore', exact: true }).waitFor();
    await page.locator('#streamsNav').click();
    await page.getByRole('heading', { name: 'Value streams', exact: true }).waitFor();
    const restored = await page.evaluate(async () => await (await fetch('/api/data')).json());
    assert.equal(restored.streams.length, 1);
    assert.equal(restored.steps.length, 1);
    assert.equal(restored.processes.length, 1);
    assert.equal(restored.pcf_entries.length, 5);
    assert.equal(restored.streams[0].pcf_ids.length, 5);
    assert.equal(restored.step_processes.length, 1);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('reset-viewer');
    await page.getByLabel('Password', { exact: true }).fill('reset-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Value streams', exact: true }).waitFor();
    assert.equal(await page.locator('#maintenanceNav').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(
      'Data management browser test passed: warning cancellation, backup-first clearing, retained configuration, full restoration, and Viewer restriction.',
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
