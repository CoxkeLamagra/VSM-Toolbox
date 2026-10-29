const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  net = require('node:net');
const { spawn } = require('node:child_process');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const root = path.resolve(__dirname, '..'),
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vsm-workshop-'));
  const socket = net.createServer();
  await new Promise((r) => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn('python3', ['app.py'], {
    cwd: root,
    env: {
      ...process.env,
      VSM_DATABASE: path.join(temp, 'db.sqlite3'),
      VSM_HOST: '127.0.0.1',
      VSM_PORT: String(port),
      VSM_UPDATE_DIR: path.join(temp, 'updates'),
    },
    stdio: 'ignore',
  });
  let browser;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(base + '/api/health')).ok) break;
      } catch {}
      await delay(100);
    }
    let cookie = '',
      csrf = '';
    async function api(route, data, method) {
      const r = await fetch(base + '/api/' + route, {
        method: method || (data === undefined ? 'GET' : 'POST'),
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const b = await r.json();
      assert.ok(r.ok, JSON.stringify(b));
      if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
      if (b.csrf_token) csrf = b.csrf_token;
      return b;
    }
    await api('auth/register', { username: 'admin', password: 'workshop-admin-password' });
    const adminCookie = cookie;
    await api('users', {
      username: 'editor',
      password: 'workshop-editor-password',
      role: 'Editor',
    });
    await api('users', {
      username: 'viewer',
      password: 'workshop-viewer-password',
      role: 'Viewer',
    });
    const board = await api('workshops', { name: 'Incident current state' });
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.VSM_CHROMIUM || undefined,
      args: ['--no-sandbox'],
    });
    const errors = [];
    async function pageFor(value) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
      await context.addCookies([{ name: 'vsm_session', value: value.split('=')[1], url: base }]);
      const p = await context.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(base);
      await p.getByRole('button', { name: 'Value Stream Mapping', exact: true }).click();
      await p.locator('#workshopPicker').selectOption(String(board.id));
      await p.waitForFunction(() =>
        document.querySelector('#workshopStatus').textContent.includes('Connected'),
      );
      return p;
    }
    const a = await pageFor(adminCookie);
    cookie = '';
    csrf = '';
    await api('auth/login', { username: 'editor', password: 'workshop-editor-password' });
    const b = await pageFor(cookie);
    await a.getByRole('button', { name: '+ Process step', exact: true }).click();
    await a.locator('.workshop-step').waitFor();
    await b.locator('.workshop-step').waitFor();
    const block = a.locator('.workshop-step');
    await block.click();
    await a
      .locator('#workshopEdit [name=text]')
      .fill('Register incident <script>alert(1)</script>');
    await a.locator('#workshopEdit [name=work]').fill('12');
    await a.getByRole('button', { name: 'Save block', exact: true }).click();
    await b.waitForFunction(() =>
      document.querySelector('.workshop-step title')?.textContent.includes('Register incident'),
    );
    assert.equal(await a.locator('#workshopCanvas script').count(), 0);
    // Independent editors both open the same version; preserve the losing draft from silent overwrite.
    await b.locator('.workshop-step').click();
    await b.locator('#workshopEdit [name=text]').fill('Stale editor draft');
    await a.locator('#workshopEdit [name=text]').fill('Current shared value');
    await a.getByRole('button', { name: 'Save block', exact: true }).click();
    await a.waitForFunction(() =>
      document.querySelector('#workshopStatus').textContent.includes('Saved'),
    );
    await b.getByRole('button', { name: 'Save block', exact: true }).click();
    await b.waitForFunction(() =>
      document.querySelector('#workshopStatus').textContent.includes('Another participant'),
    );
    const box = await block.boundingBox();
    await a.mouse.move(box.x + 50, box.y + 50);
    await a.mouse.down();
    await a.mouse.move(box.x + 210, box.y + 130, { steps: 8 });
    await a.mouse.up();
    await a.waitForFunction(() =>
      document.querySelector('#workshopStatus').textContent.includes('Saved'),
    );
    const moved = await block.getAttribute('transform');
    await b.waitForFunction(
      (v) => document.querySelector('.workshop-step')?.getAttribute('transform') === v,
      moved,
    );
    const before = await a.locator('#workshopCanvas').getAttribute('viewBox');
    await a.getByRole('button', { name: 'Zoom in', exact: true }).click();
    assert.notEqual(await a.locator('#workshopCanvas').getAttribute('viewBox'), before);
    await a.getByRole('button', { name: '+ Customer / VOC', exact: true }).click();
    await a.locator('.workshop-customer').waitFor();
    await a.getByRole('button', { name: 'Connect blocks →', exact: true }).click();
    const opts = await a.locator('#workshopInspector [name=target] option').allTextContents();
    assert.equal(opts.length, 2);
    const target = await a
      .locator('#workshopInspector [name=target] option')
      .nth(1)
      .getAttribute('value');
    await a.locator('#workshopInspector [name=target]').selectOption(target);
    await a.getByRole('button', { name: 'Add connector', exact: true }).click();
    await a.locator('.workshop-line').waitFor();
    cookie = '';
    csrf = '';
    await api('auth/login', { username: 'viewer', password: 'workshop-viewer-password' });
    const v = await pageFor(cookie);
    assert.equal(await v.getByRole('button', { name: '+ Process step', exact: true }).count(), 0);
    await v.locator('.workshop-step').click();
    assert.equal(await v.locator('#workshopEdit [name=text]').getAttribute('readonly'), '');
    await a.reload();
    await a.getByRole('button', { name: 'Value Stream Mapping', exact: true }).click();
    await a.locator('.workshop-line').waitFor();
    await a.locator('#newWorkshop [name=name]').fill('Future state workshop');
    await a.getByRole('button', { name: 'Create workshop', exact: true }).click();
    await a.waitForFunction(
      () =>
        document.querySelector('#workshopPicker').selectedOptions[0]?.textContent ===
        'Future state workshop',
    );
    await a.getByRole('button', { name: '+ Improvement', exact: true }).click();
    await a.locator('.workshop-improvement').waitFor();
    await a.getByRole('button', { name: 'Delete workshop', exact: true }).click();
    await a
      .getByRole('textbox', { name: 'Workshop deletion confirmation' })
      .fill('Future state workshop');
    await a.getByRole('button', { name: 'Delete permanently', exact: true }).click();
    await a.locator('.workshop-line').waitFor();
    await a.screenshot({ path: '/tmp/vsm-workshop-review.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log(
      'Workshop browser checks passed: two-user sync, stale-edit conflict, drag, zoom, connectors, escaping, viewer access and reload persistence.',
    );
  } finally {
    if (browser) await browser.close();
    server.kill();
    await new Promise((r) => server.once('exit', r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
