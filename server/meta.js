/* WhatsApp through Meta's own Cloud API (free test number from developers.facebook.com).
   Free-form text works inside the 24-hour window that opens when the phone messages the test number first. */
const crypto = require('node:crypto');
const TYPES = (() => { try { return require('../src/data.js').emergencyTypes || []; } catch (e) { return []; } })();

function createMeta(opts = {}) {
  const env = (k) => (opts[k] !== undefined ? opts[k] : process.env[k]);
  const token = env('WA_TOKEN');
  const phoneId = env('WA_PHONE_NUMBER_ID');
  const version = env('WA_GRAPH_VERSION') || 'v26.0';
  const appSecret = env('WA_APP_SECRET');
  const enabled = () => Boolean(token && phoneId);
  /* The verify token Meta asks for when you add the webhook. Shown on the live page so nobody has to invent one. */
  const verifyToken = () => env('WA_VERIFY_TOKEN') || (process.env.LIVE_KEY ? crypto.createHash('sha256').update('meta:' + process.env.LIVE_KEY).digest('hex').slice(0, 20) : '');

  const api = opts.api || (async (body) => {
    const r = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = j.error || {};
      const hint = e.code === 131047 ? ' (the phone must send a message to the test number first: 24-hour window)'
        : e.code === 190 ? ' (WA_TOKEN expired: copy a new one from Meta API Setup)'
        : e.code === 131030 ? ' (add this phone to the allowed numbers in Meta API Setup)' : '';
      throw new Error(`WhatsApp ${e.code || r.status}: ${e.message || 'request failed'}${hint}`);
    }
    return j;
  });

  const to = (phone) => String(phone || '').replace(/\D/g, '');

  /* Turns a plain reply into a WhatsApp list or buttons when it ends with numbered choices, so nobody has to type numbers.
     `label` (who this phone is acting as) goes on top, because in the team test one phone plays every role. */
  function shape(phone, text, label) {
    const base = { messaging_product: 'whatsapp', to: to(phone) };
    const head = label ? { type: 'text', text: label.slice(0, 60) } : undefined;
    const plain = () => Object.assign(base, { type: 'text', text: { body: (label ? '*' + label + '*\n' : '') + text, preview_url: false } });
    const buttons = (body, opts) => Object.assign(base, { type: 'interactive', interactive: Object.assign(head ? { header: head } : {}, {
      type: 'button', body: { text: body },
      action: { buttons: opts.map((o) => ({ type: 'reply', reply: { id: o.id, title: o.title.slice(0, 20) } })) } }) });
    const list = (body, opts, button) => Object.assign(base, { type: 'interactive', interactive: Object.assign(head ? { header: head } : {}, {
      type: 'list', body: { text: body },
      action: { button: (button || 'Choose').slice(0, 20), sections: [{ title: 'Choose one', rows: opts.slice(0, 10).map((o) => Object.assign({ id: o.id, title: o.title.slice(0, 24) }, o.desc ? { description: o.desc.slice(0, 72) } : {})) }] } }) });
    if (text.length > 1000) return plain();
    if (/^INCOMING|^URGENT/.test(text)) {
      return buttons(text, [{ id: '1', title: '1 All ready' }, { id: '2 15', title: '2 Ready in 15 min' }, { id: '3', title: '3 Not available' }]);
    }
    // Patient form link: a button that opens the one-page form
    const fl = text.match(/^Open the patient form: (https?:\/\/\S+)\n([\s\S]*)$/);
    if (fl) {
      return Object.assign(base, { type: 'interactive', interactive: Object.assign(head ? { header: head } : {}, {
        type: 'cta_url', body: { text: '📝 Patient details form. ' + fl[2] },
        action: { name: 'cta_url', parameters: { display_text: '📝 Open form', url: fl[1] } } }) });
    }
    // Language choice on the first Hi
    if (/Choose language \/ भाषा चुनें\.$/.test(text)) {
      return buttons(text, [{ id: 'LANG EN', title: 'English' }, { id: 'LANG HI', title: 'हिंदी (Hindi)' }]);
    }
    // Emergency list after Hi (English or Hindi)
    const tl = text.match(/^([\s\S]*?)\s*(?:On WhatsApp, reply with a number: |WhatsApp पर नंबर भेजें: )[\s\S]*$/);
    if (tl && TYPES.length) {
      const hi = /नमस्ते/.test(tl[1]);
      const body = tl[1].replace(/ Tap Choose emergency to start a referral\./, '').replace(/ रेफ़रल शुरू करने के लिए Choose emergency दबाएँ।/, '') +
        (hi ? '\n\nनीचे *Choose emergency* दबाएँ। हर सूची पर हमारे क्लिनिकल पार्टनर के हस्ताक्षर हैं।' : '\n\nTap *Choose emergency* below. Each list is signed by our clinical partner.');
      return list(body, TYPES.map((t, i) => ({ id: String(i + 1), title: (i + 1) + ' ' + (t.short || t.label), desc: t.label })), 'Choose emergency');
    }
    if (/Tap SEND to confirm, or CHANGE to pick another\.|पुष्टि के लिए SEND दबाएँ/.test(text)) {
      return buttons(text.replace('Tap SEND to confirm, or CHANGE to pick another.', 'Tap *SEND* to confirm, *CHANGE* to pick another, or *Add details* for name, age and blood group.'),
        [{ id: 'SEND', title: '✅ SEND' }, { id: 'CHANGE', title: '🔁 CHANGE' }, { id: 'DETAILS', title: '📝 Add details' }]);
    }
    // Numbered choices at the end of the last line: "Tap: 1 Yes, 2 No, 3 Transferred." / "Outcome: 1 Delivered, 2 Other."
    const lines = text.split('\n'); const last = lines[lines.length - 1];
    const at = last.search(/(?:Tap:?|Tap one\.|Outcome:|number:|दबाएँ:|नतीजा:)\s*1\s+\S/);
    if (at >= 0) {
      const tail = last.slice(at).replace(/^(?:Tap:?|Tap one\.|Outcome:|number:|दबाएँ:|नतीजा:)\s*/, '');
      const opts = tail.split(/[.,]\s+(?=\d+\s)/).map((x) => x.trim().replace(/[.।]$/, '').match(/^(\d+)\s+(.+)$/)).filter(Boolean).map((m) => ({ id: m[1], title: m[1] + ' ' + m[2], desc: m[2] }));
      if (opts.length >= 2 && opts.length <= 10) {
        return opts.length <= 3 && opts.every((o) => o.title.length <= 20) ? buttons(text, opts) : list(text, opts);
      }
    }
    return plain();
  }

  async function sendTo(phone, text, label) {
    return api(shape(phone, text, label));
  }

  async function sendText(live, phone, text, label) {
    if (!live) return { status: 'simulated', channel: 'screen' };
    if (!phone) return { status: 'no-phone', channel: 'none' };
    try { await sendTo(phone, text, label); return { status: 'sent', channel: 'whatsapp' }; } catch (e) {
      console.error('meta send failed', e.message);
      return { status: 'failed', channel: 'whatsapp', error: e.message };
    }
  }

  function validSignature(req) {
    if (!appSecret) return true; // optional: set WA_APP_SECRET to check Meta's signature
    const got = String(req.get('x-hub-signature-256') || '');
    const want = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody || '').digest('hex');
    return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  }

  /* Pulls {from, text} out of a webhook POST. Button taps carry the reply id ("1", "2 15", "3"). */
  function incoming(body) {
    const out = [];
    for (const e of (body && body.entry) || []) for (const c of e.changes || []) for (const m of (c.value && c.value.messages) || []) {
      const text = m.type === 'text' ? m.text && m.text.body
        : m.type === 'interactive' ? (m.interactive.button_reply || m.interactive.list_reply || {}).id
        : m.type === 'button' ? m.button && (m.button.payload || m.button.text) : null;
      if (m.from && typeof text === 'string') out.push({ from: m.from, text: text.trim() });
    }
    return out;
  }

  return { enabled, verifyToken, sendText, sendTo, validSignature, incoming, shape };
}

module.exports = { createMeta };
