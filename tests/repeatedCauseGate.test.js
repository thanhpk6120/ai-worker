/**
 * tests/repeatedCauseGate.test.js
 * Co che chong VONG LAP: khi nguyen nhan loi cua vong hien tai giong het
 * nhung loi da gap o vong truoc thi dung vong lap (FAILED) thay vi retry
 * them voi ket qua se giong nhu vong truoc.
 *
 * Ca 2 tang:
 * - jobPolicy: chu ky loi (signature) chuan hoa + lich su luu trong pipeline_config
 * - systemone: model that quyet dinh "trung nguyen nhan khong" (fallback: so chu ky)
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jobPolicy = require('../src/execution/jobPolicy');
const policy = require('../src/systemone/policy');

// --- Chu ky loi (signature) -------------------------------------------------

test('signature chuan hoa: khac chi tiet nhe (so, duong dan) => cung chu ky', () => {
  const a = jobPolicy.buildFailureSignature('Error: file D:\\a\\b.ts line 42: cannot read');
  const b = jobPolicy.buildFailureSignature('Error: file D:\\a\\c.ts line 99: cannot read');
  assert.equal(a, b, 'khac duong dan/so dong => van cung nguyen nhan');
});

test('signature chuan hoa: khac nguyen nhan that => khac chu ky', () => {
  const a = jobPolicy.buildFailureSignature('TypeError: undefined is not a function');
  const b = jobPolicy.buildFailureSignature('TS2322: Type string not assignable to number');
  assert.notEqual(a, b);
});

test('signature chuan hoa: timestamp va uuid bi loai => cung chu ky', () => {
  const a = jobPolicy.buildFailureSignature('2026-10-21T03:26:36.819Z job 11111111-2222-3333-4444-555555555555 failed');
  const b = jobPolicy.buildFailureSignature('2026-10-22T09:11:02.001Z job 99999999-8888-7777-6666-555555555555 failed');
  assert.equal(a, b);
});

test('signature rong khi reason rong', () => {
  assert.equal(jobPolicy.buildFailureSignature(''), '');
  assert.equal(jobPolicy.buildFailureSignature(null), '');
  assert.equal(jobPolicy.buildFailureSignature(undefined), '');
});

// --- Lich su loi ------------------------------------------------------------

test('append + get failure history giu lai qua cac vong', () => {
  let job = { pipeline_config: {} };
  const sig = jobPolicy.buildFailureSignature('boom');
  job.pipeline_config = jobPolicy.appendFailureHistory(job, sig, 'IMPLEMENT', 1);
  job.pipeline_config = jobPolicy.appendFailureHistory(job, sig, 'IMPLEMENT', 2);
  const hist = jobPolicy.getFailureHistory(job);
  assert.equal(hist.length, 2);
  assert.equal(hist[0].step, 'IMPLEMENT');
  assert.equal(hist[1].attempt, 2);
});

test('findRepeatedFailure: chu ky giong => repeated=true, khac => false', () => {
  let job = { pipeline_config: {} };
  const sigA = jobPolicy.buildFailureSignature('timeout 3600000ms');
  const sigB = jobPolicy.buildFailureSignature('exit code 1');
  job.pipeline_config = jobPolicy.appendFailureHistory(job, sigA, 'IMPLEMENT', 1);

  const dup = jobPolicy.findRepeatedFailure(job, sigA, 'IMPLEMENT');
  assert.equal(dup.repeated, true);
  assert.equal(dup.occurrences, 1);

  const other = jobPolicy.findRepeatedFailure(job, sigB, 'IMPLEMENT');
  assert.equal(other.repeated, false);
});

test('findRepeatedFailure: chu ky giong nhung khac step => khong trung (phai so theo step)', () => {
  let job = { pipeline_config: {} };
  const sig = jobPolicy.buildFailureSignature('exit code 1');
  job.pipeline_config = jobPolicy.appendFailureHistory(job, sig, 'IMPLEMENT', 1);
  const cross = jobPolicy.findRepeatedFailure(job, sig, 'FIXING');
  assert.equal(cross.repeated, false, 'IMPLEMENT truoc do khong phai FIXING truoc do');
});

test('clearFailureHistory xoa sach lich su (dung khi restart/clone)', () => {
  let job = { pipeline_config: {} };
  const sig = jobPolicy.buildFailureSignature('boom');
  job.pipeline_config = jobPolicy.appendFailureHistory(job, sig, 'IMPLEMENT', 1);
  const cleared = jobPolicy.clearFailureHistory(job.pipeline_config);
  assert.equal(cleared.failure_history, undefined);
  assert.equal(jobPolicy.getFailureHistory({ pipeline_config: cleared }).length, 0);
});

test('getFailureHistory tra [] khi pipeline_config hong (JSON hong)', () => {
  const hist = jobPolicy.getFailureHistory({ pipeline_config: '{khong phai JSON' });
  assert.deepEqual(hist, []);
});

// --- Heuristic SystemOne ----------------------------------------------------

test('heuristic offline: chu ky hien tai trung lan truoc => repeated=true', () => {
  const sig = jobPolicy.buildFailureSignature('exit code 1');
  const history = [{ step: 'IMPLEMENT', signature: sig, attempt: 1 }];
  const d = policy.repeatedCauseHeuristic({ history, signature: sig });
  assert.equal(d.repeated, true);
  assert.equal(d.fallback, true);
  assert.match(d.reason, /trung|giong hop/i);
});

test('heuristic offline: chu ky moi => repeated=false', () => {
  const history = [{ step: 'IMPLEMENT', signature: jobPolicy.buildFailureSignature('exit code 1'), attempt: 1 }];
  const d = policy.repeatedCauseHeuristic({ history, signature: jobPolicy.buildFailureSignature('timeout 60000ms') });
  assert.equal(d.repeated, false);
});

test('heuristic offline: khong co lich su => repeated=false (khong chan retry)', () => {
  const d = policy.repeatedCauseHeuristic({ history: [], signature: 'x' });
  assert.equal(d.repeated, false);
});

test('heuristic offline: signature rong => repeated=false (khong chan retry nguoi hien)', () => {
  const history = [{ step: 'IMPLEMENT', signature: 'abc', attempt: 1 }];
  const d = policy.repeatedCauseHeuristic({ history, signature: '' });
  assert.equal(d.repeated, false);
});

// --- Client SystemOne: checkRepeatedCause ---------------------------------

test('checkRepeatedCause fallback khi SystemOne tat => van so duoc chu ky', async () => {
  const client = require('../src/systemone/client');
  const sig = jobPolicy.buildFailureSignature('exit code 1');
  const history = [{ step: 'FIXING', signature: sig, attempt: 1 }];
  const d = await client.checkRepeatedCause({
    jobId: 'j-1', step: 'FIXING', attempt: 2, maxRetries: 10,
    reason: 'exit code 1', signature: sig, history
  });
  assert.equal(typeof d.repeated, 'boolean');
  assert.equal(d.repeated, true, 'chu ky trung phai bi phat hien du model offline');
});
