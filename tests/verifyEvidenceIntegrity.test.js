/**
 * tests/verifyEvidenceIntegrity.test.js
 * Do chinh xac VERIFY: file KHAI trong metadata.json nhung KHONG TON TAI tren dia
 * => phai FAIL (khong duoc PASS voi 0 bang chung thuc te).
 *
 * Job RSGATE-44 (bd88ae0a): metadata.json khai 17 file, evidence/ chi con
 * metadata.json => co the PASS voi 0 bang chung.
 *
 * Gate phai FAIL-CLOSED: loi trong luc verify => FAIL, khong phai PASS.
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
    const p = path.join(evidenceDir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return { root, featureDir, evidenceDir };
}

// Ly do trong `reasons` co dau tieng Viet => so bang `tồn tại` (co dau),
// khong phai `khong ton tai` (ASCII) - se khong khop.
const MISSING_REASON_RE = /tồn tại/i;
const MISSING_FILE_RE = /b\.log|a\.png/;

test('metadata khai file KHONG ton tai => FAIL (co ly do "KHONG ton tai")', () => {
  const { featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png', 'b.log'] }]
  });
  // KHONG tao a.png / b.log tren dia.
  const res = verifyTaskEvidence({
    jobId: 'v-1', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  assert.equal(res.failed, true, 'phai FAIL khi file khai ma khong ton tai');
  const reasons = JSON.stringify(res.reasons || []);
  assert.equal(MISSING_REASON_RE.test(reasons), true,
    `phai co ly do "KHONG ton tai trong dia", thuc te: ${reasons}`);
});

test('TEST AM: co 1 file that hop le + khai them file thieu => FAIL vi file thieu', () => {
  // truong hop nay validFiles.length > 0 => khong fail vi "khong co bang chung nao".
  // Chi co the fail vi ly do "file khai ma khong ton tai" => chung minh gate moi hoat dong.
  const { featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png', 'b.log'] }]
  }, { 'a.png': 'x'.repeat(6000) });
  const res = verifyTaskEvidence({
    jobId: 'v-2', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  assert.equal(res.failed, true, 'phai FAIL');
  const reasons = JSON.stringify(res.reasons || []);
  assert.equal(MISSING_REASON_RE.test(reasons), true,
    `phai co ly do file thieu, thuc te: ${reasons}`);
  assert.equal(MISSING_FILE_RE.test(reasons), true,
    `phai nhac ten file bi thieu, thuc te: ${reasons}`);
});

test('metadata khai file TON TAI => khong fail vi ly do file thieu', () => {
  const { featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['a.png'] }]
  }, { 'a.png': 'x'.repeat(6000) });
  const res = verifyTaskEvidence({
    jobId: 'v-3', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  const reasons = JSON.stringify(res.reasons || []);
  assert.equal(MISSING_REASON_RE.test(reasons) && MISSING_FILE_RE.test(reasons), false,
    `khong duoc fail vi thieu file khai: ${reasons}`);
});

test('duong dan lop sau (sub/dir/a.png) co that tren dia => KHONG fail oan', () => {
  const { featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: ['sub/dir/a.png'] }]
  }, { 'sub/dir/a.png': 'x'.repeat(6000) });
  const res = verifyTaskEvidence({
    jobId: 'v-4', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  const reasons = JSON.stringify(res.reasons || []);
  assert.equal(MISSING_REASON_RE.test(reasons) && MISSING_FILE_RE.test(reasons), false,
    `duong dan lop sau co that => khong duoc bao thieu: ${reasons}`);
});

test('t.evidence la OBJECT (khong phai array) => khong throw, van FAIL vi file thieu', () => {
  // Agent tu viet metadata => t.evidence co the la object. Truoc day .forEach
  // throw => catch ngoai => gate FAIL-OPEN (PASS khong bang chung).
  const { featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: { fileName: 'a.png' } }]
  }, { 'a.png': 'x'.repeat(6000) });
  const res = verifyTaskEvidence({
    jobId: 'v-5', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  assert.equal(res.failed, true, 'khong duoc PASS');
});

test('t.evidence la OBJECT khai file thieu => FAIL, khong fail-open', () => {
  const { featureDir, evidenceDir } = makeFeature({
    taskCode: 'T-1',
    tests: [{ id: 'TC-01', status: 'PASSED', evidence: { fileName: 'missing.png' } }]
  }, { 'a.png': 'x'.repeat(6000) });
  const res = verifyTaskEvidence({
    jobId: 'v-6', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  assert.equal(res.failed, true, 'phai FAIL, khong duoc fail-open PASS');
  const reasons = JSON.stringify(res.reasons || []);
  assert.equal(MISSING_REASON_RE.test(reasons), true, `phai co ly do file thieu: ${reasons}`);
});

test('khong co metadata.json => van FAIL (khong co bang chung nao)', () => {
  const { featureDir, evidenceDir } = makeFeature(null, { 'a.png': 'x'.repeat(6000) });
  const res = verifyTaskEvidence({
    jobId: 'v-7', evidenceDir, featureDir, taskCode: 'T-1', emit: () => {}
  });
  assert.equal(res.failed, true, 'khong metadata.json => phai FAIL');
});
