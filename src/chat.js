/* WhatsApp-style view of the same live MVP. Every tap calls the same server actions as the dashboard view
   (/api/act), so the routing rules, the 2-minute timer and the messages are exactly the same. */
(function (root) {
  var MK = root.MK, D = MK.DATA, M = MK.messages;
  var SID = null, KEY = null, ST = null, OFFSET = 0, BUSY = false, LAST = '', VIEW = 'nurse', SEEN = null;
  var ECHO = {}; // replies tapped on a hospital phone in this browser, shown as sent messages
  var CK = null; // check-in being filled on a hospital phone: { facility, items }
  var ALL_ITEMS = D.checklistItems.concat(D.extraItems || []);
  var AUTO = null; // auto-play: { i, total, text, stop }

  var PHONES = [
    { id: 'nurse', label: 'Nurse', owner: 'Nurse Kavitha, PHC Rampur' },
    { id: 'dh', label: 'DH Devgarh', owner: 'Labour room, DH Devgarh' },
    { id: 'sdh', label: 'SDH Kheri', owner: 'Labour room, SDH Kheri' },
    { id: 'chc', label: 'CHC Sonpur', owner: 'Duty phone, CHC Sonpur' },
    { id: 'mc', label: 'GMC Rajnagar', owner: 'Emergency desk, GMC Rajnagar' },
    { id: 'doctor', label: 'Doctor', owner: 'Receiving doctor' },
    { id: 'bloodbank', label: 'Blood bank', owner: 'Blood bank' },
    { id: 'family', label: 'Family', owner: 'Mother’s family' },
    { id: 'driver', label: '108 driver', owner: '108 ambulance driver' },
    { id: 'emt', label: '108 EMT', owner: '108 ambulance EMT' },
    { id: 'district', label: 'District officer', owner: 'District MH officer' },
    { id: 'asha', label: 'PHC and ASHA', owner: 'PHC and ASHA Sunita' }
  ];

  function $(id) { return document.getElementById(id); }
  function now() { return Date.now() + OFFSET; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function linkify(s) { return esc(s).replace(/(https?:\/\/[^\s<]+|\/s\/[a-f0-9.]+)/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; }); }
  function clock(ms) { return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toLowerCase(); }
  function fac(id) { return ((ST && ST.facilities) || D.facilities).filter(function (f) { return f.id === id; })[0]; }
  function cur() { return ST && ST.cur; }
  function typeOf() { var id = (cur() && cur().type) || 'bleeding'; return D.emergencyTypes.filter(function (t) { return t.id === id; })[0]; }
  function isHospital(id) { var f = fac(id); return f && (f.kind === 'hospital' || f.kind === 'fallback'); }

  /* ---------- messages for one phone ---------- */
  function nurseMsgs() {
    var t0 = ST.serverTime;
    return (ST.chat || []).map(function (m) { return { dir: m.from === 'nurse' ? 'out' : 'in', text: m.text, at: m.at || t0 }; });
  }
  function phoneMsgs(role) {
    var list = (ST.outbox || []).filter(function (o) { return o.role === role; }).map(function (o) {
      return { dir: 'in', text: o.text, at: o.at, call: /^No-reply call/.test(o.label || ''), incoming: /^INCOMING/.test(o.text || '') };
    });
    (ECHO[role] || []).forEach(function (e) { if (!ST.cur || e.ref === ST.cur.id) list.push({ dir: 'out', text: e.text, at: e.at }); });
    return list.sort(function (a, b) { return a.at - b.at; });
  }
  function msgsFor(role) { return role === 'nurse' ? nurseMsgs() : phoneMsgs(role); }
  function countIn(role) { return msgsFor(role).filter(function (m) { return m.dir === 'in'; }).length; }

  /* ---------- buttons a WhatsApp interactive message would carry ---------- */
  function nurseButtons() {
    var r = cur(), step = ST.step;
    if (step === 'start') return { list: 'Choose emergency', act: 'pick-type' };
    if (step === 'callback') return { btns: [['ncall', '1', 'Press 1: Heavy bleeding'], ['ncall', '2', 'Press 2: Fits / eclampsia']] };
    if (step === 'details') return { list: 'Fill patient details', act: 'open-details' };
    if (step === 'proposed') return { row: [['send', '', 'SEND'], ['change', '', 'CHANGE']] };
    if (step === 'close' && r && !r.arrived) return { extra: M.T.closeQ, btns: [['arrived', 'Yes', '1 Yes, arrived'], ['arrived', 'No', '2 No'], ['arrived', 'Transferred', '3 Transferred']] };
    if (step === 'close' && r && r.arrived === 'Yes' && !r.readyOnArrival) return { btns: [['ready', 'Yes', '1 Yes, all ready'], ['ready', 'No', '2 No, something missing']] };
    if (step === 'close' && r && r.readyOnArrival === 'No' && !r.missing) return { btns: MK.engine.itemsFor(r.type, D).map(function (it) { return ['missing', it.id, it.label]; }) };
    if (step === 'close' && r && r.arrived === 'Yes' && !r.outcome) return { btns: [['outcome', 'Delivered', '1 Delivered'], ['outcome', 'Other', '2 Other']] };
    return null;
  }
  function hospitalCanReply(role) { var r = cur(); return r && r.proposal === role && ['sent', 'routed', 'ivr'].indexOf(r.state) !== -1; }

  function drillPending(role) { var d = ST.drill; return d && !d.done && d.ids.indexOf(role) !== -1 && d.replies[role] == null && !hospitalCanReply(role); }
  /* Buttons a hospital phone shows after it confirmed: team ready, discharge, feedback. Plus the drill reply. */
  function hospitalAfter(role) {
    if (!isHospital(role)) return [];
    if (drillPending(role)) return [['drillok', '', '1 Drill received']];
    var r = cur(); if (!r || (r.confirmed || r.destination) !== role) return [];
    if (r.state === 'confirmed' && !r.teamReadyAt && !r.arrived) return [['team', '', 'Team ready at the door']];
    if (r.dischargedAt && !r.feedback) return [r.confirmed || r.destination, 'The hospital can tell the PHC if the referral was on time. This is for learning at the PHC monthly review.'];
    if (r.state === 'closed' && r.arrived === 'Yes' && !r.dischargedAt) return [['discharge', '', 'Mark discharged home']];
    if (r.dischargedAt && !r.feedback) return [['fb', '1', '1 On time'], ['fb', '2', '2 Should have come earlier'], ['fb', '3', '3 Could have been managed at the PHC']];
    return [];
  }
  function btnHtml(b) { return '<button data-act="' + b[0] + '" data-v="' + esc(b[1]) + '">' + esc(b[2]) + '</button>'; }

  function bubble(m, extra) {
    var tk = m.dir === 'out' ? '<span class="tk">✓✓</span>' : '';
    var body;
    if (m.call) body = '<span class="callrec"><span class="cic">📞</span><span><b>Voice call</b><br><span class="foot2">' + esc(m.text) + '</span></span></span>';
    else if (m.incoming) body = '<span class="hdr">🚨 Incoming referral</span>' + linkify(m.text);
    else body = linkify(m.text);
    return '<div class="grp ' + m.dir + '"><div class="bub">' + body + '<span class="meta">' + clock(m.at) + tk + '</span></div>' + (extra || '') + '</div>';
  }

  function renderMsgs() {
    var el = $('msgs');
    var near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    var list = msgsFor(VIEW), r = cur(), html = '<div class="day">Today</div>';
    html += '<div class="sysmsg">🔒 Messages here are the same texts Matri-Kavach sends on WhatsApp. Synthetic demo data.</div>';
    if (!list.length && VIEW === 'nurse') html += '<div class="sysmsg">Say <b>Hi</b> to Matri-Kavach to start. Type it below or tap the Hi chip.</div>';
    if (isHospital(VIEW)) html += checkinBar(VIEW);
    if (!list.length && VIEW !== 'nurse') html += '<div class="empty">' + emptyText(VIEW) + '</div>';
    var lastIn = -1; list.forEach(function (m, i) { if (m.dir === 'in') lastIn = i; });
    var lastIncoming = -1; list.forEach(function (m, i) { if (m.incoming) lastIncoming = i; });
    list.forEach(function (m, i) {
      var extra = '';
      if (VIEW === 'nurse' && i === lastIn && i === list.length - 1) {
        var b = nurseButtons();
        if (b && b.list) extra = '<div class="qr"><button data-act="' + b.act + '">☰ ' + esc(b.list) + '</button></div>';
        else if (b && b.row) extra = '<div class="qr row">' + b.row.map(btnHtml).join('') + '</div>';
        else if (b && b.btns && !b.extra) extra = '<div class="qr">' + b.btns.map(btnHtml).join('') + '</div>';
      }
      if (VIEW !== 'nurse' && m.incoming && i === lastIncoming && hospitalCanReply(VIEW)) {
        extra = '<div class="qr">' + [['reply', 'all-ready', '1 All ready'], ['reply', 'ready-in', '2 Ready in 15 min'], ['reply', 'not-available', '3 Not available']].map(btnHtml).join('') + '</div>';
      }
      html += bubble(m, extra);
    });
    var ha = hospitalAfter(VIEW);
    if (ha.length) html += '<div class="grp in"><div class="qr">' + ha.map(btnHtml).join('') + '</div></div>';
    if (AUTO) html += '<div class="sysmsg autobar">▶ Auto-play ' + AUTO.i + ' of ' + AUTO.total + ': ' + esc(AUTO.text) + ' <button data-act="auto-stop">Stop</button></div>';
    if (VIEW === 'nurse') {
      var nb = nurseButtons();
      if (nb && nb.extra && list.length && list[list.length - 1].dir === 'in') html += bubble({ dir: 'in', text: nb.extra, at: now() }, '<div class="qr">' + nb.btns.map(btnHtml).join('') + '</div>');
    }
    if (r && r.state === 'sent' && (VIEW === 'nurse' || VIEW === r.proposal)) html += '<div class="sysmsg">⏱ ' + esc(fac(r.proposal).short) + ' has <b data-cd>02:00</b> to reply. If silent, it gets an automatic call. <button data-act="skip">Skip 2 min (demo)</button></div>';
    if (r && r.state === 'ivr' && VIEW === 'nurse') html += '<div class="sysmsg">📞 Calling ' + esc(fac(r.proposal).short) + ' duty phone now.</div>';
    el.innerHTML = html;
    if (near || BUSY) el.scrollTop = el.scrollHeight;
    countdown();
  }

  function checkinBar(id) {
    var f = fac(id);
    var full = f.kind !== 'hospital' ? '' : f.full
      ? '<div class="sysmsg warnmsg">⛔ Marked <b>FULL</b> until ' + esc(clock(f.fullUntil)) + '. Referrals skip this hospital. <button data-act="full" data-v="0">Open again</button></div>'
      : '';
    return full + checkinLine(f);
  }
  function checkinLine(f) {
    if (!f.checkin) return '<div class="sysmsg warnmsg">⚠ Night shift check-in <b>not done</b>. This hospital shows as Uncertain and gets no referrals. <button data-act="checkin-open">Do check-in</button></div>';
    var yes = ALL_ITEMS.filter(function (it) { return f.checkin.items[it.id] === true; }).length;
    var open = Object.assign({}, f, { full: false });
    var ready = D.emergencyTypes.filter(function (t) { return t.signed && MK.engine.facilityStatus(open, D, t.id) === 'ready'; }).map(function (t) { return t.short; });
    return '<div class="sysmsg">☑ Night shift check-in by ' + esc(f.who) + ': ' + yes + ' of ' + ALL_ITEMS.length + ' Yes. Ready for: <b>' + esc(ready.length ? ready.join(', ') : 'none') + '</b> <button data-act="checkin-open">Open check-in</button>' +
      (f.kind === 'hospital' && !f.full ? ' <button data-act="full" data-v="1">Full for 2 hours</button>' : '') + '</div>';
  }

  function emptyText(role) {
    if (role === 'nurse') return 'Starting…';
    if (isHospital(role)) return 'No referral for this hospital yet. Messages arrive here only when Matri-Kavach picks it.';
    return 'Nothing yet. This phone gets a message once a hospital confirms' + (role === 'district' ? ' or nobody is ready.' : role === 'asha' ? ' and the nurse closes the case.' : '.');
  }

  /* ---------- phone picker with unread badges ---------- */
  function renderPhones() {
    $('phones').innerHTML = PHONES.map(function (p) {
      var unread = Math.max(0, countIn(p.id) - (SEEN[p.id] || 0));
      if (p.id === VIEW) unread = 0;
      return '<button class="ph" role="tab" data-phone="' + p.id + '" aria-selected="' + (p.id === VIEW) + '">' + esc(p.label) + (unread ? '<span class="badge">' + unread + '</span>' : '') + '</button>';
    }).join('');
    var p = PHONES.filter(function (x) { return x.id === VIEW; })[0];
    var others = PHONES.reduce(function (n, x) { return x.id === VIEW ? n : n + Math.max(0, countIn(x.id) - (SEEN[x.id] || 0)); }, 0);
    $('owner').innerHTML = '\ud83d\udcf1 Phone of <b>' + esc(p.owner) + '</b> <span class="sw">Switch phone \u25be</span>' + (others ? '<span class="badge">' + others + '</span>' : '');
    var nurseNew = VIEW === 'nurse' && (!ST.chat.length || ST.step === 'done');
    $('sugg').innerHTML = nurseNew ? '<button data-act="say" data-v="Hi">Hi</button><button data-act="say" data-v="BLEED B+">BLEED B+</button><button data-act="mcall">📞 Missed call</button><button data-act="auto">▶ Auto-play</button><button data-act="help">How to test</button>' : '';
  }

  /* ---------- side panel: what to tap next, the case, readiness ---------- */
  function next() {
    var r = cur(), step = ST.step;
    if (step === 'callback') return ['nurse', 'No internet: Matri-Kavach called the nurse back. Press 1 for heavy bleeding or 2 for fits. The referral starts with the details to follow.'];
    if (ST.drill && !ST.drill.done && (!r || r.state === 'closed')) return ['dh', 'Mock drill running. Open each hospital phone and tap 1 Drill received, or send the result to the district from the ⋮ menu.'];
    if (!r && !ST.chat.length) return ['nurse', 'On the Nurse phone, type Hi (or tap the Hi chip). Matri-Kavach answers with the menu.'];
    if (!r || step === 'start') return ['nurse', 'On the Nurse phone, tap Choose emergency. Pick heavy bleeding, or fits / eclampsia to see that readiness differs by emergency.'];
    if (step === 'details') return ['nurse', 'Tap Fill patient details. The values are filled in for you, just tap Send.'];
    if (step === 'proposed') return ['nurse', 'Matri-Kavach picked the nearest hospital that said ready this shift. Tap SEND, or CHANGE to pick the next one.'];
    if (r.state === 'sent') return [r.proposal, 'The ambulance is already moving. Open the ' + fac(r.proposal).short + ' phone and tap 1 All ready, or tap Skip 2 minutes to see what happens when nobody replies.'];
    if (r.state === 'ivr') return [r.proposal, fac(r.proposal).short + ' is getting an automatic call. Open its phone and press 1, or tap No answer to see the reroute.'];
    if (r.state === 'fallback' || (step === 'close' && r.districtAlert && !r.arrived)) return ['district', 'Nobody was ready, so the medical college is the destination and the district officer was alerted. Look at those phones, then close the case on the Nurse phone.'];
    if (step === 'close' && !r.arrived && !r.teamReadyAt && r.state === 'confirmed') return [r.confirmed, 'Confirmed. The hospital can tap Team ready at the door. The doctor, blood bank, family, driver and EMT were told. Then record arrival on the Nurse phone.'];
    if (step === 'close' && !r.arrived) return ['doctor', 'Confirmed. The doctor, blood bank and family were told at the same moment. Look at their phones, then record arrival on the Nurse phone.'];
    if (step === 'close' && r.arrived === 'Yes' && !r.readyOnArrival) return ['nurse', 'Say whether the hospital was really ready on arrival. A No alerts the district: this is how false check-ins get caught.'];
    if (step === 'close') return ['nurse', 'Record the outcome on the Nurse phone.'];
    if (r.state === 'closed' && r.arrived === 'Yes' && !r.dischargedAt) return [r.confirmed || r.destination, 'Later, the hospital taps Mark discharged home. The PHC and ASHA get the back-referral for day 3, 7 and 42 visits.'];
    if (r.state === 'closed') return ['asha', 'Loop closed. The PHC and ASHA got the follow-up plan. Tap Reset to run again.'];
    return ['nurse', ''];
  }
  function renderSide() {
    var n = next(), r = cur();
    var stepsDone = { start: 0, details: 1, proposed: 2, waiting: 3, close: 4, done: 6 }[ST.step] || 0;
    if (ST.step === 'close' && r && r.arrived) stepsDone = 5;
    var steps = ['Pick the emergency', 'Send patient details', 'SEND to the proposed hospital', 'Hospital confirms (or call, reroute)', 'Doctor, blood bank, family told', 'Record arrival and outcome'];
    var html = '<div class="panel"><h2>Next</h2><p>' + esc(n[1]) + '</p>' + (n[0] !== VIEW ? '<button class="ctl" data-phone="' + n[0] + '">Open ' + esc(PHONES.filter(function (p) { return p.id === n[0]; })[0].label) + ' phone</button>' : '') + '</div>';
    html += '<div class="panel"><h2>Referral steps</h2><ol class="steps">' + steps.map(function (s, i) { return '<li class="' + (i < stepsDone ? 'done' : i === stepsDone ? 'now' : '') + '">' + esc(s) + '</li>'; }).join('') + '</ol></div>';
    if (r) {
      var dest = r.destination || r.confirmed || r.proposal;
      html += '<div class="panel"><h2>This case</h2><dl class="kv"><dt>Referral</dt><dd>' + esc(r.id) + '</dd><dt>State</dt><dd>' + esc(r.state) + '</dd>' +
        (dest && fac(dest) ? '<dt>Hospital</dt><dd>' + esc(fac(dest).name) + '</dd>' : '') +
        (r.patient ? '<dt>Mother</dt><dd>' + esc([r.patient.name, r.patient.age, r.patient.blood].filter(Boolean).join(', ')) + '</dd>' : '') +
        (r.bloodHoldUntil ? '<dt>Blood</dt><dd>One unit held until ' + esc(clock(r.bloodHoldUntil)) + '</dd>' : '') +
        (r.feedback ? '<dt>Feedback</dt><dd>' + esc(r.feedback) + '</dd>' : '') + '</dl></div>';
      html += '<div class="panel"><h2>Case timeline</h2><ol class="tl">' + (r.events || []).map(function (e) {
        var mins = Math.round((e.at - r.createdAt) / 60000);
        return '<li><b>' + esc(clock(e.at)) + '</b> <span class="plus">+' + mins + ' min</span><br>' + esc(e.text) + '</li>';
      }).join('') + '</ol></div>';
    }
    html += kpiPanel();
    var rows = ST.facilities.filter(function (f) { return f.kind === 'hospital' || f.kind === 'fallback'; }).map(function (f) {
      var st = MK.engine.facilityStatus(f, D, typeOf().id);
      var pill = st === 'ready' ? '<span class="pill ok">Ready</span>' : st === 'uncertain' ? '<span class="pill warn">No check-in</span>' : st === 'full' ? '<span class="pill bad">Full</span>' : '<span class="pill bad">Not ready</span>';
      return '<dt>' + esc(f.short) + '</dt><dd>' + pill + ' ' + f.km + ' km</dd>';
    }).join('');
    html += '<div class="panel"><h2>Tonight’s readiness (' + esc(typeOf().short.toLowerCase()) + ')</h2><dl class="kv">' + rows + '</dl>' + (typeOf().review ? '<p class="sub2">' + esc(typeOf().review) + '</p>' : '') + '</div>';
    html += '<div class="panel"><h2>Who sees what</h2><dl class="kv">' +
      '<dt>Hospital</dt><dd>Emergency, ETA, blood group, nurse facts</dd>' +
      '<dt>Doctor</dt><dd>Private summary link, expires</dd>' +
      '<dt>Blood bank</dt><dd>Blood group and hospital only</dd>' +
      '<dt>108 driver</dt><dd>Pickup and hospital only, no medical details</dd>' +
      '<dt>108 EMT</dt><dd>Nurse facts and blood group, for care on the way</dd>' +
      '<dt>Family</dt><dd>Hospital and ETA only, no medical details</dd>' +
      '<dt>District</dt><dd>Case ID and alerts, no patient name</dd></dl></div>';
    $('side').innerHTML = html;
    $('skip').hidden = !(r && r.state === 'sent');
    document.querySelectorAll('[data-scn]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.scn === ST.scenario)); });
  }

  function kpiPanel() {
    var k = MK.engine.kpis(ST.refs || [], ST.facilities, D), B = D.baseline;
    function tile(label, val, unit, base) {
      return '<div class="kp"><span class="kv2">' + (val == null ? '–' : esc(val) + '<small>' + unit + '</small>') + '</span><span class="kl">' + esc(label) + '</span>' + (base ? '<span class="kb">' + esc(base) + '</span>' : '') + '</div>';
    }
    return '<div class="panel"><h2>District KPIs (this session)</h2><div class="kps">' +
      tile('Decision to hospital door (est.)', k.doorMin, ' min', 'Today: ' + B.doorMin + ' min') +
      tile('First hospital asked was ready', k.firstReadyPct, '%', 'Today: ' + B.firstReadyPct + '%') +
      tile('Hospital reply time', k.replySec, ' s', 'Limit: 120 s') +
      tile('Not ready on arrival', k.checked ? k.mismatches : null, ' of ' + k.checked, '') +
      '</div><p class="sub2">Today = our simulation of 20,000 synthetic night emergencies. Door time = time to a confirmed hospital plus road ETA.</p></div>';
  }

  /* ---------- automatic call screen ---------- */
  function renderCall() {
    var r = cur(), show = r && r.state === 'ivr' && VIEW === r.proposal;
    $('call').hidden = !show;
    if (show) $('call-script').textContent = M.fill('ivrScript', { type: typeOf().short, eta: MK.engine.etaMinutes(fac(r.proposal).km, D) });
  }

  function render() {
    if (!ST) return;
    renderPhones(); renderMsgs(); renderSide(); renderCall();
  }

  function countdown() {
    var r = cur(); if (!r || r.state !== 'sent') return;
    var left = Math.max(0, Math.ceil((r.timerStart + ST.replyWindowSec * 1000 - now()) / 1000));
    var txt = '0' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    document.querySelectorAll('[data-cd]').forEach(function (c) { c.textContent = txt; });
  }

  /* ---------- bottom sheets: list message and patient form (like WhatsApp Flows) ---------- */
  function openSheet(html) { $('sheet').innerHTML = '<div class="grab"></div>' + html; $('sheet').hidden = false; $('sheet-bg').hidden = false; }
  function closeSheet() { $('sheet').hidden = true; $('sheet-bg').hidden = true; }
  function phonesSheet() {
    openSheet('<h3>Switch phone</h3><p class="sub2">Each person chats with the same Matri-Kavach number.</p>' + PHONES.map(function (p) {
      var unread = p.id === VIEW ? 0 : Math.max(0, countIn(p.id) - (SEEN[p.id] || 0));
      return '<button class="opt' + (p.id === VIEW ? ' cur' : '') + '" data-phone="' + p.id + '"><span>' + esc(p.label) + '<small>' + esc(p.owner) + '</small></span>' + (unread ? '<span class="badge">' + unread + '</span>' : '') + '</button>';
    }).join(''));
  }
  function menuSheet() {
    var r = cur();
    var idle = !r || r.state === 'closed';
    var dr = ST.drill && !ST.drill.done;
    openSheet('<h3>Demo menu</h3>' +
      '<button class="opt" data-act="auto"><span>▶ Auto-play the Lakshmi case<small>The whole referral plays by itself across all phones, about 1 minute</small></span></button>' +
      (r && r.state === 'sent' ? '<button class="opt" data-act="skip"><span>Skip 2 minutes<small>See what happens when the hospital stays silent</small></span></button>' : '') +
      '<button class="opt" data-scn="confirms"><span>New case: hospital confirms</span></button>' +
      '<button class="opt" data-scn="nobody"><span>New case: no hospital ready<small>Nobody passes the checklist tonight</small></span></button>' +
      ((!r || r.state === 'closed' || r.state === 'confirmed') ? '<button class="opt" data-act="miss"><span>Demo: DH Devgarh misses the night check-in<small>It turns Uncertain, gets a reminder, district is told</small></span></button>' : '') +
      (idle && !dr ? '<button class="opt" data-act="drill"><span>Demo: weekly mock drill<small>Every labour room phone gets a practice referral; district sees who answered</small></span></button>' : '') +
      (dr ? '<button class="opt" data-act="drill-report"><span>Send the drill result to the district now<small>Hospitals that did not reply show as no reply</small></span></button>' : '') +
      ((!r || ['closed', 'confirmed'].indexOf(r.state) !== -1) && !fac('dh').full ? '<button class="opt" data-act="full-dh"><span>Demo: DH Devgarh is full for 2 hours<small>Diversion: the next referral skips it</small></span></button>' : '') +
      '<button class="opt" data-act="report"><span>Demo: monthly readiness report to district<small>Which hospital was not ready, how often, and why</small></span></button>' +
      '<button class="opt" data-act="help"><span>How to test</span></button>' +
      '<button class="opt" data-act="reset"><span>Reset this chat</span></button>' +
      '<a class="opt" href="' + esc($('classic').getAttribute('href')) + '"><span>Open the dashboard view</span></a>');
  }
  function checkinSheet(id) {
    var f = fac(id);
    if (!CK || CK.facility !== id) CK = { facility: id, items: f.checkin ? Object.assign({}, f.checkin.items) : {} };
    var rows = ALL_ITEMS.map(function (it) {
      var v = CK.items[it.id];
      return '<div class="ck"><span>' + esc(it.label) + '</span><span class="yn"><button data-act="ck" data-v="' + it.id + ':1" aria-pressed="' + (v === true) + '">Yes</button><button data-act="ck" data-v="' + it.id + ':0" aria-pressed="' + (v === false) + '">No</button></span></div>';
    }).join('');
    openSheet('<h3>Night shift check-in</h3><p class="sub2">' + esc(f.short) + ' · ' + esc(f.who) + '. One check-in covers every emergency. Not answered = not ready.</p>' + rows + '<button class="go" data-act="ck-save">Save check-in</button>');
  }
  function helpSheet() {
    openSheet('<h3>How to test (2 minutes)</h3><ol class="help">' +
      '<li><b>Nurse phone:</b> type <b>Hi</b>, tap <b>Choose emergency</b>, pick <b>Heavy bleeding</b>, then <b>Fill patient details</b> and Send. The values are filled in.</li>' +
      '<li><b>See the routing:</b> CHC Sonpur is skipped (no anaesthetist tonight) and DH Devgarh is proposed. Tap <b>SEND</b>.</li>' +
      '<li><b>Switch phone</b> (bar under the header) to <b>DH Devgarh</b> and tap <b>1 All ready</b>. Then look at the Doctor, Family, 108 driver and 108 EMT phones.</li>' +
      '<li><b>Try more</b> from the ⋮ menu: Skip 2 minutes (no reply, automatic call, reroute), No hospital ready, or a missed check-in. Try <b>Fits or eclampsia</b>: it goes to SDH Kheri because DH has no HDU bed tonight.</li>' +
      '<li><b>Close the loop:</b> on arrival the nurse says if everything was really ready (a No alerts the district), the hospital marks discharge, and the PHC and ASHA get the back-referral. The side panel shows the case timeline.</li>' +
      '<li><b>Quick keyword:</b> type <b>BLEED B+</b> or <b>FITS O+</b> instead of Hi, like an SMS. No internet? Tap <b>📞 Missed call</b>: Matri-Kavach calls back and the nurse presses 1 or 2.</li>' +
      '<li><b>Short on time?</b> Tap <b>▶ Auto-play</b> and watch the whole case run across every phone. The side panel shows the district KPIs against today’s 131 minutes.</li></ol>' +
      '<p class="sub2">Prototype with synthetic data. Nothing is sent to a real phone. If the page was asleep, the first load can take up to a minute.</p><button class="go" data-act="help-close">Start</button>');
  }
  function typeSheet() {
    openSheet('<h3>Choose emergency</h3>' + D.emergencyTypes.map(function (t, i) {
      return '<button class="opt" role="radio" data-act="type" data-v="' + t.id + '" aria-checked="' + (i === 0) + '"><span>' + esc(t.label) + (t.signed ? (t.review ? '<small>' + esc(t.review) + '</small>' : '') : '<small>Checklist not reviewed yet: call the doctor</small>') + '</span><span class="radio"></span></button>';
    }).join('') + '<button class="go" data-act="type-send">Send</button>');
  }
  function detailsSheet() {
    var m = D.mother;
    function f(id, label, v) { return '<label>' + label + '<input id="' + id + '" value="' + esc(v) + '"></label>'; }
    function s(id, label, opts, v) { return '<label>' + label + '<select id="' + id + '">' + opts.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></label>'; }
    var t = typeOf(), form = D.forms[t.id] || D.forms.bleeding;
    var qs = form.map(function (q) { return q.options ? s('f-' + q.id, q.label, q.options, q.options[0]) : f('f-' + q.id, q.label, q.value || ''); });
    var pairs = ''; for (var i = 0; i < qs.length; i += 2) pairs += qs[i + 1] ? '<div class="two">' + qs[i] + qs[i + 1] + '</div>' : qs[i];
    openSheet('<h3>Patient details: ' + esc(t.short) + '</h3><p class="sub2">Facts only. Yes / No / Unknown, never a guess.</p>' + f('f-name', 'Name', m.name) + '<div class="two">' + f('f-age', 'Age', m.age) + f('f-blood', 'Blood group (MCP card)', m.bloodGroup) + '</div>' +
      f('f-contact', 'Family contact', m.contact) + pairs + s('f-informed', 'Family told that details go to the hospital?', ['Yes', 'No'], 'Yes') + '<button class="go" data-act="details-send">Send</button>');
  }

  /* ---------- server ---------- */
  function headers() { var h = { 'content-type': 'application/json' }; if (KEY) h['x-live-key'] = KEY; return h; }
  function sync(st) {
    ST = st; OFFSET = st.serverTime - Date.now();
    if (!SEEN) { SEEN = {}; PHONES.forEach(function (p) { SEEN[p.id] = countIn(p.id); }); }
    SEEN[VIEW] = countIn(VIEW);
    var sig = JSON.stringify([st.facilities, st.refs, st.cur, st.chat, st.step, st.scenario, st.outbox, VIEW, ECHO]);
    if (sig !== LAST) { LAST = sig; render(); }
  }
  function act(action, args) {
    if (BUSY) return Promise.resolve();
    BUSY = true;
    return fetch('/api/act', { method: 'POST', headers: headers(), body: JSON.stringify({ sid: SID, action: action, args: args || {} }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Error'); sync(j); }); })
      .catch(function (e) { note('Could not reach the server: ' + e.message + ' Try again.'); })
      .then(function () { BUSY = false; });
  }
  function poll() {
    if (BUSY) return;
    fetch('/api/state?sid=' + SID, { headers: headers() }).then(function (r) { return r.json(); }).then(function (j) { if (!BUSY && j.facilities) sync(j); }).catch(function () {});
  }
  function note(text, live) { var el = $('note'); el.textContent = text; el.className = 'note' + (live ? ' live' : ''); }
  function echo(role, text) { var r = cur(); (ECHO[role] = ECHO[role] || []).push({ text: text, at: now(), ref: r && r.id }); }

  function show(phone) { if (root.scrollY > 0) root.scrollTo(0, 0); VIEW = phone; SEEN[VIEW] = countIn(VIEW); closeSheet(); LAST = ''; render(); var el = $('msgs'); el.scrollTop = el.scrollHeight; try { root.localStorage.setItem('mk-chat-view', phone); } catch (e) {} }

  /* ---------- auto-play: the whole Lakshmi case, step by step, across the phones ---------- */
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function idleAct(action, args) {
    return (function tryIt(n) { if (!BUSY) return act(action, args); if (n > 40) return Promise.resolve(); return wait(150).then(function () { return tryIt(n + 1); }); })(0);
  }
  function autoPlay() {
    if (AUTO) return;
    var P = D.mother, form = {};
    D.forms.bleeding.forEach(function (q) { form[q.id] = q.options ? q.options[0] : q.value || ''; });
    var patient = Object.assign({ name: P.name, age: String(P.age), blood: P.bloodGroup, contact: P.contact, informed: 'Yes' }, form);
    var steps = [
      ['nurse', 'Night, PHC Rampur. Lakshmi is bleeding heavily after delivery. Nurse Kavitha starts a referral.', function () { ECHO = {}; return idleAct('reset', { scenario: 'confirms' }).then(function () { return idleAct('nurseText', { text: 'Hi' }); }); }],
      ['nurse', 'She picks Heavy bleeding. The checklist was signed by the clinical partner.', function () { return idleAct('startReferral', { typeId: 'bleeding' }); }],
      ['nurse', 'She sends the facts. Matri-Kavach skips CHC Sonpur (no anaesthetist tonight) and proposes DH Devgarh, 21 km.', function () { return idleAct('details', { patient: patient }); }],
      ['nurse', 'She taps SEND. The 108 ambulance leaves at once; the hospital confirms on the way.', function () { return idleAct('send', {}); }],
      ['dh', 'DH Devgarh gets the INCOMING alert. Sister Anjali taps 1 All ready.', function () { echo('dh', '1 All ready'); return idleAct('hospitalReply', { kind: 'all-ready' }); }],
      ['bloodbank', 'At the same moment the blood bank holds one B+ unit, and the doctor, family, driver and EMT are told.', function () { return Promise.resolve(); }],
      ['dh', 'The labour room team is ready at the door.', function () { echo('dh', 'Team ready at the door'); return idleAct('teamReady', {}); }],
      ['nurse', 'She arrives. The nurse confirms everything was really ready.', function () { return idleAct('arrived', { value: 'Yes' }).then(function () { return idleAct('readyCheck', { value: 'Yes' }); }).then(function () { return idleAct('outcome', { value: 'Delivered' }); }); }],
      ['asha', 'Days later DH marks her discharged. The PHC and ASHA get the day 3, 7 and 42 visits.', function () { echo('dh', 'Discharged home'); return idleAct('discharge', {}); }],
      ['nurse', 'DH sends feedback: the referral was on time. Look at the case timeline and the KPIs in the side panel.', function () { echo('dh', '1 On time'); return idleAct('feedback', { value: '1' }); }]
    ];
    AUTO = { i: 0, total: steps.length, text: 'Starting', stop: false };
    (function run(i) {
      if (AUTO.stop || i >= steps.length) { var done = !AUTO.stop; AUTO = null; LAST = ''; render(); if (done) note('Auto-play finished. Scroll the side panel for the case timeline and KPIs, or tap Reset to try it yourself.'); return; }
      var st = steps[i];
      AUTO.i = i + 1; AUTO.text = st[1];
      st[2]().then(function () { show(st[0]); return wait(i === 0 ? 2500 : 3800); }).then(function () { run(i + 1); });
    })(0);
  }

  function bind() {
    document.addEventListener('click', function (e) {
      var p = e.target.closest('[data-phone]'); if (p) { show(p.dataset.phone); return; }
      var sc = e.target.closest('[data-scn]'); if (sc) { ECHO = {}; act('reset', { scenario: sc.dataset.scn }).then(function () { show('nurse'); }); return; }
      if (e.target.closest('#reset')) { ECHO = {}; act('reset', { scenario: ST ? ST.scenario : 'confirms' }).then(function () { show('nurse'); }); return; }
      if (e.target.closest('#skip')) { act('skip', {}); return; }
      if (e.target.closest('[data-act="reset"]')) { closeSheet(); ECHO = {}; act('reset', { scenario: ST ? ST.scenario : 'confirms' }).then(function () { show('nurse'); }); return; }
      if (e.target.id === 'sheet-bg') { closeSheet(); return; }
      var b = e.target.closest('[data-act]'); if (!b) return;
      var a = b.dataset.act, v = b.dataset.v;
      if (a === 'phones') phonesSheet();
      else if (a === 'menu') menuSheet();
      else if (a === 'skip') { closeSheet(); act('skip', {}); }
      else if (a === 'say') typed(v);
      else if (a === 'pick-type') typeSheet();
      else if (a === 'open-details') detailsSheet();
      else if (a === 'checkin-open') checkinSheet(VIEW);
      else if (a === 'ck') { var kv = v.split(':'); CK.items[kv[0]] = kv[1] === '1'; b.parentNode.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); }); }
      else if (a === 'ck-save') { var c = CK; CK = null; closeSheet(); act('checkin', { facility: c.facility, items: c.items }); }
      else if (a === 'miss') { closeSheet(); act('missCheckin', { facility: 'dh' }).then(function () { show('dh'); }); }
      else if (a === 'help') helpSheet();
      else if (a === 'help-close') closeSheet();
      else if (a === 'type') document.querySelectorAll('.sheet .opt').forEach(function (o) { o.setAttribute('aria-checked', String(o === b)); });
      else if (a === 'type-send') { var sel = document.querySelector('.sheet .opt[aria-checked="true"]'); closeSheet(); act('startReferral', { typeId: sel ? sel.dataset.v : 'bleeding' }); }
      else if (a === 'details-send') {
        var g = function (id) { var el = $(id); return el ? el.value : ''; };
        var patient = { name: g('f-name'), age: g('f-age'), blood: g('f-blood'), contact: g('f-contact'), informed: g('f-informed') };
        (D.forms[typeOf().id] || D.forms.bleeding).forEach(function (q) { patient[q.id] = g('f-' + q.id); });
        closeSheet(); act('details', { patient: patient });
      }
      else if (a === 'send') act('send', {});
      else if (a === 'change') act('change', {});
      else if (a === 'reply') { var label = { 'all-ready': '1 All ready', 'ready-in': '2 Ready in 15 min', 'not-available': '3 Not available' }[v]; echo(VIEW, label); act('hospitalReply', { kind: v, minutes: v === 'ready-in' ? 15 : null }); }
      else if (a === 'ivr') { echo(VIEW, v === '1' ? 'Answered the call and pressed 1: all ready' : 'Did not answer the call'); act('ivrAnswer', { answer: v }); }
      else if (a === 'arrived') act('arrived', { value: v });
      else if (a === 'ready') act('readyCheck', { value: v });
      else if (a === 'missing') act('readyCheck', { missing: v });
      else if (a === 'team') { echo(VIEW, 'Team ready at the door'); act('teamReady', {}); }
      else if (a === 'discharge') { echo(VIEW, 'Discharged home'); act('discharge', {}); }
      else if (a === 'report') { closeSheet(); act('monthlyReport', {}).then(function () { show('district'); }); }
      else if (a === 'outcome') act('outcome', { value: v });
      else if (a === 'fb') { echo(VIEW, { 1: '1 On time', 2: '2 Should have come earlier', 3: '3 Could have been managed at the PHC' }[v]); act('feedback', { value: v }); }
      else if (a === 'full') { echo(VIEW, v === '1' ? 'FULL' : 'OPEN'); act('setFull', { facility: VIEW, on: v === '1' }); }
      else if (a === 'full-dh') { closeSheet(); act('setFull', { facility: 'dh', on: true }).then(function () { show('dh'); }); }
      else if (a === 'drill') { closeSheet(); act('drill', {}).then(function () { show('dh'); }); }
      else if (a === 'drill-report') { closeSheet(); act('drillReport', {}).then(function () { show('district'); }); }
      else if (a === 'drillok') { echo(VIEW, '1'); act('drillReply', { facility: VIEW }); }
      else if (a === 'mcall') act('missedCall', {});
      else if (a === 'ncall') act('nurseCall', { digit: v });
      else if (a === 'auto') { closeSheet(); autoPlay(); }
      else if (a === 'auto-stop') { if (AUTO) AUTO.stop = true; }
    });
    setInterval(countdown, 500);
  }

  /* What the person types in the message box. */
  function typed(text) {
    text = String(text || '').trim(); if (!text) return;
    if (VIEW === 'nurse') { act('nurseText', { text: text }); return; }
    if (isHospital(VIEW) && hospitalCanReply(VIEW)) {
      var m = text.match(/^\s*([123])\D*(\d+)?/);
      if (m) {
        echo(VIEW, text);
        if (m[1] === '1') act('hospitalReply', { kind: 'all-ready' });
        else if (m[1] === '3') act('hospitalReply', { kind: 'not-available' });
        else act('hospitalReply', { kind: 'ready-in', minutes: Number(m[2]) || 15 });
        return;
      }
    }
    var ha = hospitalAfter(VIEW), h0 = ha[0] && ha[0][0];
    if (h0 === 'team' && /^team/i.test(text)) { echo(VIEW, text); act('teamReady', {}); return; }
    if (h0 === 'discharge' && /^disch/i.test(text)) { echo(VIEW, text); act('discharge', {}); return; }
    if (h0 === 'fb' && /^[123]\b/.test(text)) { echo(VIEW, text); act('feedback', { value: text[0] }); return; }
    if (h0 === 'drillok' && /^1\b/.test(text)) { echo(VIEW, text); act('drillReply', { facility: VIEW }); return; }
    if (isHospital(VIEW) && /^(full|open)\b/i.test(text)) { echo(VIEW, text); act('setFull', { facility: VIEW, on: /^full/i.test(text) }); return; }
    echo(VIEW, text); LAST = ''; render();
  }
  function bindComposer() {
    var f = $('composer'), t = $('text');
    t.addEventListener('input', function () { f.classList.toggle('has-text', !!t.value.trim()); });
    f.addEventListener('submit', function (e) { e.preventDefault(); var v = t.value; t.value = ''; f.classList.remove('has-text'); typed(v); });
  }

  function randomHex(n) {
    var a = new Uint8Array(n / 2); root.crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function init() {
    var q = new URLSearchParams(root.location.search);
    KEY = q.get('key') || null;
    if (KEY) { SID = 'live'; $('classic').href = '/?key=' + encodeURIComponent(KEY); }
    else {
      try { SID = root.localStorage.getItem('mk-sid'); } catch (e) { SID = null; }
      if (!SID || !/^[a-f0-9]{16}$/.test(SID)) { SID = randomHex(16); try { root.localStorage.setItem('mk-sid', SID); } catch (e) {} }
    }
    try { var v = root.localStorage.getItem('mk-chat-view'); if (v && PHONES.some(function (p) { return p.id === v; })) VIEW = v; } catch (e) {}
    if (q.get('phone') && PHONES.some(function (p) { return p.id === q.get('phone'); })) VIEW = q.get('phone');
    bind(); bindComposer();
    fetch('/api/state?sid=' + SID, { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error('no server'); return r.json(); })
      .then(function (st) {
        if (!st.facilities) throw new Error('no server');
        if (st.live) note('LIVE: these taps send real WhatsApp messages to the team test phones. The 2-minute timer runs on the server.', true);
        else note('Your own private session on the live server. Messages show on these screens and are not sent to any real phone. Synthetic data only.');
        sync(st);
        setInterval(poll, 1500);
        var seen = null; try { seen = root.localStorage.getItem('mk-help-seen'); } catch (e) {}
        if (!seen && !q.get('phone')) { helpSheet(); try { root.localStorage.setItem('mk-help-seen', '1'); } catch (e) {} }
      })
      .catch(function () { $('msgs').innerHTML = '<div class="empty">This view needs the live server. Open matri-kavach.onrender.com/chat</div>'; });
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
})(window);
