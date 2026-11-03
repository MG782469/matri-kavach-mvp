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
