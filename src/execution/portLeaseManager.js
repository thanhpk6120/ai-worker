/**
 * src/execution/portLeaseManager.js
 * Cấp phát port CHO TỪNG JOB theo dạng LEASE (giống thuê slot), thay vì mỗi job
 * tự chọn một port mới.
 *
 * VẤN ĐỀ GỐC:
 *  - Mỗi lần TESTING/VERIFY, agent tự chạy `vite --port 3011`, `java ...` trên
 *    port tuỳ ý => 2 job chạy song song đụng nhau, job sau fail bind port, phải
 *    đổi port mới, port cũ thành rác.
 *  - Không có nơi nào biết "port X đang thuộc job nào", nên không thể dọn.
 *
 * CƠ CHẾ:
 *  - Pool port cố định theo loại service (FE/BE/MOCK/OTHER). Port thuộc POOL,
 *    không thuộc job: job chỉ thuê trong thời gian chạy step.
 *  - Lease có TTL + heartbeat: worker chết => lease tự hết hạn và port được thu hồi.
 *  - Trước khi cấp, bind thử port để chắc chắn OS đang trống (tránh process rác
 *    còn giữ port từ lần chạy trước).
 *  - Port được bơm cho agent qua env `AIWORKER_PORT_MAP` + prompt contract,
 *    agent bị buộc dùng đúng port đó.
 *
 * KHÔNG xử lý: preempt (cưỡng chế lấy port). Hết thời gian chờ => trả
 * { ok:false } để tầng trên pause job và báo người dùng, không tự kill job khác.
 */
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const db = require('../storage/db');

// Pool mặc định: [from, to]. Có thể ghi đè bằng env AIWORKER_PORT_POOLS (JSON).
const DEFAULT_POOLS = {
  FE: [3010, 3019],
  BE: [8081, 8089],
  MOCK: [8090, 8099],
  OTHER: [8110, 8119]
};

const LEASE_TTL_MS = 10 * 60 * 1000;   // 10 phut
const HEARTBEAT_MS = 60 * 1000;       // 60s
const POLL_MS = 2000;                 // 2s/lan khi cho
const WAIT_LOG_EVERY_MS = 15000;

function classifyServiceKey(serviceKey) {
  const key = String(serviceKey || '').toLowerCase();
  if (/mock|stub|fake/.test(key)) return 'MOCK';
  if (/front|fe\b|-fe|ui|web|admin-fe|portal/.test(key)) return 'FE';
  if (/back|be\b|-be|api|server|service|admin-be|gateway/.test(key)) return 'BE';
  return 'OTHER';
}

function readPools() {
  const raw = process.env.AIWORKER_PORT_POOLS;
  if (!raw) return { ...DEFAULT_POOLS };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const merged = { ...DEFAULT_POOLS };
      for (const [k, v] of Object.entries(parsed)) {
        if (Array.isArray(v) && v.length === 2 && Number(v[0]) > 0 && Number(v[1]) >= Number(v[0])) {
          merged[String(k).toUpperCase()] = [Number(v[0]), Number(v[1])];
        }
      }
      return merged;
    }
  } catch (e) {
    console.warn('[PORT-LEASE] AIWORKER_PORT_POOLS không hợp lệ, dùng mặc định:', e.message);
  }
  return { ...DEFAULT_POOLS };
}

function portsForKind(kind) {
  const pools = readPools();
  const [from, to] = pools[kind] || pools.OTHER;
  const list = [];
  for (let p = from; p <= to; p += 1) list.push(p);
  return list;
}

/** Port có đang trống ở OS hay không (bind thử). */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const done = (free) => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch (e) {}
      resolve(free);
    };
    server.once('error', () => done(false));
    server.once('listening', () => done(true));
    try {
      server.listen(port, host);
    } catch (e) {
      done(false);
    }
    setTimeout(() => done(false), 800).unref();
  });
}

function ensureSchema() {
  db.getDb().exec(`
    CREATE TABLE IF NOT EXISTS port_leases (
      id TEXT PRIMARY KEY,
      service_key TEXT NOT NULL,
      port INTEGER NOT NULL,
      job_id TEXT,
      task_code TEXT,
      lease_expires_at INTEGER,
      heartbeat_at INTEGER,
      created_at TEXT,
      note TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_port_leases_port ON port_leases(port);
    CREATE INDEX IF NOT EXISTS idx_port_leases_job ON port_leases(job_id);
  `);
  // CHE DO CHO (exclusive): mỗi service_key chỉ có TỐI ĐA 1 job giữ tại một thời
  // điểm. Job thứ 2 phải xếp hàng chờ, KHÔNG được cấp port khác.
  try {
    db.getDb().exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_port_leases_service ON port_leases(service_key);');
  } catch (e) {
    // Bảng cũ còn bản ghi trùng service_key (do bug/backfill). CHỈ dọn bản ghi
    // trùng, giữ bản mới nhất của từng service — TUYỆT ĐỐI không xoá toàn bảng
    // (sẽ giết lease của job khác đang chạy).
    try {
      db.getDb().exec(`
        DELETE FROM port_leases
        WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM port_leases GROUP BY service_key
        );
      `);
      db.getDb().exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_port_leases_service ON port_leases(service_key);');
    } catch (e2) {
      console.warn('[PORT-LEASE] Không tạo được unique index service_key:', e2.message);
    }
  }
}

/** Port cố định theo serviceKey: cùng service luôn về cùng port => URL ổn định. */
function deterministicPort(serviceKey, kind) {
  const pool = portsForKind(kind);
  let hash = 0;
  for (const ch of String(serviceKey)) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  return pool[hash % pool.length];
}

/** Lease hiện tại của 1 service_key (nếu có). */
function leaseForService(serviceKey) {
  ensureSchema();
  return db.getDb().prepare('SELECT * FROM port_leases WHERE service_key = ? LIMIT 1').get(serviceKey);
}

function nowMs() { return Date.now(); }

function listLeases() {
  ensureSchema();
  return db.getDb().prepare('SELECT * FROM port_leases ORDER BY port ASC').all();
}

/** Xoá các lease đã hết hạn (worker chết hoặc job không còn giữ). */
function reclaimExpired(now = nowMs()) {
  ensureSchema();
  const result = db.getDb()
    .prepare('DELETE FROM port_leases WHERE lease_expires_at IS NOT NULL AND lease_expires_at < ?')
    .run(now);
  return Number(result && result.changes) || 0;
}

/** Giải phóng toàn bộ port của 1 job (gọi khi kết thúc step / cancel / pause). */
function releaseByJob(jobId) {
  if (!jobId) return 0;
  ensureSchema();
  const result = db.getDb().prepare('DELETE FROM port_leases WHERE job_id = ?').run(jobId);
  return Number(result && result.changes) || 0;
}

function releaseLease(leaseId) {
  if (!leaseId) return 0;
  ensureSchema();
  const result = db.getDb().prepare('DELETE FROM port_leases WHERE id = ?').run(leaseId);
  return Number(result && result.changes) || 0;
}

function heartbeat(leaseId, ttlMs = LEASE_TTL_MS) {
  if (!leaseId) return false;
  ensureSchema();
  const now = nowMs();
  const result = db.getDb()
    .prepare('UPDATE port_leases SET heartbeat_at = ?, lease_expires_at = ? WHERE id = ?')
    .run(now, now + ttlMs, leaseId);
  return Number(result && result.changes) > 0;
}

/**
 * Duy trì lease trong suốt bước chạy dài (TESTING/FIXING có thể 20-60 phút).
 *
 * NẾU KHÔNG GIA HẠN: lease TTL 10 phút sẽ hết hạn giữa lúc job đang test,
 * `reclaimExpired()` xoá lease và job khác có thể chiếm đúng service/port đó
 * ngay trong khi job đầu vẫn đang chạy.
 *
 * @param {Array<{leaseId:string}>} leases
 * @param {object} [options] { intervalMs }
 * @returns {{stop:Function}}
 */
function startLeaseHeartbeat(leases, options = {}) {
  const list = (Array.isArray(leases) ? leases : []).filter((l) => l && l.leaseId);
  if (list.length === 0) return { stop() {} };
  const intervalMs = Number(options.intervalMs) > 0 ? Number(options.intervalMs) : HEARTBEAT_MS;
  let warned = false;
  const timer = setInterval(() => {
    for (const lease of list) {
      try {
        const okBeat = heartbeat(lease.leaseId);
        if (!okBeat && !warned) {
          warned = true;
          console.warn(`[PORT-LEASE] Không gia hạn được lease ${lease.leaseId} (${lease.serviceKey}:${lease.port}) — lease có thể đã bị thu hồi.`);
        }
      } catch (e) {
        // Không để lỗi heartbeat làm sập worker.
      }
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return {
    stop() {
      try { clearInterval(timer); } catch (e) {}
    }
  };
}

/**
 * Thuê service (exclusive) cho job — CHẾ ĐỘ CHỜ.
 *
 * Chỉ MỘT job được giữ một service_key tại một thời điểm. Job khác cùng service
 * sẽ đứng chờ tới khi job đang giữ nhả lease (hết step / bị dừng), KHÔNG được
 * cấp một port khác để chạy song song.
 *
 * @returns {Promise<{ok:boolean, port?:number, leaseId?:string, serviceKey?:string,
 *   kind?:string, reason?:string, holders?:Array<object>, waitedMs?:number}>}
 */
async function acquire({ jobId, serviceKey, taskCode = null, timeoutMs = 20 * 60 * 1000, onWait = null } = {}) {
  if (!jobId || !serviceKey) {
    return { ok: false, reason: 'INVALID_ARGS' };
  }
  ensureSchema();
  const kind = classifyServiceKey(serviceKey);
  const startedAt = nowMs();
  let nextLogAt = startedAt + WAIT_LOG_EVERY_MS;

  for (;;) {
    reclaimExpired();

    const current = leaseForService(serviceKey);
    if (current && current.job_id === jobId) {
      // Idempotent: job đã giữ service này (vd FIXING nhiều vòng).
      return { ok: true, port: Number(current.port), leaseId: current.id, serviceKey, kind, waitedMs: 0 };
    }

    if (!current) {
      const pool = portsForKind(kind);
      const preferred = deterministicPort(serviceKey, kind);
      const candidates = [preferred, ...pool.filter((p) => p !== preferred)];
      for (const port of candidates) {
        if (listLeases().some((l) => Number(l.port) === port)) continue;
        // eslint-disable-next-line no-await-in-loop
        const free = await isPortFree(port);
        if (!free) continue;
        const leaseId = crypto.randomUUID();
        const now = nowMs();
        try {
          db.getDb().prepare(`
            INSERT INTO port_leases (id, service_key, port, job_id, task_code, lease_expires_at, heartbeat_at, created_at, note)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(leaseId, serviceKey, port, jobId, taskCode, now + LEASE_TTL_MS, now, new Date(now).toISOString(), null);
          return { ok: true, port, leaseId, serviceKey, kind, waitedMs: now - startedAt };
        } catch (e) {
          // Race với job khác: thử port kế tiếp.
          continue;
        }
      }
    }

    const waitedMs = nowMs() - startedAt;
    if (waitedMs >= timeoutMs) {
      return { ok: false, reason: 'PORT_WAIT_TIMEOUT', kind, serviceKey, holders: current ? [current] : [], waitedMs };
    }
    if (typeof onWait === 'function' && nowMs() >= nextLogAt) {
      nextLogAt = nowMs() + WAIT_LOG_EVERY_MS;
      try { onWait({ waitedMs, holders: current ? [current] : [], kind, serviceKey }); } catch (e) {}
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, POLL_MS).unref());
  }
}

/**
 * Cấp port cho tất cả service của workspace mà job cần.
 * @param {object} job  job row (cần id, task_code, workspace_id, repo_path)
 * @param {object} [options]
 * @returns {Promise<{ok:boolean, ports:Object<string,number>, leases:Array<object>,
 *   serviceKeys:string[], reason?:string, holders?:Array<object>}>}
 */
async function acquireForJob(job, options = {}) {
  if (!job || !job.id) return { ok: false, ports: {}, leases: [], serviceKeys: [], reason: 'INVALID_JOB' };
  ensureSchema();
  const services = resolveServicesForJob(job).slice().sort();
  const ports = {};
  const leases = [];
  for (const service of services) {
    // eslint-disable-next-line no-await-in-loop
    const res = await acquire({
      jobId: job.id,
      serviceKey: service,
      taskCode: job.task_code || null,
      timeoutMs: options.timeoutMs,
      onWait: options.onWait
    });
    if (!res.ok) {
      // Rollback các port đã thuê để không giữ rác.
      for (const l of leases) releaseLease(l.leaseId);
      return { ok: false, ports: {}, leases: [], serviceKeys: services, reason: res.reason, holders: res.holders, waitedMs: res.waitedMs };
    }
    ports[service] = res.port;
    leases.push({ serviceKey: service, port: res.port, leaseId: res.leaseId });
  }
  return { ok: true, ports, leases, serviceKeys: services };
}

/** Suy ra danh sách service cần cấp port cho job. */
function resolveServicesForJob(job) {
  // Uu tien service ma job THUC SU dong vao (co worktree con ton tai tren dia).
  // Truoc day lay 3 service dau tien cua workspace (23 service) nen moi job trong
  // cung workspace deu tranh dung 3 port do, va job khong co worktree van thuê
  // port trong khi khong co gi de chay.
  // Worktree da MERGED van con code tren dia => van tinh (FIXING sau MERGING).
  let services = [];
  try {
    services = (db.listJobWorktrees(job.id) || [])
      .filter((w) => w && w.service_key)
      .filter((w) => !/^(DELETED|REMOVED)$/i.test(String(w.status || '')))
      .filter((w) => {
        if (!w.worktree_path) return false;
        try { return fs.existsSync(w.worktree_path); } catch (e) { return false; }
      })
      .map((w) => w.service_key);
  } catch (e) {}
  // Giới hạn: 1 job không cần thuê quá 3 port (tránh chiếm cả pool).
  return Array.from(new Set(services)).slice(0, 3);
}

/** Sinh block prompt ràng buộc port (chèn đầu prompt TESTING/FIXING). */
function buildPortContract(ports) {
  const entries = Object.entries(ports || {});
  if (!entries.length) return '';
  const lines = entries.map(([service, port]) => `- ${service}: **${port}**`).join('\n');
  return `## PORT CONTRACT (BẮT BUỘC — worker đã cấp port)
Chỉ được khởi động service trên ĐÚNG các port dưới đây. KHÔNG được tự chọn port khác,
KHÔNG được đổi port khi bị lỗi bind (phải báo lỗi ra log để worker xử lý):
${lines}

**BẮT BUỘC RESTART SERVICE TRƯỚC KHI TEST/VERIFY:**
- Worker đã dừng các service cũ trong worktree này. Bạn phải **build lại** và
  **khởi động service mới** trên các port ở trên; TUYỆT ĐỐI không dùng lại
  instance/tiến trình đang chạy (có thể là code cũ).
- Worker đã ghi file \`__aiworker_build.json\` vào thư mục static của worktree
  (chứa build hash của mã nguồn hiện tại). Sau khi build, service PHẢI phục vụ
  được \`GET /__aiworker_build.json\` với đúng hash đó — nếu không, worker coi
  như bạn chưa build lại và bước test sẽ thất bại.
- Giữ service chạy cho tới khi bước kết thúc để worker xác minh; kiểm tra
  \`GET /\` trả 200 trước khi chụp ảnh/gọi API.
- Khi kết thúc kiểm thử, dừng service do bạn khởi động để nhả port.

Biến môi trường tương ứng đã được bơm sẵn: \`AIWORKER_PORT_MAP=${JSON.stringify(ports)}\`.

`;
}

/** Giải phóng toàn bộ port của job + ghi log. */
function releaseJobPorts(jobId, reason = '') {
  const count = releaseByJob(jobId);
  if (count > 0) {
    console.log(`[PORT-LEASE] Giải phóng ${count} port của job ${jobId}${reason ? ` (${reason})` : ''}.`);
  }
  return count;
}

/**
 * Xoá toàn bộ lease (gọi lúc boot). An toàn vì khi server restart, mọi tiến
 * trình con đã bị kill; port nào còn bị giữ bởi process rác sẽ bị `isPortFree`
 * phát hiện và bỏ qua khi cấp phát.
 */
function clearAllLeases() {
  ensureSchema();
  const result = db.getDb().prepare('DELETE FROM port_leases').run();
  return Number(result && result.changes) || 0;
}

/**
 * Dọn service "rác" do agent khởi động trong worktree của job đã kết thúc.
 *
 * VẤN ĐỀ: agent start `vite --port 3011` trong `.worktrees/PHUB-679`; khi job
 * DONE, tiến trình vite vẫn sống, giữ port VÀ khoá file khiến
 * `git worktree remove` bị "Permission denied".
 *
 * AN TOÀN: chỉ kill process có CommandLine chứa ĐÚNG đường dẫn worktree của job
 * (so khớp sau khi chuẩn hoá dấu phân cách), và không bao giờ kill chính worker.
 *
 * @param {object} job job row (cần worktree_path hoặc repo_path)
 * @param {object} [options] { dryRun }
 * @returns {{killed: Array<{pid:number,name:string}>, raw: string}}
 */
function killLeftoverServicesForJob(job, options = {}) {
  const worktreePath = job && (job.worktree_path || '');
  if (!worktreePath) return { killed: [], raw: '' };
  // Chỉ dọn khi đường dẫn nằm trong thư mục worktree (tránh xoá nhầm repo gốc).
  if (!/[\\/]\.worktrees[\\/]/i.test(worktreePath)) return { killed: [], raw: '' };

  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    '$needle = ($env:AIW_WORKTREE -replace "\\\\","/").ToLower()',
    '$self = [int]$env:AIW_SELF_PID',
    '$out = @()',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $cmd = $_.CommandLine',
    '  if (-not $cmd) { return }',
    '  $norm = ($cmd -replace "\\\\","/").ToLower()',
    '  if ($norm.Contains($needle) -and $_.ProcessId -ne $self) {',
    '    $out += ("{0}|{1}" -f $_.ProcessId, $_.Name)',
    '    if (-not $env:AIW_DRY_RUN) { taskkill /F /T /PID $_.ProcessId | Out-Null }',
    '  }',
    '}',
    '$out -join "`n"'
  ].join('\n');

  try {
    const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      env: {
        ...process.env,
        AIW_WORKTREE: worktreePath,
        AIW_SELF_PID: String(process.pid),
        AIW_DRY_RUN: options.dryRun ? '1' : ''
      }
    });
    const killed = String(raw || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pid, name] = line.split('|');
        return { pid: Number(pid), name: name || '' };
      })
      .filter((item) => Number.isFinite(item.pid));
    if (killed.length > 0 && !options.dryRun) {
      console.log(`[PORT-LEASE] Đã dọn ${killed.length} service rác của job ${job.task_code || job.id}: ${killed.map((k) => `${k.name}#${k.pid}`).join(', ')}`);
    }
    return { killed, raw: String(raw || '') };
  } catch (e) {
    return { killed: [], raw: '', error: e.message };
  }
}

/**
 * Giải phóng port + dọn service rác của job. Dùng khi job kết thúc hoặc bị dừng.
 * @param {object} job job row
 * @param {string} [reason]
 */
function releaseJobPortsAndCleanup(job, reason = '') {
  if (!job || !job.id) return { released: 0, killed: 0 };
  const released = releaseJobPorts(job.id, reason);
  let killed = 0;
  try {
    const res = killLeftoverServicesForJob(job);
    killed = res.killed.length;
  } catch (e) {}
  return { released, killed };
}

/**
 * Chuẩn bị service để test: DỪNG service cũ trong worktree rồi xác nhận port
 * đã trống. Bắt buộc chạy sau khi nhận port, trước khi test/verify — không được
 * dùng lại instance đang chạy (có thể là code/build cũ).
 *
 * @param {object} job
 * @param {object} ports map serviceKey -> port
 * @param {object} [options] { waitMs=10000 }
 * @returns {Promise<{ok:boolean, killed:Array, busyPorts:number[], killedCount:number}>}
 */
async function prepareServicesForTest(job, ports, options = {}) {
  const waitMs = Number(options.waitMs) > 0 ? Number(options.waitMs) : 10000;
  let killed = [];
  try {
    const res = killLeftoverServicesForJob(job);
    killed = res.killed || [];
  } catch (e) {}

  const list = Object.values(ports || {}).map(Number).filter((p) => Number.isFinite(p) && p > 0);
  const busyPorts = [];
  const deadline = nowMs() + waitMs;
  for (const port of list) {
    // eslint-disable-next-line no-await-in-loop
    let free = await isPortFree(port);
    while (!free && nowMs() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 500).unref());
      // eslint-disable-next-line no-await-in-loop
      free = await isPortFree(port);
    }
    if (!free) busyPorts.push(port);
  }
  if (killed.length > 0) {
    console.log(`[PORT-LEASE] Restart bắt buộc: đã dừng ${killed.length} service cũ của job ${job && (job.task_code || job.id)} (${killed.map((k) => `${k.name}#${k.pid}`).join(', ')}).`);
  }
  return { ok: busyPorts.length === 0, killed, killedCount: killed.length, busyPorts };
}

module.exports = {
  acquire,
  acquireForJob,
  prepareServicesForTest,
  releaseLease,
  releaseByJob,
  releaseJobPorts,
  releaseJobPortsAndCleanup,
  killLeftoverServicesForJob,
  clearAllLeases,
  heartbeat,
  startLeaseHeartbeat,
  reclaimExpired,
  listLeases,
  isPortFree,
  buildPortContract,
  resolveServicesForJob,
  classifyServiceKey,
  ensureSchema,
  portsForKind,
  DEFAULT_POOLS,
  LEASE_TTL_MS,
  HEARTBEAT_MS
};
