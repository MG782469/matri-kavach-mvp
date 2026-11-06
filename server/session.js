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

/* The demo night's check-ins are recorded at the moment the session is created (or reset), by the duty person named in the data. */
const seedFacilities = (scenario, at) => D0.facilities.map((f) => {
  const checkin = f.checkin ? { shift: f.checkin.shift, items: Object.assign({}, f.checkin.items), at, by: f.who } : null;
  if (f.kind === 'hospital' && scenario === 'nobody') { checkin.items.blood = false; checkin.items.anaesthetist = false; }
  return Object.assign({}, f, { checkin });
});

function blank(id, live, scenario, now) {
  scenario = SCENARIOS.includes(scenario) ? scenario : 'confirms';
  return { id, live: Boolean(live), scenario, facilities: seedFacilities(scenario, now || Date.now()), refs: [], cur: null,
    chat: [], step: 'start', outbox: [], links: {}, ivrAt: null, updatedAt: 0 };
}

const fac = (s, id) => s.facilities.find((f) => f.id === id);
const say = (s, from, text) => { s.chat.push({ from, text, at: Date.now() }); };
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

async function tell(s, ctx, role, label, text) {
  const r = await ctx.send(s.live, role, text);
  s.outbox.push({ at: ctx.now(), role, label, text, status: r.status, channel: r.channel, error: r.error || null });
  s.outbox = s.outbox.slice(-60);
}

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
    patient: { name: clean(p.name || D0.mother.name), age: clean(p.age, 4) || 'not given', blood: groupOf(s) },
    needs: t.needs || '', from: D0.startPoint.name, informed: p.informed || 'Not recorded',
    facts: formFor(t.id).map((q) => ({ label: q.label, value: clean(p[q.id], 20) })) };
  return (ctx.baseUrl() || '') + '/s/' + token;
}

const incomingText = (s, f) => {
  const p = (s.cur && s.cur.patient) || D0.mother;
  const t = typeOf(s);
  return M.fill('incoming', { type: t.short, needs: t.needs, eta: eta(f), group: groupOf(s) }) +
    ' Reply with the number. For 2, add the minutes, for example: 2 20.';
};
/* The 108 EMT (the clinical person in the ambulance) gets the nurse's facts. The driver does not. */
const emtText = (s, f) => {
  const p = (s.cur && s.cur.patient) || {};
  const t = typeOf(s);
  const facts = formFor(t.id).filter((q) => p[q.id]).map((q) => q.label.replace(/\?$/, '') + ': ' + clean(p[q.id], 20)).join('; ');
  return M.fill('emt', { type: t.short, name: clean(p.name || D0.mother.name), age: clean(p.age || D0.mother.age, 4), group: groupOf(s),
    facts: facts || 'not sent yet', hospital: f.short, eta: eta(f) });
};
/* The proposal always says when the hospital last checked in, and that the check-in is not a confirmation. */
const CHECK_OLD_MS = (D0.checkinValidHours || 8) * 60 * 60 * 1000;
function lastCheckText(f, ctx) {
  const c = f.checkin;
  if (!c || !c.at) return M.fill('lastCheckNone', { hospital: f.short });
  if (ctx.now() - c.at > CHECK_OLD_MS) return M.fill('lastCheckOld', { time: clock(c.at), hours: D0.checkinValidHours || 8, hospital: f.short });
  return M.fill('lastCheck', { time: clock(c.at), who: c.by || f.who, hospital: f.short });
}
const ivrText = (s, f) => M.fill('ivrScript', { type: typeOf(s).short, eta: eta(f) });

async function startReferral(s, ctx, a) {
  const t = D0.emergencyTypes.find((x) => x.id === a.typeId);
  if (!t) return s;
  if (!t.signed) { say(s, 'bot', M.T.typeNotSigned); return s; }
  setCur(s, E.startReferral(t.id, ctx.now()));
  s.step = 'details'; say(s, 'nurse', t.label);
  if (t.review) say(s, 'bot', M.fill('reviewNote', { review: t.review }));
  say(s, 'bot', M.T.details);
  return s;
}

async function details(s, ctx, a) {
  if (!s.cur || s.step !== 'details') return s;
  const p = a.patient || {};
  const patient = { name: clean(p.name), age: clean(p.age, 4), blood: clean(p.blood, 6), contact: clean(p.contact, 20),
    informed: ['Yes', 'No'].includes(p.informed) ? p.informed : 'Not recorded' };
  const form = formFor(s.cur.type);
  form.forEach((q) => { patient[q.id] = clean(p[q.id], 20); });
  s.cur = Object.assign({}, s.cur, { patient });
  const who = [patient.name, patient.age, patient.blood].filter(Boolean).join(', ');
  const key = form.slice(0, 2).filter((q) => patient[q.id]).map((q) => q.label + ' ' + patient[q.id]).join(', ');
  say(s, 'nurse', `Details sent: ${who}.${key ? ' ' + key + '.' : ''} Family informed: ${patient.informed}`);
  addEvent(s, ctx, 'Details sent. Family informed that details go to the hospital: ' + patient.informed);
  const r = E.propose(s.cur, s.facilities, CFG, ctx.now());
  setCur(s, r);
  if (r.state === 'fallback') await goFallback(s, ctx);
  else { const h = fac(s, r.proposal); say(s, 'bot', M.fill('proposed', { hospital: h.short, km: h.km, eta: eta(h) })); say(s, 'bot', lastCheckText(h, ctx)); s.step = 'proposed'; }
  return s;
}

/* Nobody confirmed: escalate to the district and PROPOSE the medical college. It is not accepted until it replies;
   the doctor, blood bank and family are told only after that. */
async function goFallback(s, ctx) {
  const mc = fac(s, 'mc');
  say(s, 'bot', M.T.fallback); say(s, 'bot', M.fill('fallbackWait', { hospital: mc.short })); s.step = 'waiting';
  await tell(s, ctx, 'district', 'District officer', M.fill('district', { id: s.cur.id }));
  await tell(s, ctx, 'driver', '108 driver', M.fill('driverFallback', { hospital: mc.short, km: mc.km }));
  await tell(s, ctx, 'emt', '108 EMT', M.fill('driverFallback', { hospital: mc.short, km: mc.km }));
  await tell(s, ctx, 'mc', mc.short, incomingText(s, mc) + ' ' + M.T.fallbackIncoming);
}

async function change(s, ctx) {
  if (!s.cur || s.cur.state !== 'routed') return s;
  const r = E.changeProposal(s.cur, s.facilities, CFG, ctx.now());
  setCur(s, r); const h = fac(s, r.proposal);
  say(s, 'nurse', 'CHANGE'); say(s, 'bot', M.fill('proposed', { hospital: h.short, km: h.km, eta: eta(h) })); say(s, 'bot', lastCheckText(h, ctx));
  return s;
}

async function send(s, ctx) {
  if (!s.cur || s.cur.state !== 'routed') return s;
  const r = E.sendTo(s.cur, ctx.now());
  setCur(s, r); s.step = 'waiting'; say(s, 'nurse', 'SEND'); say(s, 'bot', M.T.sent);
  const h = fac(s, r.proposal);
  await tell(s, ctx, 'driver', '108 driver', M.fill('driver', { from: D0.startPoint.name, hospital: h.short, km: h.km }));
  await tell(s, ctx, 'emt', '108 EMT', emtText(s, h));
  await tell(s, ctx, r.proposal, h.short, incomingText(s, h));
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
    if (typeOf(s).bloodBank) {
      const group = groupOf(s);
      const until = ctx.now() + HOLD_MIN * 60000;
      setCur(s, Object.assign({}, s.cur, { bloodHoldUntil: until }));
      addEvent(s, ctx, `Blood bank asked to hold one ${group} unit until ${clock(until)}`);
      await tell(s, ctx, 'bloodbank', 'Blood bank', M.fill('blood', { hospital: h.short, group, until: clock(until), hold: HOLD_MIN }));
    }
    await tell(s, ctx, h.id, h.short, M.T.hospAfter);
    await tell(s, ctx, 'driver', '108 driver', M.fill('driverOk', { hospital: h.short }));
    await tell(s, ctx, 'emt', '108 EMT', M.fill('emtOk', { hospital: h.short }));
    await tell(s, ctx, 'family', 'Family', M.fill('family', { hospital: h.short, eta: eta(h) }));
  } else if (r.state === 'fallback') {
    await goFallback(s, ctx);
  } else if (r.state === 'sent' && r.proposal !== prev) {
    const h = fac(s, r.proposal);
    say(s, 'bot', M.fill('reroute', { hospital: h.short })); say(s, 'bot', lastCheckText(h, ctx)); s.step = 'waiting';
    await tell(s, ctx, 'driver', '108 driver', M.fill('driverChange', { hospital: h.short, km: h.km }));
    await tell(s, ctx, 'emt', '108 EMT', M.fill('driverChange', { hospital: h.short, km: h.km }));
    await tell(s, ctx, h.id, h.short, incomingText(s, h));
  }
}

async function hospitalReply(s, ctx, a) {
  const c = s.cur;
  if (!c || !['sent', 'ivr', 'routed', 'fallback'].includes(c.state)) return s;
  const kind = a.kind === 'ready-in' ? 'ready-in' : a.kind === 'not-available' ? 'not-available' : 'all-ready';
  const minutes = kind === 'ready-in' ? Math.min(240, Math.max(1, Math.round(Number(a.minutes) || 15))) : null;
  const prev = c.proposal;
  const r = E.onHospitalReply(c, prev, kind === 'ready-in' ? { kind, minutes } : { kind }, s.facilities, CFG, ctx.now());
  if (r === c) return s;
  setCur(s, r); s.ivrAt = null;
  if (c.state === 'fallback' && r.state === 'fallback') {
    if (r.fallbackDeclined && !c.fallbackDeclined) {
      const h = fac(s, prev);
      say(s, 'bot', M.fill('fallbackDeclined', { hospital: h.short, id: r.id }));
      await tell(s, ctx, 'district', 'District officer', M.fill('fallbackDeclined', { hospital: h.short, id: r.id }));
    }
    return s;
  }
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
  if (v === 'Yes') {
    setCur(s, Object.assign({}, s.cur, { arrived: 'Yes', arrivedAt: ctx.now() })); addEvent(s, ctx, 'Arrived at the hospital'); say(s, 'nurse', 'Yes, arrived'); say(s, 'bot', M.T.readyQ);
    const h = fac(s, s.cur.confirmed || s.cur.destination);
    if (s.cur.bloodHoldUntil && h) await tell(s, ctx, 'bloodbank', 'Blood bank', M.fill('bloodIssue', { hospital: h.short, group: groupOf(s) }));
    return s;
  }
  return closeOut(s, ctx, v, null);
}

/* After arrival the nurse says whether the hospital was really ready. A "No" is a check-in mismatch the district sees. */
async function readyCheck(s, ctx, a) {
  const c = s.cur;
  if (!c || c.arrived !== 'Yes' || c.state === 'closed') return s;
  const items = E.itemsFor(c.type, CFG);
  if (!c.readyOnArrival) {
    if (a.value === 'Yes') {
      setCur(s, Object.assign({}, c, { readyOnArrival: 'Yes' })); addEvent(s, ctx, 'Nurse: everything was ready on arrival');
      say(s, 'nurse', 'Yes, all ready'); say(s, 'bot', M.T.outcomeQ); return s;
    }
    if (a.value !== 'No') return s;
    setCur(s, Object.assign({}, c, { readyOnArrival: 'No' }));
    say(s, 'nurse', 'No, something was missing');
    if (!a.missing) { say(s, 'bot', M.T.missingQ); return s; }
  }
  const cur2 = s.cur;
  if (cur2.readyOnArrival !== 'No' || cur2.missing) return s;
  const item = items.find((it) => it.id === a.missing);
  if (!item) return s;
  setCur(s, Object.assign({}, cur2, { missing: item.id }));
  addEvent(s, ctx, 'Nurse: on arrival this was missing: ' + item.label);
  say(s, 'nurse', 'Missing: ' + item.label); say(s, 'bot', M.T.outcomeQ);
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
  await tell(s, ctx, 'emt', '108 EMT', text);
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
  say(s, 'bot', M.fill('feedback', { hospital: h.short, id: c.id, value }));
  return s;
}

/* Diversion: a hospital says it is full for the next 2 hours. Routing skips it until then, or until it says OPEN. */
function expireFull(s, ctx) {
  (s.facilities || []).forEach((f) => { if (f.full && f.fullUntil <= ctx.now()) { f.full = false; f.fullUntil = null; } });
}
async function setFull(s, ctx, a) {
  const f = fac(s, String(a.facility || ''));
  if (!f || f.kind !== 'hospital') return s;
  const c = s.cur;
  if (c && ['routed', 'sent', 'ivr'].includes(c.state) && c.proposal === f.id) return s; // answer the referral with 3 instead
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
const busy = (s) => s.cur && ['referred', 'routed', 'sent', 'ivr', 'confirmed', 'fallback'].includes(s.cur.state);
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
  if (s.cur && s.step !== 'done') return s;
  if (s.step === 'done') await reset(s, ctx, {});
  say(s, 'nurse', M.T.missedCall); say(s, 'bot', M.T.callback);
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
  say(s, 'bot', M.fill('callbackDone', { type: typeOf(s).short }));
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
  say(s, 'bot', M.T.closed);
  const name = clean((r.patient || D0.mother).name);
  await tell(s, ctx, 'asha', 'PHC and ASHA', M.fill('asha', { name }));
  if (r.bloodHoldUntil && arrivedV !== 'Yes') {
    const h = fac(s, r.confirmed || r.destination);
    addEvent(s, ctx, 'Blood hold released (mother did not arrive)');
    await tell(s, ctx, 'bloodbank', 'Blood bank', M.fill('bloodRelease', { id: r.id, hospital: h ? h.short : 'the hospital', group: groupOf(s) }));
  }
  return s;
}

async function reset(s, ctx, a) {
  const fresh = blank(s.id, s.live, a.scenario || s.scenario, ctx.now());
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
  if (GREETING.test(text) && (s.step === 'done' || !s.cur)) {
    if (s.step === 'callback') s.step = 'start';
    if (s.step === 'done') await reset(s, ctx, {});
    say(s, 'nurse', text); say(s, 'bot', M.T.hello);
    return s;
  }
  const quick = text.match(QUICK);
  if (quick && (s.step === 'done' || !s.cur)) {
    if (s.step === 'done') await reset(s, ctx, {});
    const typeId = /^(fits|ecl)/i.test(quick[1]) ? 'fits' : 'bleeding';
    const group = quick[2] ? quick[2].replace(/\s+/g, '').toUpperCase().replace('POS', '+').replace('NEG', '-') : '';
    say(s, 'nurse', text);
    await startReferral(s, ctx, { typeId, quiet: true });
    say(s, 'bot', M.fill('quick', { type: typeOf(s).short, group: group || 'not given' }));
    await details(s, ctx, { patient: { name: 'Name to follow', blood: group, informed: 'Not recorded' }, quiet: true });
    return s;
  }
  if (s.step === 'callback' && /^[12]$/.test(text)) return nurseCall(s, ctx, { digit: text });
  if (s.step === 'proposed' && /^send$/i.test(text)) return send(s, ctx);
  if (s.step === 'proposed' && /^change$/i.test(text)) return change(s, ctx);
  if (s.step === 'close' && /^[1-9]$/.test(text)) return closeDigit(s, ctx, text);
  say(s, 'nurse', text);
  say(s, 'bot', s.cur ? M.T.busy : M.T.sayHi);
  return s;
}

const QUICK = /^(bleed\w*|pph|fits?|ecl\w*)\b\s*((?:ab|a|b|o)\s*(?:[+-]|pos|neg))?/i;

/* A digit typed by the nurse while closing the case (also used for WhatsApp replies). Returns the bot's next question. */
async function closeDigit(s, ctx, text) {
  const c = s.cur;
  if (!c || s.step !== 'close') return s;
  const d = text.trim()[0];
  if (!c.arrived) { const v = { 1: 'Yes', 2: 'No', 3: 'Transferred' }[d]; if (v) return arrived(s, ctx, { value: v }); }
  else if (!c.readyOnArrival) { const v = { 1: 'Yes', 2: 'No' }[d]; if (v) return readyCheck(s, ctx, { value: v }); }
  else if (c.readyOnArrival === 'No' && !c.missing) { const it = E.itemsFor(c.type, CFG)[Number(d) - 1]; if (it) return readyCheck(s, ctx, { missing: it.id }); }
  else { const v = { 1: 'Delivered', 2: 'Other' }[d]; if (v) return outcome(s, ctx, { value: v }); }
  return s;
}

/* What the nurse should be asked next while closing, as text (for WhatsApp, where buttons are numbers). */
function closePrompt(s) {
  const c = s.cur;
  if (!c || s.step !== 'close') return s.step === 'done' ? M.T.closed : null;
  if (!c.arrived) return M.T.closeQ;
  if (!c.readyOnArrival) return M.T.readyQ;
  if (c.readyOnArrival === 'No' && !c.missing) return M.T.missingQ + ' ' + E.itemsFor(c.type, CFG).map((it, i) => `${i + 1} ${it.label}`).join('. ');
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
  f.checkin = { shift: 'night', items, at: ctx.now(), by: f.who };
  f.missed = false;
  const yes = ALL_ITEMS.filter((it) => items[it.id] === true).length;
  const unknown = ALL_ITEMS.filter((it) => items[it.id] !== true && items[it.id] !== false).length;
  const readyFor = ROUTED_TYPES.filter((t) => E.facilityStatus(f, CFG, t.id) === 'ready').map((t) => t.short);
  await tell(s, ctx, f.id, f.short, M.fill('checkinSaved', { hospital: f.short, who: f.who, yes, no: ALL_ITEMS.length - yes - unknown,
    missing: unknown ? ', ' + unknown + ' not answered (counted as not ready)' : '', readyFor: readyFor.length ? readyFor.join(', ') : 'none' }));
  return s;
}

/* Demo: a hospital misses its shift check-in. It turns Uncertain, gets a reminder, and the district officer is told. */
async function missCheckin(s, ctx, a) {
  const f = fac(s, String(a.facility || 'dh'));
  if (!f || f.kind !== 'hospital' || (s.cur && ['routed', 'sent', 'ivr'].includes(s.cur.state))) return s;
  f.checkin = null; f.missed = true;
  await tell(s, ctx, f.id, f.short, M.fill('checkinRemind', { hospital: f.short }));
  await tell(s, ctx, 'district', 'District officer', M.fill('checkinEscalate', { hospital: f.short }));
  return s;
}

const RAW = { nurseText, startReferral, details, change, send, hospitalReply, ivrAnswer, skip, arrived, readyCheck, outcome, reset, checkin, missCheckin, teamReady, discharge, monthlyReport,
  feedback, setFull, drill, drillReply, drillReport, missedCall, nurseCall };
/* Every action first lifts any "full" flag whose 2 hours have passed. */
const ACTIONS = {};
Object.keys(RAW).forEach((k) => { ACTIONS[k] = (s, ctx, a) => { expireFull(s, ctx); return RAW[k](s, ctx, a || {}); }; });

function publicView(s, now) {
  return { id: s.id, live: s.live, scenario: s.scenario, facilities: s.facilities, refs: s.refs, cur: s.cur, chat: s.chat,
    step: s.step, outbox: s.outbox.slice(-30), drill: s.drill || null, serverTime: now, replyWindowSec: CFG.replyWindowSec };
}

module.exports = { CFG, FEEDBACK, blank, tick, ACTIONS, publicView, clock, eta, ivrText, ALL_ITEMS, closeDigit, closePrompt };
