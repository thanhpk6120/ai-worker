/**
 * tests/systemoneFallback.test.js
 * SystemOne phai fail-safe: khi rơi về heuristic offline thi KHONG duoc
 * dung so lieu gia de quyet dinh dung retry (da gay job bd88ae0a that bai 3/3).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../src/systemone/client');
const policy = require('../src/systemone/policy');

test('heuristic fixGate duoc danh dau fallback', () => {
  const h = policy.fixGateHeuristic({ attempt: 0, maxRetries: 3 });
  assert.equal(h.fallback, true);
  assert.equal(h.source, 'heuristic');
});

test('heuristic preJudge/router/guard/dedup deu danh dau fallback', () => {
  assert.equal(policy.preJudgeHeuristic().fallback, true);
  assert.equal(policy.routerHeuristic({}).fallback, true);
  assert.equal(policy.guardHeuristic().fallback, true);
  assert.equal(policy.dedupHeuristic({}).fallback, true);
});

test('checkFixGate khi model offline KHONG chan retry', async () => {
  // Endpoint that khong phan hoi => client fallback heuristic.
  const decision = await client.checkFixGate({
    jobId: 'j-fallback',
    attempt: 0,
    maxRetries: 3,
    failures: { error: 'x' },
    files: []
  });
  assert.equal(decision.fallback, true, 'phai fallback vi model that khong goi duoc');
  assert.equal(decision.retry, true, 'heuristic KHONG duoc phep chan retry bang so lieu gia');
});

test('checkFixGate van chan retry khi het so lan (attempt >= maxRetries)', async () => {
  const decision = await client.checkFixGate({
    jobId: 'j-limit',
    attempt: 3,
    maxRetries: 3,
    failures: { error: 'x' },
    files: []
  });
  assert.equal(decision.retry, false, 'het so lan retry thi phai dung');
  assert.equal(decision.source, 'attempt-limit');
});

test('getStatus bao trang thai live / fallback', () => {
  const s = client.getStatus();
  assert.equal(typeof s.enabled, 'boolean');
  assert.ok('live' in s);
  assert.ok('fallbackCount' in s);
  assert.ok(typeof s.model === 'string' && s.model.length > 0);
  assert.ok(typeof s.baseUrl === 'string' && s.baseUrl.length > 0);
});

test('getStatus co lastError sau khi goi that bai', async () => {
  await client.checkFixGate({ jobId: 'j-err', attempt: 0, maxRetries: 3, failures: {}, files: [] });
  const s = client.getStatus();
  assert.equal(s.live, false, 'model that da goi that bai => live=false');
  assert.ok(s.lastError && typeof s.lastError === 'string');
});
