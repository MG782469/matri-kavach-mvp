/* Two (or more) mothers at the same time: each case has its own ID, step, hospital, 108 ambulance and timer,
   and every reply reaches the right case. */
const test = require('node:test');
const assert = require('node:assert');

process.env.LIVE_KEY = 'test-key';
process.env.SKIP_TWILIO_SIGNATURE = '1';
process.env.PUBLIC_BASE_URL = 'https://mk.example';
const { createApp } = require('../server/index.js');
const { MemoryStore } = require('../server/store.js');
const S = require('../server/session.js');

async function boot() {
  let t = 1_000_000;
  const ctx = {
    now: () => t,
    send: async (live) => ({ status: live ? 'sent' : 'simulated', channel: live ? 'whatsapp' : 'screen' }),
    call: async () => ({ status: 'simulated' }),
    baseUrl: () => 'https://mk.example'
  };
  const { app, runTick } = createApp({ store: new MemoryStore(), ctx });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const act = async (action, args, sid, key) => {
    const res = await fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-live-key': key || '' }, body: JSON.stringify({ sid: sid || SID, action, args }) });
    return res.json();
  };
  const state = async () => (await fetch(base + '/api/state?sid=' + SID)).json();
  const form = (path, data) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  return { server, act, state, form, runTick, advance: (ms) => { t += ms; } };
}
const SID = 'fedcba9876543210';
const byTag = (r, tag) => r.refs.find((x) => x.tag === tag);
const msgs = (r, role) => r.outbox.filter((o) => o.role === role).map((o) => o.text);

test('two mothers at once: own case ID, own hospital, own ambulance with a map link, no patient details for drivers', async () => {
  const h = await boot();
  try {
    const r = await h.act('twoAtOnce', {});
    const A = byTag(r, 'A'), B = byTag(r, 'B');
    assert.ok(A && B && A.id !== B.id);
    assert.strictEqual(A.type, 'bleeding'); assert.strictEqual(B.type, 'fits');
    assert.strictEqual(A.state, 'sent'); assert.strictEqual(B.state, 'sent');
    assert.strictEqual(A.proposal, 'dh'); assert.strictEqual(B.proposal, 'sdh');
    assert.strictEqual(A.amb, 'amb1'); assert.strictEqual(B.amb, 'amb2');
    const d1 = msgs(r, 'driver'), d2 = msgs(r, 'driver2');
    assert.ok(d1.some((m) => m.includes('case ' + A.id) && /DH Devgarh/.test(m) && /google\.com\/maps\/dir\/\?api=1&origin=23\.15,85\.296&destination=23\.087,85\.492/.test(m)));
    assert.ok(d2.some((m) => m.includes('case ' + B.id) && /Mother B/.test(m) && /SDH Kheri/.test(m) && /destination=23\.357,85\.198/.test(m)));
    assert.ok(!d1.concat(d2).some((m) => /Lakshmi|Sunita|B\+|O\+|fits/i.test(m)), 'drivers get no patient details');
    assert.ok(msgs(r, 'emt2').some((m) => m.includes(B.id) && /Sunita/.test(m)), 'EMT 2 gets the handover for mother B');
    assert.ok(msgs(r, 'sdh').some((m) => /^INCOMING: Fits/.test(m) && m.includes(B.id)));
    assert.ok(r.chat.some((m) => /^Mother B \(/.test(m.text)), 'nurse lines say which mother');
  } finally { h.server.close(); }
});

test('hospital replies reach the right mother; the nurse screen stays on her case', async () => {
  const h = await boot();
  try {
    let r = await h.act('twoAtOnce', {});
    const B = byTag(r, 'B');
    assert.strictEqual(r.cur.id, B.id);
    r = await h.act('hospitalReply', { kind: 'all-ready', facility: 'dh' }); // DH was asked only for mother A
    assert.strictEqual(byTag(r, 'A').state, 'confirmed'); assert.strictEqual(byTag(r, 'A').confirmed, 'dh');
    assert.strictEqual(byTag(r, 'B').state, 'sent');
    assert.strictEqual(r.cur.id, B.id, 'screen did not jump to A');
    assert.ok(r.chat.some((m) => /^Mother A \(.*DH Devgarh: ALL READY/.test(m.text)));
    assert.ok(msgs(r, 'driver').some((m) => /has confirmed/.test(m)));
    assert.ok(!msgs(r, 'driver2').some((m) => /has confirmed/.test(m)));
    r = await h.act('hospitalReply', { kind: 'all-ready', facility: 'sdh', ref: B.id });
    assert.strictEqual(byTag(r, 'B').state, 'confirmed'); assert.strictEqual(byTag(r, 'B').confirmed, 'sdh');
    // close mother A from her own case
    r = await h.act('switchCase', { id: byTag(r, 'A').id });
    assert.strictEqual(r.cur.tag, 'A'); assert.strictEqual(r.step, 'close');
    await h.act('arrived', { value: 'Yes' }); await h.act('readyCheck', { value: 'Yes' });
    r = await h.act('outcome', { value: 'Delivered' });
    assert.strictEqual(byTag(r, 'A').state, 'closed'); assert.strictEqual(byTag(r, 'B').state, 'confirmed');
  } finally { h.server.close(); }
});

test('each case has its own 2-minute timer, also when it is not on the nurse screen', async () => {
  const h = await boot();
  try {
    await h.act('twoAtOnce', {});
    h.advance(121000); await h.runTick();
    const r = await h.state();
    assert.strictEqual(byTag(r, 'A').state, 'ivr'); assert.strictEqual(byTag(r, 'B').state, 'ivr');
    assert.strictEqual(r.cur.tag, 'B');
  } finally { h.server.close(); }
});

test('nurse: a keyword starts a second mother while the first keeps waiting; NEW and CASE A switch', async () => {
  const h = await boot();
  try {
    await h.act('startReferral', { typeId: 'bleeding' });
    await h.act('details', { patient: { name: 'Lakshmi Devi', blood: 'B+', informed: 'Yes' } });
    let r = await h.act('send', {});
    const A = r.cur.id;
    r = await h.act('nurseText', { text: 'FITS O+' });
    assert.notStrictEqual(r.cur.id, A);
    assert.strictEqual(r.refs.find((x) => x.id === A).state, 'sent', 'mother A still waiting');
    r = await h.act('nurseText', { text: 'CASE A' });
    assert.strictEqual(r.cur.id, A); assert.strictEqual(r.step, 'waiting');
    r = await h.act('nurseText', { text: 'NEW' });
    assert.strictEqual(r.cur, null); assert.strictEqual(r.step, 'start');
    assert.ok(/2 referral\(s\) still running/.test(r.chat[r.chat.length - 1].text));
  } finally { h.server.close(); }
});

test('a third mother with both ambulances busy: the district is asked for the nearest free 108', async () => {
  const h = await boot();
  try {
    await h.act('twoAtOnce', {});
    const r = await h.act('nurseText', { text: 'BLEED A+' });
    const C = byTag(r, 'C');
    assert.ok(C);
    if (C.state === 'routed') { const r2 = await h.act('send', {}); assert.ok(msgs(r2, 'district').some((m) => /no free 108 ambulance for case/.test(m) && m.includes(C.id))); }
    else assert.ok(msgs(r, 'district').some((m) => /no free 108 ambulance for case/.test(m)));
  } finally { h.server.close(); }
});

test('a held blood unit leaves the free stock, and comes back if the mother does not arrive', async () => {
  const h = await boot();
  try {
    let r = await h.act('twoAtOnce', {});
    const before = r.facilities.find((f) => f.id === 'dh').bloodStock['B+'];
    r = await h.act('hospitalReply', { kind: 'all-ready', facility: 'dh' });
    assert.strictEqual(r.facilities.find((f) => f.id === 'dh').bloodStock['B+'], before - 1);
    await h.act('switchCase', { tag: 'A' });
    r = await h.act('arrived', { value: 'No' });
    assert.strictEqual(r.facilities.find((f) => f.id === 'dh').bloodStock['B+'], before);
  } finally { h.server.close(); }
});

test('WhatsApp: a hospital asked for two mothers answers one by letter ("1 B"); plain "1" answers the first', async () => {
  process.env.PHONE_SDH = '+919000000022';
  const h = await boot();
  try {
    // Mother A: bleeding -> DH, SDH backup. Mother B: fits -> SDH. SDH is asked for both.
    await h.act('twoAtOnce', {}, 'live', 'test-key');
    let t = await (await h.form('/twilio/whatsapp', { From: 'whatsapp:+919000000022', Body: '1 B' })).text();
    let st = await (await fetch('http://127.0.0.1:' + h.server.address().port + '/api/state?sid=live&key=test-key')).json();
    const B = byTag(st, 'B');
    assert.match(t, new RegExp('ALL READY \\(case ' + B.id + '\\)'));
    assert.strictEqual(B.state, 'confirmed'); assert.strictEqual(B.confirmed, 'sdh');
    assert.strictEqual(byTag(st, 'A').state, 'sent');
    t = await (await h.form('/twilio/whatsapp', { From: 'whatsapp:+919000000022', Body: '1' })).text();
    st = await (await fetch('http://127.0.0.1:' + h.server.address().port + '/api/state?sid=live&key=test-key')).json();
    assert.match(t, /as backup/);
    assert.ok(byTag(st, 'A').backupYes); assert.strictEqual(byTag(st, 'A').state, 'sent');
  } finally { h.server.close(); delete process.env.PHONE_SDH; }
});

test('reading a case from text: case ID or a final letter', () => {
  const s = S.blank('0011223344556677', false, 'confirms', 1);
  s.refs = [{ id: 'MK-000001', tag: 'A', state: 'sent' }, { id: 'MK-000002', tag: 'B', state: 'sent' }];
  assert.strictEqual(S.refInText(s, '1 mk-000002'), 'MK-000002');
  assert.strictEqual(S.refInText(s, '2 20 B'), 'MK-000002');
  assert.strictEqual(S.refInText(s, '1'), null);
  assert.strictEqual(S.refInText(s, 'team'), null);
});
