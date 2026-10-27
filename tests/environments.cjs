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
    await page.getByLabel('Username', { exact: true }).fill('environment-admin');
    await page.getByLabel('Password', { exact: true }).fill('environment-password-123');
    await page.getByRole('button', { name: 'Create Admin account' }).click();
    await page.getByRole('heading', { name: 'Value streams', exact: true }).waitFor();
    const defaultId = await page.locator('#environmentSwitcher').inputValue();
    await page.evaluate(async () => {
      const session = await (await fetch('/api/session')).json();
      const headers = {
        'Content-Type': 'application/json',
        'X-CSRF-Token': session.csrf_token,
        'X-Environment-ID': String(session.environment.id),
      };
      for (const [path, body] of [
        ['streams', { name: 'Default service' }],
        ['tags', { name: 'Critical' }],
        ['pcf_entries', { name: 'IT Management', entry_type: 'Category', number: 1 }],
        [
          'users',
          { username: 'environment-viewer', password: 'environment-password-123', role: 'Viewer' },
        ],
      ]) {
        const r = await fetch('/api/' + path, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!r.ok) throw Error(await r.text());
      }
    });
    await page.locator('#environmentsNav').click();
    await page.getByRole('heading', { name: 'Environments', exact: true }).waitFor();
    assert.ok((await page.locator('.environment-counts').textContent()).includes('Value streams'));
    await page.getByRole('button', { name: 'Create environment' }).click();
    await page.getByLabel('Environment name').fill('Client B');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.locator('.environment-dashboard h2').filter({ hasText: 'Client B' }).waitFor();
    const secondId = await page.locator('#environmentSwitcher').inputValue();
    assert.notEqual(secondId, defaultId);
    await page.getByLabel('Local username', { exact: true }).fill('environment-viewer');
    await page.getByLabel('Environment role', { exact: true }).selectOption('Editor');
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await page
      .locator('.environment-members td')
      .filter({ hasText: 'environment-viewer' })
      .waitFor();
    await page.locator('#streamsNav').click();
    assert.equal(await page.locator('.stream-card').count(), 0);
    await page.getByRole('button', { name: 'Create value stream', exact: false }).click();
    await page.getByLabel('Stream name').fill('Client B service');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('heading', { name: 'Client B service', exact: true }).waitFor();
    await page.locator('#environmentSwitcher').selectOption(defaultId);
    await page.getByRole('heading', { name: 'Value streams', exact: true }).waitFor();
    assert.equal(await page.locator('.stream-card h3').textContent(), 'Default service');
    await page.locator('#environmentSwitcher').selectOption(secondId);
    await page.locator('.stream-card h3').filter({ hasText: 'Client B service' }).waitFor();
    assert.equal(await page.locator('.stream-card').count(), 1);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('environment-viewer');
    await page.getByLabel('Password', { exact: true }).fill('environment-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Value streams', exact: true }).waitFor();
    await page.locator('#environmentSwitcher').selectOption(secondId);
    await page.locator('.stream-card h3').filter({ hasText: 'Client B service' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create value stream' }).isVisible(), true);
    await page.locator('#environmentsNav').click();
    await page.locator('.environment-dashboard h2').filter({ hasText: 'Client B' }).waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Delete environment', exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: 'Create environment' }).click();
    await page.getByLabel('Environment name').fill('Personal workspace');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page
      .locator('.environment-dashboard h2')
      .filter({ hasText: 'Personal workspace' })
      .waitFor();
    assert.ok(
      await page.getByRole('button', { name: 'Delete environment', exact: true }).isVisible(),
    );
    assert.equal(await page.locator('#accountsNav').isVisible(), false);
    assert.equal(await page.locator('#tagsNav').isVisible(), true);
    await page.screenshot({ path: '/tmp/vsm-environments-dashboard.png', fullPage: true });
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete environment', exact: true }).click();
    await page
      .locator('.environment-card h3')
      .filter({ hasText: 'Personal workspace' })
      .waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByLabel('Username', { exact: true }).fill('environment-admin');
    await page.getByLabel('Password', { exact: true }).fill('environment-password-123');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('heading', { name: 'Value streams', exact: true }).waitFor();
    await page.locator('#environmentSwitcher').selectOption(secondId);
    await page.locator('.stream-card h3').filter({ hasText: 'Client B service' }).waitFor();
    await page.locator('#environmentsNav').click();
    await page.locator('.environment-dashboard h2').filter({ hasText: 'Client B' }).waitFor();
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Delete environment', exact: true }).click();
    await page
      .locator('.environment-card h3')
      .filter({ hasText: 'Client B' })
      .waitFor({ state: 'detached' });
    await page.locator('#streamsNav').click();
    await page.locator('.stream-card h3').filter({ hasText: 'Default service' }).waitFor();
    assert.equal(await page.locator('.stream-card').count(), 1);
    await page.locator('#environmentsNav').click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Delete environment', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Create your first environment', exact: true })
      .waitFor();
    assert.equal(await page.locator('#streamsNav').isDisabled(), true);
    await page.getByRole('button', { name: 'Create environment' }).click();
    await page.getByLabel('Environment name').fill('Fresh workspace');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page
      .locator('.environment-dashboard h2')
      .filter({ hasText: 'Fresh workspace' })
      .waitFor();
    assert.equal(await page.locator('#streamsNav').isDisabled(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'Environment dashboard must fit a mobile screen',
    );
    assert.deepEqual(errors, []);
    console.log(
      'Environment browser test passed: dashboard, creator Admin, membership, switching, isolated content, environment roles, deletion, and retained default data.',
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
