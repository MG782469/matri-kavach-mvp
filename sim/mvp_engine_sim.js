/* Simulation that drives the REAL MVP routing engine (src/engine.js) on a synthetic district.
   Same district and assumptions as Matri-Kavach_v3_simulation.py, so the two can be compared.
   All data is synthetic. Run: node sim/mvp_engine_sim.js  (writes sim/mvp_engine_sim.json)

   What comes from the MVP engine (not re-implemented here):
     - which hospital is proposed: only hospitals whose shift check-in has every checklist item = yes,
       nearest by ETA (engine.propose / candidatesFor)
     - reroute on "not available" or on no reply + IVR not answered (onHospitalReply, onTimeout, onIVR)
     - fallback when no checked-in Ready hospital is left: medical college proposed, must confirm
   What the simulation adds: positions, true readiness, check-in errors, reply times and driving. */
'use strict';
const E = require('../src/engine.js');
const D = require('../src/data.js');

// Same synthetic district as the Python script (positions in km, chance of being ready at night).
const H = [
  { id: 'chc1', name: 'CHC-1', x: 15, y: 15, p: 0.45 },
  { id: 'chc2', name: 'CHC-2', x: 45, y: 15, p: 0.45 },
  { id: 'chc3', name: 'CHC-3', x: 15, y: 45, p: 0.40 },
  { id: 'dh', name: 'District Hospital', x: 35, y: 35, p: 0.75 },
  { id: 'mc', name: 'Medical College', x: 55, y: 50, p: 0.97, fallback: true }
];
const A = { speedKmh: D.speedKmh, detour: D.detourFactor, lostAtUnreadyMin: 60, replyMin: 2, ivrExtraMin: 3,
  ivrShare: 0.15, checkinCorrect: 0.9, wrongReady: 0.05, n: 20000 };

function rng(seed) { // mulberry32, so every run is repeatable
  let a = seed >>> 0;
  return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const tt = (a, b) => dist(a, b) * A.detour / (A.speedKmh / 60); // minutes, same formula as the Python script
function move(pos, tgt, min) { // drive toward tgt for min minutes; returns [newPos, minutesUsed]
  const full = tt(pos, tgt); if (full <= 0) return [{ x: tgt.x, y: tgt.y }, 0];
  const f = Math.min(1, min / full);
  return [{ x: pos.x + (tgt.x - pos.x) * f, y: pos.y + (tgt.y - pos.y) * f }, Math.min(min, full)];
}
const ALL_YES = () => Object.fromEntries(D.checklistItems.map(i => [i.id, true]));

// One synthetic case: everything random is drawn here, so both policies see exactly the same case.
function makeCase(r, phcs, compliance) {
  const phc = phcs[Math.floor(r() * phcs.length)];
  const c = { phc, ready: {}, checkin: {}, ivr: {}, wrongReady: {} };
  for (const h of H) {
    c.ready[h.id] = h.fallback ? true : r() < h.p; // the medical college confirms (same as the Python script)
    const done = r() < compliance, correct = r() < A.checkinCorrect;
    c.checkin[h.id] = done ? (correct ? c.ready[h.id] : !c.ready[h.id]) : null; // null = no check-in this shift
    c.ivr[h.id] = r() < A.ivrShare; c.wrongReady[h.id] = r() < A.wrongReady;
  }
  return c;
}

function facilitiesFor(c, from) { // the shape src/engine.js expects
  return H.map(h => {
    const k = c.checkin[h.id];
    const items = ALL_YES(); if (k === false) items.anaesthetist = false; // a "not ready" check-in has a no
    return { id: h.id, name: h.name, short: h.name, km: Math.round(dist(from, h)), kind: h.fallback ? 'fallback' : 'hospital',
      checkin: k === null && !h.fallback ? null : { shift: 'night', items } };
  });
}

function runNearest(c) { // today: nearest untried facility, 60 min lost at an unready one
  let pos = c.phc, t = 0, stops = 0; const tried = new Set();
  for (;;) {
    const h = H.filter(x => !tried.has(x.id)).sort((a, b) => tt(pos, a) - tt(pos, b))[0];
    t += tt(pos, h); pos = h; stops++; tried.add(h.id);
    if (c.ready[h.id] || h.fallback) return { t, stops, firstStopReady: stops === 1, rerouted: false, fallback: false, firstAskedReady: stops === 1 };
    t += A.lostAtUnreadyMin;
  }
}

function runMvp(c) {
  let pos = c.phc, t = 0, stops = 0, rerouted = false, fallback = false, firstAsked = null;
  let F = facilitiesFor(c, c.phc);
  let ref = E.propose(E.startReferral('bleeding', 0), F, D, 0);
  for (let guard = 0; guard < 20; guard++) {
    if (ref.state === 'routed') ref = E.sendTo(ref, 0);
    const id = ref.destination, h = H.find(x => x.id === id);
    if (firstAsked === null) firstAsked = id;
    if (ref.state === 'fallback') fallback = true;
    const ready = c.ready[id];
    const ivr = !h.fallback && c.ivr[id];
    const wait = A.replyMin + (ivr ? A.ivrExtraMin : 0);
    let used; [pos, used] = move(pos, h, wait); t += used; // the ambulance drives while the hospital answers
    if (ready || (!h.fallback && c.wrongReady[id])) { // hospital says yes (rightly, or wrongly 5% of the time)
      if (ivr) { ref = E.onTimeout(ref, D.replyWindowSec * 1000, D); ref = E.onIVR(ref, '1', F, D, 0); }
      else ref = E.onHospitalReply(ref, id, { kind: 'all-ready' }, F, D, 0);
      if (ref.state !== 'confirmed') throw new Error('engine did not confirm ' + id + ' from ' + ref.state);
      t += tt(pos, h); pos = h; stops++;
      if (ready) return { t, stops, firstStopReady: stops === 1, rerouted, fallback, firstAskedReady: c.ready[firstAsked] };
      // wrong yes: found out on arrival, 60 min lost, a new referral starts from this hospital
      t += A.lostAtUnreadyMin;
      const tried = ref.tried.concat([id]);
      F = facilitiesFor(c, h);
      ref = E.propose(Object.assign(E.startReferral('bleeding', 0), { tried }), F, D, 0);
      continue;
    }
    // hospital says no, or does not answer and the IVR is not answered: the engine reroutes
    rerouted = true;
    if (ivr) { ref = E.onTimeout(ref, D.replyWindowSec * 1000, D); ref = E.onIVR(ref, '2', F, D, 0); }
    else ref = E.onHospitalReply(ref, id, { kind: 'not-available' }, F, D, 0);
  }
  throw new Error('no end');
}

function summary(rs) {
  const T = rs.map(r => r.t).sort((a, b) => a - b), n = rs.length;
  const pct = f => Math.round(1000 * rs.filter(f).length / n) / 10;
  return { median_min: Math.round(T[Math.floor(n / 2)]), mean_min: Math.round(T.reduce((a, b) => a + b, 0) / n),
    p90_min: Math.round(T[Math.floor(0.9 * n)]),
    pct_ready_on_first_physical_stop: pct(r => r.firstStopReady),
    pct_first_hospital_asked_was_ready: pct(r => r.firstAskedReady),
    pct_2plus_physical_stops: pct(r => r.stops >= 2),
    pct_rerouted_in_transit: pct(r => r.rerouted),
    pct_medical_college_fallback: pct(r => r.fallback) };
}

function run(seed, compliance) {
  const r = rng(seed);
  const phcs = Array.from({ length: 15 }, () => ({ x: r() * 60, y: r() * 60 }));
  const near = [], mvp = [];
  for (let i = 0; i < A.n; i++) { const c = makeCase(r, phcs, compliance); near.push(runNearest(c)); mvp.push(runMvp(c)); }
  return { nearest: summary(near), mvp_engine: summary(mvp) };
}

const out = { note: 'Synthetic only. Drives src/engine.js. Same district as Matri-Kavach_v3_simulation.py.', assumptions: A, runs: {} };
for (const comp of [0.85, 0.6, 0]) out.runs['checkins_' + Math.round(comp * 100) + 'pct_seed1'] = run(1, comp);
for (const s of [2, 3, 4, 5]) out.runs['checkins_85pct_seed' + s] = run(s, 0.85);
require('fs').writeFileSync(require('path').join(__dirname, 'mvp_engine_sim.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.runs, null, 1));
