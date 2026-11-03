/* WhatsApp through Meta's own Cloud API (free test number from developers.facebook.com).
   Free-form text works inside the 24-hour window that opens when the phone messages the test number first. */
const crypto = require('node:crypto');

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

  async function sendTo(phone, text) {
    if (/^INCOMING|^URGENT/.test(text) && text.length <= 1024) {
      return api({ messaging_product: 'whatsapp', to: to(phone), type: 'interactive', interactive: {
        type: 'button', body: { text },
        action: { buttons: [
          { type: 'reply', reply: { id: '1', title: '1 All ready' } },
          { type: 'reply', reply: { id: '2 15', title: '2 Ready in 15 min' } },
          { type: 'reply', reply: { id: '3', title: '3 Not available' } }] } } });
    }
    return api({ messaging_product: 'whatsapp', to: to(phone), type: 'text', text: { body: text, preview_url: false } });
  }

  async function sendText(live, phone, text) {
    if (!live) return { status: 'simulated', channel: 'screen' };
    if (!phone) return { status: 'no-phone', channel: 'none' };
    try { await sendTo(phone, text); return { status: 'sent', channel: 'whatsapp' }; } catch (e) {
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

  return { enabled, verifyToken, sendText, sendTo, validSignature, incoming };
}

module.exports = { createMeta };
