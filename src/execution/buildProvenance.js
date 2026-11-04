/**
 * src/execution/buildProvenance.js
 * Chứng minh service đang chạy đúng bản build của WORKTREE hiện tại.
 *
 * VẤN ĐỀ: worker cấp port + dặn agent "phải restart", nhưng không có cách nào
 * biết agent thật sự build lại hay chỉ trỏ vào một instance cũ. Hậu quả: ảnh
 * evidence/API test được chụp trên bản build cũ → PASS sai.
 *
 * CƠ CHẾ (3 lớp, không cần sửa app đích):
 *  1. `computeWorktreeHash()` — hash trạng thái nguồn: HEAD + git status + git diff
 *     + lockfile. Đổi 1 dòng code là hash đổi.
 *  2. `writeBuildMarker()` — worker ghi file marker chứa hash vào thư mục static
 *     của worktree (`public/` cho FE, `src/main/resources/static/` cho BE).
 *     Marker nằm trong đầu vào build ⇒ muốn phục vụ được marker MỚI thì buộc
 *     phải build lại.
 *  3. `checkRuntimeProvenance()` — sau khi agent chạy xong: gọi
 *     `GET /__aiworker_build.json` trên từng port, so hash; đồng thời kiểm tra
 *     process đang listen port được sinh ra SAU khi bước bắt đầu (không phải
 *     instance cũ còn sót).
 *
 * Nếu marker tồn tại trên đĩa mà service trả 404 ⇒ chưa rebuild ⇒ FAIL.
 * Nếu app không phục vụ được static (không detect được thư mục) ⇒ fallback
 * kiểm tra process-start-time và ghi cảnh báo (không chặn oan).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync, execSync } = require('node:child_process');

const MARKER_NAME = '__aiworker_build.json';
const MARKER_ROUTE = `/${MARKER_NAME}`;
// Cho phép lệch giờ giữa lúc bắt đầu bước và lúc process được tạo.
const PROCESS_START_SKEW_MS = 2 * 60 * 1000;
const HTTP_TIMEOUT_MS = 2500;

function safeGit(worktreePath, args) {
  try {
    return execSync(`git ${args}`, { cwd: worktreePath, stdio: 'pipe', encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return '';
  }
}

/**
 * Hash trạng thái nguồn của worktree.
 * Gồm: HEAD, danh sách file thay đổi, diff nội dung, và hash các lockfile.
 * @param {object} job
 * @returns {{hash:string, commit:string, dirty:boolean, lockfiles:string[]}}
 */
function computeWorktreeHash(job) {
  const wt = job && (job.worktree_path || job.repo_path);
  if (!wt || !fs.existsSync(wt)) {
    return { hash: '', commit: '', dirty: false, lockfiles: [] };
  }
  const commit = safeGit(wt, 'rev-parse HEAD');
  const status = safeGit(wt, 'status --porcelain');
  const diff = safeGit(wt, 'diff');
  const lockNames = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pom.xml', 'build.gradle', 'requirements.txt', 'go.sum'];
  const lockHashes = [];
  for (const name of lockNames) {
    const full = path.join(wt, name);
    if (fs.existsSync(full)) {
      try {
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16);
        lockHashes.push(`${name}:${h}`);
      } catch (e) {}
    }
  }
  const payload = [commit, status, diff, lockHashes.join(',')].join('\n---\n');
  const hash = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  return { hash, commit, dirty: Boolean(status), lockfiles: lockHashes.map((l) => l.split(':')[0]) };
}

/**
 * Thư mục static có thể phục vụ marker trong worktree.
 *
 * Danh sách TỔNG QUÁT theo quy ước phổ biến của các stack (không gắn với 1 dự án):
 * Vite/Angular/React (`public`), Next/Nuxt (`public`), Spring Boot
 * (`src/main/resources/static|public|META-INF/resources`), ASP.NET (`wwwroot`),
 * Django (`static`/`staticfiles`), Laravel/PHP (`public`), Rails (`public`),
 * monorepo FE (`client|frontend|web|admin/public`).
 */
function detectStaticDirs(job) {
  const wt = job && (job.worktree_path || job.repo_path);
  if (!wt || !fs.existsSync(wt)) return [];
  const candidates = [
    // Node/FE phổ biến (Vite, React, Angular, Next, Nuxt, Vue, Svelte...)
    path.join(wt, 'public'),
    path.join(wt, 'static'),
    path.join(wt, 'app', 'static'),
    path.join(wt, 'staticfiles'),           // Django collectstatic
    // Monorepo: FE nằm trong thư mục con
    path.join(wt, 'client', 'public'),
    path.join(wt, 'frontend', 'public'),
    path.join(wt, 'web', 'public'),
    path.join(wt, 'admin', 'public'),
    path.join(wt, 'ClientApp', 'public'),
    // Java / Spring Boot
    path.join(wt, 'src', 'main', 'resources', 'static'),
    path.join(wt, 'src', 'main', 'resources', 'public'),
    path.join(wt, 'src', 'main', 'resources', 'META-INF', 'resources'),
    // .NET
    path.join(wt, 'wwwroot')
  ];
  return candidates.filter((dir) => {
    try { return fs.existsSync(dir) && fs.statSync(dir).isDirectory(); } catch (e) { return false; }
  });
}

/**
 * Thêm marker vào `.git/info/exclude` của worktree để file kỹ thuật này
 * KHÔNG bị commit/merge vào nhánh chính.
 * - Worktree bình thường: `.git` là thư mục.
 * - Worktree của `git worktree add`: `.git` là file chứa `gitdir: <path>`.
 */
function ensureMarkerIgnored(job) {
  const wt = job && (job.worktree_path || job.repo_path);
  if (!wt) return false;
  try {
    const dotGit = path.join(wt, '.git');
    if (!fs.existsSync(dotGit)) return false;
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const raw = fs.readFileSync(dotGit, 'utf8');
      const m = raw.match(/^gitdir:\s*(.+)$/im);
      if (!m) return false;
      gitDir = path.resolve(wt, m[1].trim());
    }
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    if (!current.split(/\r?\n/).some((line) => line.trim() === MARKER_NAME)) {
      fs.appendFileSync(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}${MARKER_NAME}\n`, 'utf8');
    }
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Ghi marker build vào worktree (trước khi agent build).
 * @returns {{written:boolean, files:string[], hash:string, reason?:string}}
 */
function writeBuildMarker(job, ports = {}, hashOverride = null) {
  const wtHash = hashOverride || computeWorktreeHash(job).hash;
  if (!wtHash) return { written: false, files: [], hash: '', reason: 'NO_WORKTREE' };
  const dirs = detectStaticDirs(job);
  if (!dirs.length) return { written: false, files: [], hash: wtHash, reason: 'NO_STATIC_DIR' };
  const payload = {
    build_hash: wtHash,
    task_code: (job && job.task_code) || null,
    job_id: (job && job.id) || null,
    ports: ports || {},
    written_at: new Date().toISOString()
  };
  const files = [];
  for (const dir of dirs) {
    try {
      const target = path.join(dir, MARKER_NAME);
      fs.writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
      files.push(target);
    } catch (e) {}
  }
  if (files.length > 0) ensureMarkerIgnored(job);
  return { written: files.length > 0, files, hash: wtHash, reason: files.length ? null : 'WRITE_FAILED' };
}

/** GET JSON từ port local (dùng http để không phụ thuộc thư viện). */
function httpGetJson(port, route, timeoutMs = HTTP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode, body });
        try { resolve({ ok: true, status: 200, json: JSON.parse(body), body }); }
        catch (e) { resolve({ ok: false, status: 200, error: 'INVALID_JSON', body }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'TIMEOUT' }); });
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.code || err.message }));
  });
}

/**
 * Lấy PID đang listen port + thời điểm process được tạo (ms).
 * @returns {{pid:number|null, startedAtMs:number|null}}
 */
function getPortOwnerInfo(port) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen | Select-Object -First 1`,
    'if (-not $c) { Write-Output "NONE"; exit 0 }',
    '$p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue',
    'if (-not $p) { Write-Output "NONE"; exit 0 }',
    "$start = [int64](($p.StartTime.ToUniversalTime().ToFileTimeUtc() / 10000) - 11644473600000)",
    'Write-Output ("{0}|{1}" -f $p.Id, $start)'
  ].join('\n');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 15000
    }).trim();
    if (!out || out === 'NONE') return { pid: null, startedAtMs: null };
    const [pidRaw, startRaw] = out.split('|');
    return { pid: Number(pidRaw) || null, startedAtMs: Number(startRaw) || null };
  } catch (e) {
    return { pid: null, startedAtMs: null };
  }
}

/**
 * Kiểm tra service trên các port có đúng build của worktree không.
 *
 * @param {object} params
 * @param {object} params.job
 * @param {object} params.ports map serviceKey -> port
 * @param {number} params.stepStartedAt ms
 * @param {string} params.expectedHash
 * @param {boolean} [params.markerWritten] worker đã ghi marker vào static dir chưa
 * @returns {Promise<{ok:boolean, mode:string, services:Array<object>, reason?:string}>}
 */
async function checkRuntimeProvenance({ job, ports, stepStartedAt, expectedHash, markerWritten = false }) {
  const services = [];
  let ok = true;
  let mode = markerWritten ? 'marker' : 'process-start';
  // Process-start check dùng PowerShell/taskkill — chỉ có trên Windows.
  // Trên nền tảng khác, bỏ qua check này thay vì báo NO_LISTENER sai.
  const canCheckProcess = process.platform === 'win32';

  for (const [serviceKey, portRaw] of Object.entries(ports || {})) {
    const port = Number(portRaw);
    const info = canCheckProcess ? getPortOwnerInfo(port) : { pid: null, startedAtMs: null };
    const item = {
      serviceKey,
      port,
      pid: info.pid,
      processStartedAt: info.startedAtMs ? new Date(info.startedAtMs).toISOString() : null,
      restartedInThisStep: null,
      servedHash: null,
      hashMatched: null,
      httpStatus: null,
      ok: true,
      problems: []
    };

    if (!canCheckProcess) {
      // Không xác định được PID: chỉ dựa vào marker hash.
      mode = markerWritten ? 'marker' : 'unsupported';
    } else if (!info.pid) {
      item.ok = false;
      item.problems.push('NO_LISTENER');
    } else {
      const skewOk = !stepStartedAt || !info.startedAtMs || (info.startedAtMs >= stepStartedAt - PROCESS_START_SKEW_MS);
      item.restartedInThisStep = Boolean(skewOk);
      if (!skewOk) {
        item.ok = false;
        item.problems.push('REUSED_OLD_PROCESS');
      }
    }

    if (canCheckProcess ? info.pid : true) {
      // eslint-disable-next-line no-await-in-loop
      const marker = await httpGetJson(port, MARKER_ROUTE);
      item.httpStatus = marker.status;
      if (marker.ok && marker.json) {
        item.servedHash = marker.json.build_hash || null;
        item.hashMatched = Boolean(expectedHash) && item.servedHash === expectedHash;
        if (!item.hashMatched) {
          item.ok = false;
          item.problems.push('BUILD_HASH_MISMATCH');
        }
      } else if (markerWritten) {
        // Worker đã ghi marker vào static dir: nếu service không trả marker mới
        // nghĩa là chưa build lại (hoặc build cũ) => không được coi là đã test.
        item.ok = false;
        item.problems.push(marker.status === 404 ? 'MARKER_NOT_SERVED_NOT_REBUILT' : 'MARKER_UNREACHABLE');
      } else if (marker.status === 0) {
        item.ok = false;
        item.problems.push('HTTP_UNREACHABLE');
      } else {
        // Không ghi được marker (app không có static dir) => chỉ dựa vào
        // process-start-time, ghi cảnh báo để không chặn oan.
        mode = canCheckProcess ? 'process-start' : 'unsupported';
      }
    }

    ok = ok && item.ok;
    services.push(item);
  }

  const reason = ok ? null : services
    .filter((s) => !s.ok)
    .map((s) => `${s.serviceKey}:${s.port}[${s.problems.join('+')}]`)
    .join(', ');

  return { ok, mode, services, reason };
}

module.exports = {
  computeWorktreeHash,
  writeBuildMarker,
  ensureMarkerIgnored,
  checkRuntimeProvenance,
  detectStaticDirs,
  getPortOwnerInfo,
  MARKER_NAME,
  MARKER_ROUTE,
  PROCESS_START_SKEW_MS
};
