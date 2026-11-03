/* WhatsApp-style view of the same live MVP. Every tap calls the same server actions as the dashboard view
   (/api/act), so the routing rules, the 2-minute timer and the messages are exactly the same. */
(function (root) {
  var MK = root.MK, D = MK.DATA, M = MK.messages;
  var SID = null, KEY = null, ST = null, OFFSET = 0, BUSY = false, LAST = '', VIEW = 'nurse', SEEN = null;
  var ECHO = {}; // replies tapped on a hospital phone in this browser, shown as sent messages

  var PHONES = [
    { id: 'nurse', label: 'Nurse', owner: 'Phone of Nurse Kavitha, PHC Rampur (refers the mother)' },
    { id: 'dh', label: 'DH Devgarh', owner: 'Labour-room duty phone, District Hospital Devgarh' },
    { id: 'sdh', label: 'SDH Kheri', owner: 'Labour-room duty phone, Sub-district Hospital Kheri' },
    { id: 'chc', label: 'CHC Sonpur', owner: 'Duty phone, CHC Sonpur' },
    { id: 'mc', label: 'GMC Rajnagar', owner: 'Obstetrics emergency desk, Govt Medical College Rajnagar' },
    { id: 'doctor', label: 'Doctor', owner: 'Phone of the receiving doctor' },
    { id: 'bloodbank', label: 'Blood bank', owner: 'Blood bank phone at the receiving hospital' },
    { id: 'family', label: 'Family', owner: 'Phone of the mother’s family' },
    { id: 'district', label: 'District officer', owner: 'Phone of the district maternal health officer' },
    { id: 'asha', label: 'PHC and ASHA', owner: 'Phone of the PHC and the mother’s ASHA' }
  ];

  function $(id) { return document.getElementById(id); }
  function now() { return Date.now() + OFFSET; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function linkify(s) { return esc(s).replace(/(https?:\/\/[^\s<]+|\/s\/[a-f0-9.]+)/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>'; }); }
  function clock(ms) { return new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).toLowerCase(); }
  function fac(id) { return ((ST && ST.facilities) || D.facilities).filter(function (f) { return f.id === id; })[0]; }
  function cur() { return ST && ST.cur; }
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
    if (step === 'details') return { list: 'Fill patient details', act: 'open-details' };
    if (step === 'proposed') return { row: [['send', '', 'SEND'], ['change', '', 'CHANGE']] };
    if (step === 'close' && r && !r.arrived) return { extra: M.T.closeQ, btns: [['arrived', 'Yes', '1 Yes, arrived'], ['arrived', 'No', '2 No'], ['arrived', 'Transferred', '3 Transferred']] };
    if (step === 'close' && r && r.arrived === 'Yes' && !r.outcome) return { btns: [['outcome', 'Delivered', '1 Delivered'], ['outcome', 'Other', '2 Other']] };
    return null;
  }
  function hospitalCanReply(role) { var r = cur(); return r && r.proposal === role && ['sent', 'routed', 'ivr'].indexOf(r.state) !== -1; }

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
    if (!list.length) html += '<div class="empty">' + emptyText(VIEW) + '</div>';
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
    if (VIEW === 'nurse') {
      var nb = nurseButtons();
      if (nb && nb.extra && list.length && list[list.length - 1].dir === 'in') html += bubble({ dir: 'in', text: nb.extra, at: now() }, '<div class="qr">' + nb.btns.map(btnHtml).join('') + '</div>');
    }
    if (r && r.state === 'sent' && (VIEW === 'nurse' || VIEW === r.proposal)) html += '<div class="sysmsg">⏱ ' + esc(fac(r.proposal).short) + ' has <b data-cd>02:00</b> to reply. If silent, it gets an automatic call.</div>';
    if (r && r.state === 'ivr' && VIEW === 'nurse') html += '<div class="sysmsg">📞 Calling ' + esc(fac(r.proposal).short) + ' duty phone now.</div>';
    el.innerHTML = html;
    if (near || BUSY) el.scrollTop = el.scrollHeight;
    countdown();
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
    $('owner').textContent = p.owner;
  }

  /* ---------- side panel: what to tap next, the case, readiness ---------- */
  function next() {
    var r = cur(), step = ST.step;
    if (!r || step === 'start') return ['nurse', 'On the Nurse phone, tap Choose emergency and pick heavy bleeding after delivery.'];
    if (step === 'details') return ['nurse', 'Tap Fill patient details. The values are filled in for you, just tap Send.'];
    if (step === 'proposed') return ['nurse', 'Matri-Kavach picked the nearest hospital that said ready this shift. Tap SEND, or CHANGE to pick the next one.'];
    if (r.state === 'sent') return [r.proposal, 'The ambulance is already moving. Open the ' + fac(r.proposal).short + ' phone and tap 1 All ready, or tap Skip 2 minutes to see what happens when nobody replies.'];
    if (r.state === 'ivr') return [r.proposal, fac(r.proposal).short + ' is getting an automatic call. Open its phone and press 1, or tap No answer to see the reroute.'];
    if (r.state === 'fallback' || (step === 'close' && r.districtAlert && !r.arrived)) return ['district', 'Nobody was ready, so the medical college is the destination and the district officer was alerted. Look at those phones, then close the case on the Nurse phone.'];
    if (step === 'close' && !r.arrived) return ['doctor', 'Confirmed. The doctor, blood bank and family were told at the same moment. Look at their phones, then record arrival on the Nurse phone.'];
    if (step === 'close') return ['nurse', 'Record the outcome on the Nurse phone.'];
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
        (r.patient ? '<dt>Mother</dt><dd>' + esc(r.patient.name) + ', ' + esc(r.patient.age) + ', ' + esc(r.patient.blood) + '</dd>' : '') + '</dl></div>';
    }
    var rows = ST.facilities.filter(function (f) { return f.kind === 'hospital' || f.kind === 'fallback'; }).map(function (f) {
      var st = MK.engine.facilityStatus(f, D);
      var pill = st === 'ready' ? '<span class="pill ok">Ready</span>' : st === 'uncertain' ? '<span class="pill warn">No check-in</span>' : '<span class="pill bad">Not ready</span>';
      return '<dt>' + esc(f.short) + '</dt><dd>' + pill + ' ' + f.km + ' km</dd>';
    }).join('');
    html += '<div class="panel"><h2>Tonight’s readiness (heavy bleeding)</h2><dl class="kv">' + rows + '</dl></div>';
    $('side').innerHTML = html;
    $('skip').hidden = !(r && r.state === 'sent');
    document.querySelectorAll('[data-scn]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.scn === ST.scenario)); });
  }

  /* ---------- automatic call screen ---------- */
  function renderCall() {
    var r = cur(), show = r && r.state === 'ivr' && VIEW === r.proposal;
    $('call').hidden = !show;
    if (show) $('call-script').textContent = M.fill('ivrScript', { eta: MK.engine.etaMinutes(fac(r.proposal).km, D) });
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
  function typeSheet() {
    openSheet('<h3>Choose emergency</h3>' + D.emergencyTypes.map(function (t, i) {
      return '<button class="opt" role="radio" data-act="type" data-v="' + t.id + '" aria-checked="' + (i === 0) + '"><span>' + esc(t.label) + (t.signed ? '' : '<small>Checklist not signed yet</small>') + '</span><span class="radio"></span></button>';
    }).join('') + '<button class="go" data-act="type-send">Send</button>');
  }
  function detailsSheet() {
    var m = D.mother;
    function f(id, label, v) { return '<label>' + label + '<input id="' + id + '" value="' + esc(v) + '"></label>'; }
    function s(id, label, opts, v) { return '<label>' + label + '<select id="' + id + '">' + opts.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></label>'; }
    openSheet('<h3>Patient details</h3>' + f('f-name', 'Name', m.name) + '<div class="two">' + f('f-age', 'Age', m.age) + f('f-blood', 'Blood group (MCP card)', m.bloodGroup) + '</div>' +
      f('f-contact', 'Family contact', m.contact) + '<div class="two">' + f('f-time', 'Time of delivery', m.deliveredAt) + s('f-mode', 'Mode of delivery', ['Normal', 'Caesarean', 'Not yet delivered'], 'Normal') + '</div>' +
      '<div class="two">' + s('f-oxy', 'Oxytocin 10 IU given?', ['Yes', 'No'], 'Yes') + s('f-miso', 'Misoprostol 600 mcg?', ['Yes', 'No'], 'Yes') + '</div>' +
      s('f-iv', 'IV line in place?', ['Yes', 'No'], 'Yes') + '<button class="go" data-act="details-send">Send</button>');
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

  function show(phone) { VIEW = phone; SEEN[VIEW] = countIn(VIEW); closeSheet(); LAST = ''; render(); var el = $('msgs'); el.scrollTop = el.scrollHeight; try { root.localStorage.setItem('mk-chat-view', phone); } catch (e) {} }

  function bind() {
    document.addEventListener('click', function (e) {
      var p = e.target.closest('[data-phone]'); if (p) { show(p.dataset.phone); return; }
      var sc = e.target.closest('[data-scn]'); if (sc) { ECHO = {}; act('reset', { scenario: sc.dataset.scn }).then(function () { show('nurse'); }); return; }
      if (e.target.closest('#reset')) { ECHO = {}; act('reset', { scenario: ST ? ST.scenario : 'confirms' }).then(function () { show('nurse'); }); return; }
      if (e.target.closest('#skip')) { act('skip', {}); return; }
      if (e.target.id === 'sheet-bg') { closeSheet(); return; }
      var b = e.target.closest('[data-act]'); if (!b) return;
      var a = b.dataset.act, v = b.dataset.v;
      if (a === 'pick-type') typeSheet();
      else if (a === 'open-details') detailsSheet();
      else if (a === 'type') document.querySelectorAll('.sheet .opt').forEach(function (o) { o.setAttribute('aria-checked', String(o === b)); });
      else if (a === 'type-send') { var sel = document.querySelector('.sheet .opt[aria-checked="true"]'); closeSheet(); act('startReferral', { typeId: sel ? sel.dataset.v : 'bleeding' }); }
      else if (a === 'details-send') {
        var g = function (id) { var el = $(id); return el ? el.value : ''; };
        var patient = { name: g('f-name'), age: g('f-age'), blood: g('f-blood'), contact: g('f-contact'), time: g('f-time'), mode: g('f-mode'), oxy: g('f-oxy'), miso: g('f-miso'), iv: g('f-iv') };
        closeSheet(); act('details', { patient: patient });
      }
      else if (a === 'send') act('send', {});
      else if (a === 'change') act('change', {});
      else if (a === 'reply') { var label = { 'all-ready': '1 All ready', 'ready-in': '2 Ready in 15 min', 'not-available': '3 Not available' }[v]; echo(VIEW, label); act('hospitalReply', { kind: v, minutes: v === 'ready-in' ? 15 : null }); }
      else if (a === 'ivr') { echo(VIEW, v === '1' ? 'Answered the call and pressed 1: all ready' : 'Did not answer the call'); act('ivrAnswer', { answer: v }); }
      else if (a === 'arrived') act('arrived', { value: v });
      else if (a === 'outcome') act('outcome', { value: v });
    });
    setInterval(countdown, 500);
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
    bind();
    fetch('/api/state?sid=' + SID, { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error('no server'); return r.json(); })
      .then(function (st) {
        if (!st.facilities) throw new Error('no server');
        if (st.live) note('LIVE: these taps send real WhatsApp messages to the team test phones. The 2-minute timer runs on the server.', true);
        else note('Your own private session on the live server. Messages show on these screens and are not sent to any real phone. Synthetic data only.');
        sync(st);
        setInterval(poll, 1500);
      })
      .catch(function () { $('msgs').innerHTML = '<div class="empty">This view needs the live server. Open matri-kavach.onrender.com/chat</div>'; });
  }

  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
})(window);
