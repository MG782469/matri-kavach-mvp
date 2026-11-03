/* Screens, buttons and the demo clock. All routing decisions come from engine.js. */
(function (root) {
  var MK = root.MK, D = MK.DATA, E = MK.engine, M = MK.messages;
  var LIVE = false, SID = null, KEY = null, OFFSET = 0, BUSY = false, LAST = '';
  var S = { outbox: [], facilities: [], refs: [], cur: null, chat: [], step: 'start', form: null, scenario: 'confirms', auto: null, view: 'nurse', pendingType: null };
  var SILENT = { silent: ['dh'], confirms: [], nobody: [] };

  function now() { return Date.now() + OFFSET; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fac(id) { return S.facilities.filter(function (f) { return f.id === id; })[0]; }
  function setCur(r) { S.cur = r; if (!r) return; S.refs = S.refs.some(function (x) { return x.id === r.id; }) ? S.refs.map(function (x) { return x.id === r.id ? r : x; }) : S.refs.concat([r]); }
  function say(from, text) { S.chat.push({ from: from, text: text }); }
  function scheduleAuto(ms, fn) { S.auto = { at: now() + ms, fn: fn }; }

  function applyScenario(id) {
    S.scenario = id;
    S.facilities = D.facilities.map(function (f) {
      if (f.kind !== 'hospital' || id !== 'nobody') return Object.assign({}, f, { checkin: f.checkin ? Object.assign({}, f.checkin, { items: Object.assign({}, f.checkin.items) }) : null });
      return Object.assign({}, f, { checkin: { shift: 'night', items: Object.assign({}, f.checkin.items, { blood: false }) } });
    });
  }

  function reset(scenario) {
    if (LIVE) return act('reset', { scenario: scenario || S.scenario });
    applyScenario(scenario || S.scenario);
    S.refs = []; S.cur = null; S.chat = []; S.step = 'start'; S.form = null; S.auto = null; S.pendingType = null;
    say('bot', M.T.menu);
    render();
  }

  function startReferral(typeId) {
    if (LIVE) return act('startReferral', { typeId: typeId });
    var t = D.emergencyTypes.filter(function (x) { return x.id === typeId; })[0];
    if (!t.signed) { say('bot', M.T.typeNotSigned); render(); return; }
    setCur(E.startReferral(typeId, now()));
    S.step = 'details'; say('nurse', t.label); say('bot', M.T.details);
    render();
  }

  function submitDetails() {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    S.form = { name: v('f-name'), age: v('f-age'), blood: v('f-blood'), contact: v('f-contact'), time: v('f-time'), mode: v('f-mode'), oxy: v('f-oxy'), miso: v('f-miso'), iv: v('f-iv') };
    if (LIVE) return act('details', { patient: S.form });
    S.cur = Object.assign({}, S.cur, { patient: S.form });
    say('nurse', 'Details sent: ' + S.form.name + ', ' + S.form.age + ', ' + S.form.blood + ', delivered ' + S.form.time);
    var r = E.propose(S.cur, S.facilities, D, now());
    setCur(r);
    if (r.state === 'fallback') { say('bot', M.T.fallback); S.step = 'close'; }
    else { var h = fac(r.proposal); say('bot', M.fill('proposed', { hospital: h.short, km: h.km, eta: E.etaMinutes(h.km, D) })); S.step = 'proposed'; }
    render();
  }

  function changeProposal() {
    if (LIVE) return act('change', {});
    var r = E.changeProposal(S.cur, S.facilities, D, now());
    setCur(r); var h = fac(r.proposal);
    say('nurse', 'CHANGE'); say('bot', M.fill('proposed', { hospital: h.short, km: h.km, eta: E.etaMinutes(h.km, D) }));
    render();
  }

  function send() {
    if (LIVE) return act('send', {});
    var r = E.sendTo(S.cur, now());
    setCur(r); S.step = 'waiting'; say('nurse', 'SEND'); say('bot', M.T.sent);
    autoReplyFor(r.proposal);
    render();
  }

  // Demo driver: the hospital answers on its own after a few seconds, unless the scenario makes it silent.
  function autoReplyFor(hospitalId) {
    if (SILENT.silent.indexOf(hospitalId) !== -1 && S.scenario === 'silent') return;
    scheduleAuto(8000, function () { hospitalReply('all-ready', null, hospitalId); });
  }

  function hospitalReply(kind, minutes, hospitalId) {
    if (LIVE) return act('hospitalReply', { kind: kind, minutes: minutes });
    if (!S.cur || S.cur.state !== 'sent' && S.cur.state !== 'ivr' && S.cur.state !== 'routed') return;
    if (hospitalId && S.cur.proposal !== hospitalId) return;
    S.auto = null;
    var h = fac(S.cur.proposal);
    var reply = kind === 'ready-in' ? { kind: 'ready-in', minutes: minutes } : { kind: kind };
    var prev = S.cur.proposal;
    var r = E.onHospitalReply(S.cur, prev, reply, S.facilities, D, now());
    setCur(r);
    afterEngine(prev, r, h, kind === 'ready-in' ? minutes : null);
    render();
  }

  function afterEngine(prev, r, h, minutes) {
    if (r.state === 'confirmed') {
      say('bot', minutes ? M.fill('readyIn', { hospital: h.short, min: minutes, time: '2:30 am' }) : M.fill('ready', { hospital: h.short, time: '2:30 am' }));
      S.step = 'close';
    } else if (r.state === 'fallback') {
      say('bot', M.T.fallback); S.step = 'close';
    } else if (r.state === 'sent' && r.proposal !== prev) {
      say('bot', M.fill('reroute', { hospital: fac(r.proposal).short })); S.step = 'waiting';
      autoReplyFor(r.proposal);
    }
  }

  function countdown() {
    var t = now();
    if (S.cur && S.cur.state === 'sent') {
      var left = Math.max(0, Math.ceil((S.cur.timerStart + D.replyWindowSec * 1000 - t) / 1000));
      var txt = '0' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      document.querySelectorAll('[data-cd]').forEach(function (c) { c.textContent = txt; });
    }
  }

  function tick() {
    if (LIVE) { countdown(); return; }
    if (!S.cur) return;
    var t = now();
    if (S.cur.state === 'sent') {
      var r = E.onTimeout(S.cur, t, D);
      if (r.state === 'ivr') {
        setCur(r); S.step = 'waiting';
        say('bot', M.fill('silent', { hospital: fac(r.proposal).short }));
        if (S.scenario === 'silent') scheduleAuto(5000, function () { ivrAnswer('none'); });
        render();
      }
    }
    if (S.auto && t >= S.auto.at) { var fn = S.auto.fn; S.auto = null; fn(); }
    if (S.cur && S.cur.state === 'sent') {
      var left = Math.max(0, Math.ceil((S.cur.timerStart + D.replyWindowSec * 1000 - t) / 1000));
      var txt = '0' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
      document.querySelectorAll('[data-cd]').forEach(function (c) { c.textContent = txt; });
    }
  }

  function ivrAnswer(ans) {
    if (LIVE) return act('ivrAnswer', { answer: ans });
    if (!S.cur || S.cur.state !== 'ivr') return;
    S.auto = null;
    var prev = S.cur.proposal;
    var r = E.onIVR(S.cur, ans, S.facilities, D, now());
    setCur(r);
    if (r.state === 'confirmed') { say('bot', 'IVR: all ready. ' + fac(prev).short + ' confirmed.'); }
    else { say('bot', 'IVR not answered.'); }
    afterEngine(prev, r, fac(r.proposal || prev), null);
    render();
  }

  function skipTwoMinutes() {
    if (LIVE) return act('skip', {});
    if (!S.cur || S.cur.state !== 'sent') return;
    setCur(Object.assign({}, S.cur, { timerStart: S.cur.timerStart - D.replyWindowSec * 1000 }));
  }

  function closeOut(arrived, outcome) {
    var r = E.onClose(S.cur, arrived, outcome, now());
    setCur(r); S.step = 'done';
    say('nurse', arrived === 'Yes' ? 'Yes, arrived' : arrived);
    if (outcome) say('nurse', 'Outcome: ' + outcome);
    say('bot', M.T.closed);
    render();
  }

  function render() {
    var v = S.view;
    document.querySelectorAll('.tab').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.v === v)); });
    document.querySelectorAll('.screen').forEach(function (s) { s.hidden = s.dataset.v !== v; });
    renderNurse(); renderHospital(); renderAlerts(); renderDash();
    var sc = document.querySelectorAll('[data-scn]');
    sc.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.scn === S.scenario)); });
  }

  function renderNurse() {
    var el = document.getElementById('nurse-body');
    var chat = S.chat.map(function (m) { return '<div class="bub ' + (m.from === 'nurse' ? 'out' : 'in') + '">' + esc(m.text) + '</div>'; }).join('');
    var body = '';
    var r = S.cur;
    if (S.step === 'start') {
      body = '<div class="opts">' + D.emergencyTypes.map(function (t) { return '<button class="opt" data-act="type" data-id="' + t.id + '">' + esc(t.label) + '</button>'; }).join('') + '</div>';
    } else if (S.step === 'details') {
      var p = (r && r.patient) || { name: D.mother.name, age: D.mother.age, blood: D.mother.bloodGroup, contact: D.mother.contact, time: D.mother.deliveredAt, mode: 'Normal', oxy: 'Yes', miso: 'Yes', iv: 'Yes' };
      body = '<div class="form">' +
        field('f-name', 'Name', p.name) + field('f-age', 'Age', p.age) + field('f-blood', 'Blood group (MCP card)', p.blood) +
        field('f-contact', 'Family contact', p.contact) + field('f-time', 'Time of delivery', p.time) +
        select('f-mode', 'Mode of delivery', ['Normal', 'Caesarean', 'Not yet delivered'], p.mode) +
        select('f-oxy', 'Oxytocin 10 IU given?', ['Yes', 'No'], p.oxy) + select('f-miso', 'Misoprostol 600 mcg given?', ['Yes', 'No'], p.miso) +
        select('f-iv', 'IV line in place?', ['Yes', 'No'], p.iv) +
        '<button class="btn primary" data-act="details">Send details</button></div>';
    } else if (S.step === 'proposed') {
      body = '<div class="opts"><button class="btn primary" data-act="send">SEND</button><button class="btn" data-act="change">CHANGE</button></div>';
    } else if (S.step === 'waiting') {
      body = r && r.state === 'sent' ? '<div class="status">Hospital reply: <span data-cd class="timer">02:00</span></div>' : '<div class="status">Waiting for the hospital reply.</div>';
    } else if (S.step === 'close' && r && !r.arrived) {
      body = '<div class="opts"><button class="btn primary" data-act="arrived" data-v="Yes">1 Yes, arrived</button><button class="btn" data-act="arrived" data-v="No">2 No</button><button class="btn" data-act="arrived" data-v="Transferred">3 Transferred</button></div>';
    } else if (S.step === 'close' && r && !r.outcome) {
      body = '<div class="opts"><button class="btn primary" data-act="outcome" data-v="Delivered">1 Delivered</button><button class="btn" data-act="outcome" data-v="Other">2 Other</button></div>';
    } else if (r && r.state === 'closed') {
      body = '<div class="status ok">Closed. Loop recorded.</div>';
    }
    el.innerHTML = '<div class="chat">' + chat + '</div>' + body;
  }

  function field(id, label, value) { return '<label class="fld">' + label + '<input id="' + id + '" value="' + esc(value) + '"></label>'; }
  function select(id, label, opts, value) { return '<label class="fld">' + label + '<select id="' + id + '">' + opts.map(function (o) { return '<option' + (o === value ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select></label>'; }

  function checklistRows(f) {
    return D.checklistItems.map(function (it) {
      var ok = f.checkin && f.checkin.items[it.id] === true;
      return '<li><span>' + esc(it.label) + '</span><b class="' + (ok ? 'yes' : 'no') + '">' + (ok ? 'Yes' : 'No') + '</b></li>';
    }).join('');
  }

  function renderHospital() {
    var el = document.getElementById('hospital-body');
    if (!S.cur) { el.innerHTML = '<p class="empty">No incoming referral yet. Start one in the nurse chat.</p>'; return; }
    var target = S.cur.proposal && S.cur.state !== 'closed' ? fac(S.cur.proposal) : fac(S.cur.destination || 'mc');
    if (S.cur.state === 'fallback') target = fac('mc');
    var p = S.cur.patient || D.mother;
    var html = '<div class="card"><div class="lbl">Incoming referral to ' + esc(target.name) + '</div>' +
      '<p>' + esc(M.fill('incoming', { eta: E.etaMinutes(target.km, D), group: p.blood || D.mother.bloodGroup })) + '</p>' +
      '<ul class="checks">' + checklistRows(target) + '</ul></div>';
    if (S.cur.state === 'sent' || S.cur.state === 'routed') {
      html += '<div class="opts"><button class="btn primary" data-act="reply" data-v="all-ready">1 All ready</button>' +
        '<button class="btn" data-act="reply" data-v="ready-in">2 Ready in 15 min</button>' +
        '<button class="btn" data-act="reply" data-v="not-available">3 Not available</button></div>';
      if (S.cur.state === 'sent') html += '<div class="status">Reply window: <span data-cd class="timer">02:00</span> <button class="btn small" data-act="skip">Skip 2 minutes (demo)</button></div>';
    }
    if (S.cur.state === 'ivr') html += '<div class="card"><div class="lbl">IVR call to duty phone</div><p>' + esc(M.fill('ivrScript', { eta: E.etaMinutes(target.km, D) })) + '</p><div class="opts"><button class="btn primary" data-act="ivr" data-v="1">Press 1</button><button class="btn" data-act="ivr" data-v="none">No answer</button></div></div>';
    el.innerHTML = html;
  }

  function renderAlerts() {
    var el = document.getElementById('alerts-body');
    var r = S.cur;
    if (!r || (r.state !== 'confirmed' && r.state !== 'fallback' && r.state !== 'closed')) { el.innerHTML = '<p class="empty">Doctor, blood bank, family and district alerts appear here once a hospital confirms or the medical college is the destination.</p>' + outboxCard(); return; }
    var h = fac(r.state === 'fallback' ? 'mc' : (r.confirmed || r.proposal));
    var p = r.patient || D.mother;
    var cards = [
      card('Receiving doctor', 'Summary', M.T.doctor + ' Patient: ' + p.name + ', ' + p.age + ', ' + p.blood + '.'),
      card('Blood bank', 'Alert', M.fill('blood', { hospital: h.short })),
      card('Family', 'Message', M.fill('family', { hospital: h.short, eta: E.etaMinutes(h.km, D) }))
    ];
    if (r.districtAlert) cards.push(card('District officer', 'Alert', M.fill('district', { id: r.id })));
    if (r.state === 'closed') cards.push(card('PHC and ASHA', 'Outcome', M.fill('asha', { name: p.name })));
    el.innerHTML = cards.join('') + outboxCard();
  }

  function outboxCard() {
    if (!LIVE || !S.outbox.length) return '';
    var label = { sent: 'Sent', simulated: 'Shown on screen', 'no-phone': 'No phone set', failed: 'Failed' };
    var rows = S.outbox.slice().reverse().map(function (o) {
      return '<li><b>' + esc(o.label) + '</b> · ' + esc(label[o.status] || o.status) + (o.channel && o.channel !== 'screen' && o.channel !== 'none' ? ' by ' + esc(o.channel) : '') + (o.error ? ' · ' + esc(o.error) : '') + '<br>' + esc(o.text) + '</li>';
    }).join('');
    return '<div class="card"><div class="lbl">Message log</div><ul class="log">' + rows + '</ul></div>';
  }

  function card(who, tag, text) { return '<div class="card"><div class="lbl">' + esc(who) + ' · ' + esc(tag) + '</div><p>' + esc(text) + '</p></div>'; }

  function renderDash() {
    var el = document.getElementById('dash-body');
    var refs = S.refs;
    var closed = refs.filter(function (r) { return r.state === 'closed'; }).length;
    var rate = E.closedLoopRate(refs);
    var rows = S.facilities.filter(function (f) { return f.kind === 'hospital' || f.kind === 'fallback'; }).map(function (f) {
      var st = E.facilityStatus(f, D);
      var pill = st === 'ready' ? '<span class="pill ok">Ready</span>' : st === 'uncertain' ? '<span class="pill warn">Uncertain</span>' : '<span class="pill bad">Not ready</span>';
      return '<tr><td>' + esc(f.short) + '</td><td>' + pill + '</td><td>' + E.etaMinutes(f.km, D) + ' min</td><td>' + esc(f.blood) + '</td></tr>';
    }).join('');
    var list = refs.length ? refs.map(function (r) { return '<li>' + esc(r.id) + ' · ' + esc(r.state) + (r.destination ? ' · ' + esc(fac(r.destination) ? fac(r.destination).short : r.destination) : '') + '</li>'; }).join('') : '<li>No referrals yet.</li>';
    el.innerHTML = '<div class="tile kpi"><div class="lbl">Referral loop closure rate</div><div class="big">' + Math.round(rate * 100) + '%</div><p>' + closed + ' of ' + refs.length + ' referrals closed. Synthetic data.</p></div>' +
      '<div class="card"><div class="lbl">Readiness tonight, heavy bleeding checklist</div><table><tr><th>Hospital</th><th>Status</th><th>ETA</th><th>Blood</th></tr>' + rows + '</table></div>' +
      '<div class="card"><div class="lbl">Referrals in this session</div><ul>' + list + '</ul></div>';
  }

  function bind() {
    document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { S.view = b.dataset.v; render(); }); });
    document.querySelectorAll('[data-scn]').forEach(function (b) { b.addEventListener('click', function () { reset(b.dataset.scn); }); });
    document.getElementById('reset').addEventListener('click', function () { reset(S.scenario); });
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]'); if (!b) return;
      var a = b.dataset.act;
      if (a === 'type') startReferral(b.dataset.id);
      else if (a === 'details') submitDetails();
      else if (a === 'change') changeProposal();
      else if (a === 'send') send();
      else if (a === 'reply') { var v = b.dataset.v; hospitalReply(v, v === 'ready-in' ? 15 : null, null); }
      else if (a === 'ivr') ivrAnswer(b.dataset.v);
      else if (a === 'skip') skipTwoMinutes();
      else if (a === 'arrived' && LIVE) act('arrived', { value: b.dataset.v });
      else if (a === 'outcome' && LIVE) act('outcome', { value: b.dataset.v });
      else if (a === 'arrived') { if (b.dataset.v === 'Yes') { S.step = 'close'; S.cur = Object.assign({}, S.cur, { arrived: 'Yes' }); say('nurse', 'Yes, arrived'); say('bot', M.T.outcomeQ); render(); } else closeOut(b.dataset.v, null); }
      else if (a === 'outcome') closeOut('Yes', b.dataset.v);
    });
    setInterval(tick, 500);
  }

  function randomHex(n) {
    var a = new Uint8Array(n / 2); (root.crypto || {}).getRandomValues ? root.crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.floor(Math.random() * 256); });
    return Array.prototype.map.call(a, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  function headers() { var h = { 'content-type': 'application/json' }; if (KEY) h['x-live-key'] = KEY; return h; }

  function modeNote(text, cls) {
    var el = document.getElementById('mode-note'); if (!el) return;
    el.hidden = !text; el.textContent = text || ''; el.className = 'banner ' + (cls || '');
  }

  function sync(st) {
    OFFSET = st.serverTime - Date.now();
    D.replyWindowSec = st.replyWindowSec;
    S.facilities = st.facilities; S.refs = st.refs; S.cur = st.cur; S.chat = st.chat; S.step = st.step; S.scenario = st.scenario; S.outbox = st.outbox || [];
    showTelegram(st.telegram);
    var sig = JSON.stringify([st.facilities, st.refs, st.cur, st.chat, st.step, st.scenario, st.outbox]);
    if (sig !== LAST) { LAST = sig; render(); }
  }

  // Live session only: links that connect a phone to the Telegram test bot.
  function showTelegram(links) {
    var el = document.getElementById('tg-links'); if (!el) return;
    if (!links || !links.length) { el.hidden = true; return; }
    if (el.dataset.done) return;
    el.dataset.done = '1'; el.hidden = false;
    el.innerHTML = '<div class="lbl">Connect phones on Telegram</div><p>Open a link on the phone, then tap Start. One phone can play every role.</p><div class="opts">' +
      links.map(function (l) { return '<a class="btn' + (l.role === 'all' ? ' primary' : '') + '" href="' + esc(l.url) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>'; }).join('') + '</div>';
  }

  function act(action, args) {
    if (BUSY) return Promise.resolve();
    BUSY = true;
    return fetch('/api/act', { method: 'POST', headers: headers(), body: JSON.stringify({ sid: SID, action: action, args: args || {} }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Error'); sync(j); }); })
      .catch(function (e) { modeNote('Could not reach the server: ' + e.message + ' Try again.', 'warnb'); })
      .then(function () { BUSY = false; });
  }

  function poll() {
    if (BUSY) return;
    fetch('/api/state?sid=' + SID, { headers: headers() }).then(function (r) { return r.json(); }).then(function (j) { if (!BUSY && j.facilities) sync(j); }).catch(function () {});
  }

  // Use the live server when it answers. Without one (a static page), fall back to the local demo.
  function connect() {
    var p = new URLSearchParams(root.location.search);
    KEY = p.get('key') || null;
    if (KEY) SID = 'live';
    else {
      try { SID = root.localStorage.getItem('mk-sid'); } catch (e) { SID = null; }
      if (!SID || !/^[a-f0-9]{16}$/.test(SID)) { SID = randomHex(16); try { root.localStorage.setItem('mk-sid', SID); } catch (e) {} }
    }
    return fetch('/api/state?sid=' + SID, { headers: headers() })
      .then(function (r) { if (!r.ok) throw new Error('no server'); return r.json(); })
      .then(function (st) {
        if (!st.facilities) throw new Error('no server');
        LIVE = true;
        document.body.classList.add('is-live');
        modeNote(st.live
          ? 'LIVE: real WhatsApp messages and a real phone call go to the team test phones. The 2-minute timer runs on the server.'
          : 'Live server: this is your own private session. The 2-minute timer runs on the server. Messages are shown on screen and are not sent to any phone.', st.live ? 'liveb' : '');
        sync(st);
        setInterval(poll, 1500);
        return true;
      })
      .catch(function () { return false; });
  }

  function init() {
    if (!document.getElementById('nurse-body')) return;
    bind();
    connect().then(function (ok) { if (!ok) reset('confirms'); });
  }

  MK.app = { init: init, _state: S };
  if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : globalThis);
