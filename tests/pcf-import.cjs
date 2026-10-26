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
  const server = spawn(process.env.PYTHON || 'python3', ['app.py'], {
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
    await page.getByLabel('Username', { exact: true }).fill('csv-admin');
    await page.getByLabel('Password', { exact: true }).fill('csv-password-123');
    await page.getByRole('button', { name: 'Create Admin account' }).click();
    await page.locator('#pcfNav').click();
    const original =
      'PCF ID,Hierarchy ID,Name\nT,1.1.1.1.1,Create ticket\nC,1.0,IT Management\nG,1.1,Fault to Restoration\nP,1.1.1,Incident Management\nA,1.1.1.1,Register Incident\n';
    const changed = original
      .replace('IT Management', 'Changed category')
      .replace('Fault to Restoration', 'Changed group')
      .replace('Create ticket', 'Changed task');
    async function upload(text) {
      const panel = page.locator('.pcf-import');
      if (!(await panel.isVisible()))
        await page.getByRole('button', { name: 'Import from CSV', exact: true }).click();
      await page
        .locator('#pcfCSVFile')
        .setInputFiles({ name: 'pcf.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });
      await page.getByRole('button', { name: 'Upload and preview', exact: true }).click();
    }
    async function entries() {
      return page.evaluate(async () => await (await fetch('/api/pcf_entries')).json());
    }
    assert.equal(await page.locator('.pcf-import').isVisible(), false);
    assert.equal(
      await page.locator('.title-row .detail-actions [data-action=pcf-import-toggle]').count(),
      1,
    );
    await upload(original);
    await page.getByRole('heading', { name: 'Review CSV import' }).waitFor();
    assert.equal((await entries()).length, 0);
    await page.getByRole('button', { name: 'Import entries', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '5 created' }).waitFor();
    assert.equal((await entries()).length, 5);
    const saved = await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      const items = await (await fetch('/api/pcf_entries')).json();
      const task = items.find((e) => e.reference === 'T');
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token };
      await fetch('/api/pcf_entries/' + task.id, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ description: 'Keep these notes' }),
      });
      const stream = await (
        await fetch('/api/streams', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name: 'CSV linked service', pcf_ids: [task.id] }),
        })
      ).json();
      return { stream: stream.id, task: task.id };
    });
    await upload(changed);
    await page.getByLabel('Overwrite C', { exact: true }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Import entries', exact: true }).isEnabled(),
      false,
    );
    await page.getByRole('button', { name: 'Overwrite ALL', exact: true }).click();
    await page.getByLabel('Overwrite G', { exact: true }).selectOption('no');
    await page.screenshot({ path: '/tmp/vsm-pcf-csv-preview.png', fullPage: true });
    await page.getByRole('button', { name: 'Import entries', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '4 overwritten, 1 skipped' }).waitFor();
    assert.equal((await entries()).find((e) => e.reference === 'G').name, 'Fault to Restoration');
    assert.equal((await entries()).find((e) => e.reference === 'T').id, saved.task);
    assert.equal(
      (await entries()).find((e) => e.reference === 'T').description,
      'Keep these notes',
    );
    assert.deepEqual(
      await page.evaluate(
        async (id) => (await (await fetch('/api/streams/' + id)).json()).pcf_ids,
        saved.stream,
      ),
      [saved.task],
    );
    await upload(changed);
    await page.getByRole('button', { name: 'Skip ALL', exact: true }).click();
    await page.getByRole('button', { name: 'Import entries', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '0 overwritten, 5 skipped' }).waitFor();
    await upload(changed);
    await page.getByRole('button', { name: 'Overwrite ALL', exact: true }).click();
    await page.getByRole('button', { name: 'Import entries', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '5 overwritten' }).waitFor();
    assert.equal((await entries()).find((e) => e.reference === 'G').name, 'Changed group');
    await upload('PCF ID,Hierarchy ID,Name\nMISSING,9.1,Orphan group\n');
    await page.getByRole('alert').filter({ hasText: 'missing parent' }).waitFor();
    assert.equal((await entries()).length, 5);
    await upload(original);
    await page.getByRole('button', { name: 'Overwrite ALL', exact: true }).click();
    await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      const items = await (await fetch('/api/pcf_entries')).json();
      await fetch('/api/pcf_entries/' + items[0].id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token },
        body: JSON.stringify({ description: 'Changed after preview' }),
      });
    });
    await page.getByRole('button', { name: 'Import entries', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'changed since preview' }).waitFor();
    assert.equal((await entries()).find((e) => e.reference === 'C').name, 'Changed category');
    await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: 'Import entries', exact: true }).count(),
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      'PCF CSV browser test passed: preview, hierarchy creation, Yes/No/ALL, Skip ALL, preserved IDs/notes/links, invalid parents, and stale preview rejection.',
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
