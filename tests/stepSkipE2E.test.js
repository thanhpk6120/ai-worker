/**
 * tests/stepSkipE2E.test.js
 * E2E qua executeStep that cua server:
 * - IMPLEMENT co marker `IMPLEMENT_STATUS: DONE` => BO QUA agent IMPLEMENT,
 *   sang thang TESTING (khong tao step IMPLEMENT).
 * - PLANNING co marker `.plan_ok.json` => BO QUA agent PLANNING, sang IMPLEMENT.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// PHẢI set DB_PATH TRƯỚC mọi require (config.js đọc env lúc require).
// Nếu không, test sẽ ghi vào DB production.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-skip-'));
process.env.DB_PATH = path.join(TMP, 'skip-test.sqlite');

const stepGate = require('../src/execution/stepGate');
const { runnerRegistry } = require('../src/runners/runnerRegistry');
const db = require('../src/storage/db');
const { executeStep } = require('../src/server');

// Stub runner: KHONG spawn agent CLI that (test phai chay nhanh, khong ton tai
// tai nguyen). Runner gia luon thanh cong.
const originalGetAvailableRunner = runnerRegistry.getAvailableRunner.bind(runnerRegistry);
runnerRegistry.getAvailableRunner = () => ({
  name: 'stub-runner',
  execute: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false })
});
test.after(() => { runnerRegistry.getAvailableRunner = originalGetAvailableRunner; });

function makeWorkspace(taskCode, devPlan) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-skip-ws-'));
  const featureDir = path.join(root, 'docs', 'features', taskCode);
  fs.mkdirSync(featureDir, { recursive: true });
  if (devPlan) fs.writeFileSync(path.join(featureDir, 'dev_plan.md'), devPlan, 'utf8');
  return { root, featureDir };
}

test('IMPLEMENT: marker DONE => bo qua agent, sang TESTING', async () => {
  const taskCode = 'T-SKIP-IMPL';
  const { root, featureDir } = makeWorkspace(taskCode,
    '# Dev Plan\n\n<!-- IMPLEMENT_STATUS: DONE -->\n\nMã nguồn đã implement đầy đủ.\n');
  const jobId = 'skip-impl-1';
  db.createJob({
    id: jobId, title: 'T', prompt: 'p', status: 'IMPLEMENT',
    repo_path: root, task_code: taskCode
  });

  await executeStep(jobId, { maxHops: 2 });

  const job = db.getJobById(jobId);
  assert.equal(job.status, 'TESTING', `phai sang TESTING, thuc te ${job.status}`);
  const steps = db.getStepsByJobId(jobId) || [];
  const implSteps = steps.filter((s) => s.step_type === 'IMPLEMENT');
  assert.equal(implSteps.length, 0, 'KHONG duoc tao step IMPLEMENT (da bo qua agent)');
});

test('IMPLEMENT: khong co marker => van chay agent IMPLEMENT', async () => {
  const taskCode = 'T-SKIP-IMPL-2';
  const { root } = makeWorkspace(taskCode, '# Dev Plan\n\nChưa implement gì cả.\n');
  const jobId = 'skip-impl-2';
  db.createJob({
    id: jobId, title: 'T', prompt: 'p', status: 'IMPLEMENT',
    repo_path: root, task_code: taskCode
  });

  await executeStep(jobId, { maxHops: 2 });

  const steps = db.getStepsByJobId(jobId) || [];
  const implSteps = steps.filter((s) => s.step_type === 'IMPLEMENT');
  assert.equal(implSteps.length, 1, 'phai co step IMPLEMENT (agent chay that)');
});

test('IMPLEMENT: marker NEEDED => van chay agent IMPLEMENT', async () => {
  const taskCode = 'T-SKIP-IMPL-3';
  const { root } = makeWorkspace(taskCode,
    '# Dev Plan\n\n<!-- IMPLEMENT_STATUS: NEEDED -->\n\nCòn thiếu phần X.\n');
  const jobId = 'skip-impl-3';
  db.createJob({
    id: jobId, title: 'T', prompt: 'p', status: 'IMPLEMENT',
    repo_path: root, task_code: taskCode
  });

  await executeStep(jobId, { maxHops: 2 });

  const steps = db.getStepsByJobId(jobId) || [];
  assert.equal(steps.filter((s) => s.step_type === 'IMPLEMENT').length, 1,
    'marker NEEDED => phai chay IMPLEMENT');
});

test('PLANNING: co marker plan_ok => bo qua agent PLANNING, sang IMPLEMENT', async () => {
  const taskCode = 'T-SKIP-PLAN';
  const { root, featureDir } = makeWorkspace(taskCode, '# Dev Plan\n\nNội dung\n');
  stepGate.writePlanOkMarker(featureDir, { taskCode });
  const jobId = 'skip-plan-1';
  db.createJob({
    id: jobId, title: 'T', prompt: 'p', status: 'PLANNING',
    repo_path: root, task_code: taskCode
  });

  await executeStep(jobId, { maxHops: 2 });

  const job = db.getJobById(jobId);
  assert.equal(job.status, 'IMPLEMENT', `phai sang IMPLEMENT, thuc te ${job.status}`);
  const steps = db.getStepsByJobId(jobId) || [];
  assert.equal(steps.filter((s) => s.step_type === 'PLANNING').length, 0,
    'KHONG duoc tao step PLANNING (da bo qua agent)');
});
