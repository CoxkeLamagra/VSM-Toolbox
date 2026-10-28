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
    await page.locator('[data-action="new-stream"]').first().click();
    await page.getByLabel('Stream name', { exact: true }).fill('Rated stream');
    await page
      .getByLabel('Net available working time (minutes per period)', { exact: true })
      .fill('420');
    await page.getByLabel('Customer demand (requests per period)', { exact: true }).fill('35');
    await page.getByLabel('Customer Value Add (CVA)', { exact: true }).selectOption('3');
    await page.getByLabel('Business Value Add (BVA)', { exact: true }).selectOption('1');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('heading', { name: 'Rated stream', exact: true }).waitFor();
    assert.ok(
      (await page.locator('.title-row .value-rating-badges').textContent()).includes(
        'CVA: 3 - High',
      ),
    );
    await page.locator('[data-action="new-step"]').first().click();
    await page.getByLabel('Step name', { exact: true }).fill('Rated step');
    await page.getByLabel('Active work time (minutes)', { exact: true }).fill('12.5');
    await page.getByLabel('Waiting time (minutes)', { exact: true }).fill('7.5');
    assert.ok(
      (await page.locator('#stepTimePreview').textContent()).includes(
        'Lead time (work + wait): 20 min',
      ),
    );
    await page.getByLabel('Customer Value Add (CVA)', { exact: true }).selectOption('2');
    await page.getByLabel('Business Value Add (BVA)', { exact: true }).selectOption('3');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.locator('.diagram-node.delivery-step').waitFor();
    assert.ok(
      (await page.locator('.diagram-node.delivery-step').textContent()).includes('Cycle 12.5 min'),
    );
    assert.ok(
      (await page.locator('.diagram-node.delivery-step').textContent()).includes('Lead 20 min'),
    );
    const metric = (name) =>
      page
        .locator('.service-time-stats .stat')
        .filter({ has: page.locator('.label', { hasText: name }) })
        .locator('strong');
    assert.equal(await metric('Cycle time (processing)').textContent(), '12.5 min');
    assert.equal(await metric('Lead time').textContent(), '20 min');
    assert.equal(await metric('Takt time').textContent(), '12 min/request');

    assert.ok(
      (await page.locator('.diagram-node.delivery-step').textContent()).includes('CVA: 2 - Medium'),
    );
    await page.locator('[data-action="flow-view"]').click();
    assert.ok(
      (await page.locator('.step .value-rating-badges').textContent()).includes('BVA: 3 - High'),
    );
    await page.locator('[data-action="edit-step"]').click();
    await page.getByLabel('Customer Value Add (CVA)', { exact: true }).selectOption('');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page
      .locator('.step .value-rating-badges')
      .filter({ hasText: 'CVA: Not rated' })
      .waitFor();
    assert.ok(
      (await page.locator('.step .value-rating-badges').textContent()).includes('CVA: Not rated'),
    );
    assert.ok(
      (await page.locator('.step .value-rating-badges').textContent()).includes('BVA: 3 - High'),
    );
    await page.reload();
    await page.locator('.stream-card').click();
    await page.locator('.diagram-node.delivery-step').waitFor();
    assert.ok(
      (await page.locator('.diagram-node.delivery-step').textContent()).includes('BVA: 3 - High'),
    );
    assert.deepEqual(errors, []);
    console.log(
      'Service time browser checks passed: takt configuration, live preview, cycle/lead totals, diagram, clearing ratings, and persistence.',
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
