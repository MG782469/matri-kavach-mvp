/* WhatsApp Flows: the patient-details form opens INSIDE WhatsApp (no browser).
   One Flow per emergency type, built from the same questions as the web form (src/data.js forms).
   The server creates each Flow on Meta the first time it is needed (draft mode is enough for the test number),
   and reuses it by name afterwards. If anything fails, the caller falls back to the one-page web form link. */
const crypto = require('node:crypto');
const D = require('../src/data.js');

const BLOOD = ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-', 'Not known'];
const short = (label, max) => {
  const t = String(label).replace(/\?$/, '').replace(/\s*\(.*\)$/, '');
  if (t.length <= max) return t;
  let out = '';
  for (const w of t.split(' ')) { if ((out ? out + ' ' + w : w).length > max) break; out = out ? out + ' ' + w : w; }
  return out || t.slice(0, max);
};

/* The questions, in the same order as the web form. kind: text | number | phone | area | radio | dropdown */
function questions(typeId) {
  const m = D.mother || {};
  const form = D.forms[typeId] || D.forms.bleeding;
  const qs = [
    { id: 'name', label: 'Name', kind: 'text', init: m.name },
    { id: 'age', label: 'Age', kind: 'number', init: String(m.age || '') },
    { id: 'blood', label: 'Blood group (MCP card)', kind: 'dropdown', options: BLOOD, init: m.bloodGroup },
    { id: 'contact', label: 'Family contact', kind: 'phone', init: '' },
    { id: 'abha', label: 'ABHA number', kind: 'text', helper: 'Optional. The ABDM link is a mock in this demo.', init: '' }
  ];
  form.forEach((q) => {
    if (q.options) {
      const opts = q.options.concat(q.options.some((o) => /^(Unknown|Not checked|Not yet delivered)$/.test(o)) ? [] : ['Unknown']);
      qs.push({ id: q.id, label: q.label, kind: 'radio', options: opts });
    } else qs.push({ id: q.id, label: q.label, kind: q.id === 'other' ? 'area' : 'text', init: q.value || '' });
  });
  qs.push({ id: 'informed', label: 'Family told that details go to the hospital?', kind: 'radio', options: ['Yes', 'No'] });
  return qs;
}

function flowJson(typeId) {
  const t = D.emergencyTypes.find((x) => x.id === typeId) || { short: 'Emergency' };
  const kids = [
    { type: 'TextSubheading', text: 'Patient details: ' + (t.short || t.label) },
    { type: 'TextCaption', text: 'Facts only. Yes / No / Unknown, never a guess.' }
  ];
  const payload = {};
  for (const q of questions(typeId)) {
    payload[q.id] = '${form.' + q.id + '}';
    if (q.kind === 'radio') {
      const c = { type: 'RadioButtonsGroup', name: q.id, label: short(q.label, 30), required: false,
        'data-source': q.options.map((o, i) => ({ id: 'o' + i, title: o.slice(0, 30) })) };
      if (short(q.label, 30) !== q.label.replace(/\?$/, '')) c.description = q.label;
      kids.push(c);
    } else if (q.kind === 'dropdown') {
      const c = { type: 'Dropdown', name: q.id, label: short(q.label, 20), required: false,
        'data-source': q.options.map((o, i) => ({ id: 'o' + i, title: o })) };
      const at = q.options.indexOf(q.init);
      if (at >= 0) c['init-value'] = 'o' + at;
      kids.push(c);
    } else if (q.kind === 'area') {
      kids.push({ type: 'TextArea', name: q.id, label: short(q.label, 20), required: false, 'max-length': 100 });
    } else {
      const c = { type: 'TextInput', name: q.id, label: short(q.label, 20), required: false,
        'input-type': q.kind === 'number' ? 'number' : q.kind === 'phone' ? 'phone' : 'text' };
      const helper = q.helper || (short(q.label, 20) !== q.label ? q.label : '');
      if (helper) c['helper-text'] = helper.slice(0, 80);
      if (q.init) c['init-value'] = String(q.init);
      kids.push(c);
    }
  }
  kids.push({ type: 'Footer', label: 'Send details', 'on-click-action': { name: 'complete', payload } });
  return { version: '6.0', screens: [{ id: 'DETAILS', title: 'Patient details', terminal: true, success: true, data: {}, layout: { type: 'SingleColumnLayout', children: kids } }] };
}

/* Turn the Flow's answers (radio ids "o2") back into the option text the web form uses. */
function decode(typeId, ans) {
  const out = {};
  for (const q of questions(typeId)) {
    let v = ans ? ans[q.id] : undefined;
    if (v == null || v === '' || /^\$\{form\./.test(String(v))) { out[q.id] = ''; continue; }
    if (q.options) { const m = String(v).match(/^o(\d+)$/); v = m ? q.options[Number(m[1])] || '' : ''; }
    out[q.id] = String(v);
  }
  return out;
}

function createFlows(opts = {}) {
  const env = (k) => (opts[k] !== undefined ? opts[k] : process.env[k]);
  const token = env('WA_TOKEN');
  const version = env('WA_GRAPH_VERSION') || 'v26.0';
  // WhatsApp Business account of the Matri-Kavach test number (not a secret; override with WA_WABA_ID).
  const waba = env('WA_WABA_ID') || '1723089795913808';
  const enabled = () => Boolean(token) && env('WA_FLOWS') !== '0';
  const graph = opts.graph || (async (method, path, body) => {
    const r = await fetch(`https://graph.facebook.com/${version}/${path}`, {
      method, headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Flows ${(j.error && j.error.code) || r.status}: ${(j.error && j.error.message) || 'request failed'}`);
    return j;
  });
  const cache = new Map();
  let failedUntil = 0;

  async function ensure(typeId) {
    if (cache.has(typeId)) return cache.get(typeId);
    if (Date.now() < failedUntil) throw new Error('Flows unavailable (recent failure)');
    const json = flowJson(typeId);
    const name = 'mk_details_' + typeId + '_' + crypto.createHash('sha1').update(JSON.stringify(json)).digest('hex').slice(0, 8);
    try {
      const list = await graph('GET', `${waba}/flows?fields=id,name,status&limit=200`);
      let f = (list.data || []).find((x) => x.name === name);
      if (!f) {
        const made = await graph('POST', `${waba}/flows`, { name, categories: ['OTHER'], flow_json: JSON.stringify(json) });
        if (made.validation_errors && made.validation_errors.length) {
          console.error('flow validation errors', name, JSON.stringify(made.validation_errors).slice(0, 1500));
          throw new Error('Flow JSON has validation errors');
        }
        f = { id: made.id, name };
        console.log('flow created', name, made.id);
      }
      cache.set(typeId, f.id);
      return f.id;
    } catch (e) {
      failedUntil = Date.now() + 10 * 60 * 1000; // do not hammer Meta; the link form is used meanwhile
      throw e;
    }
  }

  /* The interactive message that opens the Flow. flow_token links the answers back to the case. */
  function message(phone, flowId, flowToken, body, label) {
    return {
      messaging_product: 'whatsapp', to: String(phone || '').replace(/\D/g, ''), type: 'interactive',
      interactive: Object.assign(label ? { header: { type: 'text', text: label.slice(0, 60) } } : {}, {
        type: 'flow', body: { text: body.slice(0, 1024) },
        action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: flowId, flow_cta: 'Open form', mode: env('WA_FLOW_MODE') || 'draft',
          flow_token: flowToken, flow_action: 'navigate', flow_action_payload: { screen: 'DETAILS' } } }
      })
    };
  }

  return { enabled, ensure, message };
}

module.exports = { createFlows, flowJson, questions, decode };
