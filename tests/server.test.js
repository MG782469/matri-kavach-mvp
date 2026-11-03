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
