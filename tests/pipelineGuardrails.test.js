/**
 * tests/pipelineGuardrails.test.js
 * Nguyen tac: TIMEOUT va RETRY chi la chi so CHONG TREO / CHONG LAP.
 * Khong duoc dung chung de "suy ra do phuc tap" cua task.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/systemone/policy');
const jobPolicy = require('../src/execution/jobPolicy');

// --- Triage: task LON khong duoc phan loai S/quick --------------------------

test('prompt doc truy xuat jira/story/tai lieu => KHONG phai quick', () => {
  // Prompt that cua job RSGATE-44 (da bi phan loai sai S/quick confidence 0.9).
  const prompt = 'doc task jira https://jira.cybertech.vn/browse/RSGATE-44, tu truy xuat task/story lon, tai lieu conf de phan tich va trien khai task, tai khoan login: admin/admin';
  const sig = policy.triageSignals({ prompt });
  assert.equal(sig.heavySignal, true, 'phai nhan ra dau hieu task lon');
  assert.equal(sig.large, true);
  assert.equal(sig.quick, false, 'task lon KHONG duoc la quick');
});

test('triageHeuristic: prompt task lon => track full (khong quick)', () => {
  const prompt = 'doc task jira https://jira.cybertech.vn/browse/RSGATE-44, tu truy xuat task/story lon, tai lieu conf de phan tich va trien khai task';
  const d = policy.triageHeuristic({ prompt });
  assert.equal(d.track, 'full');
  assert.notEqual(d.complexity, 'S');
});


test('triageSignals: task nho giu nguyen quick=true', () => {
  const sig = policy.triageSignals({ prompt: 'ping' });
  assert.equal(sig.quick, true);
  assert.equal(sig.heavySignal, false);
});

// --- Timeout: quick cap KHONG con cat timeout ------------------------------

test('resolveQuickStepTimeoutMs van ton tai (backward compat) nhung server KHONG dung cap', () => {
  // Ham van con de khong pha API cu, nhung server KHONG con goi no de cat timeout.
  const job = { pipeline_config: { quick_timeout_ms: 120000 } };
  assert.equal(jobPolicy.resolveQuickStepTimeoutMs(job, 3600000), 120000);
});
test('task nho van phai quick (khong phan loai nguoc nguoi)', () => {
  // Luu y: regex quick loai tru prompt chua fix|bug|error|sua|loi (hanh vi cu,
  // giu nguyen) => "fix typo" roi ve track full, khong phai quick.
  const d = policy.triageHeuristic({ prompt: 'ping' });
  assert.equal(d.track, 'quick');
  assert.equal(d.complexity, 'S');
});

test('timeout user duoc giu nguyen khi co quick_track=true trong config', () => {
  const job = { pipeline_config: { quick_track: true, timeout: 3600000 } };
  const cfg = jobPolicy.parsePipelineConfig(job);
  assert.equal(cfg.quick_track, true);
  assert.equal(cfg.timeout, 3600000);
});

// --- Retry: so lan retry theo config, khong theo env -------------------------

test('resolveMaxRetries doc pipeline_config.max_retries (khong phai env=3)', () => {
  const job = { pipeline_config: { max_retries: 10, maxRetries: 10 } };
  const r = jobPolicy.resolveMaxRetries(job);
  assert.equal(r.value, 10);
  assert.equal(r.source, 'job');
});

test('resolveMaxRetries fallback env khi config khong khai', () => {
  const r = jobPolicy.resolveMaxRetries({ pipeline_config: {} }, 3);
  assert.equal(r.value, 3);
});

// --- Backoff: co backoff giua cac vong retry --------------------------------

test('backoff tang dan theo attempt (vong 1 khong wait)', () => {
  assert.equal(jobPolicy.resolveRetryBackoffMs(1), 0);
  assert.ok(jobPolicy.resolveRetryBackoffMs(2) > 0);
  assert.ok(jobPolicy.resolveRetryBackoffMs(3) > jobPolicy.resolveRetryBackoffMs(2));
});
