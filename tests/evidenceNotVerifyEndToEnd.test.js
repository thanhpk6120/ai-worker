/**
 * tests/evidenceNotVerifyEndToEnd.test.js
 * End-to-end: agent tự tạo metadata.json khai PASSED -> UI (getTaskEvidences)
 * phải hiện NOT VERIFY. Sau khi VERIFY chạy -> mới PASS.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-e2e-ev-'));
  const evidenceDir = path.join(root, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'test_plan.md'), '# Test plan\n\nKhong yeu cau UI.\n', 'utf8');
  return { root, featureDir: root, evidenceDir };
}

test('E2E: agent tu khai PASSED -> file van NOT VERIFY truoc khi VERIFY chay', () => {
  const { featureDir, evidenceDir } = makeFeature();
  fs.writeFileSync(path.join(evidenceDir, 'a.png'), Buffer.alloc(6000, 1));
  // Agent tự tay ghi metadata.json với status PASSED (mô phỏng agent tự khai PASS).
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify({
    taskCode: 'E2E-1',
    verdict: 'PASS',
    tests: [{ id: 'TC-01', name: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, null, 2), 'utf8');

  // Đọc như UI đọc ( qua store ) -> phải NOT VERIFY.
  const items = store.listEvidence(evidenceDir);
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'NOT VERIFY', 'evidence moi phai NOT VERIFY');
  assert.equal(items[0].verdict, null, 'verdict phai null');
});

test('E2E: sau VERIFY -> PASS, tests[] van nguyen ban', () => {
  const { featureDir, evidenceDir } = makeFeature();
  fs.writeFileSync(path.join(evidenceDir, 'a.png'), Buffer.alloc(6000, 1));
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify({
    taskCode: 'E2E-2',
    verdict: 'PASS',
    tests: [{ id: 'TC-01', name: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, null, 2), 'utf8');

  verifyTaskEvidence({
    jobId: 'job-e2e-2',
    evidenceDir,
    featureDir,
    taskCode: 'E2E-2',
    emit: () => {}
  });

  const items = store.listEvidence(evidenceDir);
  assert.equal(items[0].status, 'PASS', 'VERIFY xong phai PASS');
  assert.equal(items[0].verdict, 'PASS');

  const after = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'metadata.json'), 'utf8'));
  assert.equal(Array.isArray(after.tests), true, 'tests[] phai con nguyen (gate VERIFY doc raw)');
  assert.equal(after.tests[0].status, 'PASSED', 'tests[] nguyen ban');
  assert.equal(after.evidenceStatus['a.png'].status, 'PASS');
  assert.equal(after.evidenceStatus['a.png'].verified, true);
});
