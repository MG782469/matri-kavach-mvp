/* Outbound channels. Real Twilio calls only for the live session and only to numbers set in environment variables.
   Nothing here ever sends to a number typed into the web form. */
const crypto = require('node:crypto');

const ROLE_ENV = {
  nurse: 'PHONE_NURSE', chc: 'PHONE_CHC', dh: 'PHONE_DH', sdh: 'PHONE_SDH', mc: 'PHONE_MC',
  doctor: 'PHONE_DOCTOR', bloodbank: 'PHONE_BLOODBANK', family: 'PHONE_FAMILY', district: 'PHONE_DISTRICT', asha: 'PHONE_ASHA', driver: 'PHONE_DRIVER', emt: 'PHONE_EMT'
};

const digits = (p) => String(p || '').replace(/\D/g, '');
/* TEST_PHONE is one number that stands in for the nurse, the hospitals, the doctor and the family during the team test.
   Blood bank, ASHA and district alerts stay on screen unless their own phone is set (this saves trial messages). */
const TEST_ROLES = ['nurse', 'chc', 'dh', 'sdh', 'mc', 'doctor', 'family'];
const phoneFor = (role) => process.env[ROLE_ENV[role]] || (TEST_ROLES.includes(role) ? process.env.TEST_PHONE || '' : '');
const sameNumber = (a, b) => digits(a).length >= 10 && digits(a).slice(-10) === digits(b).slice(-10);
const configured = () => Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
const baseUrl = () => (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

function roleForNumber(num) {
  return Object.keys(ROLE_ENV).filter((r) => sameNumber(phoneFor(r), num));
}

async function twilio(path, params) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/${path}.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(sid + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${body.message || 'request failed'}`);
  return body;
}

const waNumber = (p) => 'whatsapp:+' + digits(p).replace(/^0+/, '');
const e164 = (p) => '+' + digits(p);

/* Returns {status, channel}. status: sent | simulated | no-phone | failed */
async function sendText(live, role, text) {
  const to = phoneFor(role);
  if (!live || !configured()) return { status: 'simulated', channel: 'screen' };
  if (!to) return { status: 'no-phone', channel: 'none' };
  try {
    if ((process.env.CHANNEL || 'whatsapp') === 'sms') {
      await twilio('Messages', { To: e164(to), From: process.env.TWILIO_SMS_FROM, Body: text });
      return { status: 'sent', channel: 'sms' };
    }
    await twilio('Messages', { To: waNumber(to), From: 'whatsapp:' + e164(process.env.TWILIO_WHATSAPP_FROM || '+14155238886'), Body: text });
    if (process.env.SMS_ALSO === '1' && process.env.TWILIO_SMS_FROM && role === 'family') {
      await twilio('Messages', { To: e164(to), From: process.env.TWILIO_SMS_FROM, Body: text });
    }
    return { status: 'sent', channel: 'whatsapp' };
  } catch (e) {
    console.error('send failed', role, e.message);
    return { status: 'failed', channel: 'whatsapp', error: e.message };
  }
}

/* Plain SMS (fallback when the family has no WhatsApp). Needs Twilio keys and TWILIO_SMS_FROM; otherwise shown on screen only. */
async function sendSms(live, role, text) {
  const to = phoneFor(role);
  if (!live || !configured() || !process.env.TWILIO_SMS_FROM) return { status: 'simulated', channel: 'sms' };
  if (!to) return { status: 'no-phone', channel: 'sms' };
  try {
    await twilio('Messages', { To: e164(to), From: process.env.TWILIO_SMS_FROM, Body: text });
    return { status: 'sent', channel: 'sms' };
  } catch (e) {
    console.error('sms failed', role, e.message);
    return { status: 'failed', channel: 'sms', error: e.message };
  }
}

async function placeCall(live, role, refId) {
  const to = phoneFor(role);
  if (!live || !configured() || !to || !process.env.TWILIO_SMS_FROM) return { status: 'simulated' };
  try {
    const q = `?ref=${encodeURIComponent(refId)}`;
    await twilio('Calls', {
      To: e164(to), From: e164(process.env.TWILIO_SMS_FROM),
      Url: baseUrl() + '/twilio/voice' + q, StatusCallback: baseUrl() + '/twilio/voice-status' + q,
      StatusCallbackEvent: 'completed', Timeout: '30'
    });
    return { status: 'sent' };
  } catch (e) {
    console.error('call failed', role, e.message);
    return { status: 'failed', error: e.message };
  }
}

/* Twilio signs the full URL plus sorted POST params with the auth token (HMAC-SHA1, base64). */
function validSignature(req) {
  if (process.env.SKIP_TWILIO_SIGNATURE === '1') return true;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const url = baseUrl() + req.originalUrl;
  const data = Object.keys(req.body || {}).sort().reduce((acc, k) => acc + k + req.body[k], url);
  const expected = crypto.createHmac('sha1', token).update(data).digest('base64');
  const got = String(req.get('x-twilio-signature') || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

module.exports = { phoneFor, sameNumber, roleForNumber, sendText, sendSms, placeCall, validSignature, configured, baseUrl };
