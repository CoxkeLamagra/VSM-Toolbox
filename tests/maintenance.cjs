// Exercise gateway responses and repeated restart interruptions without a browser.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
(async () => {
  let pending,
    errors = [],
    attempts = 0;
  const context = vm.createContext({
    setTimeout: (callback) => {
      pending = callback;
      return 1;
    },
    clearTimeout: () => {},
    document: { querySelector: () => ({}) },
  });
  const source = fs.readFileSync('web/app.js', 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
  vm.runInContext(source.slice(0, source.indexOf('const steps =')), context);
  await assert.rejects(
    vm.runInContext(
      "readResponse({status:502,text:async()=>'<html><h1>Bad Gateway</h1></html>'})",
      context,
    ),
    /HTTP 502/,
  );
  assert.equal(
    (await vm.runInContext('readResponse({status:200,text:async()=>\'{"queued":true}\'})', context))
      .queued,
    true,
  );
  context.failRead = () => {
    if (++attempts <= 4) throw new Error('Temporarily unavailable');
  };
  context.recordError = (e) => errors.push(e.message);
  vm.runInContext(
    "session={user:{role:'Admin'}};view='backups';error=recordError;refresh=async()=>failRead();",
    context,
  );
  await vm.runInContext('refreshMaintenance()', context);
  for (let i = 0; i < 4; i++) await pending();
  assert.equal(attempts, 5, 'Polling survives repeated restart interruptions');
  assert.equal(errors.length, 4);
  vm.runInContext("view='streams'", context);
  await pending();
  assert.equal(attempts, 5, 'Leaving maintenance stops retries');
  console.log('Maintenance response and polling tests passed.');
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
