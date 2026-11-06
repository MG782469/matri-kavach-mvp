/* Matri-Kavach MVP server: serves the web app, keeps sessions in Postgres, runs the 120-second timers,
   and talks to Twilio (WhatsApp, voice). Synthetic data only. */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const makeStore = require('./store.js');
const notify = require('./notify.js');
const { createTelegram } = require('./telegram.js');
const { createMeta } = require('./meta.js');
const S = require('./session.js');
const M = require('../src/messages.js');

const ROOT = path.join(__dirname, '..');
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createApp(opts = {}) {
  const store = opts.store || makeStore(process.env.DATABASE_URL);
  const telegram = opts.telegram || createTelegram(store);
  const meta = opts.meta || createMeta();
  /* Texts go by Telegram when a bot token is set, otherwise by Twilio WhatsApp.
     The no-reply call is a Twilio voice call when a Twilio number is set; on Telegram without one, an URGENT second message stands in for it. */
  const canCall = () => notify.configured() && Boolean(process.env.TWILIO_SMS_FROM);
  const ctx = opts.ctx || {
    now: () => Date.now(),
    send: (live, role, text) => (meta.enabled() ? meta.sendText(live, notify.phoneFor(role), text)
      : telegram.enabled() ? telegram.sendText(live, role, text) : notify.sendText(live, role, text)),
    call: async (live, role, refId, text) => {
      if (live && !canCall() && meta.enabled()) return meta.sendText(live, notify.phoneFor(role), 'URGENT, no reply in 2 minutes. ' + text);
      if (live && !canCall() && telegram.enabled()) return telegram.sendText(live, role, 'URGENT, no reply in 2 minutes. ' + text);
      return Object.assign({ channel: 'voice' }, await notify.placeCall(live, role, refId));
    },
    sms: (live, role, text) => notify.sendSms(live, role, text),
    baseUrl: notify.baseUrl
  };
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  /* One request at a time per session, so a webhook and a tap cannot overwrite each other. */
  const locks = new Map();
  function withSession(id, live, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      let s = await store.get(id);
      if (!s) s = S.blank(id, live, undefined, ctx.now());
      const out = await fn(s);
      await store.put(s);
      return out === undefined ? s : out;
    });
    locks.set(id, run);
    run.catch(() => {}).then(() => { if (locks.get(id) === run) locks.delete(id); });
    return run;
  }

  const liveKeyOk = (k) => {
    const want = process.env.LIVE_KEY;
    if (!want || !k) return false;
    const a = Buffer.from(String(k)); const b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  function resolveSid(req) {
    const sid = String((req.body && req.body.sid) || req.query.sid || '');
    if (sid === 'live') return liveKeyOk(req.get('x-live-key') || (req.body && req.body.key) || req.query.key) ? 'live' : null;
    return /^[a-f0-9]{16}$/.test(sid) ? sid : null;
  }

  const hits = new Map();
  setInterval(() => hits.clear(), 60000).unref();
  const limited = (req, res, next) => {
    const n = (hits.get(req.ip) || 0) + 1; hits.set(req.ip, n);
    if (n > 240) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    next();
  };

  app.get('/api/health', (req, res) => res.json({ ok: true, db: Boolean(process.env.DATABASE_URL), twilio: notify.configured(), whatsappMeta: meta.enabled(), telegram: telegram.enabled(), liveEnabled: Boolean(process.env.LIVE_KEY) }));

  app.get('/api/state', limited, async (req, res) => {
    const sid = resolveSid(req);
    if (!sid) return res.status(403).json({ error: 'Bad session or live key' });
    const s = await withSession(sid, sid === 'live', async () => undefined);
    const role = S.roleOf(s, ctx, req.get('x-role-token'));
    if (req.get('x-role-token') && !role) return res.status(401).json({ error: 'Login expired. Log in again.' });
    const view = S.roleView(S.publicView(s, ctx.now()), role);
    if (sid === 'live') { view.telegram = meta.enabled() ? null : telegram.links(); view.metaVerifyToken = meta.verifyToken(); }
    res.json(view);
  });

  app.post('/api/act', limited, async (req, res) => {
    const sid = resolveSid(req);
    const act = S.ACTIONS[String(req.body.action || '')];
    if (!sid) return res.status(403).json({ error: 'Bad session or live key' });
    if (!act) return res.status(400).json({ error: 'Unknown action' });
    try {
      const token = req.get('x-role-token');
      let role = null, denied = false;
      const s = await withSession(sid, sid === 'live', (sess) => {
        role = S.roleOf(sess, ctx, token);
        if ((token && !role) || !S.allowed(sess, role, String(req.body.action), req.body.args || {})) { denied = true; return undefined; }
        return act(sess, ctx, req.body.args || {});
      });
      if (denied) return res.status(403).json({ error: token && !role ? 'Login expired. Log in again.' : 'This role cannot do that.' });
      res.json(S.roleView(S.publicView(s, ctx.now()), role));
    } catch (e) {
      console.error('act failed', e);
      res.status(500).json({ error: 'Something went wrong. Try Reset.' });
    }
  });

  /* ---- Role login (demo RBAC): the code is shown on screen instead of an SMS ---- */
  app.post('/api/login', limited, async (req, res) => {
    const sid = resolveSid(req);
    if (!sid) return res.status(403).json({ error: 'Bad session or live key' });
    let out = null;
    await withSession(sid, sid === 'live', async (s) => { out = S.loginStart(s, ctx, req.body.phone); });
    if (!out) return res.status(404).json({ error: 'This number is not registered for a role.' });
    res.json(out);
  });
  app.post('/api/verify', limited, async (req, res) => {
    const sid = resolveSid(req);
    if (!sid) return res.status(403).json({ error: 'Bad session or live key' });
    let out = null;
    await withSession(sid, sid === 'live', async (s) => { out = S.loginVerify(s, ctx, req.body.phone, req.body.code); });
    if (!out) return res.status(401).json({ error: 'Wrong or expired code.' });
    res.json(out);
  });

  /* ---- Twilio webhooks (live session only) ---- */
  const twiml = (res, inner) => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response>' + (inner || '') + '</Response>');
  const guard = (req, res, next) => (notify.validSignature(req) ? next() : res.status(403).send('Bad signature'));

  /* A reply from a phone, by WhatsApp or Telegram. isRole(role) says whether the sender plays that role. */
  async function inbound(isRole, body) {
    let reply = 'Matri-Kavach: no referral is waiting for your reply right now.';
    await withSession('live', true, async (s) => {
      const c = s.cur;
      const dest = c && (c.confirmed || c.destination);
      if (dest && isRole(dest) && /^team\b/i.test(body)) { await S.ACTIONS.teamReady(s, ctx); reply = 'Recorded: team ready at the door. The PHC and the 108 EMT have been told.'; return; }
      if (dest && isRole(dest) && /^disch/i.test(body)) { await S.ACTIONS.discharge(s, ctx); reply = 'Recorded: discharged home. The PHC and ASHA have the back-referral.'; return; }
      if (dest && isRole(dest) && c.dischargedAt && !c.feedback && /^[123]\b/.test(body)) { await S.ACTIONS.feedback(s, ctx, { value: body[0] }); reply = 'Thank you. Your feedback was sent to the PHC.'; return; }
      const hosp = s.facilities.find((f) => f.kind === 'hospital' && isRole(f.id));
      if (hosp && /^full\b/i.test(body)) { await S.ACTIONS.setFull(s, ctx, { facility: hosp.id, on: true }); reply = hosp.full ? 'Recorded: FULL for 2 hours. Reply OPEN when you can take patients again.' : 'Please answer the referral first: reply 3 if you cannot take her.'; return; }
      if (hosp && /^open\b/i.test(body)) { await S.ACTIONS.setFull(s, ctx, { facility: hosp.id, on: false }); reply = 'Recorded: open for referrals again.'; return; }
      const drillFor = s.drill && !s.drill.done && s.drill.ids.find((id) => s.drill.replies[id] == null && isRole(id));
      if (drillFor && /^1\b/.test(body) && !(c && ['sent', 'ivr', 'routed'].includes(c.state))) { await S.ACTIONS.drillReply(s, ctx, { facility: drillFor }); reply = 'Drill reply recorded. Thank you.'; return; }
      if (isRole('nurse') && (!c || ['done', 'proposed', 'close', 'callback'].includes(s.step))) {
        const n = s.chat.length;
        await S.ACTIONS.nurseText(s, ctx, { text: body });
        const bot = s.chat.slice(n).filter((m) => m.from === 'bot').map((m) => m.text);
        const next = s.step === 'close' ? S.closePrompt(s) : null;
        reply = (next && !bot.includes(next) ? bot.concat([next]) : bot).join('\n') || reply;
        if (s.step === 'close' || s.step === 'done' || !c || bot.length) return;
      }
      if (!c) return;
      const asked = ['sent', 'ivr', 'routed', 'fallback'].includes(c.state) && isRole(c.proposal) ? c.proposal
        : ['sent', 'ivr'].includes(c.state) && c.backup && !c.backupYes && isRole(c.backup) ? c.backup : null;
      if (asked) {
        const isBackup = asked !== c.proposal;
        if (/^1/.test(body)) { await S.ACTIONS.hospitalReply(s, ctx, { kind: 'all-ready', facility: asked }); reply = isBackup ? 'Thank you. Recorded: ready, as backup. The nearer hospital has priority; we will tell you.' : 'Thank you. Recorded: ALL READY.'; }
        else if (/^3/.test(body)) { await S.ACTIONS.hospitalReply(s, ctx, { kind: 'not-available', facility: asked }); reply = isBackup ? 'Recorded: not available.' : 'Recorded: not available. We are rerouting.'; }
        else if (/^2/.test(body)) {
          const m = body.match(/\d+/g);
          const minutes = m && m[1] ? Number(m[1]) : null;
          if (!minutes) reply = 'Please send 2 and the minutes, for example: 2 20';
          else { await S.ACTIONS.hospitalReply(s, ctx, { kind: 'ready-in', minutes, facility: asked }); reply = `Recorded: ready in ${minutes} min.`; }
        } else reply = 'Reply 1 (all ready), 2 and minutes such as 2 20 (ready later), or 3 (not available).';
      }
    });
    return reply;
  }

  app.post('/twilio/whatsapp', guard, async (req, res) => {
    const from = req.body.From || '';
    const reply = await inbound((role) => notify.sameNumber(notify.phoneFor(role), from), String(req.body.Body || '').trim());
    twiml(res, '<Message>' + esc(reply) + '</Message>');
  });

  /* Meta WhatsApp Cloud API webhook: GET is the one-time check when you add the URL, POST carries messages. */
  app.get('/meta/webhook', (req, res) => {
    const vt = meta.verifyToken();
    if (req.query['hub.mode'] === 'subscribe' && vt && req.query['hub.verify_token'] === vt) return res.type('text/plain').send(String(req.query['hub.challenge'] || ''));
    res.sendStatus(403);
  });
  app.post('/meta/webhook', async (req, res) => {
    if (!meta.validSignature(req)) return res.sendStatus(403);
    res.sendStatus(200);
    for (const m of meta.incoming(req.body)) {
      try {
        const reply = await inbound((role) => notify.sameNumber(notify.phoneFor(role), m.from), m.text);
        await meta.sendTo(m.from, reply);
      } catch (e) { console.error('meta webhook failed', e.message); }
    }
  });

  app.post('/telegram/webhook', async (req, res) => {
    if (!telegram.enabled() || req.get('x-telegram-bot-api-secret-token') !== telegram.secret) return res.sendStatus(403);
    res.sendStatus(200);
    const m = req.body && req.body.message;
    if (!m || !m.chat || typeof m.text !== 'string') return;
    const text = m.text.trim();
    try {
      if (/^\/start\b/.test(text)) return void await telegram.reply(m.chat.id, await telegram.join(m.chat.id, m.from && m.from.first_name, text.split(/\s+/)[1]));
      const roles = await telegram.rolesForChat(m.chat.id);
      if (!roles.length) return void await telegram.reply(m.chat.id, 'This phone is not connected. Open the Telegram link on the Matri-Kavach live page.');
      await telegram.reply(m.chat.id, await inbound((role) => roles.includes(role), text));
    } catch (e) { console.error('telegram webhook failed', e.message); }
  });

  app.all('/twilio/voice', guard, async (req, res) => {
    const s = await store.get('live');
    const c = s && s.cur;
    const h = c && s.facilities.find((f) => f.id === c.proposal);
    const text = h ? S.ivrText(s, h) : 'Matri-Kavach. No referral is waiting.';
    const action = notify.baseUrl() + '/twilio/voice-gather?ref=' + encodeURIComponent(String(req.query.ref || ''));
    twiml(res, `<Gather numDigits="1" timeout="10" action="${esc(action)}" method="POST"><Say voice="alice" language="en-IN">${esc(text)}</Say></Gather><Say>No input received. Goodbye.</Say>`);
  });

  async function ivrFor(ref, answer) {
    await withSession('live', true, async (s) => {
      if (s.cur && s.cur.id === ref && s.cur.state === 'ivr') await S.ACTIONS.ivrAnswer(s, ctx, { answer });
    });
  }
  app.post('/twilio/voice-gather', guard, async (req, res) => {
    await ivrFor(String(req.query.ref || ''), req.body.Digits === '1' ? '1' : 'none');
    twiml(res, '<Say>Thank you. Goodbye.</Say>');
  });
  app.post('/twilio/voice-status', guard, async (req, res) => {
    if (['no-answer', 'busy', 'failed', 'canceled', 'completed'].includes(req.body.CallStatus)) await ivrFor(String(req.query.ref || ''), 'none');
    res.sendStatus(204);
  });

  /* ---- Doctor summary link: facts only, expires in 2 hours ---- */
  app.get('/s/:token', async (req, res) => {
    const token = String(req.params.token);
    const sid = token.split('.')[0];
    const s = /^([a-f0-9]{16}|live)$/.test(sid) ? await store.get(sid) : null;
    const l = s && s.links && s.links[token];
    const page = (title, body) => res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:Arial,sans-serif;margin:0;background:#f5f7fa;color:#232f3e}main{max-width:480px;margin:0 auto;padding:20px 16px}h1{color:#1f3da9;font-size:20px}h2{font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:#1f3da9;margin:0 0 4px}.c{background:#fff;border:1px solid #d9dee5;border-radius:10px;padding:14px;margin:12px 0}dt{color:#5d6a79;font-size:13px;margin-top:8px}dd{margin:0;font-size:16px}.n{color:#5d6a79;font-size:12px}</style></head><body><main>${body}</main></body></html>`);
    if (!l) return page('Link not found', '<h1>Link not found</h1><p>This summary link does not exist.</p>');
    if (ctx.now() > l.expires) return res.status(410).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired</title><body style="font-family:Arial;padding:20px"><h1 style="color:#1f3da9">Link expired</h1><p>This summary link was valid for 2 hours and has expired.</p>');
    const p = l.patient;
    const facts = (l.facts || []).map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value) || 'Not recorded'}</dd>`).join('');
    page('Referral summary', `<h1>Referral handover (ISBAR)</h1>
      <div class="c"><h2>I · Identify</h2><dl><dt>From</dt><dd>${esc(l.from || 'PHC nurse')}, referral ${esc(l.ref || '')}</dd><dt>Patient</dt><dd>${esc(p.name)}, ${esc(p.age)}${/^\d+$/.test(String(p.age)) ? ' years' : ''}</dd></dl></div>
      <div class="c"><h2>S · Situation</h2><dl><dt>Emergency (chosen by nurse)</dt><dd>${esc(l.type || '')}</dd><dt>Going to</dt><dd>${esc(l.hospital)}, about ${esc(l.eta)} min</dd></dl></div>
      <div class="c"><h2>B · Background</h2><dl><dt>Blood group</dt><dd>${esc(p.blood)}</dd>${p.abha ? `<dt>ABHA number (given by nurse, not verified: ABDM link is a mock in this demo)</dt><dd>${esc(p.abha)}</dd>` : ''}<dt>Family told details go to the hospital</dt><dd>${esc(l.informed || 'Not recorded')}</dd></dl></div>
      <div class="c"><h2>A · Nurse facts</h2><dl>${facts || '<dd>Not sent yet</dd>'}</dl></div>
      <div class="c"><h2>R · Request</h2><p>${l.needs ? 'Please have ready: ' + esc(l.needs) + '.' : 'Please be ready at the labour room door.'} Reply on the labour room phone if anything is missing.</p></div>
      ${l.review ? `<p class="n">Checklist: ${esc(l.review)}.</p>` : ''}<p class="n">Facts only, no diagnosis. Synthetic demo data. Link expires ${esc(new Date(l.expires).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }))} IST.</p>`);
  });

  /* ---- Static web app ---- */
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
  app.get('/chat', (req, res) => res.sendFile(path.join(ROOT, 'chat.html')));
  app.get('/styles.css', (req, res) => res.sendFile(path.join(ROOT, 'styles.css')));
  app.use('/src', express.static(path.join(ROOT, 'src')));

  /* ---- Server-side timers: 120-second reply window, IVR wait ---- */
  let ticking = false;
  async function runTick() {
    if (ticking) return; ticking = true;
    try {
      for (const a of await store.active()) {
        await withSession(a.id, a.live, (s) => S.tick(s, ctx));
      }
    } catch (e) { console.error('tick failed', e.message); } finally { ticking = false; }
  }

  return { app, store, runTick, telegram };
}

async function main() {
  const { app, store, runTick, telegram } = createApp();
  await store.init();
  telegram.setup(notify.baseUrl()).then(() => telegram.enabled() && console.log('Telegram webhook set')).catch((e) => console.error('Telegram setup failed', e.message));
  const timer = setInterval(runTick, 1000);
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`Matri-Kavach listening on ${port}. db=${Boolean(process.env.DATABASE_URL)} twilio=${notify.configured()} live=${Boolean(process.env.LIVE_KEY)}`));
  process.on('SIGTERM', () => { clearInterval(timer); server.close(() => process.exit(0)); });
}

module.exports = { createApp };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
