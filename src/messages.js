/* Every message text the MVP shows. Placeholders in [brackets] are filled by fill(). */
(function (root) {
  var T = {
    menu: 'Matri-Kavach. Tap: New emergency referral.',
    pickType: 'Tap one emergency type:',
    typeNotSigned: 'The checklist for this type is not signed yet. For this demo, please use heavy bleeding after delivery.',
    details: 'Patient details. You can send these now or later.',
    proposed: 'Sending to [hospital], [km] km, about [eta] min. Tap SEND to confirm, or CHANGE to pick another.',
    sent: 'Ambulance 108 has the destination. The hospital is being asked to confirm. We will update you.',
    ready: '[hospital]: ALL READY. Mother expected about [time].',
    readyIn: '[hospital]: ready in [min] min. Mother expected about [time].',
    silent: 'No reply from [hospital] yet. Calling the duty phone now.',
    reroute: 'Rerouted to [hospital], the backup. Ambulance has been told.',
    fallback: 'No hospital has confirmed ready. Medical college is the destination. District officer has been alerted.',
    closeQ: 'Did the mother arrive? Tap: 1 Yes, 2 No, 3 Transferred.',
    outcomeQ: 'Outcome: 1 Delivered, 2 Other.',
    closed: 'Thank you. The PHC and ASHA will get the summary.',
    incoming: 'INCOMING: Heavy bleeding. ETA [eta] min. Blood group [group]. Needs: blood, anaesthetist, theatre. Tap: 1 All ready, 2 Ready in __ min, 3 Not available.',
    ivrScript: 'Automated call: Heavy bleeding referral, ETA [eta] minutes. Press 1 if all ready.',
    doctor: 'Facts-only summary: name, age, blood group, delivery time, treatment given, live ETA. Secure link expires in 2 hours (demo).',
    blood: 'B+ alert for [hospital]. Arranged under JSSK. The family is not asked for blood.',
    family: '[hospital], about [eta] minutes. Bring the MCP card and Aadhaar.',
    asha: 'Outcome recorded for [name]. Day 3, 7 and 42 visits are scheduled.',
    district: 'Referral [id]: no hospital ready tonight. Medical college is the destination.'
  };
  function fill(key, vars) {
    return T[key].replace(/\[(\w+)\]/g, function (_, k) { return vars && vars[k] != null ? vars[k] : '[' + k + ']'; });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { T: T, fill: fill };
  root.MK = root.MK || {}; root.MK.messages = { T: T, fill: fill };
})(typeof window !== 'undefined' ? window : globalThis);
