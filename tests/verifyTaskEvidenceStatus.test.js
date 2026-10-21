/**
 * tests/verifyTaskEvidenceStatus.test.js
 * verifyTaskEvidence phải GHI TRẠNG THÁI evidence sau khi verify:
 *   file hợp lệ -> PASS, file lỗi -> FAILED, file chưa verify -> NOT VERIFY.
 *
 * Test này chạy verifyTaskEvidence THẬT (qua require server.js) rồi đọc lại
 * metadata.json để assert — không mock.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyTaskEvidence } = require('../src/server.js');
const store = require('../src/verification/evidenceStore');

function makeFeature() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-vte-'));
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  // test_plan.md không yêu cầu UI screenshot -> tránh nhánh fail "chưa chụp ảnh UI"
  fs.writeFileSync(path.join(root, 'test_plan.md'), '# Test plan\n\nKhong yeu cau UI.\n', 'utf8');
  return { root, featureDir: root, evidenceDir };
}

test('verifyTaskEvidence ghi PASS cho file hop le', () => {
  const { featureDir, evidenceDir } = makeFeature();
  fs.writeFileSync(path.join(evidenceDir, 'a.png'), Buffer.alloc(6000, 1));
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-1',
    verdict: 'PASS',
    tests: [{ id: 'TC-01', name: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, null, 2), 'utf8');

  const res = verifyTaskEvidence({
    jobId: 'job-test-1',
    evidenceDir,
    featureDir,
    taskCode: 'T-1',
    emit: () => {}
  });

  assert.equal(typeof res.failed, 'boolean');
  const after = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'metadata.json'), 'utf8'));
  assert.equal(Array.isArray(after.tests), true, 'tests[] phai con nguyen');
  assert.equal(after.tests.length, 1, 'tests[] khong bi mat');
  assert.equal(after.evidenceStatus['a.png'].status, 'PASS', 'file hop le phai PASS');
  assert.equal(after.evidenceStatus['a.png'].verdict, 'PASS');
});

test('verifyTaskEvidence ghi FAILED cho file loi (undeclared - khong khai trong tests[])', () => {
  const { featureDir, evidenceDir } = makeFeature();
  fs.writeFileSync(path.join(evidenceDir, 'orphan.png'), Buffer.alloc(6000, 1));
  fs.writeFileSync(path.join(evidenceDir, 'declared.png'), Buffer.alloc(6000, 1));
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-2',
    tests: [{ id: 'TC-01', name: 'TC-01', status: 'PASSED', evidence: ['declared.png'] }]
  }, null, 2), 'utf8');

  const res = verifyTaskEvidence({
    jobId: 'job-test-2',
    evidenceDir,
    featureDir,
    taskCode: 'T-2',
    emit: () => {}
  });

  assert.equal(res.failed, true, 'file undeclared phai lam verify fail');
  const after = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'metadata.json'), 'utf8'));
  assert.equal(after.evidenceStatus['orphan.png'].status, 'FAILED');
  assert.equal(after.evidenceStatus['orphan.png'].verdict, 'FAIL');
  assert.equal(after.evidenceStatus['declared.png'].status, 'PASS');
  assert.equal(Array.isArray(after.tests), true, 'tests[] phai con nguyen');
  assert.equal(after.tests.length, 1);
});

test('verifyTaskEvidence giu NOT VERIFY cho file chua duoc verify', () => {
  const { featureDir, evidenceDir } = makeFeature();
  // File trong metadata nhung KHONG ton tai tren dia -> FAILED.
  // File ton tai va hop le -> PASS.
  // File chua co trong metadata va chua verify -> NOT VERIFY (record moi khong duoc ghi).
  fs.writeFileSync(path.join(evidenceDir, 'ok.png'), Buffer.alloc(6000, 1));
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-3',
    tests: [{ id: 'TC-01', name: 'TC-01', status: 'PASSED', evidence: ['ok.png'] }]
  }, null, 2), 'utf8');

  verifyTaskEvidence({
    jobId: 'job-test-3',
    evidenceDir,
    featureDir,
    taskCode: 'T-3',
    emit: () => {}
  });

  const meta = store.readMetadata(evidenceDir);
  const rec = meta.records.find((r) => r.fileName === 'ok.png');
  assert.equal(rec.status, 'PASS');
});

test('verifyTaskEvidence khong lam mat tests[] khi metadata shape array', () => {
  const { featureDir, evidenceDir } = makeFeature();
  fs.writeFileSync(path.join(evidenceDir, 'a.png'), Buffer.alloc(6000, 1));
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify([
    { fileName: 'a.png', stepName: 'step-1', status: 'CAPTURED' }
  ], null, 2), 'utf8');

  verifyTaskEvidence({
    jobId: 'job-test-4',
    evidenceDir,
    featureDir,
    taskCode: 'T-4',
    emit: () => {}
  });

  const after = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'metadata.json'), 'utf8'));
  assert.equal(Array.isArray(after), true, 'shape array phai giu array');
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'PASS');
  assert.equal(after[0].stepName, 'step-1', 'field goc phai con');
});

test('verifyTaskEvidence giu key goc khi metadata shape map', () => {
  const { featureDir, evidenceDir } = makeFeature();
  fs.writeFileSync(path.join(evidenceDir, 'a.png'), Buffer.alloc(6000, 1));
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify({
    taskCode: 'T-5',
    notes: 'ghi chu agent',
    'a.png': { stepName: 'step-1', status: 'CAPTURED' }
  }, null, 2), 'utf8');

  verifyTaskEvidence({
    jobId: 'job-test-5',
    evidenceDir,
    featureDir,
    taskCode: 'T-5',
    emit: () => {}
  });

  const after = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'metadata.json'), 'utf8'));
  assert.equal(after.taskCode, 'T-5', 'key goc bi mat');
  assert.equal(after.notes, 'ghi chu agent', 'key goc bi mat');
  assert.equal(after['a.png'].status, 'PASS');
});
