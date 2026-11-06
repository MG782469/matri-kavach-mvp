/* Tests for the 6 Nov second-round ideas: ask 2 hospitals at once, blood stock per group, staffing, Hindi,
   hospital editor, settings, ASHA home emergency, supply idea (OFF by default), role logins, drafts, SMS. */
const test = require('node:test');
const assert = require('node:assert');

process.env.LIVE_KEY = 'test-key';
process.env.PUBLIC_BASE_URL = 'https://mk.example';
const { createApp } = require('../server/index.js');
const { MemoryStore } = require('../server/store.js');
const S = require('../server/session.js');

async function boot() {
  let t = 1_000_000;
  const ctx = {
    now: () => t,
    send: async () => ({ status: 'simulated', channel: 'screen' }),
    call: async () => ({ status: 'simulated' }),
    baseUrl: () => 'https://mk.example'
  };
  const { app, runTick } = createApp({ store: new MemoryStore(), ctx });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = async (path, body, token) => {
    const headers = { 'content-type': 'application/json' }; if (token) headers['x-role-token'] = token;
    const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const act = async (action, args, token) => (await post('/api/act', { sid: SID, action, args }, token)).body;
  const state = async (token) => { const h = token ? { 'x-role-token': token } : {}; const r = await fetch(base + '/api/state?sid=' + SID, { headers: h }); return { status: r.status, body: await r.json() }; };
  return { server, post, act, state, runTick, advance: (ms) => { t += ms; } };
}
const SID = '0123456789abcdef';
const PATIENT = { name: 'Lakshmi Devi', age: '24', blood: 'B+', contact: '98XXXXXX10', time: '22:41', mode: 'Normal', oxy: 'Yes', miso: 'Yes', iv: 'Yes' };
const ALLYES = Object.fromEntries(S.ALL_ITEMS.map((i) => [i.id, true]));
const msgs = (r, role) => r.outbox.filter((o) => o.role === role).map((o) => o.text);
async function toSent(h, patient) {
  await h.act('startReferral', { typeId: 'bleeding' });
  await h.act('details', { patient: patient || PATIENT });
  return h.act('send', {});
}

test('ask 2 at once: DH and SDH both get INCOMING; DH confirms, SDH is cancelled', async () => {
  const h = await boot();
  try {
    let r = await toSent(h);
    assert.strictEqual(r.cur.proposal, 'dh'); assert.strictEqual(r.cur.backup, 'sdh');
    assert.ok(msgs(r, 'dh').some((m) => /^INCOMING/.test(m)));
    assert.ok(msgs(r, 'sdh').some((m) => /^INCOMING/.test(m) && /BACKUP together with DH Devgarh/.test(m)));
    assert.ok(r.chat.some((m) => /Also asked at the same time as backup: SDH Kheri/.test(m.text)));
    r = await h.act('hospitalReply', { kind: 'all-ready', facility: 'dh' });
    assert.strictEqual(r.cur.state, 'confirmed'); assert.strictEqual(r.cur.confirmed, 'dh');
    assert.ok(msgs(r, 'sdh').some((m) => /^CANCELLED/.test(m)));
  } finally { h.server.close(); }
});

test('backup says yes first: the nearer hospital keeps priority; when it says no, the backup is confirmed at once', async () => {
  const h = await boot();
  try {
    await toSent(h);
    let r = await h.act('hospitalReply', { kind: 'all-ready', facility: 'sdh' });
    assert.strictEqual(r.cur.state, 'sent'); assert.ok(r.cur.backupYes);
    assert.ok(r.chat.some((m) => /SDH Kheri \(backup\) said ready/.test(m.text)));
    r = await h.act('hospitalReply', { kind: 'not-available', facility: 'dh' });
    assert.strictEqual(r.cur.state, 'confirmed'); assert.strictEqual(r.cur.confirmed, 'sdh');
    assert.ok(!msgs(r, 'dh').some((m) => /^CANCELLED/.test(m)));
    assert.ok(msgs(r, 'family').some((m) => /SDH Kheri/.test(m)));
  } finally { h.server.close(); }
});

test('backup said yes and the nearer hospital stays silent for 2 minutes: backup confirmed, no IVR call, DH told', async () => {
  const h = await boot();
  try {
    await toSent(h);
    await h.act('hospitalReply', { kind: 'ready-in', minutes: 10, facility: 'sdh' });
    h.advance(121000); await h.runTick();
    const r = (await h.state()).body;
    assert.strictEqual(r.cur.state, 'confirmed'); assert.strictEqual(r.cur.confirmed, 'sdh'); assert.strictEqual(r.cur.readyIn, 10);
    assert.ok(msgs(r, 'dh').some((m) => /^CANCELLED/.test(m)));
    assert.ok(!r.outbox.some((o) => /^No-reply call/.test(o.label)));
  } finally { h.server.close(); }
});

test('nearer hospital says no while the backup has not answered: the backup becomes first choice with a fresh timer', async () => {
  const h = await boot();
  try {
    await toSent(h);
    h.advance(30000);
    let r = await h.act('hospitalReply', { kind: 'not-available', facility: 'dh' });
    assert.strictEqual(r.cur.state, 'sent'); assert.strictEqual(r.cur.proposal, 'sdh'); assert.strictEqual(r.cur.timerStart, 1_030_000);
    assert.ok(msgs(r, 'sdh').some((m) => /now the FIRST choice/.test(m)));
    assert.ok(msgs(r, 'driver').some((m) => /go to SDH Kheri instead/.test(m)));
    r = await h.act('hospitalReply', { kind: 'all-ready', facility: 'sdh' });
    assert.strictEqual(r.cur.confirmed, 'sdh');
  } finally { h.server.close(); }
});

test('settings: parallel off asks one hospital; reply window 60 s starts the call after 60 s', async () => {
  const h = await boot();
  try {
    await h.act('setSettings', { parallel: false, replyWindowSec: 60 });
    let r = await toSent(h);
    assert.strictEqual(r.cur.backup, null);
    assert.ok(!msgs(r, 'sdh').length);
    assert.strictEqual(r.replyWindowSec, 60);
    h.advance(61000); await h.runTick();
    r = (await h.state()).body;
    assert.strictEqual(r.cur.state, 'ivr');
  } finally { h.server.close(); }
});

test('blood stock per group: B- mother skips DH (no B- unit) and goes to SDH', async () => {
  const h = await boot();
  try {
    const r = await toSent(h, Object.assign({}, PATIENT, { blood: 'B-' }));
    assert.strictEqual(r.cur.proposal, 'sdh');
  } finally { h.server.close(); }
});

test('check-in records nurses on duty and blood stock; one nurse alerts the district', async () => {
  const h = await boot();
  try {
    let r = await h.act('checkin', { facility: 'dh', items: ALLYES, nurses: 1, bloodStock: { 'B+': 0, 'O+': 3, 'X': 9 } });
    const f = r.facilities.find((x) => x.id === 'dh');
    assert.strictEqual(f.checkin.nurses, 1); assert.deepStrictEqual(f.bloodStock, { 'O+': 3 });
    assert.ok(msgs(r, 'district').some((m) => /Staffing gap: DH Devgarh has only 1 nurse/.test(m)));
    r = await toSent(h);
    assert.strictEqual(r.cur.proposal, 'sdh'); // no B+ left at DH
    r = await h.act('eraktSync', { facility: 'dh' });
    assert.ok(msgs(r, 'dh').some((m) => /e-RaktKosh \(MOCK/.test(m)));
  } finally { h.server.close(); }
});

test('Hindi: nurse chat in Hindi, family gets Hindi and English', async () => {
  const h = await boot();
  try {
    await h.act('setSettings', { lang: 'hi' });
    await toSent(h);
    const r = await h.act('hospitalReply', { kind: 'all-ready' });
    assert.ok(r.chat.some((m) => /सब तैयार/.test(m.text)));
    const fam = msgs(r, 'family').pop();
    assert.match(fam, /MCP कार्ड/); assert.match(fam, /Bring the MCP card/);
  } finally { h.server.close(); }
});

test('hospital editor: a new hospital is Uncertain until it checks in, then it can be proposed', async () => {
  const h = await boot();
  try {
    let r = await h.act('addHospital', { name: 'CHC Naya', km: 5 });
    const nf = r.facilities.find((f) => f.name === 'CHC Naya');
    assert.ok(nf && nf.checkin === null);
    r = await toSent(h); assert.strictEqual(r.cur.proposal, 'dh');
    await h.act('reset', {});
    r = await h.act('checkin', { facility: nf.id, items: ALLYES, nurses: 2, bloodStock: { 'B+': 2 } });
    r = await toSent(h); assert.strictEqual(r.cur.proposal, nf.id);
    await h.act('reset', {});
    r = await h.act('removeHospital', { id: nf.id });
    assert.ok(!r.facilities.some((f) => f.id === nf.id));
  } finally { h.server.close(); }
});

test('ASHA home emergency: distances from the home, ambulance sent at once, driver gets the village', async () => {
  const h = await boot();
  try {
    const r = await h.act('ashaHome', { typeId: 'bleeding', village: 'kesla', blood: 'B+' });
    assert.strictEqual(r.cur.state, 'sent'); assert.strictEqual(r.cur.origin.name, 'Village Kesla');
    assert.ok(msgs(r, 'driver').some((m) => /pick up at Village Kesla/.test(m)));
    assert.ok(msgs(r, 'asha').some((m) => /108 is coming to Village Kesla/.test(m)));
    const dh = r.facilities.find((f) => f.id === 'dh');
    assert.strictEqual(dh.km, Math.round(Math.hypot(40 - 33, 57 - 40)));
  } finally { h.server.close(); }
});

test('supply idea is OFF by default; when ON it only advises the district and routing does not change', async () => {
  const h = await boot();
  try {
    const items = Object.assign({}, ALLYES, { uterotonics: false });
    await h.act('checkin', { facility: 'chc', items });
    let r = await toSent(h);
    assert.ok(!msgs(r, 'district').some((m) => /Supply idea/.test(m)));
    await h.act('reset', {});
    await h.act('checkin', { facility: 'chc', items });
    await h.act('setSettings', { supply: true });
    r = await toSent(h, Object.assign({}, PATIENT, { blood: 'O+' }));
    assert.strictEqual(r.cur.proposal, 'dh');
    assert.ok(msgs(r, 'district').some((m) => /Supply idea \(OFF by default, not approved/.test(m) && /CHC Sonpur/.test(m) && /uterotonic/.test(m)));
  } finally { h.server.close(); }
});

test('role login: code, token, own messages only, and actions limited to the role', async () => {
  const h = await boot();
  try {
    await toSent(h);
    assert.strictEqual((await h.post('/api/login', { sid: SID, phone: '99999 99999' })).status, 404);
    const L = (await h.post('/api/login', { sid: SID, phone: '90000 00008' })).body;
    assert.strictEqual(L.role, 'driver'); assert.match(L.demoCode, /^\d{6}$/);
    assert.strictEqual((await h.post('/api/verify', { sid: SID, phone: '90000 00008', code: '000000' })).status, 401);
    const V = (await h.post('/api/verify', { sid: SID, phone: '90000 00008', code: L.demoCode })).body;
    const st = (await h.state(V.token)).body;
    assert.strictEqual(st.role, 'driver'); assert.deepStrictEqual(st.chat, []);
    assert.ok(st.outbox.every((o) => o.role === 'driver'));
    assert.ok(!st.cur.patient && !JSON.stringify(st).includes('Lakshmi'));
    assert.strictEqual((await h.post('/api/act', { sid: SID, action: 'hospitalReply', args: { kind: 'all-ready' } }, V.token)).status, 403);
    const L2 = (await h.post('/api/login', { sid: SID, phone: '9000000002' })).body;
    const V2 = (await h.post('/api/verify', { sid: SID, phone: '9000000002', code: L2.demoCode })).body;
    assert.strictEqual((await h.post('/api/act', { sid: SID, action: 'checkin', args: { facility: 'sdh', items: ALLYES } }, V2.token)).status, 403);
    const ok = await h.post('/api/act', { sid: SID, action: 'hospitalReply', args: { kind: 'all-ready', facility: 'dh' } }, V2.token);
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.cur.confirmed, 'dh');
    assert.strictEqual((await h.state('f'.repeat(32))).status, 401);
  } finally { h.server.close(); }
});

test('draft emergencies are never routed: the nurse sees the draft list and is told to call the doctor', async () => {
  const h = await boot();
  try {
    const r = await h.act('startReferral', { typeId: 'aph' });
    assert.strictEqual(r.cur, null);
    assert.ok(r.chat.some((m) => /Draft checklist for clinical review/.test(m.text) && /Call the doctor now/.test(m.text)));
  } finally { h.server.close(); }
});

test('family by SMS when set: the family message goes on the SMS channel', async () => {
  const h = await boot();
  try {
    await h.act('setSettings', { smsFamily: true });
    await toSent(h);
    const r = await h.act('hospitalReply', { kind: 'all-ready' });
    assert.strictEqual(r.outbox.find((o) => o.role === 'family').channel, 'sms');
  } finally { h.server.close(); }
});
