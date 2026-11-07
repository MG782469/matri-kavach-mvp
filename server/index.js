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
const D = require('../src/data.js');

const ROOT = path.join(__dirname, '..');

/* On WhatsApp every message says whose phone it is for, because in the team test one phone plays every role. */
const ROLE_LABEL = {
  nurse: '👩‍⚕️ Nurse Kavitha · PHC Rampur', chc: '🏥 CHC Sonpur · labour room', dh: '🏥 DH Devgarh · labour room', sdh: '🏥 SDH Kheri · labour room',
  mc: '🏥 GMC Rajnagar · referral desk', doctor: '🩺 Doctor on call', family: '👪 Family of the mother', bloodbank: '🩸 Blood bank',
  district: '📊 District officer', asha: '🤱 ASHA Sunita', driver: '🚑 108 driver · Ambulance 1', emt: '🚑 108 EMT · Ambulance 1',
  driver2: '🚑 108 driver · Ambulance 2', emt2: '🚑 108 EMT · Ambulance 2'
};
const HELP = ['ℹ️ *Matri-Kavach on WhatsApp*: what you can type',
  '*Nurse (PHC)*',
  '• Hi: start a referral (pick the emergency from the list)',
  '• BLEED B+ or FITS O+: one-line quick referral with blood group',
  '• SEND / CHANGE: confirm or change the hospital',
  '• NEW: a second mother at the same time · CASE A / CASE B: switch',
  '• RESET: close every case and start a fresh demo night',
  '*Hospital labour room*',
  '• 1 All ready · 2 20 (ready in 20 min) · 3 Not available (add B for mother B: 1 B)',
  '• TEAM: team ready at the door · DISCHARGED: she went home',
  '• FULL / OPEN: stop or restart new referrals for 2 hours',
  '*108 EMT*',
  '• WORSE 1-5: the mother is getting worse on the way',
  '*Hospital, every shift*',
  '• CHECKIN DH (or SDH, CHC): the night shift readiness check-in',
  '*District officer*',
  '• STATUS: live dashboard · REPORT: monthly readiness report',
  'Website (dashboard, map, district view): https://matri-kavach-mvp.onrender.com'].join('\n');
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
    send: (live, role, text) => (meta.enabled() ? meta.sendText(live, notify.phoneFor(role), text, ROLE_LABEL[role])
      : telegram.enabled() ? telegram.sendText(live, role, text) : notify.sendText(live, role, text)),
    call: async (live, role, refId, text) => {
      if (live && !canCall() && meta.enabled()) return meta.sendText(live, notify.phoneFor(role), 'URGENT, no reply in 2 minutes. ' + text, ROLE_LABEL[role]);
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
  async function inbound(isRole, body, info = {}) {
    const IDLE = 'Matri-Kavach: no referral is waiting for your reply right now.';
    let reply = IDLE;
    info.role = isRole('nurse') ? 'nurse' : null;
    if (/^(help|menu|commands|\?)$/i.test(body)) { info.role = null; return HELP; }
    await withSession('live', true, async (s) => {
      /* RESET from the nurse phone: wipe every open case and start a fresh demo night (same as the Reset button). */
      if (/^(reset|restart|clear all)$/i.test(body) && isRole('nurse')) {
        await S.ACTIONS.reset(s, ctx, {});
        info.role = 'nurse';
        reply = 'Demo reset: all cases closed, fresh night. Type Hi to start a new referral.';
        return;
      }
      const c = s.cur;
      /* WhatsApp nurse: Hi first asks the language; "Add details" asks for the one-line patient details. */
      if (isRole('nurse')) {
        const lg = body.match(/^(?:lang\s*(en|hi)|(english|hindi|हिंदी|हिन्दी)(?:\s*\(hindi\))?)$/i);
        if (lg) { s.settings.lang = /^(en|english)$/i.test(lg[1] || lg[2]) ? 'en' : 'hi'; body = 'Hi'; }
        else if (S.GREETING.test(body) && (!c || s.step === 'done')) { info.role = 'nurse'; reply = M.T.langAsk; return; }
        const pickN = !c && s.step === 'start' && notify.baseUrl() && body.match(/^([1-9])$/);
        const pickT = pickN && D.emergencyTypes[Number(pickN[1]) - 1];
        if (pickT && pickT.signed) {
          info.role = 'nurse';
          await S.ACTIONS.startReferral(s, ctx, { typeId: pickT.id });
          if (s.cur && s.step === 'details') { reply = S.waFormFirst(s, ctx, notify.baseUrl()); return; }
        }
        if (c && s.step === 'details' && /^skip$/i.test(body)) { info.role = 'nurse'; reply = await S.waSkipDetails(s, ctx); return; }
        if (/^(add\s*)?details?$/i.test(body) && c) { info.role = 'nurse'; reply = notify.baseUrl() ? S.waFormLink(s, ctx, notify.baseUrl()) : S.waFormStart(s); return; }
        if (/^form$/i.test(body) && c) { info.role = 'nurse'; reply = S.waFormStart(s); return; }
        if (S.waFormOpen(s) && (S.GREETING.test(body) || /^(help|menu)$/i.test(body))) s.waForm = null;
        if (S.waFormOpen(s) && !/^(new|case\s+[a-z]|send|change)$/i.test(body)) { info.role = 'nurse'; reply = await S.waFormAnswer(s, ctx, body); return; }
      }
      /* Several mothers can be open at once: find the case this hospital is answering ("1 MK-123456" or "1 B" names one). */
      const named = S.refInText(s, body);
      const hospIds = s.facilities.filter((f) => (f.kind === 'hospital' || f.kind === 'fallback') && isRole(f.id)).map((f) => f.id);
      const caseOf = (action) => {
        for (const ref of named ? [named, null] : [null]) {
          for (const id of hospIds) {
            const x = S.refById(s, S.caseFor(s, action, { facility: id, ref }, Boolean(ref)));
            const mine = x && (action === 'hospitalReply' ? x.proposal === id || x.backup === id : (x.confirmed || x.destination) === id);
            if (mine) return { ref: x.id, facility: id };
          }
        }
        return null;
      };
      const idOf = (k) => { const r = k && S.refById(s, k.ref); return r ? ' (case ' + r.id + ')' : ''; };
      /* The 108 EMT: "WORSE 1" (or "WORSE 1 B" for mother B) tells the hospital she is getting worse. */
      const emtRole = (D.ambulances || []).map((x) => x.emt).find((r) => isRole(r));
      if (emtRole && /^(worse|w)\b/i.test(body)) {
        const n = body.match(/\b([1-5])\b/);
        const ref = S.emtCase(s, emtRole, named);
        if (!ref) { reply = 'Matri-Kavach: no mother is on the way in your ambulance right now.'; return; }
        if (!n) { reply = M.T.emtWorseAsk; return; }
        const sign = (D.worseSigns || [])[Number(n[1]) - 1];
        const k = s.outbox.length;
        info.role = emtRole;
        await S.ACTIONS.emtWorse(s, ctx, { emt: emtRole, ref, sign: sign && sign.id });
        const ok = s.outbox.slice(k).filter((o) => o.role === emtRole).pop();
        reply = ok ? ok.text : reply; if (ok && ok.status === 'sent') info.skip = true; return;
      }
      /* Shift check-in, district dashboard and monthly report by text */
      const ck = body.match(/^check-?\s?in\b\s*(chc|dh|sdh|mc)?\s*(ok|all|yes|no)?\s*([\d\s,]*)$/i);
      if (ck) {
        const order = ['dh', 'sdh', 'chc', 'mc'];
        const fid = ck[1] ? ck[1].toLowerCase() : order.find((id) => isRole(id));
        if (!fid || !isRole(fid)) { reply = 'Check-in is done from a hospital labour room phone.'; return; }
        info.role = fid;
        if (!ck[2]) { reply = S.waCheckinList(s, fid); return; }
        const missing = /^no$/i.test(ck[2]) ? (ck[3].match(/\d+/g) || []) : [];
        await S.waCheckin(s, ctx, { facility: fid, missing });
        info.skip = true; reply = ''; return;
      }
      if (/^(status|dashboard)$/i.test(body)) { info.role = isRole('district') ? 'district' : null; reply = S.waStatus(s, ctx); return; }
      if (/^report$/i.test(body) && isRole('district')) { await S.ACTIONS.monthlyReport(s, ctx, {}); info.skip = true; reply = ''; return; }
      const tc = /^team\b/i.test(body) && caseOf('teamReady');
      if (tc) { info.role = tc.facility; await S.ACTIONS.teamReady(s, ctx, tc); reply = 'Recorded: team ready at the door' + idOf(tc) + '. The PHC and the 108 EMT have been told.'; return; }
      const dc = /^disch/i.test(body) && caseOf('discharge');
      if (dc) { info.role = dc.facility; await S.ACTIONS.discharge(s, ctx, dc); reply = 'Recorded: discharged home' + idOf(dc) + '. The PHC and ASHA have the back-referral.'; return; }
      const fc = /^[123]\b/.test(body) && caseOf('feedback');
      if (fc) { info.role = fc.facility; await S.ACTIONS.feedback(s, ctx, Object.assign({ value: body[0] }, fc)); reply = 'Thank you. Your feedback was sent to the PHC.'; return; }
      const hosp = s.facilities.find((f) => f.kind === 'hospital' && isRole(f.id));
      if (hosp && /^(full|open)\b/i.test(body)) info.role = hosp.id;
      if (hosp && /^full\b/i.test(body)) { await S.ACTIONS.setFull(s, ctx, { facility: hosp.id, on: true }); reply = hosp.full ? 'Recorded: FULL for 2 hours. Reply OPEN when you can take patients again.' : 'Please answer the referral first: reply 3 if you cannot take her.'; return; }
      if (hosp && /^open\b/i.test(body)) { await S.ACTIONS.setFull(s, ctx, { facility: hosp.id, on: false }); reply = 'Recorded: open for referrals again.'; return; }
      const drillFor = s.drill && !s.drill.done && s.drill.ids.find((id) => s.drill.replies[id] == null && isRole(id));
      if (drillFor && /^1\b/.test(body) && !(c && ['sent', 'ivr', 'routed'].includes(c.state))) { await S.ACTIONS.drillReply(s, ctx, { facility: drillFor }); reply = 'Drill reply recorded. Thank you.'; return; }
      if (isRole('nurse') && (!c || ['done', 'proposed', 'close', 'callback'].includes(s.step) || /^(new|case\s+[a-z]|bleed|pph|fits?|ecl)\b/i.test(body) || (c && S.isDetailsText(body)))) {
        const n = s.chat.length;
        await S.ACTIONS.nurseText(s, ctx, { text: body });
        const bot = s.chat.slice(n).filter((m) => m.from === 'bot').map((m) => m.text);
        const next = s.step === 'close' ? S.closePrompt(s) : null;
        reply = (next && !bot.includes(next) ? bot.concat([next]) : bot).join('\n') || reply;
        if (s.step === 'close' || s.step === 'done' || !c || bot.length) return;
      }
      const hc = caseOf('hospitalReply');
      if (hc) {
        info.role = hc.facility;
        const hr = S.refById(s, hc.ref);
        const asked = hc.facility;
        const isBackup = asked !== hr.proposal;
        const tag = idOf(hc);
        const args = (x) => Object.assign({ facility: asked, ref: hc.ref }, x);
        if (/^1/.test(body)) { await S.ACTIONS.hospitalReply(s, ctx, args({ kind: 'all-ready' })); reply = isBackup ? 'Thank you. Recorded: ready, as backup' + tag + '. The nearer hospital has priority; we will tell you.' : 'Thank you. Recorded: ALL READY' + tag + '.'; }
        else if (/^3/.test(body)) { await S.ACTIONS.hospitalReply(s, ctx, args({ kind: 'not-available' })); reply = isBackup ? 'Recorded: not available' + tag + '.' : 'Recorded: not available' + tag + '. We are rerouting.'; }
        else if (/^2/.test(body)) {
          const m = body.match(/\d+/g);
          const minutes = m && m[1] ? Number(m[1]) : null;
          if (!minutes) reply = 'Please send 2 and the minutes, for example: 2 20';
          else { await S.ACTIONS.hospitalReply(s, ctx, args({ kind: 'ready-in', minutes })); reply = `Recorded: ready in ${minutes} min${tag}.`; }
        } else reply = 'Reply 1 (all ready), 2 and minutes such as 2 20 (ready later), or 3 (not available). If two mothers are coming, add the case letter, for example: 1 B.';
      }
      /* Nothing matched: tell a hospital or an unknown number what this phone is for, instead of a bare "nothing waiting". */
      if (reply === IDLE && !isRole('nurse')) {
        const h = s.facilities.find((f) => (f.kind === 'hospital' || f.kind === 'fallback') && isRole(f.id));
        if (h) { info.role = h.id; reply = 'This phone is the labour room of ' + h.short + '. No referral is waiting for you right now. When a PHC nurse sends a mother, the request and the reply buttons come here. Type CHECKIN to update tonight\'s readiness, or HELP.'; }
        else if (!Object.keys(ROLE_LABEL).some((r) => isRole(r))) reply = 'Matri-Kavach demo: this number has no role yet. Ask the team to add it (nurse, hospital or 108), or try the web demo at ' + (notify.baseUrl() || 'the Matri-Kavach site') + '/chat';
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
    if (!meta.validSignature(req)) { console.log('meta webhook: bad signature'); return res.sendStatus(403); }
    res.sendStatus(200);
    const msgs = meta.incoming(req.body);
    const fields = ((req.body && req.body.entry) || []).flatMap((e) => (e.changes || []).map((c) => c.field)).join(',');
    console.log('meta webhook: field=' + (fields || '-') + ' messages=' + msgs.length + msgs.map((m) => ' from=..' + String(m.from).slice(-4)).join(''));
    for (const m of msgs) {
      try {
        const info = {};
        const reply = await inbound((role) => notify.sameNumber(notify.phoneFor(role), m.from), m.text, info);
        if (!info.skip) await meta.sendTo(m.from, reply, info.role ? ROLE_LABEL[info.role] : null);
        console.log('meta reply sent to ..' + String(m.from).slice(-4));
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
    const c = s && ((s.refs || []).find((r) => r.id === String(req.query.ref || '')) || s.cur);
    const h = c && s.facilities.find((f) => f.id === c.proposal);
    const text = h ? S.ivrText(s, h) : 'Matri-Kavach. No referral is waiting.';
    const action = notify.baseUrl() + '/twilio/voice-gather?ref=' + encodeURIComponent(String(req.query.ref || ''));
    twiml(res, `<Gather numDigits="1" timeout="10" action="${esc(action)}" method="POST"><Say voice="alice" language="en-IN">${esc(text)}</Say></Gather><Say>No input received. Goodbye.</Say>`);
  });

  async function ivrFor(ref, answer) {
    await withSession('live', true, async (s) => {
      const r = (s.refs || []).find((x) => x.id === ref);
      if (r && r.state === 'ivr') await S.ACTIONS.ivrAnswer(s, ctx, { answer, ref });
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
  /* Patient details form opened from the WhatsApp "Open form" button (live session only). */
  const formPage = (res, title, body, status) => res.status(status || 200).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
    body{font-family:Arial,sans-serif;margin:0;background:#f5f7fa;color:#232f3e}main{max-width:480px;margin:0 auto;padding:18px 16px 40px}
    h1{color:#1f3da9;font-size:20px;margin:0 0 4px}.sub{color:#5d6a79;font-size:13px;margin:0 0 14px}
    label{display:block;font-size:13px;color:#5d6a79;margin:10px 0 0}input,select{display:block;width:100%;box-sizing:border-box;font-size:16px;padding:10px;border:1px solid #c9d1db;border-radius:8px;background:#fff;color:#232f3e;margin-top:4px}
    .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.two label{margin-top:10px}
    button{width:100%;font-size:16px;padding:13px;border-radius:10px;border:0;margin-top:14px;cursor:pointer}
    .go{background:#1f3da9;color:#fff;font-weight:bold}.alt{background:#fff;border:1px solid #c9d1db;color:#232f3e;text-align:left}.alt small{display:block;color:#5d6a79;font-size:12px}
    .ok{background:#e8f6ee;border:1px solid #9dd4b1;border-radius:10px;padding:14px;white-space:pre-line}</style></head><body><main>${body}</main></body></html>`);
  app.get('/f/:token', async (req, res) => {
    const token = String(req.params.token);
    if (!/^live\.f[a-f0-9]{16}$/.test(token)) return formPage(res, 'Link not found', '<h1>Link not found</h1>', 404);
    let v = null;
    await withSession('live', true, async (s) => { v = await S.formView(s, ctx, token); return undefined; });
    if (!v) return formPage(res, 'Link expired', '<h1>Link expired</h1><p class="sub">This form link was valid for 2 hours. Tap Add details in WhatsApp again.</p>', 410);
    const field = (q) => q.options
      ? `<label>${esc(q.label)}<select name="${esc(q.id)}">${q.options.map((o) => `<option${o === q.value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`
      : `<label>${esc(q.label)}<input name="${esc(q.id)}" value="${esc(q.value)}" autocomplete="off"></label>`;
    const by = Object.fromEntries(v.qs.map((q) => [q.id, q]));
    const head = ['name', 'age', 'blood', 'contact', 'abha', 'informed'];
    const rest = v.qs.filter((q) => !head.includes(q.id)).map(field);
    let pairs = ''; for (let i = 0; i < rest.length; i += 2) pairs += rest[i + 1] ? `<div class="two">${rest[i]}${rest[i + 1]}</div>` : rest[i];
    formPage(res, 'Patient details', `<h1>Patient details: ${esc(v.type)}</h1><p class="sub">Case ${esc(v.id)}${v.tag ? ' (Mother ' + esc(v.tag) + ')' : ''}. Facts only. Yes / No / Unknown, never a guess.</p>
      <form method="post">${field(by.name)}<div class="two">${field(by.age)}${field(by.blood)}</div>${field(by.contact)}${field(by.abha)}${pairs}${field(by.informed)}
      <button type="button" class="alt" onclick="document.querySelectorAll('input').forEach(function(i){i.value=''})">Clear the form<small>Type your own values instead of the demo ones</small></button>
      <button class="go" type="submit">Send</button></form>`);
  });
  app.post('/f/:token', async (req, res) => {
    const token = String(req.params.token);
    if (!/^live\.f[a-f0-9]{16}$/.test(token)) return formPage(res, 'Link not found', '<h1>Link not found</h1>', 404);
    let text = null;
    await withSession('live', true, async (s) => { text = await S.formSubmit(s, ctx, token, req.body || {}); return text ? s : undefined; });
    if (!text) return formPage(res, 'Link expired', '<h1>Link expired</h1><p class="sub">Tap Add details in WhatsApp again.</p>', 410);
    if (meta.enabled() && notify.phoneFor('nurse')) await meta.sendTo(notify.phoneFor('nurse'), text, ROLE_LABEL.nurse).catch((e) => console.error('form reply failed', e.message));
    formPage(res, 'Details sent', `<h1>✅ Details sent</h1><div class="ok">${esc(text)}</div><p class="sub">Go back to WhatsApp. You can open this form again to correct anything.</p>`);
  });

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
  app.get('/privacy', (req, res) => res.sendFile(path.join(ROOT, 'privacy.html')));
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
