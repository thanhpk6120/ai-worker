/**
 * tests/repeatedCauseE2E.test.js
 * End-to-end co che so trung nguyen nhan qua ham that cua server.
 *
 * Biet kich quan trong: `failure_history` phai CON LAI giua cac vong.
 * Truoc day vong FIXING ghi `pipeline_config` bang snapshot job dau executeStep
 * => xoa sach history => co che KHONG BAO GIO chay.
 * Test nay khoa cach ghi de do.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-rep-'));
process.env.DB_PATH = path.join(TMP, 'repeat-test.sqlite');

const db = require('../src/storage/db');
const { evaluateRepeatedCause } = require('../src/server');
const jobPolicy = require('../src/execution/jobPolicy');

function newJob(id) {
  db.createJob({ id, title: 'T', prompt: 'p', status: 'IMPLEMENT' });
  return db.getJobById(id);
}

test('vong 1: chu ky moi => repeated=false, history duoc ghi', async () => {
  const id = 'rep-e2e-1';
  newJob(id);
  const d = await evaluateRepeatedCause({
    id, step: 'IMPLEMENT', attempt: 1, maxRetries: 10, reason: 'exit code 1'
  });
  assert.equal(d.repeated, false, 'vong dau chua co loi truoc => cho retry');
  const hist = jobPolicy.getFailureHistory(db.getJobById(id));
  assert.equal(hist.length, 1, 'phai ghi 1 muc vao lich su');
  assert.equal(hist[0].step, 'IMPLEMENT');
});

test('vong 2: cung chu ky => phat hien trung (history con nguyen ven)', async () => {
  const id = 'rep-e2e-2';
  newJob(id);
  await evaluateRepeatedCause({ id, step: 'IMPLEMENT', attempt: 1, maxRetries: 10, reason: 'exit code 1' });
  // Ghi pipeline_config bang snapshot CU (mo phong loi ghi de cua vong FIXING).
  const stale = db.getJobById(id);
  const stalePipe = jobPolicy.parsePipelineConfig(stale);
  // ...roi vong sau ghi de bang snapshot do.
  db.updateJob(id, { pipeline_config: { ...stalePipe } });

  const d = await evaluateRepeatedCause({ id, step: 'IMPLEMENT', attempt: 2, maxRetries: 10, reason: 'exit code 1' });
  assert.equal(d.repeated, true, 'cung chu ky phai bi phat hien la TRUNG');
  assert.equal(d.occurrences, 1);
  assert.equal(d.stoppedBySystemOne, true);
});

test('vong 2: chu ky KHAC => khong trung (khong chan retry o chua can)', async () => {
  const id = 'rep-e2e-3';
  newJob(id);
  await evaluateRepeatedCause({ id, step: 'IMPLEMENT', attempt: 1, maxRetries: 10, reason: 'exit code 1' });
  const d = await evaluateRepeatedCause({ id, step: 'IMPLEMENT', attempt: 2, maxRetries: 10, reason: 'timeout 3600000ms' });
  assert.equal(d.repeated, false, 'nguyen nhan khac => van cho retry');
});

test('vong 2: cung chu ky nhung KHAC step => khong trung', async () => {
  const id = 'rep-e2e-4';
  newJob(id);
  await evaluateRepeatedCause({ id, step: 'IMPLEMENT', attempt: 1, maxRetries: 10, reason: 'exit code 1' });
  const d = await evaluateRepeatedCause({ id, step: 'FIXING', attempt: 1, maxRetries: 10, reason: 'exit code 1' });
  assert.equal(d.repeated, false, 'IMPLEMENT truoc != FIXING truoc');
});

test('history van con sau khi co vong ghi pipeline_config bang snapshot cu (FIXING pattern)', async () => {
  const id = 'rep-e2e-5';
  newJob(id);
  await evaluateRepeatedCause({ id, step: 'FIXING', attempt: 1, maxRetries: 10, reason: 'exit code 1' });
  // Vong FIXING ghi pipeline_config bang job snapshot dau executeStep.
  const systemone = require('../src/systemone/client');
  const stale = db.getJobById(id);
  db.updateJob(id, { pipeline_config: systemone.withFixAttempt(stale, 2) });
  const hist = jobPolicy.getFailureHistory(db.getJobById(id));
  assert.equal(hist.length, 1, 'history PHAI con sau khi ghi fix_attempt');
});

test('FIXING loop: ghi fix_attempt bang job FRESH giu nguyen history (snapshot CU lam mat)', async () => {
  const id = 'rep-e2e-6';
  newJob(id);
  // Snapshot dau executeStep (chua co history).
  const jobSnapshot = db.getJobById(id);
  await evaluateRepeatedCause({ id, step: 'FIXING', attempt: 1, maxRetries: 10, reason: 'exit code 1' });

  const systemone = require('../src/systemone/client');
  // Cach CU (sai): ghi bang snapshot dau executeStep => XOA history.
  const staleCfg = systemone.withFixAttempt(jobSnapshot, 2);
  assert.equal(staleCfg.failure_history, undefined, 'snapshot CU lam mat history (ly do can fix)');

  // Cach DUNG (da fix): lay fresh tu DB truoc khi ghi.
  const freshJob = db.getJobById(id);
  const freshCfg = systemone.withFixAttempt(freshJob, 2);
  assert.equal(Array.isArray(freshCfg.failure_history), true, 'bang FRESH phai giu duoc history');
  assert.equal(freshCfg.failure_history.length, 1);
  assert.equal(freshCfg.fix_attempt, 2, 'van phai giu so vong fix');
});

test('cung `reason` (exit code 1) nhung output agent KHAC nhau => KHONG trung', async () => {
  // Khong co output trong chu ky loi => moi vong deu ra chu ky "exit code 1"
  // => vong 2 bi coi la TRUNG va job dung sau 1 lan retry (pham max_retries=10).
  const id = 'rep-e2e-7';
  newJob(id);
  const d1 = await evaluateRepeatedCause({
    id, step: 'IMPLEMENT', attempt: 1, maxRetries: 10,
    reason: 'exit code 1', output: 'TypeError: undefined is not a function at login.ts'
  });
  assert.equal(d1.repeated, false);
  const d2 = await evaluateRepeatedCause({
    id, step: 'IMPLEMENT', attempt: 2, maxRetries: 10,
    reason: 'exit code 1', output: 'TS2322: Type string is not assignable to number at field.ts'
  });
  assert.equal(d2.repeated, false, 'nguyen nhan KHAC nhau (output khac) => van cho retry');
  assert.equal(d2.occurrences, 0);
});

test('cung `reason` + cung output => trung (dung vong lap)', async () => {
  const id = 'rep-e2e-8';
  newJob(id);
  const out = 'TypeError: undefined is not a function at login.ts';
  await evaluateRepeatedCause({ id, step: 'IMPLEMENT', attempt: 1, maxRetries: 10, reason: 'exit code 1', output: out });
  const d2 = await evaluateRepeatedCause({ id, step: 'IMPLEMENT', attempt: 2, maxRetries: 10, reason: 'exit code 1', output: out });
  assert.equal(d2.repeated, true, 'cung nguyen nhan THAT => phai dung vong lap');
  assert.equal(d2.occurrences, 1);
  assert.equal(d2.stoppedBySystemOne, true);
});
