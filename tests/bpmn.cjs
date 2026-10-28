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
    await page.locator('#processNav').click();
    await page.getByRole('button', { name: 'Import BPMN XML', exact: true }).click();
    await page.getByLabel('Process name', { exact: true }).fill('Imported incident');
    await page.locator('#bpmnFile').setInputFiles('tests/fixtures/incident.bpmn');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.locator('#bpmnCanvas svg').waitFor();
    assert.equal(await page.locator('.bpmn-node').count(), 4);
    assert.ok((await page.locator('#bpmnCanvas').textContent()).includes('Triage & assign'));
    await page.getByLabel('Diagram zoom', { exact: true }).fill('150');
    assert.equal(
      await page.locator('#bpmnCanvas svg').getAttribute('width'),
      String(Number(await page.locator('#bpmnCanvas svg').getAttribute('data-width')) * 1.5),
    );
    await page.reload();
    await page.locator('#processNav').click();
    await page.getByRole('button', { name: 'View BPMN diagram', exact: true }).click();
    await page.locator('#bpmnCanvas svg').waitFor();
    await page.getByRole('button', { name: 'Replace BPMN XML', exact: true }).click();
    await page
      .locator('#bpmnFile')
      .setInputFiles({ name: 'bad.xml', mimeType: 'text/xml', buffer: Buffer.from('<broken>') });
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.locator('#error').filter({ hasText: 'Invalid BPMN XML' }).waitFor();
    assert.equal(await page.locator('.bpmn-node').count(), 4);
    await page.locator('#editor').evaluate((dialog) => dialog.close());
    await page.getByRole('button', { name: 'Replace BPMN XML', exact: true }).click();
    await page.locator('#bpmnFile').setInputFiles('tests/fixtures/problem-flow.bpmn');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.locator('.bpmn-node').nth(12).waitFor();
    const collisions = await page.evaluate(() => {
      const svg = document.querySelector('#bpmnCanvas svg');
      const intersects = (a, b) =>
        a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
      const shapes = [
        ...svg.querySelectorAll('.bpmn-node > rect, .bpmn-node > ellipse, .bpmn-node > polygon'),
      ].map((shape) => shape.getBBox());
      const external = [...svg.querySelectorAll('.bpmn-external-label')];
      const failures = external
        .filter((text) => shapes.some((shape) => intersects(text.getBBox(), shape)))
        .map((text) => text.textContent);
      for (const text of svg.querySelectorAll('.bpmn-task-label')) {
        const box = text.getBBox(),
          shape = text.parentElement.querySelector('rect').getBBox();
        if (
          box.x < shape.x ||
          box.y < shape.y ||
          box.x + box.width > shape.x + shape.width ||
          box.y + box.height > shape.y + shape.height
        )
          failures.push(text.textContent);
      }
      const view = svg.viewBox.baseVal;
      if (
        external.some((text) => {
          const box = text.getBBox();
          return (
            box.x < view.x ||
            box.y < view.y ||
            box.x + box.width > view.x + view.width ||
            box.y + box.height > view.y + view.height
          );
        })
      )
        failures.push('clipped labels');
      return failures;
    });
    assert.deepEqual(collisions, [], 'BPMN labels must fit their tasks or avoid all node shapes');
    assert.equal(await page.locator('.bpmn-gateway-marker').count(), 3);
    await page.locator('.bpmn-panel').screenshot({ path: '/tmp/vsm-bpmn-label-layout.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(
      'BPMN browser checks passed: import, rendering, zoom, persistence, invalid replacement and mobile.',
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
