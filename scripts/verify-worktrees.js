#!/usr/bin/env node
/**
 * verify-worktrees.js — Đối soát worktree: DB ↔ thư mục đĩa ↔ git worktree list.
 *
 * Bắt các trường hợp miss:
 *   W1. Job đang chạy (IMPLEMENT/TESTING/VERIFY/FIXING/MERGING) nhưng KHÔNG có worktree ACTIVE.
 *   W2. Job đã kết thúc (DONE/FAILED/CANCELLED/TIMED_OUT) nhưng còn worktree ACTIVE (miss cleanup).
 *   W3. Worktree ACTIVE nhưng thư mục không tồn tại trên đĩa (hoặc ngược lại: thư mục còn nhưng DB không có).
 *   W4. Worktree MERGED/CANCELLED nhưng thư mục vẫn còn trên đĩa (rò rỉ dung lượng).
 *   W5. git worktree list của repo gốc còn đăng ký thư mục đã biến mất.
 *   W6. File .task-manifest.json thiếu trong thư mục worktree ACTIVE.
 *
 * Dùng:  node scripts/verify-worktrees.js            (chỉ đọc, exit 1 nếu có lỗi)
 *        node scripts/verify-worktrees.js --fix      (dọn các worktree rác qua worktreeManager)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'ai-worker.sqlite');
const worktreeManager = require(path.join(ROOT, 'src', 'utils', 'worktreeManager.js'));
const { extractTargetServicesFromDevPlan } = require(path.join(ROOT, 'src', 'utils', 'devPlanServiceExtract.js'));

const FIX = process.argv.includes('--fix');
const ACTIVE_JOB_STATUSES = new Set(['IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'MERGING']);
const TERMINAL_JOB_STATUSES = new Set(['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

const issues = [];
const add = (code, msg, ctx = {}) => issues.push({ code, msg, ...ctx });

function openDb() {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(DB_PATH, { readOnly: !FIX });
}

function repoOf(serviceKey, wsPath, svcConfig) {
  if (svcConfig && svcConfig.repo_path) {
    return path.isAbsolute(svcConfig.repo_path)
      ? svcConfig.repo_path
      : path.resolve(wsPath || '.', svcConfig.repo_path);
  }
  return wsPath ? path.resolve(wsPath, serviceKey) : null;
}

function gitWorktreeList(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return [];
  try {
    const out = execSync('git worktree list --porcelain', {
      cwd: repoPath, stdio: 'pipe', encoding: 'utf-8' });
    return out.split('\n\n').map((blk) => {
      const line = blk.split('\n').find((l) => l.startsWith('worktree '));
      return line ? line.slice('worktree '.length).trim() : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`Không thấy DB: ${DB_PATH}`);
    process.exit(2);
  }

  const db = openDb();
  const jobs = db.prepare('SELECT * FROM jobs').all();
  const wts = db.prepare('SELECT * FROM job_worktrees').all();
  const workspaces = db.prepare('SELECT * FROM workspaces').all();
  const services = db.prepare('SELECT * FROM workspace_services').all();

  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const svcByKey = new Map();
  for (const s of services) svcByKey.set(`${s.workspace_id}::${s.service_key}`, s);

  const wtsByJob = new Map();
  for (const w of wts) {
    if (!wtsByJob.has(w.job_id)) wtsByJob.set(w.job_id, []);
    wtsByJob.get(w.job_id).push(w);
  }

  // W1 / W2 — tương quan job status ↔ worktree ACTIVE
  // W1 chỉ báo khi job LẼ RA phải có worktree. Ba nguồn xác định:
  //   1. job.worktree_path có giá trị
  //   2. pipeline_config.target_services không rỗng
  //   3. dev_plan.md nêu service mục tiêu (dùng chung extractor với server.js)
  // Job không xác định được service mục tiêu thì chạy tiếp trong workspace là hợp lệ.
  for (const job of jobs) {
    const list = wtsByJob.get(job.id) || [];
    const active = list.filter((w) => w.status === 'ACTIVE');
    let expectsWorktree = false;
    if (job.worktree_path) expectsWorktree = true;
    else {
      try {
        const pipe = job.pipeline_config ? JSON.parse(job.pipeline_config) : null;
        if (pipe && Array.isArray(pipe.target_services) && pipe.target_services.length > 0) {
          expectsWorktree = true;
        }
      } catch {}
    }
    if (!expectsWorktree && job.task_code) {
      const ws = job.workspace_id ? wsById.get(job.workspace_id) : null;
      const svcs = ws ? services.filter((s) => s.workspace_id === ws.id) : [];
      if (svcs.length > 0) {
        try {
          const { defaultFileManager: fileManager } = require(path.join(ROOT, 'src', 'storage', 'fileManager.js'));
          const planFiles = fileManager.readPlanFiles(job.repo_path || (ws && ws.path), job.task_code);
          const devPlanText = (planFiles && planFiles.devPlan) || '';
          if (devPlanText) {
            const targets = extractTargetServicesFromDevPlan(devPlanText, svcs, `${job.title || ''} ${job.prompt || ''} ${job.task_code}`);
            if (targets.length > 0) expectsWorktree = true;
          }
        } catch {}
      }
    }
    if (ACTIVE_JOB_STATUSES.has(job.status) && active.length === 0 && expectsWorktree) {
      add('W1', `Job ${job.task_code || job.id} đang '${job.status}' nhưng không có worktree ACTIVE`, {
        jobId: job.id, taskCode: job.task_code
      });
    }
    if (TERMINAL_JOB_STATUSES.has(job.status) && active.length > 0) {
      for (const w of active) {
        add('W2', `Job ${job.task_code || job.id} đã '${job.status}' nhưng worktree '${w.service_key}' còn ACTIVE`, {
          jobId: job.id, taskCode: job.task_code, worktreeId: w.id, worktreePath: w.worktree_path
        });
      }
    }
  }

  // W3 / W4 — đối soát với đĩa
  for (const w of wts) {
    const exists = w.worktree_path && fs.existsSync(w.worktree_path);
    if (w.status === 'ACTIVE' && !exists) {
      add('W3', `Worktree ACTIVE nhưng thư mục không tồn tại: ${w.worktree_path}`, {
        worktreeId: w.id, jobId: w.job_id, serviceKey: w.service_key
      });
      continue;
    }
    if (w.status === 'ACTIVE' && exists) {
      const manifest = path.join(w.worktree_path, '.task-manifest.json');
      if (!fs.existsSync(manifest)) {
        add('W6', `Worktree ACTIVE thiếu .task-manifest.json: ${w.worktree_path}`, {
          worktreeId: w.id, jobId: w.job_id
        });
      }
    }
    if ((w.status === 'MERGED' || w.status === 'CANCELLED') && exists) {
      add('W4', `Worktree '${w.status}' nhưng thư mục vẫn còn: ${w.worktree_path}`, {
        worktreeId: w.id, jobId: w.job_id, serviceKey: w.service_key, worktreePath: w.worktree_path
      });
    }
  }

  // W3b — thư mục .worktrees/* còn trên đĩa nhưng DB không có record
  const dbPaths = new Set(wts.map((w) => path.resolve(w.worktree_path || '')));
  for (const ws of workspaces) {
    if (!ws.path || !fs.existsSync(ws.path)) continue;
    for (const s of services.filter((x) => x.workspace_id === ws.id)) {
      const repo = repoOf(s.service_key, ws.path, s);
      const wtRoot = repo ? path.join(repo, '.worktrees') : null;
      if (!wtRoot || !fs.existsSync(wtRoot)) continue;
      for (const entry of fs.readdirSync(wtRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.')) continue; // bỏ qua .trash, .DS_Store...
        const p = path.resolve(path.join(wtRoot, entry.name));
        if (!dbPaths.has(p)) {
          // Thư mục có .git là worktree hợp lệ do Agent tự tạo trong job, không phải worker tạo hỏng.
          const isGitWt = fs.existsSync(path.join(p, '.git'));
          const note = isGitWt ? ' (worktree hợp lệ do Agent tự tạo, không qua worker)' : ' (thư mục rác không phải worktree)';
          add('W3', `Thư mục .worktrees trên đĩa không có trong DB: ${p}${note}`, { worktreePath: p, agentCreated: isGitWt });
        }
      }
    }
  }

  // W5 — git worktree list còn đăng ký thư mục đã mất
  const seenRepos = new Set();
  for (const w of wts) {
    const job = jobs.find((j) => j.id === w.job_id);
    const ws = job ? wsById.get(job.workspace_id) : null;
    const svc = ws ? svcByKey.get(`${ws.id}::${w.service_key}`) : null;
    const repo = repoOf(w.service_key, ws ? ws.path : (job ? job.repo_path : null), svc);
    if (!repo || seenRepos.has(repo)) continue;
    seenRepos.add(repo);
    for (const listed of gitWorktreeList(repo)) {
      const norm = path.resolve(listed);
      if (norm.includes(`${path.sep}.worktrees${path.sep}`) && !fs.existsSync(norm)) {
        add('W5', `git worktree list còn đăng ký thư mục đã mất: ${norm}`, { repo, worktreePath: norm });
      }
    }
  }

  // Báo cáo
  if (issues.length === 0) {
    console.log('✅ Worktree nhất quán: DB ↔ đĩa ↔ git. Không phát hiện miss.');
    db.close();
    process.exit(0);
  }

  const byCode = issues.reduce((acc, it) => {
    (acc[it.code] = acc[it.code] || []).push(it);
    return acc;
  }, {});
  console.log(`❌ Phát hiện ${issues.length} vấn đề worktree:\n`);
  for (const [code, list] of Object.entries(byCode)) {
    console.log(`[${code}] ${list.length} mục`);
    for (const it of list) console.log(`   - ${it.msg}`);
    console.log('');
  }

  if (FIX) {
    console.log('🔧 --fix: dọn worktree rác qua worktreeManager (Recycle Bin, không xóa cứng)...');
    let fixed = 0;
    for (const it of issues) {
      if ((it.code !== 'W2' && it.code !== 'W4') || !it.worktreePath) continue;
      // Suy repo từ chính worktree_path: <repo>/.worktrees/<task> => repo = dirname(dirname(path))
      // Không dùng serviceKey vì worktree_path có thể nằm ở repo khác record DB (đã gặp PHUB-673/675).
      const resolvedWt = path.resolve(it.worktreePath);
      const repo = path.dirname(path.dirname(resolvedWt));
      try {
        const removed = worktreeManager.removeTaskWorktree(repo, it.worktreePath);
        if (!removed || fs.existsSync(it.worktreePath)) {
          console.log(`   ✖ còn kẹt, chưa dọn được: ${it.worktreePath}`);
          // Thư mục còn kẹt dù đã thử Trash => có process đang giữ handle (Windows không
          // cho rename/delete thư mục đang là CWD của process khác). Liệt kê PID để xử lý tay.
          try {
            const taskTag = path.basename(resolvedWt);
            const cmd = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${taskTag}' -and $_.Name -notmatch '^(cmd|powershell|conhost)\\.exe$' } | ForEach-Object { $_.ProcessId.ToString() + '  ' + $_.Name + '  ' + ($_.CommandLine -replace '\\s+',' ').Substring(0,[Math]::Min(120,$_.CommandLine.Length)) }`;
            const holders = execSync(`powershell -NoProfile -Command "${cmd}"`, {
              stdio: 'pipe', encoding: 'utf-8', timeout: 20000
            }).trim();
            if (holders) {
              console.log('     process có thể đang giữ handle (kill rồi chạy lại --fix):');
              for (const line of holders.split('\n')) console.log(`       ${line.trim()}`);
            } else {
              console.log(`     không thấy process giữ handle; chạy restart-worker.bat rồi --fix lại.`);
            }
          } catch {}
          continue;
        }
        if (it.worktreeId) {
          db.prepare("UPDATE job_worktrees SET status = 'CANCELLED', updated_at = ? WHERE id = ?")
            .run(new Date().toISOString(), it.worktreeId);
        }
        fixed += 1;
        console.log(`   ✔ dọn ${it.worktreePath}`);
      } catch (err) {
        console.log(`   ✖ lỗi dọn ${it.worktreePath}: ${err.message}`);
      }
    }
    console.log(`\nĐã dọn ${fixed}/${issues.filter((i) => i.code === 'W2' || i.code === 'W4').length} worktree.`);
  } else {
    console.log('Chạy lại với --fix để dọn các worktree rác (W2/W4).');
  }

  db.close();
  process.exit(1);
}

main();
