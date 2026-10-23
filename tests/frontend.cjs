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
  source.slice(source.indexOf('function syncThemeStylesheet()'), source.indexOf('function stats(')),
  context,
);
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
