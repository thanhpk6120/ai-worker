/**
 * scripts/verify-task-pipeline-fix.js
 * Verify end-to-end các thay đổi TASK-PIPELINE-FIX trên server thật:
 *  1. GET /api/v1/systemone/status  -> có trạng thái live/fallback
 *  2. GET /api/v1/jobs/:id/evidence  -> mỗi evidence có status 3 giá trị + name + order
 *  3. POST .../evidence/files/:f/status -> đổi sang NOT VERIFY / PASS / FAILED
 *  4. SSE /api/v1/jobs/:id/logs/stream -> nhận event 'evidence' realtime khi file mới sinh
 *  5. GET /api/v1/jobs/:id -> cùng dữ liệu evidence (nguồn UI dùng)
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${detail ? ' :: ' + detail : ''}`);
}
function failedCount() {
  return results.filter((r) => !r.ok).length;
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, text: b }); }
      });
    }).on('error', reject);
  });
}

function post(port, p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(b) }); }
        catch (e) { resolve({ status: res.statusCode, text: b }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Mở SSE, tạo file evidence mới sau 1s, chờ event 'evidence' mang tên file mới.
 */
function verifySseRealtime(port, jobId, evidenceDir, png) {
  return new Promise((resolve) => {
    const sseEvents = [];
    let sseReq = null;
    const done = (reason) => {
      if (sseReq) { try { sseReq.destroy(); } catch (e) {} }
      resolve({ events: sseEvents, reason });
    };
    sseReq = http.get({ host: '127.0.0.1', port, path: `/api/v1/jobs/${jobId}/logs/stream` }, (res) => {
      res.on('data', (chunk) => {
        const s = chunk.toString();
        for (const line of s.split('\n')) {
          if (line.startsWith('event: ')) sseEvents.push(line.slice(7).trim());
          if (line.startsWith('data: ') && sseEvents.includes('evidence')) {
            try {
              const d = JSON.parse(line.slice(6));
              if (d.evidence && d.evidence.filename === '04_ui_realtime.png') done('received');
            } catch (e) {}
          }
        }
      });
      res.on('end', () => done('closed'));
      setTimeout(() => done('timeout'), 8000);
    });
    sseReq.on('error', () => done('error'));
    setTimeout(() => {
      try {
        fs.writeFileSync(path.join(evidenceDir, '04_ui_realtime.png'), png);
        const meta = JSON.parse(fs.readFileSync(path.join(evidenceDir, 'metadata.json'), 'utf8'));
        meta.push({
          fileName: '04_ui_realtime.png', name: 'Anh realtime',
          description: 'Sinh khi pipeline dang chay', stepIndex: 4, order: 4,
          status: 'NOT VERIFY', timestamp: '2026-10-20T04:00:00.000Z'
        });
        fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
      } catch (e) { done('write-error'); }
    }, 1200);
  });
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-verify-fix-'));
  const featureDir = path.join(tmpRoot, 'docs', 'features', 'TASK-FIX-VERIFY');
  const evidenceDir = path.join(featureDir, 'evidence');
  fs.mkdirSync(evidenceDir, { recursive: true });

  const png = Buffer.alloc(6000, 7);
  fs.writeFileSync(path.join(evidenceDir, '01_ui_step1.png'), png);
  fs.writeFileSync(path.join(evidenceDir, '02_ui_step2.png'), png);
  fs.writeFileSync(path.join(evidenceDir, '03_ui_step3.png'), png);
  fs.writeFileSync(path.join(evidenceDir, 'metadata.json'), JSON.stringify([
    { fileName: '01_ui_step1.png', name: 'Danh sach doi soat', description: 'Bang doi soat co cot HTTP Method', passCriteria: 'Co cot HTTP Method', stepIndex: 1, order: 1, status: 'NOT VERIFY', timestamp: '2026-10-20T01:00:00.000Z' },
    { fileName: '02_ui_step2.png', name: 'Chi tiet ban ghi', description: 'Mo ban ghi co errorCode', passCriteria: 'errorCode khong null', stepIndex: 2, order: 2, status: 'NOT VERIFY', timestamp: '2026-10-20T02:00:00.000Z' },
    { fileName: '03_ui_step3.png', name: 'Man hinh loi', description: 'Man hinh loi 502', passCriteria: 'Khong con cot loi', stepIndex: 3, order: 3, status: 'NOT VERIFY', timestamp: '2026-10-20T03:00:00.000Z' }
  ], null, 2), 'utf8');

  const db = require('../src/storage/db');
  const jobId = `verify-fix-${Date.now()}`;
  db.createJob({
    id: jobId,
    title: 'TASK-FIX-VERIFY',
    prompt: 'verify task pipeline fix',
    repo_path: tmpRoot,
    task_code: 'TASK-FIX-VERIFY',
    status: 'TESTING',
    runner: 'omp',
    pipeline_config: JSON.stringify({ timeout: 600000, max_retries: 7, job_deadline_ms: 1800000 })
  });

  const { app, stopAllEvidenceWatchers } = require('../src/server.js');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  console.log(`\n[INFO] Server test chay tai port ${port}\n`);

  try {
    // 1. SystemOne status
    const so = await get(port, '/api/v1/systemone/status');
    check('GET /api/v1/systemone/status tra ve 200', so.status === 200, `status=${so.status}`);
    check('SystemOne status co truong live/fallbackCount/model',
      !!(so.json && so.json.status && 'live' in so.json.status && 'fallbackCount' in so.json.status && so.json.status.model),
      JSON.stringify(so.json && so.json.status ? { live: so.json.status.live, model: so.json.status.model, fallbackCount: so.json.status.fallbackCount } : null));

    // 2. GET /evidence
    const ev = await get(port, `/api/v1/jobs/${jobId}/evidence`);
    check('GET /evidence tra ve 200', ev.status === 200, `status=${ev.status}`);
    const list = (ev.json && ev.json.evidence) ? ev.json.evidence : [];
    check('GET /evidence tra ve 3 evidence', list.length === 3, `count=${list.length}`);
    check('Moi evidence co status NOT VERIFY (chua verify)',
      list.length === 3 && list.every((e) => e.status === 'NOT VERIFY'),
      JSON.stringify(list.map((e) => e.status)));
    check('Moi evidence co verdict null khi chua verify',
      list.length === 3 && list.every((e) => e.verdict === null),
      JSON.stringify(list.map((e) => e.verdict)));
    check('Moi evidence co name va description',
      list.length === 3 && list.every((e) => e.name && e.description),
      JSON.stringify(list.map((e) => e.name)));
    check('Moi evidence co passCriteria',
      list.length === 3 && list.every((e) => !!e.passCriteria),
      JSON.stringify(list.map((e) => e.passCriteria)));
    check('Evidence sap xep theo thu tu step (order 1,2,3)',
      list.length === 3 && list[0].order === 1 && list[1].order === 2 && list[2].order === 3,
      JSON.stringify(list.map((e) => e.order)));

    // 3. Đổi trạng thái qua API
    const r1 = await post(port, `/api/v1/jobs/${jobId}/evidence/files/01_ui_step1.png/status`, { status: 'PASS' });
    check('POST status=PASS tra ve 200', r1.status === 200, `status=${r1.status}`);
    check('POST status=PASS tra ve status PASS', r1.json && r1.json.status === 'PASS' && r1.json.verdict === 'PASS', JSON.stringify(r1.json));

    const r2 = await post(port, `/api/v1/jobs/${jobId}/evidence/files/02_ui_step2.png/status`, { status: 'FAILED' });
    check('POST status=FAILED tra ve status FAILED', r2.json && r2.json.status === 'FAILED' && r2.json.verdict === 'FAIL', JSON.stringify(r2.json));

    const r3 = await post(port, `/api/v1/jobs/${jobId}/evidence/files/03_ui_step3.png/status`, { status: 'NOT VERIFY' });
    check('POST status="NOT VERIFY" duoc chap nhan', r3.json && r3.json.status === 'NOT VERIFY' && r3.json.verdict === null, JSON.stringify(r3.json));

    const ev2 = await get(port, `/api/v1/jobs/${jobId}/evidence`);
    const list2 = (ev2.json && ev2.json.evidence) ? ev2.json.evidence : [];
    check('GET /evidence phan anh 3 trang thai sau khi doi',
      list2.length === 3 && list2[0].status === 'PASS' && list2[1].status === 'FAILED' && list2[2].status === 'NOT VERIFY',
      JSON.stringify(list2.map((e) => e.status)));

    // 4. GET /jobs/:id (nguồn UI dùng)
    const jobDetail = await get(port, `/api/v1/jobs/${jobId}`);
    const evJob = (jobDetail.json && jobDetail.json.evidence) ? jobDetail.json.evidence : [];
    check('GET /jobs/:id (nguon UI) cung dung trang thai 3 gia tri',
      evJob.length === 3 && evJob[0].status === 'PASS' && evJob[1].status === 'FAILED' && evJob[2].status === 'NOT VERIFY',
      JSON.stringify(evJob.map((e) => e.status)));
    check('GET /jobs/:id (nguon UI) co name + order',
      evJob.length === 3 && evJob.every((e) => e.name && e.order !== null && e.order !== undefined),
      JSON.stringify(evJob.map((e) => ({ name: e.name, order: e.order }))));

    // 5. SSE realtime
    const sse = await verifySseRealtime(port, jobId, evidenceDir, png);
    check('SSE gui event "evidence" realtime khi file evidence moi sinh',
      sse.events.includes('evidence'),
      `events=${JSON.stringify([...new Set(sse.events)])} reason=${sse.reason}`);
  } catch (e) {
    check('Khong nem exception', false, e.message);
  } finally {
    try { stopAllEvidenceWatchers(); } catch (e) {}
    server.close();
  }

  const failed = failedCount();
  console.log(`\n=== TONG KET: ${results.length - failed}/${results.length} PASS ===`);
  if (failed) {
    console.log('Cac muc FAIL:');
    for (const f of results.filter((r) => !r.ok)) console.log(` - ${f.name} :: ${f.detail || ''}`);
  } else {
    console.log('TAT CA VERIFY PASS');
  }
  // Server SSE giu socket nen phai ep thoat process.
  process.exit(failed ? 1 : 0);
})();
