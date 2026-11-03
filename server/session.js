/* One demo/live session = one nurse screen plus the phones around it. All routing decisions come from src/engine.js.
   Actions are async because they may send messages. They change the session object and return it. */
const crypto = require('node:crypto');
const E = require('../src/engine.js');
const D0 = require('../src/data.js');
const M = require('../src/messages.js');

const CFG = Object.assign({}, D0, { replyWindowSec: Number(process.env.REPLY_WINDOW_SEC) || D0.replyWindowSec });
const IVR_WAIT_MS = (Number(process.env.IVR_WAIT_SEC) || 60) * 1000;
const LINK_TTL_MS = 2 * 60 * 60 * 1000;
const SCENARIOS = ['confirms', 'silent', 'nobody'];

const seedFacilities = (scenario) => D0.facilities.map((f) => {
  const checkin = f.checkin ? { shift: f.checkin.shift, items: Object.assign({}, f.checkin.items) } : null;
  if (f.kind === 'hospital' && scenario === 'nobody') checkin.items.blood = false;
  return Object.assign({}, f, { checkin });
});

function blank(id, live, scenario) {
  scenario = SCENARIOS.includes(scenario) ? scenario : 'confirms';
  return { id, live: Boolean(live), scenario, facilities: seedFacilities(scenario), refs: [], cur: null,
    chat: [{ from: 'bot', text: M.T.menu }], step: 'start', outbox: [], links: {}, ivrAt: null, updatedAt: 0 };
}

const fac = (s, id) => s.facilities.find((f) => f.id === id);
const say = (s, from, text) => { s.chat.push({ from, text }); };
const eta = (f) => E.etaMinutes(f.km, CFG);
const clock = (ms) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toLowerCase();
const clean = (v, n = 60) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);

function setCur(s, r) {
  s.cur = r;
  s.refs = s.refs.some((x) => x.id === r.id) ? s.refs.map((x) => (x.id === r.id ? r : x)) : s.refs.concat([r]);
}

async function tell(s, ctx, role, label, text) {
  const r = await ctx.send(s.live, role, text);
  s.outbox.push({ at: ctx.now(), role, label, text, status: r.status, channel: r.channel, error: r.error || null });
  s.outbox = s.outbox.slice(-60);
}

function summaryLink(s, ctx, hospital) {
  const p = s.cur.patient || D0.mother;
  const token = s.id + '.' + crypto.randomBytes(8).toString('hex');
  const dest = fac(s, hospital);
  s.links[token] = { expires: ctx.now() + LINK_TTL_MS, hospital: dest.name, eta: eta(dest), ref: s.cur.id, patient: {
    name: clean(p.name), age: clean(p.age, 4), blood: clean(p.blood, 6), delivered: clean(p.time, 20),
    oxytocin: clean(p.oxy, 4), misoprostol: clean(p.miso, 4), iv: clean(p.iv, 4), mode: clean(p.mode, 20) } };
  return (ctx.baseUrl() || '') + '/s/' + token;
}

const incomingText = (s, f) => {
  const p = (s.cur && s.cur.patient) || D0.mother;
  return M.fill('incoming', { eta: eta(f), group: clean(p.blood, 6) || D0.mother.bloodGroup }) +
    ' Reply with the number. For 2, add the minutes, for example: 2 20.';
};

async function startReferral(s, ctx, a) {
  const t = D0.emergencyTypes.find((x) => x.id === a.typeId);
  if (!t) return s;
  if (!t.signed) { say(s, 'bot', M.T.typeNotSigned); return s; }
  setCur(s, E.startReferral(t.id, ctx.now()));
  s.step = 'details'; say(s, 'nurse', t.label); say(s, 'bot', M.T.details);
  return s;
}

async function details(s, ctx, a) {
  if (!s.cur || s.step !== 'details') return s;
  const p = a.patient || {};
  const patient = { name: clean(p.name), age: clean(p.age, 4), blood: clean(p.blood, 6), contact: clean(p.contact, 20), time: clean(p.time, 20),
    mode: clean(p.mode, 20), oxy: clean(p.oxy, 4), miso: clean(p.miso, 4), iv: clean(p.iv, 4) };
  s.cur = Object.assign({}, s.cur, { patient });
  say(s, 'nurse', `Details sent: ${patient.name}, ${patient.age}, ${patient.blood}, delivered ${patient.time}`);
  const r = E.propose(s.cur, s.facilities, CFG, ctx.now());
  setCur(s, r);
  if (r.state === 'fallback') await goFallback(s, ctx);
  else { const h = fac(s, r.proposal); say(s, 'bot', M.fill('proposed', { hospital: h.short, km: h.km, eta: eta(h) })); s.step = 'proposed'; }
  return s;
}

async function goFallback(s, ctx) {
  const mc = fac(s, 'mc');
  say(s, 'bot', M.T.fallback); s.step = 'close';
  await tell(s, ctx, 'mc', 'Medical college', incomingText(s, mc));
  await tell(s, ctx, 'district', 'District officer', M.fill('district', { id: s.cur.id }));
  await tell(s, ctx, 'doctor', 'Receiving doctor', 'Matri-Kavach summary (link expires in 2 hours): ' + summaryLink(s, ctx, 'mc'));
}

async function change(s, ctx) {
  if (!s.cur || s.cur.state !== 'routed') return s;
  const r = E.changeProposal(s.cur, s.facilities, CFG, ctx.now());
  setCur(s, r); const h = fac(s, r.proposal);
  say(s, 'nurse', 'CHANGE'); say(s, 'bot', M.fill('proposed', { hospital: h.short, km: h.km, eta: eta(h) }));
  return s;
}

async function send(s, ctx) {
  if (!s.cur || s.cur.state !== 'routed') return s;
  const r = E.sendTo(s.cur, ctx.now());
  setCur(s, r); s.step = 'waiting'; say(s, 'nurse', 'SEND'); say(s, 'bot', M.T.sent);
  await tell(s, ctx, r.proposal, fac(s, r.proposal).short, incomingText(s, fac(s, r.proposal)));
  return s;
}

async function afterEngine(s, ctx, prev, r, minutes) {
  if (r.state === 'confirmed') {
    const h = fac(s, r.confirmed || prev);
    const arrive = clock(ctx.now() + (minutes ? minutes : 0) * 60000 + eta(h) * 60000);
    say(s, 'bot', minutes ? M.fill('readyIn', { hospital: h.short, min: minutes, time: arrive }) : M.fill('ready', { hospital: h.short, time: arrive }));
    s.step = 'close';
    await tell(s, ctx, 'nurse', 'Nurse', minutes ? M.fill('readyIn', { hospital: h.short, min: minutes, time: arrive }) : M.fill('ready', { hospital: h.short, time: arrive }));
    await tell(s, ctx, 'doctor', 'Receiving doctor', 'Matri-Kavach summary (link expires in 2 hours): ' + summaryLink(s, ctx, h.id));
    await tell(s, ctx, 'bloodbank', 'Blood bank', M.fill('blood', { hospital: h.short }));
    await tell(s, ctx, 'family', 'Family', M.fill('family', { hospital: h.short, eta: eta(h) }));
  } else if (r.state === 'fallback') {
    await goFallback(s, ctx);
  } else if (r.state === 'sent' && r.proposal !== prev) {
    const h = fac(s, r.proposal);
    say(s, 'bot', M.fill('reroute', { hospital: h.short })); s.step = 'waiting';
    await tell(s, ctx, h.id, h.short, incomingText(s, h));
  }
}

async function hospitalReply(s, ctx, a) {
  const c = s.cur;
  if (!c || !['sent', 'ivr', 'routed'].includes(c.state)) return s;
  const kind = a.kind === 'ready-in' ? 'ready-in' : a.kind === 'not-available' ? 'not-available' : 'all-ready';
  const minutes = kind === 'ready-in' ? Math.min(240, Math.max(1, Math.round(Number(a.minutes) || 15))) : null;
  const prev = c.proposal;
  const r = E.onHospitalReply(c, prev, kind === 'ready-in' ? { kind, minutes } : { kind }, s.facilities, CFG, ctx.now());
  if (r === c) return s;
  setCur(s, r); s.ivrAt = null;
  await afterEngine(s, ctx, prev, r, minutes);
  return s;
}

async function ivrAnswer(s, ctx, a) {
  if (!s.cur || s.cur.state !== 'ivr') return s;
  const prev = s.cur.proposal;
  const r = E.onIVR(s.cur, a.answer === '1' ? '1' : 'none', s.facilities, CFG, ctx.now());
  setCur(s, r); s.ivrAt = null;
  say(s, 'bot', r.state === 'confirmed' ? `IVR: all ready. ${fac(s, prev).short} confirmed.` : 'IVR not answered.');
  await afterEngine(s, ctx, prev, r, null);
  return s;
}

async function skip(s) {
  if (!s.cur || s.cur.state !== 'sent') return s;
  setCur(s, Object.assign({}, s.cur, { timerStart: s.cur.timerStart - CFG.replyWindowSec * 1000 }));
  return s;
}

async function arrived(s, ctx, a) {
  if (!s.cur || s.step !== 'close' || s.cur.arrived) return s;
  const v = ['Yes', 'No', 'Transferred'].includes(a.value) ? a.value : null;
  if (!v) return s;
  if (v === 'Yes') { s.cur = Object.assign({}, s.cur, { arrived: 'Yes' }); setCur(s, s.cur); say(s, 'nurse', 'Yes, arrived'); say(s, 'bot', M.T.outcomeQ); return s; }
  return closeOut(s, ctx, v, null);
}

async function outcome(s, ctx, a) {
  if (!s.cur || s.cur.arrived !== 'Yes') return s;
  return closeOut(s, ctx, 'Yes', ['Delivered', 'Other'].includes(a.value) ? a.value : 'Other');
}

async function closeOut(s, ctx, arrivedV, outcomeV) {
  const r = E.onClose(Object.assign({}, s.cur, { arrived: null }), arrivedV, outcomeV, ctx.now());
  if (r.state !== 'closed') return s;
  setCur(s, r); s.step = 'done';
  say(s, 'nurse', arrivedV === 'Yes' ? 'Yes, arrived' : arrivedV);
  if (outcomeV) say(s, 'nurse', 'Outcome: ' + outcomeV);
  say(s, 'bot', M.T.closed);
  const name = clean((r.patient || D0.mother).name);
  await tell(s, ctx, 'asha', 'PHC and ASHA', M.fill('asha', { name }));
  return s;
}

async function reset(s, ctx, a) {
  const fresh = blank(s.id, s.live, a.scenario || s.scenario);
  // Summary links already sent to a doctor keep working until they expire, even after Reset.
  const links = {};
  Object.keys(s.links || {}).forEach((k) => { if (s.links[k].expires > ctx.now()) links[k] = s.links[k]; });
  Object.keys(s).forEach((k) => delete s[k]);
  Object.assign(s, fresh, { links });
  return s;
}

/* Called every second for sessions waiting on a hospital. */
async function tick(s, ctx) {
  const c = s.cur;
  if (!c) return s;
  if (c.state === 'sent') {
    const r = E.onTimeout(c, ctx.now(), CFG);
    if (r.state === 'ivr') {
      setCur(s, r); s.ivrAt = ctx.now();
      const h = fac(s, r.proposal);
      say(s, 'bot', M.fill('silent', { hospital: h.short }));
      const script = M.fill('ivrScript', { eta: eta(h) });
      const call = await ctx.call(s.live, r.proposal, r.id, script);
      s.outbox.push({ at: ctx.now(), role: r.proposal, label: 'No-reply call to ' + h.short, text: script, status: call.status, channel: call.channel || 'voice', error: call.error || null });
    }
  } else if (c.state === 'ivr' && s.live && s.ivrAt && ctx.now() - s.ivrAt > IVR_WAIT_MS) {
    return ivrAnswer(s, ctx, { answer: 'none' });
  }
  return s;
}

const ACTIONS = { startReferral, details, change, send, hospitalReply, ivrAnswer, skip, arrived, outcome, reset };

function publicView(s, now) {
  return { id: s.id, live: s.live, scenario: s.scenario, facilities: s.facilities, refs: s.refs, cur: s.cur, chat: s.chat,
    step: s.step, outbox: s.outbox.slice(-20), serverTime: now, replyWindowSec: CFG.replyWindowSec };
}

module.exports = { CFG, blank, tick, ACTIONS, publicView, clock, eta };
