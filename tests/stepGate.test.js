/**
 * tests/stepGate.test.js
 * 3 quyet dinh pipeline (user chot 2026-10-22):
 *
 * 1) PLANNING chi lam viec PLANNING, xong phai chuyen qua buoc khac.
 *    Ke hoach da verify (marker .plan_ok.json) => bo qua agent PLANNING.
 * 2) IMPLEMENT phai xac dinh code da implement chua; da du => skip sang TESTING.
 *    Ket luan do agent PLANNING ghi trong dev_plan.md (marker IMPLEMENT_STATUS).
 * 3) TESTING va cac buoc sau LUON chay lai => evidence cu reset ve NOT VERIFY.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stepGate = require('../src/execution/stepGate');
const store = require('../src/verification/evidenceStore');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-gate-'));
}

// --- Marker ke hoach hop le -------------------------------------------------

test('plan marker: ghi va doc lai duoc', () => {
  const dir = tmpDir();
  assert.equal(stepGate.readPlanOkMarker(dir), null, 'chua co marker => null');
  stepGate.writePlanOkMarker(dir, { taskCode: 'T-1' });
  const m = stepGate.readPlanOkMarker(dir);
  assert.ok(m, 'phai doc duoc marker');
  assert.equal(m.taskCode, 'T-1');
  assert.ok(m.at, 'phai co timestamp');
});

test('plan marker: xoa duoc (plan bi sua => verify lai)', () => {
  const dir = tmpDir();
  stepGate.writePlanOkMarker(dir, { taskCode: 'T-1' });
  stepGate.clearPlanOkMarker(dir);
  assert.equal(stepGate.readPlanOkMarker(dir), null);
});


test('plan marker: gan van tay plan (hash) de kiem tra hieu luc', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'dev_plan.md'), '# Dev\n\nv1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'test_plan.md'), '# Test\n\nv1\n', 'utf8');
  stepGate.writePlanOkMarker(dir, { taskCode: 'T-1' });
  const m = stepGate.readPlanOkMarker(dir);
  assert.ok(m.planFingerprint, 'marker phai co van tay plan');
  assert.ok(m.planFingerprint.hash, 'phai co hash');
  assert.equal(stepGate.isPlanMarkerValid(dir, m).valid, true, 'plan khong doi => marker con hieu luc');
});

test('plan marker: plan bi SUA sau khi xac nhan => marker HET HIEU LUC', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'dev_plan.md'), '# Dev\n\nv1\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'test_plan.md'), '# Test\n\nv1\n', 'utf8');
  stepGate.writePlanOkMarker(dir, { taskCode: 'T-1' });
  const m = stepGate.readPlanOkMarker(dir);
  assert.equal(stepGate.isPlanMarkerValid(dir, m).valid, true);

  // Agent sua plan o buoc sau => phai chay lai PLANNING de verify lai.
  fs.writeFileSync(path.join(dir, 'dev_plan.md'), '# Dev\n\nv2 - da sua\n', 'utf8');
  const check = stepGate.isPlanMarkerValid(dir, m);
  assert.equal(check.valid, false, 'plan da doi => marker phai het hieu luc');
  assert.match(check.reason, /thay doi/i);
});

test('plan marker: khong co fingerprint (marker cu) => HET HIEU LUC (an toan)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'dev_plan.md'), '# Dev\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'plan_ok.json'), JSON.stringify({ at: 'x' }), 'utf8');
  const old = { at: 'x' };
  const check = stepGate.isPlanMarkerValid(dir, old);
  assert.equal(check.valid, false, 'marker khong co van tay plan => phai chay lai');
});

test('plan marker: khong co marker => het hieu luc', () => {
  const dir = tmpDir();
  const check = stepGate.isPlanMarkerValid(dir, null);
  assert.equal(check.valid, false);
  assert.match(check.reason, /khong co marker/i);
});
// --- Marker trang thai implement ---------------------------------------------

test('implement status: doc duoc DONE / NEEDED tu dev_plan.md', () => {
  const done = '# Dev Plan\n\n<!-- IMPLEMENT_STATUS: DONE -->\n\nNội dung';
  assert.equal(stepGate.readImplementStatus(done), 'DONE');
  const needed = '# Dev Plan\n\n<!-- IMPLEMENT_STATUS: NEEDED -->\n\nNội dung';
  assert.equal(stepGate.readImplementStatus(needed), 'NEEDED');
});

test('implement status: khong co marker => null (phai chay IMPLEMENT)', () => {
  assert.equal(stepGate.readImplementStatus('# Dev Plan\n\nKhông có marker'), null);
  assert.equal(stepGate.readImplementStatus(''), null);
  assert.equal(stepGate.readImplementStatus(null), null);
});

test('implement status: ghi marker vao dev_plan.md (chen sau tieu de dau tien)', () => {
  const out = stepGate.writeImplementStatus('# Dev Plan\n\n## 1. Muc 1', 'DONE');
  assert.match(out, /<!-- IMPLEMENT_STATUS: DONE -->/);
  assert.ok(out.indexOf('IMPLEMENT_STATUS') < out.indexOf('## 1. Muc 1'), 'marker phai o truoc noi dung');
  assert.equal(stepGate.readImplementStatus(out), 'DONE');
});

test('implement status: ghi de marker cu (khong nhan doi them marker)', () => {
  const once = stepGate.writeImplementStatus('# Dev Plan', 'DONE');
  const twice = stepGate.writeImplementStatus(once, 'NEEDED');
  assert.equal((twice.match(/IMPLEMENT_STATUS/g) || []).length, 1, 'chi duoc co 1 marker');
  assert.equal(stepGate.readImplementStatus(twice), 'NEEDED');
});

// --- Reset evidence cho TESTING ----------------------------------------------

test('TESTING: reset toan bo evidence ve NOT VERIFY', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png', 'b.log'] }]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));
  fs.writeFileSync(path.join(dir, 'b.log'), 'log');

  store.setStatuses(dir, { 'a.png': 'PASS', 'b.log': 'FAILED' });
  let items = store.listEvidence(dir);
  assert.equal(items.filter((i) => i.status === 'PASS').length, 1, 'truoc reset co 1 PASS');

  const n = store.resetAllToNotVerify(dir);
  assert.equal(n, 2, 'phai reset ca 2 file');

  items = store.listEvidence(dir);
  assert.equal(items.filter((i) => i.status === 'PASS').length, 0, 'khong con PASS nao');
  assert.equal(items.filter((i) => i.status === 'FAILED').length, 0, 'khong con FAILED nao');
  assert.equal(items.filter((i) => i.status === 'NOT VERIFY').length, 2, 'ca 2 phai la NOT VERIFY');
});

test('TESTING: reset evidence rong => 0, khong loi', () => {
  const dir = tmpDir();
  assert.equal(store.resetAllToNotVerify(dir), 0);
  assert.equal(store.resetAllToNotVerify(null), 0);
});

test('TESTING: reset giu nguyen metadata tests[] (khong phai xoa case)', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', name: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(dir, 'a.png'), 'x'.repeat(100));
  store.setStatuses(dir, { 'a.png': 'PASS' });
  store.resetAllToNotVerify(dir);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
  assert.equal(Array.isArray(raw.tests), true, 'tests[] phai con nguyen');
  assert.equal(raw.tests[0].id, 'TC-01');
});
