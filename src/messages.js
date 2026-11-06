/* Every message text the MVP shows. Placeholders in [brackets] are filled by fill(). */
(function (root) {
  var T = {
    menu: 'Matri-Kavach. Tap: New emergency referral.',
    hello: 'Namaste! This is Matri-Kavach, emergency referral help for PHC Rampur. Tap Choose emergency to start a referral.',
    sayHi: 'Type Hi to start a new emergency referral.',
    busy: 'A referral is in progress. Please use the buttons above.',
    pickType: 'Tap one emergency type:',
    typeNotSigned: 'The checklist for this type is not reviewed yet. Call the doctor now. For this demo, use heavy bleeding or fits.',
    reviewNote: 'Checklist status: [review].',
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
    incoming: 'INCOMING: [type]. ETA [eta] min. Blood group [group]. Needs: [needs]. Tap: 1 All ready, 2 Ready in __ min, 3 Not available.',
    ivrScript: 'Automated call: [type] referral, ETA [eta] minutes. Press 1 if all ready.',
    doctor: 'Facts-only summary: name, age, blood group, delivery time, treatment given, live ETA. Secure link expires in 2 hours (demo).',
    blood: '[group] alert for [hospital]. Arranged under JSSK. The family is not asked for blood.',
    family: '[hospital], about [eta] minutes. Bring the MCP card and Aadhaar.',
    asha: 'Outcome recorded for [name]. Day 3, 7 and 42 visits are scheduled.',
    district: 'Referral [id]: no hospital ready tonight. Medical college is the destination.',
    driver: '108 trip: pick up at [from]. Go to [hospital], [km] km. The hospital is confirming now. Patient details are with the hospital, not on this phone.',
    driverChange: '108 change: go to [hospital] instead, [km] km. Turn now if already on the way.',
    emt: '108 EMT handover: [type]. [name], [age] years, blood group [group]. Nurse facts: [facts]. Going to [hospital], about [eta] min. If she gets worse on the way, call the PHC doctor or the hospital labour room. Facts only, no diagnosis.',
    emtOk: '[hospital] has confirmed. The labour room team is waiting. Hand over the nurse facts at the door.',
    driverOk: '108: [hospital] has confirmed. The labour room team will meet you at the door.',
    checkinSaved: 'Shift check-in saved for [hospital] by [who]: [yes] Yes, [no] No[missing]. Ready tonight for: [readyFor].',
    checkinRemind: 'Reminder: the night shift check-in for [hospital] is not done. Until you check in, this hospital shows as Uncertain and gets no referrals. Open the check-in and tap Yes or No for each item.',
    checkinEscalate: '[hospital] has not done the night shift check-in. It is shown as Uncertain and gets no referrals until it checks in.'
  };
  function fill(key, vars) {
    return T[key].replace(/\[(\w+)\]/g, function (_, k) { return vars && vars[k] != null ? vars[k] : '[' + k + ']'; });
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { T: T, fill: fill };
  root.MK = root.MK || {}; root.MK.messages = { T: T, fill: fill };
})(typeof window !== 'undefined' ? window : globalThis);
