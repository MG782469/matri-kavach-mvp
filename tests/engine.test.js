const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine.js');
const D = require('../src/data.js');

const withCheckin = (id, items) => D.facilities.map(f => f.id === id ? Object.assign({}, f, { checkin: items ? { shift: 'night', items } : null }) : f);
const allYes = D.facilities.find(f => f.id === 'dh').checkin.items;

test('happy path: DH Devgarh is proposed first and confirms', () => {
  let r = E.startReferral('bleeding', 0);
  r = E.propose(r, D.facilities, D, 0);
  assert.strictEqual(r.proposal, 'dh');
  r = E.sendTo(r, 0);
  r = E.onHospitalReply(r, 'dh', { kind: 'all-ready' }, D.facilities, D, 30000);
  assert.strictEqual(r.state, 'confirmed');
});

test('CHC Sonpur is never proposed for heavy bleeding (no anaesthetist)', () => {
  const c = E.candidatesFor(D.facilities, D, []);
  assert.ok(!c.some(x => x.id === 'chc'));
});

test('silent path: 2 minutes, IVR, then reroute to SDH Kheri sends at once', () => {
  let r = E.propose(E.startReferral('bleeding', 0), D.facilities, D, 0);
  r = E.sendTo(r, 0);
  r = E.onTimeout(r, 119000, D);
  assert.strictEqual(r.state, 'sent');
  r = E.onTimeout(r, 120000, D);
  assert.strictEqual(r.state, 'ivr');
  r = E.onIVR(r, 'none', D.facilities, D, 150000);
  assert.strictEqual(r.proposal, 'sdh');
  assert.strictEqual(r.state, 'sent');
  assert.strictEqual(r.timerStart, 150000);
});

test('not available: reroute with no wait', () => {
  let r = E.propose(E.startReferral('bleeding', 0), D.facilities, D, 0);
  r = E.sendTo(r, 0);
  r = E.onHospitalReply(r, 'dh', { kind: 'not-available' }, D.facilities, D, 5000);
  assert.strictEqual(r.proposal, 'sdh');
});

test('fallback: no Ready hospital goes to the medical college with a district alert', () => {
  const none = D.facilities.map(f => f.kind === 'hospital' ? Object.assign({}, f, { checkin: { shift: 'night', items: Object.assign({}, allYes, { blood: false }) } }) : f);
  const r = E.propose(E.startReferral('bleeding', 0), none, D, 0);
  assert.strictEqual(r.state, 'fallback');
  assert.strictEqual(r.destination, 'mc');
  assert.strictEqual(r.districtAlert, true);
});

test('uncertain: no check-in this shift is never routed as Ready', () => {
  const f = withCheckin('dh', null);
  assert.strictEqual(E.facilityStatus(f.find(x => x.id === 'dh'), D), 'uncertain');
  assert.ok(!E.candidatesFor(f, D, []).some(x => x.id === 'dh'));
});

test('ETA follows km, speed and detour factor', () => {
  assert.strictEqual(E.etaMinutes(9, D), 25);
});

test('determinism: same inputs give the same routing 100 times', () => {
  const runs = Array.from({ length: 100 }, () => E.propose(E.startReferral('bleeding', 0), D.facilities, D, 0).proposal);
  assert.ok(runs.every(x => x === 'dh'));
});

test('closed-loop rate changes as referrals close', () => {
  const confirmedA = E.onHospitalReply(E.sendTo(E.propose(E.startReferral('bleeding', 0), D.facilities, D, 0), 0), 'dh', { kind: 'all-ready' }, D.facilities, D, 0);
  const a = E.onClose(confirmedA, 'Yes', 'Delivered', 1);
  const b = E.startReferral('bleeding', 2);
  assert.strictEqual(E.closedLoopRate([a, b]), 0.5);
  const confirmed = E.onHospitalReply(E.sendTo(E.propose(b, D.facilities, D, 2), 2), 'dh', { kind: 'all-ready' }, D.facilities, D, 3);
  assert.strictEqual(E.closedLoopRate([a, E.onClose(confirmed, 'Yes', 'Delivered', 4)]), 1);
});

test('fits / eclampsia: DH has no HDU bed tonight, so SDH Kheri is proposed; bleeding still goes to DH', () => {
  const fits = E.propose(E.startReferral('fits', 0), D.facilities, D, 0);
  assert.strictEqual(fits.proposal, 'sdh');
  assert.strictEqual(E.facilityStatus(D.facilities.find(f => f.id === 'dh'), D, 'fits'), 'not-ready');
  assert.strictEqual(E.facilityStatus(D.facilities.find(f => f.id === 'dh'), D, 'bleeding'), 'ready');
  assert.deepStrictEqual(E.itemsFor('fits', D).map(i => i.id), ['mgso4', 'antihtn', 'obstetrician', 'anaesthetist', 'airway', 'lab', 'theatre', 'hdu', 'newborn']);
  assert.strictEqual(E.itemsFor('bleeding', D).length, 7);
});

test('fits: an unknown item (missing in the check-in) is never Ready', () => {
  const items = Object.assign({}, D.facilities.find(f => f.id === 'sdh').checkin.items);
  delete items.mgso4;
  const f = withCheckin('sdh', items).find(x => x.id === 'sdh');
  assert.strictEqual(E.facilityStatus(f, D, 'fits'), 'not-ready');
});
