/**
 * tests/systemone.test.js
 * Unit offline cho SYSTEMONE-01: policy typed, client fallback + wire fixAttempt.
 * Chạy offline (SYSTEMONE_ENABLED=false), không gọi mạng.
 */
const assert = require('node:assert');
const { describe, it } = require('node:test');

process.env.SYSTEMONE_ENABLED = 'false';

const policy = require('../src/systemone/policy');
const client = require('../src/systemone/client');
describe('SystemOne policy heuristic (offline, confidence<=0.4)', () => {
  it('router trả preferredName', () => {
    const r = policy.routerHeuristic({ preferredName: 'claude-code' });
    assert.strictEqual(r.runner, 'claude-code');
    assert.ok(r.confidence <= 0.4);
  });

  it('triage prompt ngắn về S/quick', () => {
    const t = policy.triageHeuristic({ prompt: 'ping' });
    assert.strictEqual(t.track, 'quick');
    assert.ok(t.confidence <= 0.4);
  });

  it('fixGate tôn trọng maxRetries', () => {
    assert.strictEqual(policy.fixGateHeuristic({ attempt: 0, maxRetries: 3 }).retry, true);
    assert.strictEqual(policy.fixGateHeuristic({ attempt: 3, maxRetries: 3 }).retry, false);
  });

  it('preJudge fail-open đủ 4 kênh', () => {
    const p = policy.preJudgeHeuristic();
    assert.strictEqual(p.pass, false);
    assert.deepStrictEqual(p.failedFields, ['ui', 'api', 'log', 'db']);
  });

  it('guard fail-closed scrub', () => {
    const g = policy.guardHeuristic();
    assert.strictEqual(g.action, 'scrub');
  });

  it('dedup bucket ổn định 16 hex', () => {
    const d1 = policy.dedupHeuristic({ taskCode: 'T', prompt: 'hello' });
    const d2 = policy.dedupHeuristic({ taskCode: 'T', prompt: 'hello' });
    assert.strictEqual(d1.bucketId, d2.bucketId);
    assert.match(d1.bucketId, /^[0-9a-f]{16}$/);
  });
});

describe('SystemOne client fallback khi disabled', () => {
  it('decideTriage về heuristic M/full khi disabled', async () => {
    const t = await client.decideTriage({ taskCode: 'T', prompt: 'x'.repeat(500), jobId: 'j1' });
    assert.ok(['S', 'M', 'L'].includes(t.complexity));
    assert.ok(t.confidence <= 0.4);
  });

  it('decideGuard về scrub khi disabled', async () => {
    const g = await client.decideGuard({ taskCode: 'T', prompt: 'hello' });
    assert.strictEqual(g.action, 'scrub');
  });

  it('decideFixGate chặn khi attempt>=maxRetries', async () => {
    const f = await client.decideFixGate({ jobId: 'j', attempt: 3, maxRetries: 3, failures: {}, files: [] });
    assert.strictEqual(f.retry, false);
  });

  it('getStats có đủ counters', () => {
    const s = client.getStats();
    for (const k of ['calls', 'hits', 'misses', 'fallbacks', 'cliSaved', 'cost']) {
      assert.ok(typeof s[k] === 'number', k);
    }
  });
});

describe('SystemOne client wire helpers (gộp từ wire.js)', () => {
  it('getFixAttempt đọc pipeline_config', () => {
    assert.strictEqual(client.getFixAttempt({ pipeline_config: { fix_attempt: 2 } }), 2);
    assert.strictEqual(client.getFixAttempt({ pipeline_config: '{"fix_attempt":1}' }), 1);
    assert.strictEqual(client.getFixAttempt({}), 0);
  });

  it('withFixAttempt ghi attempt', () => {
    const cfg = client.withFixAttempt({ pipeline_config: {} }, 2);
    assert.strictEqual(cfg.fix_attempt, 2);
  });

  it('checkFixGate chặn khi hết retry', async () => {
    const f = await client.checkFixGate({ jobId: 'j', attempt: 3, maxRetries: 3, failures: {}, files: [] });
    assert.strictEqual(f.retry, false);
  });

  it('checkGuard giữ prompt gốc trong promptToUse', async () => {
    const secret = 'password=123456';
    const g = await client.checkGuard({ taskCode: 'T', prompt: `hello ${secret}` });
    assert.strictEqual(g.action, 'scrub');
    assert.ok(String(g.promptToUse).includes(secret), 'promptToUse phải giữ nguyên secret gốc');
  });
});
