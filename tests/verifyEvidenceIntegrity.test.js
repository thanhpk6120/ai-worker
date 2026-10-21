/**
 * tests/verifyEvidenceIntegrity.test.js
 * Do chinh xac VERIFY: file KHAI trong metadata.json nhung KHONG TON TAI tren dia
 * => phai FAIL (khong duoc PASS voi 0 bang chung thuc te).
 *
 * Job RSGATE-44 (bd88ae0a): metadata.json khai 17 file, evidence/ chi con
 * metadata.json => co the PASS voi 0 bang chung.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { verifyTaskEvidence } = require('../src/server.js');

function makeFeature(metadata, files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-vev-'));
  const featureDir = path.join(root, 'docs', 'features', 'T-1');
  const evidenceDir = path.join(featureDir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'test_plan.md'), '# Test plan\n', 'utf8');
  if (metadata) fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(evidenceDir, name), content, 'utf8');
  }
  return { root, featureDir, evidenceDir };
}

test('metadata khai file KHONG ton tai => FAIL', () => {
  const { featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png', 'b.log'] }]
  });
  // KHONG tao a.png / b.log tren dia.
  const res = verifyTaskEvidence({
    jobId: 'v-1', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  assert.equal(res.failed, true, 'phai FAIL khi file khai ma khong ton tai');
});

test('metadata khai file TON TAI => khong fail vi ly do nay', () => {
  const { featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, { 'a.png': 'x'.repeat(6000) });
  const res = verifyTaskEvidence({
    jobId: 'v-2', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  // Van co the fail vi ly do khac (anh UI/TC mapping) - nhung KHONG duoc fail
  // vi "file khai ma khong ton tai".
  const reasons = JSON.stringify(res.reasons || []);
  assert.equal(/khong ton tai/i.test(reasons) && /a\.png/.test(reasons), false,
    `khong duoc fail vi thieu file khai: ${reasons}`);
});

test('duong dan tuyet doi trong metadata => basename doi chieu duoc', () => {
  const { root, featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['sub/dir/a.png'] }]
  });
  // Tao file o evidence/sub/dir/a.png (nested).
  fs.mkdirSync(path.join(evidenceDir, 'sub', 'dir'), { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'sub', 'dir', 'a.png'), 'x'.repeat(6000));
  const res = verifyTaskEvidence({
    jobId: 'v-3', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  const reasons = JSON.stringify(res.reasons || []);
  assert.equal(/khong ton tai/i.test(reasons) && /a\.png/.test(reasons), false,
    `duong dan tuyet doi co basename a.png tren dia => khong duoc bao thieu: ${reasons}`);
});

test('khong co metadata.json => van FAIL (khong co bang chung nao)', () => {
  const { featureDir, evidenceDir } = makeFeature(null, { 'a.png': 'x'.repeat(6000) });
  const res = verifyTaskEvidence({
    jobId: 'v-4', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  assert.equal(res.failed, true, 'khong metadata.json => phai FAIL');
});
