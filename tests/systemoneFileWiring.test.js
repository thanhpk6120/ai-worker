/**
 * tests/systemoneFileWiring.test.js
 * Test WIRING: noi dung file phai that su co mat trong body POST gui di model.
 *
 * Ly do can test rieng: bug `state.slice(0, 4000)` (cat sach fileContext) va bug
 * `included.push` bi mat deu LOT QUA unit test cua fileContext.js - vi no chi
 * kiem tra ham thuan, khong kiem tra duong gui len gateway.
 * Test nay stub global.fetch, bat body that, va assert noi dung file co trong do.
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

process.env.SYSTEMONE_ENABLED = 'true';

const client = require('../src/systemone/client');

const MARKER = 'FILE_CONTENT_MARKER_XYZ_42';

function stubFetch(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => { global.fetch = original; };
}

const FIXGATE_ANSWERS = {
  should_retry: { type: 'noul', noul: 0.8 },
  will_succeed: { type: 'noul', noul: 0.5 },
  needs_full_scope: { type: 'noul', noul: 0.1 },
  is_tiny_fix: { type: 'noul', noul: 0.7 }
};

describe('SystemOne - wiring file context vao body POST', () => {
  it('decideFixGate gui noi dung file trong `state` len gateway', async () => {
    let captured = null;
    const restore = stubFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ model: 'typesafe/jev-1.13-20260917', answers: FIXGATE_ANSWERS })
      };
    });
    try {
      // Padding > 4000 ky tu TRUOC marker: neu state bi cat o 4000 ky tu,
      // marker se bi mat => test bat duoc bug "cat sach fileContext".
      const padding = 'x'.repeat(8000);
      const fileContext = `--- FILE: src/bug.js ---\n${padding}\n// ${MARKER}\nconst x = 1;`;
      const r = await client.decideFixGate({
        jobId: 'wire-1', attempt: 1, maxRetries: 3,
        failures: { error: 'TypeError: boom' },
        files: ['src/bug.js'],
        fileContext
      });
      assert.ok(r, 'phai tra quyet dinh');
      assert.ok(captured, 'phai bat duoc body gui di');
      assert.ok(captured.state.includes(MARKER),
        'noi dung file phai co trong `state` (gateway chi doc state)');
      assert.ok(captured.state.includes('src/bug.js'), 'phai co ten file trong state');
      assert.ok(captured.state.length > 4000, `state phai > 4000 ky tu, got ${captured.state.length}`);
    } finally {
      restore();
    }
  });

  it('state duoc gioi han 240000 ky tu (MAX_STATE_CHARS)', async () => {
    let captured = null;
    const restore = stubFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ answers: FIXGATE_ANSWERS }) };
    });
    try {
      await client.decideFixGate({
        jobId: 'wire-2', attempt: 1, maxRetries: 3,
        failures: { error: 'x' }, files: [], fileContext: 'z'.repeat(500000)
      });
      assert.ok(captured.state.length <= 240000, `state dai ${captured.state.length}, vuot 240000`);
    } finally {
      restore();
    }
  });

  it('cache key phan biet 2 bo file khac nhau (khong dung 2000 ky tu dau)', async () => {
    const calls = [];
    const restore = stubFetch(async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ answers: FIXGATE_ANSWERS }) };
    });
    try {
      const common = 'PREFIX_SHARED_'.repeat(200);
      await client.decideFixGate({ jobId: 'wire-3', attempt: 1, maxRetries: 3, failures: { error: 'e' }, files: ['a.js'], fileContext: `${common}AAA` });
      await client.decideFixGate({ jobId: 'wire-3', attempt: 1, maxRetries: 3, failures: { error: 'e' }, files: ['a.js'], fileContext: `${common}BBB` });
      // 2 bo file khac nhau (chi 3 ky tu cuoi khac) => phai goi 2 lan, khong dung cache.
      assert.equal(calls.length, 2, `phai goi 2 lan (khong dung cache), got ${calls.length}`);
      assert.ok(calls[0].state.includes('AAA'));
      assert.ok(calls[1].state.includes('BBB'));
    } finally {
      restore();
    }
  });
});
