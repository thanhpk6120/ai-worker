/**
 * src/execution/processJanitor.js
 * ---------------------------------------------------------------------------
 * Process Janitor - dọn tiến trình rác (dev server / BE / agent CLI bỏ hoang)
 * theo chu kỳ, có báo cáo + log để xem lại trên Dashboard.
 *
 * VÌ SAO CẦN: mỗi vòng TESTING/FIXING, agent tự dựng service (vite, spring-boot,
 * mvn, mock...) trong worktree. Khi job kết thúc hoặc agent chết giữa đường, các
 * tiến trình này không phải lúc nào cũng chết theo, chúng ôm port + RAM. Đã gặp
 * thực tế: BE 8081/8082 + mock 8099 + vite 3100 sống hơn 20 giờ sau khi job DONE.
 *
 * NGUYÊN TẮC AN TOÀN (quan trọng hơn tính năng):
 *  1. KHÔNG BAO GIỜ kill chính worker, tổ tiên của worker, hay con cháu của worker
 *     (mọi agent/job đang chạy đều là con cháu worker => được bảo vệ tuyệt đối).
 *  2. KHÔNG kill tiến trình đang giữ port lease còn hiệu lực.
 *  3. KHÔNG kill tiến trình có đường dẫn thuộc worktree của job CHƯA kết thúc.
 *  4. KHÔNG kill tiến trình hệ thống / IDE / shell tương tác của người dùng.
 *  5. Chỉ kill tiến trình sống lâu hơn `JANITOR_GRACE_MINUTES`.
 *  6. Mọi quyết định đều ghi log kèm lý do -> audit được.
 *
 * Toàn bộ luật ở đây là TỔNG QUÁT (theo dấu hiệu cmdline/port/worktree), không
 * hard-code tên dự án nào, nên dùng được cho mọi workspace.
 * ---------------------------------------------------------------------------
 */
'use strict';

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');

const config = require('../config');
const db = require('../storage/db');
const portLeaseManager = require('./portLeaseManager');

// Trạng thái job được coi là "đã xong" -> service còn sót lại là rác.
const TERMINAL_JOB_STATUSES = ['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ARCHIVED'];

// Trạng thái job coi là ĐANG CHẠY -> mọi tiến trình trong worktree của nó bất khả xâm phạm.
// PENDING/PAUSED KHÔNG nằm ở đây: lúc đó worker đã nhả port, service còn sống là rác.
const RUNNING_JOB_STATUSES = ['PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'MERGING'];

// Tên tiến trình KHÔNG BAO GIỜ kill (hệ điều hành, IDE, shell tương tác).
const PROTECTED_NAMES = new Set([
  'system', 'idle', 'registry', 'memory compression',
  'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe',
  'svchost.exe', 'dwm.exe', 'fontdrvhost.exe', 'spoolsv.exe', 'taskhostw.exe',
  'sihost.exe', 'ctfmon.exe', 'explorer.exe', 'searchhost.exe', 'startmenuexperiencehost.exe',
  'runtimebroker.exe', 'shellexperiencehost.exe', 'textinputhost.exe', 'conhost.exe',
  'msmpeng.exe', 'securityhealthservice.exe', 'audiodg.exe',
  'orca.exe', 'dsh next.exe', 'code.exe', 'code - insiders.exe', 'devenv.exe',
  'idea64.exe', 'pycharm64.exe', 'webstorm64.exe', 'goland64.exe', 'rider64.exe',
  'windowsterminal.exe', 'wt.exe', 'sshd.exe'
]);

// Tên không đưa vào báo cáo "Được bảo vệ" dù chúng thuộc cây worker:
// tổ tiên hệ thống của worker và các shell/conhost tạm thời làm báo cáo nhiễu.
const REPORT_HIDDEN_NAMES = new Set([
  ...PROTECTED_NAMES,
  'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wmiprvse.exe', 'conhost.exe', 'bash.exe', 'sh.exe'
]);

// Dấu hiệu một tiến trình là service dev (FE/BE) do agent dựng lên.
const DEV_SERVER_RE = new RegExp([
  '\\bvite\\b', '\\bnext\\s+dev\\b', '\\breact-scripts\\b', '\\bwebpack\\b', '\\bng\\s+serve\\b',
  'spring-boot:run', '\\bbootRun\\b', '\\bjava\\b[^\\n]*-jar\\b', '\\buvicorn\\b', '\\bgunicorn\\b',
  '\\bflask\\s+run\\b', 'dotnet\\s+run\\b', 'php\\s+artisan\\s+serve', '\\bnpm\\s+run\\s+dev\\b',
  '\\bpnpm\\s+(run\\s+)?dev\\b', '\\byarn\\s+dev\\b', '\\bmvnw?\\b', '\\bgradlew?\\b',
  'mock_[a-z0-9_]+\\.mjs', '\\bjson-server\\b'
].join('|'), 'i');

// Dấu hiệu một tiến trình là agent CLI / MCP server (chỉ dùng ở luật C - mặc định TẮT).
const AGENT_RE = /(?:^|[\\/])(omp|claude|codex|opencode)(\.exe)?\s|mcp-server|memorix|gitnexus|shell-snapshots/i;

/** Chuẩn hoá đường dẫn để so khớp theo "đoạn" (tránh PHUB-67 khớp PHUB-679). */
function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** `child` có nằm TRONG `parent` không (so theo đoạn đường dẫn). */
function isInsidePath(child, parent) {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  return c === p || c.startsWith(p + '\\');
}

/**
 * Command line có tham chiếu tới thư mục `dirPath` (như một ĐOẠN đường dẫn) không?
 * Khác `isInsidePath`: command line chứa cả cờ và đối số, nên phải tìm chuỗi con
 * và kiểm tra ranh giới hai đầu để tránh `...\PHUB-67` khớp `...\PHUB-679`.
 */
function cmdRefersToPath(cmd, dirPath) {
  const c = normalizePath(cmd);
  const p = normalizePath(dirPath);
  if (!c || !p) return false;
  let from = 0;
  for (;;) {
    const idx = c.indexOf(p, from);
    if (idx === -1) return false;
    const before = idx === 0 ? '' : c[idx - 1];
    const after = c[idx + p.length];
    const beforeOk = before === '' || before === ' ' || before === '"' || before === "'" || before === '=';
    const afterOk = after === undefined || after === '\\' || after === '"' || after === "'" || after === ' ' || after === '\r' || after === '\n';
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
}

/**
 * Dựng map pid -> con trực tiếp và tập con cháu của 1 pid.
 * @param {Array} procs
 * @param {number|string} rootPid
 * @returns {Set<number>}
 */
function collectDescendants(procs, rootPid) {
  const childrenByParent = new Map();
  for (const p of procs) {
    const ppid = Number(p.ppid);
    if (!childrenByParent.has(ppid)) childrenByParent.set(ppid, []);
    childrenByParent.get(ppid).push(Number(p.pid));
  }
  const out = new Set();
  const stack = [Number(rootPid)];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of (childrenByParent.get(cur) || [])) {
      if (out.has(child)) continue;
      out.add(child);
      stack.push(child);
    }
  }
  return out;
}

/** Tổ tiên của 1 pid (gần -> xa). */
function collectAncestors(byPid, pid, maxDepth = 15) {
  const out = [];
  let cur = Number(pid);
  for (let i = 0; i < maxDepth; i += 1) {
    const rec = byPid.get(cur);
    if (!rec) break;
    const ppid = Number(rec.ppid);
    if (!ppid || ppid === cur) break;
    const parent = byPid.get(ppid);
    if (!parent) break;
    out.push(parent);
    cur = ppid;
  }
  return out;
}

/**
 * PHÂN TÍCH THUẦN (không I/O) -> danh sách ứng viên kill + danh sách được bảo vệ.
 * Tách riêng để unit-test không cần PowerShell.
 *
 * @param {object} input
 * @param {Array<{pid:number,ppid:number,name:string,cmd:string,ageMs:number,cpu:number}>} input.procs
 * @param {Array<{port:number,pid:number}>} input.listeners
 * @param {Array<{service_key:string,port:number,job_id:string}>} input.leases
 * @param {Array<{task_code:string,status:string,worktree_path:string}>} input.jobs
 * @param {number} input.selfPid
 * @param {object} [input.opts]
 * @returns {{candidates:Array, protectedList:Array, scanned:number}}
 */
function analyze({ procs, listeners, leases, jobs, selfPid, opts = {} }) {
  const graceMs = (opts.graceMinutes !== undefined ? opts.graceMinutes : config.JANITOR_GRACE_MINUTES) * 60 * 1000;
  const allowIdleAgentTrees = opts.idleAgentTrees !== undefined ? opts.idleAgentTrees : config.JANITOR_IDLE_AGENT_TREES;
  const idleAgentMs = (opts.idleAgentHours !== undefined ? opts.idleAgentHours : config.JANITOR_IDLE_AGENT_HOURS) * 60 * 60 * 1000;

  const byPid = new Map();
  for (const p of procs) byPid.set(Number(p.pid), p);

  const leasePorts = new Set((leases || []).map((l) => Number(l.port)).filter((n) => Number.isFinite(n)));
  const listenerPids = new Set((listeners || []).map((l) => Number(l.pid)).filter((n) => Number.isFinite(n)));
  const listenerByPid = new Map();
  for (const l of (listeners || [])) {
    const pid = Number(l.pid);
    if (!Number.isFinite(pid)) continue;
    if (!listenerByPid.has(pid)) listenerByPid.set(pid, []);
    listenerByPid.get(pid).push(Number(l.port));
  }

  const activeJobs = (jobs || []).filter((j) => RUNNING_JOB_STATUSES.includes(String(j.status || '').toUpperCase()));
  const doneJobs = (jobs || []).filter((j) => TERMINAL_JOB_STATUSES.includes(String(j.status || '').toUpperCase()));
  // Mọi worktree đã biết (job đang chạy, đang chờ, đã xong) - dùng để nhận diện
  // "tiến trình do worker/agent tạo ra" mà không đụng tiến trình người dùng tự chạy.
  const knownWorktrees = Array.from(new Set(
    (jobs || []).map((j) => j.worktree_path).filter(Boolean)
  ));
  const poolPorts = new Set(
    (opts.poolPorts || portLeaseManager.getAllPoolPorts()).map((p) => Number(p))
  );

  /** @type {Map<number,string>} pid -> lý do được bảo vệ */
  const guarded = new Map();
  const guard = (pid, reason) => {
    const n = Number(pid);
    if (!Number.isFinite(n) || guarded.has(n)) return;
    guarded.set(n, reason);
  };

  // (1) Worker + toàn bộ tổ tiên + toàn bộ con cháu của worker.
  guard(selfPid, 'worker (chính tiến trình này)');
  for (const anc of collectAncestors(byPid, selfPid)) guard(anc.pid, `tổ tiên của worker (${anc.name})`);
  for (const pid of collectDescendants(procs, selfPid)) guard(pid, 'con cháu của worker (agent/job đang chạy)');

  // (2) Tiến trình đang giữ port lease còn hiệu lực.
  for (const pid of listenerPids) {
    const ports = listenerByPid.get(pid) || [];
    if (ports.some((port) => leasePorts.has(port))) {
      guard(pid, `đang giữ port lease ${ports.filter((p) => leasePorts.has(p)).join(',')}`);
      for (const d of collectDescendants(procs, pid)) guard(d, 'con của service đang giữ lease');
    }
  }

  // (3) Tiến trình nằm trong worktree của job CHƯA kết thúc.
  for (const p of procs) {
    const cmd = String(p.cmd || '');
    if (!cmd) continue;
    for (const job of activeJobs) {
      const wt = job.worktree_path;
      if (!wt) continue;
      if (cmdRefersToPath(cmd, wt)) {
        guard(p.pid, `thuộc worktree job đang chạy ${job.task_code}`);
        for (const d of collectDescendants(procs, p.pid)) guard(d, 'con của tiến trình trong worktree đang chạy');
      }
    }
  }

  // (4) Tên hệ thống / IDE / shell tương tác.
  for (const p of procs) {
    if (PROTECTED_NAMES.has(String(p.name || '').toLowerCase())) guard(p.pid, 'tiến trình hệ thống/IDE');
  }

  /** Tìm gốc của cây rác: đi lên tới khi gặp tiến trình được bảo vệ hoặc đã mất cha. */
  const treeRootOf = (pid) => {
    let root = Number(pid);
    let cur = byPid.get(root);
    for (let i = 0; i < 12; i += 1) {
      if (!cur) break;
      const parent = byPid.get(Number(cur.ppid));
      if (!parent) break;
      if (guarded.has(Number(parent.pid))) break;
      const pname = String(parent.name || '').toLowerCase();
      if (PROTECTED_NAMES.has(pname)) break;
      // Không leo qua tiến trình "vỏ" không liên quan tới dev server.
      if (!DEV_SERVER_RE.test(String(parent.cmd || '')) && !AGENT_RE.test(String(parent.cmd || ''))) break;
      root = Number(parent.pid);
      cur = parent;
    }
    return root;
  };

  /** @type {Map<number,{rootPid:number,pid:number,reason:string,port:number|null,name:string,ageMinutes:number,cmd:string}>} */
  const candidates = new Map();
  const addCandidate = (proc, reason, port) => {
    if (!proc) return;
    const rootPid = treeRootOf(proc.pid);
    if (guarded.has(rootPid) || guarded.has(Number(proc.pid))) return;
    if (candidates.has(rootPid)) return;
    candidates.set(rootPid, {
      rootPid,
      pid: Number(proc.pid),
      name: proc.name,
      reason,
      port: port || null,
      ageMinutes: Math.round((Number(proc.ageMs) || 0) / 60000),
      cmd: String(proc.cmd || '').slice(0, 400)
    });
  };

  // LUẬT A: service dev đang giữ port KHÔNG có lease và đã sống quá grace.
  // Nhận diện theo CẢ CÂY: java do mvn spawn có cmdline kiểu
  // `java -cp @argfile App --spring.profiles.active=dev` (không có -jar, không có
  // spring-boot:run) nên nếu chỉ soi cmdline của chính nó sẽ bỏ sót.
  const looksLikeDevServer = (proc) => {
    if (!proc) return false;
    if (DEV_SERVER_RE.test(String(proc.cmd || ''))) return true;
    return collectAncestors(byPid, proc.pid, 4).some((anc) => DEV_SERVER_RE.test(String(anc.cmd || '')));
  };
  for (const l of (listeners || [])) {
    const proc = byPid.get(Number(l.pid));
    if (!proc) continue;
    if (leasePorts.has(Number(l.port))) continue;
    if ((Number(proc.ageMs) || 0) < graceMs) continue;
    // Chỉ coi là rác khi: cổng nằm trong pool worker cấp phát, HOẶC tiến trình
    // nằm trong worktree do worker tạo. Tuyệt đối không đụng dev server người
    // dùng tự chạy ở repo chính hay thư mục khác.
    const inPool = poolPorts.has(Number(l.port));
    const inWorktree = knownWorktrees.some((wt) => cmdRefersToPath(proc.cmd, wt));
    if (!inPool && !inWorktree) continue;
    if (!inPool && !looksLikeDevServer(proc)) continue;
    addCandidate(
      proc,
      inPool
        ? `Cổng ${l.port} thuộc pool của worker nhưng bị chiếm mà KHÔNG có port lease`
        : `Service dev trong worktree bị bỏ hoang, chiếm cổng ${l.port} không lease`,
      Number(l.port)
    );
  }

  // LUẬT B: tiến trình nằm trong worktree của job ĐÃ kết thúc.
  for (const p of procs) {
    const cmd = String(p.cmd || '');
    if (!cmd) continue;
    if ((Number(p.ageMs) || 0) < graceMs) continue;
    for (const job of doneJobs) {
      const wt = job.worktree_path;
      if (!wt) continue;
      if (!cmdRefersToPath(cmd, wt)) continue;
      addCandidate(p, `Service còn sót trong worktree ${job.task_code} (job đã ${job.status})`, null);
      break;
    }
  }

  // LUẬT C: cây agent CLI bỏ hoang, đã idle lâu.
  // An toàn: chỉ kill khi (a) đủ tuổi, (b) đã có ÍT NHẤT 2 mẫu CPU (lần quét trước đó),
  // (c) CPU tiêu thụ giữa 2 lần quét = 0. Nhờ vậy phiên đang được dùng (kể cả chỉ
  // thỉnh thoảng gõ) sẽ không bị kill oan.
  if (allowIdleAgentTrees) {
    for (const p of procs) {
      const cmd = String(p.cmd || '');
      if (!cmd || !AGENT_RE.test(cmd)) continue;
      if ((Number(p.ageMs) || 0) < idleAgentMs) continue;
      if (p.cpuFirstSeen) continue; // chưa có mẫu trước => chưa kết luận idle
      if (Number(p.cpuDeltaSec || 0) > 0) continue; // đang tiêu CPU => đang được dùng
      addCandidate(p, `Cây agent CLI bỏ hoang (idle > ${Math.round(idleAgentMs / 3600000)}h, CPU 0 giữa 2 lần quét)`, null);
    }
  }

  const protectedList = Array.from(guarded.entries())
    .map(([pid, reason]) => ({ pid, name: (byPid.get(pid) || {}).name || '?', reason }))
    .sort((a, b) => a.pid - b.pid);

  return {
    candidates: Array.from(candidates.values()),
    protectedList,
    scanned: procs.length
  };
}

// ==========================================
// SNAPSHOT (Windows only)
// ==========================================
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$now = Get-Date
$procs = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    name = [string]$_.Name
    cmd = [string]$_.CommandLine
    ageMs = [int64](($now - $_.CreationDate).TotalMilliseconds)
  }
})
$cpuMap = @{}
Get-Process | ForEach-Object {
  if ($null -ne $_.CPU) { $cpuMap[[string]$_.Id] = [double]$_.CPU }
}
$lis = @(Get-NetTCPConnection -State Listen | ForEach-Object {
  [pscustomobject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess }
})
[pscustomobject]@{ procs = $procs; cpu = $cpuMap; listeners = $lis } | ConvertTo-Json -Depth 4 -Compress
`;

function runPowerShell(script, timeoutMs = 25000) {
  const exe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8'
  });
  return out;
}

/** Chụp ảnh tiến trình + cổng đang listen. */
function snapshot() {
  if (process.platform !== 'win32') {
    return { procs: [], listeners: [], cpu: {}, supported: false };
  }
  const raw = runPowerShell(PS_SCRIPT);
  const parsed = JSON.parse(raw);
  const procs = (parsed.procs || []).map((p) => ({
    pid: Number(p.pid),
    ppid: Number(p.ppid),
    name: String(p.name || ''),
    cmd: String(p.cmd || ''),
    ageMs: Number(p.ageMs) || 0
  }));
  const cpu = parsed.cpu || {};
  for (const p of procs) p.cpu = Number(cpu[String(p.pid)] || 0);
  const listeners = (parsed.listeners || []).map((l) => ({ port: Number(l.port), pid: Number(l.pid) }));
  return { procs, listeners, cpu, supported: true };
}

/**
 * So sánh CPU giữa 2 lần quét để biết tiến trình có ĐANG được dùng hay không.
 * Đây là điều kiện an toàn của LUẬT C: chỉ kill cây agent khi CPU = 0 giữa 2 lần
 * quét liên tiếp (và đã có ít nhất 1 mẫu trước đó).
 * @param {Array} procs
 */
let lastCpuSample = new Map();
function annotateCpuDeltas(procs) {
  const next = new Map();
  for (const p of procs) {
    const pid = Number(p.pid);
    const cpu = Number(p.cpu) || 0;
    if (lastCpuSample.has(pid)) {
      p.cpuDeltaSec = Math.max(0, cpu - lastCpuSample.get(pid));
      p.cpuFirstSeen = false;
    } else {
      p.cpuDeltaSec = 0;
      p.cpuFirstSeen = true; // chưa có mẫu trước => chưa được kết luận là idle
    }
    next.set(pid, cpu);
  }
  lastCpuSample = next;
  return procs;
}

/** Kill cả cây tiến trình (Windows) hoặc 1 tiến trình (POSIX). */function killTree(pid) {
  if (!Number.isFinite(Number(pid)) || Number(pid) <= 4) {
    return { ok: false, error: 'PID không hợp lệ' };
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 15000, windowsHide: true, stdio: 'ignore'
      });
    } else {
      process.kill(Number(pid), 'SIGKILL');
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ==========================================
// RUN
// ==========================================
let running = false;

/** Nạp dữ liệu job/worktree/lease từ DB. */
function loadDbState() {
  const raw = db.getDb();
  // Bảng `port_leases` do portLeaseManager tạo lazy, có thể chưa tồn tại trong
  // DB mới => không được để janitor chết vì thiếu bảng.
  let jobs = [];
  try {
    jobs = raw.prepare(`
      SELECT id, task_code, status, worktree_path FROM jobs
      WHERE COALESCE(status, '') <> 'ARCHIVED'
    `).all().map((j) => ({ ...j }));
  } catch (e) {
    jobs = [];
  }

  // Bổ sung worktree của các service (job_worktrees) cho job đã xong.
  try {
    const wts = raw.prepare('SELECT job_id, service_key, worktree_path, status FROM job_worktrees').all();
    for (const w of wts) {
      if (!w.worktree_path) continue;
      const job = jobs.find((j) => j.id === w.job_id);
      if (!job) continue;
      if (!job.worktree_path) job.worktree_path = w.worktree_path;
      if (!job.extra_worktrees) job.extra_worktrees = [];
      job.extra_worktrees.push(w.worktree_path);
    }
    // Mở rộng danh sách: mỗi worktree thành 1 dòng ảo để luật so khớp đường dẫn chạy được.
    for (const job of jobs.slice()) {
      for (const extra of (job.extra_worktrees || [])) {
        if (normalizePath(extra) === normalizePath(job.worktree_path || '')) continue;
        jobs.push({ ...job, worktree_path: extra, _virtual: true });
      }
    }
  } catch (e) {}

  let leases = [];
  try {
    leases = raw.prepare('SELECT service_key, port, job_id FROM port_leases').all().map((l) => ({ ...l }));
  } catch (e) {
    leases = [];
  }
  return { jobs, leases };
}

/**
 * Chạy 1 lần dọn dẹp.
 * @param {{trigger?:string, dryRun?:boolean}} [options]
 * @returns {Promise<object>} report
 */
async function runJanitor(options = {}) {
  const trigger = options.trigger || 'manual';
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : Boolean(config.JANITOR_DRY_RUN);
  const startedAt = new Date();
  const startedMs = Date.now();
  const log = [];
  const push = (line) => log.push(`[${new Date().toISOString()}] ${line}`);

  const runId = crypto.randomUUID();
  const base = {
    id: runId,
    started_at: startedAt.toISOString(),
    trigger,
    dry_run: dryRun,
    scanned: 0,
    killed: 0,
    protected_count: 0,
    freed_ports: [],
    killed_list: [],
    protected_list: [],
    errors: []
  };

  push(`[START] janitor run ${runId} (trigger=${trigger}${dryRun ? ', DRY-RUN' : ''})`);

  let before = { procs: [], listeners: [], supported: true };
  try {
    before = snapshot();
  } catch (err) {
    push(`[ERROR] Không chụp được danh sách tiến trình: ${err.message}`);
    base.errors.push(err.message);
    base.finished_at = new Date().toISOString();
    base.duration_ms = Date.now() - startedMs;
    base.log = log;
    return base;
  }
  if (!before.supported) {
    push('[SKIP] Nền tảng không hỗ trợ (chỉ hỗ trợ Windows).');
    base.finished_at = new Date().toISOString();
    base.duration_ms = Date.now() - startedMs;
    base.log = log;
    return base;
  }

  const state = loadDbState();
  // Tính CPU tiêu thụ so với lần quét trước (điều kiện an toàn của LUẬT C).
  annotateCpuDeltas(before.procs);
  const verdict = analyze({
    procs: before.procs,
    listeners: before.listeners,
    leases: state.leases,
    jobs: state.jobs,
    selfPid: process.pid,
    opts: options.opts || {}
  });

  base.scanned = verdict.scanned;
  // Tách "bảo vệ liên quan" (worker, agent đang chạy, service giữ lease, worktree
  // đang dùng) khỏi "tiến trình hệ thống/IDE" — nếu gộp, màn hình sẽ đầy svchost.exe
  // và không còn giá trị đọc.
  const relevantProtected = verdict.protectedList.filter(
    (p) => !/hệ thống\/IDE/i.test(p.reason) && !REPORT_HIDDEN_NAMES.has(String(p.name || '').toLowerCase())
  );
  const systemProtected = verdict.protectedList.length - relevantProtected.length;
  base.protected_count = relevantProtected.length;
  base.protected_system_count = systemProtected;
  base.protected_list = relevantProtected.slice(0, 60);
  push(`[SCAN] ${verdict.scanned} tiến trình, ${before.listeners.length} cổng đang listen, ${state.leases.length} lease hiệu lực.`);
  push(`[SCAN] Bảo vệ ${relevantProtected.length} tiến trình liên quan + ${systemProtected} tiến trình hệ thống, phát hiện ${verdict.candidates.length} ứng viên rác.`);

  const freedBefore = new Set(before.listeners.map((l) => Number(l.port)));

  if (!verdict.candidates.length) {
    push('[DONE] Không có tiến trình rác.');
  }

  for (const cand of verdict.candidates) {
    if (dryRun) {
      push(`[WOULD-KILL] pid=${cand.rootPid} (${cand.name}) — ${cand.reason}`);
      base.killed_list.push({ ...cand, killed: false, dry_run: true });
      continue;
    }
    const res = killTree(cand.rootPid);
    if (res.ok) {
      base.killed += 1;
      push(`[KILL] pid=${cand.rootPid} (${cand.name}, age=${cand.ageMinutes}m) — ${cand.reason}`);
      base.killed_list.push({ ...cand, killed: true });
    } else {
      push(`[FAIL] pid=${cand.rootPid} (${cand.name}) — ${cand.reason} :: ${res.error}`);
      base.errors.push(`pid ${cand.rootPid}: ${res.error}`);
      base.killed_list.push({ ...cand, killed: false, error: res.error });
    }
  }

  // Đo lại cổng sau khi kill để báo cáo đã giải phóng được gì.
  if (!dryRun && base.killed > 0) {
    await new Promise((r) => setTimeout(r, 800));
    try {
      const after = snapshot();
      const freed = [];
      for (const port of freedBefore) {
        if (port >= 1024 && !after.listeners.some((l) => Number(l.port) === port)) freed.push(port);
      }
      base.freed_ports = freed.sort((a, b) => a - b);
      if (freed.length) push(`[FREE] Cổng đã giải phóng: ${base.freed_ports.join(', ')}`);
    } catch (err) {
      push(`[WARN] Không đo lại được cổng: ${err.message}`);
    }
  }

  base.finished_at = new Date().toISOString();
  base.duration_ms = Date.now() - startedMs;
  push(`[END] killed=${base.killed}/${verdict.candidates.length}, freed_ports=[${base.freed_ports.join(',')}], ${base.duration_ms}ms`);
  base.log = log;
  return base;
}

/** Chạy + lưu lịch sử vào DB (dùng cho cả vòng tự động và nút "Chạy ngay"). */
async function runAndPersist(options = {}) {
  if (running) {
    return { ok: false, skipped: true, reason: 'Lần dọn trước chưa kết thúc.' };
  }
  running = true;
  const startedMs = Date.now();
  const id = crypto.randomUUID();
  try {
    db.createJanitorRun({ id, started_at: new Date().toISOString(), trigger: options.trigger || 'manual' });
  } catch (e) {
    running = false;
    return { ok: false, error: `Không tạo được bản ghi janitor: ${e.message}` };
  }
  try {
    const report = await runJanitor({ ...options, id });
    report.id = id;
    const persist = db.finishJanitorRun(id, {
      finished_at: report.finished_at,
      duration_ms: report.duration_ms || (Date.now() - startedMs),
      scanned: report.scanned,
      killed: report.killed,
      protected_count: report.protected_count,
      freed_ports: report.freed_ports,
      report,
      log: report.log
    });
    try { db.pruneJanitorRuns(200); } catch (e) {}
    return { ok: true, report, record: persist };
  } catch (err) {
    try {
      db.finishJanitorRun(id, {
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - startedMs,
        report: { error: err.message },
        log: [`[ERROR] ${err.message}`]
      });
    } catch (e) {}
    return { ok: false, error: err.message };
  } finally {
    running = false;
  }
}

// ==========================================
// AUTO LOOP
// ==========================================
let loopTimer = null;
let nextRunAt = null;

function getStatus() {
  const last = (() => {
    try { return db.listJanitorRuns(1)[0] || null; } catch (e) { return null; }
  })();
  return {
    enabled: Boolean(config.JANITOR_ENABLED),
    interval_ms: config.JANITOR_INTERVAL_MS,
    next_run_at: nextRunAt ? new Date(nextRunAt).toISOString() : null,
    running,
    dry_run: Boolean(config.JANITOR_DRY_RUN),
    config: {
      grace_minutes: config.JANITOR_GRACE_MINUTES,
      idle_agent_trees: Boolean(config.JANITOR_IDLE_AGENT_TREES),
      idle_agent_hours: config.JANITOR_IDLE_AGENT_HOURS
    },
    last_run: last
      ? {
        id: last.id,
        started_at: last.started_at,
        finished_at: last.finished_at,
        trigger: last.trigger,
        duration_ms: last.duration_ms,
        scanned: last.scanned,
        killed: last.killed,
        freed_ports: last.freed_ports || []
      }
      : null
  };
}

/** Vòng tự động: chạy ngay 1 lần sau khi boot (trễ 30s) rồi mỗi `JANITOR_INTERVAL_MS`. */
function startJanitorLoop() {
  if (loopTimer) return loopTimer;
  if (!config.JANITOR_ENABLED) {
    console.log('[JANITOR] Tắt theo cấu hình (JANITOR_ENABLED=false).');
    return null;
  }
  const firstDelayMs = 30000;
  nextRunAt = Date.now() + firstDelayMs;

  const tick = async () => {
    try {
      const r = await runAndPersist({ trigger: 'auto' });
      if (r.ok) {
        const rep = r.report || {};
        console.log(`[JANITOR] killed=${rep.killed || 0} freed=[${(rep.freed_ports || []).join(',')}] in ${rep.duration_ms || 0}ms`);
      } else if (!r.skipped) {
        console.warn('[JANITOR] Lỗi:', r.error || r.reason);
      }
    } catch (err) {
      console.warn('[JANITOR] Lỗi vòng dọn dẹp:', err.message);
    }
    nextRunAt = Date.now() + config.JANITOR_INTERVAL_MS;
  };

  const timeout = setTimeout(async () => {
    await tick();
    loopTimer = setInterval(tick, config.JANITOR_INTERVAL_MS);
    if (loopTimer.unref) loopTimer.unref();
  }, firstDelayMs);
  if (timeout.unref) timeout.unref();
  loopTimer = timeout;
  console.log(`[JANITOR] Bật: quét mỗi ${Math.round(config.JANITOR_INTERVAL_MS / 60000)} phút.`);
  return loopTimer;
}

module.exports = {
  runJanitor,
  runAndPersist,
  startJanitorLoop,
  getStatus,
  snapshot,
  analyze,
  killTree,
  collectDescendants,
  collectAncestors,
  isInsidePath,
  cmdRefersToPath,
  normalizePath,
  PROTECTED_NAMES,
  DEV_SERVER_RE,
  AGENT_RE,
  TERMINAL_JOB_STATUSES
};
