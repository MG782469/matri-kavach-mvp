/* Synthetic district for the Matri-Kavach MVP. All names, people and numbers are fake. */
(function (root) {
  var DATA = {
    district: 'Synthetic district (demo)',
    speedKmh: 30,
    detourFactor: 1.4,
    replyWindowSec: 120,
    startPoint: { id: 'phc', name: 'PHC Rampur', nurse: 'Kavitha' },
    mother: { name: 'Lakshmi Devi', age: 24, bloodGroup: 'B+', deliveredAt: '22:41', contact: '98XXXXXX10' },
    // Heavy bleeding checklist: the 7 items signed by Dr Gufran.
    checklistItems: [
      { id: 'blood', label: 'Blood for mother’s group in stock, or cross-match within the hour' },
      { id: 'obstetrician', label: 'Obstetrician on duty or on call within 15 minutes' },
      { id: 'anaesthetist', label: 'Anaesthetist on duty' },
      { id: 'theatre', label: 'Operating theatre free, with suction and working equipment' },
      { id: 'uterotonics', label: 'Uterotonic drugs in stock: oxytocin, misoprostol, tranexamic acid' },
      { id: 'iv', label: 'IV fluids and cannulas in stock' },
      { id: 'bed', label: 'Post-operative or HDU bed free' }
    ],
    facilities: [
      { id: 'chc', name: 'CHC Sonpur', short: 'CHC Sonpur', km: 9, role: 'CHC', kind: 'hospital',
        blood: 'O+ 2 units', who: 'Duty nurse', ini: 'S',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: false, theatre: true, uterotonics: true, iv: true, bed: true } } },
      { id: 'dh', name: 'District Hospital Devgarh', short: 'DH Devgarh', km: 21, role: 'Labour room in-charge', kind: 'hospital',
        blood: 'B+ 6 units', who: 'Sister Anjali', ini: 'A',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true } } },
      { id: 'sdh', name: 'Sub-district Hospital Kheri', short: 'SDH Kheri', km: 25, role: 'Labour room in-charge', kind: 'hospital',
        blood: 'B+ 3 units', who: 'Sister Rekha', ini: 'R',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true } } },
      { id: 'mc', name: 'Govt Medical College Rajnagar', short: 'GMC Rajnagar', km: 52, role: 'Obstetrics emergency desk', kind: 'fallback',
        blood: 'B+ 21 units', who: 'Duty registrar', ini: 'G',
        checkin: { shift: 'night', items: { blood: true, obstetrician: true, anaesthetist: true, theatre: true, uterotonics: true, iv: true, bed: true } } }
    ],
    // Emergency types. Only heavy bleeding has a signed checklist in this MVP.
    emergencyTypes: [
      { id: 'bleeding', label: 'Heavy bleeding after delivery', signed: true },
      { id: 'fits', label: 'Fits or eclampsia', signed: false },
      { id: 'obstructed', label: 'Obstructed labour', signed: false },
      { id: 'other', label: 'Other: call the doctor now', signed: false }
    ]
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = DATA;
  root.MK = root.MK || {}; root.MK.DATA = DATA;
})(typeof window !== 'undefined' ? window : globalThis);
