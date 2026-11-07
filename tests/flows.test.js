const test = require('node:test');
const assert = require('node:assert');
const { flowJson, decode, createFlows } = require('../server/flows.js');
const D = require('../src/data.js');

test('WhatsApp Flow forms: one per emergency, inside Meta limits, Footer last, every field in the payload', () => {
  for (const t of Object.keys(D.forms)) {
    const kids = flowJson(t).screens[0].layout.children;
    assert.ok(kids.length <= 50);
    assert.strictEqual(kids[kids.length - 1].type, 'Footer');
    const names = kids.filter((c) => c.name).map((c) => c.name);
    assert.deepStrictEqual(Object.keys(kids[kids.length - 1]['on-click-action'].payload), names);
    for (const c of kids) {
      if (['TextInput', 'TextArea', 'Dropdown'].includes(c.type)) assert.ok(c.label.length <= 20, t + ' ' + c.label);
      if (c.type === 'RadioButtonsGroup') assert.ok(c.label.length <= 30, t + ' ' + c.label);
      (c['data-source'] || []).forEach((o) => assert.ok(o.title.length <= 30));
      if (c['helper-text']) assert.ok(c['helper-text'].length <= 80);
    }
  }
});

test('Flow answers map back to the web form values', () => {
  const v = decode('bleeding', { name: 'Sunita', age: '27', blood: 'o4', mode: 'o1', oxy: 'o0', informed: 'o1', miso: '${form.miso}' });
  assert.strictEqual(v.blood, 'O+'); assert.strictEqual(v.mode, 'Caesarean'); assert.strictEqual(v.oxy, 'Yes');
  assert.strictEqual(v.informed, 'No'); assert.strictEqual(v.miso, ''); assert.strictEqual(v.name, 'Sunita');
});

test('Flow is created once on Meta and then reused; the message opens it in draft mode', async () => {
  const calls = [];
  const f = createFlows({ WA_TOKEN: 't', graph: async (m, p, b) => { calls.push(m + ' ' + p); return m === 'GET' ? { data: [] } : { id: 'F1', validation_errors: [] }; } });
  assert.strictEqual(await f.ensure('bleeding'), 'F1');
  assert.strictEqual(await f.ensure('bleeding'), 'F1');
  assert.strictEqual(calls.filter((c) => c.startsWith('POST')).length, 1);
  const msg = f.message('919557941106', 'F1', 'live.fabc', 'Fill it', 'Nurse');
  assert.strictEqual(msg.interactive.type, 'flow');
  assert.strictEqual(msg.interactive.action.parameters.mode, 'draft');
  assert.strictEqual(msg.interactive.action.parameters.flow_token, 'live.fabc');
});
