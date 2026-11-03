/* Telegram as a free test channel (no message limits, no approvals). WhatsApp stays the production channel.
   A phone joins by opening a link shown only on the live page: t.me/<bot>?start=<code>_<role>. */
const crypto = require('node:crypto');

const TEAM_ROLES = ['nurse', 'chc', 'dh', 'sdh', 'mc', 'doctor', 'family'];
const ALL_ROLES = TEAM_ROLES.concat(['bloodbank', 'asha', 'district']);
const ROLE_NAMES = { all: 'all team roles (nurse, hospital, doctor, family)', nurse: 'Nurse', dh: 'Hospital', doctor: 'Doctor', family: 'Family' };
const LINK_ROLES = ['all', 'nurse', 'dh', 'doctor', 'family'];
const CONTACTS = 'tg-contacts';

function createTelegram(store, opts = {}) {
  const token = opts.token !== undefined ? opts.token : process.env.TELEGRAM_BOT_TOKEN;
  const enabled = () => Boolean(token);
  const secret = token ? crypto.createHash('sha256').update('wh:' + token).digest('hex').slice(0, 32) : '';
  const joinCode = () => (process.env.LIVE_KEY ? crypto.createHash('sha256').update('join:' + process.env.LIVE_KEY).digest('hex').slice(0, 16) : '');
  let username = null;

  const api = opts.api || (async (method, params) => {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params)
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error('Telegram: ' + (j.description || r.status));
    return j.result;
  });

  const contacts = async () => (await store.get(CONTACTS)) || { id: CONTACTS, chats: {} };
  const rolesOf = (v) => (v.roles.includes('all') ? TEAM_ROLES : v.roles);

  async function setup(baseUrl) {
    if (!enabled()) return;
    const me = await api('getMe', {});
    username = me.username;
    if (baseUrl) await api('setWebhook', { url: baseUrl + '/telegram/webhook', secret_token: secret, allowed_updates: ['message'] });
  }

  async function chatsFor(role) {
    const c = await contacts();
    return Object.keys(c.chats).filter((id) => rolesOf(c.chats[id]).includes(role));
  }

  async function sendText(live, role, text) {
    if (!live) return { status: 'simulated', channel: 'screen' };
    const ids = await chatsFor(role);
    if (!ids.length) return { status: 'no-phone', channel: 'telegram' };
    const params = { text, disable_web_page_preview: true };
    if (/^INCOMING|^URGENT/.test(text)) params.reply_markup = { keyboard: [[{ text: '1 All ready' }], [{ text: '2 15' }, { text: '3 Not available' }]], one_time_keyboard: true, resize_keyboard: true };
    try {
      for (const id of ids) await api('sendMessage', Object.assign({ chat_id: id }, params));
      return { status: 'sent', channel: 'telegram' };
    } catch (e) {
      console.error('telegram send failed', role, e.message);
      return { status: 'failed', channel: 'telegram', error: e.message };
    }
  }

  function links() {
    if (!username || !joinCode()) return null;
    return LINK_ROLES.map((r) => ({ role: r, label: r === 'all' ? 'One phone for everything' : ROLE_NAMES[r], url: `https://t.me/${username}?start=${joinCode()}_${r}` }));
  }

  async function join(chatId, name, arg) {
    const [code, role] = String(arg || '').split('_');
    if (!code || code !== joinCode()) return 'This link is not valid. Open the Telegram link from the Matri-Kavach live page.';
    const r = role === 'all' || ALL_ROLES.includes(role) ? role : 'all';
    const c = await contacts();
    c.chats[String(chatId)] = { roles: [r], name: String(name || '').slice(0, 40), at: Date.now() };
    await store.put(c);
    return `Connected as ${ROLE_NAMES[r] || r}. Matri-Kavach test alerts will arrive here. Synthetic data only.`;
  }

  async function rolesForChat(chatId) {
    const c = await contacts();
    const v = c.chats[String(chatId)];
    return v ? rolesOf(v) : [];
  }

  const reply = (chatId, text) => api('sendMessage', { chat_id: chatId, text, reply_markup: { remove_keyboard: true } });

  return { enabled, secret, setup, sendText, links, join, rolesForChat, reply };
}

module.exports = { createTelegram };
