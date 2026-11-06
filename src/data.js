/* Synthetic district for the Matri-Kavach MVP. All names, people and numbers are fake. */
(function (root) {
  var DATA = {
    district: 'Synthetic district (demo)',
    speedKmh: 30,
    detourFactor: 1.4,
    replyWindowSec: 120,
    startPoint: { id: 'phc', name: 'PHC Rampur', nurse: 'Kavitha', x: 20, y: 50 },
    // Synthetic map (km grid) for the district view and for ASHA home emergencies. Not real places.
    villages: [
      { id: 'bhuiyan', name: 'Village Bhuiyan', x: 12, y: 62 },
      { id: 'kesla', name: 'Village Kesla', x: 33, y: 40 }
    ],
    bloodGroups: ['A+', 'A-', 'B+', 'B-', 'O+', 'O-', 'AB+', 'AB-'],
    // Items that can be sent from another hospital (idea: inter-hospital supply). OFF by default, not approved.
    movableItems: ['blood', 'uterotonics', 'iv', 'mgso4', 'antihtn'],
    // Minimum nurses on duty before the district is told about a staffing gap (demo rule).
    minNurses: 2,
    // Demo role logins (RBAC): synthetic numbers, the one-time code is shown on screen. Not real numbers.
    roleLogins: [
      { role: 'nurse', label: 'PHC nurse', phone: '90000 00001' },
      { role: 'dh', label: 'DH Devgarh labour room', phone: '90000 00002' },
      { role: 'sdh', label: 'SDH Kheri labour room', phone: '90000 00003' },
      { role: 'chc', label: 'CHC Sonpur duty phone', phone: '90000 00004' },
      { role: 'mc', label: 'GMC Rajnagar emergency desk', phone: '90000 00005' },
      { role: 'doctor', label: 'Receiving doctor', phone: '90000 00006' },
      { role: 'bloodbank', label: 'Blood bank', phone: '90000 00007' },
      { role: 'driver', label: '108 driver', phone: '90000 00008' },
      { role: 'emt', label: '108 EMT', phone: '90000 00009' },
      { role: 'family', label: 'Family', phone: '90000 00010' },
      { role: 'district', label: 'District officer', phone: '90000 00011' },
      { role: 'asha', label: 'ASHA', phone: '90000 00012' }
    ],
    mother: { name: 'Lakshmi Devi', age: 24, bloodGroup: 'B+', deliveredAt: '22:41', contact: '98XXXXXX10' },
    // Heavy bleeding checklist: the 7 items signed by M Gufran (clinical partner).
    // One shift check-in answers every item once; each emergency type uses the items it needs.
    // Items come from M Gufran's approval record (4 Nov 2026), cross-checked with NHM CEmONC 2024 and FOGSI-GESTOSIS-ICOG HDP 2026.
    // group = the heading the item sits under on the check-in screen.
    checklistItems: [
      { id: 'blood', short: 'blood', group: 'Blood and drugs', label: 'Blood of her group, or cross-match within 1 hour' },
      { id: 'obstetrician', group: 'Staff', label: 'Obstetrician on duty, or on call within 15 min' },
      { id: 'anaesthetist', group: 'Staff', label: 'Anaesthetist on duty' },
      { id: 'theatre', group: 'Rooms and beds', label: 'Operating theatre free, suction working' },
      { id: 'uterotonics', short: 'uterotonic drugs', group: 'Blood and drugs', label: 'Oxytocin, misoprostol, tranexamic acid in stock' },
      { id: 'iv', short: 'IV fluids', group: 'Blood and drugs', label: 'IV fluids and cannulas in stock' },
      { id: 'bed', group: 'Rooms and beds', label: 'Post-op or HDU bed free' }
    ],
    extraItems: [
      { id: 'mgso4', short: 'magnesium sulphate', group: 'Blood and drugs', label: 'Magnesium sulphate + calcium gluconate in stock' },
      { id: 'antihtn', short: 'antihypertensive', group: 'Blood and drugs', label: 'Labetalol or nifedipine in stock' },
      { id: 'antibiotics', group: 'Blood and drugs', label: 'IV antibiotics in stock' },
      { id: 'airway', group: 'Equipment and lab', label: 'Oxygen, suction, bag-mask, BP and SpO2 monitor working' },
      { id: 'lab', group: 'Equipment and lab', label: 'Emergency lab open: blood counts, kidney, liver' },
      { id: 'usg', group: 'Equipment and lab', label: 'Ultrasound available' },
      { id: 'hdu', group: 'Rooms and beds', label: 'HDU or ICU bed free' },
      { id: 'newborn', group: 'Equipment and lab', label: 'Newborn resuscitation corner ready' },
      { id: 'paed', group: 'Staff', label: 'Paediatrician on duty or on call' },
      { id: 'sncu', group: 'Rooms and beds', label: 'SNCU (newborn unit) bed free' }
    ],
    itemGroups: ['Staff', 'Rooms and beds', 'Blood and drugs', 'Equipment and lab'],
    facilities: [
      { id: 'chc', name: 'CHC Sonpur', short: 'CHC Sonpur', km: 9, role: 'CHC', kind: 'hospital', x: 27, y: 45, nurses: 1, hfr: 'IN0000DEMO01',
        bloodStock: { 'O+': 2 },
        blood: 'O+ 2 units', who: 'Duty nurse', ini: 'S',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: false, theatre: true, uterotonics: true, iv: true, bed: true,
          mgso4: true, antihtn: true, airway: true, lab: false, hdu: false, newborn: false, antibiotics: true, usg: false, paed: false, sncu: false } } },
      { id: 'dh', name: 'District Hospital Devgarh', short: 'DH Devgarh', km: 21, role: 'Labour room in-charge', kind: 'hospital', x: 40, y: 57, nurses: 3, hfr: 'IN0000DEMO02',
        bloodStock: { 'A+': 4, 'B+': 6, 'O+': 5, 'AB+': 1, 'O-': 1 },
        blood: 'B+ 6 units', who: 'Sister Anjali', ini: 'A',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true,
          mgso4: true, antihtn: true, airway: true, lab: true, hdu: false, newborn: true, antibiotics: true, usg: true, paed: true, sncu: true } } },
      { id: 'sdh', name: 'Sub-district Hospital Kheri', short: 'SDH Kheri', km: 25, role: 'Labour room in-charge', kind: 'hospital', x: 10, y: 27, nurses: 2, hfr: 'IN0000DEMO03',
        bloodStock: { 'A+': 2, 'B+': 3, 'O+': 4, 'B-': 1, 'A-': 1 },
        blood: 'B+ 3 units', who: 'Sister Rekha', ini: 'R',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true,
          mgso4: true, antihtn: true, airway: true, lab: true, hdu: true, newborn: true, antibiotics: true, usg: true, paed: true, sncu: true } } },
      { id: 'mc', name: 'Govt Medical College Rajnagar', short: 'GMC Rajnagar', km: 52, role: 'Obstetrics emergency desk', kind: 'fallback', x: 70, y: 34, nurses: 6, hfr: 'IN0000DEMO04',
        bloodStock: { 'A+': 12, 'B+': 21, 'O+': 18, 'AB+': 4, 'A-': 2, 'B-': 2, 'O-': 3, 'AB-': 1 },
        blood: 'B+ 21 units', who: 'Duty registrar', ini: 'G',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true,
          mgso4: true, antihtn: true, airway: true, lab: true, hdu: true, newborn: true, antibiotics: true, usg: true, paed: true, sncu: true } } }
    ],
    // Emergency types. Only types with a reviewed checklist route; the others tell the nurse to call the doctor.
    // Emergency types. signed: true = on M Gufran's sign-off record and routed. signed: false = not routed, the nurse calls the doctor.
    emergencyTypes: [
      { id: 'bleeding', label: 'Heavy bleeding after delivery (PPH)', short: 'Heavy bleeding', signed: true,
        items: ['blood', 'obstetrician', 'anaesthetist', 'theatre', 'uterotonics', 'iv', 'bed'],
        needs: 'blood, anaesthetist, theatre', bloodBank: true, review: 'Signed by M Gufran (clinical partner)' },
      { id: 'fits', label: 'Fits or eclampsia', short: 'Fits / eclampsia', signed: true,
        items: ['mgso4', 'antihtn', 'obstetrician', 'anaesthetist', 'airway', 'lab', 'theatre', 'hdu', 'newborn'],
        needs: 'magnesium sulphate, HDU bed, obstetrician', bloodBank: false, review: 'Signed by M Gufran (typed name, 4 Nov 2026). Obstetrician validation needed before a pilot' },
      { id: 'obstructed', label: 'Obstructed labour', short: 'Obstructed labour', signed: true,
        items: ['obstetrician', 'anaesthetist', 'theatre', 'blood', 'iv', 'antibiotics', 'newborn', 'bed'],
        needs: 'obstetrician, anaesthetist, theatre for caesarean, newborn resuscitation', bloodBank: true, review: 'Signed by M Gufran (typed name, 4 Nov 2026). Obstetrician validation needed before a pilot' },
      { id: 'aph', label: 'Bleeding before delivery (APH)', short: 'APH', signed: true,
        items: ['obstetrician', 'anaesthetist', 'blood', 'theatre', 'iv', 'airway', 'usg', 'newborn'],
        needs: 'blood, obstetrician, theatre, newborn resuscitation', bloodBank: true, review: 'Signed by M Gufran (typed name, 4 Nov 2026). Obstetrician validation needed before a pilot',
        safety: 'Safety: no vaginal examination until placenta praevia is ruled out by the treating team.' },
      { id: 'sepsis', label: 'Fever after delivery (possible sepsis)', short: 'Sepsis', signed: true,
        items: ['antibiotics', 'iv', 'airway', 'lab', 'obstetrician', 'anaesthetist', 'theatre', 'hdu'],
        needs: 'IV antibiotics, HDU bed, obstetrician', bloodBank: false, review: 'Signed by M Gufran (typed name, 4 Nov 2026). Obstetrician validation needed before a pilot' },
      // Not on the sign-off record yet: shown as a proposed list, not routed.
      { id: 'newborn', label: 'Newborn emergency', short: 'Newborn', signed: false,
        draft: ['Paediatrician on duty or on call', 'SNCU bed free', 'Oxygen and bag-mask working', 'Newborn resuscitation corner ready'] },
      { id: 'other', label: 'Other: call the doctor now', signed: false }
    ],
    // Baseline from our simulation of 20,000 synthetic night emergencies (not real data).
    baseline: { doorMin: 131, firstReadyPct: 52, source: 'Simulation, 20,000 synthetic night emergencies' },
    // How long the blood bank holds a unit for a confirmed referral before it is released.
    bloodHoldMin: 60,
    // A shift check-in older than this is shown as old: the hospital must confirm before it is trusted.
    checkinValidHours: 8,
    // Synthetic monthly readiness report for the district dashboard (not real data).
    monthReport: {
      month: 'October 2026 (synthetic)', shifts: 93,
      rows: [
        { id: 'chc', checkins: 84, gap: 'No anaesthetist on 22 nights', arrivals: 0, mismatches: 0 },
        { id: 'dh', checkins: 92, gap: 'HDU bed full on 11 nights; B- blood short on 3 nights', arrivals: 18, mismatches: 1 },
        { id: 'sdh', checkins: 90, gap: 'Obstetrician only on call (not on site) on 6 nights', arrivals: 9, mismatches: 0 },
        { id: 'mc', checkins: 93, gap: 'No gaps reported', arrivals: 4, mismatches: 0 }
      ]
    },
    // What the nurse sends for each type, after name, age, blood group and family contact. Facts only, no diagnosis.
    forms: {
      bleeding: [
        { id: 'time', label: 'Time of delivery', value: '22:41' },
        { id: 'mode', label: 'Mode of delivery', options: ['Normal', 'Caesarean', 'Not yet delivered'] },
        { id: 'oxy', label: 'Oxytocin 10 IU given?', options: ['Yes', 'No'] },
        { id: 'miso', label: 'Misoprostol 600 mcg given?', options: ['Yes', 'No'] },
        { id: 'iv', label: 'IV line in place?', options: ['Yes', 'No'] }
      ],
      fits: [
        { id: 'fits', label: 'Number of fits', value: '2' },
        { id: 'lastfit', label: 'Time of last fit', value: '22:10' },
        { id: 'bp', label: 'Latest BP', value: '168/112' },
        { id: 'weeks', label: 'Weeks of pregnancy, or delivered', value: '34 weeks' },
        { id: 'mgso4', label: 'Magnesium sulphate loading dose given?', options: ['Yes', 'No', 'Unknown'] },
        { id: 'antihtn', label: 'Antihypertensive given?', options: ['Yes', 'No', 'Unknown'] },
        { id: 'iv', label: 'IV line and catheter in place?', options: ['Yes', 'No'] }
      ],
      obstructed: [
        { id: 'start', label: 'Labour started at', value: '06:30' },
        { id: 'waters', label: 'Waters broke at', value: '12:15' },
        { id: 'fhr', label: 'Baby heartbeat heard?', options: ['Yes', 'No', 'Not checked'] },
        { id: 'prevcs', label: 'Previous caesarean?', options: ['No', 'Yes', 'Unknown'] },
        { id: 'iv', label: 'IV line in place?', options: ['Yes', 'No'] },
        { id: 'abx', label: 'Antibiotic given?', options: ['Yes', 'No', 'Unknown'] }
      ],
      aph: [
        { id: 'weeks', label: 'Weeks of pregnancy', value: '33 weeks' },
        { id: 'since', label: 'Bleeding started at', value: '21:50' },
        { id: 'pads', label: 'Pads soaked so far', value: '3' },
        { id: 'pain', label: 'Pain in the belly?', options: ['No', 'Yes'] },
        { id: 'moving', label: 'Baby moving?', options: ['Yes', 'No', 'Unknown'] },
        { id: 'iv', label: 'IV line in place?', options: ['Yes', 'No'] }
      ],
      sepsis: [
        { id: 'delivered', label: 'Delivered on', value: '3 days ago' },
        { id: 'temp', label: 'Temperature', value: '39.2 °C' },
        { id: 'pulse', label: 'Pulse', value: '124' },
        { id: 'bp', label: 'Latest BP', value: '94/60' },
        { id: 'abx', label: 'Antibiotic given?', options: ['No', 'Yes'] },
        { id: 'iv', label: 'IV line in place?', options: ['Yes', 'No'] }
      ]
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
  root.MK = root.MK || {}; root.MK.DATA = DATA;
})(typeof window !== 'undefined' ? window : globalThis);
