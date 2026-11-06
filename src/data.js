/* Synthetic district for the Matri-Kavach MVP. All names, people and numbers are fake. */
(function (root) {
  var DATA = {
    district: 'Synthetic district (demo)',
    speedKmh: 30,
    detourFactor: 1.4,
    replyWindowSec: 120,
    startPoint: { id: 'phc', name: 'PHC Rampur', nurse: 'Kavitha' },
    mother: { name: 'Lakshmi Devi', age: 24, bloodGroup: 'B+', deliveredAt: '22:41', contact: '98XXXXXX10' },
    // Heavy bleeding checklist: the 7 items signed by M Gufran (clinical partner).
    checklistItems: [
      { id: 'blood', label: 'Blood for mother’s group in stock, or cross-match within the hour' },
      { id: 'obstetrician', label: 'Obstetrician on duty or on call within 15 minutes' },
      { id: 'anaesthetist', label: 'Anaesthetist on duty' },
      { id: 'theatre', label: 'Operating theatre free, with suction and working equipment' },
      { id: 'uterotonics', label: 'Uterotonic drugs in stock: oxytocin, misoprostol, tranexamic acid' },
      { id: 'iv', label: 'IV fluids and cannulas in stock' },
      { id: 'bed', label: 'Post-operative or HDU bed free' }
    ],
    // Extra items for fits / eclampsia (approval record 4A, reviewed by M Gufran on 4 Nov 2026).
    // One shift check-in answers every item once; each emergency type uses the items it needs.
    extraItems: [
      { id: 'mgso4', label: 'Magnesium sulphate in stock and in date, with calcium gluconate as antidote' },
      { id: 'antihtn', label: 'Approved antihypertensive in stock (labetalol or nifedipine)' },
      { id: 'airway', label: 'Oxygen, suction, bag-mask, BP monitor and pulse oximeter checked' },
      { id: 'lab', label: 'Emergency lab open: platelets, kidney and liver tests' },
      { id: 'hdu', label: 'HDU or ICU bed free, with monitoring' },
      { id: 'newborn', label: 'Newborn resuscitation and preterm newborn care available' }
    ],
    facilities: [
      { id: 'chc', name: 'CHC Sonpur', short: 'CHC Sonpur', km: 9, role: 'CHC', kind: 'hospital',
        blood: 'O+ 2 units', who: 'Duty nurse', ini: 'S',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: false, theatre: true, uterotonics: true, iv: true, bed: true,
          mgso4: true, antihtn: true, airway: true, lab: false, hdu: false, newborn: false } } },
      { id: 'dh', name: 'District Hospital Devgarh', short: 'DH Devgarh', km: 21, role: 'Labour room in-charge', kind: 'hospital',
        blood: 'B+ 6 units', who: 'Sister Anjali', ini: 'A',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true,
          mgso4: true, antihtn: true, airway: true, lab: true, hdu: false, newborn: true } } },
      { id: 'sdh', name: 'Sub-district Hospital Kheri', short: 'SDH Kheri', km: 25, role: 'Labour room in-charge', kind: 'hospital',
        blood: 'B+ 3 units', who: 'Sister Rekha', ini: 'R',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true,
          mgso4: true, antihtn: true, airway: true, lab: true, hdu: true, newborn: true } } },
      { id: 'mc', name: 'Govt Medical College Rajnagar', short: 'GMC Rajnagar', km: 52, role: 'Obstetrics emergency desk', kind: 'fallback',
        blood: 'B+ 21 units', who: 'Duty registrar', ini: 'G',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true,
          mgso4: true, antihtn: true, airway: true, lab: true, hdu: true, newborn: true } } }
    ],
    // Emergency types. Only types with a reviewed checklist route; the others tell the nurse to call the doctor.
    emergencyTypes: [
      { id: 'bleeding', label: 'Heavy bleeding after delivery', short: 'Heavy bleeding', signed: true,
        items: ['blood', 'obstetrician', 'anaesthetist', 'theatre', 'uterotonics', 'iv', 'bed'],
        needs: 'blood, anaesthetist, theatre', bloodBank: true, review: 'Checklist signed by clinical partner' },
      { id: 'fits', label: 'Fits or eclampsia', short: 'Fits / eclampsia', signed: true,
        items: ['mgso4', 'antihtn', 'obstetrician', 'anaesthetist', 'airway', 'lab', 'theatre', 'hdu', 'newborn'],
        needs: 'magnesium sulphate, HDU bed, obstetrician', bloodBank: false,
        review: 'Reviewed by clinical partner, pending obstetrician validation' },
      { id: 'obstructed', label: 'Obstructed labour', signed: false },
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
      ]
    }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
  root.MK = root.MK || {}; root.MK.DATA = DATA;
})(typeof window !== 'undefined' ? window : globalThis);
