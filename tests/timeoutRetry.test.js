/**
 * tests/timeoutRetry.test.js
 * Timeout / retry cho job (TASK-PIPELINE-FIX Phase A):
 * - max_retries trong pipeline_config PHẢI được dùng thật (bug: job khai 10 vẫn dừng 3/3)
 * - tổng ngân sách thời gian cho job (deadline)
 * - backoff giữa các vòng retry
 * - phát hiện rate-limit 429 của provider
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../src/execution/jobPolicy');

// --- resolveMaxRetries -----------------------------------------------------

test('max_retries trong pipeline_config duoc dung that (job khai 10 => 10)', () => {
  const job = { pipeline_config: JSON.stringify({ timeout: 3600000, max_retries: 10, maxRetries: 10 }) };
  const r = policy.resolveMaxRetries(job);
  assert.equal(r.value, 10, 'phai dung max_retries cua job');
  assert.equal(r.source, 'job');
});

test('pipeline_config dang object cung duoc dung', () => {
  const job = { pipeline_config: { max_retries: 7 } };
  const r = policy.resolveMaxRetries(job);
  assert.equal(r.value, 7);
  assert.equal(r.source, 'job');
});

test('maxRetries (camelCase) cung duoc dung', () => {
  const r = policy.resolveMaxRetries({ pipeline_config: { maxRetries: 5 } });
  assert.equal(r.value, 5);
  assert.equal(r.source, 'job');
});

test('job cu khong khai max_retries => dung env (khong hoi quy)', () => {
  const r = policy.resolveMaxRetries({ pipeline_config: { timeout: 1000 } }, 3);
  assert.equal(r.value, 3);
  assert.equal(r.source, 'env');
});

test('khong co gi => default 3', () => {
  const r = policy.resolveMaxRetries({ pipeline_config: {} }, 0);
  assert.equal(r.value, 3);
  assert.equal(r.source, 'default');
});

test('gia tri khong hop le bi bo qua, fallback env', () => {
  const r = policy.resolveMaxRetries({ pipeline_config: { max_retries: 'abc' } }, 4);
  assert.equal(r.value, 4);
  assert.equal(r.source, 'env');
});

test('gia tri 0 khong duoc chuyen thanh fallback (0 = khong retry) — quy uoc: bo qua, dung env', () => {
  const r = policy.resolveMaxRetries({ pipeline_config: { max_retries: 0 } }, 3);
  assert.equal(r.value, 3);
  assert.equal(r.source, 'env');
});

// --- Deadline ---------------------------------------------------------------

test('job_deadline_ms duoc doc tu pipeline_config', () => {
  const r = policy.resolveJobDeadlineMs({ pipeline_config: { job_deadline_ms: 7200000 } });
  assert.equal(r, 7200000);
});

test('job_deadline_minutes -> ms', () => {
  const r = policy.resolveJobDeadlineMs({ pipeline_config: { job_deadline_minutes: 90 } });
  assert.equal(r, 90 * 60 * 1000);
});

test('khong khai deadline => null (khong ep deadline)', () => {
  assert.equal(policy.resolveJobDeadlineMs({ pipeline_config: {} }), null);
  assert.equal(policy.resolveJobDeadlineMs({}), null);
});

test('resolveEffectiveTimeout: min(step timeout, thoi gian con lai)', () => {
  const now = 1000000;
  const r = policy.resolveEffectiveTimeout({ stepTimeoutMs: 3600000, deadlineAt: now + 600000, now });
  assert.equal(r.expired, false);
  assert.equal(r.timeoutMs, 600000, 'phai cat theo deadline con lai');
  assert.equal(r.remainingMs, 600000);
});

test('resolveEffectiveTimeout: het deadline => expired, timeoutMs = 0', () => {
  const now = 1000000;
  const r = policy.resolveEffectiveTimeout({ stepTimeoutMs: 3600000, deadlineAt: now - 1, now });
  assert.equal(r.expired, true);
  assert.equal(r.timeoutMs, 0);
});

test('resolveEffectiveTimeout: khong co deadline => giu nguyen step timeout', () => {
  const r = policy.resolveEffectiveTimeout({ stepTimeoutMs: 3600000, deadlineAt: null });
  assert.equal(r.expired, false);
  assert.equal(r.timeoutMs, 3600000);
  assert.equal(r.remainingMs, null);
});

test('resolveEffectiveTimeout: step timeout nho hon deadline thi giu step timeout', () => {
  const now = 1000000;
  const r = policy.resolveEffectiveTimeout({ stepTimeoutMs: 60000, deadlineAt: now + 3600000, now });
  assert.equal(r.timeoutMs, 60000);
});

// --- Backoff ----------------------------------------------------------------

test('backoff vong dau = 0 (khong cho)', () => {
  assert.equal(policy.resolveRetryBackoffMs(1), 0);
});

test('backoff tang dan theo attempt', () => {
  assert.equal(policy.resolveRetryBackoffMs(2), 5000);
  assert.equal(policy.resolveRetryBackoffMs(3), 10000);
  assert.equal(policy.resolveRetryBackoffMs(4), 20000);
});

// --- Deadline tuyet doi (bug: deadline truot mai) -----------------------------

test('deadline duoc gan 1 lan roi doc lai, khong truot theo moi lan chuyen step', () => {
  const job = { pipeline_config: { job_deadline_ms: 3600000 } };
  const first = policy.resolveDeadlineAt(job, 1000000);
  assert.equal(first.isNew, true, 'lan dau phai tinh moi');
  assert.equal(first.deadlineAt, 1000000 + 3600000);

  // Giu deadline vao pipeline_config nhu server.js lam
  const pipe = { ...job.pipeline_config, deadline_at: first.deadlineAt };
  const job2 = { pipeline_config: pipe };

  // Lan sau executeStep chay lai (now bat bien) => deadline phai GIU NGUYEN
  const second = policy.resolveDeadlineAt(job2, 9999999);
  assert.equal(second.isNew, false, 'lan sau phai doc lai, khong tinh moi');
  assert.equal(second.deadlineAt, first.deadlineAt, 'deadline phai tuyet doi');
});

test('job khong khai deadline => null (khong gan deadline_at)', () => {
  const r = policy.resolveDeadlineAt({ pipeline_config: {} }, 1000000);
  assert.equal(r.deadlineAt, null);
  assert.equal(r.isNew, false);
});

test('deadline da het han => resolveEffectiveTimeout expired', () => {
  const { deadlineAt } = policy.resolveDeadlineAt({ pipeline_config: { job_deadline_ms: 1000 } }, 1000000);
  const eff = policy.resolveEffectiveTimeout({ stepTimeoutMs: 3600000, deadlineAt, now: 1000000 + 2000 });
  assert.equal(eff.expired, true, 'phai expired khi qua deadline');
  assert.equal(eff.timeoutMs, 0);
});

// --- collectAgentOutput (bug: doc .output thay vi .stdout/.stderr) -----------

test('collectAgentOutput doc stdout + stderr (runner.execute khong co field output)', () => {
  const result = { stdout: 'normal output', stderr: '429 Service temporarily unavailable retry-after-ms=5000', exitCode: 1 };
  const out = policy.collectAgentOutput(result);
  assert.ok(out.includes('429'), 'phai lay stderr');
  assert.ok(out.includes('normal output'), 'phai lay stdout');
  const r = policy.detectRateLimit(out);
  assert.equal(r.limited, true, 'rate-limit phai duoc phat hien tu stderr');
  assert.equal(r.retryAfterMs, 5000);
});

test('collectAgentOutput xu ly null / undefined / string', () => {
  assert.equal(policy.collectAgentOutput(null), '');
  assert.equal(policy.collectAgentOutput(undefined), '');
  assert.equal(policy.collectAgentOutput('abc'), 'abc');
  assert.equal(policy.collectAgentOutput({}), '');
});

test('rate-limit trong stderr duoc phat hien (case that cua job bd88ae0a)', () => {
  const stderr = '429 Service temporarily unavailable: all targets were skipped by pre-dispatch filters reset after 665h 47m 11s retry-after-ms=2396831000\nService temporarily unavailable: all targets were skipped by pre-dispatch filters reset after 665h 47m 11s (type=rate_limit_error param=ALL_TARGETS_SKIPPED)';
  const r = policy.detectRateLimit(policy.collectAgentOutput({ stdout: '', stderr }));
  assert.equal(r.limited, true);
  assert.equal(r.retryAfterMs, 2396831000);
});

test('backoff co tran (cap 60s)', () => {
  assert.equal(policy.resolveRetryBackoffMs(10), 60000);
  assert.equal(policy.resolveRetryBackoffMs(50), 60000);
});

// --- Rate limit -------------------------------------------------------------

test('phat hien 429 rate_limit_error', () => {
  const out = '429 Service temporarily unavailable: all targets were skipped by pre-dispatch filters reset after 665h 47m 11s retry-after-ms=2396831000\nService temporarily unavailable (type=rate_limit_error param=ALL_TARGETS_SKIPPED)';
  const r = policy.detectRateLimit(out);
  assert.equal(r.limited, true);
  assert.equal(r.retryAfterMs, 2396831000);
});

test('phat hien retry-after-ms', () => {
  const r = policy.detectRateLimit('retry-after-ms=5000');
  assert.equal(r.limited, true);
  assert.equal(r.retryAfterMs, 5000);
});

test('output binh thuong khong phai rate limit', () => {
  const r = policy.detectRateLimit('[IMPLEMENT] Hoan tat trien khai ma nguon.\nTest PASSED');
  assert.equal(r.limited, false);
  assert.equal(r.retryAfterMs, null);
});

test('chuoi rong hoac undefined khong phai rate limit', () => {
  assert.equal(policy.detectRateLimit('').limited, false);
  assert.equal(policy.detectRateLimit(undefined).limited, false);
  assert.equal(policy.detectRateLimit(null).limited, false);
});

test('chi doc 429 co dau cach moi, khong phai con so 1429 trong text', () => {
  // "1429" chua "429" theo sau ranh giar tu => KHONG phai rate limit
  const r = policy.detectRateLimit('gia tri 1429 duoc ghi nhan');
  assert.equal(r.limited, false);
});
