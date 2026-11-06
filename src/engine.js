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

  // Blood group as written on the MCP card, cleaned to A+, B-, AB+ ... or '' if not known.
  function normGroup(g) {
    var m = String(g || '').toUpperCase().replace(/\s+/g, '').replace('POS', '+').replace('NEG', '-').match(/^(AB|A|B|O)([+-])$/);
    return m ? m[1] + m[2] : '';
  }

  // If the hospital keeps blood stock per group and the mother's group is known, the blood item needs a unit of her group.
  function lacksGroup(f, D, typeId, group) {
    var g = normGroup(group);
    if (!g || !f.bloodStock) return false;
    var needsBlood = itemsFor(typeId, D).some(function (it) { return it.id === 'blood'; });
    return needsBlood && !((f.bloodStock[g] || 0) > 0);
  }

  function facilityStatus(f, D, typeId, group) {
    if (f.full) return 'full'; // the hospital said it is full (diversion) for the next hours
    if (!f.checkin) return 'uncertain';
    var ok = itemsFor(typeId, D).every(function (item) { return f.checkin.items[item.id] === true; });
    if (ok && lacksGroup(f, D, typeId, group)) return 'not-ready';
    return ok ? 'ready' : 'not-ready';
  }

  // What a hospital is missing tonight for this emergency (used for the supply idea and for messages).
  function missingFor(f, D, typeId, group) {
    if (!f.checkin) return null;
    var miss = itemsFor(typeId, D).filter(function (item) { return f.checkin.items[item.id] !== true; }).map(function (it) { return it.id; });
    if (miss.indexOf('blood') === -1 && lacksGroup(f, D, typeId, group)) miss.push('blood');
    return miss;
  }

  function candidatesFor(facilities, D, tried, typeId, group) {
    tried = tried || [];
    return facilities
      .filter(function (f) { return f.kind === 'hospital' && tried.indexOf(f.id) === -1; })
      .filter(function (f) { return facilityStatus(f, D, typeId, group) === 'ready'; })
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

  function groupOfRef(ref) { return ref.patient ? ref.patient.blood : ''; }

  function propose(ref, facilities, D, now) {
    var c = candidatesFor(facilities, D, ref.tried, ref.type, groupOfRef(ref));
    if (c.length) {
      var first = c[0];
      return Object.assign({}, ref, { state: 'routed', proposal: first.id, destination: first.id,
        events: note(ref, now, 'Proposed ' + first.name + ', ' + first.km + ' km, about ' + first.eta + ' min') });
    }
    return sendToFallback(ref, now);
  }

  function changeProposal(ref, facilities, D, now) {
    if (ref.state !== 'routed') return ref;
    var c = candidatesFor(facilities, D, ref.tried.concat([ref.proposal]), ref.type, groupOfRef(ref));
    if (!c.length) return ref;
    var next = c[0];
    return Object.assign({}, ref, { proposal: next.id, destination: next.id,
      events: note(ref, now, 'Nurse changed the proposal to ' + next.name) });
  }

  // backupId (optional): the next ready hospital, asked at the same moment. The nearer one (the proposal) has priority.
  function sendTo(ref, now, backupId) {
    if (ref.state !== 'routed') return ref;
    var b = backupId && backupId !== ref.proposal ? backupId : null;
    return Object.assign({}, ref, { state: 'sent', timerStart: now, firstAsked: ref.firstAsked || ref.proposal, backup: b, backupYes: null,
      events: note(ref, now, 'SEND: ambulance 108 told the destination. Hospital asked to confirm' + (b ? '; next hospital asked at the same time as backup' : '')) });
  }

  // The second-nearest ready hospital, to ask in parallel. Null when there is none.
  function pickBackup(ref, facilities, D) {
    var c = candidatesFor(facilities, D, ref.tried.concat([ref.proposal]), ref.type, groupOfRef(ref));
    return c.length ? c[0].id : null;
  }

  // The backup said yes and the nearer hospital said no or stayed silent: the backup is the destination.
  function confirmBackup(ref, facilities, now, cancelPrimary) {
    var y = ref.backupYes, id = ref.backup;
    return Object.assign({}, ref, { state: 'confirmed', proposal: id, destination: id, confirmed: id, readyIn: y.minutes || null, decidedAt: now,
      cancelled: cancelPrimary ? ref.proposal : null, backup: null, backupYes: null,
      tried: cancelPrimary ? ref.tried.concat([ref.proposal]) : ref.tried,
      events: note(ref, now, nameOf(facilities, id) + ' confirmed ' + (y.minutes ? 'ready in ' + y.minutes + ' min' : 'ALL READY') + ' (asked in parallel)' + (cancelPrimary ? '; ' + nameOf(facilities, ref.proposal) + ' told it is no longer needed' : '')) });
  }

  function sendToFallback(ref, now) {
    // The medical college is only proposed. It still has to confirm, and the district coordinates with the clinicians.
    return Object.assign({}, ref, { state: 'fallback', destination: 'mc', proposal: 'mc', districtAlert: true,
      events: note(ref, now, 'No hospital confirmed readiness. District emergency escalation initiated. Medical college proposed as tertiary fallback, awaiting confirmation') });
  }

  // After a reroute the ambulance is told the new hospital at once, and the 2-minute timer starts again.
  function reroute(ref, facilities, D, now) {
    if (ref.backup && ref.backupYes) return confirmBackup(ref, facilities, now, false);
    if (ref.backup) {
      // The backup was already asked: it becomes the first choice with a fresh timer, and the next hospital becomes the backup.
      var p0 = Object.assign({}, ref, { state: 'routed', proposal: ref.backup, destination: ref.backup, backup: null, backupYes: null });
      var nb = D.parallel ? pickBackup(p0, facilities, D) : null;
      return Object.assign({}, p0, { state: 'sent', timerStart: now, backup: nb,
        events: note(ref, now, 'Rerouted to ' + nameOf(facilities, ref.backup) + ' (already asked in parallel)' + (nb ? '; ' + nameOf(facilities, nb) + ' asked as the new backup' : '')) });
    }
    var p = propose(ref, facilities, D, now);
    return p.state === 'routed' ? sendTo(p, now, D.parallel ? pickBackup(p, facilities, D) : null) : p;
  }

  function nameOf(facilities, id) { var f = (facilities || []).filter(function (x) { return x.id === id; })[0]; return f ? f.name : id; }

  function onHospitalReply(ref, facilityId, reply, facilities, D, now) {
    if (ref.backup && facilityId === ref.backup && facilityId !== ref.proposal) return onBackupReply(ref, reply, facilities, now);
    if (facilityId !== ref.proposal && facilityId !== ref.destination) return ref;
    var fname = nameOf(facilities, facilityId);
    if (reply.kind === 'all-ready' || reply.kind === 'ready-in') {
      var min = reply.kind === 'ready-in' ? reply.minutes : null;
      return Object.assign({}, ref, { state: 'confirmed', confirmed: facilityId, readyIn: min, decidedAt: now,
        cancelled: ref.backup || null, backup: null, backupYes: null,
        events: note(ref, now, fname + ' confirmed ' + (min ? 'ready in ' + min + ' min' : 'ALL READY') + (ref.backup ? '; ' + nameOf(facilities, ref.backup) + ' (backup) told it is no longer needed' : '')) });
    }
    if (reply.kind === 'not-available' && ref.state === 'fallback') {
      return Object.assign({}, ref, { fallbackDeclined: true,
        events: note(ref, now, fname + ' cannot confirm. District and clinicians coordinating the destination') });
    }
    if (reply.kind === 'not-available') {
      var moved = Object.assign({}, ref, { tried: ref.tried.concat([facilityId]),
        events: note(ref, now, fname + ' not available. Rerouting') });
      return reroute(moved, facilities, D, now);
    }
    return ref;
  }

  // A reply from the hospital asked in parallel. A yes waits: the nearer hospital keeps priority until its 2 minutes end.
  function onBackupReply(ref, reply, facilities, now) {
    if (['sent', 'ivr'].indexOf(ref.state) === -1 || ref.backupYes) return ref;
    var bname = nameOf(facilities, ref.backup);
    if (reply.kind === 'all-ready' || reply.kind === 'ready-in') {
      var y = { kind: reply.kind, minutes: reply.kind === 'ready-in' ? reply.minutes : null, at: now };
      return Object.assign({}, ref, { backupYes: y,
        events: note(ref, now, bname + ' (backup) said ' + (y.minutes ? 'ready in ' + y.minutes + ' min' : 'ALL READY') + '; waiting for ' + nameOf(facilities, ref.proposal) + ', which is nearer and has priority') });
    }
    if (reply.kind === 'not-available') {
      return Object.assign({}, ref, { tried: ref.tried.concat([ref.backup]), backup: null, backupYes: null, backupDeclined: ref.backup,
        events: note(ref, now, bname + ' (backup) not available') });
    }
    return ref;
  }

  function onTimeout(ref, now, D, facilities) {
    if (ref.state !== 'sent') return ref;
    if (now - ref.timerStart < D.replyWindowSec * 1000) return ref;
    if (ref.backup && ref.backupYes) return confirmBackup(Object.assign({}, ref, { events: note(ref, now, 'No reply from ' + nameOf(facilities, ref.proposal) + ' in 2 minutes') }), facilities, now, true);
    return Object.assign({}, ref, { state: 'ivr', ivrCalled: true,
      events: note(ref, now, 'No reply in 2 minutes. IVR call to the duty phone') });
  }

  function onIVR(ref, answer, facilities, D, now) {
    if (ref.state !== 'ivr') return ref;
    if (answer === '1') {
      return Object.assign({}, ref, { state: 'confirmed', confirmed: ref.proposal, decidedAt: now, cancelled: ref.backup || null, backup: null, backupYes: null,
        events: note(ref, now, nameOf(facilities, ref.proposal) + ' confirmed by IVR' + (ref.backup ? '; ' + nameOf(facilities, ref.backup) + ' (backup) told it is no longer needed' : '')) });
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
    closedLoopRate: closedLoopRate, kpis: kpis, sendToFallback: sendToFallback, reroute: reroute,
    pickBackup: pickBackup, normGroup: normGroup, missingFor: missingFor, lacksGroup: lacksGroup
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.MK = root.MK || {}; root.MK.engine = api;
})(typeof window !== 'undefined' ? window : globalThis);
