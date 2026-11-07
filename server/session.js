/* One demo/live session = one nurse screen plus the phones around it. All routing decisions come from src/engine.js.
   Actions are async because they may send messages. They change the session object and return it. */
const crypto = require('node:crypto');
const E = require('../src/engine.js');
const D0 = require('../src/data.js');
const M = require('../src/messages.js');

const CFG = Object.assign({}, D0, { replyWindowSec: Number(process.env.REPLY_WINDOW_SEC) || D0.replyWindowSec });
const IVR_WAIT_MS = (Number(process.env.IVR_WAIT_SEC) || 60) * 1000;
const LINK_TTL_MS = 2 * 60 * 60 * 1000;
const FULL_MS = 2 * 60 * 60 * 1000;
const HOLD_MIN = Number(process.env.BLOOD_HOLD_MIN) || D0.bloodHoldMin || 60;
const SCENARIOS = ['confirms', 'silent', 'nobody'];
/* District settings for one session. Ask 2 hospitals at once is ON; supply top-up is OFF until approved. */
const DEFAULTS = { parallel: true, replyWindowSec: null, lang: 'en', supply: false, smsFamily: false };
const WINDOWS = [60, 120, 180];
function ensure(s) {
  s.settings = Object.assign({}, DEFAULTS, s.settings || {});
  s.added = s.added || []; s.roleTokens = s.roleTokens || {}; s.otps = s.otps || {};
  return s;
}
/* The engine config for this session: the reply window and the parallel ask come from the district settings. */
const C = (s) => Object.assign({}, CFG, { parallel: Boolean(s.settings && s.settings.parallel),
  replyWindowSec: (s.settings && s.settings.replyWindowSec) || CFG.replyWindowSec });
const tr = (s, key, vars) => M.fill(key, vars || {}, s.settings && s.settings.lang);

/* The demo night's check-ins are recorded at the moment the session is created (or reset), by the duty person named in the data. */
const seedFacilities = (scenario, at, added) => D0.facilities.map((f) => {
  const checkin = f.checkin ? { shift: f.checkin.shift, items: Object.assign({}, f.checkin.items), at, by: f.who, nurses: f.nurses } : null;
  if (f.kind === 'hospital' && scenario === 'nobody') { checkin.items.blood = false; checkin.items.anaesthetist = false; }
  return Object.assign({}, f, { checkin, bloodStock: Object.assign({}, f.bloodStock || {}) });
}).concat((added || []).map((f) => Object.assign({}, f, { checkin: null, bloodStock: {} })));

function blank(id, live, scenario, now) {
  scenario = SCENARIOS.includes(scenario) ? scenario : 'confirms';
  return ensure({ id, live: Boolean(live), scenario, facilities: seedFacilities(scenario, now || Date.now()), refs: [], cur: null,
    chat: [], step: 'start', outbox: [], links: {}, ivrAt: null, updatedAt: 0 });
}

const fac = (s, id) => s.facilities.find((f) => f.id === id);
/* When two or more mothers are open at once, every bot line says which mother it is about. */
const say = (s, from, text) => {
  const pre = from === 'bot' && s.cur && s.cur.tag && (s.bg || openRefs(s).length > 1) ? `Mother ${s.cur.tag} (${s.cur.id}): ` : '';
  s.chat.push({ from, text: pre + text, at: Date.now(), ref: s.cur ? s.cur.id : null });
};
const eta = (f) => E.etaMinutes(f.km, CFG);
const clock = (ms) => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toLowerCase();
const clean = (v, n = 60) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n);

function addEvent(s, ctx, text) {
  if (!s.cur) return;
  setCur(s, Object.assign({}, s.cur, { events: s.cur.events.concat([{ at: ctx.now(), text }]) }));
}

function setCur(s, r) {
  s.cur = r;
  s.refs = s.refs.some((x) => x.id === r.id) ? s.refs.map((x) => (x.id === r.id ? r : x)) : s.refs.concat([r]);
}

/* ---- Several mothers at once ----
   s.cur is the case on the nurse screen and s.step its step. Every case keeps its own step in s.refs, so a second
   mother can be referred while the first one is still waiting, and hospital replies and timers reach the right case. */
function isOpen(r) { return Boolean(r) && r.state !== 'closed'; }
function openRefs(s) { return (s.refs || []).filter(isOpen); }
function refById(s, id) { return (s.refs || []).find((r) => r.id === id) || null; }
function park(s) { if (s.cur && refById(s, s.cur.id)) setCur(s, Object.assign({}, s.cur, { step: s.step })); }
/* Distances are counted from the PHC, or from the home for an ASHA home case. */
function applyOrigin(s) {
  const o = s.cur && s.cur.origin;
  (s.facilities || []).forEach((f) => {
    if (f.baseKm == null) f.baseKm = f.km;
    f.km = o && f.x != null ? Math.max(1, Math.round(Math.hypot(f.x - o.x, f.y - o.y))) : f.baseKm;
  });
}
function activate(s, id) {
  park(s);
  const r = id ? refById(s, id) : null;
  s.cur = r; s.step = r ? r.step || 'start' : (s.step === 'callback' ? 'callback' : 'start');
  applyOrigin(s);
}
/* Run fn on another case (a hospital reply, a timer), then put the nurse screen back on the case she had open. */
async function withCase(s, id, fn) {
  if (!id || (s.cur && s.cur.id === id) || !refById(s, id)) return fn();
  const back = s.cur ? s.cur.id : null, backStep = s.step;
  activate(s, id); s.bg = true;
  try { return await fn(); } finally {
    s.bg = false; park(s);
    if (back) activate(s, back); else { s.cur = null; s.step = backStep; applyOrigin(s); }
  }
}
const caseHead = (s) => (s.cur ? `Case ${s.cur.id}` + (s.cur.tag && s.refs.length > 1 ? ` (Mother ${s.cur.tag})` : '') : '');
const statusText = (s, r) => {
  const h = fac(s, r.confirmed || r.proposal || r.destination);
  const at = h ? h.short : 'no hospital yet';
  return { referred: 'details not sent yet', routed: 'proposed ' + at + ', not sent yet', sent: 'waiting for ' + at, ivr: 'calling ' + at,
    confirmed: at + ' confirmed', fallback: 'no hospital ready, district alerted', closed: 'closed' }[r.state] || r.state;
};

/* ---- 108 ambulances: each mother gets her own ambulance, driver and EMT ---- */
const AMBS = D0.ambulances && D0.ambulances.length ? D0.ambulances : [{ id: 'amb1', label: '108 Ambulance', driver: 'driver', emt: 'emt' }];
const ambOf = (s) => (s.cur && AMBS.find((a) => a.id === s.cur.amb)) || null;
async function assignAmb(s, ctx) {
  if (!s.cur) return null;
  if (s.cur.amb) return ambOf(s);
  const taken = openRefs(s).filter((r) => r.id !== s.cur.id && r.amb && r.arrived !== 'Yes').map((r) => r.amb);
  const free = AMBS.find((a) => !taken.includes(a.id));
  if (free) {
    setCur(s, Object.assign({}, s.cur, { amb: free.id }));
    addEvent(s, ctx, free.label + ' assigned to this mother');
    return free;
  }
  if (!s.cur.noAmb) {
    setCur(s, Object.assign({}, s.cur, { noAmb: true }));
    const from = pickupOf(s).name;
    addEvent(s, ctx, 'No free 108 ambulance: district asked to send the nearest one');
    say(s, 'bot', M.fill('noAmbulance', { id: s.cur.id, tag: s.cur.tag || '', from }));
    await tell(s, ctx, 'district', 'District officer', M.fill('noAmbulance', { id: s.cur.id, tag: s.cur.tag || '', from }));
  }
  return null;
}
/* Where the ambulance picks her up: the PHC, or the home location the ASHA shared. */
function pickupOf(s) {
  const o = s.cur && s.cur.origin;
  if (!o) return D0.startPoint;
  const v = (D0.villages || []).find((x) => x.id === o.id);
  return Object.assign({}, o, v ? { lat: v.lat, lng: v.lng } : {});
}
/* Google Maps directions from the pick-up to the hospital. Demo coordinates; in a pilot they come from ABDM HFR. */
const mapsLink = (from, to) => (from && to && from.lat != null && to.lat != null
  ? `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}&destination=${to.lat},${to.lng}&travelmode=driving` : '');
async function tellDriver(s, ctx, text, destId) {
  const a = await assignAmb(s, ctx);
  if (!a) return;
  const h = destId ? fac(s, destId) : null;
  const link = h ? mapsLink(pickupOf(s), h) : '';
  const head = `${a.label}, case ${s.cur.id}` + (s.cur.tag && s.refs.length > 1 ? ` (Mother ${s.cur.tag})` : '') + '. ';
  text = String(text).replace(/^108 trip: pick up/, 'Pick up').replace(/^108 change: /, 'CHANGE: ').replace(/^108: /, '');
  await tell(s, ctx, a.driver, a.id === AMBS[0].id ? '108 driver' : '108 driver, ' + a.label.replace(/^108 /, ''), head + text + (link ? ' Route (demo location): ' + link : ''));
}
async function tellEmt(s, ctx, text) {
  const a = await assignAmb(s, ctx);
  if (!a) return;
  const head = `${a.label}, case ${s.cur.id}` + (s.cur.tag && s.refs.length > 1 ? ` (Mother ${s.cur.tag})` : '') + '. ';
  await tell(s, ctx, a.emt, a.id === AMBS[0].id ? '108 EMT' : '108 EMT, ' + a.label.replace(/^108 /, ''), head + text);
}
/* A message about this case to the hospital, doctor, blood bank or nurse always carries the case ID. */
async function tellC(s, ctx, role, label, text) {
  return tell(s, ctx, role, label, s.cur && !String(text).includes(s.cur.id) ? text + ' [' + caseHead(s) + ']' : text);
}

async function tell(s, ctx, role, label, text) {
  const sms = role === 'family' && s.settings && s.settings.smsFamily;
  let r = sms && ctx.sms ? await ctx.sms(s.live, role, text) : await ctx.send(s.live, role, text);
  if (sms && !ctx.sms) r = Object.assign({}, r, { channel: 'sms' });
  // WhatsApp did not go through to the family: try a plain SMS once.
  if (!sms && role === 'family' && r.status === 'failed' && ctx.sms) { const r2 = await ctx.sms(s.live, role, text); if (r2.status !== 'failed') r = r2; }
  s.outbox.push({ at: ctx.now(), role, label, text, status: r.status, channel: r.channel, error: r.error || null });
  s.outbox = s.outbox.slice(-60);
}
/* The family message in the local language (Hindi, pending review) with the English text under it. */
const familyText = (s, vars) => (s.settings.lang === 'hi' ? M.fill('family', vars, 'hi') + '\n' : '') + M.fill('family', vars);

const typeOf = (s) => D0.emergencyTypes.find((x) => x.id === (s.cur && s.cur.type)) || D0.emergencyTypes[0];
const groupOf = (s) => (s.cur && s.cur.patient ? clean(s.cur.patient.blood, 6) || 'not known yet' : D0.mother.bloodGroup);
const formFor = (typeId) => D0.forms[typeId] || D0.forms.bleeding;

function summaryLink(s, ctx, hospital) {
  const p = s.cur.patient || {};
  const t = typeOf(s);
  const token = s.id + '.' + crypto.randomBytes(8).toString('hex');
  const dest = fac(s, hospital);
  s.links[token] = { expires: ctx.now() + LINK_TTL_MS, hospital: dest.name, eta: eta(dest), ref: s.cur.id,
    type: t.label, review: t.review || '',
    patient: { name: clean(p.name || D0.mother.name), age: clean(p.age, 4) || 'not given', blood: groupOf(s), abha: p.abha || '' },
    needs: t.needs || '', from: D0.startPoint.name, informed: p.informed || 'Not recorded',
    facts: formFor(t.id).map((q) => ({ label: q.label, value: clean(p[q.id], q.id === 'other' ? 100 : 20) })) };
  return (ctx.baseUrl() || '') + '/s/' + token;
}

const incomingText = (s, f) => {
  const t = typeOf(s);
  const other = openRefs(s).find((r) => s.cur && r.id !== s.cur.id && (r.confirmed || r.proposal) === f.id && ['sent', 'ivr', 'confirmed'].includes(r.state) && r.arrived !== 'Yes');
  return M.fill('incoming', { type: t.short, needs: t.needs, eta: eta(f), group: groupOf(s) }) +
    ' Reply with the number. For 2, add the minutes, for example: 2 20.' + (other ? ' ' + M.fill('secondCase', { other: other.id }) : '');
};
/* The 108 EMT (the clinical person in the ambulance) gets the nurse's facts. The driver does not. */
const emtText = (s, f) => {
  const p = (s.cur && s.cur.patient) || {};
  const t = typeOf(s);
  const facts = formFor(t.id).filter((q) => p[q.id]).map((q) => q.label.replace(/\?$/, '') + ': ' + clean(p[q.id], q.id === 'other' ? 100 : 20)).join('; ');
  return M.fill('emt', { type: t.short, name: clean(p.name || D0.mother.name), age: clean(p.age || D0.mother.age, 4), group: groupOf(s),
    facts: facts || 'not sent yet', hospital: f.short, eta: eta(f) });
};
/* The proposal always says when the hospital last checked in, and that the check-in is not a confirmation. */
const CHECK_OLD_MS = (D0.checkinValidHours || 8) * 60 * 60 * 1000;
function lastCheckText(s, f, ctx) {
  const c = f.checkin;
  if (!c || !c.at) return tr(s, 'lastCheckNone', { hospital: f.short });
  if (ctx.now() - c.at > CHECK_OLD_MS) return tr(s, 'lastCheckOld', { time: clock(c.at), hours: D0.checkinValidHours || 8, hospital: f.short });
  return tr(s, 'lastCheck', { time: clock(c.at), who: c.by || f.who, hospital: f.short });
}
const ivrText = (s, f) => M.fill('ivrScript', { type: typeOf(s).short, eta: eta(f) });

async function startReferral(s, ctx, a) {
  const t = D0.emergencyTypes.find((x) => x.id === a.typeId);
  if (!t) return s;
  if (!t.signed) {
    say(s, 'nurse', t.label);
    say(s, 'bot', t.draft ? tr(s, 'draftNote', { items: t.draft.join(', ') }) : tr(s, 'typeNotSigned'));
    return s;
  }
  park(s);
  const base = E.startReferral(t.id, ctx.now());
  let id = base.id, n = 1;
  while (refById(s, id)) id = base.id + '-' + (++n);
  const tag = String.fromCharCode(65 + (s.refs.length % 26));
  s.cur = null;
  setCur(s, Object.assign(base, { id, tag }, a.origin ? { origin: a.origin } : {}));
  applyOrigin(s);
  s.step = 'details'; say(s, 'nurse', t.label);
  if (t.review) say(s, 'bot', tr(s, 'reviewNote', { review: t.review }));
  if (t.safety) say(s, 'bot', t.safety);
  say(s, 'bot', tr(s, 'details'));
  return s;
}

async function details(s, ctx, a) {
  if (!s.cur || s.step !== 'details') return s;
  const p = a.patient || {};
  const patient = { name: clean(p.name), age: clean(p.age, 4), blood: clean(p.blood, 6), contact: clean(p.contact, 20), abha: clean(p.abha, 17),
    informed: ['Yes', 'No'].includes(p.informed) ? p.informed : 'Not recorded' };
  const form = formFor(s.cur.type);
  form.forEach((q) => { patient[q.id] = clean(p[q.id], q.id === 'other' ? 100 : 20); });
  s.cur = Object.assign({}, s.cur, { patient });
  const who = [patient.name, patient.age, patient.blood].filter(Boolean).join(', ');
  const key = form.slice(0, 2).filter((q) => patient[q.id]).map((q) => q.label + ' ' + patient[q.id]).join(', ');
  say(s, 'nurse', `Details sent: ${who}.${key ? ' ' + key + '.' : ''} Family informed: ${patient.informed}`);
  addEvent(s, ctx, 'Details sent. Family informed that details go to the hospital: ' + patient.informed);
  const r = E.propose(s.cur, s.facilities, C(s), ctx.now());
  setCur(s, r);
  if (r.state !== 'fallback') await supplyIdea(s, ctx);
  if (r.state === 'fallback') await goFallback(s, ctx);
  else { const h = fac(s, r.proposal); say(s, 'bot', tr(s, 'proposed', { hospital: h.short, km: h.km, eta: eta(h) })); say(s, 'bot', lastCheckText(s, h, ctx)); s.step = 'proposed'; }
  return s;
}

/* Nobody confirmed: escalate to the district and PROPOSE the medical college. It is not accepted until it replies;
   the doctor, blood bank and family are told only after that. */
async function goFallback(s, ctx) {
  const mc = fac(s, 'mc');
  say(s, 'bot', tr(s, 'fallback')); say(s, 'bot', tr(s, 'fallbackWait', { hospital: mc.short })); s.step = 'waiting';
  await tell(s, ctx, 'district', 'District officer', M.fill('district', { id: s.cur.id }));
  await tellDriver(s, ctx, M.fill('driverFallback', { hospital: mc.short, km: mc.km }), mc.id);
  await tellEmt(s, ctx, M.fill('driverFallback', { hospital: mc.short, km: mc.km }));
  await tellC(s, ctx, 'mc', mc.short, incomingText(s, mc) + ' ' + M.T.fallbackIncoming);
}

async function change(s, ctx) {
  if (!s.cur || s.cur.state !== 'routed') return s;
  const r = E.changeProposal(s.cur, s.facilities, C(s), ctx.now());
  setCur(s, r); const h = fac(s, r.proposal);
  say(s, 'nurse', 'CHANGE'); say(s, 'bot', tr(s, 'proposed', { hospital: h.short, km: h.km, eta: eta(h) })); say(s, 'bot', lastCheckText(s, h, ctx));
  return s;
}

async function send(s, ctx, a) {
  if (!s.cur || s.cur.state !== 'routed') return s;
  const backup = s.settings.parallel ? E.pickBackup(s.cur, s.facilities, C(s)) : null;
  const r = E.sendTo(s.cur, ctx.now(), backup);
  setCur(s, r); s.step = 'waiting'; if (!(a && a.quiet)) say(s, 'nurse', 'SEND'); say(s, 'bot', tr(s, 'sent'));
  const h = fac(s, r.proposal);
  const o = r.origin;
  await tellDriver(s, ctx, o ? M.fill('driverHome', { place: o.name, hospital: h.short, km: h.km }) : M.fill('driver', { from: D0.startPoint.name, hospital: h.short, km: h.km }), h.id);
  await tellEmt(s, ctx, emtText(s, h));
  await tellC(s, ctx, r.proposal, h.short, incomingText(s, h));
  if (r.backup) await askBackup(s, ctx, r);
  return s;
}

/* Ask the next ready hospital at the same moment. The nearer one keeps priority; the backup is cancelled if it confirms. */
async function askBackup(s, ctx, r) {
  const b = fac(s, r.backup), h = fac(s, r.proposal);
  say(s, 'bot', tr(s, 'parallelNurse', { backup: b.short, hospital: h.short }));
  await tellC(s, ctx, b.id, b.short, incomingText(s, b) + ' ' + M.fill('parallelIncoming', { primary: h.short }));
}

/* Idea: inter-hospital supply. OFF by default. Advisory to the district only; routing never changes because of it. */
async function supplyIdea(s, ctx) {
  const c = s.cur;
  if (!s.settings.supply || !c || c.supplyIdea || !c.proposal) return;
  const dest = fac(s, c.proposal);
  const group = c.patient && c.patient.blood;
  const movable = D0.movableItems || [];
  const near = s.facilities.filter((f) => f.kind === 'hospital' && f.id !== dest.id && !f.full && f.km < dest.km)
    .map((f) => ({ f, miss: E.missingFor(f, C(s), c.type, group) }))
    .filter((x) => x.miss && x.miss.length && x.miss.every((m) => movable.includes(m)))
    .sort((a, b) => a.f.km - b.f.km)[0];
  if (!near) return;
  const labels = near.miss.map((m) => { const it = ALL_ITEMS.find((x) => x.id === m) || { label: m }; return it.short || it.label.split(/[,:(]/)[0].trim().toLowerCase(); });
  setCur(s, Object.assign({}, s.cur, { supplyIdea: near.f.id }));
  addEvent(s, ctx, 'Supply idea sent to the district (advisory only): ' + near.f.short + ' lacks only ' + labels.join(', '));
  await tell(s, ctx, 'district', 'District officer', M.fill('supplyIdea', { hospital: near.f.short, items: labels.join(', '), type: typeOf(s).short.toLowerCase(), from: dest.short }));
}

async function afterEngine(s, ctx, prev, r, minutes, prevBackup) {
  if (r.state === 'confirmed') {
    const h = fac(s, r.confirmed || prev);
    if (minutes == null && r.readyIn) minutes = r.readyIn;
    if (r.cancelled && fac(s, r.cancelled)) { const x = fac(s, r.cancelled); await tell(s, ctx, x.id, x.short, M.fill('cancelled', { id: r.id, hospital: h.short })); }
    const arrive = clock(ctx.now() + (minutes ? minutes : 0) * 60000 + eta(h) * 60000);
    say(s, 'bot', minutes ? tr(s, 'readyIn', { hospital: h.short, min: minutes, time: arrive }) : tr(s, 'ready', { hospital: h.short, time: arrive }));
    s.step = 'close';
    await tellC(s, ctx, 'nurse', 'Nurse', minutes ? M.fill('readyIn', { hospital: h.short, min: minutes, time: arrive }) : M.fill('ready', { hospital: h.short, time: arrive }));
    await tellC(s, ctx, 'doctor', 'Receiving doctor', 'Matri-Kavach summary (link expires in 2 hours): ' + summaryLink(s, ctx, h.id));
    if (typeOf(s).bloodBank) {
      const group = groupOf(s);
      const until = ctx.now() + HOLD_MIN * 60000;
      // The held unit leaves the hospital's free stock, so a second mother of the same group is not sent there blindly.
      const g = E.normGroup ? E.normGroup(group) : group;
      const took = g && h.bloodStock && h.bloodStock[g] > 0;
      if (took) h.bloodStock[g] -= 1;
      setCur(s, Object.assign({}, s.cur, { bloodHoldUntil: until }, took ? { bloodTaken: { fac: h.id, group: g } } : {}));
      addEvent(s, ctx, `Blood bank asked to hold one ${group} unit until ${clock(until)}`);
      await tellC(s, ctx, 'bloodbank', 'Blood bank', M.fill(group === 'not known yet' ? 'bloodUnknown' : 'blood', { hospital: h.short, group, until: clock(until), hold: HOLD_MIN }));
    }
    await tellC(s, ctx, h.id, h.short, M.T.hospAfter);
    await tellDriver(s, ctx, M.fill('driverOk', { hospital: h.short }), h.id);
    await tellEmt(s, ctx, M.fill('emtOk', { hospital: h.short }));
    await tell(s, ctx, 'family', 'Family', familyText(s, { hospital: h.short, eta: eta(h) }));
  } else if (r.state === 'fallback') {
    await goFallback(s, ctx);
  } else if (r.state === 'sent' && r.proposal !== prev) {
    const h = fac(s, r.proposal);
    const wasBackup = prevBackup && r.proposal === prevBackup;
    if (wasBackup) say(s, 'bot', tr(s, 'rerouteBackup', { hospital: fac(s, prev).short, backup: h.short }));
    else say(s, 'bot', tr(s, 'reroute', { hospital: h.short }));
    say(s, 'bot', lastCheckText(s, h, ctx)); s.step = 'waiting';
    await tellDriver(s, ctx, M.fill('driverChange', { hospital: h.short, km: h.km }), h.id);
    await tellEmt(s, ctx, M.fill('driverChange', { hospital: h.short, km: h.km }));
    await tellC(s, ctx, h.id, h.short, wasBackup ? M.fill('nowFirst', { id: r.id }) : incomingText(s, h));
    if (r.backup && r.backup !== prevBackup) await askBackup(s, ctx, r);
  }
}

async function hospitalReply(s, ctx, a) {
  const c = s.cur;
  if (!c || !['sent', 'ivr', 'routed', 'fallback'].includes(c.state)) return s;
  const kind = a.kind === 'ready-in' ? 'ready-in' : a.kind === 'not-available' ? 'not-available' : 'all-ready';
  const minutes = kind === 'ready-in' ? Math.min(240, Math.max(1, Math.round(Number(a.minutes) || 15))) : null;
  const prev = c.proposal, prevBackup = c.backup;
  const fid = a.facility && [c.proposal, c.backup].includes(String(a.facility)) ? String(a.facility) : prev;
  const r = E.onHospitalReply(c, fid, kind === 'ready-in' ? { kind, minutes } : { kind }, s.facilities, C(s), ctx.now());
  if (r === c) return s;
  setCur(s, r);
  if (fid !== prev) { // the hospital asked in parallel answered; the nearer one still has priority
    const b = fac(s, fid), h = fac(s, prev);
    say(s, 'bot', r.backupYes ? tr(s, 'backupYesNurse', { backup: b.short, hospital: h.short }) : tr(s, 'backupNoNurse', { backup: b.short }));
    return s;
  }
  s.ivrAt = null;
  if (c.state === 'fallback' && r.state === 'fallback') {
    if (r.fallbackDeclined && !c.fallbackDeclined) {
      const h = fac(s, prev);
      say(s, 'bot', tr(s, 'fallbackDeclined', { hospital: h.short, id: r.id }));
      await tell(s, ctx, 'district', 'District officer', M.fill('fallbackDeclined', { hospital: h.short, id: r.id }));
    }
    return s;
  }
  await afterEngine(s, ctx, prev, r, minutes, prevBackup);
  return s;
}

async function ivrAnswer(s, ctx, a) {
  if (!s.cur || s.cur.state !== 'ivr') return s;
  const prev = s.cur.proposal, prevBackup = s.cur.backup;
  const r = E.onIVR(s.cur, a.answer === '1' ? '1' : 'none', s.facilities, C(s), ctx.now());
  setCur(s, r); s.ivrAt = null;
  say(s, 'bot', r.state === 'confirmed' && r.confirmed === prev ? `IVR: all ready. ${fac(s, prev).short} confirmed.` : 'IVR not answered.');
  await afterEngine(s, ctx, prev, r, null, prevBackup);
  return s;
}

async function skip(s) {
  if (!s.cur || s.cur.state !== 'sent') return s;
  setCur(s, Object.assign({}, s.cur, { timerStart: s.cur.timerStart - C(s).replyWindowSec * 1000 }));
  return s;
}

async function arrived(s, ctx, a) {
  if (!s.cur || s.step !== 'close' || s.cur.arrived) return s;
  const v = ['Yes', 'No', 'Transferred'].includes(a.value) ? a.value : null;
  if (!v) return s;
  if (v === 'Yes') {
    setCur(s, Object.assign({}, s.cur, { arrived: 'Yes', arrivedAt: ctx.now() })); addEvent(s, ctx, 'Arrived at the hospital'); say(s, 'nurse', 'Yes, arrived'); say(s, 'bot', tr(s, 'readyQ'));
    const h = fac(s, s.cur.confirmed || s.cur.destination);
    if (s.cur.bloodHoldUntil && h) await tellC(s, ctx, 'bloodbank', 'Blood bank', M.fill('bloodIssue', { hospital: h.short, group: groupOf(s) }));
    return s;
  }
  return closeOut(s, ctx, v, null);
}

/* After arrival the nurse says whether the hospital was really ready. A "No" is a check-in mismatch the district sees. */
async function readyCheck(s, ctx, a) {
  const c = s.cur;
  if (!c || c.arrived !== 'Yes' || c.state === 'closed') return s;
  const items = E.itemsFor(c.type, C(s));
  if (!c.readyOnArrival) {
    if (a.value === 'Yes') {
      setCur(s, Object.assign({}, c, { readyOnArrival: 'Yes' })); addEvent(s, ctx, 'Nurse: everything was ready on arrival');
      say(s, 'nurse', 'Yes, all ready'); say(s, 'bot', tr(s, 'outcomeQ')); return s;
    }
    if (a.value !== 'No') return s;
    setCur(s, Object.assign({}, c, { readyOnArrival: 'No' }));
    say(s, 'nurse', 'No, something was missing');
    if (!a.missing) { say(s, 'bot', tr(s, 'missingQ')); return s; }
  }
  const cur2 = s.cur;
  if (cur2.readyOnArrival !== 'No' || cur2.missing) return s;
  const item = items.find((it) => it.id === a.missing);
  if (!item) return s;
  setCur(s, Object.assign({}, cur2, { missing: item.id }));
  addEvent(s, ctx, 'Nurse: on arrival this was missing: ' + item.label);
  say(s, 'nurse', 'Missing: ' + item.label); say(s, 'bot', tr(s, 'outcomeQ'));
  const h = fac(s, cur2.confirmed || cur2.destination);
  await tell(s, ctx, 'district', 'District officer', M.fill('mismatch', { hospital: h ? h.short : 'The hospital', item: item.label, id: cur2.id }));
  return s;
}

/* Hospital taps "Team ready at the door" after it confirmed. */
async function teamReady(s, ctx) {
  const c = s.cur;
  if (!c || c.state !== 'confirmed' || c.teamReadyAt || c.arrived) return s;
  const h = fac(s, c.confirmed);
  setCur(s, Object.assign({}, c, { teamReadyAt: ctx.now() })); addEvent(s, ctx, h.short + ': team ready at the labour room door');
  const text = M.fill('teamReady', { hospital: h.short });
  say(s, 'bot', text);
  await tellEmt(s, ctx, text);
  return s;
}

/* Hospital marks the mother discharged home: the PHC and ASHA get the back-referral. */
async function discharge(s, ctx) {
  const c = s.cur;
  if (!c || c.state !== 'closed' || c.arrived !== 'Yes' || c.dischargedAt) return s;
  const h = fac(s, c.confirmed || c.destination);
  setCur(s, Object.assign({}, c, { dischargedAt: ctx.now() })); addEvent(s, ctx, 'Discharged home from ' + h.short + '. Back-referral sent to PHC and ASHA');
  const text = M.fill('discharge', { hospital: h.short, name: clean((c.patient || D0.mother).name), time: clock(ctx.now()) });
  say(s, 'bot', text);
  await tell(s, ctx, 'asha', 'PHC and ASHA', text);
  await tell(s, ctx, h.id, h.short, M.fill('feedbackQ', { id: c.id }));
  return s;
}

const FEEDBACK = { 1: 'On time', 2: 'Should have come earlier', 3: 'Could have been managed at the PHC' };

/* The receiving hospital tells the PHC whether the referral was on time. It is shown to the nurse for learning. */
async function feedback(s, ctx, a) {
  const c = s.cur;
  const value = FEEDBACK[String(a.value)] || (Object.values(FEEDBACK).includes(a.value) ? a.value : null);
  if (!c || !c.dischargedAt || c.feedback || !value) return s;
  const h = fac(s, c.confirmed || c.destination);
  setCur(s, Object.assign({}, c, { feedback: value })); addEvent(s, ctx, `Feedback from ${h.short}: ${value}`);
  say(s, 'bot', tr(s, 'feedback', { hospital: h.short, id: c.id, value }));
  return s;
}

/* Diversion: a hospital says it is full for the next 2 hours. Routing skips it until then, or until it says OPEN. */
function expireFull(s, ctx) {
  (s.facilities || []).forEach((f) => { if (f.full && f.fullUntil <= ctx.now()) { f.full = false; f.fullUntil = null; } });
}
async function setFull(s, ctx, a) {
  const f = fac(s, String(a.facility || ''));
  if (!f || f.kind !== 'hospital') return s;
  if (openRefs(s).some((c) => ['routed', 'sent', 'ivr'].includes(c.state) && c.proposal === f.id)) return s; // answer the referral with 3 instead
  if (a.on === false) {
    if (!f.full) return s;
    f.full = false; f.fullUntil = null;
    await tell(s, ctx, f.id, f.short, M.fill('fullOff', { hospital: f.short }));
    await tell(s, ctx, 'district', 'District officer', M.fill('fullOff', { hospital: f.short }));
    return s;
  }
  f.full = true; f.fullUntil = ctx.now() + FULL_MS;
  await tell(s, ctx, f.id, f.short, M.fill('fullOn', { hospital: f.short, time: clock(f.fullUntil) }));
  await tell(s, ctx, 'district', 'District officer', M.fill('fullDistrict', { hospital: f.short, time: clock(f.fullUntil) }));
  return s;
}

/* Weekly mock drill: every hospital phone gets a practice referral; the district sees who answered and how fast. */
const ACTIVE = ['referred', 'routed', 'sent', 'ivr', 'confirmed', 'fallback'];
const busy = (s) => openRefs(s).concat(s.cur ? [s.cur] : []).some((r) => ACTIVE.includes(r.state));
async function drill(s, ctx) {
  if (busy(s) || (s.drill && !s.drill.done)) return s;
  const ids = s.facilities.filter((f) => f.kind === 'hospital' || f.kind === 'fallback').map((f) => f.id);
  s.drill = { at: ctx.now(), ids, replies: {}, done: false };
  for (const id of ids) await tell(s, ctx, id, fac(s, id).short, M.T.drill);
  return s;
}
async function drillReply(s, ctx, a) {
  const d = s.drill; const id = String(a.facility || '');
  if (!d || d.done || !d.ids.includes(id) || d.replies[id] != null) return s;
  d.replies[id] = Math.max(1, Math.round((ctx.now() - d.at) / 1000));
  if (d.ids.every((x) => d.replies[x] != null)) return drillReport(s, ctx);
  return s;
}
const secs = (n) => (n >= 60 ? Math.floor(n / 60) + ' min ' + (n % 60) + ' s' : n + ' s');
async function drillReport(s, ctx) {
  const d = s.drill;
  if (!d || d.done) return s;
  d.done = true;
  const rows = d.ids.map((id) => fac(s, id).short + (d.replies[id] != null ? ' answered in ' + secs(d.replies[id]) : ' no reply')).join('; ');
  await tell(s, ctx, 'district', 'District officer', M.fill('drillReport', { rows }));
  return s;
}

/* No internet at the PHC: the nurse gives a missed call, Matri-Kavach calls back and she picks the emergency on the keypad. */
async function missedCall(s, ctx) {
  activate(s, null); // a missed call is always a new mother; any open case keeps running
  say(s, 'nurse', M.T.missedCall); say(s, 'bot', tr(s, 'callback'));
  s.step = 'callback';
  return s;
}
async function nurseCall(s, ctx, a) {
  if (s.step !== 'callback') return s;
  const typeId = { 1: 'bleeding', 2: 'fits' }[String(a.digit)];
  if (!typeId) return s;
  say(s, 'nurse', 'Pressed ' + a.digit);
  await startReferral(s, ctx, { typeId });
  addEvent(s, ctx, 'Started by missed call and keypad (no internet)');
  say(s, 'bot', tr(s, 'callbackDone', { type: typeOf(s).short }));
  await details(s, ctx, { patient: { name: 'Name to follow', informed: 'Not recorded' } });
  return s;
}

/* Demo: the district officer gets the monthly readiness gap report. */
async function monthlyReport(s, ctx) {
  const R = D0.monthReport;
  const lines = R.rows.map((r) => { const f = fac(s, r.id); return `${f.short}: check-in done ${r.checkins} of ${R.shifts} shifts. ${r.gap}.` + (r.arrivals ? ` Ready on arrival ${r.arrivals - r.mismatches} of ${r.arrivals}.` : ''); });
  const mine = s.refs.filter((r) => r.readyOnArrival);
  const extra = mine.length ? ` This session: ready on arrival ${mine.filter((r) => r.readyOnArrival === 'Yes').length} of ${mine.length}.` : '';
  await tell(s, ctx, 'district', 'District officer', `Monthly readiness report, ${R.month}. ` + lines.join(' ') + extra);
  return s;
}

async function outcome(s, ctx, a) {
  if (!s.cur || s.cur.arrived !== 'Yes' || !s.cur.readyOnArrival || (s.cur.readyOnArrival === 'No' && !s.cur.missing)) return s;
  return closeOut(s, ctx, 'Yes', ['Delivered', 'Other'].includes(a.value) ? a.value : 'Other');
}

async function closeOut(s, ctx, arrivedV, outcomeV) {
  const r = E.onClose(Object.assign({}, s.cur, { arrived: null }), arrivedV, outcomeV, ctx.now());
  if (r.state !== 'closed') return s;
  setCur(s, r); s.step = 'done';
  if (!(arrivedV === 'Yes' && outcomeV)) say(s, 'nurse', arrivedV === 'Yes' ? 'Yes, arrived' : arrivedV);
  if (outcomeV) say(s, 'nurse', 'Outcome: ' + outcomeV);
  say(s, 'bot', tr(s, 'closed'));
  const name = clean((r.patient || D0.mother).name);
  await tell(s, ctx, 'asha', 'PHC and ASHA', M.fill('asha', { name }));
  if (r.bloodHoldUntil && arrivedV !== 'Yes') {
    const h = fac(s, r.confirmed || r.destination);
    addEvent(s, ctx, 'Blood hold released (mother did not arrive)');
    const bt = r.bloodTaken && fac(s, r.bloodTaken.fac);
    if (bt && bt.bloodStock) bt.bloodStock[r.bloodTaken.group] = (bt.bloodStock[r.bloodTaken.group] || 0) + 1;
    await tell(s, ctx, 'bloodbank', 'Blood bank', M.fill('bloodRelease', { id: r.id, hospital: h ? h.short : 'the hospital', group: groupOf(s) }));
  }
  return s;
}

async function reset(s, ctx, a) {
  const fresh = blank(s.id, s.live, a.scenario || s.scenario, ctx.now());
  fresh.settings = Object.assign({}, s.settings || DEFAULTS); fresh.added = (s.added || []).slice();
  fresh.roleTokens = s.roleTokens || {}; fresh.otps = {};
  fresh.facilities = seedFacilities(fresh.scenario, ctx.now(), fresh.added);
  // Summary links already sent to a doctor keep working until they expire, even after Reset.
  const links = {};
  Object.keys(s.links || {}).forEach((k) => { if (s.links[k].expires > ctx.now()) links[k] = s.links[k]; });
  Object.keys(s).forEach((k) => delete s[k]);
  Object.assign(s, fresh, { links });
  return s;
}

/* Called every second for sessions waiting on a hospital. */
async function tick(s, ctx) {
  ensure(s);
  const ids = (s.refs || []).filter((r) => r.state === 'sent' || r.state === 'ivr').map((r) => r.id);
  for (const id of ids) await withCase(s, id, () => tickOne(s, ctx));
  return s;
}
async function tickOne(s, ctx) {
  const c = s.cur;
  if (!c) return s;
  if (c.state === 'sent') {
    const r = E.onTimeout(c, ctx.now(), C(s), s.facilities);
    if (r.state === 'confirmed') { // silent nearer hospital, but the backup already said yes
      setCur(s, r);
      say(s, 'bot', tr(s, 'silent', { hospital: fac(s, c.proposal).short }).split('.')[0] + '.');
      await afterEngine(s, ctx, c.proposal, r, null, c.backup);
      return s;
    }
    if (r.state === 'ivr') {
      setCur(s, r); s.ivrAt = ctx.now();
      const h = fac(s, r.proposal);
      say(s, 'bot', tr(s, 'silent', { hospital: h.short }));
      const script = ivrText(s, h);
      const call = await ctx.call(s.live, r.proposal, r.id, script);
      s.outbox.push({ at: ctx.now(), role: r.proposal, label: 'No-reply call to ' + h.short, text: script, status: call.status, channel: call.channel || 'voice', error: call.error || null });
    }
  } else if (c.state === 'ivr' && s.live && s.ivrAt && ctx.now() - s.ivrAt > IVR_WAIT_MS) {
    return ivrAnswer(s, ctx, { answer: 'none' });
  }
  return s;
}

const GREETING = /^(hi+|hello+|hey+|hii+|namaste|namaskar|start|menu)\b/i;

/* The nurse types in the chat. "Hi" (or hello, namaste) opens the menu, like any WhatsApp business bot. */
async function nurseText(s, ctx, a) {
  const text = clean(a.text, 120);
  if (!text) return s;
  if (/^new\b/i.test(text)) { say(s, 'nurse', text); return newCase(s, ctx, { quiet: true }); }
  const sw = text.match(/^case\s+([a-z])\b/i) || text.match(/^(MK-\d+(?:-\d+)?)$/i);
  if (sw) { say(s, 'nurse', text); return switchCase(s, ctx, /^MK-/i.test(sw[1]) ? { id: sw[1].toUpperCase() } : { tag: sw[1].toUpperCase() }); }
  if (GREETING.test(text) && (s.step === 'done' || !s.cur)) {
    if (s.step === 'callback') s.step = 'start';
    if (s.step === 'done') activate(s, null);
    say(s, 'nurse', text); say(s, 'bot', tr(s, 'hello')); say(s, 'bot', typeList(s));
    return s;
  }
  /* A number after Hi picks the emergency (plain WhatsApp has no list button). */
  const num = !s.cur && s.step === 'start' && text.match(/^([1-9])$/);
  const picked = num && D0.emergencyTypes[Number(num[1]) - 1];
  if (picked) {
    say(s, 'nurse', text);
    await startReferral(s, ctx, { typeId: picked.id });
    if (s.cur && s.step === 'details') {
      say(s, 'bot', tr(s, 'typeNumber', { type: picked.label }));
      await details(s, ctx, { patient: { name: 'Name to follow', informed: 'Not recorded' }, quiet: true });
    }
    return s;
  }
  const quick = text.match(QUICK);
  if (quick) { // a keyword always starts a referral for a new mother; an open case keeps running
    if (s.cur) activate(s, null);
    const typeId = /^(fits|ecl)/i.test(quick[1]) ? 'fits' : 'bleeding';
    const group = quick[2] ? quick[2].replace(/\s+/g, '').toUpperCase().replace('POS', '+').replace('NEG', '-') : '';
    say(s, 'nurse', text);
    await startReferral(s, ctx, { typeId, quiet: true });
    say(s, 'bot', tr(s, 'quick', { type: typeOf(s).short, group: group || 'not given' }));
    await details(s, ctx, { patient: { name: 'Name to follow', blood: group, informed: 'Not recorded' }, quiet: true });
    return s;
  }
  if (s.step === 'callback' && /^[12]$/.test(text)) return nurseCall(s, ctx, { digit: text });
  if (s.cur && isDetailsText(text)) return waDetails(s, ctx, { text: a.text });
  if (s.step === 'proposed' && /^send$/i.test(text)) return send(s, ctx);
  if (s.step === 'proposed' && /^change$/i.test(text)) return change(s, ctx);
  if (s.step === 'close' && /^[1-9]$/.test(text)) return closeDigit(s, ctx, text);
  say(s, 'nurse', text);
  say(s, 'bot', s.cur ? tr(s, 'busy') : tr(s, 'sayHi'));
  return s;
}

/* WhatsApp: the nurse types the patient details in one line, before or after SEND ("Lakshmi Devi, 24, B+, family yes"). */
const BLOOD_RE = /^(ab|a|b|o)\s*(\+|-|pos(?:itive)?|neg(?:ative)?|\+ve|-ve)$/i;
function parseDetails(text) {
  const t = String(text || '').replace(/^(details?|d)\s*[:\-]\s*|^details?\s+/i, '');
  const parts = t.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2 && !/^details?\b/i.test(String(text))) return null;
  const out = {};
  for (const x of parts) {
    const fam = x.match(/^(?:family(?:\s+informed)?)\s*[:\-]?\s*(yes|no|haan|nahi)$/i);
    if (fam) { out.informed = /^(yes|haan)$/i.test(fam[1]) ? 'Yes' : 'No'; continue; }
    const age = x.match(/^(\d{2})(?:\s*(?:y|yr|yrs|years?|sal))?$/i);
    if (age && !out.age) { out.age = age[1]; continue; }
    const bg = x.replace(/\s+/g, ' ').match(BLOOD_RE);
    if (bg && !out.blood) { out.blood = bg[1].toUpperCase() + (/^(\+|pos|\+ve)/i.test(bg[2]) ? '+' : '-'); continue; }
    if (!out.name && /^[a-z][a-z .']{1,40}$/i.test(x)) { out.name = x.replace(/\s+/g, ' '); continue; }
  }
  const n = ['name', 'age', 'blood'].filter((k) => out[k]).length;
  return n >= 2 || (n >= 1 && /^details?\b/i.test(String(text))) ? out : null;
}
const isDetailsText = (text) => Boolean(parseDetails(text));

async function waDetails(s, ctx, a) {
  const c = s.cur; const d = parseDetails(a.text);
  if (!c || !d) return s;
  const p = Object.assign({}, c.patient || {});
  if (d.name) p.name = clean(d.name); if (d.age) p.age = clean(d.age, 4);
  const newGroup = d.blood && clean(d.blood, 6) !== p.blood;
  if (d.blood) p.blood = clean(d.blood, 6);
  if (d.informed) p.informed = d.informed;
  setCur(s, Object.assign({}, c, { patient: p }));
  const who = [p.name, p.age && p.age + ' years', p.blood && 'blood group ' + p.blood].filter(Boolean).join(', ');
  say(s, 'nurse', a.text);
  say(s, 'bot', M.fill('waDetails', { who, informed: p.informed || 'Not recorded' }));
  addEvent(s, ctx, 'Details sent on WhatsApp: ' + who);
  const hid = s.step === 'proposed' ? null : s.cur.confirmed || s.cur.destination || (['sent', 'ivr', 'confirmed', 'fallback'].includes(s.cur.state) ? s.cur.proposal : null);
  if (hid) {
    const h = fac(s, hid);
    if (h) await tellC(s, ctx, h.id, h.short, M.fill('waDetailsHosp', { who, informed: p.informed || 'Not recorded' }));
    if (h && newGroup && s.cur.bloodHoldUntil) await tellC(s, ctx, 'bloodbank', 'Blood bank', M.fill('bloodLater', { hospital: h.short, group: p.blood }));
  } else if (s.step === 'proposed') {
    const h = fac(s, s.cur.proposal);
    if (h) say(s, 'bot', tr(s, 'proposed', { hospital: h.short, km: h.km, eta: eta(h) }));
  }
  return s;
}

/* WhatsApp: shift check-in by text. "CHECKIN DH" shows the numbered items; "CHECKIN DH OK" or "CHECKIN DH NO 3 7" saves it. */
function waCheckinList(s, fid) {
  const f = fac(s, fid);
  return `🗒️ Night shift check-in for ${f.short} (${f.who}). Which of these are NOT ready tonight?\n` +
    ALL_ITEMS.map((it, i) => `${i + 1}. ${it.label}`).join('\n') +
    `\n\nReply CHECKIN ${fid.toUpperCase()} OK if all are ready, or CHECKIN ${fid.toUpperCase()} NO and the numbers that are not ready, for example: CHECKIN ${fid.toUpperCase()} NO 3 7`;
}
async function waCheckin(s, ctx, a) {
  const f = fac(s, a.facility); if (!f) return s;
  const off = new Set((a.missing || []).map(Number));
  const items = {}; ALL_ITEMS.forEach((it, i) => { items[it.id] = !off.has(i + 1); });
  return checkin(s, ctx, { facility: f.id, items, nurses: f.checkin && f.checkin.nurses != null ? f.checkin.nurses : 3 });
}
/* WhatsApp: the district officer's dashboard as one message. */
function waStatus(s, ctx) {
  const open = (s.refs || []).filter((r) => !['closed'].includes(r.state));
  const hosp = s.facilities.filter((f) => f.kind === 'hospital' || f.kind === 'fallback');
  const icon = { ready: '🟢', partial: '🟡', uncertain: '⚪', 'not-ready': '🔴' };
  const rows = hosp.map((f) => {
    const st = E.facilityStatus(f, C(s), 'bleeding');
    const when = f.checkin ? 'check-in ' + clock(f.checkin.at) : 'no check-in';
    return `${icon[st] || '⚪'} ${f.short}: ${st.replace('-', ' ')} for heavy bleeding (${when}${f.full ? ', FULL' : ''})`;
  });
  const cases = open.length ? open.map((r) => `• ${r.id}${r.tag ? ' (Mother ' + r.tag + ')' : ''}: ${(D0.emergencyTypes.find((t) => t.id === r.type) || {}).short || r.type}, ${r.state}${r.confirmed ? ' at ' + fac(s, r.confirmed).short : r.proposal ? ', asked ' + fac(s, r.proposal).short : ''}`).join('\n') : '• none';
  return `📊 District dashboard, ${clock(ctx.now())}\n*Hospitals tonight*\n${rows.join('\n')}\n*Open referrals*\n${cases}\n\nType REPORT for the monthly readiness report. Full map and KPIs: https://matri-kavach-mvp.onrender.com`;
}

const typeList = (s) => tr(s, 'typeList', { list: D0.emergencyTypes.map((t, i) => (i + 1) + ' ' + t.label).join(', ') });
const QUICK = /^(bleed\w*|pph|fits?|ecl\w*)\b\s*((?:ab|a|b|o)\s*(?:[+-]|pos|neg))?/i;

/* A digit typed by the nurse while closing the case (also used for WhatsApp replies). Returns the bot's next question. */
async function closeDigit(s, ctx, text) {
  const c = s.cur;
  if (!c || s.step !== 'close') return s;
  const d = text.trim()[0];
  if (!c.arrived) { const v = { 1: 'Yes', 2: 'No', 3: 'Transferred' }[d]; if (v) return arrived(s, ctx, { value: v }); }
  else if (!c.readyOnArrival) { const v = { 1: 'Yes', 2: 'No' }[d]; if (v) return readyCheck(s, ctx, { value: v }); }
  else if (c.readyOnArrival === 'No' && !c.missing) { const it = E.itemsFor(c.type, C(s))[Number(d) - 1]; if (it) return readyCheck(s, ctx, { missing: it.id }); }
  else { const v = { 1: 'Delivered', 2: 'Other' }[d]; if (v) return outcome(s, ctx, { value: v }); }
  return s;
}

/* What the nurse should be asked next while closing, as text (for WhatsApp, where buttons are numbers). */
function closePrompt(s) {
  const c = s.cur;
  if (!c || s.step !== 'close') return s.step === 'done' ? M.T.closed : null;
  if (!c.arrived) return M.T.closeQ;
  if (!c.readyOnArrival) return M.T.readyQ;
  if (c.readyOnArrival === 'No' && !c.missing) return M.T.missingQ + ' ' + E.itemsFor(c.type, C(s)).map((it, i) => `${i + 1} ${it.label}`).join('. ');
  return M.T.outcomeQ;
}

const ALL_ITEMS = D0.checklistItems.concat(D0.extraItems || []);
const ROUTED_TYPES = D0.emergencyTypes.filter((t) => t.signed);

/* Shift check-in from a hospital's labour room phone: one Yes/No per item, shared by every emergency type. */
async function checkin(s, ctx, a) {
  const f = fac(s, String(a.facility || ''));
  if (!f || (f.kind !== 'hospital' && f.kind !== 'fallback')) return s;
  const given = a.items || {};
  const items = {};
  ALL_ITEMS.forEach((it) => { if (given[it.id] === true || given[it.id] === false) items[it.id] = given[it.id]; });
  const nurses = a.nurses == null || a.nurses === '' ? null : Math.max(0, Math.min(30, Math.round(Number(a.nurses) || 0)));
  f.checkin = { shift: 'night', items, at: ctx.now(), by: f.who, nurses };
  f.missed = false;
  if (a.bloodStock && typeof a.bloodStock === 'object') f.bloodStock = cleanStock(a.bloodStock);
  const yes = ALL_ITEMS.filter((it) => items[it.id] === true).length;
  const unknown = ALL_ITEMS.filter((it) => items[it.id] !== true && items[it.id] !== false).length;
  const readyFor = ROUTED_TYPES.filter((t) => E.facilityStatus(f, C(s), t.id) === 'ready').map((t) => t.short);
  await tell(s, ctx, f.id, f.short, M.fill('checkinSaved', { hospital: f.short, who: f.who, yes, no: ALL_ITEMS.length - yes - unknown,
    missing: unknown ? ', ' + unknown + ' not answered (counted as not ready)' : '', readyFor: readyFor.length ? readyFor.join(', ') : 'none' }));
  if (nurses != null && nurses < (D0.minNurses || 2)) await tell(s, ctx, 'district', 'District officer', M.fill('staffGap', { hospital: f.short, n: nurses, min: D0.minNurses || 2, who: f.who }));
  return s;
}

const cleanStock = (o) => {
  const out = {};
  (D0.bloodGroups || []).forEach((g) => { const n = Math.round(Number(o[g])); if (n > 0) out[g] = Math.min(99, n); });
  return out;
};

/* Mock of an e-RaktKosh link: fills the blood stock per group from demo data. Not connected to the real e-RaktKosh. */
async function eraktSync(s, ctx, a) {
  const f = fac(s, String(a.facility || ''));
  const base = f && D0.facilities.find((x) => x.id === f.id);
  if (!f) return s;
  f.bloodStock = Object.assign({}, (base && base.bloodStock) || {}); f.bloodSyncedAt = ctx.now();
  const list = Object.keys(f.bloodStock).map((g) => g + ' ' + f.bloodStock[g]).join(', ') || 'no units';
  await tell(s, ctx, f.id, f.short, `Blood stock updated from e-RaktKosh (MOCK, demo data, not the real system): ${list}.`);
  return s;
}

/* District settings: reply window, ask 2 hospitals at once, language, supply idea, family by SMS. */
async function setSettings(s, ctx, a) {
  const st = s.settings;
  if (typeof a.parallel === 'boolean') st.parallel = a.parallel;
  if (WINDOWS.includes(Number(a.replyWindowSec))) st.replyWindowSec = Number(a.replyWindowSec);
  if (['en', 'hi'].includes(a.lang)) st.lang = a.lang;
  if (typeof a.supply === 'boolean') st.supply = a.supply;
  if (typeof a.smsFamily === 'boolean') st.smsFamily = a.smsFamily;
  return s;
}

/* Hospital editor: the district adds a hospital. It starts Uncertain (no check-in) and gets no referral until it checks in. */
async function addHospital(s, ctx, a) {
  const name = clean(a.name, 40);
  const km = Math.round(Number(a.km));
  if (!name || !(km >= 1 && km <= 150) || s.added.length >= 4 || busy(s)) return s;
  const n = s.added.length + 1, ang = (n * 75 + 20) * Math.PI / 180;
  const P = D0.startPoint;
  const f = { id: 'h' + n + crypto.randomBytes(2).toString('hex'), name, short: name, km, role: 'Labour room', kind: 'hospital', who: 'Duty nurse', ini: name[0].toUpperCase(),
    x: Math.round((P.x + Math.cos(ang) * km) * 10) / 10, y: Math.round((P.y + Math.sin(ang) * km) * 10) / 10, nurses: null,
    lat: Math.round((P.lat + Math.sin(ang) * km * -0.009) * 1000) / 1000, lng: Math.round((P.lng + Math.cos(ang) * km * 0.0098) * 1000) / 1000, hfr: 'not linked', added: true };
  s.added.push(f);
  s.facilities.push(Object.assign({}, f, { checkin: null, bloodStock: {} }));
  await tell(s, ctx, f.id, f.short, `Welcome to Matri-Kavach, ${f.short}. Please do the night shift check-in. Until then this hospital shows as Uncertain and gets no referrals.`);
  return s;
}
async function removeHospital(s, ctx, a) {
  const id = String(a.id || '');
  if (!s.added.some((f) => f.id === id) || busy(s)) return s;
  s.added = s.added.filter((f) => f.id !== id); s.facilities = s.facilities.filter((f) => f.id !== id);
  return s;
}

/* ASHA home emergency: the ASHA shares the home location; distances are counted from the home and the ambulance is sent at once. */
async function ashaHome(s, ctx, a) {
  const v = (D0.villages || []).find((x) => x.id === a.village);
  const t = D0.emergencyTypes.find((x) => x.id === a.typeId && x.signed);
  if (!v || !t) return s;
  activate(s, null); // a home emergency is a new mother; any open case keeps running
  const origin = { id: v.id, name: v.name, x: v.x, y: v.y, by: 'ASHA Sunita' };
  await startReferral(s, ctx, { typeId: t.id, origin });
  if (s.cur) setCur(s, Object.assign({}, s.cur, { events: [{ at: ctx.now(), text: 'Referral started by ASHA Sunita (home emergency)' }] }));
  const text = tr(s, 'ashaStart', { asha: 'Sunita', type: t.short, place: v.name });
  say(s, 'bot', text); addEvent(s, ctx, 'Location shared: ' + v.name);
  await tell(s, ctx, 'asha', 'PHC and ASHA', text);
  await details(s, ctx, { patient: { name: 'Name to follow', blood: clean(a.blood, 6), informed: 'Not recorded' } });
  if (s.cur.state === 'routed') {
    await send(s, ctx, { quiet: true });
    const h = fac(s, s.cur.proposal);
    await tell(s, ctx, 'asha', 'PHC and ASHA', tr(s, 'ashaSent', { place: v.name, hospital: h.short, eta: eta(h) }));
  }
  return s;
}

/* Demo: a hospital misses its shift check-in. It turns Uncertain, gets a reminder, and the district officer is told. */
async function missCheckin(s, ctx, a) {
  const f = fac(s, String(a.facility || 'dh'));
  if (!f || f.kind !== 'hospital' || openRefs(s).some((c) => ['routed', 'sent', 'ivr'].includes(c.state))) return s;
  f.checkin = null; f.missed = true;
  await tell(s, ctx, f.id, f.short, M.fill('checkinRemind', { hospital: f.short }));
  await tell(s, ctx, 'district', 'District officer', M.fill('checkinEscalate', { hospital: f.short }));
  return s;
}

/* The nurse starts a referral for another mother. The open cases keep running: timers, hospital replies and the 108 go on. */
async function newCase(s, ctx, a) {
  activate(s, null);
  const open = openRefs(s).length;
  if (!(a && a.quiet)) say(s, 'nurse', 'NEW');
  say(s, 'bot', open ? tr(s, 'newCase', { open }) : tr(s, 'hello'));
  return s;
}
/* The nurse switches the screen to another mother's case (by letter or case ID). */
async function switchCase(s, ctx, a) {
  const r = a.id ? refById(s, String(a.id)) : (s.refs || []).filter((x) => x.tag === String(a.tag || '').toUpperCase()).pop();
  if (!r) return s;
  activate(s, r.id);
  say(s, 'bot', tr(s, 'switched', { tag: r.tag || '', id: r.id, type: (D0.emergencyTypes.find((x) => x.id === r.type) || {}).short || r.type, status: statusText(s, r) }));
  return s;
}

/* Which case a hospital action is about: the case ID if given, else the case that asked this hospital (the open one on screen first). */
const CASE_ACTS = ['hospitalReply', 'ivrAnswer', 'teamReady', 'discharge', 'feedback'];
function caseFor(s, action, a, strict) {
  if (a.ref && refById(s, String(a.ref)) && !strict) return String(a.ref);
  const f = a.facility ? String(a.facility) : null;
  const dest = (r) => r.confirmed || r.destination;
  const fits = {
    hospitalReply: (r) => ['sent', 'ivr', 'routed', 'fallback'].includes(r.state) && f && (r.proposal === f || (r.backup === f && !r.backupYes && ['sent', 'ivr'].includes(r.state))),
    ivrAnswer: (r) => r.state === 'ivr' && (!f || r.proposal === f),
    teamReady: (r) => r.state === 'confirmed' && !r.teamReadyAt && !r.arrived && (!f || r.confirmed === f),
    discharge: (r) => r.state === 'closed' && r.arrived === 'Yes' && !r.dischargedAt && (!f || dest(r) === f),
    feedback: (r) => r.dischargedAt && !r.feedback && (!f || dest(r) === f)
  }[action];
  if (!fits) return null;
  if (strict) { const r = a.ref && refById(s, String(a.ref)); return r && fits(r) ? r.id : null; }
  if (s.cur && fits(s.cur)) return s.cur.id;
  const m = (s.refs || []).find(fits);
  return m ? m.id : null;
}
/* For a reply by phone: the case named in the text ("1 MK-123456" or "1 B"), if any. */
function refInText(s, text) {
  const t = String(text || '');
  const id = t.match(/MK-\d+(?:-\d+)?/i);
  if (id && refById(s, id[0].toUpperCase())) return id[0].toUpperCase();
  const tag = t.match(/\b([A-Za-z])\s*$/);
  if (tag && !/^\s*[a-z]+\s*$/i.test(t)) { const r = openRefs(s).filter((x) => x.tag === tag[1].toUpperCase()).pop(); if (r) return r.id; }
  return null;
}

/* The 108 EMT reports the mother is getting worse on the way. The EMT picks what they see (facts only); the
   receiving hospital and doctor are told at once, the nurse sees it, and if nobody has confirmed yet the district too. */
const EN_ROUTE = ['sent', 'ivr', 'confirmed', 'fallback'];
function emtCase(s, emtRole, ref) {
  const amb = AMBS.find((a) => a.emt === emtRole);
  const mine = (r) => r && EN_ROUTE.includes(r.state) && !r.arrived && (!amb || !emtRole || (r.amb || AMBS[0].id) === amb.id);
  const named = ref && refById(s, String(ref));
  if (named) return mine(named) ? named.id : null;
  if (mine(s.cur)) return s.cur.id;
  const r = (s.refs || []).filter(mine).pop();
  return r ? r.id : null;
}
async function emtWorse(s, ctx, a) {
  const id = emtCase(s, a.emt || null, a.ref);
  if (!id) return s;
  return withCase(s, id, async () => {
    const c = s.cur;
    const sg = (D0.worseSigns || []).find((x) => x.id === a.sign) || (D0.worseSigns || [])[0] || { id: 'other', label: 'Other' };
    setCur(s, Object.assign({}, c, { worse: (c.worse || []).concat([{ at: ctx.now(), sign: sg.id }]) }));
    const sign = sg.label.toLowerCase();
    const text = M.fill('emtWorse', { sign });
    const told = [];
    const hosp = c.state === 'confirmed' ? [c.confirmed] : [c.proposal, c.backup].filter(Boolean);
    for (const hid of [...new Set(hosp)]) { const h = fac(s, hid); if (h) { await tellC(s, ctx, h.id, h.short, text); told.push(h.short); } }
    if (c.state === 'confirmed') { await tellC(s, ctx, 'doctor', 'Receiving doctor', text); told.push('the receiving doctor'); }
    else { await tellC(s, ctx, 'district', 'District officer', M.fill('emtWorseDistrict', { id: c.id, sign })); told.push('the district officer'); }
    told.push('PHC nurse');
    addEvent(s, ctx, '108 EMT: getting worse (' + sign + '). Told ' + told.join(', '));
    say(s, 'bot', '⚠ 108 EMT: the mother is getting worse on the way (' + sign + '). Told: ' + told.slice(0, -1).join(', ') + '.');
    await tellEmt(s, ctx, M.fill('emtWorseOk', { sign: sg.label, who: told.join(', ') }));
    return s;
  });
}

/* Demo: two mothers reach the PHC at the same time. Each gets her own case ID, hospital and 108 ambulance. */
async function twoAtOnce(s, ctx) {
  activate(s, null);
  say(s, 'bot', 'Demo: two mothers reach PHC Rampur at the same time. Mother A has heavy bleeding, Mother B has fits.');
  const fill = (typeId, extra) => { const p = {}; formFor(typeId).forEach((q) => { p[q.id] = q.options ? q.options[0] : q.value || ''; }); return Object.assign(p, extra); };
  await startReferral(s, ctx, { typeId: 'bleeding' });
  await details(s, ctx, { patient: fill('bleeding', { name: D0.mother.name, age: String(D0.mother.age), blood: D0.mother.bloodGroup, contact: D0.mother.contact, informed: 'Yes' }) });
  if (s.cur && s.cur.state === 'routed') await send(s, ctx, {});
  activate(s, null);
  await startReferral(s, ctx, { typeId: 'fits' });
  await details(s, ctx, { patient: fill('fits', { name: 'Sunita Kumari', age: '22', blood: 'O+', contact: '98XXXXXX22', informed: 'Yes' }) });
  if (s.cur && s.cur.state === 'routed') await send(s, ctx, {});
  return s;
}

const RAW = { newCase, switchCase, twoAtOnce, emtWorse, nurseText, startReferral, details, change, send, hospitalReply, ivrAnswer, skip, arrived, readyCheck, outcome, reset, checkin, missCheckin, teamReady, discharge, monthlyReport,
  feedback, setFull, drill, drillReply, drillReport, missedCall, nurseCall, eraktSync, setSettings, addHospital, removeHospital, ashaHome };
/* Every action first lifts any "full" flag whose 2 hours have passed. */
const ACTIONS = {};
Object.keys(RAW).forEach((k) => {
  ACTIONS[k] = async (s, ctx, a) => {
    ensure(s); expireFull(s, ctx); a = a || {};
    if (CASE_ACTS.includes(k)) { await withCase(s, caseFor(s, k, a), () => RAW[k](s, ctx, a)); return s; }
    return RAW[k](s, ctx, a);
  };
});

function publicView(s, now) {
  ensure(s);
  return { id: s.id, live: s.live, scenario: s.scenario, facilities: s.facilities, refs: s.refs, cur: s.cur, chat: s.chat,
    step: s.step, outbox: s.outbox.slice(-30), drill: s.drill || null, serverTime: now, replyWindowSec: C(s).replyWindowSec,
    settings: s.settings, role: null };
}

/* ---- Role logins (RBAC demo): phone number = role, one-time code shown on screen (no SMS in the demo) ---- */
const HOSPITAL_ROLES = (s) => s.facilities.filter((f) => f.kind === 'hospital' || f.kind === 'fallback').map((f) => f.id);
const OTP_MS = 5 * 60 * 1000, TOKEN_MS = 12 * 60 * 60 * 1000;
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
function loginStart(s, ctx, phone) {
  ensure(s);
  const who = (D0.roleLogins || []).find((x) => digits(x.phone) === digits(phone));
  if (!who) return null;
  const code = String(crypto.randomInt(100000, 1000000));
  s.otps[who.role] = { code, exp: ctx.now() + OTP_MS, tries: 0 };
  return { role: who.role, label: who.label, demoCode: code };
}
function loginVerify(s, ctx, phone, code) {
  ensure(s);
  const who = (D0.roleLogins || []).find((x) => digits(x.phone) === digits(phone));
  const o = who && s.otps[who.role];
  if (!o || o.exp < ctx.now() || o.tries >= 5) return null;
  o.tries += 1;
  if (String(code || '').trim() !== o.code) return null;
  delete s.otps[who.role];
  Object.keys(s.roleTokens).forEach((k) => { if (s.roleTokens[k].exp < ctx.now()) delete s.roleTokens[k]; });
  const token = crypto.randomBytes(16).toString('hex');
  s.roleTokens[token] = { role: who.role, exp: ctx.now() + TOKEN_MS };
  return { token, role: who.role, label: who.label };
}
function roleOf(s, ctx, token) {
  const t = token && s.roleTokens && s.roleTokens[token];
  return t && t.exp > ctx.now() ? t.role : null;
}
/* Which role may run which action. A hospital may only answer, check in or mark full for itself. */
const NURSE_ACTS = ['newCase', 'switchCase', 'twoAtOnce', 'nurseText', 'startReferral', 'details', 'change', 'send', 'arrived', 'readyCheck', 'outcome', 'missedCall', 'nurseCall', 'skip', 'reset'];
const HOSP_ACTS = ['hospitalReply', 'ivrAnswer', 'checkin', 'teamReady', 'discharge', 'feedback', 'setFull', 'drillReply', 'eraktSync'];
const DISTRICT_ACTS = ['monthlyReport', 'drill', 'drillReport', 'setSettings', 'addHospital', 'removeHospital', 'missCheckin', 'reset'];
function allowed(s, role, action, a) {
  if (!role) return true; // no login: the open demo, every phone on one screen
  if (role === 'nurse') return NURSE_ACTS.includes(action);
  if (role === 'district') return DISTRICT_ACTS.includes(action);
  if (role === 'asha') return action === 'ashaHome';
  if (AMBS.some((x) => x.emt === role)) { if (action !== 'emtWorse') return false; a.emt = role; return Boolean(emtCase(s, role, a.ref)); }
  if (HOSPITAL_ROLES(s).includes(role)) {
    if (!HOSP_ACTS.includes(action)) return false;
    if (CASE_ACTS.includes(action) && !a.facility && !a.ref) a.facility = role; // a hospital acts for itself
    const cid = CASE_ACTS.includes(action) ? caseFor(s, action, a) : null;
    const c = (cid && refById(s, cid)) || s.cur;
    if (['checkin', 'setFull', 'drillReply', 'eraktSync'].includes(action)) return String(a.facility || '') === role;
    if (action === 'hospitalReply') return String(a.facility || (c && c.proposal) || '') === role;
    if (action === 'ivrAnswer') return Boolean(c && c.proposal === role);
    return Boolean(c && (c.confirmed || c.destination) === role);
  }
  return false; // doctor, blood bank, driver and family only read their own messages
}
/* What one role sees: only its own messages. People who do not treat her never get her name or the case history. */
function roleView(view, role) {
  if (!role) return view;
  const clinical = role === 'nurse' || HOSPITAL_ROLES({ facilities: view.facilities }).includes(role);
  const emtAmb = AMBS.find((x) => x.emt === role); // the EMT sees only the cases in their own ambulance
  const strip = (r) => r && { id: r.id, tag: r.tag, amb: r.amb, type: r.type, state: r.state, proposal: r.proposal, backup: r.backup, backupYes: r.backupYes, confirmed: r.confirmed,
    destination: r.destination, timerStart: r.timerStart, fallbackDeclined: r.fallbackDeclined, arrived: r.arrived, teamReadyAt: r.teamReadyAt,
    dischargedAt: r.dischargedAt, feedback: r.feedback, createdAt: r.createdAt, decidedAt: r.decidedAt, firstAsked: r.firstAsked, readyOnArrival: r.readyOnArrival, events: [] };
  return Object.assign({}, view, { role,
    chat: role === 'nurse' ? view.chat : [],
    outbox: view.outbox.filter((o) => o.role === role),
    cur: clinical ? view.cur : strip(view.cur),
    refs: role === 'district' ? view.refs.map(strip) : clinical ? view.refs
      : emtAmb ? view.refs.filter((r) => (r.amb || AMBS[0].id) === emtAmb.id).map(strip) : [],
    drill: view.drill });
}

module.exports = { emtCase, CFG, FEEDBACK, blank, tick, ACTIONS, publicView, clock, eta, ivrText, ALL_ITEMS, closeDigit, closePrompt,
  loginStart, loginVerify, roleOf, allowed, roleView, caseFor, refInText, refById, isDetailsText, waCheckin, waCheckinList, waStatus };
