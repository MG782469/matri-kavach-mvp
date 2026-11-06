/* Matri-Kavach routing engine. Pure functions only: no DOM, no timers, no randomness.
   Every function takes the clock value (ms) and returns a new referral object. */
(function (root) {
  function data() {
    return typeof module !== 'undefined' && module.exports ? require('./data.js') : root.MK.DATA;
  }

  function etaMinutes(km, D) {
    return Math.round((km / D.speedKmh) * 60 * D.detourFactor);
  }

  // Ready = every checklist item yes in the current shift.
  // Uncertain = no check-in in the current shift. Never routed as Ready.
  // The checklist items one emergency type needs. Unknown type = the heavy bleeding list.
  function itemsFor(typeId, D) {
    var all = D.checklistItems.concat(D.extraItems || []);
    var t = (D.emergencyTypes || []).filter(function (x) { return x.id === typeId; })[0];
    if (!t || !t.items) return D.checklistItems;
    return t.items.map(function (id) { return all.filter(function (it) { return it.id === id; })[0]; }).filter(Boolean);
  }

  function facilityStatus(f, D, typeId) {
    if (f.full) return 'full'; // the hospital said it is full (diversion) for the next hours
    if (!f.checkin) return 'uncertain';
    var ok = itemsFor(typeId, D).every(function (item) { return f.checkin.items[item.id] === true; });
    return ok ? 'ready' : 'not-ready';
  }

  function candidatesFor(facilities, D, tried, typeId) {
    tried = tried || [];
    return facilities
      .filter(function (f) { return f.kind === 'hospital' && tried.indexOf(f.id) === -1; })
      .filter(function (f) { return facilityStatus(f, D, typeId) === 'ready'; })
      .map(function (f) { return { id: f.id, name: f.short, km: f.km, eta: etaMinutes(f.km, D) }; })
      .sort(function (a, b) { return a.eta - b.eta || a.km - b.km; });
  }

  function note(ref, at, text) {
    return ref.events.concat([{ at: at, text: text }]);
  }

  function startReferral(typeId, now) {
    return {
      id: 'MK-' + String(now).slice(-6), type: typeId, state: 'referred', createdAt: now,
      proposal: null, tried: [], destination: null, confirmed: null, readyIn: null,
      timerStart: null, ivrCalled: false, districtAlert: false, arrived: null, outcome: null,
      closedAt: null, events: [{ at: now, text: 'Referral started by nurse' }]
    };
  }

  function propose(ref, facilities, D, now) {
    var c = candidatesFor(facilities, D, ref.tried, ref.type);
    if (c.length) {
      var first = c[0];
      return Object.assign({}, ref, { state: 'routed', proposal: first.id, destination: first.id,
        events: note(ref, now, 'Proposed ' + first.name + ', ' + first.km + ' km, about ' + first.eta + ' min') });
    }
    return sendToFallback(ref, now);
  }

  function changeProposal(ref, facilities, D, now) {
    if (ref.state !== 'routed') return ref;
    var c = candidatesFor(facilities, D, ref.tried.concat([ref.proposal]), ref.type);
    if (!c.length) return ref;
    var next = c[0];
    return Object.assign({}, ref, { proposal: next.id, destination: next.id,
      events: note(ref, now, 'Nurse changed the proposal to ' + next.name) });
  }

  function sendTo(ref, now) {
    if (ref.state !== 'routed') return ref;
    return Object.assign({}, ref, { state: 'sent', timerStart: now, firstAsked: ref.firstAsked || ref.proposal,
      events: note(ref, now, 'SEND: ambulance 108 told the destination. Hospital asked to confirm') });
  }

  function sendToFallback(ref, now) {
    return Object.assign({}, ref, { state: 'fallback', destination: 'mc', proposal: 'mc', districtAlert: true, decidedAt: now,
      events: note(ref, now, 'No Ready hospital. Medical college is the destination. District officer alerted') });
  }

  // After a reroute the ambulance is told the new hospital at once, and the 2-minute timer starts again.
  function reroute(ref, facilities, D, now) {
    var p = propose(ref, facilities, D, now);
    return p.state === 'routed' ? sendTo(p, now) : p;
  }

  function nameOf(facilities, id) { var f = (facilities || []).filter(function (x) { return x.id === id; })[0]; return f ? f.name : id; }

  function onHospitalReply(ref, facilityId, reply, facilities, D, now) {
    if (facilityId !== ref.proposal && facilityId !== ref.destination) return ref;
    var fname = nameOf(facilities, facilityId);
    if (reply.kind === 'all-ready' || reply.kind === 'ready-in') {
      var min = reply.kind === 'ready-in' ? reply.minutes : null;
      return Object.assign({}, ref, { state: 'confirmed', confirmed: facilityId, readyIn: min, decidedAt: now,
        events: note(ref, now, fname + ' confirmed ' + (min ? 'ready in ' + min + ' min' : 'ALL READY')) });
    }
    if (reply.kind === 'not-available') {
      var moved = Object.assign({}, ref, { tried: ref.tried.concat([facilityId]),
        events: note(ref, now, fname + ' not available. Rerouting') });
      return reroute(moved, facilities, D, now);
    }
    return ref;
  }

  function onTimeout(ref, now, D) {
    if (ref.state !== 'sent') return ref;
    if (now - ref.timerStart < D.replyWindowSec * 1000) return ref;
    return Object.assign({}, ref, { state: 'ivr', ivrCalled: true,
      events: note(ref, now, 'No reply in 2 minutes. IVR call to the duty phone') });
  }

  function onIVR(ref, answer, facilities, D, now) {
    if (ref.state !== 'ivr') return ref;
    if (answer === '1') {
      return Object.assign({}, ref, { state: 'confirmed', confirmed: ref.proposal, decidedAt: now,
        events: note(ref, now, nameOf(facilities, ref.proposal) + ' confirmed by IVR') });
    }
    var moved = Object.assign({}, ref, { tried: ref.tried.concat([ref.proposal]),
      events: note(ref, now, 'IVR not answered. Rerouting to the backup') });
    return reroute(moved, facilities, D, now);
  }

  function onClose(ref, arrived, outcome, now) {
    if (ref.state !== 'confirmed' && ref.state !== 'fallback') return ref;
    return Object.assign({}, ref, { state: 'closed', arrived: arrived, outcome: outcome, closedAt: now,
      events: note(ref, now, 'Closed: ' + arrived + ', outcome ' + outcome) });
  }

  function closedLoopRate(refs) {
    if (!refs.length) return 0;
    var closed = refs.filter(function (r) { return r.state === 'closed'; }).length;
    return closed / refs.length;
  }

  /* District KPIs from this session's referrals.
     Door time is estimated: minutes from the start of the referral to the hospital decision, plus the road ETA. */
  function kpis(refs, facilities, D) {
    function median(a) { if (!a.length) return null; a = a.slice().sort(function (x, y) { return x - y; }); var m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
    var door = refs.filter(function (r) { return r.decidedAt; }).map(function (r) {
      var f = (facilities || []).filter(function (x) { return x.id === (r.confirmed || r.destination); })[0];
      return Math.round((r.decidedAt - r.createdAt) / 60000 + (f ? etaMinutes(f.km, D) : 0));
    });
    var asked = refs.filter(function (r) { return r.firstAsked && (r.confirmed || r.state === 'fallback' || r.state === 'closed'); });
    var checked = refs.filter(function (r) { return r.readyOnArrival; });
    var reply = refs.filter(function (r) { return r.confirmed && r.timerStart && r.decidedAt; }).map(function (r) { return Math.round((r.decidedAt - r.timerStart) / 1000); });
    return {
      cases: refs.length,
      doorMin: median(door),
      firstReadyPct: asked.length ? Math.round(100 * asked.filter(function (r) { return r.confirmed === r.firstAsked; }).length / asked.length) : null,
      mismatches: checked.filter(function (r) { return r.readyOnArrival === 'No'; }).length,
      checked: checked.length,
      replySec: median(reply),
      closedPct: refs.length ? Math.round(100 * closedLoopRate(refs)) : null
    };
  }

  var api = {
    etaMinutes: etaMinutes, itemsFor: itemsFor, facilityStatus: facilityStatus, candidatesFor: candidatesFor,
    startReferral: startReferral, propose: propose, changeProposal: changeProposal, sendTo: sendTo,
    onHospitalReply: onHospitalReply, onTimeout: onTimeout, onIVR: onIVR, onClose: onClose,
    closedLoopRate: closedLoopRate, kpis: kpis, sendToFallback: sendToFallback, reroute: reroute
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MK = root.MK || {}; root.MK.engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
