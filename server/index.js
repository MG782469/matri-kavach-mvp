/* Matri-Kavach MVP server: serves the web app, keeps sessions in Postgres, runs the 120-second timers,
   and talks to Twilio (WhatsApp, voice). Synthetic data only. */
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const makeStore = require('./store.js');
const notify = require('./notify.js');
const S = require('./session.js');
const M = require('../src/messages.js');

const ROOT = path.join(__dirname, '..');
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function createApp(opts = {}) {
  const store = opts.store || makeStore(process.env.DATABASE_URL);
  const ctx = opts.ctx || {
    now: () => Date.now(),
    send: notify.sendText,
    call: notify.placeCall,
    baseUrl: notify.baseUrl
  };
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  /* One request at a time per session, so a webhook and a tap cannot overwrite each other. */
  const locks = new Map();
  function withSession(id, live, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      let s = await store.get(id);
      if (!s) s = S.blank(id, live);
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

  app.get('/api/health', (req, res) => res.json({ ok: true, db: Boolean(process.env.DATABASE_URL), twilio: notify.configured(), liveEnabled: Boolean(process.env.LIVE_KEY) }));

  app.get('/api/state', limited, async (req, res) => {
    const sid = resolveSid(req);
    if (!sid) return res.status(403).json({ error: 'Bad session or live key' });
    const s = await withSession(sid, sid === 'live', async () => undefined);
    res.json(S.publicView(s, ctx.now()));
  });

  app.post('/api/act', limited, async (req, res) => {
    const sid = resolveSid(req);
    const act = S.ACTIONS[String(req.body.action || '')];
    if (!sid) return res.status(403).json({ error: 'Bad session or live key' });
    if (!act) return res.status(400).json({ error: 'Unknown action' });
    try {
      const s = await withSession(sid, sid === 'live', (sess) => act(sess, ctx, req.body.args || {}));
      res.json(S.publicView(s, ctx.now()));
    } catch (e) {
      console.error('act failed', e);
      res.status(500).json({ error: 'Something went wrong. Try Reset.' });
    }
  });

  /* ---- Twilio webhooks (live session only) ---- */
  const twiml = (res, inner) => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response>' + (inner || '') + '</Response>');
  const guard = (req, res, next) => (notify.validSignature(req) ? next() : res.status(403).send('Bad signature'));

  app.post('/twilio/whatsapp', guard, async (req, res) => {
    const from = req.body.From || '';
    const body = String(req.body.Body || '').trim();
    let reply = 'Matri-Kavach: no referral is waiting for your reply right now.';
    await withSession('live', true, async (s) => {
      const c = s.cur;
      if (!c) return;
      if (['sent', 'ivr', 'routed'].includes(c.state) && notify.sameNumber(notify.phoneFor(c.proposal), from)) {
        if (/^1/.test(body)) { await S.ACTIONS.hospitalReply(s, ctx, { kind: 'all-ready' }); reply = 'Thank you. Recorded: ALL READY.'; }
        else if (/^3/.test(body)) { await S.ACTIONS.hospitalReply(s, ctx, { kind: 'not-available' }); reply = 'Recorded: not available. We are rerouting.'; }
        else if (/^2/.test(body)) {
          const m = body.match(/\d+/g);
          const minutes = m && m[1] ? Number(m[1]) : null;
          if (!minutes) reply = 'Please send 2 and the minutes, for example: 2 20';
          else { await S.ACTIONS.hospitalReply(s, ctx, { kind: 'ready-in', minutes }); reply = `Recorded: ready in ${minutes} min.`; }
        } else reply = 'Reply 1 (all ready), 2 and minutes such as 2 20 (ready later), or 3 (not available).';
      } else if (['confirmed', 'fallback'].includes(c.state) && notify.sameNumber(notify.phoneFor('nurse'), from)) {
        if (!c.arrived) {
          const v = { 1: 'Yes', 2: 'No', 3: 'Transferred' }[body[0]];
          if (v) { await S.ACTIONS.arrived(s, ctx, { value: v }); reply = v === 'Yes' ? M.T.outcomeQ : M.T.closed; }
          else reply = M.T.closeQ;
        } else {
          const v = { 1: 'Delivered', 2: 'Other' }[body[0]];
          if (v) { await S.ACTIONS.outcome(s, ctx, { value: v }); reply = M.T.closed; } else reply = M.T.outcomeQ;
        }
      }
    });
    twiml(res, '<Message>' + esc(reply) + '</Message>');
  });

  app.all('/twilio/voice', guard, async (req, res) => {
    const s = await store.get('live');
    const c = s && s.cur;
    const h = c && s.facilities.find((f) => f.id === c.proposal);
    const text = h ? M.fill('ivrScript', { eta: S.eta(h) }) : 'Matri-Kavach. No referral is waiting.';
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
    const page = (title, body) => res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font-family:Arial,sans-serif;margin:0;background:#f5f7fa;color:#232f3e}main{max-width:480px;margin:0 auto;padding:20px 16px}h1{color:#1f3da9;font-size:20px}.c{background:#fff;border:1px solid #d9dee5;border-radius:10px;padding:14px;margin:12px 0}dt{color:#5d6a79;font-size:13px;margin-top:8px}dd{margin:0;font-size:16px}.n{color:#5d6a79;font-size:12px}</style></head><body><main>${body}</main></body></html>`);
    if (!l) return page('Link not found', '<h1>Link not found</h1><p>This summary link does not exist.</p>');
    if (ctx.now() > l.expires) return res.status(410).type('html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired</title><body style="font-family:Arial;padding:20px"><h1 style="color:#1f3da9">Link expired</h1><p>This summary link was valid for 2 hours and has expired.</p>');
    const p = l.patient;
    page('Referral summary', `<h1>Referral summary</h1><div class="c"><dl>
      <dt>Patient</dt><dd>${esc(p.name)}, ${esc(p.age)} years</dd>
      <dt>Blood group</dt><dd>${esc(p.blood)}</dd>
      <dt>Delivery</dt><dd>${esc(p.mode)}, ${esc(p.delivered)}</dd>
      <dt>Given before transfer</dt><dd>Oxytocin: ${esc(p.oxytocin)}. Misoprostol: ${esc(p.misoprostol)}. IV line: ${esc(p.iv)}</dd>
      <dt>Going to</dt><dd>${esc(l.hospital)}, about ${esc(l.eta)} min</dd></dl></div>
      <p class="n">Facts only, no diagnosis. Synthetic demo data. Link expires ${esc(new Date(l.expires).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }))} IST.</p>`);
  });

  /* ---- Static web app ---- */
  app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
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

  return { app, store, runTick };
}

async function main() {
  const { app, store, runTick } = createApp();
  await store.init();
  const timer = setInterval(runTick, 1000);
  const port = Number(process.env.PORT) || 3000;
  const server = app.listen(port, () => console.log(`Matri-Kavach listening on ${port}. db=${Boolean(process.env.DATABASE_URL)} twilio=${notify.configured()} live=${Boolean(process.env.LIVE_KEY)}`));
  process.on('SIGTERM', () => { clearInterval(timer); server.close(() => process.exit(0)); });
}

module.exports = { createApp };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
