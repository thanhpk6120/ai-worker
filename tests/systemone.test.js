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

  it('triageSignals: "large" thang "quick" (migrate khong phai task de)', () => {
    // Bug cu: quick check truoc large => "migrate module sang microservices"
    // (len < 200, khong chua fix|bug|error) bi phan loai NHAM thanh quick.
    const sig = policy.triageSignals({ prompt: 'migrate module sang microservices' });
    assert.strictEqual(sig.large, true);
    assert.strictEqual(sig.quick, false, 'large phai thang quick');
    assert.strictEqual(policy.triageHeuristic({ prompt: 'migrate module sang microservices' }).track, 'full');
  });

  it('triageSignals: prompt tieng Viet co dau va khong deu ra cung ket qua', () => {
    const withDau = policy.triageSignals({ prompt: 'kiểm tra hệ thống đăng nhập' });
    const noDau = policy.triageSignals({ prompt: 'kiem tra he thong dang nhap' });
    assert.strictEqual(withDau.quick, noDau.quick);
    assert.strictEqual(withDau.large, noDau.large);
  });

  it('triageSignals: prompt trung binh => khong quick, khong large (mo ho)', () => {
    const sig = policy.triageSignals({ prompt: 'Can sua loi trong he thong thanh toan, them validation cho input' });
    assert.strictEqual(sig.quick, false);
    assert.strictEqual(sig.large, false);
  });

  it('fold bo dau + lowercase', () => {
    assert.strictEqual(policy.fold('Xác Minh'), 'xac minh');
    assert.strictEqual(policy.fold('LỖI'), 'loi');
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

  it('checkGuard khi action=scrub phai tra prompt DA scrub (khong loi secret)', async () => {
    const secret = 'password=123456';
    const g = await client.checkGuard({ taskCode: 'T', prompt: `hello ${secret}` });
    assert.strictEqual(g.action, 'scrub');
    // Truoc day tra prompt goc => SecretScrubber khong co tac dung gi.
    assert.ok(!String(g.promptToUse).includes(secret), 'promptToUse KHONG duoc chua secret goc');
  });

  it('checkGuard khi action=allow moi giu prompt goc', async () => {
    const g = await client.checkGuard({ taskCode: 'T', prompt: 'xin chao ban' });
    assert.ok(['allow', 'scrub', 'warn'].includes(g.action));
    if (g.action === 'allow') {
      assert.ok(String(g.promptToUse).includes('xin chao ban'), 'action=allow giu nguyen prompt');
    }
  });
});

describe('SystemOne probe()', () => {
  // Stub global.fetch de chay logic that cua probe() ma khong goi mang.
  // systemone/client.js doc config.SYSTEMONE_ENABLED luc require, nen phai
  // doi config.SYSTEMONE_ENABLED truoc moi require lai module.
  function withStubbedFetch(impl, fn) {
    const original = global.fetch;
    global.fetch = impl;
    return Promise.resolve()
      .then(fn)
      .finally(() => { global.fetch = original; });
  }

  it('probe tra live=false khi SYSTEMONE_ENABLED=false', async () => {
    const p = await client.probe();
    assert.strictEqual(p.live, false);
    assert.strictEqual(p.error, 'SYSTEMONE_ENABLED=false');
    assert.strictEqual(p.noul, null);
  });

  it('probe tra live=true khi gateway tra noul hop le', async () => {
    const cfg = require('../src/config');
    const prevEnabled = cfg.SYSTEMONE_ENABLED;
    cfg.SYSTEMONE_ENABLED = true;
    try {
      await withStubbedFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ model: 'typesafe/jev-1.13-20260917', answers: { is_alive: { type: 'noul', noul: 0.77 } } })
      }), async () => {
        const p = await client.probe();
        assert.strictEqual(p.live, true);
        assert.strictEqual(p.noul, 0.77);
        assert.strictEqual(p.error, null);
        assert.strictEqual(p.model, 'typesafe/jev-1.13-20260917');
      });
    } finally {
      cfg.SYSTEMONE_ENABLED = prevEnabled;
    }
  });

  it('probe tra live=false khi gateway 200 nhung answers rong (schema lech)', async () => {
    const cfg = require('../src/config');
    const prevEnabled = cfg.SYSTEMONE_ENABLED;
    cfg.SYSTEMONE_ENABLED = true;
    try {
      await withStubbedFetch(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ model: 'typesafe/jev-1.13-20260917', answers: {} })
      }), async () => {
        const p = await client.probe();
        // Khong co noul hop le => KHONG duoc bao "live" (che loi do bi che mat).
        assert.strictEqual(p.live, false);
        assert.strictEqual(p.noul, null);
        assert.ok(p.error, 'phai bao loi khi answers rong');
      });
    } finally {
      cfg.SYSTEMONE_ENABLED = prevEnabled;
    }
  });

  it('probe tra live=false khi gateway loi HTTP', async () => {
    const cfg = require('../src/config');
    const prevEnabled = cfg.SYSTEMONE_ENABLED;
    cfg.SYSTEMONE_ENABLED = true;
    try {
      await withStubbedFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }), async () => {
        const p = await client.probe();
        assert.strictEqual(p.live, false);
        assert.ok(p.error);
      });
    } finally {
      cfg.SYSTEMONE_ENABLED = prevEnabled;
    }
  });
});
