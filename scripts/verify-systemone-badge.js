/**
 * scripts/verify-systemone-badge.js
 * Verify badge SystemOne PER-TASK end-to-end:
 * 1) Tạo job (không spawn agent - chỉ tới bước triage/dedup)
 * 2) Đọc badge qua API: phải là "CHƯA GỌI" (live === null) trước khi job chạy
 * 3) Gọi /start -> SystemOne triage chạy -> badge phải là "LIVE" (live === true)
 * 4) Xác nhận 2 job khác nhau có badge riêng biệt
 * 5) Dọn job test (không để lại rác trong DB)
 */
'use strict';
const assert = require('node:assert/strict');

const BASE = process.env.AW_BASE || 'http://127.0.0.1:3000';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// Workspace TAM de job test KHONG ghi tai lieu vao repo that
// (server tao docs/features/<task_code>/ trong repo_path).
const TMP_WS = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-badge-'));

async function createJob(tag) {
  const res = await fetch(`${BASE}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `[BADGE-TEST] ${tag}`,
      task_code: `BADGE-TEST-${tag}-${Date.now()}`,
      prompt: 'Sua mot loi typo nho trong README.md. Khong can browser.',
      runner: 'omp',
      repo_path: TMP_WS
    })
  });
  assert.ok(res.status === 200 || res.status === 201, `tao job ${tag} => HTTP ${res.status}`);
  const j = await res.json();
  return j.job ? j.job.id : (j.id || (j.data && j.data.id));
}

async function getBadge(jobId) {
  const res = await fetch(`${BASE}/api/v1/jobs/${jobId}`);
  assert.equal(res.status, 200, `doc job ${jobId} => HTTP ${res.status}`);
  const j = await res.json();
  const job = j.job || j;
  return job.systemone_state || null;
}

async function main() {
  const created = [];
  try {
    // 1) Job moi: CHUA GOI
    const idA = await createJob('A');
    created.push(idA);
    const badge0 = await getBadge(idA);
    console.log('1) job moi -> systemone_state =', JSON.stringify(badge0));
    assert.strictEqual(badge0, null, 'job chua chay phai co badge CHUA GOI (null)');

    // 2) Start -> SystemOne triage chay -> LIVE
    const startRes = await fetch(`${BASE}/api/v1/jobs/${idA}/start`, { method: 'POST' });
    console.log('2) start HTTP', startRes.status);
    assert.ok(startRes.status === 200, `start job => HTTP ${startRes.status}`);

    // Cho pipeline chay vai giay cho den khi co badge.
    let badge = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      badge = await getBadge(idA);
      if (badge) break;
    }
    console.log('3) sau start -> systemone_state =', JSON.stringify(badge));
    assert.ok(badge, 'phai co badge sau khi start');
    assert.strictEqual(badge.live, true, `phai la LIVE (model that), got ${JSON.stringify(badge)}`);
    assert.ok(badge.calls >= 1, 'phai co it nhat 1 lan goi model');
    assert.strictEqual(badge.fallbacks, 0, 'khong duoc co fallback heuristic');

    // 3) Job thu 2: badge rieng biet
    const idB = await createJob('B');
    created.push(idB);
    const badgeB = await getBadge(idB);
    console.log('4) job B (moi) -> systemone_state =', JSON.stringify(badgeB));
    assert.strictEqual(badgeB, null, 'job B chua chay => badge rieng = null');
    assert.notStrictEqual(badgeB, badge, '2 job phai co badge RIENG BIET');

    console.log(`\nTAT CA PASS: badge per-task - job A = ${badge.live} (${badge.calls} calls), job B = CHUA GOI`);
  } finally {
    // Cancel truoc de dua status ve CANCELLED, sau do DELETE xoa cung khoi DB
    for (const id of created) {
      try {
        await fetch(`${BASE}/api/v1/jobs/${id}/cancel`, { method: 'POST' });
      } catch (e) {}
      try {
        await fetch(`${BASE}/api/v1/jobs/${id}`, { method: 'DELETE' });
      } catch (e) {}
    }
    console.log('Da cancel & xoa sach job test khoi DB:', created.join(', '));
    try { fs.rmSync(TMP_WS, { recursive: true, force: true }); } catch (e) {}
  }
}

main().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
