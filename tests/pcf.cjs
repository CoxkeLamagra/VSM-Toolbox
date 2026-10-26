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
    await page.getByLabel('Username', { exact: true }).fill('pcf-admin');
    await page.getByLabel('Password', { exact: true }).fill('pcf-password-123');
    await page.getByRole('button', { name: 'Create Admin account' }).click();
    await page.locator('#pcfNav').click();
    await page.getByRole('heading', { name: 'PCF framework', exact: true }).waitFor();
    const names = [
      'IT Management',
      'Fault to Restoration',
      'Incident Management',
      'Register Incident',
      'Create ticket',
    ];
    const save = () => page.getByRole('button', { name: 'Save changes', exact: true }).click();
    for (let i = 0; i < names.length; i++) {
      if (i === 0) await page.locator('[data-action=new-pcf]').first().click();
      else await page.locator('.pcf-detail [data-action=new-pcf]').click();
      await page.getByLabel('Entry name', { exact: true }).fill(names[i]);
      assert.equal(await page.getByLabel('Index number', { exact: true }).inputValue(), '1');
      if (i === 2) await page.getByLabel('APQC reference ID (optional)').fill('LOCAL-INCIDENT');
      await save();
      await page.locator('.pcf-tile h3 button').filter({ hasText: names[i] }).click();
      await page.locator('.pcf-detail h2').filter({ hasText: names[i] }).waitFor();
    }
    assert.equal(
      await page.locator('.pcf-detail [data-action=new-pcf]').count(),
      0,
      'Tasks cannot have children',
    );
    await page.getByRole('button', { name: 'All categories', exact: true }).click();
    await page.getByRole('button', { name: 'Index', exact: true }).click();
    assert.equal(await page.locator('.pcf-index .pcf-number').last().textContent(), '1.1.1.1.1');
    assert.equal(await page.locator('.pcf-index details').count(), 4);
    await page.screenshot({ path: '/tmp/vsm-pcf-index.png', fullPage: true });
    await page.getByRole('button', { name: 'Tiles', exact: true }).click();
    await page.locator('.pcf-tile').click({ position: { x: 15, y: 15 } });
    await page.locator('.pcf-detail h2').filter({ hasText: 'IT Management' }).waitFor();
    await page.locator('#streamsNav').click();
    await page.getByRole('button', { name: 'Create value stream' }).click();
    await page.getByLabel('Stream name').fill('Incident restoration');
    await page
      .locator('.pcf-option')
      .filter({ hasText: '1 IT Management' })
      .locator('input')
      .check();
    await page.getByLabel('Find PCF entries').fill('ticket');
    assert.equal(await page.locator('.pcf-option:visible').count(), 1);
    await page.locator('.pcf-option').filter({ hasText: 'Create ticket' }).locator('input').check();
    await save();
    await page.getByRole('heading', { name: 'Incident restoration', exact: true }).waitFor();
    assert.equal(await page.locator('.pcf-linked [data-action=open-pcf]').count(), 2);
    await page
      .locator('.pcf-linked [data-action=open-pcf]')
      .filter({ hasText: 'Create ticket' })
      .click();
    await page.locator('.pcf-detail h2').filter({ hasText: 'Create ticket' }).waitFor();
    await page
      .locator('.pcf-associated')
      .getByRole('button', { name: 'Incident restoration', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Incident restoration', exact: true }).waitFor();
    await page.reload();
    await page.locator('.stream-card h3').click();
    assert.equal(await page.locator('.pcf-linked [data-action=open-pcf]').count(), 2);
    await page.getByRole('button', { name: 'Manage PCF links' }).click();
    assert.equal(await page.locator('.pcf-option input:checked').count(), 2);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('#pcfNav').click();
    await page.getByRole('button', { name: 'All categories', exact: true }).click();
    await page.locator('.pcf-tile h3 button').click();
    await page.locator('.pcf-detail [data-action=edit-pcf]').click();
    await page.getByLabel('Index number', { exact: true }).fill('7');
    await save();
    await page.getByRole('button', { name: 'All categories', exact: true }).click();
    await page.getByRole('button', { name: 'Index', exact: true }).click();
    assert.equal(await page.locator('.pcf-index .pcf-number').last().textContent(), '7.1.1.1.1');
    await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf_token },
        body: JSON.stringify({
          username: 'pcf-viewer',
          password: 'pcf-password-123',
          role: 'Viewer',
        }),
      });
    });
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByLabel('Username', { exact: true }).fill('pcf-viewer');
    await page.getByLabel('Password', { exact: true }).fill('pcf-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.locator('#pcfNav').click();
    assert.equal(await page.locator('[data-action=new-pcf]').count(), 0);
    assert.equal(await page.locator('[data-action=edit-pcf]').count(), 0);
    await page.getByRole('button', { name: 'Tiles', exact: true }).click();
    await page.locator('.pcf-tile h3 button').click();
    assert.equal(await page.locator('.pcf-detail [data-action=edit-pcf]').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(
      'PCF browser test passed: five-level entry creation, index, tile drill-down, multi-entry stream links, search, persistence, renumbering, Viewer and mobile access.',
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
