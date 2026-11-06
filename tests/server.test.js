const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

process.env.LIVE_KEY = 'test-key';
process.env.SKIP_TWILIO_SIGNATURE = '1';
process.env.PHONE_NURSE = '+919000000001';
process.env.PHONE_DH = '+919000000002';
process.env.PHONE_SDH = '+919000000002';
process.env.PHONE_DOCTOR = '+919000000003';
process.env.PHONE_FAMILY = '+919000000004';
process.env.PUBLIC_BASE_URL = 'https://mk.example';

const { createApp } = require('../server/index.js');
const { MemoryStore } = require('../server/store.js');

async function boot() {
  let t = 1_000_000;
  const sent = []; const calls = [];
  const ctx = {
    now: () => t,
    send: async (live, role, text) => { if (live) sent.push({ role, text }); return { status: live ? 'sent' : 'simulated', channel: live ? 'whatsapp' : 'screen' }; },
    call: async (live, role, ref) => { if (live) calls.push({ role, ref }); return { status: live ? 'sent' : 'simulated' }; },
    baseUrl: () => 'https://mk.example'
  };
  const { app, runTick } = createApp({ store: new MemoryStore(), ctx });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const act = async (sid, action, args, key) => {
    const res = await fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-live-key': key || '' }, body: JSON.stringify({ sid, action, args }) });
    return { status: res.status, body: await res.json() };
  };
  const form = (path, data) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
  return { base, server, act, form, sent, calls, runTick, advance: (ms) => { t += ms; } };
}

const PATIENT = { name: 'Lakshmi Devi', age: '24', blood: 'B+', contact: '98XXXXXX10', time: '22:41', mode: 'Normal', oxy: 'Yes', miso: 'Yes', iv: 'Yes' };
const SID = 'abcdef0123456789';

async function toSent(h, sid, key) {
  await h.act(sid, 'startReferral', { typeId: 'bleeding' }, key);
  await h.act(sid, 'details', { patient: PATIENT }, key);
  return h.act(sid, 'send', {}, key);
}

test('web session: confirm, close the loop, nothing is really sent', async () => {
  const h = await boot();
  let r = await toSent(h, SID);
  assert.strictEqual(r.body.cur.state, 'sent');
  assert.strictEqual(r.body.cur.proposal, 'dh');
  r = await h.act(SID, 'hospitalReply', { kind: 'all-ready' });
  assert.strictEqual(r.body.cur.state, 'confirmed');
  assert.ok(r.body.outbox.every((o) => o.status === 'simulated'));
  r = await h.act(SID, 'arrived', { value: 'Yes' });
  r = await h.act(SID, 'readyCheck', { value: 'Yes' });
  r = await h.act(SID, 'outcome', { value: 'Delivered' });
  assert.strictEqual(r.body.cur.state, 'closed');
  assert.strictEqual(h.sent.length, 0);
  h.server.close();
});

test('server timer: 120 s silence starts IVR, no answer reroutes to SDH and restarts the timer', async () => {
  const h = await boot();
  await toSent(h, SID);
  h.advance(119000); await h.runTick();
  let r = await (await fetch(h.base + '/api/state?sid=' + SID)).json();
  assert.strictEqual(r.cur.state, 'sent');
  h.advance(2000); await h.runTick();
  r = await (await fetch(h.base + '/api/state?sid=' + SID)).json();
  assert.strictEqual(r.cur.state, 'ivr');
  r = (await h.act(SID, 'ivrAnswer', { answer: 'none' })).body;
  assert.strictEqual(r.cur.state, 'sent');
  assert.strictEqual(r.cur.proposal, 'sdh');
  assert.ok(r.cur.timerStart >= 1_000_000 + 121000);
  h.server.close();
});

test('live session needs the key; bad session ids are refused', async () => {
  const h = await boot();
  assert.strictEqual((await h.act('live', 'startReferral', { typeId: 'bleeding' }, 'wrong')).status, 403);
  assert.strictEqual((await h.act('not-a-session', 'reset', {})).status, 403);
  assert.strictEqual((await h.act('live', 'reset', {}, 'test-key')).status, 200);
  h.server.close();
});

test('live: SEND messages the hospital, hospital WhatsApp reply 1 confirms and fans out alerts with a 2-hour link', async () => {
  const h = await boot();
  await toSent(h, 'live', 'test-key');
  assert.ok(h.sent.some((m) => m.role === 'dh' && /INCOMING/.test(m.text)));
  const res = await h.form('/twilio/whatsapp', { From: 'whatsapp:+919000000002', Body: '1' });
  assert.match(await res.text(), /ALL READY/);
  const st = await (await fetch(h.base + '/api/state?sid=live&key=test-key')).json();
  assert.strictEqual(st.cur.state, 'confirmed');
  const doc = h.sent.find((m) => m.role === 'doctor');
  assert.ok(doc && /\/s\/live\./.test(doc.text));
  assert.ok(h.sent.some((m) => m.role === 'family'));
  const token = doc.text.match(/\/s\/(live\.[a-f0-9]+)/)[1];
  assert.strictEqual((await fetch(h.base + '/s/' + token)).status, 200);
  h.advance(2 * 60 * 60 * 1000 + 1000);
  assert.strictEqual((await fetch(h.base + '/s/' + token)).status, 410);
  h.server.close();
});

test('live: a reply from the wrong number is ignored; "2" without minutes asks again; "2 20" is ready in 20', async () => {
  const h = await boot();
  await toSent(h, 'live', 'test-key');
  let t = await (await h.form('/twilio/whatsapp', { From: 'whatsapp:+919999999999', Body: '1' })).text();
  assert.match(t, /no referral is waiting/);
  t = await (await h.form('/twilio/whatsapp', { From: 'whatsapp:+919000000002', Body: '2' })).text();
  assert.match(t, /minutes/);
  t = await (await h.form('/twilio/whatsapp', { From: 'whatsapp:+919000000002', Body: '2 20' })).text();
  assert.match(t, /ready in 20/);
  const st = await (await fetch(h.base + '/api/state?sid=live&key=test-key')).json();
  assert.strictEqual(st.cur.readyIn, 20);
  h.server.close();
});

test('live: silence places the IVR call; pressing 1 on the call confirms; no answer reroutes', async () => {
  const h = await boot();
  await toSent(h, 'live', 'test-key');
  h.advance(121000); await h.runTick();
  assert.strictEqual(h.calls.length, 1);
  const ref = h.calls[0].ref;
  const voice = await (await h.form('/twilio/voice?ref=' + ref, {})).text();
  assert.match(voice, /Press 1 if all ready/);
  await h.form('/twilio/voice-gather?ref=' + ref, { Digits: '1' });
  let st = await (await fetch(h.base + '/api/state?sid=live&key=test-key')).json();
  assert.strictEqual(st.cur.state, 'confirmed');
  await h.act('live', 'reset', {}, 'test-key');
  await toSent(h, 'live', 'test-key');
  h.advance(121000); await h.runTick();
  const ref2 = h.calls[1].ref;
  await h.form('/twilio/voice-status?ref=' + ref2, { CallStatus: 'no-answer' });
  st = await (await fetch(h.base + '/api/state?sid=live&key=test-key')).json();
  assert.strictEqual(st.cur.state, 'sent');
  assert.strictEqual(st.cur.proposal, 'sdh');
  h.server.close();
});

test('Twilio signature check rejects a forged webhook and accepts a signed one', async () => {
  process.env.SKIP_TWILIO_SIGNATURE = '0';
  process.env.TWILIO_AUTH_TOKEN = 'secret-token';
  const h = await boot();
  const body = { From: 'whatsapp:+919000000002', Body: '1' };
  let res = await h.form('/twilio/whatsapp', body);
  assert.strictEqual(res.status, 403);
  const url = 'https://mk.example/twilio/whatsapp';
  const data = Object.keys(body).sort().reduce((a, k) => a + k + body[k], url);
  const sig = crypto.createHmac('sha1', 'secret-token').update(data).digest('base64');
  res = await fetch(h.base + '/twilio/whatsapp', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig }, body: new URLSearchParams(body) });
  assert.strictEqual(res.status, 200);
  delete process.env.TWILIO_AUTH_TOKEN; process.env.SKIP_TWILIO_SIGNATURE = '1';
  h.server.close();
});

test('TEST_PHONE stands in for team roles but not for blood bank, ASHA or district; Render address is used by default', () => {
  const n = require('../server/notify.js');
  const keep = { ...process.env };
  for (const k of ['PHONE_NURSE', 'PHONE_DH', 'PHONE_DOCTOR', 'PHONE_FAMILY', 'PHONE_BLOODBANK', 'PUBLIC_BASE_URL']) delete process.env[k];
  process.env.TEST_PHONE = '+919811111111';
  process.env.RENDER_EXTERNAL_URL = 'https://matri-kavach.onrender.com/';
  assert.strictEqual(n.phoneFor('dh'), '+919811111111');
  assert.strictEqual(n.phoneFor('family'), '+919811111111');
  assert.strictEqual(n.phoneFor('bloodbank'), '');
  assert.strictEqual(n.phoneFor('asha'), '');
  assert.strictEqual(n.baseUrl(), 'https://matri-kavach.onrender.com');
  Object.assign(process.env, keep); delete process.env.TEST_PHONE; delete process.env.RENDER_EXTERNAL_URL;
});

test('Telegram: join link connects one phone for all roles; INCOMING arrives with buttons; tapping "1 All ready" confirms', async () => {
  const { createTelegram } = require('../server/telegram.js');
  const store = new MemoryStore();
  const calls = [];
  const api = async (method, params) => { calls.push({ method, params }); return method === 'getMe' ? { username: 'MatriKavachBot' } : {}; };
  const telegram = createTelegram(store, { token: 'tok', api });
  await telegram.setup('https://mk.example');
  assert.ok(calls.some((c) => c.method === 'setWebhook' && c.params.url === 'https://mk.example/telegram/webhook'));
  let t = 1_000_000;
  const { app } = createApp({ store, telegram, ctx: {
    now: () => t, baseUrl: () => 'https://mk.example',
    send: (live, role, text) => telegram.sendText(live, role, text),
    call: (live, role, ref, text) => telegram.sendText(live, role, 'URGENT, no reply in 2 minutes. ' + text)
  } });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const hook = (text, secret = telegram.secret) => fetch(base + '/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ message: { chat: { id: 555 }, from: { first_name: 'Manas' }, text } }) });
  const st = await (await fetch(base + '/api/state?sid=live&key=test-key')).json();
  const all = st.telegram.find((l) => l.role === 'all');
  assert.match(all.url, /^https:\/\/t\.me\/MatriKavachBot\?start=[a-f0-9]{16}_all$/);
  assert.strictEqual((await hook('/start x', 'wrong')).status, 403);
  await hook('/start bad_all');
  assert.match(calls.at(-1).params.text, /not valid/);
  await hook('/start ' + all.url.split('start=')[1]);
  assert.match(calls.at(-1).params.text, /^Connected/);
  const act = (action, args) => fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-live-key': 'test-key' }, body: JSON.stringify({ sid: 'live', action, args }) });
  await act('startReferral', { typeId: 'bleeding' });
  await act('details', { patient: PATIENT });
  await act('send', {});
  const incoming = calls.find((c) => c.method === 'sendMessage' && /^INCOMING/.test(c.params.text));
  assert.ok(incoming && incoming.params.chat_id === '555' && incoming.params.reply_markup.keyboard);
  await hook('1 All ready');
  await new Promise((r) => setTimeout(r, 50));
  const after = await (await fetch(base + '/api/state?sid=live&key=test-key')).json();
  assert.strictEqual(after.cur.state, 'confirmed');
  assert.ok(after.outbox.some((o) => o.label === 'Receiving doctor' && o.status === 'sent' && o.channel === 'telegram'));
  assert.ok(after.outbox.some((o) => o.label === 'Blood bank' && o.status === 'no-phone'));
  server.close();
});

test('Meta WhatsApp: webhook check, INCOMING has 3 buttons, tapping "1 All ready" confirms, expired-window error is explained', async () => {
  const { createMeta } = require('../server/meta.js');
  const sent = [];
  let failNext = false;
  const api = async (body) => {
    if (failNext) { failNext = false; throw new Error('WhatsApp 131047: Re-engagement message (the phone must send a message to the test number first: 24-hour window)'); }
    sent.push(body); return { messages: [{ id: 'wamid.x' }] };
  };
  const meta = createMeta({ WA_TOKEN: 't', WA_PHONE_NUMBER_ID: '123', WA_APP_SECRET: '', api });
  const store = new MemoryStore();
  const { createTelegram } = require('../server/telegram.js');
  process.env.PHONE_DH = '+919700123513'; process.env.PHONE_NURSE = '+919700123513';
  const { app } = createApp({ store, meta, telegram: createTelegram(store, { token: '' }) });
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const st0 = await (await fetch(base + '/api/state?sid=live&key=test-key')).json();
  const vt = st0.metaVerifyToken;
  assert.match(vt, /^[a-f0-9]{20}$/);
  assert.strictEqual(await (await fetch(base + `/meta/webhook?hub.mode=subscribe&hub.verify_token=${vt}&hub.challenge=42`)).text(), '42');
  assert.strictEqual((await fetch(base + '/meta/webhook?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42')).status, 403);
  const act = (action, args) => fetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-live-key': 'test-key' }, body: JSON.stringify({ sid: 'live', action, args }) });
  await act('startReferral', { typeId: 'bleeding' });
  await act('details', { patient: PATIENT });
  await act('send', {});
  const inc = sent.find((b) => b.type === 'interactive');
  assert.ok(inc && inc.to === '919700123513' && inc.interactive.action.buttons.length === 3);
  assert.ok(inc.interactive.action.buttons.every((b) => b.reply.title.length <= 20));
  const tap = { entry: [{ changes: [{ value: { messages: [{ from: '919700123513', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: '1', title: '1 All ready' } } }] } }] }] };
  await fetch(base + '/meta/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tap) });
  await new Promise((r) => setTimeout(r, 50));
  let st = await (await fetch(base + '/api/state?sid=live&key=test-key')).json();
  assert.strictEqual(st.cur.state, 'confirmed');
  assert.ok(sent.some((b) => b.type === 'text' && /ALL READY/.test(b.text.body)));
  await act('reset', {});
  await act('startReferral', { typeId: 'bleeding' });
  await act('details', { patient: PATIENT });
  failNext = true;
  st = await (await act('send', {})).json();
  assert.ok(st.outbox.some((o) => o.status === 'failed' && /24-hour window/.test(o.error)));
  delete process.env.PHONE_DH;
  server.close();
});

test('WhatsApp-style view is served and closing a case records each nurse answer once', async () => {
  const h = await boot();
  try {
    const page = await fetch(h.base + '/chat');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Matri-Kavach Chat View/);
    const js = await fetch(h.base + '/src/chat.js');
    assert.strictEqual(js.status, 200);
    await toSent(h, SID);
    await h.act(SID, 'hospitalReply', { kind: 'all-ready' });
    await h.act(SID, 'arrived', { value: 'Yes' });
    await h.act(SID, 'readyCheck', { value: 'Yes' });
    const done = (await h.act(SID, 'outcome', { value: 'Delivered' })).body;
    assert.strictEqual(done.cur.state, 'closed');
    assert.strictEqual(done.chat.filter((m) => m.text === 'Yes, arrived').length, 1);
    assert.ok(done.chat.every((m) => typeof m.at === 'number'));
  } finally { h.server.close(); }
});

test('nurse chat starts empty and Hi opens the menu', async () => {
  const h = await boot();
  try {
    const sid = '0123456789abcdef';
    let r = await fetch(h.base + '/api/state?sid=' + sid).then((x) => x.json());
    assert.strictEqual(r.chat.length, 0);
    r = (await h.act(sid, 'nurseText', { text: 'hello' })).body;
    assert.deepStrictEqual(r.chat.map((m) => m.from), ['nurse', 'bot']);
    assert.match(r.chat[1].text, /Namaste/);
    r = (await h.act(sid, 'nurseText', { text: 'what now' })).body;
    assert.match(r.chat[3].text, /Type Hi/);
  } finally { h.server.close(); }
});

test('fits / eclampsia referral: own form, own alert text, review label, no blood bank alert', async () => {
  const h = await boot();
  try {
    let r = (await h.act(SID, 'startReferral', { typeId: 'fits' })).body;
    assert.ok(r.chat.some((m) => /pending obstetrician validation/.test(m.text)));
    r = (await h.act(SID, 'details', { patient: { name: 'Sunita', age: '22', blood: 'O+', contact: '98XXXXXX22', fits: '2', lastfit: '22:10', bp: '168/112', weeks: '34 weeks', mgso4: 'Yes', antihtn: 'Yes', iv: 'Yes' } })).body;
    assert.strictEqual(r.cur.proposal, 'sdh');
    assert.strictEqual(r.cur.patient.bp, '168/112');
    r = (await h.act(SID, 'send', {})).body;
    const inc = r.outbox.find((o) => o.role === 'sdh');
    assert.match(inc.text, /INCOMING: Fits \/ eclampsia/);
    assert.match(inc.text, /magnesium sulphate/);
    r = (await h.act(SID, 'hospitalReply', { kind: 'all-ready' })).body;
    assert.strictEqual(r.cur.state, 'confirmed');
    assert.ok(!r.outbox.some((o) => o.role === 'bloodbank'));
    const link = r.outbox.find((o) => o.role === 'doctor').text.match(/\/s\/[a-f0-9.]+/)[0];
    const page = await (await fetch(h.base + link)).text();
    assert.match(page, /Latest BP/);
    assert.match(page, /168\/112/);
    assert.match(page, /pending obstetrician validation/);
  } finally { h.server.close(); }
});

test('obstructed labour is still blocked: the nurse is told to call the doctor', async () => {
  const h = await boot();
  try {
    const r = (await h.act(SID, 'startReferral', { typeId: 'obstructed' })).body;
    assert.strictEqual(r.cur, null);
    assert.match(r.chat[r.chat.length - 1].text, /Call the doctor/);
  } finally { h.server.close(); }
});

test('108 driver gets pickup and hospital only, never patient details', async () => {
  const h = await boot();
  try {
    let r = (await toSent(h, SID)).body;
    const trip = r.outbox.find((o) => o.role === 'driver');
    assert.match(trip.text, /PHC Rampur/);
    assert.match(trip.text, /DH Devgarh/);
    assert.ok(!/Lakshmi|B\+|Oxytocin/.test(trip.text));
    r = (await h.act(SID, 'hospitalReply', { kind: 'all-ready' })).body;
    assert.ok(r.outbox.some((o) => o.role === 'driver' && /confirmed/.test(o.text)));
    assert.ok(r.outbox.some((o) => o.role === 'bloodbank' && /^B\+ alert/.test(o.text)));
    const fam = r.outbox.find((o) => o.role === 'family').text;
    assert.ok(!/bleeding|Oxytocin|B\+/i.test(fam));
  } finally { h.server.close(); }
});

test('shared shift check-in: saving it changes readiness for every emergency type', async () => {
  const h = await boot();
  try {
    const items = Object.fromEntries(require('../server/session.js').ALL_ITEMS.map((i) => [i.id, true]));
    let r = (await h.act(SID, 'checkin', { facility: 'dh', items })).body;
    const msg = r.outbox.filter((o) => o.role === 'dh').pop().text;
    assert.match(msg, /13 Yes, 0 No/);
    assert.match(msg, /Heavy bleeding, Fits \/ eclampsia/);
    await h.act(SID, 'startReferral', { typeId: 'fits' });
    r = (await h.act(SID, 'details', { patient: { name: 'S', age: '22', blood: 'O+' } })).body;
    assert.strictEqual(r.cur.proposal, 'dh');
  } finally { h.server.close(); }
});

test('missed check-in: hospital turns Uncertain, gets a reminder, district is told, bleeding goes to SDH', async () => {
  const h = await boot();
  try {
    let r = (await h.act(SID, 'missCheckin', { facility: 'dh' })).body;
    assert.strictEqual(r.facilities.find((f) => f.id === 'dh').checkin, null);
    assert.ok(r.outbox.some((o) => o.role === 'dh' && /Reminder/.test(o.text)));
    assert.ok(r.outbox.some((o) => o.role === 'district' && /has not done/.test(o.text)));
    r = (await toSent(h, SID)).body;
    assert.strictEqual(r.cur.proposal, 'sdh');
  } finally { h.server.close(); }
});

test('108 EMT gets the nurse facts for care on the way; the driver still does not', async () => {
  const h = await boot();
  try {
    const r = (await toSent(h, SID)).body;
    const emt = r.outbox.find((o) => o.role === 'emt').text;
    assert.match(emt, /Heavy bleeding/);
    assert.match(emt, /B\+/);
    assert.match(emt, /Oxytocin 10 IU given: Yes/);
    assert.match(emt, /no diagnosis/);
    assert.ok(!/Oxytocin|B\+/.test(r.outbox.find((o) => o.role === 'driver').text));
  } finally { h.server.close(); }
});

async function toConfirmed(h, sid) {
  await toSent(h, sid);
  return (await h.act(sid, 'hospitalReply', { kind: 'all-ready' })).body;
}

test('arrival check: "No, something missing" alerts the district with the item', async () => {
  const h = await boot();
  try {
    await toConfirmed(h, SID);
    let r = (await h.act(SID, 'arrived', { value: 'Yes' })).body;
    assert.match(r.chat[r.chat.length - 1].text, /Was everything ready/);
    r = (await h.act(SID, 'outcome', { value: 'Delivered' })).body;
    assert.notStrictEqual(r.cur.state, 'closed');
    r = (await h.act(SID, 'readyCheck', { value: 'No' })).body;
    assert.match(r.chat[r.chat.length - 1].text, /What was missing/);
    r = (await h.act(SID, 'readyCheck', { missing: 'anaesthetist' })).body;
    assert.ok(r.outbox.some((o) => o.role === 'district' && /mismatch/.test(o.text) && /Anaesthetist/.test(o.text)));
    r = (await h.act(SID, 'outcome', { value: 'Delivered' })).body;
    assert.strictEqual(r.cur.state, 'closed');
    assert.strictEqual(r.cur.missing, 'anaesthetist');
  } finally { h.server.close(); }
});

test('team ready, discharge back-referral, timeline events and family-informed record', async () => {
  const h = await boot();
  try {
    await h.act(SID, 'startReferral', { typeId: 'bleeding' });
    await h.act(SID, 'details', { patient: Object.assign({}, PATIENT, { informed: 'Yes' }) });
    await h.act(SID, 'send', {});
    let r = (await h.act(SID, 'hospitalReply', { kind: 'all-ready' })).body;
    assert.ok(r.outbox.some((o) => o.role === 'dh' && /Reply TEAM/.test(o.text)));
    r = (await h.act(SID, 'teamReady', {})).body;
    assert.ok(r.chat.some((m) => /team is ready at the labour room door/.test(m.text)));
    assert.ok(r.outbox.some((o) => o.role === 'emt' && /team is ready/.test(o.text)));
    await h.act(SID, 'arrived', { value: 'Yes' });
    await h.act(SID, 'readyCheck', { value: 'Yes' });
    await h.act(SID, 'outcome', { value: 'Delivered' });
    r = (await h.act(SID, 'discharge', {})).body;
    assert.ok(r.outbox.some((o) => o.role === 'asha' && /Back-referral/.test(o.text) && /day 3, 7 and 42/.test(o.text)));
    const ev = r.cur.events.map((e) => e.text).join(' | ');
    assert.match(ev, /Family informed that details go to the hospital: Yes/);
    assert.match(ev, /team ready/);
    assert.match(ev, /everything was ready on arrival/);
    assert.match(ev, /Discharged home/);
    assert.ok(r.cur.events.every((e) => typeof e.at === 'number'));
  } finally { h.server.close(); }
});

test('quick keyword BLEED B+ starts a referral and proposes a hospital; SEND by text works', async () => {
  const h = await boot();
  try {
    let r = (await h.act(SID, 'nurseText', { text: 'BLEED B+' })).body;
    assert.strictEqual(r.cur.type, 'bleeding');
    assert.strictEqual(r.cur.patient.blood, 'B+');
    assert.strictEqual(r.step, 'proposed');
    r = (await h.act(SID, 'nurseText', { text: 'send' })).body;
    assert.strictEqual(r.cur.state, 'sent');
    const h2 = await boot();
    const r2 = (await h2.act(SID, 'nurseText', { text: 'fits o pos' })).body;
    assert.strictEqual(r2.cur.type, 'fits');
    assert.strictEqual(r2.cur.patient.blood, 'O+');
    assert.strictEqual(r2.cur.proposal, 'sdh');
    h2.server.close();
  } finally { h.server.close(); }
});

test('monthly readiness report goes to the district officer', async () => {
  const h = await boot();
  try {
    const r = (await h.act(SID, 'monthlyReport', {})).body;
    const t = r.outbox.find((o) => o.role === 'district').text;
    assert.match(t, /Monthly readiness report/);
    assert.match(t, /HDU bed full on 11 nights/);
  } finally { h.server.close(); }
});

test('WhatsApp close flow by numbers: arrival, ready check, outcome', async () => {
  const h = await boot();
  process.env.PHONE_DH = '+919000000002';
  try {
    await h.act('live', 'startReferral', { typeId: 'bleeding' }, 'test-key');
    await h.act('live', 'details', { patient: PATIENT }, 'test-key');
    await h.act('live', 'send', {}, 'test-key');
    await h.act('live', 'hospitalReply', { kind: 'all-ready' }, 'test-key');
    process.env.PHONE_NURSE = '+919000000001';
    const say = async (b) => (await h.form('/twilio/whatsapp', { From: 'whatsapp:+919000000001', Body: b })).text();
    assert.match(await say('1'), /Was everything ready/);
    assert.match(await say('2'), /What was missing\? Reply|What was missing/);
    assert.match(await say('3'), /Outcome/);
    assert.match(await say('1'), /Thank you/);
  } finally { h.server.close(); }
});

async function toDischarged(h, sid) {
  await toConfirmed(h, sid);
  await h.act(sid, 'arrived', { value: 'Yes' });
  await h.act(sid, 'readyCheck', { value: 'Yes' });
  await h.act(sid, 'outcome', { value: 'Delivered' });
  return (await h.act(sid, 'discharge', {})).body;
}

test('hospital marks itself FULL: routing skips it, district is told, OPEN brings it back, it expires after 2 hours', async () => {
  const h = await boot();
  try {
    let r = (await h.act(SID, 'setFull', { facility: 'dh', on: true })).body;
    assert.strictEqual(r.facilities.find((f) => f.id === 'dh').full, true);
    assert.ok(r.outbox.some((o) => o.role === 'district' && /Diversion: DH Devgarh/.test(o.text)));
    await h.act(SID, 'startReferral', { typeId: 'bleeding' });
    r = (await h.act(SID, 'details', { patient: PATIENT })).body;
    assert.strictEqual(r.cur.proposal, 'sdh');
    await h.act(SID, 'reset', {});
    r = (await h.act(SID, 'setFull', { facility: 'dh', on: true })).body;
    r = (await h.act(SID, 'setFull', { facility: 'dh', on: false })).body;
    assert.ok(!r.facilities.find((f) => f.id === 'dh').full);
    await h.act(SID, 'setFull', { facility: 'dh', on: true });
    h.advance(2 * 60 * 60 * 1000 + 1000);
    await h.act(SID, 'startReferral', { typeId: 'bleeding' });
    r = (await h.act(SID, 'details', { patient: PATIENT })).body;
    assert.strictEqual(r.cur.proposal, 'dh');
  } finally { h.server.close(); }
});

test('KPIs: estimated door time, first hospital ready, mismatches', async () => {
  const E = require('../src/engine.js'); const D = require('../src/data.js');
  const h = await boot();
  try {
    await toConfirmed(h, SID);
    await h.act(SID, 'arrived', { value: 'Yes' });
    const r = (await h.act(SID, 'readyCheck', { value: 'No', missing: 'blood' })).body;
    const k = E.kpis(r.refs, r.facilities, D);
    assert.strictEqual(k.doorMin, 59);
    assert.strictEqual(k.firstReadyPct, 100);
    assert.strictEqual(k.mismatches, 1);
    assert.strictEqual(k.checked, 1);
  } finally { h.server.close(); }
});

test('blood hold: held on confirm, issue on arrival, released if she never arrives', async () => {
  const h = await boot();
  try {
    let r = await toConfirmed(h, SID);
    r = (await h.act(SID, 'arrived', { value: 'Yes' })).body;
    assert.ok(r.cur.bloodHoldUntil > 0);
    assert.ok(r.outbox.some((o) => o.role === 'bloodbank' && /hold one B\+ unit until/.test(o.text)));
    assert.ok(r.outbox.some((o) => o.role === 'bloodbank' && /Issue the held B\+ unit/.test(o.text)));
    await h.act(SID, 'reset', {});
    await toConfirmed(h, SID);
    r = (await h.act(SID, 'arrived', { value: 'Transferred' })).body;
    assert.ok(r.outbox.some((o) => o.role === 'bloodbank' && /Hold released/.test(o.text)));
  } finally { h.server.close(); }
});

test('hospital feedback after discharge reaches the nurse chat', async () => {
  const h = await boot();
  try {
    let r = await toDischarged(h, SID);
    assert.ok(r.outbox.some((o) => o.role === 'dh' && /was the referral on time/.test(o.text)));
    r = (await h.act(SID, 'feedback', { value: '2' })).body;
    assert.strictEqual(r.cur.feedback, 'Should have come earlier');
    assert.match(r.chat[r.chat.length - 1].text, /Feedback from DH Devgarh/);
    r = (await h.act(SID, 'feedback', { value: '1' })).body;
    assert.strictEqual(r.cur.feedback, 'Should have come earlier');
  } finally { h.server.close(); }
});

test('mock drill: every hospital phone gets it, replies are timed, district gets the result', async () => {
  const h = await boot();
  try {
    let r = (await h.act(SID, 'drill', {})).body;
    assert.strictEqual(r.outbox.filter((o) => /^DRILL/.test(o.text)).length, 4);
    h.advance(12000);
    await h.act(SID, 'drillReply', { facility: 'dh' });
    r = (await h.act(SID, 'drillReport', {})).body;
    const t = r.outbox.find((o) => o.role === 'district' && /drill result/.test(o.text)).text;
    assert.match(t, /DH Devgarh answered in 12 s/);
    assert.match(t, /SDH Kheri no reply/);
  } finally { h.server.close(); }
});

test('missed call with no internet: keypad 1 starts a heavy bleeding referral with details to follow', async () => {
  const h = await boot();
  try {
    let r = (await h.act(SID, 'missedCall', {})).body;
    assert.strictEqual(r.step, 'callback');
    r = (await h.act(SID, 'nurseText', { text: '1' })).body;
    assert.strictEqual(r.cur.type, 'bleeding');
    assert.strictEqual(r.step, 'proposed');
    assert.ok(r.cur.events.some((e) => /missed call/.test(e.text)));
    r = (await h.act(SID, 'send', {})).body;
    assert.ok(r.outbox.some((o) => o.role === 'dh' && /Blood group not known yet/.test(o.text)));
  } finally { h.server.close(); }
});

test('doctor summary link is an ISBAR handover', async () => {
  const h = await boot();
  try {
    const r = await toConfirmed(h, SID);
    const link = r.outbox.find((o) => o.role === 'doctor').text.match(/\/s\/[a-f0-9.]+/)[0];
    const html = await (await fetch(h.base + link)).text();
    ['I · Identify', 'S · Situation', 'B · Background', 'A · Nurse facts', 'R · Request', 'blood, anaesthetist, theatre'].forEach((x) => assert.ok(html.includes(x), x));
  } finally { h.server.close(); }
});

test('nobody ready: medical college is only proposed; doctor, blood bank and family wait for its confirmation', async () => {
  const h = await boot();
  try {
    await h.act(SID, 'reset', { scenario: 'nobody' });
    await h.act(SID, 'startReferral', { typeId: 'bleeding' });
    let r = (await h.act(SID, 'details', { patient: PATIENT })).body;
    assert.strictEqual(r.cur.state, 'fallback');
    assert.strictEqual(r.step, 'waiting');
    assert.ok(r.chat.some((m) => /District emergency escalation initiated\. Medical college proposed as tertiary fallback, subject to clinical coordination and state referral protocols\./.test(m.text)));
    assert.ok(!r.chat.some((m) => /Medical college is the destination/.test(m.text)));
    assert.ok(!r.outbox.some((o) => ['doctor', 'family', 'bloodbank'].includes(o.role)));
    assert.ok(r.outbox.some((o) => o.role === 'district' && /tertiary fallback/.test(o.text)));
    assert.ok(r.outbox.some((o) => o.role === 'mc' && /TERTIARY FALLBACK/.test(o.text)));
    assert.ok(r.outbox.some((o) => o.role === 'driver' && /proposed tertiary fallback/.test(o.text)));
    r = (await h.act(SID, 'arrived', { value: 'Yes' })).body;
    assert.ok(!r.cur.arrived);
    r = (await h.act(SID, 'hospitalReply', { kind: 'all-ready' })).body;
    assert.strictEqual(r.cur.state, 'confirmed');
    assert.strictEqual(r.cur.confirmed, 'mc');
    assert.strictEqual(r.step, 'close');
    assert.ok(r.outbox.some((o) => o.role === 'doctor') && r.outbox.some((o) => o.role === 'family'));
  } finally { h.server.close(); }
});

test('nobody ready and the medical college cannot confirm: district and clinicians decide, nothing is auto-accepted', async () => {
  const h = await boot();
  try {
    await h.act(SID, 'reset', { scenario: 'nobody' });
    await h.act(SID, 'startReferral', { typeId: 'bleeding' });
    await h.act(SID, 'details', { patient: PATIENT });
    const r = (await h.act(SID, 'hospitalReply', { kind: 'not-available' })).body;
    assert.strictEqual(r.cur.state, 'fallback');
    assert.strictEqual(r.cur.fallbackDeclined, true);
    assert.ok(r.outbox.some((o) => o.role === 'district' && /cannot confirm/.test(o.text)));
    assert.ok(!r.outbox.some((o) => o.role === 'doctor'));
  } finally { h.server.close(); }
});

test('proposal shows the real last check-in time, and an old check-in is shown as unconfirmed', async () => {
  const h = await boot();
  try {
    await h.act(SID, 'reset', {});
    await h.act(SID, 'startReferral', { typeId: 'bleeding' });
    let r = (await h.act(SID, 'details', { patient: PATIENT })).body;
    const at = r.facilities.find((f) => f.id === 'dh').checkin.at;
    assert.strictEqual(at, 1_000_000);
    const line = r.chat[r.chat.length - 1].text;
    assert.match(line, /^Last readiness check: .+, by Sister Anjali \(self-reported at the shift check-in\)\. Not yet confirmed for this case: DH Devgarh must reply\.$/);
    await h.act(SID, 'reset', {});
    h.advance(9 * 60 * 60 * 1000);
    await h.act(SID, 'checkin', { facility: 'sdh', items: {} });
    await h.act(SID, 'startReferral', { typeId: 'bleeding' });
    r = (await h.act(SID, 'details', { patient: PATIENT })).body;
    assert.match(r.chat[r.chat.length - 1].text, /more than 8 hours ago\. Treat it as unconfirmed until DH Devgarh replies/);
  } finally { h.server.close(); }
});

test('no unverified security claim on the call screen', async () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'chat.html'), 'utf8');
  assert.ok(!/end-to-end encrypted/i.test(html));
  assert.match(html, /Automated call \(demo\)/);
});
