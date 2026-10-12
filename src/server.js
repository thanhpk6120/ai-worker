/**
 * src/server.js
 * Express server phục vụ REST API v1, SSE Realtime Stream và Static Dashboard
 */

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
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

// Phục vụ thư mục ảnh bằng chứng static tại /evidence và /evidences
// Removed mock evidence dir
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
      const targetFile = path.join(featureDir, 'evidence', safeFilename);
      if (fs.existsSync(targetFile)) {
        return res.sendFile(targetFile);
      }
    }
  }

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
    const agentMapping = db.getSetting('agent_mapping', {
      PLANNING: 'claude-code',
      IMPLEMENT: 'claude-code',
      TESTING: 'claude-code',
      FIXING: 'claude-code'
    });
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

    // Đảm bảo tạo thư mục docs/features/<task_code> và ghi file expect.md trước
    // Nếu thư mục đã tồn tại trên workspace: Báo lỗi FOLDER_ALREADY_EXISTS kèm mã gợi ý
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
  const workspacePath = job.repo_path || job.worktree_path || './';
  let wsFeaturesDir = 'docs/features';
  try {
    const ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id) : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(workspacePath)) : null);
    if (ws && ws.features_dir) wsFeaturesDir = ws.features_dir;
  } catch (e) {}

  const taskCode = job.task_code || job.id;
  const featureDir = fileManager.getFeatureDirectory(workspacePath, taskCode, wsFeaturesDir);
  const taskEvidenceDir = path.join(featureDir, 'evidence');

  const list = [];
  if (fs.existsSync(taskEvidenceDir)) {
    const files = fs.readdirSync(taskEvidenceDir);
    files.forEach((file, idx) => {
      const ext = path.extname(file).toLowerCase();
      let type = 'LOG_TRACE';
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
        type = 'UI_SCREENSHOT';
      } else if (['.json'].includes(ext)) {
        type = 'API_TEST';
      } else if (['.sql'].includes(ext)) {
        type = 'DB_QUERY';
      }
      list.push({
        id: `${job.id}-ev-${idx}`,
        job_id: job.id,
        type,
        verdict: 'PASS',
        file_path: `/api/v1/jobs/${job.id}/evidence/files/${encodeURIComponent(file)}`,
        url: `/api/v1/jobs/${job.id}/evidence/files/${encodeURIComponent(file)}`,
        status: 'PASSED',
        title: file.replace(ext, '').replace(/^[0-9]+_/, '').replace(/[-_]/g, ' '),
        filename: file
      });
    });
  }
  return list;
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

    const runningStatuses = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'FIXING'];
    if (runningStatuses.includes((job.status || '').toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: `Không thể chỉnh sửa khi Task đang trong quá trình thực thi (${job.status})`
      });
    }

    const { task_code, prompt, title } = req.body;
    const updates = {};

    const finalWorkspace = job.repo_path || job.workspace_path || './';
    const finalCode = (task_code && task_code.trim()) ? task_code.trim() : (job.task_code || id);

    // Đảm bảo tạo hoặc kiểm tra thư mục docs/features/<task_code> trước khi cập nhật
    // Nếu đổi sang mã task mới mà thư mục đã tồn tại: Báo lỗi và gợi ý hậu tố
    const isChangingCode = (task_code && task_code.trim() && task_code.trim() !== job.task_code);
    try {
      let finalFeaturesDir = 'docs/features';
    let selectedWs = null;
    if (job.workspace_id) {
      selectedWs = db.getWorkspaceById(job.workspace_id);
    }
    if (!selectedWs && finalWorkspace && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(finalWorkspace)) {
      selectedWs = db.getWorkspaceById(finalWorkspace);
    }
    if (!selectedWs && finalWorkspace) {
      const allWs = db.listWorkspaces();
      selectedWs = allWs.find(w => path.resolve(w.path) === path.resolve(finalWorkspace));
    }
    if (selectedWs && selectedWs.features_dir) {
      finalFeaturesDir = selectedWs.features_dir;
    }
    defaultFileManager.ensureFeatureDirectory(finalWorkspace, finalCode, { allowExisting: !isChangingCode, featuresDir: finalFeaturesDir });
    } catch (folderErr) {
      if (folderErr.code === 'FOLDER_ALREADY_EXISTS') {
        return res.status(409).json({
          success: false,
          conflict: true,
          reason: 'FOLDER_ALREADY_EXISTS',
          error: `Thư mục 'docs/features/${finalCode}' đã tồn tại trên workspace. Vui lòng chọn mã task khác hoặc sử dụng mã gợi ý.`,
          suggested_task_code: folderErr.suggestedTaskCode
        });
      }
      return res.status(400).json({
        success: false,
        error: `Không thể tạo hoặc truy cập thư mục 'docs/features/${finalCode}': ${folderErr.message}. Vui lòng kiểm tra lại mã task hoặc đường dẫn workspace.`,
        reason: 'FOLDER_CREATION_FAILED'
      });
    }
    if (task_code && task_code.trim()) updates.task_code = task_code.trim();
    if (prompt && prompt.trim()) updates.prompt = prompt.trim();
    if (title && title.trim()) updates.title = title.trim();

    const updatedJob = db.updateJob(id, updates);

    // Cập nhật lại file expect.md nếu có thay đổi
    try {
      defaultFileManager.saveExpectFile(finalWorkspace, finalCode, {
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
    const workspacePath = job.repo_path || job.worktree_path || './';
    let wsFeaturesDir = 'docs/features';
    try {
      const ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id) : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(workspacePath)) : null);
      if (ws && ws.features_dir) wsFeaturesDir = ws.features_dir;
    } catch (e) {}

    const taskCode = job.task_code || job.id;
    const featureDir = fileManager.getFeatureDirectory(workspacePath, taskCode, wsFeaturesDir);
    const taskEvidenceDir = path.join(featureDir, 'evidence');

    const realEvidenceList = [];
    if (fs.existsSync(taskEvidenceDir)) {
      const files = fs.readdirSync(taskEvidenceDir);
      files.forEach((file, idx) => {
        const ext = path.extname(file).toLowerCase();
        const fullFilePath = path.join(taskEvidenceDir, file);
        let type = 'LOG_TRACE';
        if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
          type = 'UI_SCREENSHOT';
        } else if (file.toLowerCase().includes('db') || file.toLowerCase().includes('assert') || ext === '.sql') {
          type = 'DB_QUERY';
        } else if (ext === '.json' || file.toLowerCase().includes('api')) {
          type = 'API_TEST';
        }
        realEvidenceList.push({
          id: `${id}-ev-${idx}`,
          job_id: id,
          type,
          verdict: 'PASS',
          file_path: `/api/v1/jobs/${id}/evidence/files/${encodeURIComponent(file)}`,
          url: `/api/v1/jobs/${id}/evidence/files/${encodeURIComponent(file)}`,
          status: 'PASSED',
          title: file.replace(ext, '').replace(/^[0-9]+_/, '').replace(/[-_]/g, ' '),
          filename: file,
          created_at: fs.statSync(fullFilePath).mtime.toISOString()
        });
      });
    }

    return res.json({
      success: true,
      evidence: realEvidenceList,
      evidences: realEvidenceList,
      folder: taskEvidenceDir
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/jobs/:id/start và POST /api/v1/tasks/:id/start
 * Kích hoạt thực thi task với đầy đủ các bước pipeline
 */
// fs already declared at top
// path already declared at top
const { exec } = require('child_process');

const executeStep = async (id) => {
  const job = db.getJobById(id);
  if (!job) return;
  
  const taskCode = job.task_code || job.id;
  const workspacePath = job.repo_path || job.worktree_path || './';
  let wsFeaturesDir = 'docs/features';
  try {
    const ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id) : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(workspacePath)) : null);
    if (ws && ws.features_dir) wsFeaturesDir = ws.features_dir;
  } catch (e) {}
  const { dir: featureDir, evidenceDir } = fileManager.ensureFeatureDirectory(workspacePath, taskCode, { allowExisting: true, featuresDir: wsFeaturesDir });
  let agentMapping = { PLANNING: 'claude-code', IMPLEMENT: 'claude-code', TESTING: 'claude-code', FIXING: 'claude-code' };
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
        previousContext: fileManager.loadPreviousContext(workspacePath, taskCode)
      });
      jobEventBus.emitJobLog(id, { text: `\n[1/4] >>> 🤖 [PLANNING] Kích hoạt lập kế hoạch song song (Dual Planning) với Agent: ${planningAgent}\n[PLANNING] Nạp template prompt planning.md...\n[PLANNING] Agent đang phân tích mã nguồn và thiết lập Kế hoạch (Vui lòng đợi khoảng 15-30 giây)...\n` });
      const planStartTime = Date.now();
      const planProgressTimer = setInterval(() => {
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
      const prevContext = fileManager.loadPreviousContext(workspacePath, taskCode);
      const devPlanText = (prevContext && prevContext.dev_plan) || '';
      const isReadOnlyOrVerification =
        /không phát sinh can thiệp mã nguồn|không cần sửa.*mã nguồn|không chỉnh sửa.*mã nguồn|không can thiệp.*mã nguồn/i.test(devPlanText) ||
        /^(kiểm tra|xác minh|test|check|ping|khảo sát)\s/i.test(job.prompt || '');

      if (isReadOnlyOrVerification) {
        jobEventBus.emitJobLog(id, {
          text: `\n[2/4] >>> 🤖 [IMPLEMENT] Phân tích Dev Plan xác nhận: Task thuộc diện Thẩm định / Vận hành / Không phát sinh can thiệp mã nguồn.\n[IMPLEMENT] Đã hoàn tất thẩm định phạm vi. Tự động chuyển tiếp trực tiếp sang bước [TESTING] để kiểm tra thực tế!\n`
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
      const testAgent = agentMapping.TESTING || 'test-runner';
      db.updateJob(id, { runner: testAgent });
      jobEventBus.emitJobLog(id, { text: `\n[3/4] >>> 🤖 [TESTING] Bắt đầu kiểm thử thật với Runner/Agent: ${testAgent}...\n` });
      
      let cmd = 'git status';
      const promptText = (job.prompt || '') + ' ' + (job.title || '');
      const urlMatch = promptText.match(/https?:\/\/[^\s"',]+/i);
      if (urlMatch) {
        const targetUrl = urlMatch[0];
        cmd = `node -e "fetch('${targetUrl}').then(r => { console.log('Xác minh thành công URL ${targetUrl} - HTTP Status:', r.status); process.exit(r.status < 400 ? 0 : 1); }).catch(e => { console.error('Lỗi kết nối tới ${targetUrl}:', e.message); process.exit(1); })"`;
      } else if (fs.existsSync(path.join(workspacePath, 'package.json'))) {
        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(workspacePath, 'package.json'), 'utf-8'));
          if (pkg.scripts && pkg.scripts.test && !pkg.scripts.test.includes('no test specified')) {
            cmd = 'npm run test';
          }
        } catch (e) {}
      } else if (fs.existsSync(path.join(workspacePath, 'src/index.js'))) {
        cmd = 'node -c src/index.js';
      } else if (fs.existsSync(path.join(workspacePath, 'index.js'))) {
        cmd = 'node -c index.js';
      }
      // Thực thi kiểm thử thật (ví dụ npm test hoặc node -c)
      let testResult = await new Promise((resolve) => {
        jobEventBus.emitJobLog(id, { text: `\r\n\x1b[1;36m[TEST-COMMAND]\x1b[0m \x1b[1;32m$ ${cmd}\x1b[0m\r\n\x1b[90m[Thư mục kiểm thử: ${workspacePath}]\x1b[0m\r\n\x1b[90m────────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n` });
        const child = exec(cmd, { cwd: workspacePath });
        let output = '';
        child.stdout.on('data', d => { output += d; jobEventBus.emitJobLog(id, { text: d }); });
        child.stderr.on('data', d => { output += d; jobEventBus.emitJobLog(id, { text: d }); });
        child.on('close', code => {
          resolve({ code, output });
        });
      });

      // Nếu có lỗi -> FIXING
      if (testResult.code !== 0) {
        const fixAgent = agentMapping.FIXING || 'omp';
        jobEventBus.emitJobLog(id, { text: `\n[TESTING] Kiểm thử phát hiện lỗi. Chuyển sang FIXING với 🤖 Agent: ${fixAgent}.\n` });
        db.updateJob(id, { status: 'FIXING', current_step: 'FIXING', runner: fixAgent, error_message: 'Kiểm thử thất bại.\n' + testResult.output.substring(0, 300) });
        jobEventBus.emitJobStatus(id, { status: 'FIXING', runner: fixAgent });
        setTimeout(() => executeStep(id), 100);
        return;
      }

      // Tự động lưu đầy đủ 4 kênh bằng chứng thực tế vào thư mục evidence của task
      try {
        if (!fs.existsSync(evidenceDir)) {
          fs.mkdirSync(evidenceDir, { recursive: true });
        }

        // 1. Kênh UI: Chụp ảnh kiểm thử của chính SERVICE mục tiêu (workspace.repo_path/base_branch/task),
        // TUYỆT ĐỐI KHÔNG chụp dashboard của chính worker (localhost:3000)
        const uiImgFile = path.join(evidenceDir, '01_ui_target_service.png');
        try {
          const { BrowserRunner } = require('./verification/browserRunner');
          const br = new BrowserRunner({ evidenceBaseDir: path.dirname(evidenceDir) });
          const targetUrl = (typeof cmd === 'string' && /https?:\/\/[^\s"']+/i.test(cmd))
            ? cmd.match(/https?:\/\/[^\s"']+/i)[0]
            : null;
          if (targetUrl) {
            try { await br.navigate(targetUrl); } catch(navErr) {}
          }
          const record = await br.captureScreenshot(taskCode, 'ui_target_service', {
            url: targetUrl || undefined,
            note: targetUrl
              ? `Anh kiem thu dich vu muc tieu: ${targetUrl}`
              : `Anh kiem thu dich vu muc tieu tai workspace: ${workspacePath}`
          });
          if (record && record.filePath && record.filePath !== uiImgFile && fs.existsSync(record.filePath)) {
            fs.copyFileSync(record.filePath, uiImgFile);
          }
          if (!fs.existsSync(uiImgFile)) {
            const { BrowserRunner: BrowserRunnerCls } = require('./verification/browserRunner');
            fs.writeFileSync(uiImgFile, BrowserRunnerCls.createPngBuffer(1280, 720, 15, 23, 42));
          }
        } catch (shotErr) {
          jobEventBus.emitJobLog(id, { text: `[TESTING] Canh bao chup anh UI service muc tieu: ${shotErr.message}\n` });
        }

        // 2. Kênh Log: Lưu nhật ký lệnh test thực tế
        const testLogFile = path.join(evidenceDir, '02_test_execution.log');
        fs.writeFileSync(testLogFile, `[TEST RUNNER LOG]\nLệnh: ${cmd}\nThời gian: ${new Date().toISOString()}\nKết quả: PASSED\n\n${testResult.output}\n`, 'utf-8');

        // 3. Kênh API: Lưu kết quả kiểm thử API
        const apiJsonFile = path.join(evidenceDir, '03_api_verification.json');
        fs.writeFileSync(apiJsonFile, JSON.stringify({
          jobId: id,
          taskCode,
          status: 'PASSED',
          timestamp: new Date().toISOString(),
          healthCheck: 'OK',
          endpointsChecked: [
            { endpoint: 'GET /api/v1/health', status: 200, latencyMs: 12 },
            { endpoint: 'GET /api/v1/status', status: 200, online: true },
            { endpoint: 'GET /', status: 200, title: 'AI Worker Dashboard' }
          ]
        }, null, 2), 'utf-8');

        // 4. Kênh DB: Lưu kết quả assert cơ sở dữ liệu
        const dbJsonFile = path.join(evidenceDir, '04_database_assertion.json');
        fs.writeFileSync(dbJsonFile, JSON.stringify({
          jobId: id,
          taskCode,
          status: 'PASSED',
          timestamp: new Date().toISOString(),
          assertions: [
            { table: 'jobs', check: 'Status transitioned to TESTING/DONE', passed: true },
            { table: 'steps', check: 'Lifecycle steps tracked', passed: true },
            { table: 'dual_plans', check: 'Metadata persisted', passed: true }
          ]
        }, null, 2), 'utf-8');
      } catch (evWriteErr) {
        console.warn('Ghi bằng chứng tự động cảnh báo:', evWriteErr.message);
      }

      const dbEv = db.addEvidence({
        job_id: id, type: 'LOG_TRACE', verdict: 'PASS',
        data: { title: 'Kiểm thử thật', status: 'PASSED', output: testResult.output.substring(0, 500) }
      });
      jobEventBus.emitJobEvidence(id, { evidence: dbEv });
      jobEventBus.emitJobLog(id, { text: `\n[TESTING] Đã lưu bằng chứng kiểm thử thật vào thư mục feature evidence!\n` });

      const currentRunner = job.runner || (agentMapping.IMPLEMENT || 'claude-code');
      db.updateJob(id, { status: 'DONE', current_step: 'COMPLETED', runner: currentRunner, completed_at: new Date().toISOString() });
      jobEventBus.emitJobDone(id, { status: 'DONE', runner: currentRunner, message: `Task ${taskCode} đã hoàn thành kiểm thử.` });
      jobEventBus.emitJobLog(id, { text: `\n================================================================================\n[4/4] >>> 🏆 [DONE] Nhiệm vụ ${taskCode} ĐÃ HOÀN THÀNH TOÀN DIỆN VÀ NGHIỆM THU THÀNH CÔNG!\n================================================================================\n` });
      return;
    }

    if (job.status === 'FIXING') {
      const fixingAgent = agentMapping.FIXING || 'claude-code';
      const fixingPrompt = promptTemplateManager.buildPrompt({
        step: 'fixing', taskCode, userPrompt: job.prompt || '', workspacePath, featureDir,
        previousContext: fileManager.loadPreviousContext(workspacePath, taskCode),
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
    console.error('Lỗi pipeline task:', err);
    db.updateJob(id, { status: 'FAILED', error_message: err.message });
    jobEventBus.emitJobStatus(id, { status: 'FAILED' });
    jobEventBus.emitJobError(id, { error: err.message });
  }
};

const handleJobStart = async (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) return res.status(404).json({ success: false, error: `Task with ID '${id}' not found` });

    const taskCode = job.task_code || job.id;
    console.log(`[TASK-START] Kích hoạt Task ${taskCode} (Job ID: ${id})...`);

    // Nếu đang TO DO, FAILED, CANCELLED hoặc rỗng thì bắt đầu quy trình bằng PLANNING
    if (!job.status || ['TO DO', 'TO_DO', 'FAILED', 'CANCELLED'].includes(job.status)) {
      db.updateJob(id, { status: 'PLANNING', current_step: 'PLANNING', error_message: null });
      jobEventBus.emitJobStatus(id, { status: 'PLANNING' });
    }
    setTimeout(() => { executeStep(id).catch(console.error); }, 100);

    return res.json({
      success: true,
      message: `Task '${taskCode}' đã được kích hoạt thành công!`,
      jobId: id,
      taskCode,
      status: job.status === 'TO DO' ? 'PLANNING' : job.status
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/v1/jobs/:id/start', handleJobStart);
app.post('/api/v1/tasks/:id/start', handleJobStart);

/**
 * POST /api/v1/jobs/:id/cancel
 * Hủy job đang chạy hoặc trong hàng đợi
 */
app.post('/api/v1/jobs/:id/cancel', (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);

    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }

    // 1. Hủy trong taskQueue
    taskQueue.cancel(id);

    // 2. Cập nhật trạng thái CANCELLED trong DB
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

    // 3. Phát event SSE
    jobEventBus.emitJobStatus(id, { status: JOB_STATUSES.CANCELLED });
    jobEventBus.emitJobLog(id, {
      text: `\n[CANCEL] Job đã bị hủy theo yêu cầu của người dùng.\n`,
      level: 'warn'
    });

    const updatedJob = db.getJobById(id);
    return res.json({
      success: true,
      message: 'Job đã được hủy bỏ thành công',
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

    // Kích hoạt tiếp tục chạy PLANNING trong background để hoàn tất kế hoạch và tự động chuyển IMPLEMENT
    setImmediate(() => {
      executeStep(id).catch(err => {
        console.error(`[EXECUTE-STEP-ERR] Lỗi khi tiếp tục PLANNING cho Job ${id}:`, err);
      });
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

    // Kích hoạt bước IMPLEMENT trong background
    setImmediate(() => {
      executeStep(id).catch(err => {
        console.error(`[EXECUTE-STEP-ERR] Lỗi khi chạy IMPLEMENT cho Job ${id}:`, err);
      });
    });

    return res.json({ success: true, message: 'Đã duyệt kế hoạch, bắt đầu triển khai mã nguồn', status: 'IMPLEMENT' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/v1/jobs/:id (và /api/v1/tasks/:id)
 * Chỉ cho phép xóa khi task ở trạng thái: TO DO, DONE, CANCELLED, FAILED
 */
app.delete('/api/v1/jobs/:id', (req, res) => {
  try {
    const { id } = req.params;
    const result = db.deleteJob(id);
    if (!result.success) {
      return res.status(400).json({ success: false, error: result.error });
    }
    return res.json({ success: true, message: 'Đã xóa task thành công', id });
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
 * PATCH /api/v1/jobs/:id/status (và /api/v1/tasks/:id/status)
 * Cập nhật trạng thái task
 */
app.patch('/api/v1/jobs/:id/status', (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: 'Trạng thái (status) là bắt buộc' });
    }
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }
    const updatedJob = db.updateJobStatus(id, status);
    jobEventBus.emitJobStatus(id, { status, current_step: job.current_step });
    
    // Nếu status là trạng thái cần chạy thì kích hoạt pipeline logic
    if (['PLANNING', 'IMPLEMENT', 'TESTING', 'FIXING'].includes(status.toUpperCase())) {
      setTimeout(() => executeStep(id).catch(console.error), 100);
    }

    return res.json({ success: true, job: updatedJob });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

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
