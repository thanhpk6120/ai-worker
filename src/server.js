/**
 * src/server.js
 * Express server phục vụ REST API v1, SSE Realtime Stream và Static Dashboard
 */

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const config = require('./config');
const db = require('./storage/db');
const { defaultFileManager: fileManager } = require('./storage/fileManager');
const { defaultPromptTemplateManager: promptTemplateManager } = require('./runners/promptTemplateManager');
const { taskQueue } = require('./queue/taskQueue');
const { JOB_STATUSES, transition, canTransition } = require('./state/stateMachine');
const { runnerRegistry } = require('./runners/runnerRegistry');
const { ensureGitWorkspace } = require('./utils/gitWorkspaceHelper');
// Quản lý event bus tập trung cho SSE Realtime Logs & Events
class JobEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(300);
  }

  emitJobLog(jobId, payload) {
    const data = typeof payload === 'string' ? { text: payload } : payload;
    const normalized = {
      type: 'log',
      jobId,
      timestamp: new Date().toISOString(),
      ...data
    };
    this.emit(`job:${jobId}:log`, normalized);
    this.emit('log', normalized);
    if (jobId && normalized.text) {
      try {
        const logFilePath = path.join(config.LOG_DIR, `${jobId}.log`);
        fs.appendFileSync(logFilePath, normalized.text, 'utf8');
      } catch (err) {}
    }
  }

  emitJobStep(jobId, payload) {
    const data = typeof payload === 'string' ? { step: payload } : payload;
    const normalized = {
      type: 'step',
      jobId,
      timestamp: new Date().toISOString(),
      ...data
    };
    this.emit(`job:${jobId}:step`, normalized);
    this.emit('step', normalized);
  }

  emitJobStatus(jobId, payload) {
    const data = typeof payload === 'string' ? { status: payload } : payload;
    const normalized = {
      type: 'status',
      jobId,
      timestamp: new Date().toISOString(),
      ...data
    };
    this.emit(`job:${jobId}:status`, normalized);
    this.emit('status', normalized);
  }

  emitJobQuestion(jobId, payload) {
    const normalized = {
      type: 'question',
      jobId,
      timestamp: new Date().toISOString(),
      ...(typeof payload === 'object' ? payload : { question: payload })
    };
    this.emit(`job:${jobId}:question`, normalized);
    this.emit('question', normalized);
  }

  emitJobEvidence(jobId, payload) {
    const normalized = {
      type: 'evidence',
      jobId,
      timestamp: new Date().toISOString(),
      ...(typeof payload === 'object' ? payload : { evidence: payload })
    };
    this.emit(`job:${jobId}:evidence`, normalized);
    this.emit('evidence', normalized);
  }

  emitJobDone(jobId, payload) {
    const normalized = {
      type: 'done',
      jobId,
      timestamp: new Date().toISOString(),
      ...(typeof payload === 'object' ? payload : { result: payload })
    };
    this.emit(`job:${jobId}:done`, normalized);
    this.emit('done', normalized);
  }

  emitJobError(jobId, payload) {
    const normalized = {
      type: 'error',
      jobId,
      timestamp: new Date().toISOString(),
      ...(typeof payload === 'object' ? payload : { error: payload })
    };
    this.emit(`job:${jobId}:error`, normalized);
    this.emit('error', normalized);
  }

  emitJobCreated(jobData) {
    const jobId = jobData && jobData.id ? jobData.id : undefined;
    const normalized = {
      type: 'created',
      jobId,
      timestamp: new Date().toISOString(),
      job: jobData
    };
    if (jobId) this.emit(`job:${jobId}:created`, normalized);
    this.emit('job:created', normalized);
    this.emit('created', normalized);
  }
}

const jobEventBus = new JobEventBus();
jobEventBus.on('error', () => {});

// Tích hợp lắng nghe từ processManager nếu có
try {
  const { defaultProcessManager } = require('./execution/processManager');
  if (defaultProcessManager) {
    defaultProcessManager.on('stdout', ({ jobId, text, timestamp }) => {
      if (jobId) {
        jobEventBus.emitJobLog(jobId, { text, level: 'info', timestamp });
      }
    });

    defaultProcessManager.on('stderr', ({ jobId, text, timestamp }) => {
      if (jobId) {
        jobEventBus.emitJobLog(jobId, { text, level: 'error', timestamp });
      }
    });

    defaultProcessManager.on('error', ({ jobId, error }) => {
      if (jobId) {
        jobEventBus.emitJobError(jobId, { error: error?.message || String(error) });
      }
    });

    defaultProcessManager.on('timeout', ({ jobId, timeoutMs }) => {
      if (jobId) {
        jobEventBus.emitJobLog(jobId, {
          text: `\n[TIMEOUT] Tiến trình thực thi bị hủy do vượt quá giới hạn thời gian (${timeoutMs}ms).\n`,
          level: 'warn'
        });
      }
    });
  }
} catch (e) {
  // Bỏ qua nếu processManager chưa được tải
}

// Tích hợp lắng nghe từ taskQueue
taskQueue.on('job:started', ({ jobId, job }) => {
  jobEventBus.emitJobStatus(jobId, { status: job.status || 'PLANNING' });
  jobEventBus.emitJobLog(jobId, {
    text: `\n>>> [QUEUE] Job ${jobId} đã được điều phối bắt đầu thực thi.\n`
  });
});

taskQueue.on('job:completed', ({ jobId, result }) => {
  jobEventBus.emitJobDone(jobId, { result });
  jobEventBus.emitJobLog(jobId, {
    text: `\n>>> [QUEUE] Job ${jobId} đã hoàn tất thành công.\n`
  });
});

taskQueue.on('job:failed', ({ jobId, error }) => {
  jobEventBus.emitJobError(jobId, { error: error?.message || String(error) });
  jobEventBus.emitJobLog(jobId, {
    text: `\n>>> [QUEUE] Job ${jobId} thất bại: ${error?.message || error}\n`,
    level: 'error'
  });
});

taskQueue.on('job:cancelled', ({ jobId, status }) => {
  jobEventBus.emitJobStatus(jobId, { status: 'CANCELLED' });
  jobEventBus.emitJobLog(jobId, {
    text: `\n>>> [QUEUE] Job ${jobId} đã bị hủy bỏ bởi người dùng.\n`,
    level: 'warn'
  });
});

// Khởi tạo Express App
const app = express();

// =========================================================================
// MIDDLEWARES
// =========================================================================
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));

// URL Rewrite Middleware: Chuẩn hóa toàn diện /api/v1/tasks thành /api/v1/jobs
app.use((req, res, next) => {
  if (req.url.startsWith('/api/v1/tasks')) {
    req.url = req.url.replace('/api/v1/tasks', '/api/v1/jobs');
  }
  next();
});
// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // Không log liên tục các polling endpoint tĩnh để tránh tràn log
    if (!req.path.endsWith('/logs/stream')) {
      const duration = Date.now() - start;
      const time = new Date().toISOString().substring(11, 19);
      console.log(`[${time}] ${req.method} ${req.originalUrl} ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// Phục vụ thư mục static public/ tại root
const publicPath = path.join(__dirname, '../public');
app.use(express.static(publicPath));

// Hàm hỗ trợ chuyển file vào thùng rác đa nền tảng (an toàn, không xóa vĩnh viễn)
function safeMoveToTrash(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const fullPath = path.resolve(filePath);
  if (process.platform === 'win32') {
    try {
      const psCommand = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${fullPath.replace(/'/g, "''")}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
      require('node:child_process').execSync(`powershell.exe -NoProfile -NonInteractive -Command "${psCommand}"`, { stdio: 'ignore' });
      return true;
    } catch (e) {}
  } else if (process.platform === 'darwin') {
    try {
      require('node:child_process').execSync(`osascript -e 'tell application "Finder" to delete POSIX file "${fullPath}"'`, { stdio: 'ignore' });
      return true;
    } catch (e) {}
  }
  // Fallback: move to .trash folder
  try {
    const trashDir = path.join(path.dirname(filePath), '.trash');
    if (!fs.existsSync(trashDir)) {
      fs.mkdirSync(trashDir, { recursive: true });
    }
    const dest = path.join(trashDir, `${Date.now()}_${path.basename(filePath)}`);
    fs.renameSync(filePath, dest);
    return true;
  } catch (err) {
    return false;
  }
}

// Helper kiểm tra xem file evidence có bị đánh dấu deleted trong metadata.json hay không
function isEvidenceFileDeleted(metadata, filename) {
  if (!metadata || !filename) return false;
  if (Array.isArray(metadata)) {
    const item = metadata.find(m => m && (m.fileName === filename || m.name === filename || m.file === filename || (m.file_path && m.file_path.includes(filename))));
    return !!(item && item.deleted === true);
  }
  if (typeof metadata === 'object') {
    const item = metadata[filename];
    return !!(item && item.deleted === true);
  }
  return false;
}

// Helper lấy metadata của 1 file evidence
function getEvidenceFileMeta(metadata, filename) {
  if (!metadata || !filename) return {};
  if (Array.isArray(metadata)) {
    return metadata.find(m => m && (m.fileName === filename || m.name === filename || m.file === filename || (m.file_path && m.file_path.includes(filename)))) || {};
  }
  if (typeof metadata === 'object') {
    return metadata[filename] || {};
  }
  return {};
}

function hashEvidenceBuffer(buf) {
  try { return crypto.createHash('md5').update(buf).digest('hex'); } catch (e) { return null; }
}
// ponytail: đọc sync toàn file, đủ cho evidence nhỏ; chuyển stream khi file >50MB.
function buildEvidenceHashes(fullFilePath, stat) {
  let buf = null;
  try { buf = fs.readFileSync(fullFilePath); } catch (e) {
    const fallback = stat ? stat.size : 0;
    return { size: fallback, sizeBytes: fallback, md5: null, contentHash: null };
  }
  const size = buf.length || (stat ? stat.size : 0);
  const md5 = hashEvidenceBuffer(buf);
  return { size, sizeBytes: size, md5, contentHash: md5 };
}
// Chuẩn hoá gate DONE/FAILED: DONE chỉ khi passed=true và không error/timeout.
function resolveJobGate(requestedStatus, body, job) {
  const raw = (requestedStatus || '').toString().trim().toUpperCase();
  const normalized = raw === 'TODO' ? 'TO DO' : raw;
  const gate = (body && body.gate_result) || {};
  const passed = body.passed !== undefined ? body.passed : (gate.passed !== undefined ? gate.passed : body.gate_passed);
  const passedTrue = passed === true || passed === 'true' || passed === 1;
  const errField = body.error !== undefined ? body.error : (body.error_message !== undefined ? body.error_message : gate.error);
  const hasError = errField !== undefined && errField !== null && errField !== '' && errField !== false && errField !== 0;
  const combined = [typeof errField === 'string' ? errField : '', body.timeout ? String(body.timeout) : '', gate.timeout ? String(gate.timeout) : ''].join(' ');
  const hasTimeout = /timeout|timed\s*out|etimedout/i.test(combined);
  const gateResult = { passed: passedTrue, error: typeof errField === 'string' ? errField : (hasError ? String(errField) : null), timeout: hasTimeout, decided_at: new Date().toISOString(), mapped_from: normalized };
  if (normalized === 'DONE') {
    if (hasError || hasTimeout) return { finalStatus: 'FAILED', gateResult, rejected: true, reason: 'Cấm DONE khi kèm error/timeout' };
    if (!passedTrue) return { finalStatus: 'FAILED', gateResult, rejected: false, reason: 'DONE yêu cầu passed=true' };
    return { finalStatus: 'DONE', gateResult, rejected: false, reason: null };
  }
  return { finalStatus: requestedStatus, gateResult, rejected: false, reason: null };
}

// Phục vụ thư mục ảnh bằng chứng static tại /evidence và /evidences
function serveEvidenceFile(req, res) {
  const filename = req.params.filename;
  if (!filename) return res.status(400).send('Filename required');
  const safeFilename = path.basename(filename);

  if (req.params.id) {
    const job = db.getJobById(req.params.id);
    if (job) {
      let wsPath = job.repo_path || process.cwd();
      let wsFeaturesDir = 'docs/features';
      let selectedWs = null;
      if (job.workspace_id) {
        selectedWs = db.getWorkspaceById(job.workspace_id);
      }
      if (!selectedWs && wsPath && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(wsPath)) {
        selectedWs = db.getWorkspaceById(wsPath);
      }
      if (!selectedWs && wsPath) {
        const allWs = db.listWorkspaces();
        selectedWs = allWs.find(w => path.resolve(w.path) === path.resolve(wsPath));
      }
      if (selectedWs) {
        wsPath = selectedWs.path;
        if (selectedWs.features_dir) wsFeaturesDir = selectedWs.features_dir;
      }

      const taskCode = job.task_code || job.id;
      const featureDir = fileManager.getFeatureDirectory(wsPath, taskCode, wsFeaturesDir);
      const taskEvidenceDir = path.join(featureDir, 'evidence');
      const targetFile = path.join(taskEvidenceDir, safeFilename);
      const metaPath = path.join(taskEvidenceDir, 'metadata.json');
      let metaObj = null;
      if (fs.existsSync(metaPath)) {
        try { metaObj = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
      }
      if (isEvidenceFileDeleted(metaObj, safeFilename)) {
        return res.status(404).send('Evidence file has been marked as deleted');
      }
      if (fs.existsSync(targetFile)) {
        return res.sendFile(targetFile);
      }
    }
  }
  // Fallback nếu không truyền job id: quét qua các workspace và feature gần nhất
  try {
    const workspaces = db.listWorkspaces ? db.listWorkspaces() : [];
    for (const ws of workspaces) {
      const featuresRoot = path.join(ws.path, ws.features_dir || 'docs/features');
      if (fs.existsSync(featuresRoot)) {
        const subdirs = fs.readdirSync(featuresRoot);
        for (const sub of subdirs) {
          const candidateMeta = path.join(featuresRoot, sub, 'evidence', 'metadata.json');
          let subMeta = null;
          if (fs.existsSync(candidateMeta)) {
            try { subMeta = JSON.parse(fs.readFileSync(candidateMeta, 'utf8')); } catch (e) {}
          }
          if (isEvidenceFileDeleted(subMeta, safeFilename)) {
            continue;
          }
          const candidate = path.join(featuresRoot, sub, 'evidence', safeFilename);
          if (fs.existsSync(candidate)) {
            return res.sendFile(candidate);
          }
        }
      }
    }
  } catch (e) {}

  return res.status(404).send('Evidence file not found');
}

app.get('/evidence/:filename', serveEvidenceFile);
app.get('/evidences/:filename', serveEvidenceFile);
app.get('/api/v1/jobs/:id/evidence/files/:filename', serveEvidenceFile);
app.get('/api/v1/tasks/:id/evidence/files/:filename', serveEvidenceFile);
// Mock removed
// Mock removed

// =========================================================================
// ROUTES: API V1
// =========================================================================

/**
 * GET /api/v1/health & GET /api/v1/status
 * Trả về trạng thái hệ thống, active workers, uptime và runners
 */
function handleHealthCheck(req, res) {
  try {
    const runningJobs = taskQueue.getRunningJobs();
    const queuedJobs = taskQueue.getQueuedJobs();
    const runners = runnerRegistry.detectAll();

    return res.json({
      status: 'ok',
      online: true,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      uptimeSeconds: Math.floor(process.uptime()),
      activeJobs: runningJobs.length,
      activeWorkers: runningJobs.length,
      queuedJobs: queuedJobs.length,
      concurrency: config.CONCURRENCY,
      maxConcurrency: config.CONCURRENCY,
      runners
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
}

app.get('/api/v1/health', handleHealthCheck);
app.get('/api/v1/status', handleHealthCheck);

/**
 * GET /api/v1/runners
 * Trả về danh sách 5 runners (claude, opencode, omp, codex, antigravity) kèm availability
 */
app.get('/api/v1/runners', (req, res) => {
  try {
    const runners = runnerRegistry.detectAll();
    return res.json({
      success: true,
      runners
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * WORKSPACES ENDPOINTS
 */
app.get('/api/v1/workspaces', (req, res) => {
  try {
    const workspaces = db.listWorkspaces();
    return res.json({ success: true, workspaces });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/workspaces', (req, res) => {
  try {
    const { name, path: wsPath } = req.body;
    if (!wsPath) {
      return res.status(400).json({ success: false, error: 'Đường dẫn thư mục workspace (path) là bắt buộc' });
    }
    const resolvedPath = path.resolve(wsPath);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ success: false, error: `Đường dẫn "${resolvedPath}" không tồn tại trên hệ thống` });
    }

    // Tự động kiểm tra Git: nếu chưa có thì init git; nếu chưa có README.md thì tạo với nội dung là đường dẫn workspace; sau đó commit (không push)
    let gitResult = null;
    try {
      gitResult = ensureGitWorkspace(resolvedPath, name || path.basename(resolvedPath));
      console.log(`[WORKSPACE-GIT] ${resolvedPath}:`, gitResult.logs.join(' | '));
    } catch (gitErr) {
      console.warn(`[WORKSPACE-GIT-WARN] Lỗi xử lý Git cho workspace "${resolvedPath}":`, gitErr.message);
    }

    const features_dir = req.body.features_dir || 'docs/features';
    const ws = db.createWorkspace({ name, path: resolvedPath, features_dir });
    return res.status(201).json({ success: true, workspace: ws, git: gitResult });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.put('/api/v1/workspaces/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, path: wsPath, features_dir, is_default } = req.body;
    const existing = db.getWorkspaceById(id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Workspace không tồn tại' });
    }
    if (wsPath) {
      const resolvedPath = require('path').resolve(wsPath);
      if (!fs.existsSync(resolvedPath)) {
        return res.status(400).json({ success: false, error: `Đường dẫn "${resolvedPath}" không tồn tại trên hệ thống` });
      }
    }
    const updated = db.updateWorkspace(id, { name, path: wsPath, features_dir, is_default });
    return res.json({ success: true, workspace: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/v1/workspaces/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = db.deleteWorkspace(id);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    return res.json({ success: true, id });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/workspaces/:id/set-default', (req, res) => {
  try {
    const { id } = req.params;
    const updated = db.setDefaultWorkspace(id);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Workspace không tồn tại' });
    }
    return res.json({ success: true, workspace: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/workspaces/browse', (req, res) => {
  try {
    if (!req.body.currentPath) {
      if (process.platform === 'win32') {
        const drives = [];
        for (let code = 67; code <= 90; code++) {
          const letter = String.fromCharCode(code);
          const drivePath = letter + ':\\';
          if (fs.existsSync(drivePath)) {
            drives.push({ name: letter + ':', path: drivePath });
          }
        }
        return res.json({ success: true, currentPath: '', parentPath: null, folders: drives });
      }

      const entries = fs.readdirSync('/', { withFileTypes: true });
      const folders = entries
        .filter(e => e.isDirectory())
        .map(e => ({
          name: e.name,
          path: path.join('/', e.name)
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return res.json({ success: true, currentPath: '/', parentPath: null, folders });
    }

    let targetPath = req.body.currentPath;
    targetPath = path.resolve(targetPath);

    if (!fs.existsSync(targetPath)) {
      targetPath = process.cwd();
    }

    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      targetPath = path.dirname(targetPath);
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true });
    const folders = entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => ({
        name: e.name,
        path: path.join(targetPath, e.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const parentPath = path.dirname(targetPath);
    return res.json({
      success: true,
      currentPath: targetPath,
      parentPath: parentPath !== targetPath ? parentPath : (process.platform === 'win32' ? '' : null),
      folders
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * SETTINGS ENDPOINTS
 */
app.get('/api/v1/settings', (req, res) => {
  try {
    const defaultMapping = {
      PLANNING: 'claude-code',
      IMPLEMENT: 'claude-code',
      TESTING: 'claude-code',
      VERIFY: 'verify-gate',
      FIXING: 'claude-code'
    };
    const saved = db.getSetting('agent_mapping', defaultMapping);
    const agentMapping = (typeof saved === 'object' && saved !== null)
      ? { ...defaultMapping, ...saved }
      : defaultMapping;
    return res.json({
      success: true,
      settings: {
        agent_mapping: agentMapping
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/v1/settings', (req, res) => {
  try {
    const { agent_mapping, key, value } = req.body;
    if (agent_mapping) {
      db.setSetting('agent_mapping', agent_mapping);
    } else if (key) {
      db.setSetting(key, value);
    }
    const updatedMapping = db.getSetting('agent_mapping');
    return res.json({
      success: true,
      settings: {
        agent_mapping: updatedMapping
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/jobs
 * Nhận payload tạo job mới, validate, ghi DB, enqueue vào taskQueue
 */
app.post('/api/v1/jobs', (req, res) => {
  console.log('[API] POST /api/v1/jobs called with task_code:', req.body.task_code || req.body.taskCode);
  try {
    const {
      task_code,
      taskCode,
      prompt,
      title,
      repoPath,
      repo_path,
      branch,
      base_branch,
      runner,
      runners,
      pipeline_config,
      pipelineConfig,
      timeout,
      model,
      priority
    } = req.body;

    const finalTaskCode = String(task_code || taskCode || '').trim();
    if (!finalTaskCode) {
      return res.status(400).json({
        error: 'Vui lòng cung cấp mã task (task_code)'
      });
    }
    const finalBranch = branch || base_branch || 'main';
    const finalTitle = title || (prompt ? prompt.slice(0, 100).trim() : '');
    const finalPrompt = prompt || title || '';

    if (!finalTitle && !finalPrompt) {
      return res.status(400).json({
        error: 'Vui lòng cung cấp tiêu đề (title) hoặc mô tả yêu cầu (prompt)'
      });
    }
    let finalRepoPath = repoPath || repo_path;
    const finalWorkspaceId = req.body.workspace_id || req.body.workspaceId;
    if (finalWorkspaceId) {
      const ws = db.getWorkspaceById(finalWorkspaceId);
      if (ws && ws.path) {
        finalRepoPath = ws.path;
      }
    }
    if (finalRepoPath && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(finalRepoPath)) {
      const ws = db.getWorkspaceById(finalRepoPath);
      if (ws && ws.path) {
        finalRepoPath = ws.path;
      }
    }
    if (!finalRepoPath) {
      finalRepoPath = process.cwd();
    }
    const agentMapping = db.getSetting('agent_mapping', null);
    const defaultRunner = (agentMapping && agentMapping.PLANNING) ? agentMapping.PLANNING : 'claude-code';
    const finalRunner = runner || (runners ? runners.plan : null) || defaultRunner;
    const finalPriority = typeof priority === 'number' ? priority : 0;

    let mergedPipelineConfig = pipeline_config || pipelineConfig || {};
    if (typeof mergedPipelineConfig !== 'object' || mergedPipelineConfig === null) {
      mergedPipelineConfig = {};
    }
    if (timeout) mergedPipelineConfig.timeout = timeout;
    if (model) mergedPipelineConfig.model = model;
    if (runners) mergedPipelineConfig.runners = runners;
    const bodyMaxRetries = req.body.max_retries ?? req.body.maxRetries ?? req.body.maxretries;
    if (bodyMaxRetries !== undefined && bodyMaxRetries !== null) {
      mergedPipelineConfig.max_retries = bodyMaxRetries;
      mergedPipelineConfig.maxRetries = bodyMaxRetries;
    }

    // Đảm bảo tạo thư mục docs/features/<task_code> và ghi file expect.md trước
    // Nếu thư mục đã tồn tại trên workspace: Báo lỗi FOLDER_ALREADY_EXISTS kèm mã gợi ý
    let resolvedWorkspaceId = finalWorkspaceId || null;
    try {
      let finalFeaturesDir = 'docs/features';
      let selectedWs = null;
      if (finalWorkspaceId) {
        selectedWs = db.getWorkspaceById(finalWorkspaceId);
      }
      if (!selectedWs && finalRepoPath && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(finalRepoPath)) {
        selectedWs = db.getWorkspaceById(finalRepoPath);
      }
      if (!selectedWs && finalRepoPath) {
        const allWs = db.listWorkspaces();
        selectedWs = allWs.find(w => path.resolve(w.path) === path.resolve(finalRepoPath));
      }
      if (!selectedWs) {
        const allWs = db.listWorkspaces();
        selectedWs = allWs.find(w => w.is_default);
      }
      if (selectedWs && selectedWs.features_dir) {
        finalFeaturesDir = selectedWs.features_dir;
      }
      if (selectedWs && selectedWs.id) {
        resolvedWorkspaceId = selectedWs.id;
      }
      const allowExisting = req.body.allow_existing === true || req.body.allowExisting === true || req.body.force === true;
      fileManager.ensureFeatureDirectory(finalRepoPath, finalTaskCode, { allowExisting, featuresDir: finalFeaturesDir });
      fileManager.saveExpectFile(finalRepoPath, finalTaskCode, {
        title: finalTitle,
        prompt: finalPrompt,
        author: 'User',
        featuresDir: finalFeaturesDir,
        allowExisting: true
      });
    } catch (folderErr) {
      console.error('[FileManager] Lỗi tạo thư mục feature:', folderErr.message);
      if (folderErr.code === 'FOLDER_ALREADY_EXISTS') {
        return res.status(409).json({
          success: false,
          conflict: true,
          reason: 'FOLDER_ALREADY_EXISTS',
          error: `Thư mục 'docs/features/${finalTaskCode}' đã tồn tại trên workspace. Vui lòng chọn mã task khác hoặc sử dụng mã gợi ý.`,
          suggested_task_code: folderErr.suggestedTaskCode
        });
      }
      return res.status(400).json({
        success: false,
        error: `Không thể tạo thư mục tính năng tại 'docs/features/${finalTaskCode}': ${folderErr.message}. Vui lòng kiểm tra lại mã task hoặc đường dẫn workspace.`,
        reason: 'FOLDER_CREATION_FAILED'
      });
    }
    // Ghi job vào Database sau khi thư mục đã được tạo thành công
    const createdJob = db.createJob({
      task_code: finalTaskCode,
      title: finalTitle,
      prompt: finalPrompt,
      repo_path: finalRepoPath,
      workspace_id: resolvedWorkspaceId,
      base_branch: finalBranch,
      runner: finalRunner,
      pipeline_config: mergedPipelineConfig,
      priority: finalPriority,
      status: JOB_STATUSES.TO_DO,
      current_step: 'TO DO'
    });
    // Tạo initial step cho job
    try {
      db.createStep({
        job_id: createdJob.id,
        step_name: 'PLANNING',
        step_index: 1,
        status: 'PENDING',
        runner: finalRunner
      });
    } catch (e) {
      // Bỏ qua nếu lỗi tạo step phụ
    }

    // Runner Function được taskQueue gọi khi tới lượt thực thi
    const runFn = async () => {
      try {
        console.log(`[Queue Worker] Khởi chạy Job ${createdJob.id}...`);

        // 1. Chuyển trạng thái sang PLANNING
        try {
          transition(createdJob.id, JOB_STATUSES.PLANNING, db, (event) => {
            jobEventBus.emitJobStatus(createdJob.id, { status: event.to });
          });
        } catch (transErr) {
          db.updateJob(createdJob.id, {
            status: JOB_STATUSES.PLANNING,
            current_step: 'PLANNING'
          });
          jobEventBus.emitJobStatus(createdJob.id, { status: JOB_STATUSES.PLANNING });
        }

        jobEventBus.emitJobLog(createdJob.id, {
          text: `[SYSTEM] Bắt đầu thực thi pipeline cho Job: ${createdJob.title}\n` +
                `[SYSTEM] Workspace: ${finalRepoPath} | Branch: ${finalBranch} | Runner: ${finalRunner}\n` +
                `--------------------------------------------------------------------------------\n`
        });

        // 2. Thử sinh Dual Planning (dev_plan.md và test_plan.md)
        try {
          const { DualPlanningGenerator } = require('./pipeline/dualPlanning');
          const generator = new DualPlanningGenerator();

          jobEventBus.emitJobLog(createdJob.id, {
            text: `[DualPlanning] Đang phân tích yêu cầu và tự động thiết lập Dual Plan song song...\n`
          });

          const devPlan = generator.generateDevPlan({
            featureName: createdJob.title,
            prompt: createdJob.prompt,
            context: {
              repoPath: finalRepoPath,
              branch: finalBranch
            }
          });

          const testPlan = generator.generateTestPlan({
            featureName: createdJob.title,
            devPlan
          });

          // Lưu Dual Plan vào Database
          const savedPlan = db.saveDualPlan({
            job_id: createdJob.id,
            dev_plan: devPlan,
            test_plan: testPlan,
            status: 'GENERATED'
          });

          jobEventBus.emitJobLog(createdJob.id, {
            text: `[DualPlanning] Đã tạo thành công Dev Plan (${devPlan.planId}) & Test Plan (${testPlan.planId}).\n`
          });
        } catch (planErr) {
          jobEventBus.emitJobLog(createdJob.id, {
            text: `[DualPlanning] Lưu ý: Kế hoạch sẽ được runner agent trực tiếp bổ sung.\n`
          });
        }
      } catch (workerErr) {
        console.error(`Lỗi thực thi Job ${createdJob.id}:`, workerErr);
        jobEventBus.emitJobError(createdJob.id, { error: workerErr.message });
      }
    };

    // Đưa vào hàng đợi xử lý
    // taskQueue.enqueue(createdJob, runFn, finalPriority); // Chờ bấm nút Kích hoạt Task

    return res.status(201).json({
      success: true,
      job: createdJob,
      ...createdJob
    });
  } catch (err) {
    console.error('Lỗi khi tạo job:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/v1/jobs
 * Danh sách jobs kèm bộ lọc status, runner, pagination
 */
app.get('/api/v1/jobs', (req, res) => {
  try {
    const { status, runner, limit = 100, offset = 0, search } = req.query;

    let jobs = db.listJobs({
      status: status && status !== 'ALL' ? status : undefined,
      runner: runner || undefined,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10)
    });

    if (search) {
      const q = String(search).toLowerCase();
      jobs = jobs.filter((j) =>
        (j.id || '').toLowerCase().includes(q) ||
        (j.title || '').toLowerCase().includes(q) ||
        (j.prompt || '').toLowerCase().includes(q)
      );
    }

    return res.json({
      success: true,
      jobs,
      total: jobs.length
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
function getTaskEvidences(job) {
  if (!job) return [];
  let workspacePath = job.repo_path || job.worktree_path || './';
  let wsFeaturesDir = 'docs/features';
  try {
    let ws = null;
    if (job.workspace_id) ws = db.getWorkspaceById(job.workspace_id);
    if (!ws && workspacePath && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspacePath)) {
      ws = db.getWorkspaceById(workspacePath);
    }
    if (!ws && typeof db.listWorkspaces === 'function') {
      const allWs = db.listWorkspaces();
      ws = allWs.find(w => path.resolve(w.path) === path.resolve(workspacePath));
    }
    if (ws) {
      if (ws.path) workspacePath = ws.path;
      if (ws.features_dir) wsFeaturesDir = ws.features_dir;
    }
  } catch (e) {}
  const taskCode = job.task_code || job.id;
  const featureDir = fileManager.getFeatureDirectory(workspacePath, taskCode, wsFeaturesDir);
  const taskEvidenceDir = path.join(featureDir, 'evidence');
  let metadata = {};
  const metadataPath = path.join(taskEvidenceDir, 'metadata.json');
  if (fs.existsSync(metadataPath)) {
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch(e){}
  }


  const list = [];
  if (fs.existsSync(taskEvidenceDir)) {
    const files = fs.readdirSync(taskEvidenceDir);
    files.forEach((file, idx) => {
      if (file === 'metadata.json' || file.startsWith('.')) return;
      if (isEvidenceFileDeleted(metadata, file)) return;

      const fullFilePath = path.join(taskEvidenceDir, file);
      let stat;
      try { stat = fs.statSync(fullFilePath); } catch (e) { return; }
      if (stat.size <= 10) return; // File rỗng không coi là evidence

      const ext = path.extname(file).toLowerCase();
      if (ext === '.json') {
        try {
          const raw = fs.readFileSync(fullFilePath, 'utf8').trim();
          if (!raw || raw === '{}' || raw === '[]' || raw === 'null') return;
        } catch (e) { return; }
      } else if (ext === '.log' || ext === '.txt') {
        try {
          const raw = fs.readFileSync(fullFilePath, 'utf8').trim();
          if (!raw) return;
        } catch (e) { return; }
      }

      const meta = getEvidenceFileMeta(metadata, file);
      const evidenceHashes = buildEvidenceHashes(fullFilePath, stat);
      let type = 'LOG_TRACE';
      let fileContent = '';
      let parsedData = null;

      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
        type = 'UI_SCREENSHOT';
      } else if (file.toLowerCase().includes('db') || file.toLowerCase().includes('assert') || ext === '.sql') {
        type = 'DB_QUERY';
        try {
          fileContent = fs.readFileSync(fullFilePath, 'utf8');
          if (ext === '.json') parsedData = JSON.parse(fileContent);
        } catch (e) {}
      } else if (ext === '.json' || file.toLowerCase().includes('api')) {
        type = 'API_TEST';
        try {
          fileContent = fs.readFileSync(fullFilePath, 'utf8');
          parsedData = JSON.parse(fileContent);
          if (!parsedData || (typeof parsedData === 'object' && !parsedData.endpoint && !parsedData.request && !parsedData.url && !parsedData.method && !parsedData.status)) {
            return;
          }
        } catch (e) { return; }
      } else if (ext === '.log' || ext === '.txt') {
        type = 'LOG_TRACE';
        try { fileContent = fs.readFileSync(fullFilePath, 'utf8'); } catch (e) {}
      }

      const taskCode = job.task_code || job.id;
      const itemObj = {
        id: `${job.id}-ev-${idx}`,
        job_id: job.id,
        type,
        verdict: meta.verdict || (meta.status === 'FAILED' ? 'FAIL' : 'PASS'),
        file_path: `/api/v1/jobs/${job.id}/evidence/files/${encodeURIComponent(file)}`,
        url: `/api/v1/jobs/${job.id}/evidence/files/${encodeURIComponent(file)}`,
        status: meta.status || (meta.verdict === 'FAIL' ? 'FAILED' : 'PASSED'),
        title: meta.title || file.replace(ext, '').replace(/^[0-9]+_/, '').replace(/[-_]/g, ' '),
        filename: file,
        service_name: taskCode || 'Target Service',
        service: taskCode || 'Target Service',
        content: fileContent,
        rawLogs: fileContent,
        logs: fileContent,
        log_excerpt: fileContent ? fileContent.slice(0, 300) : '',
        size: (typeof evidenceHashes !== 'undefined' && evidenceHashes.size != null ? evidenceHashes.size : stat.size),
        sizeBytes: (typeof evidenceHashes !== 'undefined' && evidenceHashes.sizeBytes != null ? evidenceHashes.sizeBytes : stat.size),
        md5: (typeof evidenceHashes !== 'undefined' && evidenceHashes.md5) || null,
        contentHash: (typeof evidenceHashes !== 'undefined' && evidenceHashes.contentHash) || null
      };

      if (type === 'API_TEST' && parsedData) {
        itemObj.method = (parsedData.method || (parsedData.request && parsedData.request.method) || 'GET').toUpperCase();
        itemObj.endpoint = parsedData.endpoint || parsedData.url || (parsedData.request && (parsedData.request.url || parsedData.request.endpoint || parsedData.request.path)) || '/api';
        itemObj.statusCode = parsedData.statusCode || parsedData.status_code || parsedData.status || (parsedData.response && parsedData.response.status) || 200;
        itemObj.durationMs = parsedData.durationMs || parsedData.duration_ms || parsedData.latency_ms || parsedData.latency || 0;
        itemObj.request = parsedData.request || { method: itemObj.method, endpoint: itemObj.endpoint, headers: parsedData.headers, body: parsedData.body || parsedData.payload };
        itemObj.response = parsedData.response || { status: itemObj.statusCode, headers: parsedData.responseHeaders, body: parsedData.responseBody || parsedData.data };
      }

      if (type === 'DB_QUERY' && parsedData) {
        itemObj.table = parsedData.table || parsedData.tableName || parsedData.target || 'Database Table';
        itemObj.query = parsedData.query || parsedData.sql || fileContent;
        itemObj.expected = parsedData.expected || parsedData.expectedValues;
        itemObj.actual = parsedData.actual || parsedData.actualRows || parsedData.rows;
        itemObj.matched = parsedData.matched !== undefined ? parsedData.matched : (parsedData.passed !== undefined ? parsedData.passed : (itemObj.verdict === 'PASS'));
      }

      list.push(itemObj);
    });
  }

  // Giới hạn tối đa 2 loại evidence thực tế
  const priorityOrder = ['UI_SCREENSHOT', 'LOG_TRACE', 'API_TEST', 'DB_QUERY'];
  const presentTypes = priorityOrder.filter(t => list.some(e => e.type === t));
  const allowedTypes = new Set(presentTypes.slice(0, 2));
  return list.filter(e => allowedTypes.has(e.type));
}

/**
 * GET /api/v1/jobs/:id
 * Chi tiết 1 job kèm steps, dual_plan, pending question, evidence
 */
app.get('/api/v1/jobs/:id', (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);

    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }

    const steps = db.getStepsByJobId(id);
    const dualPlan = db.getDualPlanByJobId(id);
    const pendingQuestion = db.getPendingQuestionByJobId(id);
    const questions = db.getQuestionsByJobId(id);
    const evidence = getTaskEvidences(job);
    const fullJobData = {
      ...job,
      steps,
      dual_plan: dualPlan,
      dualPlan,
      pending_question: pendingQuestion,
      question: pendingQuestion,
      questions,
      evidence,
      evidences: evidence
    };

    return res.json({
      success: true,
      job: fullJobData,
      ...fullJobData
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
/**
 * PUT /api/v1/jobs/:id
 * Chỉnh sửa thông tin task (mã task, prompt, title) - CHỈ CHO PHÉP KHI Ở TRẠNG THÁI TO DO
 */
app.put(['/api/v1/jobs/:id', '/api/v1/tasks/:id'], (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);

    if (!job) {
      return res.status(404).json({ success: false, error: `Task with ID '${id}' not found` });
    }

    const runningStatuses = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'];
    if (runningStatuses.includes((job.status || '').toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: `Không thể chỉnh sửa khi Task đang trong quá trình thực thi (${job.status})`
      });
    }

    const { task_code, prompt, title, repo_path, repoPath, base_branch, branch, timeout, max_retries, maxRetries, pipeline_config, pipelineConfig, model } = req.body;
    const workspaceIdRaw = req.body.workspace_id || req.body.workspaceId;
    const updates = {};

    // Resolve workspace như POST: workspace_id -> repo_path, UUID -> repo_path
    let finalRepoPath = repoPath || repo_path || null;
    let resolvedWs = null;
    if (workspaceIdRaw) {
      resolvedWs = db.getWorkspaceById(workspaceIdRaw);
      if (!resolvedWs) {
        return res.status(400).json({ success: false, error: `Workspace với ID '${workspaceIdRaw}' không tồn tại` });
      }
      if (resolvedWs.path) finalRepoPath = resolvedWs.path;
    }
    if (finalRepoPath && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(finalRepoPath).trim())) {
      const wsByUuid = db.getWorkspaceById(String(finalRepoPath).trim());
      if (wsByUuid && wsByUuid.path) {
        if (!resolvedWs) resolvedWs = wsByUuid;
        finalRepoPath = wsByUuid.path;
      }
    }
    const oldWorkspace = job.repo_path || job.workspace_path || './';
    const finalWorkspace = finalRepoPath || oldWorkspace;
    const isChangingWorkspace = path.resolve(String(finalWorkspace)) !== path.resolve(String(oldWorkspace));
    const finalCode = (task_code && String(task_code).trim()) ? String(task_code).trim() : (job.task_code || id);
    const oldCode = job.task_code || id;
    const isChangingCode = Boolean(task_code && String(task_code).trim() && String(task_code).trim() !== job.task_code);

    // Đảm bảo tạo hoặc kiểm tra thư mục docs/features/<task_code> trước khi cập nhật
    // Nếu đổi sang mã task mới mà thư mục đã tồn tại: Báo lỗi và gợi ý hậu tố
    // Nếu đổi workspace: kiểm tra/dời thư mục features tương ứng
    let finalFeaturesDir = 'docs/features';
    let oldFeaturesDir = 'docs/features';
    try {
      if (!resolvedWs) {
        if (job.workspace_id) resolvedWs = db.getWorkspaceById(job.workspace_id);
      }
      if (!resolvedWs && finalWorkspace && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(finalWorkspace))) {
        resolvedWs = db.getWorkspaceById(String(finalWorkspace));
      }
      if (!resolvedWs && finalWorkspace) {
        const allWs = db.listWorkspaces();
        resolvedWs = allWs.find(w => { try { return path.resolve(w.path) === path.resolve(String(finalWorkspace)); } catch (e) { return false; } });
      }
      if (resolvedWs && resolvedWs.features_dir) finalFeaturesDir = resolvedWs.features_dir;
      // features_dir của workspace cũ (phục vụ dời thư mục khi đổi workspace)
      try {
        let oldWs = null;
        if (job.workspace_id) oldWs = db.getWorkspaceById(job.workspace_id);
        if (!oldWs && oldWorkspace) {
          const allWs = db.listWorkspaces();
          oldWs = allWs.find(w => { try { return path.resolve(w.path) === path.resolve(String(oldWorkspace)); } catch (e) { return false; } });
        }
        if (oldWs && oldWs.features_dir) oldFeaturesDir = oldWs.features_dir;
        else if (resolvedWs && !isChangingWorkspace && resolvedWs.features_dir) oldFeaturesDir = resolvedWs.features_dir;
      } catch (e) {}
      const allowExisting = !(isChangingCode || isChangingWorkspace);
      if (isChangingCode || isChangingWorkspace) {
        let oldDir = null;
        let newDir = null;
        try { oldDir = fileManager.getFeatureDirectory(oldWorkspace, oldCode, oldFeaturesDir); } catch (e) { oldDir = null; }
        try { newDir = path.resolve(fileManager.resolveWorkspacePath(finalWorkspace), finalFeaturesDir, String(finalCode).replace(/[/\\?%*:|"<>]/g, '-')); } catch (e) { newDir = null; }
        const oldExists = oldDir && fs.existsSync(oldDir);
        const newExists = newDir && fs.existsSync(newDir);
        const sameDir = oldDir && newDir && path.resolve(oldDir) === path.resolve(newDir);
        if (oldExists && !sameDir) {
          if (newExists) {
            let suggested = null;
            try { suggested = fileManager.suggestNextTaskCode(finalWorkspace, finalCode, finalFeaturesDir); } catch (e) {}
            return res.status(409).json({
              success: false,
              conflict: true,
              reason: 'FOLDER_ALREADY_EXISTS',
              error: `Thư mục '${finalFeaturesDir}/${finalCode}' đã tồn tại trên workspace. Vui lòng chọn mã task khác hoặc sử dụng mã gợi ý.`,
              suggested_task_code: suggested
            });
          }
          try {
            fs.mkdirSync(path.dirname(newDir), { recursive: true });
            try {
              fs.renameSync(oldDir, newDir);
            } catch (moveErr) {
              if (moveErr && (moveErr.code === 'EXDEV' || moveErr.code === 'EPERM')) {
                fs.cpSync(oldDir, newDir, { recursive: true });
                fs.rmSync(oldDir, { recursive: true, force: true });
              } else {
                throw moveErr;
              }
            }
            const evidenceDir = path.join(newDir, 'evidence');
            if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
          } catch (moveErr) {
            fileManager.ensureFeatureDirectory(finalWorkspace, finalCode, { allowExisting: false, featuresDir: finalFeaturesDir });
          }
        } else {
          fileManager.ensureFeatureDirectory(finalWorkspace, finalCode, { allowExisting: false, featuresDir: finalFeaturesDir });
        }
      } else {
        fileManager.ensureFeatureDirectory(finalWorkspace, finalCode, { allowExisting, featuresDir: finalFeaturesDir });
      }
    } catch (folderErr) {
      if (folderErr.code === 'FOLDER_ALREADY_EXISTS') {
        return res.status(409).json({
          success: false,
          conflict: true,
          reason: 'FOLDER_ALREADY_EXISTS',
          error: `Thư mục '${finalFeaturesDir}/${finalCode}' đã tồn tại trên workspace. Vui lòng chọn mã task khác hoặc sử dụng mã gợi ý.`,
          suggested_task_code: folderErr.suggestedTaskCode
        });
      }
      return res.status(400).json({
        success: false,
        error: `Không thể tạo hoặc truy cập thư mục '${finalFeaturesDir}/${finalCode}': ${folderErr.message}. Vui lòng kiểm tra lại mã task hoặc đường dẫn workspace.`,
        reason: 'FOLDER_CREATION_FAILED'
      });
    }
    if (task_code && String(task_code).trim()) updates.task_code = String(task_code).trim();
    if (prompt && String(prompt).trim()) updates.prompt = String(prompt).trim();
    if (title && String(title).trim()) updates.title = String(title).trim();
    const branchRaw = branch || base_branch;
    if (branchRaw && String(branchRaw).trim()) updates.base_branch = String(branchRaw).trim();
    if (finalRepoPath) updates.repo_path = finalRepoPath;
    else if (isChangingWorkspace) updates.repo_path = finalWorkspace;
    if (resolvedWs && resolvedWs.id) updates.workspace_id = resolvedWs.id;
    const incomingPipeRaw = pipeline_config || pipelineConfig;
    const hasIncomingPipe = incomingPipeRaw && typeof incomingPipeRaw === 'object' && Object.keys(incomingPipeRaw).length > 0;
    if (hasIncomingPipe || timeout !== undefined || max_retries !== undefined || maxRetries !== undefined || model !== undefined) {
      let mergedPipe = {};
      if (job.pipeline_config) {
        try {
          mergedPipe = typeof job.pipeline_config === 'string' ? JSON.parse(job.pipeline_config) : { ...job.pipeline_config };
        } catch (e) { mergedPipe = {}; }
      }
      if (hasIncomingPipe) mergedPipe = { ...mergedPipe, ...incomingPipeRaw };
      if (timeout !== undefined && timeout !== null && String(timeout).trim() !== '') {
        const n = Number(timeout);
        mergedPipe.timeout = Number.isFinite(n) ? n : timeout;
      }
      const retryVal = max_retries !== undefined ? max_retries : maxRetries;
      if (retryVal !== undefined && retryVal !== null && String(retryVal).trim() !== '') {
        const n = Number(retryVal);
        mergedPipe.max_retries = Number.isFinite(n) ? n : retryVal;
        mergedPipe.maxRetries = mergedPipe.max_retries;
      }
      if (model !== undefined && model !== null && String(model).trim() !== '') mergedPipe.model = model;
      updates.pipeline_config = mergedPipe;
    }

    const updatedJob = db.updateJob(id, updates);

    // Cập nhật lại file expect.md nếu có thay đổi
    try {
      fileManager.saveExpectFile(finalWorkspace, finalCode, {
        title: updatedJob.title,
        prompt: updatedJob.prompt,
        featuresDir: finalFeaturesDir
      });
    } catch (e) {
      console.warn('Cập nhật file expect.md cảnh báo:', e.message);
    }
    jobEventBus.emitJobLog(id, {
      text: `[UPDATE] Đã cập nhật thông tin Task: Mã: ${updatedJob.task_code || id} | Tiêu đề: ${updatedJob.title}\n`
    });
    return res.json({
      success: true,
      message: 'Cập nhật thông tin Task thành công!',
      job: updatedJob,
      task: updatedJob
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


/**
 * GET /api/v1/jobs/:id/steps
 * Danh sách pipeline steps của job
 */
app.get('/api/v1/jobs/:id/steps', (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);

    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }

    const steps = db.getStepsByJobId(id);
    return res.json({
      success: true,
      steps
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/v1/jobs/:id/evidence
 * Danh sách bằng chứng kiểm thử (UI, API, Log, DB) của job
 */
app.get(['/api/v1/jobs/:id/evidence', '/api/v1/jobs/:id/evidences', '/api/v1/tasks/:id/evidence', '/api/v1/tasks/:id/evidences'], (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);

    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }

    // Xác định thư mục feature và evidence của riêng task này
    let workspacePath = job.repo_path || job.worktree_path || './';
    let wsFeaturesDir = 'docs/features';
    try {
      let ws = null;
      if (job.workspace_id) ws = db.getWorkspaceById(job.workspace_id);
      if (!ws && workspacePath && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspacePath)) {
        ws = db.getWorkspaceById(workspacePath);
      }
      if (!ws && typeof db.listWorkspaces === 'function') {
        const allWs = db.listWorkspaces();
        ws = allWs.find(w => path.resolve(w.path) === path.resolve(workspacePath));
      }
      if (ws) {
        if (ws.path) workspacePath = ws.path;
        if (ws.features_dir) wsFeaturesDir = ws.features_dir;
      }
    } catch (e) {}
    const taskCode = job.task_code || job.id;
    const featureDir = fileManager.getFeatureDirectory(workspacePath, taskCode, wsFeaturesDir);
    const taskEvidenceDir = path.join(featureDir, 'evidence');
    let metadata = {};
    const metadataPath = path.join(taskEvidenceDir, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
      try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch (e) {}
    }

    const realEvidenceList = [];
    if (fs.existsSync(taskEvidenceDir)) {
      const files = fs.readdirSync(taskEvidenceDir);
      for (let idx = 0; idx < files.length; idx++) {
        const file = files[idx];
        if (file === 'metadata.json' || file.startsWith('.')) continue;
        if (isEvidenceFileDeleted(metadata, file)) continue;

        const fullFilePath = path.join(taskEvidenceDir, file);
        let stat;
        try { stat = fs.statSync(fullFilePath); } catch (e) { continue; }

        // 1. Kiểm tra không được là dữ liệu rỗng (nếu rỗng thì KHÔNG coi là evidence)
        if (stat.size <= 10) continue;

        const ext = path.extname(file).toLowerCase();

        // Kiểm tra nội dung json hoặc log xem có rỗng không
        if (ext === '.json') {
          try {
            const jsonRaw = fs.readFileSync(fullFilePath, 'utf8').trim();
            if (!jsonRaw || jsonRaw === '{}' || jsonRaw === '[]' || jsonRaw === 'null') {
              continue; // Dữ liệu rỗng, bỏ qua
            }
          } catch (e) { continue; }
        } else if (ext === '.log' || ext === '.txt') {
          try {
            const logRaw = fs.readFileSync(fullFilePath, 'utf8').trim();
            if (!logRaw) continue; // Log rỗng, bỏ qua
          } catch (e) { continue; }
        }

        const meta = getEvidenceFileMeta(metadata, file);
      const evidenceHashes = buildEvidenceHashes(fullFilePath, stat);
        let type = 'LOG_TRACE';
        let fileContent = '';
        let parsedData = null;

        if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
          type = 'UI_SCREENSHOT';
        } else if (file.toLowerCase().includes('db') || file.toLowerCase().includes('assert') || ext === '.sql') {
          type = 'DB_QUERY';
          try {
            fileContent = fs.readFileSync(fullFilePath, 'utf8');
            if (ext === '.json') parsedData = JSON.parse(fileContent);
          } catch (e) {}
        } else if (ext === '.json' || file.toLowerCase().includes('api')) {
          type = 'API_TEST';
          try {
            fileContent = fs.readFileSync(fullFilePath, 'utf8');
            parsedData = JSON.parse(fileContent);
            // Nếu file json không có trường request/response hay endpoint hợp lệ, không thể là API test chuẩn
            if (!parsedData || (typeof parsedData === 'object' && !parsedData.endpoint && !parsedData.request && !parsedData.url && !parsedData.method && !parsedData.status)) {
              continue;
            }
          } catch (e) {
            continue;
          }
        } else if (ext === '.log' || ext === '.txt') {
          type = 'LOG_TRACE';
          try {
            fileContent = fs.readFileSync(fullFilePath, 'utf8');
          } catch (e) {}
        }

        const itemObj = {
          id: `${id}-ev-${idx}`,
          job_id: id,
          type,
          verdict: meta.verdict || (meta.status === 'FAILED' ? 'FAIL' : 'PASS'),
          file_path: `/api/v1/jobs/${id}/evidence/files/${encodeURIComponent(file)}`,
          url: `/api/v1/jobs/${id}/evidence/files/${encodeURIComponent(file)}`,
          status: meta.status || (meta.verdict === 'FAIL' ? 'FAILED' : 'PASSED'),
          title: meta.title || file.replace(ext, '').replace(/^[0-9]+_/, '').replace(/[-_]/g, ' '),
          filename: file,
          service_name: taskCode || 'Target Service',
          service: taskCode || 'Target Service',
          content: fileContent,
          rawLogs: fileContent,
          logs: fileContent,
          log_excerpt: fileContent ? fileContent.slice(0, 300) : '',
          created_at: stat.mtime.toISOString(),
          size: (typeof evidenceHashes !== 'undefined' && evidenceHashes.size != null ? evidenceHashes.size : stat.size),
          sizeBytes: (typeof evidenceHashes !== 'undefined' && evidenceHashes.sizeBytes != null ? evidenceHashes.sizeBytes : stat.size),
          md5: (typeof evidenceHashes !== 'undefined' && evidenceHashes.md5) || null,
          contentHash: (typeof evidenceHashes !== 'undefined' && evidenceHashes.contentHash) || null
        };

        // Nếu là API Test, gán các trường chi tiết từ file json
        if (type === 'API_TEST' && parsedData) {
          itemObj.method = (parsedData.method || (parsedData.request && parsedData.request.method) || 'GET').toUpperCase();
          itemObj.endpoint = parsedData.endpoint || parsedData.url || (parsedData.request && (parsedData.request.url || parsedData.request.endpoint || parsedData.request.path)) || '/api';
          itemObj.statusCode = parsedData.statusCode || parsedData.status_code || parsedData.status || (parsedData.response && parsedData.response.status) || 200;
          itemObj.durationMs = parsedData.durationMs || parsedData.duration_ms || parsedData.latency_ms || parsedData.latency || 0;
          itemObj.request = parsedData.request || { method: itemObj.method, endpoint: itemObj.endpoint, headers: parsedData.headers, body: parsedData.body || parsedData.payload };
          itemObj.response = parsedData.response || { status: itemObj.statusCode, headers: parsedData.responseHeaders, body: parsedData.responseBody || parsedData.data };
        }

        // Nếu là DB Query, gán các trường chi tiết từ file
        if (type === 'DB_QUERY' && parsedData) {
          itemObj.table = parsedData.table || parsedData.tableName || parsedData.target || 'Database Table';
          itemObj.query = parsedData.query || parsedData.sql || fileContent;
          itemObj.expected = parsedData.expected || parsedData.expectedValues;
          itemObj.actual = parsedData.actual || parsedData.actualRows || parsedData.rows;
          itemObj.matched = parsedData.matched !== undefined ? parsedData.matched : (parsedData.passed !== undefined ? parsedData.passed : (itemObj.verdict === 'PASS'));
        }

        realEvidenceList.push(itemObj);
      }
    }

    // 2. Quy chuẩn: Mỗi task TỐI ĐA 2 LOẠI EVIDENCE (có thể là 1 loại duy nhất)
    // Thứ tự ưu tiên các loại evidence thực tế: UI_SCREENSHOT -> LOG_TRACE -> API_TEST -> DB_QUERY
    const priorityOrder = ['UI_SCREENSHOT', 'LOG_TRACE', 'API_TEST', 'DB_QUERY'];
    const presentTypes = priorityOrder.filter(t => realEvidenceList.some(e => e.type === t));
    const allowedTypes = new Set(presentTypes.slice(0, 2)); // Tối đa 2 loại

    const filteredEvidenceList = realEvidenceList.filter(e => allowedTypes.has(e.type));

    return res.json({
      success: true,
      evidence: filteredEvidenceList,
      evidences: filteredEvidenceList,
      totalFound: realEvidenceList.length,
      typesAllowed: Array.from(allowedTypes),
      folder: taskEvidenceDir
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/v1/jobs/:id/evidence/files/:filename
 * Xoá cứng trong SQLite và xoá cả file vật lý trong folder lưu evidence
 */
app.delete(['/api/v1/jobs/:id/evidence/files/:filename', '/api/v1/tasks/:id/evidence/files/:filename', '/api/v1/jobs/:id/evidence/:filename', '/api/v1/tasks/:id/evidence/:filename'], (req, res) => {
  try {
    const { id, filename } = req.params;
    if (!filename) return res.status(400).json({ success: false, error: 'Filename is required' });
    const safeFilename = path.basename(filename);

    const job = db.getJobById(id);
    if (!job) return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });

    const workspacePath = job.repo_path || job.worktree_path || './';
    let wsFeaturesDir = 'docs/features';
    try {
      const ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id) : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(workspacePath)) : null);
      if (ws && ws.features_dir) wsFeaturesDir = ws.features_dir;
    } catch (e) {}

    const taskCode = job.task_code || job.id;
    const featureDir = fileManager.getFeatureDirectory(workspacePath, taskCode, wsFeaturesDir);
    const taskEvidenceDir = path.join(featureDir, 'evidence');

    // 1. Xoá cứng bản ghi tương ứng trong bảng evidence của SQLite
    try {
      if (typeof db.deleteEvidenceByJobAndFile === 'function') {
        db.deleteEvidenceByJobAndFile(id, safeFilename);
      }
      // Đảm bảo xoá mọi record khớp tên file hoặc id
      const dbInstance = db.getDbInstance ? db.getDbInstance() : null;
      if (dbInstance) {
        dbInstance.prepare(`
          DELETE FROM evidence 
          WHERE job_id = ? AND (id = ? OR data LIKE ? OR data LIKE ?)
        `).run(id, safeFilename, `%${safeFilename}%`, `%${encodeURIComponent(safeFilename)}%`);
      }
    } catch (dbErr) {
      console.warn(`[Evidence Delete] Không thể xoá DB evidence cho job ${id}:`, dbErr.message);
    }

    // 2. Xoá cứng file vật lý trong folder lưu evidence
    const targetFilePath = path.join(taskEvidenceDir, safeFilename);
    if (fs.existsSync(targetFilePath)) {
      try {
        fs.unlinkSync(targetFilePath);
      } catch (unlinkErr) {
        console.warn(`[Evidence Delete] Không thể xoá file vật lý ${targetFilePath}:`, unlinkErr.message);
      }
    }

    // 3. Cập nhật metadata.json trên đĩa
    const metadataPath = path.join(taskEvidenceDir, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
      try {
        const raw = fs.readFileSync(metadataPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter(item => {
            if (!item) return false;
            const name = item.fileName || item.name || item.file || '';
            return name !== safeFilename && !item.filePath?.includes(safeFilename);
          });
          fs.writeFileSync(metadataPath, JSON.stringify(filtered, null, 2), 'utf-8');
        } else if (parsed && typeof parsed === 'object') {
          delete parsed[safeFilename];
          fs.writeFileSync(metadataPath, JSON.stringify(parsed, null, 2), 'utf-8');
        }
      } catch (e) {}
    }

    return res.json({
      success: true,
      message: `Đã xoá cứng bằng chứng '${safeFilename}' khỏi cơ sở dữ liệu và thư mục evidence`,
      jobId: id,
      filename: safeFilename
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH/POST /api/v1/jobs/:id/evidence/files/:filename/status
 * Cập nhật status/verdict cho file evidence trong metadata.json
 */
const handleUpdateEvidenceStatus = (req, res) => {
  try {
    const { id, filename } = req.params;
    if (!filename) return res.status(400).json({ success: false, error: 'Filename is required' });
    const safeFilename = path.basename(filename);

    const job = db.getJobById(id);
    if (!job) return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });

    const workspacePath = job.repo_path || job.worktree_path || './';
    let wsFeaturesDir = 'docs/features';
    try {
      const ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id) : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(workspacePath)) : null);
      if (ws && ws.features_dir) wsFeaturesDir = ws.features_dir;
    } catch (e) {}

    const taskCode = job.task_code || job.id;
    const featureDir = fileManager.getFeatureDirectory(workspacePath, taskCode, wsFeaturesDir);
    const taskEvidenceDir = path.join(featureDir, 'evidence');

    if (!fs.existsSync(taskEvidenceDir)) {
      fs.mkdirSync(taskEvidenceDir, { recursive: true });
    }

    const metadataPath = path.join(taskEvidenceDir, 'metadata.json');
    let metadata = {};
    if (fs.existsSync(metadataPath)) {
      try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch (e) {}
    }

    const body = req.body || {};
    const verdict = body.verdict || (body.status === 'PASSED' ? 'PASS' : (body.status === 'FAILED' ? 'FAIL' : undefined));
    const status = body.status || (body.verdict === 'PASS' ? 'PASSED' : (body.verdict === 'FAIL' ? 'FAILED' : undefined));

    metadata[safeFilename] = {
      ...(metadata[safeFilename] || {}),
      ...(verdict ? { verdict } : {}),
      ...(status ? { status } : {}),
      updated_at: new Date().toISOString()
    };

    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

    return res.json({
      success: true,
      filename: safeFilename,
      metadata: metadata[safeFilename]
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

app.patch(['/api/v1/jobs/:id/evidence/files/:filename/status', '/api/v1/tasks/:id/evidence/files/:filename/status', '/api/v1/jobs/:id/evidence/files/:filename', '/api/v1/tasks/:id/evidence/files/:filename'], handleUpdateEvidenceStatus);
app.post(['/api/v1/jobs/:id/evidence/files/:filename/status', '/api/v1/tasks/:id/evidence/files/:filename/status', '/api/v1/jobs/:id/evidence/files/:filename', '/api/v1/tasks/:id/evidence/files/:filename'], handleUpdateEvidenceStatus);


/**
 * POST /api/v1/jobs/:id/start và POST /api/v1/tasks/:id/start
 * Kích hoạt thực thi task với đầy đủ các bước pipeline
 */
// fs already declared at top
// path already declared at top
const { exec } = require('child_process');

// Đối soát evidence thực tế do Agent thu thập (dùng chung cho bước VERIFY độc lập).
// Trả về { failed: boolean }. TUYỆT ĐỐI KHÔNG tự sinh dummy evidence thay Agent.
const verifyTaskEvidence = ({ jobId, evidenceDir, featureDir, taskCode, emit }) => {
  let failed = false;
        // Tự động lưu đầy đủ các kênh bằng chứng thực tế vào thư mục evidence của task
        try {
          if (!fs.existsSync(evidenceDir)) {
            fs.mkdirSync(evidenceDir, { recursive: true });
          }
  
          // =====================================================================
          // ĐỐI SOÁT EVIDENCE THỰC TẾ DO AGENT TỰ THU THẬP & VERIFY
          // TUYỆT ĐỐI KHÔNG TỰ SINH DUMMY DATA HOẶC TỰ CHỤP ẢNH MOCKUP THAY AGENT
          // =====================================================================
          const getValidEvidenceFiles = () => {
            if (!fs.existsSync(evidenceDir)) return [];
            return fs.readdirSync(evidenceDir).filter(f => {
              if (f === 'metadata.json' || f.startsWith('.')) return false;
              const fullP = path.join(evidenceDir, f);
              try {
                const stat = fs.statSync(fullP);
                if (stat.size <= 10) return false; // File rỗng không coi là evidence
                const ext = path.extname(f).toLowerCase();
                if (ext === '.json') {
                  const raw = fs.readFileSync(fullP, 'utf8').trim();
                  if (!raw || raw === '{}' || raw === '[]' || raw === 'null') return false;
                } else if (ext === '.log' || ext === '.txt') {
                  const raw = fs.readFileSync(fullP, 'utf8').trim();
                  if (!raw) return false;
                }
                return true;
              } catch (e) {
                return false;
              }
            });
          };
  
          // 1. ĐỐI SOÁT CẤU HÌNH YÊU CẦU TRONG TEST_PLAN.MD
          let testPlanText = '';
          const testPlanPath = path.join(featureDir, 'test_plan.md');
          if (fs.existsSync(testPlanPath)) {
            try { testPlanText = fs.readFileSync(testPlanPath, 'utf8'); } catch (e) {}
          }
          const requiresUiScreenshot = /UI_SCREENSHOT/i.test(testPlanText)
            || /Kịch Bản Kiểm Thử Giao Diện/i.test(testPlanText)
            || /UI\/E2E/i.test(testPlanText);
  
          const validFiles = getValidEvidenceFiles();
          let metadataObj = {};
          const metaPath = path.join(evidenceDir, 'metadata.json');
          if (fs.existsSync(metaPath)) {
            try { metadataObj = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {}
          }
  
          // Kiểm tra xem có file ảnh UI thật không
          const uiImageFiles = validFiles.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ['.png', '.jpg', '.jpeg', '.webp'].includes(ext);
          });
  
          // 1. Nếu test_plan yêu cầu chụp ảnh UI mà Agent chưa chụp ảnh thật:
          if (requiresUiScreenshot && uiImageFiles.length === 0) {
            agentFailed = true;
            jobEventBus.emitJobLog(id, {
              text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: Task yêu cầu bằng chứng chụp ảnh UI (UI_SCREENSHOT) nhưng Agent chưa chụp ảnh giao diện thực tế của service hoặc ảnh bị rỗng.\n[TESTING-VERIFY] 🔄 Chuyển sang luồng FIXING để Agent khởi chạy service và chụp ảnh bằng chứng kiểm thử lại!\n`
            });
          }
  
          // 2. Thẩm định metadata BẮT BUỘC CHUNG CHO MỌI TASK: thiếu file, JSON hỏng/rỗng, PARTIAL lấp lửng đều FAIL
          const metaExists = fs.existsSync(metaPath);
          let metaRaw = '';
          let metaParseError = false;
          if (!metaExists) {
            agentFailed = true;
            jobEventBus.emitJobLog(id, {
              text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: Thiếu file evidence/metadata.json bắt buộc. Agent phải tự verify từng evidence khớp test_plan.md và ghi metadata.json trung thực rồi mới được kết thúc TESTING.\n`
            });
          } else {
            try { metaRaw = fs.readFileSync(metaPath, 'utf8').trim(); } catch (e) { metaRaw = ''; }
            if (!metaRaw || metaRaw === '{}' || metaRaw === '[]' || metaRaw === 'null') {
              agentFailed = true;
              jobEventBus.emitJobLog(id, {
                text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: metadata.json rỗng, không chứng minh được test case nào. Chuyển sang FIXING để chạy lại kiểm thử thật!\n`
              });
            } else {
              try {
                metadataObj = JSON.parse(metaRaw);
              } catch (parseErr) {
                metaParseError = true;
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: metadata.json không phải JSON hợp lệ (${String(parseErr.message || parseErr).substring(0, 120)}). Agent phải ghi lại file JSON đúng schema rồi chạy verify lại!\n`
                });
              }
            }
          }
          // Chỉ quét weasel words trong TRƯỜNG TRẠNG THÁI (status/verdict/result/conclusion),
          // KHÔNG quét toàn văn báo cáo để tránh false positive khi văn mô tả nhắc từ như
          // "trước đây lỗi Unknown Error / partial update / không dùng bypass".
          const STATUS_WEASEL_RE = /partial|conditional|not\s*verified|skipped|bypass|unknown\s*error|chưa\s*chạy|chua\s*chay/i;
          const STATUS_KEY_RE = /^(status|verdict|result|conclusion|trang\s*thai|ket\s*luan)$/i;
          const collectStatusValues = (node, out) => {
            const acc = out || [];
            if (!node || typeof node !== 'object') return acc;
            for (const [k, v] of Object.entries(node)) {
              if (STATUS_KEY_RE.test(String(k).trim()) && typeof v === 'string') acc.push(v);
              else if (v && typeof v === 'object') collectStatusValues(v, acc);
            }
            return acc;
          };
          const scanStatusWeasel = (node) => collectStatusValues(node).some(v => STATUS_WEASEL_RE.test(v));
          if (!metaParseError && metaRaw) {
            if (Array.isArray(metadataObj)) {
              if (metadataObj.length === 0) {
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: metadata.json là mảng rỗng, không chứng minh được test case nào!\n`
                });
              } else {
                const hasFailedItem = metadataObj.some(item => item && (item.status === 'FAILED' || item.verdict === 'FAIL' || item.status === 'FAIL' || item.verdict === 'FAILED'));
                if (hasFailedItem) {
                  agentFailed = true;
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: Phát hiện bằng chứng kiểm thử bị đánh dấu FAILED trong metadata.json. Chuyển sang FIXING để sửa lỗi!\n`
                  });
                }
                if (scanStatusWeasel(metadataObj)) {
                  agentFailed = true;
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: metadata.json có trường status/verdict lấp lửng (PARTIAL/CONDITIONAL/NOT VERIFIED/SKIPPED/BYPASS/Unknown Error). Chỉ exit 0 khi 100% case đạt thật!\n`
                  });
                }
              }
            } else if (metadataObj && typeof metadataObj === 'object') {
              const vals = Object.values(metadataObj);
              const hasFailedItem = vals.some(item => item && (item.status === 'FAILED' || item.verdict === 'FAIL' || item.status === 'FAIL' || item.verdict === 'FAILED')) || metadataObj.status === 'FAILED' || metadataObj.verdict === 'FAIL' || metadataObj.verdict === 'FAILED';
              if (hasFailedItem) {
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: Phát hiện bằng chứng kiểm thử bị đánh dấu FAILED trong metadata.json. Chuyển sang FIXING để sửa lỗi!\n`
                });
              }
              const testsArr = Array.isArray(metadataObj.tests) ? metadataObj.tests : [];
              if (testsArr.length > 0) {
                const badTest = testsArr.some(t => !t || !/^(PASSED|PASS)$/i.test(String((t.status || t.verdict || '')).trim()) || scanStatusWeasel(t));
                if (badTest) {
                  agentFailed = true;
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: metadata.json có test case chưa PASSED thật (FAILED/PARTIAL/SKIPPED). Chỉ DONE khi 100% case PASSED!\n`
                  });
                }
                // Mọi file evidence phải được khai báo trong metadata.json để chứng minh mapping với test case
                const declared = new Set();
                testsArr.forEach(t => { (t.evidence || t.evidences || t.files || []).forEach(f => declared.add(String(f))); });
                const undeclared = validFiles.filter(f => f !== 'metadata.json' && ![...declared].some(d => d.includes(f) || f.includes(d)));
                if (undeclared.length > 0) {
                  agentFailed = true;
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: File evidence chưa được khai trong metadata.json nên không chứng minh cho test case nào: ${undeclared.join(', ')}. Agent phải mapping mỗi file với đúng test case trong plan!\n`
                  });
                }
              } else {
                // Bắt buộc schema tests[] non-empty: metadata parse được nhưng không liệt kê case nào là FAIL
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: metadata.json thiếu mảng tests[] non-empty theo schema bắt buộc (mỗi test case trong test_plan.md phải có 1 entry PASSED/FAILED với evidence mapping). Chuyển sang FIXING để bổ sung!\n`
                });
              }
            }
          }
          // 2b. Chặn báo cáo lấp lửng: chỉ xét DÒNG TRẠNG THÁI và Ô BẢNG TRẠNG THÁI trong
          // test_report.md/testcase.md/report.md, không quét toàn văn để tránh oan khi phần
          // diễn giải nguyên nhân nhắc từ như "Unknown Error / partial update / bypass".
          try {
            const reportFiles = ['test_report.md', 'testcase.md', 'report.md'].map(f => path.join(featureDir, f)).filter(p => fs.existsSync(p));
            const STATUS_LINE_RE = /^\s*(?:[-*]\s*)?(trạng thái|trang thai|status|verdict|result|kết luận|ket luan)\s*[:|：]/i;
            const STATUS_CELL_RE = /^(PASSED|PASS|FAILED|FAIL|PARTIAL|CONDITIONAL(\s*PASS)?|NOT\s*VERIFIED|SKIPPED|BYPASS|UNKNOWN\s*ERROR)$/i;
            for (const rp of reportFiles) {
              const txt = fs.readFileSync(rp, 'utf8');
              let hit = '';
              for (const line of txt.split(/\r?\n/)) {
                if (STATUS_LINE_RE.test(line) && STATUS_WEASEL_RE.test(line)) { hit = line.trim().substring(0, 160); break; }
                if (line.includes('|')) {
                  const cells = line.split('|').map(c => c.trim()).filter(c => c && !/^-+$/.test(c));
                  if (cells.some(c => STATUS_CELL_RE.test(c) && STATUS_WEASEL_RE.test(c))) { hit = line.trim().substring(0, 160); break; }
                }
              }
              if (hit) {
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${path.basename(rp)} có trạng thái lấp lửng (PARTIAL/CONDITIONAL/NOT VERIFIED/SKIPPED): "${hit}". Bổ sung môi trường full-stack rồi chạy lại!\n`
                });
                break;
              }
            }
          } catch (e) {}
          // 2c. Chặn log rỗng giả: log chỉ có tên lệnh, stdout=(empty), không keyword test thật
          try {
            const logFiles = validFiles.filter(f => ['.log', '.txt'].includes(path.extname(f).toLowerCase()));
            const LOG_KEY_RE = /browser|capture|screenshot|playwright|puppeteer|navigate|GET\s+\/api|POST\s+\/api|tsc|pytest|npm\s+test|mvn\s+test|go\s+test|passed|failed|assert|✓|✔|PASS/i;
            for (const lf of logFiles) {
              const raw = fs.readFileSync(path.join(evidenceDir, lf), 'utf8');
              const trimmed = (raw || '').trim();
              if (/stdout\s*=\s*\(empty\)/i.test(trimmed) || /\(empty\)/i.test(trimmed) && trimmed.length < 1024 || (trimmed.length < 200 && !LOG_KEY_RE.test(trimmed))) {
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${lf} rỗng giả (stdout empty, thiếu output/keyword test thật). Agent phải chạy lại lệnh test thật và lưu log đầy đủ!\n`
                });
                break;
              }
            }
          } catch (e) {}
          // 2d. Ảnh UI bắt buộc có kích thước tối thiểu để loại ảnh trắng/placeholder 1x1
          try {
            for (const img of uiImageFiles) {
              const st = fs.statSync(path.join(evidenceDir, img));
              if (st.size < 5120) {
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${img} quá nhỏ (${st.size} bytes), nghi là ảnh trắng/placeholder. Agent phải chụp lại giao diện thật có dữ liệu!\n`
                });
                break;
              }
            }
          } catch (e) {}
          // 2e. Chặn ảnh UI trùng lặp nội dung (cùng MD5): 2 PNG giống hệt nhau không chứng minh được 2 case khác nhau
          try {
            const seen = new Map();
            for (const img of uiImageFiles) {
              const buf = fs.readFileSync(path.join(evidenceDir, img));
              const md5 = crypto.createHash('md5').update(buf).digest('hex');
              if (seen.has(md5)) {
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${img} trùng nội dung (MD5 ${md5}) với ${seen.get(md5)} — không chứng minh được test case riêng biệt. Agent phải chụp lại từng kịch bản thật!\n`
                });
                break;
              }
              seen.set(md5, img);
            }
          } catch (e) {}
          // 2f. Đối chiếu số lượng test case trong test_plan.md với metadata.json tests[]
          try {
            const expectedIds = new Set((testPlanText.match(/TC-[A-ZÀ-Ỹ]+-\d+/gi) || []).map(s => s.toUpperCase()));
            const testsArr2 = (!metaParseError && metadataObj && !Array.isArray(metadataObj) && Array.isArray(metadataObj.tests)) ? metadataObj.tests : [];
            if (expectedIds.size > 0 && testsArr2.length > 0) {
              const declaredIds = new Set(testsArr2.map(t => String(t.id || t.test_id || t.case_id || t.caseId || '')).map(s => s.toUpperCase()).filter(Boolean));
              const missing = [...expectedIds].filter(x => !declaredIds.has(x));
              if (missing.length > 0) {
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: metadata.json thiếu ${missing.length} test case trong test_plan.md: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', ...' : ''}. Agent phải chạy và khai đủ mọi case!\n`
                });
              }
            }
          } catch (e) {}
  
          // 3. Nếu không có bất kỳ bằng chứng hợp lệ nào:
          if (validFiles.length === 0) {
            agentFailed = true;
            jobEventBus.emitJobLog(id, {
              text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: Không phát hiện bất kỳ file bằng chứng kiểm thử hợp lệ nào (hoặc dữ liệu rỗng).\n[TESTING-VERIFY] 🔄 Chuyển sang luồng FIXING để thực thi và ghi nhận bằng chứng kiểm thử xác thực!\n`
            });
          }
          // TUYỆT ĐỐI KHÔNG tự động mock/sinh file evidence thay cho Agent.
          // Nếu Agent thiếu evidence hoặc verify thất bại -> agentFailed = true để chuyển FIXING!
        } catch (evWriteErr) {
          console.warn('Ghi bằng chứng cảnh báo:', evWriteErr.message);
        }
  return { failed };
};

const executeStep = async (id) => {
  const job = db.getJobById(id);
  if (!job || job.status === 'CANCELLED') return;
  
  const taskCode = job.task_code || job.id;
  const workspacePath = job.repo_path || job.worktree_path || './';
  let wsFeaturesDir = 'docs/features';
  try {
    const ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id) : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(workspacePath)) : null);
    if (ws && ws.features_dir) wsFeaturesDir = ws.features_dir;
  } catch (e) {}
  const { dir: featureDir, evidenceDir } = fileManager.ensureFeatureDirectory(workspacePath, taskCode, { allowExisting: true, featuresDir: wsFeaturesDir });
  let agentMapping = { PLANNING: 'claude-code', IMPLEMENT: 'claude-code', TESTING: 'claude-code', VERIFY: 'verify-gate', FIXING: 'claude-code' };
  try {
    if (typeof db.getSetting === 'function') {
      const rawMapping = db.getSetting('agent_mapping', agentMapping);
      if (typeof rawMapping === 'string') agentMapping = { ...agentMapping, ...JSON.parse(rawMapping) };
      else if (rawMapping && typeof rawMapping === 'object') agentMapping = { ...agentMapping, ...rawMapping };
    }
  } catch (e) {
    console.warn('[RUNNER] Sử dụng agent mapping mặc định:', e.message);
  }

  try {
    if (job.status === 'PLANNING') {
      const planningAgent = agentMapping.PLANNING || 'claude-code';
      db.updateJob(id, { runner: planningAgent });
      const answeredQuestions = (db.getQuestionsByJobId(id) || []).filter(q => q.status === 'ANSWERED');
      let clarificationContext = '';
      if (answeredQuestions.length > 0) {
        clarificationContext = '\n## CÁC YÊU CẦU ĐÃ ĐƯỢC NGƯỜI DÙNG GIẢI ĐÁP (CLARIFICATION ANSWERS):\n' +
          answeredQuestions.map((q, idx) => `Câu hỏi ${idx+1}: ${q.question}\nCâu trả lời của người dùng: ${q.answer}\n`).join('\n');
      }

      const planningPrompt = promptTemplateManager.buildPrompt({
        step: 'planning', taskCode, userPrompt: (job.prompt || '') + clarificationContext, workspacePath, featureDir,
        previousContext: fileManager.loadPreviousContext(workspacePath, taskCode, 'planning')
      });
      jobEventBus.emitJobLog(id, { text: `\n[1/5] >>> 🤖 [PLANNING] Kích hoạt lập kế hoạch song song (Dual Planning) với Agent: ${planningAgent}\n[PLANNING] Nạp template prompt planning.md...\n[PLANNING] Agent đang phân tích mã nguồn và thiết lập Kế hoạch (Vui lòng đợi khoảng 15-30 giây)...\n` });
      const planStartTime = Date.now();
      const planProgressTimer = setInterval(() => {
        const cur = db.getJobById(id);
        if (!cur || cur.status === 'CANCELLED') {
          clearInterval(planProgressTimer);
          return;
        }
        const elapsedSec = Math.floor((Date.now() - planStartTime) / 1000);
        jobEventBus.emitJobLog(id, { text: `\x1b[90m🤖 [PLANNING] ⏱️ ${elapsedSec}s - Agent đang tiếp tục xử lý phân tích và tổng hợp Kế hoạch...\x1b[0m\r\n` });
      }, 12000);
      const runner = runnerRegistry.getAvailableRunner(planningAgent);
      if (runner) {
        let outBuffer = '';
        try {
          await runner.execute({
            prompt: planningPrompt, cwd: workspacePath, jobId: id,
            onStdout: (text) => { outBuffer += text; jobEventBus.emitJobLog(id, { text }); },
            onStderr: (text) => { outBuffer += text; jobEventBus.emitJobLog(id, { text }); }
          });
        } catch (runnerErr) {
          jobEventBus.emitJobLog(id, { text: `[PLANNING] Thông báo runner: ${runnerErr.message}\n` });
        }
        clearInterval(planProgressTimer);
        const checkAfterPlan = db.getJobById(id);
        if (checkAfterPlan && checkAfterPlan.status === 'CANCELLED') {
          return;
        }
        // Trích xuất dev_plan.md và test_plan.md từ stdout nếu chưa được tạo trên ổ cứng
        let planFiles = fileManager.readPlanFiles(workspacePath, taskCode);
        let effectiveDevPlan = planFiles.devPlan || planFiles.dev_plan || '';
        let effectiveTestPlan = planFiles.testPlan || planFiles.test_plan || '';

        // Nếu một trong 2 plan bị thiếu hoặc rỗng (chỉ có dòng tiêu đề < 60 ký tự)
        if (!effectiveDevPlan || effectiveDevPlan.trim().length < 60 || !effectiveTestPlan || effectiveTestPlan.trim().length < 60) {
          const devMatch = outBuffer.match(/# (Dev Plan|Kế hoạch triển khai)[\s\S]*?(?=# (Test Plan|Kế hoạch kiểm thử)|$)/i);
          const testMatch = outBuffer.match(/# (Test Plan|Kế hoạch kiểm thử)[\s\S]*?(?=$)/i);

          const { DualPlanningGenerator } = require('./pipeline/dualPlanning');
          const gen = new DualPlanningGenerator({ baseOutputDir: featureDir });

          // Nếu chưa có devPlan tử tế, thử lấy từ stdout hoặc sinh mẫu
          if (!effectiveDevPlan || effectiveDevPlan.trim().length < 60) {
            if (devMatch) {
              effectiveDevPlan = devMatch[0];
            } else {
              const generatedDev = gen.generateDevPlan({ featureName: taskCode, prompt: job.prompt || taskCode });
              effectiveDevPlan = generatedDev.content;
            }
            fs.writeFileSync(path.join(featureDir, 'dev_plan.md'), effectiveDevPlan, 'utf8');
          }

          // Nếu chưa có testPlan tử tế (như trường hợp agent chỉ ghi 1 dòng tiêu đề), tự động sinh đầy đủ
          if (!effectiveTestPlan || effectiveTestPlan.trim().length < 60) {
            if (testMatch && testMatch[0].trim().length >= 60) {
              effectiveTestPlan = testMatch[0];
            } else {
              const generatedTest = gen.generateTestPlan({
                featureName: taskCode,
                prompt: job.prompt || taskCode,
                devPlan: effectiveDevPlan
              });
              effectiveTestPlan = generatedTest.content;
            }
            fs.writeFileSync(path.join(featureDir, 'test_plan.md'), effectiveTestPlan, 'utf8');
          }
          planFiles = fileManager.readPlanFiles(workspacePath, taskCode);
        }

        // Trích xuất JSON questions nếu có
        const qMatch = outBuffer.match(/```json:questions\n([\s\S]*?)```/);
        if (qMatch) {
          try {
            const questionsArray = JSON.parse(qMatch[1]);
            if (Array.isArray(questionsArray) && questionsArray.length > 0) {
              db.addQuestion({
                job_id: id,
                question: JSON.stringify(questionsArray),
                options: '[]',
                status: 'PENDING'
              });
              const pendingQ = db.getPendingQuestionByJobId(id);
              if (pendingQ) {
                jobEventBus.emitJobQuestion(id, pendingQ);
              }
            }
          } catch (e) {
            console.warn('[PLANNING] Lỗi parse json:questions:', e);
          }
        }

        db.saveDualPlan({
          job_id: id,
          dev_plan: planFiles.devPlan || planFiles.dev_plan || effectiveDevPlan || '',
          test_plan: planFiles.testPlan || planFiles.test_plan || effectiveTestPlan || '',
          status: 'GENERATED'
        });
        jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Đã ghi dev_plan.md và test_plan.md đầy đủ. Lưu metadata Dual Plan vào DB thành công.\n` });
      } else {
        jobEventBus.emitJobLog(id, { text: `[PLANNING-WARN] Không tìm thấy runner hợp lệ cho ${planningAgent}\n` });
      }

      // Kiểm tra xem còn câu hỏi PENDING nào chưa được giải đáp không
      const pendingQuestions = (db.getQuestionsByJobId(id) || []).filter(q => q.status === 'PENDING');
      if (pendingQuestions.length > 0) {
        // Còn câu hỏi cần làm rõ -> Chuyển PENDING để chờ người dùng phản hồi
        db.updateJob(id, { status: 'PENDING', current_step: 'PENDING', had_pending: 1 });
        jobEventBus.emitJobStatus(id, { status: 'PENDING' });
        jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Agent đã tạo câu hỏi làm rõ. Chuyển sang PENDING chờ người dùng phản hồi...\n` });
        return;
      }

      // Nếu không còn câu hỏi PENDING (hoặc các câu hỏi đã được giải đáp xong):
      // Tự động hoàn thành Kế hoạch và chuyển tiếp sang bước IMPLEMENT để chạy tiếp
      const implementAgent = agentMapping.IMPLEMENT || 'claude-code';
      db.updateJob(id, { status: 'IMPLEMENT', current_step: 'IMPLEMENT', runner: implementAgent, had_pending: (answeredQuestions.length > 0 ? 1 : (job.had_pending || 0)) });
      jobEventBus.emitJobStatus(id, { status: 'IMPLEMENT', runner: implementAgent });
      jobEventBus.emitJobLog(id, { text: `\n[PLANNING -> IMPLEMENT] Hoàn tất Kế hoạch sau khi làm rõ. Tự động chuyển tiếp sang triển khai mã nguồn (IMPLEMENT) với 🤖 Agent: ${implementAgent}...\n` });
      setTimeout(() => executeStep(id), 100);
      return;
    }

    if (job.status === 'IMPLEMENT') {
      const prevContext = fileManager.loadPreviousContext(workspacePath, taskCode, 'implement');
      const planFiles = fileManager.readPlanFiles(workspacePath, taskCode);
      const devPlanText = (planFiles && planFiles.devPlan) || (typeof prevContext === 'string' ? prevContext : '');
      const isReadOnlyOrVerification =
        /không phát sinh can thiệp mã nguồn|không cần sửa.*mã nguồn|không chỉnh sửa.*mã nguồn|không can thiệp.*mã nguồn/i.test(devPlanText) ||
        /^(kiểm tra|xác minh|test|check|ping|khảo sát)\s/i.test(job.prompt || '');

      if (isReadOnlyOrVerification) {
        jobEventBus.emitJobLog(id, {
          text: `\n[2/5] >>> 🤖 [IMPLEMENT] Phân tích Dev Plan xác nhận: Task thuộc diện Thẩm định / Vận hành / Không phát sinh can thiệp mã nguồn.\n[IMPLEMENT] Đã hoàn tất thẩm định phạm vi. Tự động chuyển tiếp trực tiếp sang bước [TESTING] để kiểm tra thực tế!\n`
        });
        const testAgent = agentMapping.TESTING || 'test-runner';
        db.updateJob(id, { status: 'TESTING', current_step: 'TESTING', runner: testAgent });
        jobEventBus.emitJobStatus(id, { status: 'TESTING', runner: testAgent });
        setTimeout(() => executeStep(id), 200);
        return;
      }

      const implementAgent = agentMapping.IMPLEMENT || 'claude-code';
      const implementPrompt = promptTemplateManager.buildPrompt({
        step: 'implement', taskCode, userPrompt: job.prompt || '', workspacePath, featureDir,
        previousContext: prevContext
      });
      db.updateJob(id, { runner: implementAgent });
      const impProgressTimer = setInterval(() => {
        const cur = db.getJobById(id);
        if (!cur || cur.status === 'CANCELLED') {
          clearInterval(impProgressTimer);
          return;
        }
        jobEventBus.emitJobLog(id, { text: `🤖 [IMPLEMENT] Agent đang tiếp tục viết mã nguồn...\n` });
      }, 6000);
      const runner = runnerRegistry.getAvailableRunner(implementAgent);
      if (runner) {
        let implementResult = null;
        try {
          implementResult = await runner.execute({
            prompt: implementPrompt, cwd: workspacePath, jobId: id,
            onStdout: (text) => jobEventBus.emitJobLog(id, { text }),
            onStderr: (text) => jobEventBus.emitJobLog(id, { text })
          });
        } catch (execErr) {
          jobEventBus.emitJobLog(id, { text: `[IMPLEMENT] Loi thuc thi: ${execErr.message}\n` });
          db.updateJob(id, { status: 'FAILED', current_step: 'IMPLEMENT', error_message: `IMPLEMENT that bai: ${execErr.message}` });
          jobEventBus.emitJobStatus(id, { status: 'FAILED' });
          jobEventBus.emitJobError(id, { error: `IMPLEMENT that bai: ${execErr.message}` });
          return;
        } finally {
          clearInterval(impProgressTimer);
        }
        const checkAfterImp = db.getJobById(id);
        if (checkAfterImp && checkAfterImp.status === 'CANCELLED') {
          return;
        }
        // IMPLEMENT that bai (timeout hoac exit code != 0) thi DUNG pipeline, khong tu dong sang TESTING
        if (!implementResult || implementResult.timedOut || implementResult.exitCode !== 0) {
          const failReason = implementResult && implementResult.timedOut
            ? `vuot qua gioi han thoi gian (${implementResult.timeoutMs || 900000}ms)`
            : `exit code ${implementResult ? implementResult.exitCode : 'khong xac dinh'}`;
          jobEventBus.emitJobLog(id, { text: `\n[IMPLEMENT-FAILED] Trien khai that bai (${failReason}). Pipeline DUNG tai IMPLEMENT, vui long kiem tra log va chay lai.\n` });
          db.updateJob(id, { status: 'FAILED', current_step: 'IMPLEMENT', error_message: `IMPLEMENT that bai: ${failReason}` });
          jobEventBus.emitJobStatus(id, { status: 'FAILED' });
          jobEventBus.emitJobError(id, { error: `IMPLEMENT that bai: ${failReason}` });
          return;
        }
        jobEventBus.emitJobLog(id, { text: `\n[IMPLEMENT] Hoan tat trien khai ma nguon.\n` });
      } else {
        clearInterval(impProgressTimer);
        jobEventBus.emitJobLog(id, { text: `\n[IMPLEMENT-WARN] Khong tim thay runner hop le cho ${implementAgent}\n` });
      }
      db.updateJob(id, { status: 'TESTING', current_step: 'TESTING' });
      jobEventBus.emitJobStatus(id, { status: 'TESTING' });
      setTimeout(() => executeStep(id), 100);
      return;
    }

    if (job.status === 'TESTING') {
      const checkBeforeTest = db.getJobById(id);
      if (checkBeforeTest && checkBeforeTest.status === 'CANCELLED') return;

      const testAgent = agentMapping.TESTING || 'claude-code';
      const testingPrompt = promptTemplateManager.buildPrompt({
        step: 'testing', taskCode, userPrompt: job.prompt || '', workspacePath, featureDir,
        previousContext: fileManager.loadPreviousContext(workspacePath, taskCode, 'testing'),
        errorLogs: ''
      });
      db.updateJob(id, { runner: testAgent });
      jobEventBus.emitJobLog(id, { text: `\n[3/5] >>> 🤖 [TESTING] Bắt đầu kiểm thử thật với Runner/Agent: ${testAgent}...\n` });

      const testProgressTimer = setInterval(() => {
        const cur = db.getJobById(id);
        if (!cur || cur.status === 'CANCELLED') {
          clearInterval(testProgressTimer);
          return;
        }
        jobEventBus.emitJobLog(id, { text: `🤖 [TESTING] Agent đang tiếp tục kiểm thử...\n` });
      }, 6000);

      const runner = runnerRegistry.getAvailableRunner(testAgent);
      let testingResult = null;
      let agentFailed = false;

      if (runner) {
        try {
          testingResult = await runner.execute({
            prompt: testingPrompt, cwd: workspacePath, jobId: id,
            timeoutMs: 900000,
            onStdout: (text) => jobEventBus.emitJobLog(id, { text }),
            onStderr: (text) => jobEventBus.emitJobLog(id, { text })
          });
        } catch (execErr) {
          agentFailed = true;
          jobEventBus.emitJobLog(id, { text: `[TESTING] Lỗi thực thi Agent: ${execErr.message}\n` });
          testingResult = { output: execErr.message, exitCode: 1 };
        } finally {
          clearInterval(testProgressTimer);
        }

        const checkAfterTest = db.getJobById(id);
        if (checkAfterTest && checkAfterTest.status === 'CANCELLED') {
          return;
        }

        if (!testingResult || testingResult.timedOut || testingResult.exitCode !== 0) {
          agentFailed = true;
          const failReason = testingResult && testingResult.timedOut
            ? `vượt quá giới hạn thời gian (${testingResult.timeoutMs || 900000}ms)`
            : `exit code ${testingResult ? testingResult.exitCode : 'không xác định'}`;
          jobEventBus.emitJobLog(id, { text: `\n[TESTING-FAILED] Kiểm thử thất bại: ${failReason}.\n` });
        } else {
          jobEventBus.emitJobLog(id, { text: `\n[TESTING] Hoàn tất kiểm thử qua Agent.\n` });
        }
      } else {
        clearInterval(testProgressTimer);
        agentFailed = true;
        jobEventBus.emitJobLog(id, { text: `\n[TESTING-WARN] Không tìm thấy runner hợp lệ cho ${testAgent}\n` });
        testingResult = { output: `Không tìm thấy runner hợp lệ cho ${testAgent}`, exitCode: 1 };
        
        const checkAfterTest = db.getJobById(id);
        if (checkAfterTest && checkAfterTest.status === 'CANCELLED') return;
      }

      // TESTING chỉ chạy agent kiểm thử; đối soát evidence dời sang bước VERIFY độc lập.
      if (agentFailed) {
        // Agent lỗi ngay (timeout/exit!=0/thiếu runner): vẫn đi qua VERIFY để ghi nhận đầy đủ.
        jobEventBus.emitJobLog(id, { text: `\n[TESTING] Agent kiểm thử báo lỗi, chuyển sang [VERIFY] để đối soát evidence...\n` });
      } else {
        jobEventBus.emitJobLog(id, { text: `\n[TESTING] Hoàn tất kiểm thử qua Agent, chuyển sang [VERIFY] để đối soát evidence...\n` });
      }
      const verifyAgent = 'verify-gate';
      db.updateJob(id, { status: 'VERIFY', current_step: 'VERIFY', runner: verifyAgent });
      jobEventBus.emitJobStatus(id, { status: 'VERIFY', runner: verifyAgent });
      jobEventBus.emitJobLog(id, { text: `\n[3/5] >>> 🔍 [VERIFY] Bắt đầu đối soát evidence thực tế trong ${evidenceDir}...\n` });
      setTimeout(() => executeStep(id), 100);
      return;
    }

    if (job.status === 'VERIFY') {
      const checkVerify = db.getJobById(id);
      if (checkVerify && checkVerify.status === 'CANCELLED') return;
      const { failed: verifyFailed } = verifyTaskEvidence({
        jobId: id, evidenceDir, featureDir, taskCode,
        emit: (text) => jobEventBus.emitJobLog(id, { text })
      });
      if (verifyFailed) {
        const fixAgent = agentMapping.FIXING || 'claude-code';
        const failGate = { passed: false, error: 'Đối soát evidence thất bại (VERIFY)', timeout: false, decided_at: new Date().toISOString(), mapped_from: 'VERIFY', source: 'pipeline-verify-evidence' };
        jobEventBus.emitJobLog(id, { text: `\n[VERIFY] ❌ Đối soát evidence thất bại. Chuyển sang FIXING với 🤖 Agent: ${fixAgent}.\n` });
        db.updateJob(id, { status: 'FIXING', current_step: 'FIXING', runner: fixAgent, error_message: 'Đối soát evidence thất bại (VERIFY).', gate_result: failGate });
        jobEventBus.emitJobStatus(id, { status: 'FIXING', runner: fixAgent });
        setTimeout(() => executeStep(id), 100);
        return;
      }
      // Lưu path gọn nhẹ vào SQLite DB (chỉ lưu đường dẫn, KHÔNG lưu payload lớn)
      const relEvidencePath = `docs/features/${taskCode}/evidence`;
      const dbEv = db.addEvidence({
        job_id: id,
        type: 'VERIFY_EVIDENCE',
        verdict: 'PASS',
        data: { path: relEvidencePath, taskCode }
      });
      jobEventBus.emitJobEvidence(id, { evidence: dbEv });
      jobEventBus.emitJobLog(id, { text: `\n[VERIFY] ✅ Đã đối soát bằng chứng thành công trong ${relEvidencePath}!\n` });
      const currentRunner = job.runner || (agentMapping.IMPLEMENT || 'claude-code');
      db.updateJob(id, { status: 'DONE', current_step: 'COMPLETED', runner: currentRunner, completed_at: new Date().toISOString(), error_message: null, gate_result: { passed: true, error: null, timeout: false, decided_at: new Date().toISOString(), mapped_from: 'VERIFY', source: 'pipeline-verify-evidence' } });
      jobEventBus.emitJobDone(id, { status: 'DONE', runner: currentRunner, message: `Task ${taskCode} đã hoàn thành đối soát evidence.` });
      jobEventBus.emitJobLog(id, { text: `\n================================================================================\n[5/5] >>> 🏆 [DONE] Nhiệm vụ ${taskCode} ĐÃ HOÀN THÀNH TOÀN DIỆN VÀ NGHIỆM THU THÀNH CÔNG!\n================================================================================\n` });
      return;
    }

    if (job.status === 'FIXING') {
      const fixingAgent = agentMapping.FIXING || 'claude-code';
      const fixingPrompt = promptTemplateManager.buildPrompt({
        step: 'fixing', taskCode, userPrompt: job.prompt || '', workspacePath, featureDir,
        previousContext: fileManager.loadPreviousContext(workspacePath, taskCode, 'fixing'),
        errorLogs: job.error_message || ''
      });
      db.updateJob(id, { runner: fixingAgent });
      jobEventBus.emitJobLog(id, { text: `\n[ERROR] Phát hiện sự cố. Đang sửa lỗi với 🤖 Agent: ${fixingAgent}...\n` });
      const runner = runnerRegistry.getAvailableRunner(fixingAgent);
      if (runner) {
        await runner.execute({
          prompt: fixingPrompt, cwd: workspacePath, jobId: id,
          onStdout: (text) => jobEventBus.emitJobLog(id, { text }),
          onStderr: (text) => jobEventBus.emitJobLog(id, { text })
        });
        jobEventBus.emitJobLog(id, { text: `\n[FIXING] Hoàn tất sửa lỗi.\n` });
        const checkAfterFix = db.getJobById(id);
        if (checkAfterFix && checkAfterFix.status === 'CANCELLED') {
          return;
        }
      } else {
        jobEventBus.emitJobLog(id, { text: `\n[FIXING-WARN] Không tìm thấy runner hợp lệ.\n` });
      }

      // Quay lại TESTING
      db.updateJob(id, { status: 'TESTING', current_step: 'TESTING' });
      jobEventBus.emitJobStatus(id, { status: 'TESTING' });
      setTimeout(() => executeStep(id), 100);
      return;
    }

  } catch (err) {
    const checkCancelled = db.getJobById(id);
    if (checkCancelled && checkCancelled.status === 'CANCELLED') {
      return;
    }
    console.error('Lỗi pipeline task:', err);
    db.updateJob(id, { status: 'FAILED', error_message: err.message, gate_result: { passed: false, error: err.message, timeout: /timeout|timed\s*out|etimedout/i.test(err.message || ''), decided_at: new Date().toISOString(), mapped_from: 'FAILED', source: 'pipeline-catch' } });
    jobEventBus.emitJobStatus(id, { status: 'FAILED' });
    jobEventBus.emitJobError(id, { error: err.message });
  }
};

/**
 * Chạy toàn bộ vòng đời pipeline của một Task qua TaskQueue
 * Trả về Promise hoàn thành khi Task đạt trạng thái kết thúc (DONE, FAILED, CANCELLED, TIMED_OUT)
 */
const TERMINAL_JOB_STATUSES = new Set(['DONE', 'TIMED_OUT', 'ARCHIVED', 'DELETED']);
const RESTARTABLE_JOB_STATUSES = new Set(['TO DO', 'TO_DO', 'FAILED', 'CANCELLED']);
const runJobPipeline = (jobId) => {
  return new Promise((resolve) => {
    const jobToStart = db.getJobById(jobId);
    const tCode = (jobToStart && (jobToStart.task_code || jobToStart.id)) || jobId;
    const currentStatus = ((jobToStart && jobToStart.status) || '').toString().trim().toUpperCase();
    // Job đã ở trạng thái kết thúc (DONE/TIMED_OUT/ARCHIVED/DELETED): không có nhánh
    // executeStep nào xử lý nên resolve ngay, tránh treo Promise và khóa chết workspace.
    if (TERMINAL_JOB_STATUSES.has(currentStatus)) {
      console.log(`[PIPELINE-SKIP] Task ${tCode} (${jobId}) đã ở trạng thái kết thúc ${currentStatus}, không chạy lại pipeline.`);
      resolve({ status: jobToStart.status, skipped: true });
      return;
    }
    console.log(`[PIPELINE-START] Bắt đầu thực thi pipeline cho Task ${tCode} (${jobId})...`);

    // Nếu đang TO DO, FAILED, CANCELLED hoặc rỗng thì bắt đầu chuyển PLANNING
    if (!jobToStart.status || RESTARTABLE_JOB_STATUSES.has(currentStatus)) {
      db.updateJob(jobId, { status: 'PLANNING', current_step: 'PLANNING', error_message: null });
      jobEventBus.emitJobStatus(jobId, { status: 'PLANNING' });
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onStatus = ({ status }) => {
      if (['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(status)) {
        finish({ status });
      }
    };
    const onDone = () => finish({ status: 'DONE' });
    const onError = (err) => finish({ status: 'FAILED', error: err });
    const onCancel = ({ jobId: cId }) => {
      if (cId === jobId) finish({ status: 'CANCELLED' });
    };

    const cleanup = () => {
      jobEventBus.off(`job:${jobId}:status`, onStatus);
      jobEventBus.off(`job:${jobId}:done`, onDone);
      jobEventBus.off(`job:${jobId}:error`, onError);
      taskQueue.off('job:cancel', onCancel);
    };

    jobEventBus.on(`job:${jobId}:status`, onStatus);
    jobEventBus.on(`job:${jobId}:done`, onDone);
    jobEventBus.on(`job:${jobId}:error`, onError);
    taskQueue.on('job:cancel', onCancel);

    executeStep(jobId).catch((err) => {
      console.error(`[EXECUTE-STEP-ERR] Lỗi khi thực thi pipeline cho Job ${jobId}:`, err);
      db.updateJob(jobId, { status: 'FAILED', error_message: err.message });
      jobEventBus.emitJobStatus(jobId, { status: 'FAILED' });
      jobEventBus.emitJobError(jobId, { error: err.message });
      finish({ status: 'FAILED', error: err });
    });
  });
};

const handleJobStart = async (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) return res.status(404).json({ success: false, error: `Task with ID '${id}' not found` });

    const taskCode = job.task_code || job.id;
    console.log(`[TASK-START] Yêu cầu kích hoạt Task ${taskCode} (Job ID: ${id})...`);

    // 1. Kiểm tra xem job đã nằm trong hàng đợi hoặc đang chạy chưa
    if (taskQueue.isJobEnqueuedOrRunning(id)) {
      return res.json({
        success: true,
        message: `Task '${taskCode}' đang nằm trong hàng đợi hoặc đang thực thi!`,
        jobId: id,
        taskCode,
        status: job.status,
        queued: true
      });
    }

    // 1b. Từ chối Start trên task đang chờ phản hồi (PENDING) hoặc đã kết thúc (DONE/TIMED_OUT/ARCHIVED/DELETED):
    // runJobPipeline sẽ resolve-skipped ngay (không có nhánh executeStep cho terminal),
    // enqueue lúc này chỉ chiếm slot queue và giữ lock vô ích.
    const startStatusNorm = ((job && job.status) || '').toString().trim().toUpperCase();
    if (startStatusNorm === 'PENDING') {
      return res.status(400).json({
        success: false,
        error: `Task '${taskCode}' đang chờ phản hồi (PENDING). Hãy trả lời câu hỏi hoặc duyệt kế hoạch thay vì Start lại!`
      });
    }
    if (TERMINAL_JOB_STATUSES.has(startStatusNorm)) {
      return res.status(400).json({
        success: false,
        error: `Task '${taskCode}' đã ở trạng thái kết thúc ${job.status}, không thể Start lại. Hãy Clone sang mã mới để chạy lại!`
      });
    }

     // 2. Kiểm tra xem workspace có đang bị khóa bởi task khác không (Workspace Queue Lock)
    const isLocked = taskQueue.isWorkspaceLocked(job);
    if (isLocked) {
      const activeJob = taskQueue.getActiveJobForWorkspace(job);
      const activeCode = (activeJob && (activeJob.task_code || activeJob.id)) || 'khác';
      jobEventBus.emitJobLog(id, {
        text: `\n[WORKSPACE-LOCK] ⏳ Workspace đang được thực thi bởi Task '${activeCode}'. Task '${taskCode}' đã được xếp vào hàng đợi chờ tới lượt (Workspace Lock)...\n`,
        level: 'info'
      });
    }

    // 3. Đưa job vào TaskQueue để quản lý Concurrency & Workspace Queue Lock
    taskQueue.enqueue(job, () => runJobPipeline(id), job.priority || 0);

    return res.json({
      success: true,
      message: isLocked
        ? `Task '${taskCode}' đã được xếp vào hàng đợi do Workspace đang bận!`
        : `Task '${taskCode}' đã được kích hoạt thành công!`,
      jobId: id,
      taskCode,
      status: isLocked ? (job.status || 'TO DO') : 'PLANNING',
      queued: isLocked
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/v1/jobs/:id/start', handleJobStart);
app.post('/api/v1/tasks/:id/start', handleJobStart);

/**
 * POST /api/v1/jobs/:id/clone
 * Nhân bản (Clone) task cũ sang một Task Code mới ở trạng thái TO DO
 */
const handleJobClone = async (req, res) => {
  try {
    const { id } = req.params;
    const { newTaskCode } = req.body;

    if (!newTaskCode || typeof newTaskCode !== 'string' || !newTaskCode.trim()) {
      return res.status(400).json({ success: false, error: 'Mã task mới (Task Code) là bắt buộc' });
    }

    const safeNewTaskCode = newTaskCode.trim();

    // Kiểm tra trùng mã bằng lookup trực tiếp (tránh db.listJobs() bị giới hạn limit/offset làm sai check trùng)
    const directHit = db.getJobById ? db.getJobById(safeNewTaskCode) : null;
    if (directHit) {
      return res.status(400).json({ success: false, error: `Mã task '${safeNewTaskCode}' đã tồn tại trong hệ thống. Vui lòng chọn mã khác.` });
    }

    const sourceJob = db.getJobById(id);
    if (!sourceJob) {
      return res.status(404).json({ success: false, error: `Không tìm thấy task gốc với ID '${id}'` });
    }

    const newJobId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    let pipeConfig = {};
    if (sourceJob.pipeline_config) {
      try {
        pipeConfig = typeof sourceJob.pipeline_config === 'string'
          ? JSON.parse(sourceJob.pipeline_config)
          : sourceJob.pipeline_config;
      } catch (e) {}
    }

    const promptLines = (sourceJob.prompt || '').trim().split('\n');
    const titleSummary = promptLines[0] ? promptLines[0].substring(0, 60) : `Task ${safeNewTaskCode}`;

    const newJobData = {
      id: newJobId,
      task_code: safeNewTaskCode,
      title: `[${safeNewTaskCode}] ${titleSummary}`,
      prompt: sourceJob.prompt || '',
      repo_path: sourceJob.repo_path || './',
      workspace_id: sourceJob.workspace_id || null,
      base_branch: sourceJob.base_branch || sourceJob.branch || 'main',
      runner: sourceJob.runner || 'claude-code',
      status: 'TO DO',
      current_step: null,
      error_message: null,
      exit_code: null,
      completed_at: null,
      summary: null,
      had_pending: 0,
      pipeline_config: JSON.stringify(pipeConfig),
      created_at: nowIso,
      updated_at: nowIso
    };

    const createdJob = db.createJob(newJobData);
    const responseJob = createdJob || newJobData;
    // Tạo thư mục features/<safeNewTaskCode> HOÀN TOÀN TRỐNG (chưa có bất kỳ dữ liệu gì trong folder đó)
    try {
      const workspacePath = sourceJob.repo_path || './';
      let wsFeaturesDir = 'docs/features';
      if (sourceJob.workspace_id) {
        const ws = db.getWorkspaceById(sourceJob.workspace_id);
        if (ws && ws.features_dir) wsFeaturesDir = ws.features_dir;
      }
      const newFeatureDir = fileManager.getFeatureDirectory(workspacePath, safeNewTaskCode, wsFeaturesDir);
      if (!fs.existsSync(newFeatureDir)) {
        fs.mkdirSync(newFeatureDir, { recursive: true });
      }
    } catch (dirErr) {
      console.warn('[Clone Task] Cảnh báo tạo thư mục feature mới:', dirErr.message);
    }
    jobEventBus.emitJobCreated(responseJob);
    return res.status(201).json({
      success: true,
      message: `Nhân bản task thành công thành '${safeNewTaskCode}' ở trạng thái TO DO`,
      job: responseJob
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/v1/jobs/:id/clone', handleJobClone);
app.post('/api/v1/tasks/:id/clone', handleJobClone);
/**
 * POST /api/v1/jobs/:id/cancel
 * Hủy job đang chạy hoặc trong hàng đợi
 */
app.post('/api/v1/jobs/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);

    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }

    // 1. Hủy trong taskQueue
    taskQueue.cancel(id);

    // 2. Cập nhật trạng thái CANCELLED trong DB ngay lập tức
    try {
      if (canTransition(job.status, JOB_STATUSES.CANCELLED)) {
        transition(id, JOB_STATUSES.CANCELLED, db);
      } else {
        db.updateJob(id, {
          status: JOB_STATUSES.CANCELLED,
          completed_at: new Date().toISOString()
        });
      }
    } catch (e) {
      db.updateJob(id, {
        status: JOB_STATUSES.CANCELLED,
        completed_at: new Date().toISOString()
      });
    }

    // 3. Phát event SSE cập nhật giao diện
    jobEventBus.emitJobStatus(id, { status: JOB_STATUSES.CANCELLED });
    jobEventBus.emitJobLog(id, {
      text: `\n[CANCEL] Job đã bị hủy theo yêu cầu của người dùng.\n`,
      level: 'warn'
    });

    // 4. Ngắt an toàn toàn bộ tiến trình con (process tree 2-phase: SIGTERM -> grace 5000ms -> SIGKILL)
    let killedCount = 0;
    try {
      const { defaultProcessManager } = require('./execution/processManager');
      if (defaultProcessManager) {
        killedCount = await defaultProcessManager.killProcessesByJobId(id, 5000);
      }
    } catch (e) {
      console.warn('[SERVER] Không thể gọi processManager khi cancel:', e);
    }

    jobEventBus.emitJobLog(id, {
      text: `[CANCEL] Đã dừng tiến trình con (process tree) của job (số tiến trình đã hủy: ${killedCount}).\n`,
      level: 'warn'
    });

    const updatedJob = db.getJobById(id);
    return res.json({
      success: true,
      message: 'Job đã được hủy bỏ thành công',
      killedProcesses: killedCount,
      job: updatedJob
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/jobs/:id/answer
 * Trả lời câu hỏi clarifying khi job ở trạng thái PENDING
 */
app.post('/api/v1/jobs/:id/answer', (req, res) => {
  try {
    const { id } = req.params;
    const { answer, question_id, questionId, text, selectedOptions, answers } = req.body;

    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }

    // Cho phép nhận mảng câu trả lời `answers` hoặc các định dạng cũ
    const finalAnswer = answers !== undefined ? answers : (answer !== undefined ? answer : (text || selectedOptions));
    if (finalAnswer === undefined || finalAnswer === null || finalAnswer === '' || (typeof finalAnswer === 'object' && Object.keys(finalAnswer).length === 0)) {
      return res.status(400).json({ success: false, error: 'Câu trả lời không được để trống' });
    }

    // Tìm câu hỏi cần trả lời
    const targetQId = question_id || questionId;
    let targetQuestion = null;
    if (targetQId) {
      const allQ = db.getQuestionsByJobId(id);
      targetQuestion = allQ.find((q) => q.id === targetQId) || null;
    }
    if (!targetQuestion) {
      targetQuestion = db.getPendingQuestionByJobId(id);
    }

    // Lưu vào database nếu có câu hỏi
    if (targetQuestion) {
      db.answerQuestion(targetQuestion.id, finalAnswer);
    }

    // Chuyển tiếp tới ClarificationManager nếu đang có câu hỏi pending trong memory
    try {
      const { ClarificationManager } = require('./execution/clarificationManager');
      // Nếu có singleton hoặc instance
      if (ClarificationManager) {
        // Thông báo submit answer
      }
    } catch (e) {
      // Bỏ qua
    }


    // Phát event qua SSE
    jobEventBus.emitJobQuestion(id, {
      status: 'ANSWERED',
      answer: finalAnswer,
      questionId: targetQuestion ? targetQuestion.id : null
    });

    jobEventBus.emitJobStatus(id, { status: 'IMPLEMENT' });

    jobEventBus.emitJobLog(id, {
      text: `\n[CLARIFICATION] Đã nhận câu trả lời từ người dùng: ${typeof finalAnswer === 'object' ? JSON.stringify(finalAnswer) : finalAnswer}\n` +
            `[CLARIFICATION] Tự động tiếp tục PLANNING với thông tin đã giải đáp để hoàn thiện Kế hoạch và chạy tiếp...\n`
    });

    db.updateJob(id, { status: 'PLANNING', current_step: 'PLANNING', had_pending: 1 });
    jobEventBus.emitJobStatus(id, { status: 'PLANNING' });

    // Tiếp tục PLANNING: nếu pipeline còn giữ lock (job đang running) thì chạy tiếp trực tiếp;
    // nếu server vừa restart làm mất queue thì đi qua TaskQueue để tôn trọng Workspace Lock.
    setImmediate(() => {
      if (taskQueue.isJobEnqueuedOrRunning(id)) {
        executeStep(id).catch(err => {
          console.error(`[EXECUTE-STEP-ERR] Lỗi khi tiếp tục PLANNING cho Job ${id}:`, err);
        });
      } else {
        const freshJob = db.getJobById(id);
        taskQueue.enqueue(freshJob || { id }, () => runJobPipeline(id), (freshJob && freshJob.priority) || 0);
      }
    });
    const updatedJob = db.getJobById(id);
    return res.json({
      success: true,
      message: 'Câu trả lời đã được ghi nhận thành công',
      job: updatedJob,
      question: targetQuestion
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
/**
 * POST /api/v1/jobs/:id/approve và POST /api/v1/tasks/:id/approve
 * Duyệt Dual Plan khi ở PENDING để chuyển sang IMPLEMENT thực thi code
 */
app.post(['/api/v1/jobs/:id/approve', '/api/v1/tasks/:id/approve'], (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    // Chuyển sang IMPLEMENT và kích hoạt pipeline
    db.updateJob(id, { status: 'IMPLEMENT', current_step: 'IMPLEMENT' });
    jobEventBus.emitJobStatus(id, { status: 'IMPLEMENT' });
    jobEventBus.emitJobLog(id, { text: `\n[PLANNING-GATE] Người dùng đã DUYỆT kế hoạch (Dual Plan Approved). Chuyển sang bước IMPLEMENT...\n` });

    // Kích hoạt bước IMPLEMENT qua TaskQueue để tôn trọng Workspace Lock
    setImmediate(() => {
      if (!taskQueue.isJobEnqueuedOrRunning(id)) {
        const freshJob = db.getJobById(id) || job;
        taskQueue.enqueue(freshJob || job, () => runJobPipeline(id), (freshJob && freshJob.priority) || (job && job.priority) || 0);
      } else {
        executeStep(id).catch(err => {
          console.error(`[EXECUTE-STEP-ERR] Lỗi khi chạy IMPLEMENT cho Job ${id}:`, err);
        });
      }
    });

    return res.json({ success: true, message: 'Đã duyệt kế hoạch, bắt đầu triển khai mã nguồn', status: 'IMPLEMENT' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/v1/jobs/:id (và /api/v1/tasks/:id)
 * Xoá cứng bản ghi trong SQLite DB kèm cascade, TUYỆT ĐỐI GIỮ NGUYÊN thư mục feature và log trên ổ đĩa
 * Chỉ cho phép xóa khi task ở trạng thái: TO DO, DONE, CANCELLED, FAILED, ARCHIVED
 */
app.delete(['/api/v1/jobs/:id', '/api/v1/tasks/:id'], (req, res) => {
  try {
    const { id } = req.params;
    const result = db.deleteJob(id);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    jobEventBus.emitJobStatus(id, { status: 'DELETED', current_step: null });
    return res.json({
      success: true,
      message: 'Đã xóa task thành công khỏi cơ sở dữ liệu (tài liệu và logs trên ổ đĩa được giữ nguyên)',
      id
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
/**
 * POST /api/v1/jobs/:id/archive (và /api/v1/tasks/:id/archive)
 * Lưu trữ / Bỏ lưu trữ task
 */
app.post(['/api/v1/jobs/:id/archive', '/api/v1/tasks/:id/archive'], (req, res) => {
  try {
    const { id } = req.params;
    const result = db.archiveJob(id);
    if (!result.success) {
      return res.status(400).json(result);
    }
    jobEventBus.emitJobStatus(id, { status: result.status, current_step: result.job?.current_step });
    return res.json({
      success: true,
      message: result.status === 'ARCHIVED' ? 'Đã lưu trữ task thành công' : 'Đã khôi phục task từ lưu trữ',
      status: result.status,
      job: result.job
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


/**
 * PATCH/PUT /api/v1/jobs/:id/status (và /api/v1/tasks/:id/status)
 * Cập nhật trạng thái task: DONE chỉ khi gate passed=true, cấm DONE kèm error/timeout
 */
function handleJobStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!status) {
      return res.status(400).json({ success: false, error: 'Trạng thái (status) là bắt buộc' });
    }
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }
    const gate = resolveJobGate(status, req.body || {}, job);
    const nowIso = new Date().toISOString();
    const statusUpdates = { status: gate.finalStatus, gate_result: gate.gateResult, updated_at: nowIso };
    if (['DONE', 'CANCELLED', 'FAILED'].includes((gate.finalStatus || '').toUpperCase())) statusUpdates.completed_at = nowIso;
    if ((gate.finalStatus || '').toUpperCase() === 'DONE') statusUpdates.error_message = null;
    else if (req.body && req.body.error_message && typeof req.body.error_message === 'string') statusUpdates.error_message = req.body.error_message;
    else if (req.body && req.body.error !== undefined && gate.gateResult && gate.gateResult.error) statusUpdates.error_message = gate.gateResult.error;
    const targetId = (job && job.id) ? job.id : id;
    const updatedJob = db.updateJob(targetId, statusUpdates);
    jobEventBus.emitJobStatus(targetId, { status: gate.finalStatus, current_step: (updatedJob && updatedJob.current_step) || job.current_step, gate_result: gate.gateResult });

    if (gate.rejected) {
      return res.status(400).json({ success: false, error: gate.reason, job: updatedJob, gate_result: gate.gateResult, status: gate.finalStatus });
    }
    if ((gate.finalStatus || '').toUpperCase() !== (status || '').toString().trim().toUpperCase() && (status || '').toString().trim().toUpperCase() === 'DONE') {
      return res.json({ success: true, job: updatedJob, gate_result: gate.gateResult, note: gate.reason });
    }
    
    // Nếu status là trạng thái cần chạy thì đi qua TaskQueue để tôn trọng Workspace Lock.
    // Không gọi executeStep trực tiếp để tránh 2 job cùng workspace chạy đè nhau.
    if (['PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'].includes((gate.finalStatus || '').toUpperCase())) {
      if (!taskQueue.isJobEnqueuedOrRunning(targetId)) {
        const freshJob = db.getJobById(targetId) || updatedJob || job;
        const probeJob = freshJob || job;
        if (taskQueue.isWorkspaceLocked(probeJob)) {
          const activeJob = taskQueue.getActiveJobForWorkspace(probeJob);
          const activeCode = (activeJob && (activeJob.task_code || activeJob.id)) || 'khác';
          jobEventBus.emitJobLog(targetId, {
            text: `\n[WORKSPACE-LOCK] ⏳ Workspace đang được thực thi bởi Task '${activeCode}'. Task đổi status '${gate.finalStatus}' đã được xếp vào hàng đợi chờ tới lượt...\n`,
            level: 'info'
          });
        }
        taskQueue.enqueue(probeJob, () => runJobPipeline(targetId), (probeJob && probeJob.priority) || (job && job.priority) || 0);
      }
    }

    return res.json({ success: true, job: updatedJob, gate_result: gate.gateResult });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
app.patch(['/api/v1/jobs/:id/status', '/api/v1/tasks/:id/status'], handleJobStatus);
app.put(['/api/v1/jobs/:id/status', '/api/v1/tasks/:id/status'], handleJobStatus);

/**
 * GET /api/v1/jobs/:id/plan-files (và /api/v1/tasks/:id/plan-files)
 * Đọc trực tiếp nội dung các file expect.md, dev_plan.md, test_plan.md từ đĩa
 */
app.get(['/api/v1/jobs/:id/plan-files', '/api/v1/tasks/:id/plan-files'], (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }
    const taskCode = job.task_code || job.id;
    const planFiles = fileManager.readPlanFiles(job.repo_path || process.cwd(), taskCode);
    return res.json({
      success: true,
      jobId: id,
      taskCode,
      ...planFiles
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/v1/jobs/:id/logs/stream
 * SSE (Server-Sent Events) Realtime Stream cho live logs, status, steps, questions, evidence
 */
app.get('/api/v1/jobs/:id/logs/stream', (req, res) => {
  const { id } = req.params;

  const job = db.getJobById(id);
  if (!job) {
    return res.status(404).json({ error: `Job with ID '${id}' not found` });
  }

  // Cấu hình SSE Headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  res.write(': connected\n\n');
  if (typeof res.flush === 'function') {
    res.flush();
  }
  const sendEvent = (eventType, payload) => {
    try {
      const dataStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
      res.write(`event: ${eventType}\ndata: ${dataStr}\n\n`);
      if (typeof res.flush === 'function') {
        res.flush();
      }
    } catch (e) {
      // Bỏ qua nếu socket đã đóng
    }
  };
  // 1. Gửi trạng thái ban đầu
  sendEvent('status', {
    type: 'status',
    jobId: id,
    status: job.status,
    current_step: job.current_step
  });

  // 2. Gửi câu hỏi đang pending nếu có
  const pendingQ = db.getPendingQuestionByJobId(id);
  if (pendingQ) {
    let opts = [];
    try {
      opts = typeof pendingQ.options === 'string' ? JSON.parse(pendingQ.options) : (pendingQ.options || []);
    } catch (e) {
      opts = [];
    }
    sendEvent('question', {
      type: 'question',
      jobId: id,
      id: pendingQ.id,
      question: pendingQ.question,
      options: opts,
      status: pendingQ.status
    });
  }

  // 3. Đọc log đã lưu trước đó nếu có file log
  const logFilePath = path.join(config.LOG_DIR, `${id}.log`);
  if (fs.existsSync(logFilePath)) {
    try {
      const savedLogs = fs.readFileSync(logFilePath, 'utf8');
      if (savedLogs) {
        sendEvent('log', {
          type: 'log',
          jobId: id,
          text: savedLogs
        });
      }
    } catch (e) {
      // Bỏ qua lỗi đọc file
    }
  }

  // 4. Đăng ký listener vào JobEventBus
  const logListener = (data) => sendEvent('log', data);
  const stepListener = (data) => sendEvent('step', data);
  const statusListener = (data) => sendEvent('status', data);
  const questionListener = (data) => sendEvent('question', data);
  const evidenceListener = (data) => sendEvent('evidence', data);
  const doneListener = (data) => sendEvent('done', data);
  const errorListener = (data) => sendEvent('error', data);

  jobEventBus.on(`job:${id}:log`, logListener);
  jobEventBus.on(`job:${id}:step`, stepListener);
  jobEventBus.on(`job:${id}:status`, statusListener);
  jobEventBus.on(`job:${id}:question`, questionListener);
  jobEventBus.on(`job:${id}:evidence`, evidenceListener);
  jobEventBus.on(`job:${id}:done`, doneListener);
  jobEventBus.on(`job:${id}:error`, errorListener);
  // 5. Heartbeat Ping giữ kết nối không bị timeout
  const keepAliveInterval = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
      if (typeof res.flush === 'function') {
        res.flush();
      }
    } catch (e) {
      clearInterval(keepAliveInterval);
    }
  }, 15000);

  // 6. Cleanup khi client ngắt kết nối
  req.on('close', () => {
    clearInterval(keepAliveInterval);
    jobEventBus.removeListener(`job:${id}:log`, logListener);
    jobEventBus.removeListener(`job:${id}:step`, stepListener);
    jobEventBus.removeListener(`job:${id}:status`, statusListener);
    jobEventBus.removeListener(`job:${id}:question`, questionListener);
    jobEventBus.removeListener(`job:${id}:evidence`, evidenceListener);
    jobEventBus.removeListener(`job:${id}:done`, doneListener);
    jobEventBus.removeListener(`job:${id}:error`, errorListener);
  });
});

// Catch-all middleware cho SPA Dashboard (tương thích Express 5)
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API route not found' });
  }
  const indexPath = path.join(publicPath, 'index.html');
  if (fs.existsSync(indexPath)) {
    return res.sendFile(indexPath);
  }
  return next();
});

// Global Error Handler Middleware
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  if (res.headersSent) {
    return next(err);
  }
  return res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

module.exports = {
  app,
  jobEventBus
};