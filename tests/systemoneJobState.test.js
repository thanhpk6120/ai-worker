/**
 * tests/systemoneJobState.test.js
 * Test trang thai SystemOne PER-TASK (badge "CHƯA GỌI" / "LIVE" / "FALLBACK").
 *
 * Yêu cầu: badge phải là dữ liệu của TỪNG task, không phải trạng thái global của server.
 */
const assert = require('node:assert/strict');
const { describe, it, before } = require('node:test');

// Bật SystemOne + stub fetch để không gọi mạng.
process.env.SYSTEMONE_ENABLED = 'true';

const client = require('../src/systemone/client');

const NORMAL_ANSWERS = {
  should_retry: { type: 'noul', noul: 0.8 },
  will_succeed: { type: 'noul', noul: 0.6 },
  needs_full_scope: { type: 'noul', noul: 0.1 },
  is_tiny_fix: { type: 'noul', noul: 0.7 }
};

function stubFetch(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

describe('SystemOne - trang thai per-job', () => {
  it('job chua goi => live=null (CHƯA GỌI)', () => {
    const s = client.getJobStatus('job-never-called');
    assert.strictEqual(s.live, null);
    assert.strictEqual(s.calls, 0);
    assert.strictEqual(s.fallbacks, 0);
    assert.strictEqual(s.lastError, null);
  });

  it('job goi model that => live=true, calls=1', async () => {
    const restore = stubFetch(async () => ({
      ok: true, status: 200, json: async () => ({ answers: NORMAL_ANSWERS })
    }));
    try {
      await client.checkFixGate({ jobId: 'job-live-1', attempt: 1, maxRetries: 3, failures: { error: 'e' }, files: [] });
      const s = client.getJobStatus('job-live-1');
      assert.strictEqual(s.live, true, 'phai la model that');
      assert.strictEqual(s.calls, 1);
      assert.strictEqual(s.fallbacks, 0);
      assert.strictEqual(s.lastError, null);
    } finally {
      restore();
    }
  });

  it('hai job khac nhau co trang thai rieng biet', async () => {
    const restore = stubFetch(async () => ({
      ok: true, status: 200, json: async () => ({ answers: NORMAL_ANSWERS })
    }));
    try {
      await client.checkFixGate({ jobId: 'job-A', attempt: 1, maxRetries: 3, failures: { error: 'e' }, files: [] });
      await client.checkFixGate({ jobId: 'job-B', attempt: 1, maxRetries: 3, failures: { error: 'e' }, files: [] });
      assert.strictEqual(client.getJobStatus('job-A').calls, 1);
      assert.strictEqual(client.getJobStatus('job-B').calls, 1);
      assert.strictEqual(client.getJobStatus('job-C').calls, 0, 'job C chua goi => 0');
    } finally {
      restore();
    }
  });

  it('model loi => live=false, fallbacks=1, co lastError', async () => {
    const restore = stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    try {
      await client.checkFixGate({ jobId: 'job-fail-1', attempt: 1, maxRetries: 3, failures: { error: 'e' }, files: [] });
      const s = client.getJobStatus('job-fail-1');
      assert.strictEqual(s.live, false, 'model loi => phai bao FALLBACK');
      assert.strictEqual(s.fallbacks, 1);
      assert.ok(s.lastError, 'phai co lastError');
    } finally {
      restore();
    }
  });

  it('systemone TAT => fallback=true, live=false', async () => {
    const cfg = require('../src/config');
    const prev = cfg.SYSTEMONE_ENABLED;
    cfg.SYSTEMONE_ENABLED = false;
    try {
      await client.checkFixGate({ jobId: 'job-off-1', attempt: 1, maxRetries: 3, failures: { error: 'e' }, files: [] });
      const s = client.getJobStatus('job-off-1');
      assert.strictEqual(s.live, false);
      assert.strictEqual(s.fallbacks, 1);
    } finally {
      cfg.SYSTEMONE_ENABLED = prev;
    }
  });

  it('triage KHONG goi model => phai danh dau FALLBACK (khong phai badge "songs")', async () => {
    const cfg = require('../src/config');
    const prevSys = cfg.SYSTEMONE_ENABLED;
    const prevAi = cfg.AI_TRIAGE_ENABLED;
    cfg.SYSTEMONE_ENABLED = false;
    cfg.AI_TRIAGE_ENABLED = false;
    const restore = stubFetch(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    try {
      await client.checkTriage({ taskCode: 'T', prompt: 'ping', jobId: 'job-hf-1' });
      const st = client.getJobStatus('job-hf-1');
      // KHONG goi model => phai fallback, khong bao gio bao "songs" (live=true).
      assert.strictEqual(st.live, false, 'quyet dinh khong tu model => live phai false');
      assert.strictEqual(st.fallbacks, 1, 'phai ghi nhan 1 lan fallback');
    } finally {
      cfg.SYSTEMONE_ENABLED = prevSys;
      cfg.AI_TRIAGE_ENABLED = prevAi;
      restore();
    }
  });

  it('triage: task de => heuristic nhanh, KHONG goi mang', async () => {
    const cfg = require('../src/config');
    const prevSys = cfg.SYSTEMONE_ENABLED;
    const prevAi = cfg.AI_TRIAGE_ENABLED;
    cfg.SYSTEMONE_ENABLED = false;
    cfg.AI_TRIAGE_ENABLED = false;
    let called = 0;
    const restore = stubFetch(async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; });
    try {
      const t = await client.checkTriage({ taskCode: 'T', prompt: 'ping', jobId: 'job-tri-q' });
      assert.strictEqual(called, 0, 'task de phai quyet dinh bang heuristic, khong goi model');
      assert.strictEqual(t.track, 'quick');
      assert.strictEqual(t.complexity, 'S');
      // Heuristic offline KHONG duoc tu bat quick track (confidence <= 0.4).
      assert.ok(t.confidence <= 0.4, `heuristic phai confidence <= 0.4, got ${t.confidence}`);
    } finally {
      cfg.SYSTEMONE_ENABLED = prevSys;
      cfg.AI_TRIAGE_ENABLED = prevAi;
      restore();
    }
  });

  it('triage: task migrate => heuristic nhanh, KHONG goi mang', async () => {
    const cfg = require('../src/config');
    const prevSys = cfg.SYSTEMONE_ENABLED;
    const prevAi = cfg.AI_TRIAGE_ENABLED;
    cfg.SYSTEMONE_ENABLED = false;
    cfg.AI_TRIAGE_ENABLED = false;
    let called = 0;
    const restore = stubFetch(async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) }; });
    try {
      const t = await client.checkTriage({ taskCode: 'T', prompt: 'migrate module sang microservices', jobId: 'job-tri-l' });
      assert.strictEqual(called, 0, 'task phuc tap ro rang phai heuristic, khong goi model');
      assert.strictEqual(t.track, 'full');
      assert.strictEqual(t.complexity, 'L');
      assert.ok(t.confidence <= 0.4, `heuristic phai confidence <= 0.4, got ${t.confidence}`);
    } finally {
      cfg.SYSTEMONE_ENABLED = prevSys;
      cfg.AI_TRIAGE_ENABLED = prevAi;
      restore();
    }
  });

  it('triage: prompt mo ho => goi model, chi 2 cau hoi (khong need_browser)', async () => {
    // Tat nhanh AI headless de test rieng duong Jev (model gateway).
    const cfg = require('../src/config');
    const prevAi = cfg.AI_TRIAGE_ENABLED;
    cfg.AI_TRIAGE_ENABLED = false;
    let body = null;
    const restore = stubFetch(async (url, opts) => {
      body = JSON.parse(opts.body);
      return {
        ok: true, status: 200,
        json: async () => ({ answers: { is_quick: { type: 'noul', noul: 0.2 }, is_large: { type: 'noul', noul: 0.1 } } })
      };
    });
    try {
      const t = await client.checkTriage({ taskCode: 'T', prompt: 'Can sua loi trong he thong thanh toan, them validation cho input', jobId: 'job-tri-m' });
      assert.ok(body, 'phai co goi model');
      assert.deepStrictEqual(Object.keys(body.questions).sort(), ['is_large', 'is_quick'],
        'chi hoi 2 cau, bo need_browser (ket qua chi ghi log, khong quyet dinh gi)');
      assert.strictEqual(t.track, 'full');
    } finally {
      cfg.AI_TRIAGE_ENABLED = prevAi;
      restore();
    }
  });

  it('checkGuard boc decision => tracker van nhan fallback dung', async () => {
    const restore = stubFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    try {
      const g = await client.checkGuard({ taskCode: 'T', prompt: 'secret sk-abcdefghijklmnopqrstuvwx', jobId: 'job-guard-1' });
      // checkGuard tra { action, promptToUse, decision } - decision.fallback=true
      assert.strictEqual(g.decision.fallback, true);
      const s = client.getJobStatus('job-guard-1');
      assert.strictEqual(s.live, false, 'guard fallback phai lam job = FALLBACK');
      assert.strictEqual(s.fallbacks, 1);
    } finally {
      restore();
    }
  });
});
