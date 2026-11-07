/* The 108 EMT can tell the hospital that the mother is getting worse on the way. */
const test = require('node:test');
const assert = require('node:assert');

process.env.LIVE_KEY = 'test-key';
process.env.SKIP_TWILIO_SIGNATURE = '1';
process.env.PUBLIC_BASE_URL = 'https://mk.example';
const { createApp } = require('../server/index.js');
const { MemoryStore } = require('../server/store.js');
const S = require('../server/session.js');

async function boot() {
  let t = 2_000_000;
  const ctx = {
    now: () => t,
    send: async (live) => ({ status: live ? 'sent' : 'simulated', channel: live ? 'whatsapp' : 'screen' }),
    call: async () => ({ status: 'simulated' }),
    baseUrl: () => 'https://mk.example'
  };
  const { app } = createApp({ store: new MemoryStore(), ctx });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const act = async (action, args, sid, key) => (await fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-live-key': key || '' }, body: JSON.stringify({ sid: sid || SID, action, args }) })).json();
  const form = (path, data) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  const state = async (sid, key) => (await fetch(base + '/api/state?sid=' + sid + (key ? '&key=' + key : ''))).json();
  return { server, act, form, state };
}
const SID = '0123456789abcdef';
const msgs = (r, role) => r.outbox.filter((o) => o.role === role).map((o) => o.text);
async function sent(h, sid, key) {
  await h.act('startReferral', { typeId: 'bleeding' }, sid, key);
  await h.act('details', { patient: { name: 'Lakshmi Devi', blood: 'B+', informed: 'Yes' } }, sid, key);
  return h.act('send', {}, sid, key);
}

test('EMT "getting worse" before the hospital confirmed: asked hospitals and the district are told, the nurse sees it', async () => {
  const h = await boot();
  try {
    let r = await sent(h);
    const c = r.cur;
    r = await h.act('emtWorse', { emt: 'emt', sign: 'bleeding' });
    assert.ok(msgs(r, c.proposal).some((m) => /^UPDATE from 108 EMT: .*bleeding more/.test(m) && m.includes(c.id)));
    if (c.backup) assert.ok(msgs(r, c.backup).some((m) => /^UPDATE from 108 EMT/.test(m)));
    assert.ok(msgs(r, 'district').some((m) => /getting worse \(bleeding more\) and no hospital has confirmed/.test(m)));
    assert.ok(!msgs(r, 'doctor').some((m) => /UPDATE from 108 EMT/.test(m)), 'doctor gets it only after a hospital confirmed');
    assert.ok(r.chat.some((m) => /108 EMT: the mother is getting worse/.test(m.text)));
    assert.ok(msgs(r, 'emt').some((m) => /Recorded: Bleeding more/.test(m)));
    assert.strictEqual(r.cur.worse.length, 1);
    assert.ok(r.cur.events.some((e) => /getting worse/.test(e.text)));
  } finally { h.server.close(); }
});

test('EMT "getting worse" after the hospital confirmed: that hospital and the doctor, not the district', async () => {
  const h = await boot();
  try {
    let r = await sent(h);
    r = await h.act('hospitalReply', { kind: 'all-ready', facility: r.cur.proposal });
    const dest = r.cur.confirmed;
    r = await h.act('emtWorse', { emt: 'emt', sign: 'fit' });
    assert.ok(msgs(r, dest).some((m) => /UPDATE from 108 EMT: .*had a fit/.test(m)));
    assert.ok(msgs(r, 'doctor').some((m) => /UPDATE from 108 EMT/.test(m)));
    assert.ok(!msgs(r, 'district').some((m) => /getting worse/.test(m)));
  } finally { h.server.close(); }
});

test('EMT of the other ambulance cannot report on a mother who is not in it; logged-in EMT may only do this', async () => {
  const h = await boot();
  try {
    await h.act('twoAtOnce', {});
    let r = await h.act('emtWorse', { emt: 'emt2', sign: 'drowsy' });
    const A = r.refs.find((x) => x.tag === 'A'), B = r.refs.find((x) => x.tag === 'B');
    assert.ok(!A.worse && B.worse && B.worse.length === 1, 'EMT 2 reports on mother B only');
    const s = S.blank('x', false, 'confirms', 1);
    s.refs = [{ id: 'MK-1', state: 'sent', amb: 'amb1' }];
    assert.strictEqual(S.allowed(s, 'emt2', 'emtWorse', { ref: 'MK-1' }), false);
    assert.strictEqual(S.allowed(s, 'emt', 'emtWorse', { ref: 'MK-1' }), true);
    assert.strictEqual(S.allowed(s, 'emt', 'send', {}), false);
  } finally { h.server.close(); }
});

test('WhatsApp: the EMT replies WORSE, gets the list, then WORSE 3', async () => {
  process.env.PHONE_EMT = '+919000000031';
  const h = await boot();
  try {
    await sent(h, 'live', 'test-key');
    let t = await (await h.form('/twilio/whatsapp', { From: 'whatsapp:+919000000031', Body: 'WORSE' })).text();
    assert.match(t, /1 Bleeding more/);
    t = await (await h.form('/twilio/whatsapp', { From: 'whatsapp:+919000000031', Body: 'worse 3' })).text();
    assert.match(t, /Recorded: Drowsy or not responding/);
    const st = await h.state('live', 'test-key');
    assert.strictEqual(st.cur.worse[0].sign, 'drowsy');
  } finally { h.server.close(); delete process.env.PHONE_EMT; }
});
