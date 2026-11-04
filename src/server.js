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
const zlib = require('node:zlib');

const config = require('./config');
const db = require('./storage/db');
const { defaultFileManager: fileManager } = require('./storage/fileManager');
const { defaultPromptTemplateManager: promptTemplateManager } = require('./runners/promptTemplateManager');
const { taskQueue } = require('./queue/taskQueue');
const { JOB_STATUSES, transition, canTransition } = require('./state/stateMachine');
const { runnerRegistry } = require('./runners/runnerRegistry');
const { ensureGitWorkspace } = require('./utils/gitWorkspaceHelper');
const worktreeManager = require('./utils/worktreeManager');
const { extractTargetServicesFromDevPlan } = require('./utils/devPlanServiceExtract');
const systemone = require('./systemone/client');
const jobPolicy = require('./execution/jobPolicy');
const fileContext = require('./systemone/fileContext');
const { guardPrompt } = require('./execution/promptGuard');
const evidenceStore = require('./verification/evidenceStore');
const portLeaseManager = require('./execution/portLeaseManager');
const buildProvenance = require('./execution/buildProvenance');
const processJanitor = require('./execution/processJanitor');
const { EvidenceWatcher } = require('./verification/evidenceWatcher');
const { verifyImageWithAI } = require('./verification/aiVisionVerifier');
const evidenceCompleteness = require('./verification/evidenceCompleteness');
const stepGate = require('./execution/stepGate');

// === Evidence realtime (TASK-PIPELINE-FIX C-1..C-3) ===
// Theo doi thu muc evidence cua job dang chay => day evidence moi len SSE ngay
// khi agent vua tao file, thay vi chi hien thi sau khi VERIFY pass.
// Khai bao TRUOC class JobEventBus de emitJobStatus co the goi stopEvidenceWatcher
// ma khong gap TDZ (const).
const evidenceWatchers = new Map();

// Trang thai job => worker co dang CHAY THAT hay khong.
// Job DUNG (PENDING cho user tra loi, TO DO, DONE...) => khong co doan dang mo
// => thoi luong KHONG dem tiep (cong don).
const RUNNING_JOB_STATUSES = new Set(['PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'MERGING']);

// Quản lý event bus tập trung cho SSE Realtime Logs & Events
class JobEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(300);
    /** @type {Map<string, { stream: fs.WriteStream, offset: number, path: string }>} */
    this._logStreams = new Map();
  }

  _ensureLogStream(jobId) {
    if (!jobId) return null;
    let info = this._logStreams.get(jobId);
    if (info && info.stream && !info.stream.destroyed && !info.stream.closed) {
      return info;
    }
    try {
      const logFilePath = path.join(config.LOG_DIR, `${jobId}.log`);
      let initialOffset = 0;
      if (fs.existsSync(logFilePath)) {
        try { initialOffset = fs.statSync(logFilePath).size; } catch (e) { initialOffset = 0; }
      }
      const stream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
      stream.on('error', (err) => {
        console.warn(`[JobEventBus] Loi ghi log stream job ${jobId}:`, err.message);
      });
      info = { stream, offset: initialOffset, path: logFilePath };
      this._logStreams.set(jobId, info);
      return info;
    } catch (err) {
      return null;
    }
  }

  _closeLogStream(jobId) {
    const info = this._logStreams.get(jobId);
    if (info) {
      try { info.stream.end(); } catch (e) {}
      this._logStreams.delete(jobId);
    }
  }

  getLogOffset(jobId) {
    if (!jobId) return 0;
    const info = this._logStreams.get(jobId);
    if (info) return info.offset;
    const logFilePath = path.join(config.LOG_DIR, `${jobId}.log`);
    try {
      return fs.existsSync(logFilePath) ? fs.statSync(logFilePath).size : 0;
    } catch (e) {
      return 0;
    }
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
        const stamped = String(normalized.text)
          .split('\n')
          .map((line) => (line.length ? `[${normalized.timestamp}] ${line}\n` : ''))
          .join('');
        const byteLen = Buffer.byteLength(stamped, 'utf8');
        const info = this._ensureLogStream(jobId);
        if (info && info.stream) {
          info.stream.write(stamped, () => {
            info.offset += byteLen;
          });
          normalized.offset = info.offset + byteLen;
        } else {
          const logFilePath = path.join(config.LOG_DIR, `${jobId}.log`);
          fs.appendFileSync(logFilePath, stamped, 'utf8');
        }
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
    // Job terminal => dung watcher evidence realtime, dong step timeline va stream log.
    // Dong thoi xu ly 'DELETED' (tranh ro ri watcher khi xoa job - review_round2).
    if (normalized.status && ['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'DELETED'].includes(normalized.status)) {
      try { stopEvidenceWatcher(jobId); } catch (e) {}
      try { endStepTimeline(jobId, { status: normalized.status }); } catch (e) {}
      try { this._closeLogStream(jobId); } catch (e) {}
    }
    // Job roi trang thai KHONG chay (PENDING cho user, TO DO, ARCHIVED...) => DONG
    // doan dang mo. Neu de mo, thoi gian cho user se bi tinh nham vao "Thoi luong".
    // Khi job tiep tuc chay lai, `beginStepTimeline` tao doan MOI => tiep tuc dem.
    if (normalized.status && !RUNNING_JOB_STATUSES.has(normalized.status)) {
      try { endStepTimeline(jobId, { status: normalized.status }); } catch (e) {}
    }
  }

  /**
   * Emit trang thai SystemOne CUA 1 JOB (SSE) - de UI hien badge per-task realtime.
   * @param {string} jobId
   * @param {object} state { live, calls, fallbacks, lastError, updatedAt, routes }
   */
  emitJobSystemOne(jobId, state) {
    if (!jobId || !state) return;
    const normalized = {
      type: 'systemone',
      jobId,
      timestamp: new Date().toISOString(),
      ...state
    };
    this.emit(`job:${jobId}:systemone`, normalized);
    this.emit('systemone', normalized);
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
    try { stopEvidenceWatcher(jobId); } catch (e) {}
    // Job DONE => dong doan dang mo (thoi gian chay cua buoc VERIFY cuoi cung).
    try { endStepTimeline(jobId, { status: 'DONE' }); } catch (e) {}
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
// Quản lý System Logs của Worker Server (toàn bộ tiến trình server)
const systemLogEmitter = new EventEmitter();
systemLogEmitter.setMaxListeners(300);
const systemLogBuffer = [];
const MAX_SYSTEM_LOG_BUFFER = 1000;
let systemLogFileStream = null;

function getSystemLogStream() {
  if (systemLogFileStream && !systemLogFileStream.destroyed && !systemLogFileStream.closed) {
    return systemLogFileStream;
  }
  try {
    const bgLogPath = path.join(config.LOG_DIR, 'server-bg.log');
    if (!fs.existsSync(config.LOG_DIR)) fs.mkdirSync(config.LOG_DIR, { recursive: true });
    systemLogFileStream = fs.createWriteStream(bgLogPath, { flags: 'a', encoding: 'utf8' });
    systemLogFileStream.on('error', () => {});
    return systemLogFileStream;
  } catch (e) {
    return null;
  }
}

function appendSystemLog(chunk, isError = false) {
  try {
    const str = typeof chunk === 'string' ? chunk : (chunk ? chunk.toString('utf8') : '');
    if (!str) return;

    // Ghi trực tiếp ra file log từ Node.js
    const fileStream = getSystemLogStream();
    if (fileStream && !fileStream.destroyed) {
      fileStream.write(str);
    }

    const lines = str.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      const entry = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
        timestamp: new Date().toISOString(),
        text: line,
        isError: Boolean(isError)
      };
      systemLogBuffer.push(entry);
      if (systemLogBuffer.length > MAX_SYSTEM_LOG_BUFFER) {
        systemLogBuffer.shift();
      }
      systemLogEmitter.emit('log', entry);
    }
  } catch (e) {}
}

if (!global.__aiWorkerStdoutHooked) {
  global.__aiWorkerStdoutHooked = true;
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = function (chunk, encoding, cb) {
    appendSystemLog(chunk, false);
    return origStdoutWrite(chunk, encoding, cb);
  };

  process.stderr.write = function (chunk, encoding, cb) {
    appendSystemLog(chunk, true);
    return origStderrWrite(chunk, encoding, cb);
  };
}

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
  jobEventBus.emitJobStatus(jobId, { status: job.status || 'PLANNING', is_queued: false });
  jobEventBus.emitJobLog(jobId, {
    text: `\n>>> [QUEUE] Job ${jobId} đã được điều phối bắt đầu thực thi.\n`
  });
});

taskQueue.on('job:dequeued', ({ jobId }) => {
  jobEventBus.emitJobStatus(jobId, { status: 'TO DO', is_queued: false });
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
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// Middleware nen response gzip bang node:zlib stdlib (T3.5, UC-6)
// Chi nen JSON > 1024 bytes, bo qua route SSE (/logs/stream) de khong pha vo realtime streaming.
app.use((req, res, next) => {
  if (req.path.includes('/logs/stream')) {
    return next();
  }
  const acceptEncoding = req.headers['accept-encoding'] || '';
  if (!acceptEncoding.includes('gzip')) {
    return next();
  }

  const originalSend = res.send;
  res.send = function (body) {
    if (res.headersSent) return originalSend.call(this, body);

    let buffer = null;
    if (typeof body === 'string') {
      const contentType = String(res.getHeader('content-type') || '');
      if (contentType.includes('application/json') || body.startsWith('{') || body.startsWith('[')) {
        buffer = Buffer.from(body, 'utf8');
      }
    } else if (Buffer.isBuffer(body)) {
      buffer = body;
    } else if (body && typeof body === 'object') {
      try {
        const jsonStr = JSON.stringify(body);
        buffer = Buffer.from(jsonStr, 'utf8');
        if (!res.getHeader('content-type')) {
          res.setHeader('content-type', 'application/json; charset=utf-8');
        }
      } catch (e) {
        return originalSend.call(this, body);
      }
    }

    if (buffer && buffer.length > 1024) {
      try {
        const gzipped = zlib.gzipSync(buffer);
        res.setHeader('content-encoding', 'gzip');
        res.setHeader('content-length', gzipped.length);
        res.removeHeader('etag');
        return originalSend.call(this, gzipped);
      } catch (e) {
        // Fallback khong nen
      }
    }

    return originalSend.call(this, body);
  };

  next();
});

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

// Helper lấy metadata của 1 file evidence (tương thích metadata cũ thiếu trường)
function getEvidenceFileMeta(metadata, filename) {
  if (!metadata || !filename) return {};
  let raw = {};
  if (Array.isArray(metadata)) {
    raw = metadata.find(m => m && (m.fileName === filename || m.name === filename || m.file === filename || (m.file_path && m.file_path.includes(filename)))) || {};
  } else if (typeof metadata === 'object') {
    raw = metadata[filename] || {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const strOrNull = (v) => (typeof v === 'string' && v.trim() ? v : (v != null && typeof v !== 'object' ? String(v) : null));
  const stepName = strOrNull(raw.stepName) || strOrNull(raw.step_name) || (typeof raw.step === 'string' ? raw.step : null) || null;
  const stepId = strOrNull(raw.stepId) || strOrNull(raw.step_id) || strOrNull(raw.stepIndex) || strOrNull(raw.step_index) || null;
  const step = strOrNull(raw.step) || stepName || stepId || null;
  const evidenceId = strOrNull(raw.evidenceId) || strOrNull(raw.evidence_id) || strOrNull(raw.id) || null;
  const timestamp = strOrNull(raw.timestamp) || strOrNull(raw.capturedAt) || strOrNull(raw.captured_at) || strOrNull(raw.created_at) || strOrNull(raw.createdAt) || strOrNull(raw.time) || null;
  const description = strOrNull(raw.description) || strOrNull(raw.desc) || strOrNull(raw.message) || strOrNull(raw.caption) || null;
  const testCase = strOrNull(raw.testCase) || strOrNull(raw.testcase) || (typeof raw.case === 'string' ? raw.case : null) || strOrNull(raw.caseName) || strOrNull(raw.case_name) || null;
  const caseName = strOrNull(raw.caseName) || strOrNull(raw.case_name) || testCase || null;
  const actionType = strOrNull(raw.actionType) || strOrNull(raw.action_type) || strOrNull(raw.action) || null;
  const currentUrl = strOrNull(raw.currentUrl) || strOrNull(raw.current_url) || strOrNull(raw.pageUrl) || strOrNull(raw.page_url) || null;
  const name = strOrNull(raw.name) || strOrNull(raw.title) || null;
  const passCriteria = strOrNull(raw.passCriteria) || strOrNull(raw.pass_criteria) || strOrNull(raw.criteria) || strOrNull(raw.expected) || null;
  const numOrNull = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const stepIndex = numOrNull(raw.stepIndex !== undefined ? raw.stepIndex : raw.step_index);
  const order = numOrNull(raw.order !== undefined ? raw.order : raw.sequence);
  return { ...raw, stepId, stepName, step, evidenceId, timestamp, description, name, passCriteria, stepIndex, order, testCase, testcase: strOrNull(raw.testcase) || testCase, case: raw.case != null ? raw.case : (caseName || null), caseName, actionType, currentUrl };
}
// Chuan phan loai evidence (log vs api): uu tien metadata ghi ro, suy luan cu de tuong thich.
// Noi ghi (BrowserRunner/agent) co the gan meta.type|evidence_type|channel; noi doc dung helper nay.
function normalizeEvidenceTypeHint(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const raw = meta.type || meta.evidence_type || meta.evidenceType || meta.channel || meta.kind || null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim().toUpperCase();
  if (v === 'UI_SCREENSHOT' || v === 'UI' || v === 'IMAGE' || v === 'SCREENSHOT') return 'UI_SCREENSHOT';
  if (v === 'API_TEST' || v === 'API' || v === 'API_CALL' || v === 'API_RESULT') return 'API_TEST';
  if (v === 'DB_QUERY' || v === 'DB_ASSERT' || v === 'DB' || v === 'SQL') return 'DB_QUERY';
  if (v === 'LOG_TRACE' || v === 'SERVICE_LOG' || v === 'LOG' || v === 'LOGS' || v === 'TXT') return 'LOG_TRACE';
  return null;
}
function hasApiRuntimeShape(parsedData) {
  if (!parsedData || typeof parsedData !== 'object' || Array.isArray(parsedData)) return false;
  const req = parsedData.request && typeof parsedData.request === 'object' ? parsedData.request : null;
  const hasEndpoint = !!(parsedData.endpoint || parsedData.url || (req && (req.url || req.endpoint || req.path)));
  const hasMethod = !!(parsedData.method || (req && req.method));
  const hasStatus = parsedData.status !== undefined || parsedData.statusCode !== undefined || parsedData.status_code !== undefined || (parsedData.response && typeof parsedData.response === 'object' && parsedData.response.status !== undefined);
  return hasEndpoint && (hasMethod || hasStatus);
}

/**
 * Bằng chứng API có chứa ÍT NHẤT MỘT bản ghi HTTP runtime đầy đủ không?
 *
 * Vì sao cần: gate cũ chỉ soi các key cố định ở cấp cao nhất (`endpointsChecked`,
 * `method`, `url`, `status`...). Agent ghi đúng chuẩn nhưng theo dạng
 * `{ baseUrl, results: [ { method, url, responseStatus, responseBody } ] }` —
 * một mảng kết quả thật — thì bị chấm là "không phải API runtime".
 * PHUB-682 đã lặp 3 vòng FIXING (~1 giờ) vì đúng lỗi này dù file có 9/9 lệnh gọi
 * API thật (status 200 + response body thật).
 *
 * Nay: quét MỌI mảng object ở cấp cao nhất (results/cases/calls/tests/...) và
 * chấp nhận khi có một bản ghi hội đủ method + url + status + body.
 * @param {any} obj
 * @returns {boolean}
 */
function apiEvidenceHasRuntimeRecords(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const records = [];
  const pushArray = (v) => {
    if (!Array.isArray(v)) return;
    for (const item of v) if (item && typeof item === 'object' && !Array.isArray(item)) records.push(item);
  };
  if (Array.isArray(obj)) {
    pushArray(obj);
  } else {
    // Chính object cũng có thể là 1 bản ghi phẳng { method, url, status, response }.
    records.push(obj);
    pushArray(obj.endpointsChecked);
    for (const v of Object.values(obj)) pushArray(v);
  }
  if (records.length === 0) return false;

  const hasValue = (r, keys) => keys.some((k) => r[k] !== undefined && r[k] !== null && r[k] !== '');
  const hasMethod = (r) => hasValue(r, ['method', 'httpMethod', 'verb'])
    || !!(r.request && typeof r.request === 'object' && (r.request.method || r.request.httpMethod));
  const hasUrl = (r) => hasValue(r, ['url', 'endpoint', 'path', 'uri', 'requestUrl'])
    || !!(r.request && typeof r.request === 'object' && (r.request.url || r.request.endpoint || r.request.path));
  const hasStatus = (r) => hasValue(r, ['responseStatus', 'status', 'statusCode', 'httpStatus', 'status_code', 'expectedStatus'])
    || !!(r.response && typeof r.response === 'object' && r.response.status !== undefined);
  const hasBody = (r) => ['responseBody', 'requestBody', 'body', 'data', 'response', 'payload', 'result', 'json', 'content']
    .some((k) => r[k] !== undefined && r[k] !== null);

  return records.some((r) => hasMethod(r) && hasUrl(r) && hasStatus(r) && hasBody(r));
}

/** Mô tả phần còn thiếu của bằng chứng API để log chỉ đúng việc agent phải sửa. */
function describeApiEvidenceGaps(obj, aggregate) {
  const gaps = [];
  if (!aggregate) return 'không đọc được JSON';
  if (!aggregate.hasMethod) gaps.push('method');
  if (!aggregate.hasUrl) gaps.push('url');
  if (!aggregate.hasStatus) gaps.push('status');
  if (!aggregate.hasBody) gaps.push('response body');
  return gaps.length ? `thiếu ${gaps.join(', ')}` : 'cấu trúc chưa đạt';
}

function hasDbShape(parsedData, filename) {
  const name = String(filename || '').toLowerCase();
  if (parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)) {
    if (parsedData.query || parsedData.sql || parsedData.table || parsedData.tableName || parsedData.rows || parsedData.actualRows) return true;
  }
  return name.includes('db') || name.includes('assert');
}
// Phan loai ro rang:
// - .log / .txt -> LOG_TRACE (luon la Log, khong bao gio lan sang API)
// - .png / .jpg / .webp / .jpeg / .svg -> UI_SCREENSHOT
// - .sql hoac file .json chua db/assert -> DB_QUERY
// - .json con lai -> API_TEST (luon la API test / assertions, khong lan sang Log)
function resolveEvidenceType({ filename = '', ext = '', meta = {}, parsedData = null } = {}) {
  const name = String(filename || '').toLowerCase();
  const e = String(ext || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(e)) return 'UI_SCREENSHOT';
  if (e === '.log' || e === '.txt') return 'LOG_TRACE';
  if (e === '.sql') return 'DB_QUERY';
  const hint = normalizeEvidenceTypeHint(meta);
  if (hint === 'UI_SCREENSHOT') return 'UI_SCREENSHOT';
  if (hint === 'LOG_TRACE') return 'LOG_TRACE';
  if (hint === 'DB_QUERY') return 'DB_QUERY';
  if (hint === 'API_TEST') return 'API_TEST';
  if (hasDbShape(parsedData, name) && (e === '.json' || e === '.sql' || e === '.db' || e === '.sqlite')) return 'DB_QUERY';
  if (e === '.json') return 'API_TEST';
  if (name.includes('api')) return 'API_TEST';
  return 'LOG_TRACE';
}
// Chi doc noi dung (utf8) cho file text. File binary (.xlsx/.pdf/.zip/.docx...)
// de content='' va client tai qua /evidence/files/:filename.
const TEXT_EVIDENCE_EXTS = ['.log', '.txt', '.json', '.md', '.csv', '.xml', '.yaml', '.yml', '.html', '.htm', '.sql', '.js', '.ts', '.sh', '.ps1', '.bat', '.env', '.ini', '.conf'];

function evidenceChannelOf(type) {
  if (type === 'UI_SCREENSHOT') return 'ui';
  if (type === 'API_TEST') return 'api';
  if (type === 'DB_QUERY') return 'db';
  return 'log';
}

function hashEvidenceBuffer(buf) {
  try { return crypto.createHash('md5').update(buf).digest('hex'); } catch (e) { return null; }
}
// Gioi han noi dung evidence nhung vao response (client tai full qua
// /evidence/files/:filename khi can). Truoc day nhung ca file 8MB => 1 job
// co the tra ve hang chuc MB JSON.
const MAX_INLINE_EVIDENCE_CONTENT = 64 * 1024;
// Cache doc file evidence theo (duong dan | size | mtime). Truoc day moi request
// mo job lai doc TUNG file 3 lan (validate JSON + lay content + tinh md5) =>
// ~10MB I/O + 20ms CPU dong bo moi lan, chan event loop cua SSE.
const evidenceFileCache = new Map();
const EVIDENCE_FILE_CACHE_MAX = 300;
function getCachedEvidenceFile(fullFilePath, stat) {
  const size = stat ? stat.size : 0;
  const mtimeMs = stat ? stat.mtimeMs : 0;
  const key = `${fullFilePath}|${size}|${mtimeMs}`;
  let entry = evidenceFileCache.get(key);
  if (!entry) {
    let buf = null;
    try { buf = fs.readFileSync(fullFilePath); } catch (e) { buf = null; }
    const ext = path.extname(fullFilePath).toLowerCase();
    // CHI giu text cua file text. Buffer anh (PNG co the vai MB) phai duoc giai
    // phong ngay sau khi bam md5, neu giu lai se phinh RAM theo so evidence.
    const text = (buf && TEXT_EVIDENCE_EXTS.includes(ext)) ? buf.toString('utf8') : '';
    entry = {
      size: buf ? buf.length : size,
      md5: buf ? hashEvidenceBuffer(buf) : null,
      text: text.length > 256 * 1024 ? text.slice(0, 256 * 1024) : text
    };
    if (evidenceFileCache.size >= EVIDENCE_FILE_CACHE_MAX) evidenceFileCache.clear();
    evidenceFileCache.set(key, entry);
  }
  return entry;
}
function buildEvidenceHashes(fullFilePath, stat) {
  const entry = getCachedEvidenceFile(fullFilePath, stat);
  return {
    size: entry.size,
    sizeBytes: entry.size,
    md5: entry.md5,
    contentHash: entry.md5
  };
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
        try { metaObj = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
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
            try { subMeta = JSON.parse(fs.readFileSync(candidateMeta, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
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
    let systemoneStats = { calls: 0, hits: 0, misses: 0, fallbacks: 0, cliSaved: 0, cost: 0 };
    let systemoneStatus = null;
    try { systemoneStats = systemone.getStats(); } catch (e) {}
    try { systemoneStatus = systemone.getStatus(); } catch (e) {}
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
      runners,
      systemone: systemoneStats,
      systemoneStatus
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', error: err.message });
  }
}

app.get('/api/v1/health', handleHealthCheck);
app.get('/api/v1/status', handleHealthCheck);

// ==========================================
// PROCESS JANITOR - dọn tiến trình rác (dev server / BE bỏ hoang)
// ==========================================
/**
 * GET /api/v1/janitor/status
 * Trạng thái vòng dọn dẹp: bật/tắt, chu kỳ, lần chạy tới, kết quả gần nhất.
 */
app.get('/api/v1/janitor/status', (req, res) => {
  try {
    res.json(processJanitor.getStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/janitor/runs?limit=30
 * Lịch sử các lần chạy (mới nhất trước).
 */
app.get('/api/v1/janitor/runs', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 30;
    const runs = db.listJanitorRuns(limit).map((r) => ({
      id: r.id,
      started_at: r.started_at,
      finished_at: r.finished_at,
      trigger: r.trigger,
      duration_ms: r.duration_ms,
      scanned: r.scanned,
      killed: r.killed,
      protected_count: r.protected_count,
      protected_system_count: (r.report && r.report.protected_system_count) || 0,
      freed_ports: r.freed_ports || []
    }));
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/janitor/runs/:id
 * Chi tiết 1 lần chạy: danh sách đã kill, danh sách được bảo vệ, log đầy đủ.
 */
app.get('/api/v1/janitor/runs/:id', (req, res) => {
  try {
    const run = db.getJanitorRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Không tìm thấy lần chạy này.' });
    const report = run.report || {};
    res.json({
      run: {
        id: run.id,
        started_at: run.started_at,
        finished_at: run.finished_at,
        trigger: run.trigger,
        duration_ms: run.duration_ms,
        scanned: run.scanned,
        killed: run.killed,
        protected_count: run.protected_count,
        protected_system_count: (report.protected_system_count || 0),
        freed_ports: run.freed_ports || [],
        killed_list: report.killed_list || [],
        protected_list: report.protected_list || [],
        errors: report.errors || [],
        dry_run: Boolean(report.dry_run),
        log: run.log || []
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/janitor/run
 * Chạy dọn dẹp ngay (body: { dryRun?: boolean }).
 */
app.post('/api/v1/janitor/run', async (req, res) => {
  try {
    const dryRun = req.body && req.body.dryRun !== undefined ? Boolean(req.body.dryRun) : undefined;
    const result = await processJanitor.runAndPersist({ trigger: 'manual', dryRun });
    if (!result.ok) {
      return res.status(result.skipped ? 409 : 500).json({
        ok: false,
        error: result.error || result.reason
      });
    }
    res.json({ ok: true, report: result.report, record: { id: result.report.id } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /api/v1/systemone/status
 * Trang thai model SystemOne: live (goi model that) hay fallback (heuristic offline).
 */
app.get('/api/v1/systemone/status', (req, res) => {
  try {
    let status = null;
    let stats = null;
    try { status = systemone.getStatus(); } catch (e) {}
    try { stats = systemone.getStats(); } catch (e) {}
    return res.json({ success: true, status, stats });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/v1/systemone/probe
 * Gọi thẳng 1 request noul tối thiểu để kiểm tra endpoint/key/model đang nạp có thật không.
 * Không đi qua cache, không cần tạo job.
 */
app.get('/api/v1/systemone/probe', async (req, res) => {
  try {
    if (typeof systemone.probe !== 'function') {
      return res.status(501).json({ success: false, error: 'probe khong ho tro' });
    }
    const result = await systemone.probe();
    return res.json({ success: result.live === true, ...result, status: systemone.getStatus() });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/v1/runners
 * Trả về danh sách 5 runners (claude, opencode, omp, codex, antigravity) kèm availability
 */

// Canh bao SystemOne rơi về heuristic offline. Chi log 1 lan moi job de tranh spam.
const systemoneFallbackWarned = new Set();
function logSystemOneFallback(jobId, route, decision) {
  if (!jobId || !decision || decision.fallback !== true) return;
  if (systemoneFallbackWarned.has(jobId)) return;
  systemoneFallbackWarned.add(jobId);
  const live = (() => { try { return systemone.getStatus().live; } catch (e) { return null; } })();
  const reason = live === false ? 'model khong phan hoi' : 'model bi vo hieu hoa';
  jobEventBus.emitJobLog(jobId, {
    text: `\n[SYSTEMONE-FALLBACK] ⚠ SystemOne ${route} rơi về heuristic offline (${reason}). Quyet dinh nay KHONG phai tu model that.\n`
  });
}

/**
 * Ghi nhan trang thai SystemOne CUA 1 JOB vao DB + emit SSE.
 * Badge "CHƯA GỌI"/"LIVE"/"FALLBACK" phai la du lieu cua TUNG task.
 * - `cached: true` hoac `source: 'attempt-limit'`: khong goi model => KHONG tinh vao calls.
 * - `checkGuard`/`pickRunner` boc ket qua trong `.decision` => dung `result.decision || result`.
 *
 * @param {string} jobId
 * @param {object} result Ket qua tu systemone.checkXacDinh / pickRunner
 * @param {string} route
 */
function recordSystemOne(jobId, result, route) {
  if (!jobId) return;
  const d = (result && result.decision) || result || {};
  if (!d || typeof d !== 'object') return;
  // Khong goi model that (ket qua tu cache, hoac chua het so lan retry) => bo qua.
  // Badge phai phan anh "model that da quyet dinh" chu khong phai "co quyet dinh nao".
  if (d.cached === true || d.source === 'attempt-limit') return;

  let prev = null;
  try {
    const job = db.getJobById(jobId);
    prev = job && job.systemone_state ? JSON.parse(job.systemone_state) : null;
  } catch (e) { prev = null; }
  const fallback = d.fallback === true;
  let decisionSummary = '';
  if (route === 'triage') {
    const comp = d.complexity || d.scope || (d.is_quick ? 'S' : (d.is_large ? 'L' : 'M'));
    const trk = d.track || (d.is_quick ? 'quick' : 'full');
    decisionSummary = `Triage: ${comp}/${trk}${d.confidence !== undefined ? ' (conf: ' + d.confidence + ')' : ''}`;
  } else if (route === 'fixGate') {
    const act = d.retry !== undefined ? (d.retry ? 'RETRY' : 'STOP') : (d.action || (d.allowRetry ? 'RETRY' : 'STOP'));
    const pSuccess = d.p_success !== undefined ? ` (p: ${d.p_success})` : '';
    const scope = d.fixScope ? ` [${d.fixScope}]` : '';
    decisionSummary = `FixGate: ${act}${pSuccess}${scope}`;
  } else if (route === 'repeatedCause') {
    const isRep = d.repeated !== undefined ? d.repeated : (d.verdict === 'REPEATED');
    decisionSummary = `LoopCheck: ${isRep ? 'REPEATED' : 'NEW'}`;
  } else {
    decisionSummary = `${route || 'decision'}: ${d.verdict || d.action || d.scope || 'OK'}`;
  }
  const state = {
    live: !fallback,
    calls: ((prev && prev.calls) || 0) + 1,
    fallbacks: ((prev && prev.fallbacks) || 0) + (fallback ? 1 : 0),
    lastError: fallback ? ((prev && prev.lastError) || 'model khong phan hoi - dung heuristic offline') : null,
    lastDecision: decisionSummary,
    decisions: [...((prev && prev.decisions) || []).slice(-10), { route: route || 'decision', summary: decisionSummary, time: new Date().toISOString() }],
    model: (() => { try { return systemone.getStatus().model; } catch (e) { return null; } })(),
    updatedAt: new Date().toISOString()
  };
  try { db.updateJob(jobId, { systemone_state: state }); } catch (e) {}
  try { jobEventBus.emitJobSystemOne(jobId, state); } catch (e) {}
}

/**
 * Kiem tra nguyen nhan loi cua vong hien tai co TRUNG voi lan truoc khong.
 *
 * Muc tieu: chong vong lap vô han. Neu loi moi y het loi da gap o vong truoc
 * thi retry se ra cung ket qua - ton that gian va thoi gian. SystemOne quyet
 * dinh co lap hay khong (model that + heuristic offline so chu ky loi).
 *
 * Luu chu ky loi vao `pipeline_config.failure_history` de cac vong sau so sanh.
 *
 * @param {string} args.reason    mo ta loi cua vong hien tai (vd "exit code 1")
 * @param {string} args.output   output cua agent (stdout+stderr) - phai co trong
 *                                chu ky loi, vi `reason` chi la "exit code 1"
 *                                cho MOI lan fail => moi vong se bi coi la trung.
 * @returns {Promise<{repeated: boolean, reason: string, signature: string, occurrences: number, stoppedBySystemOne: boolean}|null>}
 */
async function evaluateRepeatedCause({ id, step, attempt, maxRetries, reason, output }) {
  try {
    const job = db.getJobById(id);
    if (!job) return null;
    // Chu ky loi = mo ta loi + phan cuoi output agent (stack trace / loi that).
    // Output la phan phan biet cac lan fail khac nhau - khong co no thi moi
    // vong 2 se trung ngay va dung job sau 1 lan retry (dung max_retries=10).
    const outTail = String(output || '').slice(-1200);
    const signature = jobPolicy.buildFailureSignature(`${reason || ''}\n${outTail}`);
    if (!signature) return null;
    const history = jobPolicy.getFailureHistory(job);
    // Luu chu ky loi vua xay ra VAO lich su (truoc khi hoi so sanh).
    const pipe = jobPolicy.appendFailureHistory(job, signature, step, attempt);
    try { db.updateJob(id, { pipeline_config: pipe }); } catch (e) {}
    const prior = history.filter((h) => h.signature === signature && h.step === step);
    if (prior.length === 0) {
      // Chua co lan nao trung => he thong tu chay tiep, khong can hoi model.
      jobEventBus.emitJobLog(id, { text: `[REPEAT-CHECK] ${step} vong ${attempt}: chu ky loi moi (chua tung gap) - cho phep retry.\n` });
      return { repeated: false, reason: 'chu ky loi moi', signature, occurrences: 0, stoppedBySystemOne: false };
    }
    const decision = await systemone.checkRepeatedCause({
      jobId: id, step, attempt, maxRetries,
      reason: String(reason || '').slice(0, 1200),
      signature,
      history
    });
    const repeated = decision && decision.repeated === true;
    jobEventBus.emitJobLog(id, { text: `[REPEAT-CHECK] ${step} vong ${attempt}/${maxRetries}: chu ky loi da gap ${prior.length} lan truoc. SystemOne noi "${decision && decision.reason ? decision.reason : (repeated ? 'trung nguyen nhan' : 'khac nguyen nhan')}" => ${repeated ? 'DUNG vong lap' : 'cho phep retry'}.\n` });
    return {
      repeated,
      reason: (decision && decision.reason) || (repeated ? 'nguyen nhan loi trung voi lan truoc' : 'nguyen nhan moi'),
      signature,
      occurrences: prior.length,
      stoppedBySystemOne: repeated
    };
  } catch (e) {
    return null;
  }
}

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

    // Tự động quét các repo git con cấp 1 và lưu vào workspace_services
    let detectedServices = [];
    try {
      detectedServices = worktreeManager.scanWorkspaceServices(resolvedPath);
      if (Array.isArray(detectedServices) && detectedServices.length > 0) {
        for (const svc of detectedServices) {
          db.addWorkspaceService({
            workspace_id: ws.id,
            service_key: svc.service_key,
            repo_path: svc.repo_path,
            dev_branch: svc.dev_branch,
            deploy_branch: svc.deploy_branch,
            is_enabled: 1
          });
        }
      }
    } catch (scanErr) {
      console.warn(`[WORKSPACE-SCAN-WARN] Lỗi tự động quét services cho workspace "${resolvedPath}":`, scanErr.message);
    }

    return res.status(201).json({ success: true, workspace: ws, git: gitResult, services: detectedServices });
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
    let resolvedPath = null;
    if (wsPath) {
      resolvedPath = require('path').resolve(wsPath);
      if (!fs.existsSync(resolvedPath)) {
        return res.status(400).json({ success: false, error: `Đường dẫn "${resolvedPath}" không tồn tại trên hệ thống` });
      }
    }
    const updated = db.updateWorkspace(id, { name, path: wsPath, features_dir, is_default });

    // Nếu đường dẫn thay đổi, tự động quét lại services
    if (resolvedPath && resolvedPath !== existing.path) {
      try {
        const detectedServices = worktreeManager.scanWorkspaceServices(resolvedPath);
        for (const svc of detectedServices) {
          const exSvc = db.getWorkspaceServiceByKey(id, svc.service_key);
          if (!exSvc) {
            db.addWorkspaceService({
              workspace_id: id,
              service_key: svc.service_key,
              repo_path: svc.repo_path,
              dev_branch: svc.dev_branch,
              deploy_branch: svc.deploy_branch,
              is_enabled: 1
            });
          }
        }
      } catch (scanErr) {
        console.warn(`[WORKSPACE-RESCAN-WARN] Lỗi quét lại services:`, scanErr.message);
      }
    }

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
// ==========================================
// WORKSPACE SERVICES API (Polyrepo Multi-Service)
// ==========================================
// Lấy danh sách service của workspace
app.get('/api/v1/workspaces/:id/services', (req, res) => {
  try {
    const { id } = req.params;
    const ws = db.getWorkspaceById(id);
    if (!ws) {
      return res.status(404).json({ success: false, error: 'Workspace không tồn tại' });
    }
    const services = db.listWorkspaceServices(id);
    return res.json({ success: true, services });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Quét thư mục cấp 1 để tự động nhận diện git services và branch hiện tại
app.post('/api/v1/workspaces/:id/services/scan', (req, res) => {
  try {
    const { id } = req.params;
    const ws = db.getWorkspaceById(id);
    if (!ws) {
      return res.status(404).json({ success: false, error: 'Workspace không tồn tại' });
    }
    const { auto_save = false } = req.body || {};
    const detected = worktreeManager.scanWorkspaceServices(ws.path);

    // Nếu auto_save = true, tự động lưu hoặc cập nhật vào database
    if (auto_save && Array.isArray(detected)) {
      for (const item of detected) {
        const existing = db.getWorkspaceServiceByKey(id, item.service_key);
        if (!existing) {
          db.addWorkspaceService({
            workspace_id: id,
            service_key: item.service_key,
            repo_path: item.repo_path,
            dev_branch: item.dev_branch,
            deploy_branch: item.deploy_branch,
            is_enabled: 1
          });
        } else {
          // Cập nhật dev_branch mới nếu đã checkout nhánh khác
          db.updateWorkspaceService(existing.id, {
            dev_branch: item.dev_branch
          });
        }
      }
    }

    const currentServices = db.listWorkspaceServices(id);
    return res.json({
      success: true,
      detected,
      services: currentServices
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Thêm service mới thủ công cho workspace
app.post('/api/v1/workspaces/:id/services', (req, res) => {
  try {
    const { id } = req.params;
    const ws = db.getWorkspaceById(id);
    if (!ws) {
      return res.status(404).json({ success: false, error: 'Workspace không tồn tại' });
    }
    const { service_key, repo_path, dev_branch, deploy_branch, is_enabled = 1 } = req.body;
    if (!service_key || !repo_path || !dev_branch) {
      return res.status(400).json({ success: false, error: 'service_key, repo_path và dev_branch là bắt buộc' });
    }
    const existing = db.getWorkspaceServiceByKey(id, service_key);
    if (existing) {
      return res.status(400).json({ success: false, error: `Service '${service_key}' đã tồn tại trong workspace` });
    }
    const newService = db.addWorkspaceService({
      workspace_id: id,
      service_key,
      repo_path,
      dev_branch,
      deploy_branch: deploy_branch || null,
      is_enabled
    });
    return res.status(201).json({ success: true, service: newService });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Cập nhật service
app.put('/api/v1/workspaces/:id/services/:serviceId', (req, res) => {
  try {
    const { id, serviceId } = req.params;
    const current = db.getWorkspaceServiceById(serviceId);
    if (!current || current.workspace_id !== id) {
      return res.status(404).json({ success: false, error: 'Service không tồn tại trong workspace này' });
    }
    const updated = db.updateWorkspaceService(serviceId, req.body);
    return res.json({ success: true, service: updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Xóa service
app.delete('/api/v1/workspaces/:id/services/:serviceId', (req, res) => {
  try {
    const { id, serviceId } = req.params;
    const current = db.getWorkspaceServiceById(serviceId);
    if (!current || current.workspace_id !== id) {
      return res.status(404).json({ success: false, error: 'Service không tồn tại trong workspace này' });
    }
    const result = db.deleteWorkspaceService(serviceId);
    return res.json({ success: result.success, id: serviceId });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// JOB WORKTREES API (Dynamic Worktree Expansion)
// ==========================================
// Lấy danh sách worktree đã mount cho job
app.get('/api/v1/jobs/:id/worktrees', (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job không tồn tại' });
    }
    const worktrees = db.listJobWorktrees(id);
    return res.json({ success: true, worktrees });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Mở rộng worktree động trong quá trình thực thi (PLANNING, IMPLEMENT, TESTING, FIXING)
// Không kiểm tra slot concurrency chung vì job đã và đang giữ slot thực thi
app.post('/api/v1/jobs/:id/worktrees/expand', (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job không tồn tại' });
    }
    const { service_key, reason } = req.body;
    if (!service_key) {
      return res.status(400).json({ success: false, error: 'service_key là bắt buộc' });
    }

    // 1. Kiểm tra xem worktree cho service này đã tồn tại cho job chưa
    const existingWt = db.getJobWorktree(id, service_key);
    if (existingWt && existingWt.status === 'ACTIVE') {
      return res.json({ success: true, worktree: existingWt, already_exists: true });
    }

    // 2. Tìm thông tin service trong workspace
    let ws = null;
    if (job.workspace_id) {
      ws = db.getWorkspaceById(job.workspace_id);
    }
    if (!ws) {
      const defaultWs = db.listWorkspaces().find(w => w.is_default);
      ws = defaultWs || db.listWorkspaces()[0];
    }
    if (!ws) {
      return res.status(400).json({ success: false, error: 'Không tìm thấy workspace hợp lệ' });
    }

    let svcConfig = db.getWorkspaceServiceByKey(ws.id, service_key);
    let repoFullPath = '';
    let baseDevBranch = 'main';

    if (svcConfig) {
      baseDevBranch = svcConfig.dev_branch || 'main';
      repoFullPath = path.isAbsolute(svcConfig.repo_path)
        ? svcConfig.repo_path
        : path.resolve(ws.path, svcConfig.repo_path);
    } else {
      // Fallback: Kiểm tra thư mục service_key trong ws.path
      const candidatePath = path.resolve(ws.path, service_key);
      if (fs.existsSync(candidatePath) && fs.existsSync(path.join(candidatePath, '.git'))) {
        repoFullPath = candidatePath;
        baseDevBranch = worktreeManager.getRepoCurrentBranch(candidatePath);
      } else {
        return res.status(404).json({ success: false, error: `Không tìm thấy repository cho service '${service_key}' trong workspace` });
      }
    }

    // 3. Chuẩn bị đường dẫn worktree bên trong service repo: <serviceRepoPath>/.worktrees/<task_code>
    const taskCode = job.task_code || job.id;
    const taskBranch = `feature/${taskCode}`;
    const worktreeDestPath = path.join(repoFullPath, '.worktrees', taskCode);
    // 4. Tạo worktree qua worktreeManager
    const wtResult = worktreeManager.createTaskWorktree({
      repoFullPath,
      worktreeDestPath,
      taskBranch,
      baseDevBranch
    });

    if (!wtResult.success) {
      return res.status(500).json({ success: false, error: wtResult.error || 'Lỗi tạo worktree' });
    }

    // 5. Lưu vào database
    const createdWt = db.addJobWorktree({
      job_id: id,
      service_key,
      worktree_path: wtResult.worktree_path,
      task_branch: taskBranch,
      base_dev_branch: baseDevBranch,
      status: 'ACTIVE'
    });

    // Cập nhật worktree_path của job nếu chưa có
    if (!job.worktree_path) {
      db.updateJob(id, { worktree_path: wtResult.worktree_path });
    }

    // Lưu cấu hình task manifest riêng (Tầng 2)
    const allWts = db.listJobWorktrees(id);
    worktreeManager.saveTaskManifest(baseWorktreesDir, {
      task_code: taskCode,
      branch: taskBranch,
      services: allWts.map(w => ({
        service: w.service_key,
        worktree_path: w.worktree_path,
        dev_branch: w.base_dev_branch,
        status: w.status
      }))
    });

    // Xuất snapshot worktrees/registry.json (Tầng 3 Read-only Snapshot)
    try {
      const allActiveWts = db.getDb().prepare("SELECT * FROM job_worktrees WHERE status = 'ACTIVE'").all();
      worktreeManager.exportWorktreesRegistry(allActiveWts);
    } catch {}

    return res.status(201).json({
      success: true,
      worktree: createdWt,
      reason
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
/**
 * Trích xuất đoạn lỗi compile/build thực sự từ output của re-test (Maven/Gradle/npm).
 * Ưu tiên các dòng [ERROR], ERROR, compilation failure, hoặc phần đuôi (nơi in chi tiết lỗi).
 */
function extractBuildErrorSnippet(output, maxLen = 1500) {
  if (!output || typeof output !== 'string') return '';
  const clean = output.trim();
  if (clean.length <= maxLen) return clean;
  const lines = clean.split('\n');
  const errorLines = lines.filter(l => /\[ERROR\]|error:|compilation failure|cannot find symbol|syntax error|Exception/i.test(l));
  if (errorLines.length > 0) {
    const errorText = errorLines.join('\n');
    if (errorText.length <= maxLen) return errorText;
    return errorText.slice(-maxLen);
  }
  // Fallback: Lấy từ đuôi (nơi in stack trace và thông báo lỗi cuối cùng của build tool)
  return clean.slice(-maxLen);
}

/**
 * Tự động tạo Git Worktree cho các service mục tiêu được xác định sau bước PLANNING.
 * Chỉ tách worktree cho đúng những service đó, không tách chung cho toàn bộ workspace.
 */
function ensureTargetServicesWorktrees(jobId) {
  try {
    const job = db.getJobById(jobId);
    if (!job || !job.workspace_id) return [];

    const ws = db.getWorkspaceById(job.workspace_id);
    if (!ws) return [];

    const wsServices = db.listWorkspaceServices(ws.id);
    if (!wsServices || wsServices.length === 0) return [];

    const taskCode = job.task_code || job.id;
    const planFiles = fileManager.readPlanFiles(job.repo_path || ws.path, taskCode);
    const devPlanText = (planFiles && planFiles.devPlan) || '';

    const pipeConf = jobPolicy.parsePipelineConfig(job);
    let targetServices = (pipeConf && Array.isArray(pipeConf.target_services)) ? pipeConf.target_services : [];
    if (targetServices.length === 0 && devPlanText) {
      targetServices = extractTargetServicesFromDevPlan(devPlanText, wsServices, `${job.title || ''} ${job.prompt || ''} ${taskCode}`);
    }

    if (targetServices.length === 0) {
      console.log(`[WORKTREE] Task ${taskCode}: Không phát hiện service mục tiêu cụ thể từ dev_plan.md, tiếp tục trong workspace.`);
      return [];
    }

    const baseWorktreesDir = path.join(ws.path, '.worktrees', taskCode);
    const createdWorktrees = [];

    for (const sKey of targetServices) {
      const existingWt = db.getJobWorktree(jobId, sKey);
      if (existingWt && existingWt.status === 'ACTIVE') {
        createdWorktrees.push(existingWt);
        continue;
      }

      const svcConf = db.getWorkspaceServiceByKey(ws.id, sKey);
      if (!svcConf) continue;

      const rPath = path.isAbsolute(svcConf.repo_path)
        ? svcConf.repo_path
        : path.resolve(ws.path, svcConf.repo_path);

      if (!fs.existsSync(rPath) || !fs.existsSync(path.join(rPath, '.git'))) continue;

      const bBranch = svcConf.dev_branch || worktreeManager.getRepoCurrentBranch(rPath) || 'main';
      const destP = path.join(rPath, '.worktrees', taskCode);
      const crRes = worktreeManager.createTaskWorktree({
        repoFullPath: rPath,
        worktreeDestPath: destP,
        taskBranch: `feature/${taskCode}`,
        baseDevBranch: bBranch
      });

      if (crRes.success) {
        const newWt = db.addJobWorktree({
          job_id: jobId,
          service_key: sKey,
          worktree_path: crRes.worktree_path,
          task_branch: `feature/${taskCode}`,
          base_dev_branch: bBranch,
          status: 'ACTIVE'
        });
        createdWorktrees.push(newWt);
      } else {
        jobEventBus.emitJobLog(jobId, {
          text: `\n[WORKTREE-ERROR] ❌ Không tạo được worktree cho '${sKey}' tại ${destP}: ${crRes.error || 'lỗi không xác định'}\n`
        });
      }
    }

    if (createdWorktrees.length > 0) {
      // Xác định primary service dựa trên task title / prompt / devPlanText (ví dụ [DEV-FE] -> ưu tiên service -fe)
      const taskMeta = `${job.title || ''} ${job.prompt || ''} ${taskCode} ${devPlanText}`.toLowerCase();
      let primaryWt = createdWorktrees[0];
      if (/\[dev-fe\]|\bfe\b|frontend|giao diện/i.test(taskMeta)) {
        const feWt = createdWorktrees.find(w => w.service_key.toLowerCase().includes('fe') || w.service_key.toLowerCase().includes('frontend'));
        if (feWt) primaryWt = feWt;
      } else if (/\[dev-be\]|\[dev-db\/be\]|\bbe\b|backend|database/i.test(taskMeta)) {
        const beWt = createdWorktrees.find(w => w.service_key.toLowerCase().includes('be') || w.service_key.toLowerCase().includes('backend'));
        if (beWt) primaryWt = beWt;
      }

      db.updateJob(jobId, { worktree_path: primaryWt.worktree_path });
      for (const wtItem of createdWorktrees) {
        worktreeManager.saveTaskManifest(wtItem.worktree_path, {
          task_code: taskCode,
          workspace_id: ws.id,
          primary_service: primaryWt.service_key,
          services: createdWorktrees.map(w => ({
            service: w.service_key,
            worktree_path: w.worktree_path,
            dev_branch: w.base_dev_branch,
            status: w.status
          }))
        });
      }
      try {
        const allActiveWts = db.getDb().prepare("SELECT * FROM job_worktrees WHERE status = 'ACTIVE'").all();
        worktreeManager.exportWorktreesRegistry(allActiveWts);
      } catch {}

      jobEventBus.emitJobLog(jobId, {
        text: `\n[WORKTREE] 🌿 Đã tách Git Worktree riêng bên trong service: [${targetServices.join(', ')}] tại <service>/.worktrees/${taskCode}/\n`
      });
    }

    return createdWorktrees;
  } catch (err) {
    console.warn('[WORKTREE-TARGET-SYNC-WARN]', err.message);
    return [];
  }
}

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
      timeout_seconds,
      timeoutSeconds,
      timeout_minutes,
      timeoutMinutes,
      timeoutMs,
      timeout_ms,
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
    {
      const uiTimeoutMs = config.normalizeTimeoutMs({
        timeoutMs: timeoutMs !== undefined ? timeoutMs : timeout_ms,
        timeout_seconds: timeout_seconds !== undefined ? timeout_seconds : timeoutSeconds,
        timeout_minutes: timeout_minutes !== undefined ? timeout_minutes : timeoutMinutes,
        timeout: timeout
      }, null);
      if (uiTimeoutMs !== null && uiTimeoutMs !== undefined) mergedPipelineConfig.timeout = uiTimeoutMs;
      // mergedPipelineConfig.timeout tới đây là giá trị RAW từ pipeline_config.
      // normalizeTimeoutMs giữ nguyên số >= 10000 (đã là ms) nên không nhân đôi.
      else if (mergedPipelineConfig.timeout !== undefined) mergedPipelineConfig.timeout = config.normalizeTimeoutMs(mergedPipelineConfig.timeout, config.DEFAULT_TIMEOUT_MS);
    }
    if (model) mergedPipelineConfig.model = model;
    if (runners) mergedPipelineConfig.runners = runners;
    const bodyMaxRetries = req.body.max_retries ?? req.body.maxRetries ?? req.body.maxretries ?? req.body.max_fixing_retries ?? req.body.maxFixingRetries;
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
/**
 * Parse `systemone_state` (JSON string trong SQLite) thanh object cho API.
 * Parse loi => null (coi nhu CHUA goi model).
 * @param {object} job
 * @returns {object|null}
 */
function parseSystemOneState(job) {
  if (!job || !job.systemone_state) return null;
  try {
    const v = typeof job.systemone_state === 'string' ? JSON.parse(job.systemone_state) : job.systemone_state;
    if (!v || typeof v !== 'object') return null;
    return {
      live: v.live === true ? true : (v.live === false ? false : null),
      calls: Number(v.calls) || 0,
      fallbacks: Number(v.fallbacks) || 0,
      lastError: v.lastError || null,
      lastDecision: v.lastDecision || null,
      decisions: Array.isArray(v.decisions) ? v.decisions : [],
      model: v.model || null,
      updatedAt: v.updatedAt || null
    };
  } catch (e) {
    return null;
  }
}

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

    // Badge SystemOne per-task: tra `systemone_state` da parse (object, khong phai string).
    // Dong thoi tra runtime_ms: tong thoi gian thuc su worker chay task.
    const queuedJobIds = new Set(taskQueue.getQueuedJobs().map((q) => q.id));
    // 1 query duy nhat cho toan bo steps (truoc day 1 query/job => N+1).
    const stepsByJob = db.getStepsByJobIds(jobs.map((j) => j.id));
    const jobsWithSo = jobs.map((j) => {
      const steps = stepsByJob.get(j.id) || [];
      return {
        ...j,
        is_queued: queuedJobIds.has(j.id),
        systemone_state: parseSystemOneState(j),
        runtime_ms: computeJobRuntimeMs(j, steps)
      };
    });
    return res.json({
      success: true,
      jobs: jobsWithSo,
      total: jobsWithSo.length
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
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, '')); } catch(e){}
  }
  // evidenceStore hieu ca 3 shape (array / map / tests[]); getEvidenceFileMeta chi doc duoc 2.
  const storeMeta = evidenceStore.readMetadata(taskEvidenceDir);
  const storeByFile = new Map();
  for (const rec of storeMeta.records) {
    storeByFile.set(String(rec.fileName || '').toLowerCase(), rec);
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
      // Dung cache theo (path|size|mtime): tranh doc lai cung 1 file 3 lan/request.
      const cachedFile = getCachedEvidenceFile(fullFilePath, stat);
      if (ext === '.json') {
        try {
          const raw = String(cachedFile.text || '').trim();
          if (!raw || raw === '{}' || raw === '[]' || raw === 'null') return;
        } catch (e) { return; }
      } else if (ext === '.log' || ext === '.txt') {
        try {
          const raw = String(cachedFile.text || '').trim();
          if (!raw) return;
        } catch (e) { return; }
      }

      // CHI record tu evidenceStore (da qua suppressUnverified) moi mang trang thai
      // dang tin. Fallback `getEvidenceFileMeta` doc RAW metadata ma AGENT tu viet
      // (status: "PASSED") => phai ep NOT VERIFY, neu khong file co extension
      // ngoai EVIDENCE_FILE_RE (vd .xlsx/.pdf/.zip) se LOTT qua gate.
      const storeRec = storeByFile.get(file.toLowerCase());
      const meta = storeRec ? storeRec : { ...getEvidenceFileMeta(metadata, file), status: undefined, verdict: undefined };
      const evidenceHashes = buildEvidenceHashes(fullFilePath, stat);
      let fileContent = '';
      let parsedData = null;
      if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) {
        parsedData = null;
      } else if (TEXT_EVIDENCE_EXTS.includes(ext)) {
        // File text: lay noi dung tu cache (da doc o tren), khong doc lai dia.
        fileContent = cachedFile.text || '';
        if (ext === '.json' && fileContent) {
          try { parsedData = JSON.parse(fileContent.replace(/^\uFEFF/, '')); } catch (e) { parsedData = null; }
        }
      } else {
        // File binary (.xlsx/.pdf/.zip...): doc nhu utf8 se ra "PK\x03\x04..."
        // (mojibake) -> de content rong, client tai qua /evidence/files/:filename.
        fileContent = '';
        parsedData = null;
      }
      let type = resolveEvidenceType({ filename: file, ext, meta, parsedData });

      const taskCode = job.task_code || job.id;
      const fallbackTitle1 = file.replace(ext, '').replace(/^[0-9]+_/, '').replace(/[-_]/g, ' ');
      const evidenceTitle1 = meta.name || meta.stepName || meta.description || meta.title || fallbackTitle1;
      const evidenceStep1 = meta.stepName || meta.step || meta.stepId || null;
      const evidenceCase1 = meta.caseName || meta.testCase || meta.testcase || (typeof meta.case === 'string' ? meta.case : null) || null;
      const evidenceCapturedAt1 = meta.timestamp || meta.capturedAt || meta.captured_at || meta.created_at || meta.createdAt || meta.time || null;
      // Vong doi trang thai 3 gia tri: NOT VERIFY (chua verify) -> PASS | FAILED.
      const evStatus1 = evidenceStore.normalizeStatus(meta.status !== undefined ? meta.status : meta.verdict);
      const evVerdict1 = evidenceStore.verdictOf(evStatus1);
      const itemObj = {
        id: `${job.id}-ev-${idx}`,
        job_id: job.id,
        type,
        evidence_type: type,
        channel: evidenceChannelOf(type),
        verdict: evVerdict1,
        file_path: `/api/v1/jobs/${job.id}/evidence/files/${encodeURIComponent(file)}`,
        url: `/api/v1/jobs/${job.id}/evidence/files/${encodeURIComponent(file)}`,
        status: evStatus1,
        name: meta.name || evidenceTitle1,
        passCriteria: meta.passCriteria || meta.pass_criteria || meta.criteria || meta.expected || null,
        order: (meta.order !== undefined && meta.order !== null) ? meta.order : (meta.stepIndex !== undefined && meta.stepIndex !== null ? meta.stepIndex : null),
        stepIndex: (meta.stepIndex !== undefined && meta.stepIndex !== null) ? meta.stepIndex : null,
        title: evidenceTitle1,
        displayName: evidenceTitle1,
        filename: file,
        stepId: meta.stepId || null,
        stepName: meta.stepName || null,
        step: evidenceStep1,
        evidenceId: meta.evidenceId || null,
        timestamp: meta.timestamp || null,
        capturedAt: evidenceCapturedAt1,
        created_at: evidenceCapturedAt1 || (stat && stat.mtime ? stat.mtime.toISOString() : null),
        description: meta.description || null,
        testCase: meta.testCase || null,
        testcase: meta.testcase || meta.testCase || null,
        case: meta.case != null ? meta.case : (evidenceCase1 || null),
        caseName: evidenceCase1,
        actionType: meta.actionType || null,
        currentUrl: meta.currentUrl || null,
        service_name: taskCode || 'Target Service',
        service: taskCode || 'Target Service',
        content: fileContent ? (fileContent.length > MAX_INLINE_EVIDENCE_CONTENT
          ? fileContent.slice(0, MAX_INLINE_EVIDENCE_CONTENT)
          : fileContent) : '',
        // `rawLogs`/`logs` truoc day copy y nguyen `content` (them ~200KB/job).
        // Giu alias rong de client cu khong vo, dung `content` lam nguon duy nhat.
        rawLogs: '',
        logs: '',
        truncated: Boolean(fileContent && fileContent.length > MAX_INLINE_EVIDENCE_CONTENT),
        log_excerpt: fileContent ? fileContent.slice(0, 300) : '',
        // File binary (.xlsx/.pdf/...): noi dung khong doc duoc -> client bo qua
        // `content` va tai file qua /evidence/files/:filename.
        downloadable: !TEXT_EVIDENCE_EXTS.includes(ext) && !['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext),
        size: (typeof evidenceHashes !== 'undefined' && evidenceHashes.size != null ? evidenceHashes.size : stat.size),
        sizeBytes: (typeof evidenceHashes !== 'undefined' && evidenceHashes.sizeBytes != null ? evidenceHashes.sizeBytes : stat.size),
        md5: (typeof evidenceHashes !== 'undefined' && evidenceHashes.md5) || null,
        contentHash: (typeof evidenceHashes !== 'undefined' && evidenceHashes.contentHash) || null
      };

      if (type === 'API_TEST' && parsedData) {
        itemObj.method = (parsedData.method || parsedData.httpMethod || (parsedData.request && parsedData.request.method) || 'GET').toUpperCase();
        itemObj.endpoint = parsedData.endpoint || parsedData.url || parsedData.baseUrl || (parsedData.request && (parsedData.request.url || parsedData.request.endpoint || parsedData.request.path)) || '/api';
        itemObj.statusCode = parsedData.statusCode || parsedData.status_code || parsedData.httpStatus || parsedData.status || (parsedData.response && parsedData.response.status) || 200;
        itemObj.durationMs = parsedData.durationMs || parsedData.duration_ms || parsedData.latency_ms || parsedData.latency || 0;
        itemObj.request = parsedData.request || { method: itemObj.method, endpoint: itemObj.endpoint, headers: parsedData.headers, body: parsedData.body || parsedData.payload };
        itemObj.response = parsedData.response || { status: itemObj.statusCode, headers: parsedData.responseHeaders, body: parsedData.responseBody || parsedData.data || parsedData.firstItem };
        itemObj.parsedData = parsedData;
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

  // Sap xep theo thu tu step test: order -> stepIndex -> timestamp -> ten file.
  list.sort((a, b) => {
    const ao = (a.order === null || a.order === undefined) ? null : Number(a.order);
    const bo = (b.order === null || b.order === undefined) ? null : Number(b.order);
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    const at = Date.parse(a.timestamp || '') || 0;
    const bt = Date.parse(b.timestamp || '') || 0;
    if (at !== bt) return at - bt;
    return String(a.filename || '').localeCompare(String(b.filename || ''));
  });
  list.forEach((e, idx) => { e.id = `${job.id}-ev-${idx}`; });

  // Giữ toàn bộ evidence (không cắt 2 loại) để tab API/Log không mất mục cũ.
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

    // `id` tu URL co the la prefix/task_code => dung id canonical de doc steps
    // (bang `steps` luon luu job_id la UUID day du).
    const canonicalId = job.id || id;
    const steps = db.getStepsByJobId(canonicalId);
    const dualPlan = db.getDualPlanByJobId(id);
    const pendingQuestion = db.getPendingQuestionByJobId(id);
    const questions = db.getQuestionsByJobId(id);
    const evidence = getTaskEvidences(job);
    const isQueued = taskQueue.isJobQueued(canonicalId);
    const fullJobData = {
      ...job,
      is_queued: isQueued,
      systemone_state: parseSystemOneState(job),
      steps,
      // Thoi luong worker THUC SU chay task (tong cac doan steps da/đang chay).
      // Khong phai wall-clock tu created_at (sai: tinh ca thoi gian cho queue/cho user).
      runtime_ms: computeJobRuntimeMs(job, steps),
      dual_plan: dualPlan,
      pending_question: pendingQuestion,
      question: pendingQuestion,
      questions,
      evidence
    };

    // Tra ve DUY NHAT 1 khoa cho moi du lieu. Truoc day response con lap lai
    // `evidence`/`evidences` + `dual_plan`/`dualPlan` + `steps` o ca job va
    // top-level => payload 1,7MB cho 1 job (gap ~12 lan). Client da doc theo
    // `data.job.*` nen khong can alias nua.
    // `?compat=1` giu shape cu cho consumer ben ngoai chua kip cap nhat.
    if (String(req.query.compat || '') === '1') {
      const legacy = {
        ...fullJobData,
        dualPlan: dualPlan,
        evidences: evidence
      };
      return res.json({
        success: true,
        job: legacy,
        evidence,
        evidences: evidence,
        dual_plan: dualPlan,
        dualPlan,
        question: pendingQuestion,
        questions,
        steps
      });
    }

    return res.json({
      success: true,
      job: fullJobData
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

    const { task_code, prompt, title, repo_path, repoPath, base_branch, branch, timeout, timeout_seconds, timeoutSeconds, timeout_minutes, timeoutMinutes, timeoutMs, timeout_ms, max_retries, maxRetries, pipeline_config, pipelineConfig, model } = req.body;
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
    if (hasIncomingPipe || timeout !== undefined || timeout_seconds !== undefined || timeoutSeconds !== undefined || timeout_minutes !== undefined || timeoutMinutes !== undefined || timeoutMs !== undefined || timeout_ms !== undefined || max_retries !== undefined || maxRetries !== undefined || model !== undefined) {
      let mergedPipe = {};
      if (job.pipeline_config) {
        try {
          mergedPipe = typeof job.pipeline_config === 'string' ? JSON.parse(job.pipeline_config) : { ...job.pipeline_config };
        } catch (e) { mergedPipe = {}; }
      }
      if (hasIncomingPipe) mergedPipe = { ...mergedPipe, ...incomingPipeRaw };
      {
        const uiTimeoutMs = config.normalizeTimeoutMs({
          timeoutMs: timeoutMs !== undefined ? timeoutMs : timeout_ms,
          timeout_seconds: timeout_seconds !== undefined ? timeout_seconds : timeoutSeconds,
          timeout_minutes: timeout_minutes !== undefined ? timeout_minutes : timeoutMinutes,
          timeout: timeout
        }, null);
        if (uiTimeoutMs !== null && uiTimeoutMs !== undefined) mergedPipe.timeout = uiTimeoutMs;
        else if (mergedPipe.timeout !== undefined) mergedPipe.timeout = config.normalizeTimeoutMs(mergedPipe.timeout, config.DEFAULT_TIMEOUT_MS);
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
    jobEventBus.emitJobStatus(id, { status: updatedJob.status, current_step: updatedJob.current_step, job: updatedJob });
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
 * POST /api/v1/jobs/:id/quick-track
 * Bat/TAT che do nhanh (quick track) cho 1 task.
 *
 * Body (1 trong 2):
 * - { mode: 'auto' | 'on' | 'off' }  (UI dung dang nay)
 * - { enabled: boolean }             (backward compat)
 *
 * - 'on'  -> pipeline_config.quick_track = true
 * - 'off' -> pipeline_config.quick_track = false (TAT TUONG MINH: triage KHONG tu bat lai)
 * - 'auto'-> XOA key quick_track (he thong tu quyet dinh theo do phuc tap)
 */
app.post('/api/v1/jobs/:id/quick-track', (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }
    const body = req.body || {};
    let enabled;
    if (body.mode !== undefined && body.mode !== null) {
      const mode = String(body.mode).trim().toLowerCase();
      if (mode === 'auto') enabled = null;
      else if (mode === 'on' || mode === 'true') enabled = true;
      else if (mode === 'off' || mode === 'false') enabled = false;
      else {
        return res.status(400).json({ success: false, error: 'Tham so "mode" phai la "auto" | "on" | "off"' });
      }
    } else {
      const raw = body.enabled !== undefined ? body.enabled : body.quick_track;
      if (raw === undefined || raw === null) {
        return res.status(400).json({ success: false, error: 'Thieu tham so "mode" hoac "enabled"' });
      }
      const rawStr = String(raw).trim().toLowerCase();
      if (raw !== true && raw !== false && rawStr !== 'true' && rawStr !== 'false') {
        return res.status(400).json({ success: false, error: 'Tham so "enabled" phai la boolean' });
      }
      enabled = raw === true || rawStr === 'true';
    }
    setQuickTrack(id, enabled);
    const label = enabled === null ? 'Tu dong (he thong tu quyet dinh)' : (enabled ? 'Bat' : 'Tat');
    jobEventBus.emitJobLog(id, { text: `\n[QUICK-TRACK] Che do NHANH: ${label} cho task ${job.task_code || id}.\n` });
    return res.json({ success: true, quick_track: enabled });
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

    // Dung chung ham getTaskEvidences voi endpoint /api/v1/jobs/:id.
    // Truoc day endpoint nay copy lai logic doc file => 2 noi lech nhau
    // (vd file binary doc nhu utf8 -> "PK\x03\x04..." rac mojibake).
    const realEvidenceList = getTaskEvidences(job);
    // Giữ toàn bộ evidence (không cắt 2 loại) để tab API/Log không mất mục cũ.
    const filteredEvidenceList = realEvidenceList;

    return res.json({
      success: true,
      evidence: filteredEvidenceList,
      evidences: filteredEvidenceList,
      totalFound: realEvidenceList.length,
      typesAllowed: Array.from(new Set(realEvidenceList.map((e) => e.type))),
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
      // AGENTS.md §11.2: KHONG xoá vĩnh viễn - chuyển vào thùng rác.
      if (safeMoveToTrash(targetFilePath)) {
        console.log(`[Evidence Delete] Đã chuyển vào thùng rác: ${targetFilePath}`);
      } else {
        try {
          fs.unlinkSync(targetFilePath);
          console.warn(`[Evidence Delete] Không chuyển được vào thùng rác, đã xoá: ${targetFilePath}`);
        } catch (unlinkErr) {
          console.warn(`[Evidence Delete] Không thể xoá file vật lý ${targetFilePath}:`, unlinkErr.message);
        }
      }
    }

    // 3. Cập nhật metadata.json trên đĩa
    const metadataPath = path.join(taskEvidenceDir, 'metadata.json');
    if (fs.existsSync(metadataPath)) {
      try {
        const raw = fs.readFileSync(metadataPath, 'utf8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter(item => {
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
    // Vong doi 3 gia tri: NOT VERIFY | PASS | FAILED. 'PASSED'/'PASS'/'FAIL'/'FAILED' deu hop le.
    const rawStatus = body.status !== undefined ? body.status : body.verdict;
    if (rawStatus === undefined || rawStatus === null || rawStatus === '') {
      return res.status(400).json({ success: false, error: 'Thiếu trạng thái (status: NOT VERIFY | PASS | FAILED)' });
    }
    const status = evidenceStore.normalizeStatus(rawStatus);
    const verdict = evidenceStore.verdictOf(status);

    // Giu nguyen shape metadata.json hien co (array / map / tests[]) - evidenceStore lo phan nay.
    const applied = evidenceStore.setStatuses(taskEvidenceDir, { [safeFilename]: status });
    if (!applied) {
      // File chua co trong metadata -> them moi record (shape rong).
      try {
        const created = evidenceStore.readMetadata(taskEvidenceDir);
        const rec = evidenceStore.normalizeRecord({
          fileName: safeFilename,
          status,
          timestamp: new Date().toISOString(),
          updated_at: new Date().toISOString()
        });
        const hint = normalizeEvidenceTypeHint({ type: body.type, evidence_type: body.evidence_type, channel: body.channel });
        if (hint) {
          rec.type = hint;
          rec.evidence_type = hint;
          rec.channel = evidenceChannelOf(hint);
        }
        created.records.push(rec);
        evidenceStore.writeMetadata(taskEvidenceDir, created.shape, created.raw, created.records);
      } catch (writeErr) {
        return res.status(500).json({ success: false, error: writeErr.message });
      }
    }

    return res.json({
      success: true,
      filename: safeFilename,
      status,
      verdict,
      metadata: { status, verdict }
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
  const id = jobId;
  let agentFailed = false;
  const reasons = [];
  // File evidence bi xac dinh loi trong qua verify -> danh dau FAILED.
  const failedEvidenceFiles = new Set();
  // Khai bao o scope ngoai inner try: khoi ghi trang thai chay SAU inner catch
  // nen `validFiles` khai trong inner try se bi ReferenceError.
  let validFiles = [];
  const originalEmit = jobEventBus.emitJobLog;
  jobEventBus.emitJobLog = (targetId, payload) => {
    if (payload && typeof payload.text === 'string') {
      const match = payload.text.match(/\[TESTING-VERIFY\]\s*❌\s*([^\n\r]+)/);
      if (match && match[1]) {
        const clean = match[1].trim();
        if (!reasons.includes(clean)) reasons.push(clean);
      }
    }
    return originalEmit.call(jobEventBus, targetId, payload);
  };
  try {
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
  
          validFiles = getValidEvidenceFiles();
          let metadataObj = {};
          const metaPath = path.join(evidenceDir, 'metadata.json');
          if (fs.existsSync(metaPath)) {
            try { metadataObj = JSON.parse(fs.readFileSync(metaPath, 'utf8').replace(/^\uFEFF/, '')); } catch (e) {}
          }

          // CÁCH LY FILE LẠ TRƯỚC KHI CHẤM: agent hay thả log runtime / ảnh debug vào
          // evidence/ (be_8082_fix7.log, debug_*.png...). Chúng không chứng minh cho
          // test case nào nên bị chuyển sang evidence_quarantine/ thay vì đánh trượt
          // job. Phải làm ở đây để danh sách ảnh đem chấm AI Vision không còn file lạ.
          //
          // CHỈ cách ly khi MỌI test case đã có evidence khai báo (mapping đầy đủ):
          // lúc đó file lạ chắc chắn là rác vệ sinh. Nếu mapping còn thiếu (tests[] rỗng
          // hoặc có test không khai evidence) thì giữ nguyên luật cũ: FAIL, vì đó là
          // dấu hiệu bằng chứng không được ánh xạ chứ không phải rác.
          const testsArrEarly = (metadataObj && Array.isArray(metadataObj.tests)) ? metadataObj.tests : [];
          const testHasEvidence = (t) => {
            if (!t || typeof t !== 'object') return false;
            for (const field of ['evidence', 'evidences', 'files']) {
              const v = t[field];
              if (Array.isArray(v) && v.length > 0) return true;
              if (typeof v === 'string' && v.trim()) return true;
              if (v && typeof v === 'object' && Object.keys(v).length > 0) return true;
            }
            return false;
          };
          const mappingComplete = testsArrEarly.length > 0 && testsArrEarly.every(testHasEvidence);
          const declaredEarly = collectDeclaredEvidenceNames(metadataObj);
          if (declaredEarly.size > 0 && mappingComplete) {
            const undeclaredEarly = validFiles.filter(
              (f) => f !== 'metadata.json' && ![...declaredEarly].some((d) => d.includes(f) || f.includes(d))
            );
            if (undeclaredEarly.length > 0) {
              const movedEarly = quarantineUndeclaredEvidence(evidenceDir, undeclaredEarly);
              if (movedEarly.ok > 0) {
                const movedSet = new Set(undeclaredEarly);
                validFiles = validFiles.filter((f) => !movedSet.has(f));
              }
              jobEventBus.emitJobLog(id, {
                text: `\n[TESTING-VERIFY] ⚠️ Cách ly ${movedEarly.ok}/${undeclaredEarly.length} file không khai trong metadata.json khỏi evidence/ (→ ${movedEarly.dir || 'evidence_quarantine'}): ${undeclaredEarly.join(', ')}. Đây không phải bằng chứng nên KHÔNG tính là lỗi.\n`,
                level: 'warn'
              });
            }
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
                metadataObj = JSON.parse(metaRaw.replace(/^\uFEFF/, ''));
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
                const badTest = testsArr.some(t => !t || !/^(PASSED|PASS|NOT\s*VERIFY|CAPTURED|COLLECTED|)$/i.test(String((t.status || t.verdict || '')).trim()) || scanStatusWeasel(t));
                if (badTest) {
                  agentFailed = true;
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: metadata.json có test case chưa PASSED thật (FAILED/PARTIAL/SKIPPED). Chỉ DONE khi 100% case PASSED!\n`
                  });
                }
                // Phát hiện tự mâu thuẫn: note/mô tả ghi nhận mismatch/lệch dữ liệu nhưng test case lại để status PASSED
                const CONTRADICTION_RE = /\b(mismatch|discrepanc|unmatched)\b|không\s*khớp|khong\s*khop|lệch\s*(dữ\s*liệu|cột|thời\s*gian|múi\s*giờ|kết\s*quả|bản\s*ghi)|lech\s*(du\s*lieu|cot|thoi\s*gian|mui\s*gio|ket\s*qua|ban\s*ghi)/i;
                const hasContradiction = testsArr.some(t => {
                  if (!t || typeof t !== 'object') return false;
                  const isPass = /^(PASSED|PASS)$/i.test(String((t.status || t.verdict || '')).trim());
                  if (!isPass) return false;
                  const noteStr = [t.note, t.description, t.summary, t.reason, t.details, t.message, t.error].filter(Boolean).join(' ');
                  return CONTRADICTION_RE.test(noteStr);
                });
                if (hasContradiction) {
                  agentFailed = true;
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: Phát hiện test case tự mâu thuẫn (ghi nhận mismatch/lệch dữ liệu API-DB nhưng vẫn để status PASSED). Phải sửa nguyên nhân lệch và đối soát khớp 100% mới được PASS!\n`
                  });
                }
                // Mọi file evidence phải được khai báo trong metadata.json để chứng minh mapping với test case
                // `t.evidence` do AGENT tự viết => co the la object/string, khong phai array.
                // Khong Array.isArray => .forEach throw => catch ngoai => gate FAIL-OPEN (PASS khong bang chung).
                const declared = new Set();
                for (const t of testsArr) {
                  if (!t || typeof t !== 'object') continue;
                  for (const field of ['evidence', 'evidences', 'files']) {
                    const v = t[field];
                    if (Array.isArray(v)) for (const f of v) declared.add(String(f));
                    else if (typeof v === 'string' && v) declared.add(v);
                    else if (v && typeof v === 'object') {
                      // object dang { fileName: 'a.png' } hoac map { 'a.png': {...} }
                      for (const [k, val] of Object.entries(v)) {
                        if (typeof k === 'string' && k) declared.add(k);
                        if (val && typeof val === 'object' && val.fileName) declared.add(String(val.fileName));
                      }
                    }
                  }
                }
                const undeclared = validFiles.filter(f => f !== 'metadata.json' && ![...declared].some(d => d.includes(f) || f.includes(d)));
                if (undeclared.length > 0) {
                  // File lạ còn lại = chưa cách ly được (mapping chưa đầy đủ, file đang bị
                  // giữ, hoặc khác ổ đĩa) => vẫn là lỗi: bằng chứng không được ánh xạ.
                  agentFailed = true;
                  undeclared.forEach((f) => failedEvidenceFiles.add(f));
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: File evidence chưa được khai trong metadata.json nên không chứng minh cho test case nào: ${undeclared.join(', ')}. Agent phải mapping mỗi file với đúng test case trong plan!\n`
                  });
                }
                // CHIỀU NGƯỢC: file KHAI trong metadata.json nhưng KHÔNG TỒN TẠI trên đĩa
                // => bằng chứng không có thật. Job RSGATE-44: metadata khai 17 file,
                // evidence/ chỉ còn metadata.json -> có thể PASS với 0 bằng chứng.
                // Độ chính xác phải tuyệt đối => file khai mà thiếu = FAIL.
                // Đường dẫn lồng nhau (sub/dir/a.png) phải được giữ, không cắt basename.
                const missingOnDisk = [];
                for (const d of declared) {
                  const raw = String(d).replace(/\\/g, '/').trim();
                  if (!raw || raw === 'metadata.json') continue;
                  const rel = raw.replace(/^\.\//, '');
                  const abs = path.isAbsolute(rel)
                    ? rel
                    : path.join(evidenceDir, rel);
                  if (!fs.existsSync(abs)) {
                    // Thử basename (metadata có thể khai chỉ tên file, file nằm ở evidence/ gốc).
                    const base = path.basename(rel);
                    if (!fs.existsSync(path.join(evidenceDir, base))) missingOnDisk.push(raw);
                  }
                }
                if (missingOnDisk.length > 0) {
                  agentFailed = true;
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${missingOnDisk.length} file bằng chứng được khai trong metadata.json nhưng KHÔNG tồn tại trên đĩa: ${missingOnDisk.slice(0, 20).join(', ')}${missingOnDisk.length > 20 ? ', ...' : ''}. Agent phải tạo đúng các file bằng chứng này (đường dẫn khai trong metadata.json phải trỏ tới file thật)!\n`
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
            const LOG_KEY_RE = /browser|capture|screenshot|playwright|puppeteer|navigate|GET\s+\/api|POST\s+\/api|PUT\s+\/api|DELETE\s+\/api|PATCH\s+\/api|tsc|pytest|npm\s+test|mvn\s+test|go\s+test|passed|failed|assert|✓|✔|PASS/i;
            const RUNTIME_KEY_RE = /listening|started|ready|listening on|server.*port|GET\s+\/|POST\s+\/|PUT\s+\/|DELETE\s+\/|PATCH\s+\/|incoming|request|response|status\s*2\d\d|200 OK/i;
            const BUILD_ONLY_RE = /npm install|npm run build|building|compiled|vite|webpack|tsc -b/i;
            for (const lf of logFiles) {
              const raw = fs.readFileSync(path.join(evidenceDir, lf), 'utf8');
              const trimmed = (raw || '').trim();
              if (/stdout\s*=\s*\(empty\)/i.test(trimmed) || /\(empty\)/i.test(trimmed) && trimmed.length < 1024 || (trimmed.length < 200 && !LOG_KEY_RE.test(trimmed) && !RUNTIME_KEY_RE.test(trimmed))) {
                agentFailed = true;
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${lf} rỗng giả (stdout empty, thiếu output/keyword test thật). Agent phải chạy lại lệnh test thật và lưu log đầy đủ!\n`
                });
                break;
              }
            }
          } catch (e) {}
          // 2c2. Chan API evidence chi la build log: *api*.json thieu HTTP runtime (method+url+status+body)
          try {
            const apiFiles = validFiles.filter(f => /api/i.test(f) && f.toLowerCase().endsWith('.json'));
            const HTTP_RUNTIME_RE = /GET|POST|PUT|DELETE|PATCH|http:\/\/localhost|\/api\//i;
            for (const af of apiFiles) {
              let rawA = '';
              try { rawA = fs.readFileSync(path.join(evidenceDir, af), 'utf8'); } catch (e) { rawA = ''; }
              rawA = rawA.replace(/^\uFEFF/, '');
              let objA = null;
              try { objA = JSON.parse(rawA); } catch (e) { objA = null; }
              const strA = (rawA || '');
              const eps = (objA && Array.isArray(objA.endpointsChecked)) ? objA.endpointsChecked : [];
              let hasMethod = !!(objA && (objA.method || objA.request || objA.endpoint || objA.url || objA.httpMethod || eps.length > 0));
              let hasUrl = !!(objA && (objA.url || objA.endpoint || objA.request || objA.baseUrl || eps.some(e => e && (e.endpoint || e.url))));
              let hasStatus = !!(objA && (objA.status || objA.responseStatus || objA.statusCode || objA.httpStatus || eps.some(e => e && (e.status || e.httpStatus || e.statusCode))));
              let hasBody = !!(objA && (objA.body || objA.data || objA.response || objA.payload || objA.result || objA.responseBody !== undefined || objA.responseData !== undefined || objA.count !== undefined || objA.items || objA.rows || objA.records || objA.total !== undefined || objA.itemCount !== undefined || objA.firstItem !== undefined || eps.length > 0));

              // Ho tro cau truc long test case (nested testcases: { login: { endpoint, httpStatus }, tc15_hub: { httpStatus, httpMethod }... })
              if (objA && typeof objA === 'object' && !Array.isArray(objA)) {
                const subValues = Object.values(objA).filter(v => v && typeof v === 'object' && !Array.isArray(v));
                if (subValues.length > 0) {
                  if (!hasMethod && subValues.some(s => s.endpoint || s.url || s.method || s.httpMethod)) hasMethod = true;
                  if (!hasUrl && (objA.baseUrl || subValues.some(s => s.endpoint || s.url || s.baseUrl))) hasUrl = true;
                  if (!hasStatus && subValues.some(s => s.status || s.httpStatus || s.statusCode)) hasStatus = true;
                  if (!hasBody && subValues.some(s => s.body || s.data || s.response || s.payload || s.result || s.responseBody !== undefined || s.responseData !== undefined || s.itemCount !== undefined || s.items || s.keys || s.count !== undefined || s.firstItem !== undefined)) hasBody = true;
                }
              } else if (Array.isArray(objA)) {
                if (objA.some(s => s && (s.endpoint || s.url || s.method || s.httpMethod))) hasMethod = true;
                if (objA.some(s => s && (s.endpoint || s.url || s.baseUrl))) hasUrl = true;
                if (objA.some(s => s && (s.status || s.httpStatus || s.statusCode))) hasStatus = true;
                if (objA.some(s => s && (s.body || s.data || s.response || s.payload || s.result || s.responseBody !== undefined || s.responseData !== undefined || s.itemCount !== undefined || s.items || s.firstItem !== undefined))) hasBody = true;
              }

              const buildOnlyApi = /npm install|npm run build|building|compiled|vite|webpack|tsc -b/i.test(strA) && !HTTP_RUNTIME_RE.test(strA);
              // Chấp nhận cả cấu trúc mảng bản ghi thật (results[]/cases[]/calls[]...),
              // không chỉ các key cố định ở cấp cao nhất.
              const runtimeRecordsOk = apiEvidenceHasRuntimeRecords(objA);
              const aggregateOk = hasMethod && hasUrl && hasStatus && hasBody;
              if (!objA || (!runtimeRecordsOk && !aggregateOk) || buildOnlyApi) {
                agentFailed = true;
                failedEvidenceFiles.add(af);
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${af} không phải API runtime (thiếu method+url đầy đủ http://localhost:PORT + path nghiệp vụ, status HTTP, request/response body thật, hoặc chỉ là build log). Chẩn đoán: ${describeApiEvidenceGaps(objA, { hasMethod, hasUrl, hasStatus, hasBody })}. Agent phải khởi động service thật, gọi API nghiệp vụ thật và lưu ${af} đầy đủ!\n`
                });
                break;
              }
            }
          } catch (e) {}
          // 2c3. Bắt buộc có runtime log service chứng minh service thật đã được bật và phục vụ request test
          try {
            const hasApiFile = validFiles.some(f => /api/i.test(f) && f.toLowerCase().endsWith('.json'));
            if (hasApiFile) {
              const logFiles2 = validFiles.filter(f => ['.log', '.txt'].includes(path.extname(f).toLowerCase()));
              let hasRuntime = false;
              for (const lf of logFiles2) {
                let raw2 = '';
                try { raw2 = fs.readFileSync(path.join(evidenceDir, lf), 'utf8'); } catch (e) { raw2 = ''; }
                if (/listening|started|ready|listening on|server.*port|GET\s+\/|POST\s+\/|PUT\s+\/|DELETE\s+\/|PATCH\s+\/|incoming|request|response|status\s*2\d\d|200 OK/i.test(raw2 || '')) { hasRuntime = true; break; }
              }
              if (!hasRuntime) {
                agentFailed = true;
                if (logFiles2.length > 0) {
                  logFiles2.forEach(f => failedEvidenceFiles.add(f));
                } else {
                  failedEvidenceFiles.add('05_service_runtime.log');
                }
                jobEventBus.emitJobLog(id, {
                  text: '\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: Có file API verification nhưng thiếu runtime log service (cần log chứa listening/started/ready + dòng request GET/POST/PUT/DELETE + status 2xx lúc phục vụ request test). Log hiện tại chỉ là build log hoặc thiếu log. Agent phải khởi động service thật và lưu runtime log!\n'
                });
              }
            }
          } catch (e) {}
          // 2d. Ảnh UI bắt buộc có kích thước tối thiểu để loại ảnh trắng/placeholder 1x1
          try {
            for (const img of uiImageFiles) {
              const st = fs.statSync(path.join(evidenceDir, img));
              if (st.size < 5120) {
                agentFailed = true;
                failedEvidenceFiles.add(img);
                jobEventBus.emitJobLog(id, {
                  text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${img} quá nhỏ (${st.size} bytes), nghi là ảnh trắng/placeholder. Agent phải chụp lại giao diện thật có dữ liệu!\n`
                });
                break;
              }
            }
          } catch (e) {}
          // 2e. Chặn ảnh UI trùng lặp nội dung (cùng MD5) giữa các test case khác nhau
          try {
            // Xây dựng map file ảnh -> danh sách test case ID sử dụng nó từ metadataObj.tests
            const fileToCaseIds = new Map();
            const testsArr = (metadataObj && Array.isArray(metadataObj.tests)) ? metadataObj.tests : [];
            for (const tc of testsArr) {
              const tcId = String(tc.id || tc.test_id || '').trim().toUpperCase();
              if (!tcId) continue;
              const evList = Array.isArray(tc.evidence) ? tc.evidence : (tc.evidence ? [tc.evidence] : []);
              for (const ev of evList) {
                const baseName = path.basename(String(ev).trim());
                if (!fileToCaseIds.has(baseName)) fileToCaseIds.set(baseName, new Set());
                fileToCaseIds.get(baseName).add(tcId);
              }
            }

            const seenMd5ToImg = new Map();
            const duplicateAliasFiles = new Set();

            for (const img of uiImageFiles) {
              const buf = fs.readFileSync(path.join(evidenceDir, img));
              const md5 = crypto.createHash('md5').update(buf).digest('hex');
              if (seenMd5ToImg.has(md5)) {
                const firstImg = seenMd5ToImg.get(md5);
                const firstCases = fileToCaseIds.get(firstImg) || new Set();
                const currCases = fileToCaseIds.get(img) || new Set();

                // Kiểm tra xem 2 file có chung test case không
                let shareSameCase = false;
                for (const c of currCases) {
                  if (firstCases.has(c)) {
                    shareSameCase = true;
                    break;
                  }
                }
                // Nếu cùng thuộc 1 test case (hoặc không khai báo test case riêng):
                // Đây là file bản sao/alias trong cùng 1 kịch bản (không phải gian lận 2 case khác nhau)
                if (shareSameCase || (firstCases.size === 0 && currCases.size === 0)) {
                  duplicateAliasFiles.add(img);
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ℹ️ Phát hiện ${img} có cùng nội dung (MD5 ${md5}) với ${firstImg} trong cùng kịch bản kiểm thử — tự động bỏ qua file trùng lặp này, chỉ thẩm định file chính!\n`
                  });
                } else {
                  // Trùng nội dung giữa 2 test case KHÁC NHAU: gian lận dùng 1 ảnh cho nhiều case khác nhau
                  agentFailed = true;
                  failedEvidenceFiles.add(img);
                  jobEventBus.emitJobLog(id, {
                    text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${img} (case: ${[...currCases].join(', ') || 'N/A'}) trùng nội dung (MD5 ${md5}) với ${firstImg} (case: ${[...firstCases].join(', ') || 'N/A'}) — không chứng minh được test case riêng biệt. Agent phải chụp lại từng kịch bản thật!\n`
                  });
                  break;
                }
              } else {
                seenMd5ToImg.set(md5, img);
              }
            }

            // Loại bỏ các file trùng lặp nội dung trong cùng test case khỏi danh sách thẩm định AI Vision
            if (duplicateAliasFiles.size > 0) {
              for (const dup of duplicateAliasFiles) {
                const idx = uiImageFiles.indexOf(dup);
                if (idx !== -1) uiImageFiles.splice(idx, 1);
              }
            }
          } catch (e) {}
          // 2f. Đối soát tính nhất quán của Database Assertion / Reconciliation nếu có file assertion CSDL
          try {
            const dbAssertionFiles = validFiles.filter(f => /database.*assertion|db.*assertion|reconciliation/i.test(f) && f.endsWith('.json'));
            for (const dbFile of dbAssertionFiles) {
              try {
                const dbContent = JSON.parse(fs.readFileSync(path.join(evidenceDir, dbFile), 'utf8').replace(/^\uFEFF/, ''));
                if (dbContent && typeof dbContent === 'object') {
                  const isDbFailed = dbContent.matched === false || dbContent.passed === false || dbContent.status === 'FAILED' || dbContent.status === 'FAIL' || dbContent.verdict === 'FAILED' || dbContent.verdict === 'FAIL';
                  const hasDiscrepancies = (Array.isArray(dbContent.discrepancies) && dbContent.discrepancies.length > 0) ||
                                          (Array.isArray(dbContent.inconsistencies) && dbContent.inconsistencies.length > 0) ||
                                          (Array.isArray(dbContent.diffs) && dbContent.diffs.length > 0);
                  if (isDbFailed || hasDiscrepancies) {
                    agentFailed = true;
                    failedEvidenceFiles.add(dbFile);
                    jobEventBus.emitJobLog(id, {
                      text: `\n[TESTING-VERIFY] ❌ ĐỐI SOÁT THẤT BẠI: File ${dbFile} ghi nhận kết quả không khớp (matched: false hoặc có discrepancies/inconsistencies). Chuyển sang FIXING để xử lý triệt để!\n`
                    });
                    break;
                  }
                }
              } catch (e) {}
            }
          } catch (e) {}
          // 2g. Đối chiếu số lượng test case trong test_plan.md với metadata.json tests[]
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
          // 2h. Luật hoàn tất: pendingItems còn mở / kế hoạch nhắc DDL mà không có
          // bằng chứng kênh DB / test bị skipped vẫn tính là đạt.
          // PHUB-678 DONE dù migration Oracle chưa chạy và DbAssertTest bị @Disabled
          // => bằng chứng xanh không chứng minh được việc thật đã xong.
          try {
            const logEntries = [];
            for (const lf of validFiles) {
              const ext = path.extname(lf).toLowerCase();
              if (ext !== '.log' && ext !== '.txt') continue;
              try {
                logEntries.push({ name: lf, content: fs.readFileSync(path.join(evidenceDir, lf), 'utf8') });
              } catch (e) {}
            }
            const planTexts = [testPlanText];
            for (const pf of ['test_plan.md', 'test_report.md', 'fix_report.md', 'report.md']) {
              const p = path.join(featureDir, pf);
              try { if (fs.existsSync(p)) planTexts.push(fs.readFileSync(p, 'utf8')); } catch (e) {}
            }
            const completeness = evidenceCompleteness.evaluateEvidenceCompleteness({
              metadataObj: (!metaParseError && metadataObj && typeof metadataObj === 'object') ? metadataObj : {},
              validEvidenceFiles: validFiles,
              logEntries,
              planTexts,
              readEvidenceFile: (name) => {
                try { return fs.readFileSync(path.join(evidenceDir, name), 'utf8'); } catch (e) { return ''; }
              }
            });
            for (const v of completeness.violations) {
              agentFailed = true;
              jobEventBus.emitJobLog(id, {
                text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: ${v}\n`
              });
            }
            for (const w of completeness.warnings) {
              jobEventBus.emitJobLog(id, {
                text: `\n[TESTING-VERIFY] ⚠️ ${w}\n`
              });
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
          // FAIL-CLOSED: lỗi trong lúc verify => KHÔNG được coi là PASS.
          // Trước đây chỉ console.warn => gate trả failed:false => job PASS
          // dù evidence hỏng. Độ chính xác phải tuyệt đối => lỗi = FAIL.
          agentFailed = true;
          console.warn('Ghi bằng chứng cảnh báo:', evWriteErr.message);
          jobEventBus.emitJobLog(id, {
            text: `\n[TESTING-VERIFY] ❌ KIỂM THỬ THẤT BẠI: Lỗi khi đối soát bằng chứng (${evWriteErr.message}). Không thể xác nhận bằng chứng => coi như THẤT BẠI (fail-closed), không cho qua.\n`
          });
        }

        // Vong doi trang thai evidence: verify thanh cong -> PASS, verify loi -> FAILED.
        // File chua duoc verify (khong con trong validFiles) giu 'NOT VERIFY'.
        try {
          const statusMap = {};
          const validSet = new Set(validFiles.map((f) => String(f).toLowerCase()));
          const storeMeta = evidenceStore.readMetadata(evidenceDir);
          const allFiles = [];
          try {
            for (const f of fs.readdirSync(evidenceDir)) {
              if (f === 'metadata.json' || f.startsWith('.')) continue;
              allFiles.push(f);
            }
          } catch (e) {}
          for (const f of allFiles) {
            const key = String(f).toLowerCase();
            if (failedEvidenceFiles.has(f) || failedEvidenceFiles.has(key)) {
              statusMap[f] = evidenceStore.STATUS.FAILED;
            } else if (validSet.has(key)) {
              statusMap[f] = evidenceStore.STATUS.PASS;
            }
          }
          // File co trong metadata nhung khong con tren dia -> FAILED (khong chung minh duoc)
          for (const rec of storeMeta.records) {
            if (!rec.fileName) continue;
            if (statusMap[rec.fileName] === undefined && !validSet.has(String(rec.fileName).toLowerCase())) {
              statusMap[rec.fileName] = evidenceStore.STATUS.FAILED;
            }
          }
          if (Object.keys(statusMap).length > 0) {
            evidenceStore.setStatuses(evidenceDir, statusMap);
            const passCount = Object.values(statusMap).filter((s) => s === evidenceStore.STATUS.PASS).length;
            const failCount = Object.values(statusMap).filter((s) => s === evidenceStore.STATUS.FAILED).length;
            jobEventBus.emitJobLog(id, {
              text: `\n[TESTING-VERIFY] 📋 Trạng thái evidence sau verify: ${passCount} PASS, ${failCount} FAILED${failCount > 0 ? ` (${[...failedEvidenceFiles].slice(0, 10).join(', ')})` : ''}.\n`
            });
          }
        } catch (statusErr) {
          console.warn('Ghi trạng thái evidence:', statusErr.message);
        }
    } finally {
      jobEventBus.emitJobLog = originalEmit;
    }
    return { failed: agentFailed, reasons, validFiles, failedEvidenceFiles };
};

/**
 * Thẩm định evidence toàn diện kết hợp AI Vision cho hình ảnh (không dùng OCR).
 */
const verifyTaskEvidenceAsync = async ({ jobId, evidenceDir, featureDir, taskCode, emit, skipAiVision = false }) => {
  const syncRes = verifyTaskEvidence({ jobId, evidenceDir, featureDir, taskCode, emit });
  let agentFailed = syncRes.failed;
  const reasons = [...(syncRes.reasons || [])];
  const failedEvidenceFiles = new Set(syncRes.failedEvidenceFiles || []);
  const validFiles = syncRes.validFiles || [];
  // Lỗi HẠ TẦNG của verifier (timeout/abort/5xx/rỗng) không phải kết luận "ảnh sai".
  // Tách riêng để pause job chờ hồi phục thay vì đốt một vòng FIXING vô nghĩa.
  const infraFailures = [];

  if (skipAiVision) {
    return { failed: agentFailed, reasons, failedEvidenceFiles, infraBlocked: false };
  }

  // Lọc các file ảnh UI để thẩm định bằng AI Vision
  const uiImageFiles = validFiles.filter(f => {
    const lower = String(f).toLowerCase();
    return lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp');
  });

  if (uiImageFiles.length > 0) {
    let storeMeta = { records: [] };
    try {
      storeMeta = evidenceStore.readMetadata(evidenceDir);
    } catch (e) {}
    const metaRecords = storeMeta.records || [];

    // Kiểm tra cấu hình lần chạy trước từ pipeline_config nếu có (Incremental Verification)
    let lastFailedEvidences = new Set();
    try {
      const curJob = db.getJobById(jobId);
      const pipeCfg = jobPolicy.parsePipelineConfig(curJob);
      if (Array.isArray(pipeCfg.last_failed_evidences)) {
        lastFailedEvidences = new Set(pipeCfg.last_failed_evidences.map(f => path.basename(f)));
      }
    } catch (e) {}
    const imagesToVerify = [];
    const priorStatusMap = (storeMeta && storeMeta.evidenceStatus) || {};

    for (const img of uiImageFiles) {
      const statusEntry = priorStatusMap[img] || {};
      const alreadyPassed = statusEntry.status === 'PASS' && statusEntry.verified === true;
      const wasFailed = lastFailedEvidences.has(img);
      // Thiếu passCriteria => KHÔNG được bỏ qua: phải vào danh sách thẩm định để
      // bị đánh FAILED (buộc agent bổ sung tiêu chí cụ thể).
      const recMeta = metaRecords.find(r => r.fileName === img || r.name === img) || {};
      const hasCriteria = String(recMeta.passCriteria || recMeta.pass_criteria || recMeta.expected || '').trim().length > 0;
      if (alreadyPassed && !wasFailed && hasCriteria) {
        jobEventBus.emitJobLog(jobId, {
          text: `[VERIFY-AI-VISION] ⏭️ Bỏ qua thẩm định lại ảnh ${img} (đã đạt PASS ở lượt trước và không thay đổi).\n`
        });
      } else {
        imagesToVerify.push(img);
      }
    }

    if (imagesToVerify.length > 0) {
      jobEventBus.emitJobLog(jobId, {
        text: `\n[VERIFY-AI-VISION] 👁️ Bắt đầu thẩm định ${imagesToVerify.length}/${uiImageFiles.length} hình ảnh cần xác minh bằng AI Vision (không dùng OCR)...\n`
      });
    }

    for (const img of imagesToVerify) {
      const fullImgPath = path.join(evidenceDir, img);
      const rec = metaRecords.find(r => r.fileName === img || r.name === img || (r.filePath && r.filePath.includes(img))) || {};
      // `note`/`description` KHÔNG được dùng làm tiêu chí: nó là mô tả kết quả phía agent,
      // dùng nó thay passCriteria sẽ vô hiệu hoá luật "thiếu passCriteria ⇒ FAILED".
      const expectedCriteria = rec.passCriteria || rec.pass_criteria || rec.expected || '';
      const testCaseName = rec.testCase || rec.caseName || rec.stepName || img;
      if (!String(expectedCriteria).trim()) {
        // Không có tiêu chí cụ thể => AI Vision chỉ còn câu chung "không trắng trang",
        // nghĩa là PASS không chứng minh được nội dung đúng yêu cầu. Fail-closed.
        agentFailed = true;
        failedEvidenceFiles.add(img);
        const missMsg = `Ảnh ${img} thiếu passCriteria trong metadata.json — không có căn cứ thẩm định nội dung`;
        if (!reasons.includes(missMsg)) reasons.push(missMsg);
        jobEventBus.emitJobLog(jobId, {
          text: `[VERIFY-AI-VISION] ❌ FAILED: ${img} — thiếu \`passCriteria\`. Khai báo tiêu chí cụ thể cho ảnh này trong metadata.json (mục tests[].passCriteria hoặc passCriteria của file) rồi chạy lại VERIFY.\n`
        });
        continue;
      }
      try {
        const visionResult = await verifyImageWithAI({
          imagePath: fullImgPath,
          expectedCriteria,
          testCaseName,
          stepName: rec.stepName || ''
        });

        if (visionResult.inconclusive) {
          // Da thu 3 lan (khong cap -> 8000 -> 16000) van khong lay duoc ket luan.
          // Day la loi HA TANG (timeout/abort/5xx/rỗng), KHONG phai ket luan anh sai:
          //  - Đánh dấu ảnh chưa thẩm định (để lượt sau verify lại, không bị skip PASS).
          //  - KHÔNG set agentFailed => job không bị đẩy sang FIXING oan.
          //  - Bật infraBlocked => tầng trên pause job chờ hồi phục.
          failedEvidenceFiles.add(img);
          const incMsg = `Ảnh ${img} không thẩm định được (AI Vision thất bại sau 3 lần thử): ${visionResult.reason}`;
          infraFailures.push(incMsg);
          if (!reasons.includes(incMsg)) reasons.push(incMsg);
          jobEventBus.emitJobLog(jobId, {
            text: `[VERIFY-AI-VISION] ⚠️ KHÔNG KẾT LUẬN ĐƯỢC: ${img} — ${visionResult.reason}\n  (Lỗi hạ tầng verifier, không phải ảnh sai. Job sẽ được tạm dừng và thử lại thay vì chuyển FIXING.)\n`
          });
        } else if (!visionResult.passed) {
          agentFailed = true;
          failedEvidenceFiles.add(img);
          const failMsg = `Ảnh ${img} không đạt thẩm định AI Vision: ${visionResult.reason}`;
          if (!reasons.includes(failMsg)) reasons.push(failMsg);
          jobEventBus.emitJobLog(jobId, {
            text: `[VERIFY-AI-VISION] ❌ FAILED: ${img} — ${visionResult.reason}\n${visionResult.details ? `  (Chi tiết: ${visionResult.details})\n` : ''}`
          });
        } else {
          jobEventBus.emitJobLog(jobId, {
            text: `[VERIFY-AI-VISION] ✅ PASS: ${img} — ${visionResult.reason}\n`
          });
        }
      } catch (vErr) {
        agentFailed = true;
        failedEvidenceFiles.add(img);
        const failMsg = `Lỗi kiểm tra AI Vision cho ${img}: ${vErr.message}`;
        if (!reasons.includes(failMsg)) reasons.push(failMsg);
        jobEventBus.emitJobLog(jobId, {
          text: `[VERIFY-AI-VISION] ❌ FAILED (fail-closed): ${img} — ${failMsg}\n`
        });
      }
    }

    // Cập nhật lại statusMap trong metadata.json sau khi có kết quả AI Vision
    try {
      const statusMap = {};
      const allFiles = fs.readdirSync(evidenceDir).filter(f => f !== 'metadata.json' && !f.startsWith('.'));
      for (const f of allFiles) {
        if (failedEvidenceFiles.has(f) || failedEvidenceFiles.has(f.toLowerCase())) {
          statusMap[f] = evidenceStore.STATUS.FAILED;
        } else {
          statusMap[f] = evidenceStore.STATUS.PASS;
        }
      }
      if (Object.keys(statusMap).length > 0) {
        evidenceStore.setStatuses(evidenceDir, statusMap);
      }
    } catch (e) {}
  }

  return { failed: agentFailed, reasons, failedEvidenceFiles, infraBlocked: infraFailures.length > 0 };
};

// === Evidence realtime (TASK-PIPELINE-FIX C-1..C-3) ===
// (evidenceWatchers da khai bao o dau file, truoc class JobEventBus)

function buildEvidenceSnapshot(jobId, evidenceDir) {
  return evidenceStore.listEvidence(evidenceDir, ({ filename, ext, meta, parsedData }) => {
    try {
      return resolveEvidenceType({ filename, ext, meta, parsedData });
    } catch (e) {
      return 'UI_SCREENSHOT';
    }
  }).map((item) => {
    const type = item.type || 'UI_SCREENSHOT';
    const itemExt = item.ext || path.extname(String(item.fileName || '')).toLowerCase();
    return {
      ...item,
      id: `${jobId}-ev-${item.fileName}`,
      job_id: jobId,
      type,
      evidence_type: type,
      channel: evidenceChannelOf(type),
      // File binary (.xlsx/.pdf/...): client phai bo qua `content` va tai file
      // qua /evidence/files/:filename (neu khong -> doc .xlsx thanh text => rac).
      downloadable: !TEXT_EVIDENCE_EXTS.includes(itemExt) && !['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(itemExt),
      file_path: `/api/v1/jobs/${jobId}/evidence/files/${encodeURIComponent(item.fileName)}`,
      url: `/api/v1/jobs/${jobId}/evidence/files/${encodeURIComponent(item.fileName)}`,
      title: item.name || item.stepName || item.description || item.fileName,
      displayName: item.name || item.stepName || item.description || item.fileName,
      filename: item.fileName
    };
  });
}

function startEvidenceWatcher(jobId, evidenceDir) {
  stopEvidenceWatcher(jobId);
  const watcher = new EvidenceWatcher({
    evidenceDir,
    snapshot: () => buildEvidenceSnapshot(jobId, evidenceDir),
    onChange: (item) => {
      jobEventBus.emitJobEvidence(jobId, { evidence: item, realtime: true });
    }
  });
  watcher.start();
  evidenceWatchers.set(jobId, watcher);
  return watcher;
}

function stopEvidenceWatcher(jobId) {
  const w = evidenceWatchers.get(jobId);
  if (w) {
    w.stop();
    evidenceWatchers.delete(jobId);
  }
}

function stopAllEvidenceWatchers() {
  for (const jobId of Array.from(evidenceWatchers.keys())) stopEvidenceWatcher(jobId);
}

// Ghi timeline tung phase vao bang `steps` (started_at / finished_at / exit_code).
// Truoc day chi co 1 step PENDING lau duoc tao luc tao job, `updateStep` khong co
// caller nao => KHONG do duoc thoi gian tung buoc (task bd88ae0a ton ~4h, khong
// phan biet duoc buoc nao an het thoi gian).
//
// YEU CAU: "Thoi luong" phai la thoi luong worker THUC SU chay task do.
// => MOI LAN CHAY = 1 ROW `steps` RIENG (co started_at/finished_at).
// => TONG thoi luong = SUM(finished_at - started_at) cua cac doan da DONG
//    + doan dang MO (neu job van chay).
//
// DIEM MU (da sua):
//  1. Truoc day `if (prev && prev.phase === phase) return;` => khi re-enter cung
//     phase (retry, chay lai) bi NUOT MAT vong chay do => thoi gian that bi thieu.
//     Bay moi luon tao row moi (dong step cu truoc truoc).
//  2. Khi job roi vao PENDING (cho user tra loi) step bi TREO => thoi gian cho
//     user bi tinh nham. Bay `endStepTimeline` duoc goi khi job ngung chay.
const stepTimeline = new Map(); // jobId -> { stepId, phase, startedAt }

// ============================================================================
// PORT LEASE THEO JOB
// Mỗi job thuê port trong lúc chạy step có khởi động service (TESTING/FIXING),
// thay vì để agent tự chọn port mới. Port được bơm qua env + prompt contract.
// ============================================================================
const jobPortAssignments = new Map(); // jobId -> { phase, ports, leases, contract }
// Cho port theo cau hinh worker (mac dinh 30 phut), job co the override bang
// pipeline_config.port_wait_timeout_minutes.
const PORT_WAIT_MAX_MS = (() => {
  const raw = Number(config.PORT_WAIT_TIMEOUT_MS);
  // Fallback đồng bộ với config mặc định (60 phút).
  return Number.isFinite(raw) && raw > 0 ? raw : 60 * 60 * 1000;
})();
function resolvePortWaitMs(job) {
  try {
    const pipe = jobPolicy.parsePipelineConfig(job || {});
    const minutes = Number(pipe.port_wait_timeout_minutes);
    if (Number.isFinite(minutes) && minutes > 0) return minutes * 60 * 1000;
  } catch (e) {}
  return PORT_WAIT_MAX_MS;
}

/**
 * Mốc thời gian mới nhất của file trong thư mục evidence (0 nếu không đọc được).
 * Dùng để biết một vòng FIXING có sinh/ghi lại bằng chứng hay không.
 */
function evidenceDirLatestMtime(dir) {
  let latest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.mtimeMs > latest) latest = st.mtimeMs;
      } catch (e) {}
    }
  } catch (e) {}
  return latest;
}

/**
 * Agent CLI có chết vì provider/hạ tầng tạm thời không? (vd "Upstream temporarily unavailable")
 * Các lỗi này exit code vẫn có thể là 0 nhưng agent KHÔNG làm gì — nếu tính là một vòng
 * FIXING thất bại thì job sẽ đốt hết ngân sách chỉ vì outage của provider.
 */
const TRANSIENT_AGENT_RE = /upstream temporarily unavailable|upstream connect error|connection error|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|502 bad gateway|503 service unavailable|service temporarily unavailable|overloaded/i;
function isTransientAgentFailure(outputText) {
  const text = String(outputText || '');
  if (!text) return false;
  // Chỉ coi là lỗi hạ tầng khi agent gần như không làm gì (output rất ngắn);
  // output dài thường là vòng làm việc thật có tool call.
  return text.length < 5000 && TRANSIENT_AGENT_RE.test(text);
}

/**
 * Xác minh service đang chạy đúng build của worktree (sau khi agent chạy xong).
 * strict: sai => coi như bước test thất bại. warn: chỉ log. off: bỏ qua.
 */
async function verifyRuntimeProvenance(jobId, portCtx, phase) {
  const mode = config.RUNTIME_PROVENANCE_MODE;
  if (mode === 'off' || !portCtx || !portCtx.ports || Object.keys(portCtx.ports).length === 0) {
    return { ok: true, skipped: true, mode };
  }
  const job = db.getJobById(jobId);
  let res;
  try {
    res = await buildProvenance.checkRuntimeProvenance({
      job,
      ports: portCtx.ports,
      stepStartedAt: portCtx.stepStartedAt,
      expectedHash: portCtx.buildHash,
      markerWritten: portCtx.markerWritten
    });
  } catch (e) {
    res = { ok: false, mode: 'error', services: [], reason: e.message };
  }
  const detail = (res.services || [])
    .map((s) => `${s.serviceKey}:${s.port} pid=${s.pid || '—'} restarted=${s.restartedInThisStep} hash=${s.servedHash || '—'} ${s.ok ? 'OK' : `[${s.problems.join('+')}]`}`)
    .join(' | ');
  if (res.ok) {
    jobEventBus.emitJobLog(jobId, { text: `\n[PROVENANCE] ✅ ${phase}: service đúng build ${portCtx.buildHash} (mode=${res.mode}). ${detail}\n` });
  } else {
    jobEventBus.emitJobLog(jobId, {
      text: `\n[PROVENANCE] ${mode === 'strict' ? '⛔' : '⚠️'} ${phase}: KHÔNG xác minh được build đang chạy. ${detail || ''}${res.reason ? `\n  Lý do: ${res.reason}` : ''}\n`,
      level: 'warn'
    });
  }
  // Phân loại nguyên nhân: "không có listener" KHÁC với "đang chạy build cũ".
  // - noListenerAll: mọi service đều KHÔNG listen. Agent thường dừng service khi
  //   xong việc (đúng yêu cầu "dừng service để nhả port") => không có bản build cũ
  //   nào đang chạy, nên đây KHÔNG phải gian lận và không được đánh trượt vòng.
  //   (Trước đây chính điều này làm PHUB-679 lặp vô hạn: agent chụp ảnh xong, dừng
  //   service, rồi bị tính là "vòng sửa thất bại" -> 3 vòng liên tiếp bị huỷ.)
  // - wrongBuild: có listener nhưng phục vụ hash cũ/chưa restart => đúng là test
  //   trên bản cũ, phải chặn.
  const problems = (res.services || []).flatMap((s) => s.problems || []).map((p) => String(p).toUpperCase());
  const noListener = !res.ok && problems.length > 0 && problems.every((p) => p === 'NO_LISTENER');
  return { ...res, noListener, wrongBuild: !res.ok && !noListener };
}

/**
 * Tạm dừng job khi không lấy được port (chờ hết hạn / port còn bị chiếm).
 * Dùng pause_kind=PORT_WAIT để vòng tự động chờ hồi phục KHÔNG thử lại liên tục.
 */
function pauseJobForPortWait(job, phase, reason) {
  const pipe = jobPolicy.parsePipelineConfig(job);
  pipe.paused_step = phase;
  pipe.pause_kind = 'PORT_WAIT';
  pipe.waiting_reason = reason;
  delete pipe.retry_at;
  delete pipe.last_error_kind;
  // Lên lịch tự chạy lại (backoff tăng dần) để job không nằm chờ vô hạn khi
  // port đã được nhả mà không ai bấm "Chạy lại".
  const attempts = (Number(pipe.port_wait_auto_attempt) || 0) + 1;
  pipe.port_wait_auto_attempt = attempts;
  const backoffMs = Math.min(2 * 60 * 60 * 1000, 60 * 1000 * Math.pow(2, Math.min(attempts - 1, 6)));
  pipe.next_auto_resume_at = Date.now() + backoffMs;
  db.updateJob(job.id, { status: 'PAUSED', current_step: phase, error_message: `[PORT-WAIT] ${reason}`, pipeline_config: pipe });
  endStepTimeline(job.id, { status: 'CANCELLED' });
  jobEventBus.emitJobStatus(job.id, { status: 'PAUSED', current_step: phase, waiting: false, pause_kind: 'PORT_WAIT' });
  jobEventBus.emitJobLog(job.id, {
    text: `\n[PORT-WAIT] ⛔ ${reason}\nJob đã tạm dừng. Sẽ tự thử lại sau ${Math.round(backoffMs / 1000)}s (lần ${attempts}), hoặc bấm "Chạy lại" để thử ngay.\n`,
    level: 'warn'
  });
  return { blocked: true, ports: {}, leases: [], contract: '' };
}

/**
 * Vòng quét 30s: job PAUSED vì chờ port => tự chạy lại khi đến hạn backoff.
 * Có trần 12 lần để không quay vòng vô hạn; quá trần thì chờ người dùng.
 */
function startPortWaitRecoveryLoop() {
  if (global.__aiWorkerPortWaitRecovery) return global.__aiWorkerPortWaitRecovery;
  const timer = setInterval(async () => {
    if (!config.PORT_WAIT_AUTO_RESUME) return;
    try {
      const paused = db.listJobs({ status: 'PAUSED', limit: 50 }) || [];
      for (const job of paused) {
        const pipe = jobPolicy.parsePipelineConfig(job);
        if (String(pipe.pause_kind || '') !== 'PORT_WAIT') continue;
        const attempts = Number(pipe.port_wait_auto_attempt) || 0;
        if (attempts > 12) continue;
        const nextAt = Number(pipe.next_auto_resume_at) || 0;
        if (!nextAt || nextAt > Date.now()) continue;
        if (taskQueue.isJobEnqueuedOrRunning(job.id)) continue;
        console.log(`[PORT-WAIT] Tự động chạy lại job ${job.task_code || job.id} (lần ${attempts}) sau backoff.`);
        await resumeJobInternal(job.id, { mode: 'resume', auto: true });
      }
    } catch (e) {
      console.warn('[PORT-WAIT] Lỗi vòng tự chạy lại:', e.message);
    }
  }, 30000);
  if (timer.unref) timer.unref();
  global.__aiWorkerPortWaitRecovery = timer;
  return timer;
}

/**
 * Cấp port cho job trước khi agent chạy. Nếu hết thời gian chờ thì pause job
 * (KHÔNG tự kill job đang giữ port, không tự đổi port).
 * @param {string} jobId
 * @param {string} phase
 * @returns {Promise<{blocked?:boolean, ports?:object, leases?:Array, contract?:string}>}
 */
async function acquireJobPortsForStep(jobId, phase) {
  const existing = jobPortAssignments.get(jobId);
  if (existing && existing.leases && existing.leases.length) return existing;

  const job = db.getJobById(jobId);
  if (!job) return { blocked: true, ports: {}, leases: [], contract: '' };

  const plannedServices = portLeaseManager.resolveServicesForJob(job);
  if (!plannedServices.length) {
    // Job không có worktree nào còn tồn tại trên đĩa => không có gì để chạy.
    // Trước đây vẫn thuê 3 port lấy từ danh sách workspace, khiến job KHÁC
    // chờ hàng chục phút cho một port không ai dùng.
    jobEventBus.emitJobLog(jobId, {
      text: `\n[PORT-LEASE] ℹ️ Job không có worktree/service nào cần chạy — bỏ qua thuê port cho ${phase}.\n`
    });
    return { blocked: false, ports: {}, leases: [], contract: '', buildHash: '', markerWritten: false, stepStartedAt: Date.now() };
  }

  const portWaitMs = resolvePortWaitMs(job);
  const res = await portLeaseManager.acquireForJob(job, {
    timeoutMs: portWaitMs,
    onWait: ({ waitedMs, holders }) => {
      const who = (holders || [])
        .map((h) => `${h.service_key}:${h.port}${h.task_code ? ` (${h.task_code})` : ''}`)
        .join(', ');
      jobEventBus.emitJobLog(jobId, {
        text: `\n[PORT-WAIT] ⏳ Đang chờ port cho ${phase} — đã chờ ${Math.round(waitedMs / 1000)}s/${Math.round(portWaitMs / 1000)}s. Port đang bị giữ: ${who || 'không xác định'}.\n`,
        level: 'warn'
      });
      // Cho UI biết job đang CHỜ (không phải đang chạy bình thường).
      try {
        const cur = db.getJobById(jobId);
        jobEventBus.emitJobStatus(jobId, {
          status: cur ? cur.status : phase,
          waiting: true,
          waiting_for: 'PORT',
          waiting_ms: waitedMs,
          waiting_holders: who || null
        });
      } catch (e) {}
    }
  });

  if (!res.ok) {
    const holders = (res.holders || []).map((h) => `${h.service_key}:${h.port}${h.task_code ? ` (${h.task_code})` : ''}`).join(', ');
    const reason = `Hết thời gian chờ port cho ${phase} sau ${Math.round((res.waitedMs || 0) / 1000)}s. Port đang bị giữ: ${holders || 'không xác định'}.`;
    return pauseJobForPortWait(job, phase, reason);
  }

  // BẮT BUỘC: dừng service cũ trong worktree trước khi test/verify.
  // Không được dùng lại instance đang chạy (có thể là code/build cũ).
  const prep = await portLeaseManager.prepareServicesForTest(job, res.ports);
  if (!prep.ok) {
    const reason = `Port ${prep.busyPorts.join(', ')} vẫn bị process khác chiếm sau khi dừng service cũ; không thể test trên port này.`;
    return pauseJobForPortWait(job, phase, reason);
  }

  // Ghi marker build vào static dir của worktree: marker nằm trong đầu vào build,
  // nên chỉ khi agent build lại thì service mới phục vụ được hash hiện tại.
  // PHAI ghi TRUOC khi sinh port contract: contract phụ thuộc `markerWritten`
  // (repo không có static dir thì không được hứa với agent là có marker).
  let buildHash = '';
  let markerWritten = false;
  try {
    const wtHash = buildProvenance.computeWorktreeHash(job);
    buildHash = wtHash.hash || '';
    const marker = buildProvenance.writeBuildMarker(job, res.ports, buildHash);
    markerWritten = Boolean(marker.written);
    jobEventBus.emitJobLog(jobId, {
      text: `[PROVENANCE] Build hash worktree: ${buildHash || 'n/a'}${markerWritten ? ` — đã ghi ${buildProvenance.MARKER_NAME} vào ${marker.files.map((f) => path.basename(path.dirname(f))).join(', ')}` : ' — KHÔNG ghi được marker (app không có static dir), chỉ kiểm tra process-start-time'}\n`
    });
  } catch (e) {
    console.warn('[PROVENANCE] Không tạo được marker build:', e.message);
  }

  const contract = portLeaseManager.buildPortContract(res.ports, { markerWritten });

  const entry = { phase, ports: res.ports, leases: res.leases, contract, buildHash, markerWritten, stepStartedAt: Date.now() };
  // Gia hạn lease định kỳ: bước TESTING/FIXING có thể 20-60 phút, nếu không
  // heartbeat thì lease TTL 10 phút sẽ hết hạn GIỮA lúc job đang test và job
  // khác có thể chiếm đúng service/port đó.
  try {
    entry.heartbeat = portLeaseManager.startLeaseHeartbeat(res.leases);
  } catch (e) {
    console.warn('[PORT-LEASE] Không khởi động được heartbeat:', e.message);
  }
  jobPortAssignments.set(jobId, entry);
  // Báo UI đã hết chờ (nếu trước đó có báo waiting).
  try {
    const cur = db.getJobById(jobId);
    jobEventBus.emitJobStatus(jobId, { status: cur ? cur.status : phase, waiting: false });
  } catch (e) {}
  jobEventBus.emitJobLog(jobId, {
    text: `\n[PORT-LEASE] 🔌 Cấp port cho ${phase}: ${JSON.stringify(res.ports)}${res.waitedMs ? ` (chờ ${Math.round(res.waitedMs / 1000)}s)` : ''}.\n`
  });
  if (prep.killedCount > 0) {
    jobEventBus.emitJobLog(jobId, {
      text: `[PORT-RESTART] ♻️ Đã dừng ${prep.killedCount} service cũ (${prep.killed.map((k) => `${k.name}#${k.pid}`).join(', ')}). Agent BẮT BUỘC build lại và khởi động service mới trên port vừa cấp.\n`,
      level: 'warn'
    });
  }
  return entry;
}

/** Giải phóng port khi kết thúc đoạn chạy (service do agent start phải nhả). */
function releaseJobPorts(jobId, reason = '') {
  try {
    if (!jobPortAssignments.has(jobId) && portLeaseManager.listLeases().every((l) => l.job_id !== jobId)) {
      return;
    }
  } catch (e) {}
  try {
    const entry = jobPortAssignments.get(jobId);
    if (entry && entry.heartbeat && typeof entry.heartbeat.stop === 'function') {
      entry.heartbeat.stop();
    }
    jobPortAssignments.delete(jobId);
    const job = db.getJobById(jobId);
    const statusNorm = String((job && job.status) || '').toUpperCase();
    const terminal = ['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'ARCHIVED'].includes(statusNorm);
    if (job && terminal) {
      // Job kết thúc => dọn luôn service rác (vite/java) còn sống trong worktree,
      // nếu không port bị giữ và `git worktree remove` bị Permission denied.
      setImmediate(() => {
        try { portLeaseManager.releaseJobPortsAndCleanup(job, reason); } catch (e) {}
      });
    } else {
      portLeaseManager.releaseJobPorts(jobId, reason);
    }
  } catch (e) {
    console.warn('[PORT-LEASE] Không giải phóng được port:', e.message);
  }
}

/**
 * Chuan hoa id job ve UUID canonical trong bang `jobs`.
 * `db.getJobById` ho tro tra ve theo prefix/task_code, nhung `steps.job_id` la
 * FK -> phai dung id canonical (neu khong, INSERT step se bi loi FK).
 * Dung chung mot ham nay cho `beginStepTimeline` va `endStepTimeline` de key
 * cua `stepTimeline` luon khop.
 */
function resolveCanonicalJobId(jobId) {
  if (!jobId) return jobId;
  try {
    const job = db.getJobById(jobId);
    if (job && job.id) return job.id;
  } catch (e) {}
  return jobId;
}

function beginStepTimeline(jobId, phase, runner) {
  if (!jobId || !phase) return;
  const key = resolveCanonicalJobId(jobId);
  try {
    // Dong doan dang chay truoc (neu co) => moi lan chay la 1 doan rieng bi biet.
    // KHONG duoc bo qua khi cung phase: retry/chay lai cung la 1 doan thoi gian moi.
    if (stepTimeline.has(key)) endStepTimeline(key, { exitCode: null });
    // Sau restart/cancel, Map RAM rong nhung DB van con row RUNNING cua job nay.
    // Dong chung truoc khi tao doan moi, neu khong se tich tu step "ma".
    try { db.closeOrphanRunningSteps({ jobId: key, status: 'CANCELLED' }); } catch (e) {}
    const steps = db.getStepsByJobId(key) || [];
    const created = db.createStep({
      job_id: key,
      step_type: phase,
      step_index: steps.length + 1,
      status: 'RUNNING',
      runner: runner || null,
      started_at: new Date().toISOString()
    });
    stepTimeline.set(key, { stepId: created && created.id, phase, startedAt: Date.now() });
  } catch (e) {
    console.warn('[STEP-TIMELINE] Khong ghi duoc step:', e.message);
  }
}

function endStepTimeline(jobId, { exitCode, status } = {}) {
  if (!jobId) return;
  const key = resolveCanonicalJobId(jobId);
  const cur = stepTimeline.get(key);
  if (!cur || !cur.stepId) return;
  const finalStatus = status || 'COMPLETED';
  try {
    db.updateStep(cur.stepId, {
      status: finalStatus,
      finished_at: new Date().toISOString(),
      exit_code: exitCode === undefined ? null : exitCode
    });
  } catch (e) {
    console.warn('[STEP-TIMELINE] Khong cap nhat duoc step:', e.message);
  }
  // Buoc hoan tat = job da thuc su tien trien => xoa bo dem cho hoi phuc ha tang,
  // de su co 429/5xx sau do lai duoc huong ngan sach moi thay vi cong don
  // suot doi job roi FAILED oan.
  if (finalStatus === 'COMPLETED') {
    try {
      const curJob = db.getJobById(key);
      const pipe = curJob ? jobPolicy.parsePipelineConfig(curJob) : null;
      if (pipe && pipe.transient_retry !== undefined) {
        delete pipe.transient_retry;
        db.updateJob(key, { pipeline_config: pipe });
      }
    } catch (e) {}
  }
  // Nha port cua job khi doan chay ket thuc (service agent da start phai tra slot).
  releaseJobPorts(key, 'step-end');
  stepTimeline.delete(key);
}

/**
 * Tinh thoi luong THUC SU cua job = tong cac doan worker da chay.
 *
 * NGUON SU THAT: bang `steps`. Moi LAN worker chay 1 doan (1 phase) = 1 row
 * `steps` co `started_at` / `finished_at`.
 *
 * - Doan DA DONG (`finished_at` != null): cong het `finished_at - started_at`.
 * - Doan DANG MO (`finished_at` == null): chi cong khi doan do DANG DUOC worker
 *   chay trong process nay (co trong `stepTimeline`) VA job dang o trang thai
 *   chay. Doan mo nhung khong duoc theo doi (orphan tu process da crash) =>
 *   KHONG cong (khong doan nao bi dem thoi gian khi job dung).
 *
 * => Job PENDING (cho user tra loi): doan da DONG luc chuyen PENDING => thoi
 *    gian cho user khong bi tinh. Job chay lai => doan MOI => tiep tuc dem.
 * => Job moi vao queue (chua co doan nao): tong doan da dong = 0 (khong dem
 *    thoi gian cho queue).
 * => Job chua tung chay: khong co doan nao co `started_at` => 0.
 *
 * @param {object} job  Job tu `db.getJobById` (can `id` canonical + `status`)
 * @param {Array<object>} steps  Rows tu `db.getStepsByJobId`
 * @returns {number} tong so ms da chay thuc te
 */
function computeJobRuntimeMs(job, steps) {
  if (!job) return 0;
  const status = (job.status || '').toString().trim().toUpperCase();
  const list = Array.isArray(steps) ? steps : [];
  const now = Date.now();
  // Job dang CHAY thuc te => doan dang mo duoc dem tiep.
  const isRunning = RUNNING_JOB_STATUSES.has(status);
  // Doan dang chay trong process nay (neu co) => moi cong phan "chua dong".
  const key = resolveCanonicalJobId(job.id);
  const tracked = stepTimeline.get(key) || stepTimeline.get(job.id);
  let total = 0;
  // Job CHUA TUNG CHAY (khong co doan nao co started_at) => null (chua co du lieu).
  let hasStarted = false;
  for (const st of list) {
    if (!st) continue;
    const startedAt = Date.parse(st.started_at || '');
    if (!Number.isFinite(startedAt)) continue;
    hasStarted = true;
    const finishedAt = st.finished_at ? Date.parse(st.finished_at) : NaN;
    if (Number.isFinite(finishedAt)) {
      const diff = finishedAt - startedAt;
      if (diff > 0) total += diff;
    } else if (isRunning && tracked && (tracked.stepId === st.id || (!st.id && tracked.phase === st.step_type))) {
      // Doan dang MO va worker DANG chay doan nay => cong den thoi diem hien tai.
      const diff = now - startedAt;
      if (diff > 0) total += diff;
    }
  }
  if (!hasStarted) return null;
  return total;
}
/**
 * Chuyen sang buoc tiep theo, giu duong dan so lan chuyen (hops) de test
 * va net an toan co the gioi han chuoi chuyen buoc.
 */
const scheduleNextStep = (id, opts, delayMs = 100) => {
  // Hoãn bước kế bằng setTimeout nên nếu test kết thúc sớm, hop 2 sẽ chạy SAU khi
  // test đã khôi phục runner thật => gọi CLI thật ngoài ý muốn. Cho phép opts mang
  // mảng `_pendingSteps` để test tự await cho tới khi chuỗi hop kết thúc.
  const pendingSteps = (opts && Array.isArray(opts._pendingSteps)) ? opts._pendingSteps : null;
  const timer = setTimeout(() => {
    const running = executeStep(id, opts).catch((__e) => {
      console.error('[EXECUTE-STEP-NEXT-ERR]', (__e && __e.message) || __e);
      try {
        const errMsg = (__e && __e.message) || String(__e);
        db.updateJob(id, { status: 'FAILED', error_message: errMsg });
        jobEventBus.emitJobStatus(id, { status: 'FAILED' });
        jobEventBus.emitJobError(id, { error: errMsg });
      } catch (errDb) {}
    });
    if (pendingSteps) pendingSteps.push(running);
  }, delayMs);
  return timer;
};
/**
 * Tạo lại worktree cho các service của job khi worktree cũ đã bị dọn
 * (ví dụ job đã merge xong, worktree bị remove, sau đó được mở lại để FIXING).
 *
 * Vì sao bắt buộc: không có worktree thì `workspacePath` rơi về repo chính, agent sẽ sửa
 * trực tiếp cây dev — thay đổi không thuộc branch nào và không thể merge lại.
 *
 * Chỉ áp dụng cho job THỰC SỰ có bản ghi job_worktrees; job docs-only không có worktree
 * là hợp lệ nên bỏ qua im lặng.
 *
 * @returns {string|null} đường dẫn worktree vừa tạo lại, null nếu không tạo được
 */
function restoreMissingJobWorktree(job, docBasePath, taskCode) {
  let rows = [];
  try { rows = db.listJobWorktrees(job.id) || []; } catch (e) { return null; }
  if (!rows.length) return null;

  for (const row of rows) {
    if (!row || !row.service_key || !row.task_branch) continue;
    let repoPath = null;
    try {
      const svcConf = job.workspace_id ? db.getWorkspaceServiceByKey(job.workspace_id, row.service_key) : null;
      repoPath = svcConf
        ? (path.isAbsolute(svcConf.repo_path) ? svcConf.repo_path : path.resolve(docBasePath, svcConf.repo_path))
        : path.resolve(docBasePath, row.service_key);
    } catch (e) { repoPath = null; }
    if (!repoPath || !fs.existsSync(path.join(repoPath, '.git'))) continue;

    const destPath = path.join(repoPath, '.worktrees', taskCode);
    const crRes = worktreeManager.createTaskWorktree({
      repoFullPath: repoPath,
      worktreeDestPath: destPath,
      taskBranch: row.task_branch,
      baseDevBranch: row.base_dev_branch || 'main'
    });
    if (!crRes || !crRes.success) {
      const reason = (crRes && crRes.error) || 'unknown';
      console.warn(`[WORKTREE-RESTORE-WARN] ${taskCode}/${row.service_key}: ${reason}`);
      jobEventBus.emitJobLog(job.id, {
        text: `\n[WORKTREE-RESTORE] ⚠️ Không tạo lại được worktree ${row.task_branch}: ${reason}. Agent sẽ chạy trong repo chính!\n`
      });
      continue;
    }
    try { db.updateJobWorktreeRestore(row.id, crRes.worktree_path, 'ACTIVE'); } catch (e) {}
    jobEventBus.emitJobLog(job.id, {
      text: `\n[WORKTREE-RESTORE] ♻️ Đã tạo lại worktree ${row.task_branch} tại ${crRes.worktree_path}\n`
    });
    return crRes.worktree_path;
  }
  return null;
}
const executeStep = async (id, opts) => {
  const job = db.getJobById(id);
  if (!job || job.status === 'CANCELLED' || job.status === 'PAUSED') return;

  // Gioi han so lan chuyen step lien tiep trong 1 lan goi.
  // Pipeline 5 step x N retry co the chay lau; gioi han nay chi dung cho test
  // va la net an toan (tranh vong lap vo han khi agent tra loi kieu sai).
  const maxHops = (opts && Number(opts.maxHops)) || 0;
  if (maxHops > 0) {
    const hops = Number((opts && opts._hops) || 0) + 1;
    if (hops > maxHops) return;
    opts = { ...(opts || {}), _hops: hops };
  }
  
  const taskCode = job.task_code || job.id;
  let ws = null;
  try {
    ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id) : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(job.repo_path || '')) : null);
  } catch (e) {}
  const docBasePath = (ws && ws.path) ? ws.path : (job.repo_path || './');
  let wsFeaturesDir = (ws && ws.features_dir) ? ws.features_dir : 'docs/features';

  // Thư mục tài liệu (features & evidence) luôn nằm tại docBasePath của Workspace
  const { dir: featureDir, evidenceDir } = fileManager.ensureFeatureDirectory(docBasePath, taskCode, { allowExisting: true, featuresDir: wsFeaturesDir });
  // [WORKTREE-RESTORE] Job được mở lại (FIXING/TESTING) sau khi worktree đã bị dọn ở bước MERGING
  // => tạo lại worktree TRƯỚC khi chạy bước để agent không sửa nhầm vào cây dev của repo chính.
  if (!job.worktree_path || !fs.existsSync(job.worktree_path)) {
    try {
      const restoredPath = restoreMissingJobWorktree(job, docBasePath, taskCode);
      if (restoredPath) {
        job.worktree_path = restoredPath;
        db.updateJob(id, { worktree_path: restoredPath });
      }
    } catch (restoreErr) {
      console.warn('[WORKTREE-RESTORE-WARN]', (restoreErr && restoreErr.message) || restoreErr);
    }
  }
  // Thư mục thực thi của Runner: ưu tiên worktree bên trong service nếu đã được tạo
  const workspacePath = (job.worktree_path && fs.existsSync(job.worktree_path)) ? job.worktree_path : docBasePath;

  // Tự động đồng bộ và mở rộng worktree cho các service được chỉ định trong .task-manifest.json hoặc pipeline_config
  try {
    const taskManifest = job.worktree_path ? worktreeManager.loadTaskManifest(job.worktree_path) : null;
    const pipeConf = jobPolicy.parsePipelineConfig(job);
    const targetServices = (taskManifest && Array.isArray(taskManifest.services))
      ? taskManifest.services.map(s => typeof s === 'string' ? s : s.service)
      : ((pipeConf && Array.isArray(pipeConf.target_services)) ? pipeConf.target_services : []);

    if (targetServices.length > 0 && job.workspace_id) {
      for (const sKey of targetServices) {
        const existingWt = db.getJobWorktree(id, sKey);
        if (!existingWt || existingWt.status !== 'ACTIVE') {
          const wsObj = db.getWorkspaceById(job.workspace_id);
          if (wsObj) {
            const svcConf = db.getWorkspaceServiceByKey(wsObj.id, sKey);
            const rPath = svcConf ? (path.isAbsolute(svcConf.repo_path) ? svcConf.repo_path : path.resolve(wsObj.path, svcConf.repo_path)) : path.resolve(wsObj.path, sKey);
            if (fs.existsSync(rPath) && fs.existsSync(path.join(rPath, '.git'))) {
              const bBranch = svcConf ? (svcConf.dev_branch || 'main') : worktreeManager.getRepoCurrentBranch(rPath);
              const destP = path.join(rPath, '.worktrees', taskCode);
              const crRes = worktreeManager.createTaskWorktree({
                repoFullPath: rPath,
                worktreeDestPath: destP,
                taskBranch: `feature/${taskCode}`,
                baseDevBranch: bBranch
              });
              if (crRes.success) {
                db.addJobWorktree({
                  job_id: id,
                  service_key: sKey,
                  worktree_path: crRes.worktree_path,
                  task_branch: `feature/${taskCode}`,
                  base_dev_branch: bBranch,
                  status: 'ACTIVE'
                });
              }
            }
          }
        }
      }
    }
  } catch (syncErr) {
    console.warn('[WORKTREE-SYNC-WARN]', syncErr.message);
  }
  if (!['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.status)) {
    startEvidenceWatcher(id, evidenceDir);
  }
  const jobTimeoutMs = config.resolveJobTimeoutMs(job, null)
    ?? ((opts && opts.timeoutMs) || config.DEFAULT_TIMEOUT_MS);
  // Tong ngan sach thoi gian cho job (job_deadline_ms trong pipeline_config).
  // Timeout PER STEP khong phai ngan sach cho job: 5 step x N retry x 1h => nhieu gio.
  // Deadline phai TUYET DOI: lan dau tinh roi giu vao pipeline_config.deadline_at,
  // cac lan sau (executeStep chay lai moi lan chuyen step) doc lai gia tri da luu.
  const deadlineInfo = jobPolicy.resolveDeadlineAt(job, undefined, jobTimeoutMs);
  const jobDeadlineAt = deadlineInfo.deadlineAt;
  if (deadlineInfo.isNew && jobDeadlineAt) {
    try {
      // Lay config FRESH tu DB (khong dung snapshot `job` dau executeStep) -
      // ghi bang snapshot cu se XOA `failure_history` vua ghi o vong trước.
      const freshForDeadline = db.getJobById(id) || job;
      const pipe = jobPolicy.parsePipelineConfig(freshForDeadline);
      pipe.deadline_at = jobDeadlineAt;
      db.updateJob(id, { pipeline_config: pipe });
      job.pipeline_config = pipe;
    } catch (e) {
      console.warn('[DEADLINE] Khong luu duoc deadline_at:', e.message);
    }
  }
  const effective = jobPolicy.resolveEffectiveTimeout({ stepTimeoutMs: jobTimeoutMs, deadlineAt: jobDeadlineAt });
  if (effective.expired) {
    const msg = `Job da vuot tong ngan sach thoi gian (deadline). Dung pipeline de tranh ton tai tham.`;
    jobEventBus.emitJobLog(id, { text: `\n[DEADLINE] ${msg}\n` });
    db.updateJob(id, { status: 'TIMED_OUT', current_step: job.current_step || null, error_message: msg });
    jobEventBus.emitJobStatus(id, { status: 'TIMED_OUT' });
    jobEventBus.emitJobError(id, { error: msg });
    return;
  }

  // TIMEOUT = chi so CHONG TREO, KHONG phai tham so danh gia do phuc tap.
  // Truoc day "che do NHANH" cat timeout cua user tu 1 gio xuong 5 phut -> job
  // RSGATE-44 (task lon) bi chet 3 lan dung 300s, mat ~7 gio moi giai quyet.
  // QUY TAC MOI: timeout luon la timeout user/DEFAULT, khong bao gio bi bien doi
  // vi tri do phuc tap. Quick mode chi doi TEMPLATE (plan rut gon), khong doi hanh vi.
  let stepTimeoutMs = effective.timeoutMs;
  const effectiveQuickTrack = resolveEffectiveQuickTrack(job);
  if (isQuickTrack(job) && !effectiveQuickTrack) {
    // Job co quick_track=true nhung khong hieu luc: user da tat, hoac user da
    // khai timeout tuong minh.
    const reason = isQuickTrackDisabledByUser(job)
      ? 'user da tat che do nhanh cho task nay'
      : `user da khai timeout ${resolveExplicitTimeoutMs(job)}ms`;
    jobEventBus.emitJobLog(id, { text: `\n[TIMEOUT] Bo qua che do NHANH: ${reason}.\n` });
  }
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
      // Kế hoạch đã được verify ở lượt trước (marker tồn tại) => KHÔNG chạy
      // lại agent PLANNING. PLANNING chỉ làm việc PLANNING rồi chuyển bước -
      // không có lý do chạy lại 20 phút để viết lại plan đã đúng.
      // ĐIỀU KIỆN: marker còn hiệu lực (2 file plan KHÔNG đổi sau khi xác nhận).
      // Plan bị sửa ở bước sau => marker hết hiệu lực => chạy lại PLANNING để
      // verify lại (không bỏ qua bước dựa trên kết quả cũ).
      const planMarker = stepGate.readPlanOkMarker(featureDir);
      const markerCheck = stepGate.isPlanMarkerValid(featureDir, planMarker);
      if (markerCheck.valid) {
        ensureTargetServicesWorktrees(id);
        const markerPipe = jobPolicy.parsePipelineConfig(db.getJobById(id) || job);
        delete markerPipe.pending_started_at;
        db.updateJob(id, { status: 'IMPLEMENT', current_step: 'IMPLEMENT', runner: (agentMapping.IMPLEMENT || 'claude-code'), pipeline_config: markerPipe });
        jobEventBus.emitJobStatus(id, { status: 'IMPLEMENT', runner: (agentMapping.IMPLEMENT || 'claude-code') });
        scheduleNextStep(id, opts, 100);
        return;
      }
      if (planMarker) {
        // Marker hết hiệu lực => xoá + xoá implement_status cũ, chạy lại PLANNING.
        stepGate.clearPlanOkMarker(featureDir);
        const stalePipe = jobPolicy.parsePipelineConfig(db.getJobById(id) || job);
        delete stalePipe.implement_status;
        db.updateJob(id, { pipeline_config: stalePipe });
        jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Marker kế hoạch cũ không còn hiệu lực (${markerCheck.reason}) → chạy lại PLANNING để verify lại.\n` });
      }
      const planningAgent = agentMapping.PLANNING || 'claude-code';
      beginStepTimeline(id, 'PLANNING', planningAgent);
      db.updateJob(id, { runner: planningAgent });
      const answeredQuestions = (db.getQuestionsByJobId(id) || []).filter(q => q.status === 'ANSWERED');
      let clarificationContext = '';
      if (answeredQuestions.length > 0) {
        clarificationContext = '\n## CÁC YÊU CẦU ĐÃ ĐƯỢC NGƯỜI DÙNG GIẢI ĐÁP (CLARIFICATION ANSWERS):\n' +
          answeredQuestions.map((q, idx) => `Câu hỏi ${idx+1}: ${q.question}\nCâu trả lời của người dùng: ${q.answer}\n`).join('\n');
      }
      // Task nhe -> dung template planning-quick.md (plan ngan, it khao sat).
      const quickTrack = effectiveQuickTrack;
      const planningStep = quickTrack ? 'planning-quick' : 'planning';
      const planningPrompt = promptTemplateManager.buildPrompt({
        step: planningStep, taskCode, userPrompt: (job.prompt || '') + clarificationContext, workspacePath, featureDir,
        previousContext: fileManager.loadPreviousContext(workspacePath, taskCode, 'planning')
      });
      if (quickTrack) {
        jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Chế độ NHANH: dùng template planning-quick.md (kế hoạch ngắn, khảo sát tối đa).\n` });
      }
      // Scrub prompt LOCAL (nhanh, mien phi, khong cat du lieu). Khong goi SystemOne:
      // prompt 10-14KB la input lon, goi model de kiem tra 'co secret' la lam dung.
      const planningGuard = guardPrompt(planningPrompt);
      if (planningGuard.scrubbed || planningGuard.injection) {
        jobEventBus.emitJobLog(id, { text: `\n[GUARD] ⚠ Prompt PLANNING: secret=${planningGuard.hasSecret ? 'có' : 'không'} injection=${planningGuard.injection ? 'có' : 'không'}. Tiếp tục bằng prompt đã scrub, không FAILED job.\n` });
      }
      jobEventBus.emitJobLog(id, { text: `\n[1/5] >>> 🤖 [PLANNING] Kích hoạt lập kế hoạch song song (Dual Planning) với Agent: ${planningAgent}\n[PLANNING] Nạp template prompt planning.md...\n[PLANNING] Agent đang phân tích mã nguồn và thiết lập Kế hoạch (Vui lòng đợi khoảng 15-30 giây)...\n` });
      const planStartTime = Date.now();
      const planProgressTimer = setInterval(() => {
        try {
          const cur = db.getJobById(id);
          if (!cur || cur.status === 'CANCELLED') {
            clearInterval(planProgressTimer);
            return;
          }
          const elapsedSec = Math.floor((Date.now() - planStartTime) / 1000);
          jobEventBus.emitJobLog(id, { text: `\x1b[90m🤖 [PLANNING] ⏱️ ${elapsedSec}s - Agent đang tiếp tục xử lý phân tích và tổng hợp Kế hoạch...\x1b[0m\r\n` });
        } catch (tickErr) {
          // Callback interval khong duoc throw: uncaughtException se giet server.
          console.warn('[PLANNING-TICK] Lỗi khi cập nhật tiến độ:', tickErr.message);
        }
      }, 12000);
      const runner = runnerRegistry.getAvailableRunner(planningAgent);
      if (runner) {
        let outBuffer = '';
        let planningResult = null;
        let planningRunnerError = null;
        // Tên file kèm jobId: 2 job cùng task_code chạy song song sẽ ghi đè
        // prompt của nhau nếu dùng tên cố định.
        const planningPromptFile = path.join(featureDir, `prompt_planning.${id}.md`);
        try {
          fs.writeFileSync(planningPromptFile, planningGuard.promptToUse, 'utf8');
        } catch (err) {
          console.warn('[PROMPT-FILE] Không thể ghi prompt_planning.md:', err.message);
        }

        try {
          planningResult = await runner.execute({
            prompt: planningGuard.promptToUse,
            promptFilePath: planningPromptFile,
            featureDir,
            step: 'PLANNING',
            taskCode,
            cwd: workspacePath,
            jobId: id,
            timeoutMs: stepTimeoutMs,
            onStdout: (text) => { outBuffer += text; jobEventBus.emitJobLog(id, { text }); },
            onStderr: (text) => { outBuffer += text; jobEventBus.emitJobLog(id, { text }); }
          });
        } catch (runnerErr) {
          planningRunnerError = runnerErr;
          planningResult = { exitCode: 1, timedOut: false, stdout: outBuffer, stderr: '' };
          jobEventBus.emitJobLog(id, { text: `[PLANNING] Thông báo runner: ${runnerErr.message}\n` });
        }
        clearInterval(planProgressTimer);
        const checkAfterPlan = db.getJobById(id);
        if (checkAfterPlan && (checkAfterPlan.status === 'CANCELLED' || checkAfterPlan.status === 'PAUSED')) {
          return;
        }
        // Trích xuất dev_plan.md và test_plan.md từ stdout nếu chưa được tạo trên ổ cứng
        let planFiles = fileManager.readPlanFiles(docBasePath, taskCode, wsFeaturesDir);
        let effectiveDevPlan = planFiles.devPlan || planFiles.dev_plan || '';
        let effectiveTestPlan = planFiles.testPlan || planFiles.test_plan || '';
        // LỖI 4 (job bd88ae0a): Agent PLANNING timeout / lỗi KHÔNG được coi là "đã xong".
        // - Timeout => KHÔNG sinh plan mẫu, dừng pipeline tại PLANNING (không sang IMPLEMENT).
        // - Exit code != 0 mà không tạo được plan hợp lệ => dừng pipeline, KHÔNG sinh plan mẫu để che lỗi.
        const devMatch = outBuffer.match(/# (Dev Plan|Kế hoạch triển khai)[\s\S]*?(?=# (Test Plan|Kế hoạch kiểm thử)|$)/i);
        const testMatch = outBuffer.match(/# (Test Plan|Kế hoạch kiểm thử)[\s\S]*?(?=$)/i);
        const planningTimedOut = !!(planningResult && planningResult.timedOut);
        const planningExitCode = planningResult ? planningResult.exitCode : null;
        // exitCode null = tiến trình bị kill (signal) => coi như lỗi, giống check exitCode !== 0 gốc.
        const planningFailed = !!planningRunnerError || !planningResult || planningExitCode !== 0;
        // "Plan hợp lệ" = có trên ổ cứng HOẶC trích được từ stdout, dài >= 60 ký tự.
        const hasValidDevPlan = (!!effectiveDevPlan && effectiveDevPlan.trim().length >= 60) || !!(devMatch && devMatch[0].trim().length >= 60);
        const hasValidTestPlan = (!!effectiveTestPlan && effectiveTestPlan.trim().length >= 60) || !!(testMatch && testMatch[0].trim().length >= 60);
        const hasAnyValidPlan = hasValidDevPlan || hasValidTestPlan;

        if (planningTimedOut) {
          const timeoutMsUsed = (planningResult && planningResult.timeoutMs) || stepTimeoutMs;
          const msg = `PLANNING bi timeout (${timeoutMsUsed}ms). KHONG ghi plan mau. Pipeline dung tai PLANNING.`;
          jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Agent bi timeout - KHONG ghi plan mau. Pipeline dung tai PLANNING.\n` });
          db.updateJob(id, { status: 'TIMED_OUT', current_step: 'PLANNING', error_message: msg });
          jobEventBus.emitJobStatus(id, { status: 'TIMED_OUT' });
          jobEventBus.emitJobError(id, { error: msg });
          return;
        }

        if (planningFailed && !hasAnyValidPlan) {
          const failReason = planningRunnerError
            ? `loi thuc thi: ${planningRunnerError.message}`
            : `exit code ${planningExitCode}`;
          const msg = `PLANNING that bai (${failReason}) va khong tao duoc ke hoach hop le. KHONG ghi plan mau. Pipeline dung tai PLANNING.`;
          jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Agent that bai (${failReason}) - KHONG ghi plan mau. Pipeline dung tai PLANNING.\n` });
          db.updateJob(id, { status: 'FAILED', current_step: 'PLANNING', error_message: msg });
          jobEventBus.emitJobStatus(id, { status: 'FAILED' });
          jobEventBus.emitJobError(id, { error: msg });
          return;
        }

        // Chi sinh plan mau khi agent thuc su tra ve noi dung plan hop le (>= 60 ky tu),
        // HOAC khi khong co timeout lan loi.
        const allowSamplePlan = !planningFailed || hasAnyValidPlan;

        // Nếu một trong 2 plan bị thiếu hoặc rỗng (chỉ có dòng tiêu đề < 60 ký tự)
        if (!effectiveDevPlan || effectiveDevPlan.trim().length < 60 || !effectiveTestPlan || effectiveTestPlan.trim().length < 60) {
          if (allowSamplePlan) {
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
          }
          planFiles = fileManager.readPlanFiles(docBasePath, taskCode, wsFeaturesDir);
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
        // Agent PLANNING vua xac nhan trang thai trien khai trong dev_plan.md
        // (`<!-- IMPLEMENT_STATUS: DONE|NEEDED -->`). Ghi marker de buoc sau
        // (IMPLEMENT) doc duoc, va giu nguyen trong pipeline_config.
        const planStatus = stepGate.readImplementStatus(planFiles.devPlan || effectiveDevPlan || '');
        if (planStatus) {
          const planPipe = jobPolicy.parsePipelineConfig(db.getJobById(id) || job);
          planPipe.implement_status = planStatus;
          db.updateJob(id, { pipeline_config: planPipe });
          jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Trạng thái triển khai theo xác nhận của agent: ${planStatus} (đọc từ dev_plan.md).\n` });
        }
        // Ke hoach da duoc verify => ghi marker de lan chay sau bo qua agent PLANNING.
        stepGate.writePlanOkMarker(featureDir, { taskCode });
        jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Đã ghi dev_plan.md và test_plan.md đầy đủ. Lưu metadata Dual Plan vào DB thành công.\n` });
      } else {
        jobEventBus.emitJobLog(id, { text: `[PLANNING-WARN] Không tìm thấy runner hợp lệ cho ${planningAgent}\n` });
      }

      // Kiểm tra xem còn câu hỏi PENDING nào chưa được giải đáp không
      const pendingQuestions = (db.getQuestionsByJobId(id) || []).filter(q => q.status === 'PENDING');
      if (pendingQuestions.length > 0) {
        // Còn câu hỏi cần làm rõ -> Chuyển PENDING để chờ người dùng phản hồi
        // Pause deadline: job cho user tra loi khong phai job treo => khong
        // duoc tru thoi gian cho user vao ngan sach chay.
        db.updateJob(id, { status: 'PENDING', current_step: 'PENDING', had_pending: 1, pipeline_config: jobPolicy.pauseDeadlineForPending(db.getJobById(id) || job) });
        jobEventBus.emitJobStatus(id, { status: 'PENDING' });
        jobEventBus.emitJobLog(id, { text: `\n[PLANNING] Agent đã tạo câu hỏi làm rõ. Chuyển sang PENDING chờ người dùng phản hồi...\n` });
        return;
      }

      // Nếu không còn câu hỏi PENDING (hoặc các câu hỏi đã được giải đáp xong):
      // Tự động phân tích dev_plan.md và chỉ tạo Git Worktree cho các service mục tiêu
      ensureTargetServicesWorktrees(id);
      const implementAgent = agentMapping.IMPLEMENT || 'claude-code';
      // Resume deadline: cong lai thoi gian da cho user tra loi vao ngan sach.
      const resumedPipe = jobPolicy.resumeDeadlineAfterPending(db.getJobById(id) || job);
      db.updateJob(id, { status: 'IMPLEMENT', current_step: 'IMPLEMENT', runner: implementAgent, had_pending: (answeredQuestions.length > 0 ? 1 : (job.had_pending || 0)), pipeline_config: resumedPipe });
      jobEventBus.emitJobStatus(id, { status: 'IMPLEMENT', runner: implementAgent });
      jobEventBus.emitJobLog(id, { text: `\n[PLANNING -> IMPLEMENT] Hoàn tất Kế hoạch sau khi làm rõ. Tự động chuyển tiếp sang triển khai mã nguồn (IMPLEMENT) với 🤖 Agent: ${implementAgent}...\n` });
      scheduleNextStep(id, opts, 100);
      return;
    }

    if (job.status === 'IMPLEMENT') {
      const prevContext = fileManager.loadPreviousContext(docBasePath, taskCode, 'implement');
      const planFiles = fileManager.readPlanFiles(docBasePath, taskCode, wsFeaturesDir);
      const devPlanText = (planFiles && planFiles.devPlan) || (typeof prevContext === 'string' ? prevContext : '');

      // CODE DA DUOC IMPLEMENT CHUA? Ket luan do PLANNING ghi trong dev_plan.md
      // (`<!-- IMPLEMENT_STATUS: DONE -->`) sau khi verify plan voi code that.
      // Neu da xong => BO QUA agent IMPLEMENT, chuyen thang sang TESTING.
      // KHONG dua vao ket qua lan chay truoc: marker chi ghi khi agent xac nhan
      // bang cach DOC file trong workspace - khong phai do he thong do bang.
      const implementStatus = stepGate.readImplementStatus(devPlanText)
        || (jobPolicy.parsePipelineConfig(db.getJobById(id) || job).implement_status || null);
      if (implementStatus === 'DONE') {
        jobEventBus.emitJobLog(id, {
          text: `\n[2/5] >>> 🤖 [IMPLEMENT] Dev Plan xác nhận mã nguồn đã được implement đầy đủ (đã verify với code hiện tại) → BỎ QUA bước IMPLEMENT, chuyển thẳng sang [TESTING] để kiểm tra thực tế.\n`
        });
        const testAgent = agentMapping.TESTING || 'claude-code';
        db.updateJob(id, { status: 'TESTING', current_step: 'TESTING', runner: testAgent });
        jobEventBus.emitJobStatus(id, { status: 'TESTING', runner: testAgent });
        scheduleNextStep(id, opts, 200);
        return;
      }

      beginStepTimeline(id, 'IMPLEMENT', agentMapping.IMPLEMENT || 'claude-code');
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
        scheduleNextStep(id, opts, 200);
        return;
      }

      const implementAgent = agentMapping.IMPLEMENT || 'claude-code';
      // Task nhe -> dung template implement-quick.md (sua toi thieu, khong khao sat lai).
      const implementPrompt = promptTemplateManager.buildPrompt({
        step: effectiveQuickTrack ? 'implement-quick' : 'implement', taskCode, userPrompt: job.prompt || '', workspacePath, featureDir,
        previousContext: prevContext
      });
      const implementGuard = guardPrompt(implementPrompt);
      if (implementGuard.scrubbed || implementGuard.injection) {
        jobEventBus.emitJobLog(id, { text: `\n[GUARD] ⚠ Prompt IMPLEMENT: secret=${implementGuard.hasSecret ? 'có' : 'không'} injection=${implementGuard.injection ? 'có' : 'không'}. Tiếp tục bằng prompt đã scrub, không FAILED job.\n` });
      }
      db.updateJob(id, { runner: implementAgent });
      const runner = runnerRegistry.getAvailableRunner(implementAgent);
      if (runner) {
        // LOI 5 (job bd88ae0a): IMPLEMENT timeout / exit code != 0 PHAI di qua vong retry,
        // khong throw thang. So vong retry lay tu `pipeline_config.max_retries`
        // (jobPolicy.resolveMaxRetries) - giong vong FIXING.
        const implementRetryPolicy = jobPolicy.resolveMaxRetries(job);
        const implementMaxRetries = implementRetryPolicy.value;
        let implementAttempt = 0;
        let implementResult = null;
        let implementFailed = false;
        let implementFailReason = '';
        let implementIsTimeout = false;
        let implementRepeatedStop = null;

        while (implementAttempt < implementMaxRetries) {
          implementAttempt += 1;
          // Moi vong retry tao interval rieng, luon clear trong finally cua vong do
          // (tranh ro timer giua cac vong retry).
          const impProgressTimer = setInterval(() => {
            try {
              const cur = db.getJobById(id);
              if (!cur || cur.status === 'CANCELLED') {
                clearInterval(impProgressTimer);
                return;
              }
              jobEventBus.emitJobLog(id, { text: `🤖 [IMPLEMENT] Agent đang tiếp tục viết mã nguồn...\n` });
            } catch (tickErr) {
              console.warn('[IMPLEMENT-TICK] Lỗi khi cập nhật tiến độ:', tickErr.message);
            }
          }, 6000);

          let attemptExpired = false;
          let attemptTimedOut = false;
          let attemptExitCode = null;
          let attemptFailed = true;
          let attemptCancelled = false;

          try {
            // Timeout moi vong = min(step timeout, thoi gian con lai cua job).
            const attemptTimeout = jobPolicy.resolveEffectiveTimeout({ stepTimeoutMs: stepTimeoutMs, deadlineAt: jobDeadlineAt });
            if (attemptTimeout.expired) {
              attemptExpired = true;
            } else {
              implementResult = null;
              const implementPromptFile = path.join(featureDir, `prompt_implement.${id}.md`);
              try {
                fs.writeFileSync(implementPromptFile, implementGuard.promptToUse, 'utf8');
              } catch (err) {
                console.warn('[PROMPT-FILE] Không thể ghi prompt_implement.md:', err.message);
              }

              try {
                implementResult = await runner.execute({
                  prompt: implementGuard.promptToUse,
                  promptFilePath: implementPromptFile,
                  featureDir,
                  step: 'IMPLEMENT',
                  taskCode,
                  cwd: workspacePath,
                  jobId: id,
                  timeoutMs: attemptTimeout.timeoutMs,
                  onStdout: (text) => jobEventBus.emitJobLog(id, { text }),
                  onStderr: (text) => jobEventBus.emitJobLog(id, { text })
                });
              } catch (execErr) {
                // Loi thuc thi cung la 1 vong that bai de retry, khong throw ra ngoai.
                implementResult = { exitCode: 1, timedOut: false, stdout: '', stderr: execErr.message };
                jobEventBus.emitJobLog(id, { text: `[IMPLEMENT] Loi thuc thi: ${execErr.message}\n` });
              }
            }

            const checkAfterImp = db.getJobById(id);
            if (checkAfterImp && (checkAfterImp.status === 'CANCELLED' || checkAfterImp.status === 'PAUSED')) {
              attemptCancelled = true;
            }

            attemptTimedOut = attemptExpired || !!(implementResult && implementResult.timedOut);
            attemptExitCode = implementResult ? implementResult.exitCode : null;
            attemptFailed = attemptExpired || !implementResult || attemptTimedOut || attemptExitCode !== 0;
          } finally {
            // Luon clear timer cua vong nay, ke ca khi vong do ket thuc bang `return`.
            clearInterval(impProgressTimer);
          }

          if (attemptCancelled) {
            return;
          }

          if (!attemptFailed) {
            implementFailed = false;
            implementIsTimeout = false;
            implementFailReason = '';
            break;
          }

          implementIsTimeout = attemptTimedOut;
          implementFailReason = attemptExpired
            ? `het ngan sach thoi gian cua job (deadline)`
            : (attemptTimedOut
              ? `vuot qua gioi han thoi gian (${(implementResult && implementResult.timeoutMs) || stepTimeoutMs}ms)`
              : `exit code ${attemptExitCode === null ? 'null (bi kill)' : attemptExitCode}`);

          // Het ngan sach thoi gian cua job => retry vo nghia, dung luon.
          if (attemptExpired) {
            implementFailed = true;
            break;
          }

          // CHAN VONG LAP: neu nguyen nhan loi giong het lan truoc thi retry se
          // cho cung ket qua. SystemOne quyet dinh co lap hay khong.
          if (implementAttempt < implementMaxRetries) {
            const dup = await evaluateRepeatedCause({
              id, step: 'IMPLEMENT', attempt: implementAttempt,
              maxRetries: implementMaxRetries, reason: implementFailReason,
              output: jobPolicy.collectAgentOutput(implementResult)
            });
            if (dup && dup.repeated) {
              implementFailed = true;
              implementRepeatedStop = dup;
              break;
            }
          }

          // Con vong retry => thu lai, cho backoff roi thu tiep.
          if (implementAttempt < implementMaxRetries) {
            const backoffMs = jobPolicy.resolveRetryBackoffMs(implementAttempt + 1, {});
            const retryLog = attemptTimedOut
              ? `\n[IMPLEMENT] Timeout - thu lai lan ${implementAttempt + 1}/${implementMaxRetries} (backoff ${backoffMs}ms)\n`
              : `\n[IMPLEMENT] Loi agent (${implementFailReason}) - thu lai lan ${implementAttempt + 1}/${implementMaxRetries} (backoff ${backoffMs}ms)\n`;
            jobEventBus.emitJobLog(id, { text: retryLog });
            if (backoffMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, backoffMs));
            }
            continue;
          }

          // Het so lan retry cho phep => dung pipeline.
          implementFailed = true;
          break;
        }

        if (implementFailed) {
          // Timeout la trang thai rieng (TIMED_OUT), khong gop voi loi thuoc.
          const failStatus = implementIsTimeout ? 'TIMED_OUT' : 'FAILED';
          // Dung do SystemOne (nguyen nhan trung) => phai ghi ro trong error_message.
          const repeatedNote = implementRepeatedStop
            ? ` (SystemOne dung vong lap: ${implementRepeatedStop.reason}; nguyen nhan da gap ${implementRepeatedStop.occurrences} lan truoc)`
            : '';
          const failMsg = `IMPLEMENT that bai: ${implementFailReason}${repeatedNote}`;
          const stopNote = implementRepeatedStop
            ? `\n[IMPLEMENT-FAILED] SystemOne da DUNG vong lap: nguyen nhan loi giong hop ${implementRepeatedStop.occurrences} lan truoc (${implementRepeatedStop.reason}). Pipeline DUNG tai IMPLEMENT.\n`
            : `\n[IMPLEMENT-FAILED] Trien khai that bai (${implementFailReason}). Pipeline DUNG tai IMPLEMENT, vui long kiem tra log va chay lai.\n`;
          jobEventBus.emitJobLog(id, { text: stopNote });
          db.updateJob(id, { status: failStatus, current_step: 'IMPLEMENT', error_message: failMsg });
          jobEventBus.emitJobStatus(id, { status: failStatus });
          jobEventBus.emitJobError(id, { error: failMsg });
          // Dung pipeline tai IMPLEMENT, KHONG throw ra ngoai (tranh unhandled rejection).
          return;
        }
        jobEventBus.emitJobLog(id, { text: `\n[IMPLEMENT] Hoan tat trien khai ma nguon.\n` });
        // Ghi marker `IMPLEMENT_STATUS: DONE` vao dev_plan.md + lam moi marker
        // ke hoach (ke ca van tay plan) => lan chay sau BO QUA ca PLANNING va
        // IMPLEMENT, chuyen thang sang TESTING.
        // Khong co buoc nay thi moi job phai chay lai PLANNING + IMPLEMENT du
        // ma nguon da xong (dung thu user phan nan).
        try {
          const devPath = path.join(featureDir, 'dev_plan.md');
          if (fs.existsSync(devPath)) {
            const cur = fs.readFileSync(devPath, 'utf8');
            const next = stepGate.writeImplementStatus(cur, 'DONE');
            if (next !== cur) fs.writeFileSync(devPath, next, 'utf8');
            stepGate.writePlanOkMarker(featureDir, { taskCode, implementStatus: 'DONE' });
            jobEventBus.emitJobLog(id, { text: `\n[IMPLEMENT] Đã ghi marker IMPLEMENT_STATUS: DONE vào dev_plan.md — lần chạy sau sẽ bỏ qua PLANNING + IMPLEMENT.\n` });
          }
        } catch (e) {
          console.warn('[IMPLEMENT] Khong ghi duoc marker implement status:', e.message);
        }
      } else {
        jobEventBus.emitJobLog(id, { text: `\n[IMPLEMENT-WARN] Khong tim thay runner hop le cho ${implementAgent}\n` });
      }
      db.updateJob(id, { status: 'TESTING', current_step: 'TESTING' });
      jobEventBus.emitJobStatus(id, { status: 'TESTING' });
      scheduleNextStep(id, opts, 100);
      return;
    }

    if (job.status === 'TESTING') {
      // TESTING va cac buoc sau LUON chay lai - khong dua vao ket qua cu.
      // Bang chung cu (evidence) phai reset ve NOT VERIFY truoc khi chay,
      // neu giu PASS cu thi VERIFY co the pass bang bang chung lượt truoc.
      const resetCount = evidenceStore.resetAllToNotVerify(evidenceDir);
      if (resetCount > 0) {
        jobEventBus.emitJobLog(id, { text: `\n[TESTING] Đã reset ${resetCount} bằng chứng cũ về NOT VERIFY — lần chạy này phải tạo lại và verify lại từ đầu.\n` });
      }
      beginStepTimeline(id, 'TESTING', agentMapping.TESTING || 'claude-code');
      const checkBeforeTest = db.getJobById(id);
      if (checkBeforeTest && checkBeforeTest.status === 'CANCELLED') return;
      const testAgent = agentMapping.TESTING || 'claude-code';
      // Cấp port TRƯỚC khi agent khởi động service để 2 job không tranh port.
      const portCtx = await acquireJobPortsForStep(id, 'TESTING');
      if (portCtx.blocked) return;
      const testingPrompt = promptTemplateManager.buildPrompt({
        step: 'testing', taskCode, userPrompt: job.prompt || '', workspacePath, featureDir,
        previousContext: fileManager.loadPreviousContext(workspacePath, taskCode, 'testing'),
        errorLogs: ''
      });
      const testingGuard = guardPrompt(`${portCtx.contract || ''}${testingPrompt}`);
      if (testingGuard.scrubbed || testingGuard.injection) {
        jobEventBus.emitJobLog(id, { text: `\n[GUARD] ⚠ Prompt TESTING: secret=${testingGuard.hasSecret ? 'có' : 'không'} injection=${testingGuard.injection ? 'có' : 'không'}. Tiếp tục bằng prompt đã scrub, không FAILED job.\n` });
      }
      db.updateJob(id, { runner: testAgent });
      jobEventBus.emitJobLog(id, { text: `\n[3/5] >>> 🤖 [TESTING] Bắt đầu kiểm thử thật với Runner/Agent: ${testAgent}...\n` });

      const testProgressTimer = setInterval(() => {
        try {
          const cur = db.getJobById(id);
          if (!cur || cur.status === 'CANCELLED') {
            clearInterval(testProgressTimer);
            return;
          }
          jobEventBus.emitJobLog(id, { text: `🤖 [TESTING] Agent đang tiếp tục kiểm thử...\n` });
        } catch (tickErr) {
          console.warn('[TESTING-TICK] Lỗi khi cập nhật tiến độ:', tickErr.message);
        }
      }, 6000);

      const runner = runnerRegistry.getAvailableRunner(testAgent);
      let testingResult = null;
      let agentFailed = false;

      if (runner) {
        const testingPromptFile = path.join(featureDir, 'prompt_testing.md');
        try {
          fs.writeFileSync(testingPromptFile, testingGuard.promptToUse, 'utf8');
        } catch (err) {
          console.warn('[PROMPT-FILE] Không thể ghi prompt_testing.md:', err.message);
        }

        try {
          testingResult = await runner.execute({
            prompt: testingGuard.promptToUse,
            promptFilePath: testingPromptFile,
            featureDir,
            step: 'TESTING',
            taskCode,
            cwd: workspacePath,
            jobId: id,
            timeoutMs: stepTimeoutMs,
            // Port đã thuê: agent phải dùng đúng các port này.
            env: { AIWORKER_PORT_MAP: JSON.stringify(portCtx.ports || {}) },
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
        if (checkAfterTest && (checkAfterTest.status === 'CANCELLED' || checkAfterTest.status === 'PAUSED')) {
          return;
        }

        // Chặn "test trên bản build cũ": chỉ chấp nhận evidence khi service
        // đang chạy đúng hash worktree và vừa được restart trong bước này.
        // NGOẠI LỆ: agent dừng service khi xong việc (prompt yêu cầu nhả port)
        // => không có listener KHÔNG phải là chạy build cũ, không được đánh trượt.
        const provTesting = await verifyRuntimeProvenance(id, portCtx, 'TESTING');
        if (!provTesting.ok && provTesting.noListener) {
          jobEventBus.emitJobLog(id, { text: '[PROVENANCE] ℹ️ TESTING: không còn service nào listen (agent đã dừng để nhả port) — bỏ qua kiểm tra build lúc này, VERIFY vẫn chấm nội dung evidence.\n', level: 'warn' });
        } else if (!provTesting.ok && config.RUNTIME_PROVENANCE_MODE === 'strict') {
          const provReason = `Xác minh build thất bại: ${provTesting.reason || 'unknown'}`;
          testingResult = {
            ...(testingResult || {}),
            exitCode: 1,
            output: `${(testingResult && (testingResult.output || testingResult.stdout)) || ''}\n[PROVENANCE] ${provReason}`
          };
          jobEventBus.emitJobLog(id, { text: `[PROVENANCE] ⛔ ${provReason} — không chấp nhận evidence của bản build cũ.\n` });
        }

        if (!testingResult || testingResult.timedOut || testingResult.exitCode !== 0) {
          agentFailed = true;
          const failReason = testingResult && testingResult.timedOut
            ? `vượt quá giới hạn thời gian (${testingResult.timeoutMs || jobTimeoutMs}ms)`
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
        if (checkAfterTest && (checkAfterTest.status === 'CANCELLED' || checkAfterTest.status === 'PAUSED')) return;
      }

      // TESTING that bai (timeout/exit!=0/thieu runner): chuyen thang sang FIXING, KHONG qua VERIFY.
      if (agentFailed) {
        const fixAgentAfterTest = agentMapping.FIXING || 'claude-code';
        const failReasonText = !testingResult ? 'khong co ket qua kiem thu' : (testingResult.timedOut ? ('vuot qua gioi han thoi gian ('+(testingResult.timeoutMs || stepTimeoutMs)+'ms)') : ('exit code '+testingResult.exitCode));
        const failGate = { passed: false, error: `Kiem thu that bai (${failReasonText})`, timeout: !!(testingResult && testingResult.timedOut), decided_at: new Date().toISOString(), mapped_from: 'TESTING', source: 'pipeline-testing-failed' };
        // Rate-limit provider: retry vong FIXING sau chi lai lai mot vong ~1h vô ich.
        // runner.execute() tra { stdout, stderr } (khong phai `output`); log 429 cua CLI
        // nam trong stderr => phai gom ca hai.
        const testRateLimit = jobPolicy.detectRateLimit(jobPolicy.collectAgentOutput(testingResult));
        if (testRateLimit.limited) {
          const retryAfter = testRateLimit.retryAfterMs ? ` (retry-after ${Math.round(testRateLimit.retryAfterMs / 1000)}s)` : '';
          const msg = `Provider rate-limit${retryAfter}`;
          // Loi HA TANG: cho hoi phuc roi tu chay lai thay vi FAILED ngay.
          // Chi 1 lan goi, khong day job sang FIXING (code khong sai).
          jobEventBus.emitJobLog(id, { text: `\n[RATE-LIMIT] ${msg} — tạm dừng chờ hồi phục, không retry mù.\n` });
          pauseJobForTransient(id, { step: 'TESTING', reason: msg, retryAfterMs: testRateLimit.retryAfterMs });
          return;
        }
        // Loi ha tang khac (timeout CLI, spawn ENOENT, 5xx, output rong...) cung
        // phai cho hoi phuc thay vi tinh la code sai.
        const testFailureKind = jobPolicy.classifyFailure(jobPolicy.collectAgentOutput(testingResult));
        if (testFailureKind === 'TRANSIENT') {
          const infraMsg = `TESTING lỗi hạ tầng (exit ${testingResult && testingResult.exitCode}): ${String(jobPolicy.collectAgentOutput(testingResult)).slice(-400) || 'không có output'}`;
          pauseJobForTransient(id, { step: 'TESTING', reason: infraMsg });
          return;
        }
        // Het tong ngan sach thoi gian cua job: dung, khong vao vong FIXING moi.
        const remainingNow = jobPolicy.resolveEffectiveTimeout({ stepTimeoutMs, deadlineAt: jobDeadlineAt });
        if (remainingNow.expired) {
          const msg = 'Job da vuot tong ngan sach thoi gian (deadline). Dung pipeline de tranh ton tai tham.';
          jobEventBus.emitJobLog(id, { text: `\n[DEADLINE] ${msg}\n` });
          db.updateJob(id, { status: 'TIMED_OUT', current_step: 'TESTING', error_message: msg, gate_result: failGate });
          jobEventBus.emitJobStatus(id, { status: 'TIMED_OUT' });
          jobEventBus.emitJobError(id, { error: msg });
          return;
        }
        jobEventBus.emitJobLog(id, { text: `\n[TESTING] Agent kiểm thử báo lỗi (${failReasonText}), chuyển sang [FIXING]...` });
        db.updateJob(id, { status: 'FIXING', current_step: 'FIXING', had_fixing: 1, runner: fixAgentAfterTest, error_message: `Kiểm thử thất bại (${failReasonText}).`, gate_result: failGate });
        jobEventBus.emitJobStatus(id, { status: 'FIXING', runner: fixAgentAfterTest });
        scheduleNextStep(id, opts, 100);
        // BẮT BUỘC return: nếu rơi tiếp xuống dưới sẽ ghi đè sang VERIFY và
        // chạy SONG SONG cả FIXING lẫn VERIFY (double AI Vision + tranh port).
        return;
      }
      jobEventBus.emitJobLog(id, { text: `\n[TESTING] Hoan tat kiem thu qua Agent, chuyen sang [VERIFY] de doi soat evidence...` });
      const verifyAgent = 'verify-gate';
      db.updateJob(id, { status: 'VERIFY', current_step: 'VERIFY', runner: verifyAgent });
      jobEventBus.emitJobStatus(id, { status: 'VERIFY', runner: verifyAgent });
      jobEventBus.emitJobLog(id, { text: `\n[3/5] >>> 🔍 [VERIFY] Bắt đầu đối soát evidence thực tế trong ${evidenceDir}...\n` });
      scheduleNextStep(id, opts, 100);
      return;
    }

    if (job.status === 'VERIFY') {
      beginStepTimeline(id, 'VERIFY', 'verify-gate');
      const checkVerify = db.getJobById(id);
      if (checkVerify && checkVerify.status === 'CANCELLED') return;
      // PreJudge: BO - chi ghi log, khong quyet dinh gi (verifyTaskEvidence la nguon su that).
      // Ton 1 network call moi vong FIXING ma khong doi hanh vi gi => ton tai, cham.
      const { failed: verifyFailed, reasons: verifyReasons, infraBlocked: verifyInfraBlocked } = await verifyTaskEvidenceAsync({
        jobId: id, evidenceDir, featureDir, taskCode,
        emit: (text) => jobEventBus.emitJobLog(id, { text })
      });
      // Lỗi hạ tầng verifier (timeout/abort/5xx) KHÔNG phải nội dung sai: tạm dừng job
      // để vòng tự hồi phục thử lại, không chuyển FIXING (đốt ngân sách vô ích) và
      // tuyệt đối không cho qua MERGING với ảnh chưa thẩm định.
      if (verifyInfraBlocked && !verifyFailed) {
        const infraText = (Array.isArray(verifyReasons) && verifyReasons.length > 0)
          ? verifyReasons.join('; ')
          : 'AI Vision không kết luận được do lỗi hạ tầng verifier.';
        jobEventBus.emitJobLog(id, {
          text: `\n[VERIFY] ⏳ Không có lỗi nội dung, chỉ lỗi hạ tầng verifier: ${infraText}\n→ Tạm dừng job để tự thử lại (không chuyển FIXING).\n`,
          level: 'warn'
        });
        pauseJobForTransient(id, { step: 'VERIFY', reason: infraText });
        return;
      }
      if (verifyFailed) {
        const fixAgent = agentMapping.FIXING || 'claude-code';
        const reasonText = (Array.isArray(verifyReasons) && verifyReasons.length > 0)
          ? verifyReasons.join('; ')
          : 'Đối soát evidence thất bại (VERIFY).';
        const failGate = { passed: false, error: reasonText, timeout: false, decided_at: new Date().toISOString(), mapped_from: 'VERIFY', source: 'pipeline-verify-evidence' };
        jobEventBus.emitJobLog(id, { text: `\n[VERIFY] ❌ Đối soát evidence thất bại: ${reasonText}. Chuyển sang FIXING với 🤖 Agent: ${fixAgent}.\n` });

        // Lưu danh sách evidence bị failed vào pipeline_config để FIXING và VERIFY sau xử lý trúng đích
        try {
          const freshJob = db.getJobById(id) || job;
          const pipe = jobPolicy.parsePipelineConfig(freshJob);
          pipe.last_failed_evidences = Array.from(failedEvidenceFiles);
          pipe.last_verify_reasons = verifyReasons;
          db.updateJob(id, { pipeline_config: pipe });
        } catch (e) {}

        db.updateJob(id, { status: 'FIXING', current_step: 'FIXING', had_fixing: 1, runner: fixAgent, error_message: reasonText, gate_result: failGate });
        jobEventBus.emitJobStatus(id, { status: 'FIXING', runner: fixAgent });
        scheduleNextStep(id, opts, 100);
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
      const activeWorktrees = db.listActiveJobWorktrees(id);
      if (activeWorktrees && activeWorktrees.length > 0) {
        db.updateJob(id, { status: 'MERGING', current_step: 'MERGING', runner: currentRunner });
        jobEventBus.emitJobStatus(id, { status: 'MERGING', runner: currentRunner });
        jobEventBus.emitJobLog(id, { text: `\n[VERIFY] ✅ Đối soát bằng chứng thành công! Chuyển sang bước [MERGING] để tích hợp ${activeWorktrees.length} service vào nhánh phát triển...\n` });
        scheduleNextStep(id, opts, 100);
        return;
      }
      db.updateJob(id, { status: 'DONE', current_step: 'COMPLETED', runner: currentRunner, completed_at: new Date().toISOString(), error_message: null, gate_result: { passed: true, error: null, timeout: false, decided_at: new Date().toISOString(), mapped_from: 'VERIFY', source: 'pipeline-verify-evidence' } });
      jobEventBus.emitJobDone(id, { status: 'DONE', runner: currentRunner, message: `Task ${taskCode} đã hoàn thành đối soát evidence.` });
      jobEventBus.emitJobLog(id, { text: `\n================================================================================\n[5/5] >>> 🏆 [DONE] Nhiệm vụ ${taskCode} ĐÃ HOÀN THÀNH TOÀN DIỆN VÀ NGHIỆM THU THÀNH CÔNG!\n================================================================================\n` });
      return;
    }

    if (job.status === 'FIXING') {
      const fixingAgent = agentMapping.FIXING || 'claude-code';
      beginStepTimeline(id, 'FIXING', fixingAgent);
      // FIXING cũng khởi động lại service để chụp/kiểm tra lại => cũng phải thuê port.
      const fixingPortCtx = await acquireJobPortsForStep(id, 'FIXING');
      if (fixingPortCtx.blocked) return;
      // resumeJobInternal xoa error_message khi chay lai => agent FIXING mat context loi.
      // Fallback sang gate_result.error / last_verify_reasons de van biet phai sua gi.
      const parseMaybeJson = (v) => {
        try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return null; }
      };
      const gateSnapshot = parseMaybeJson(job.gate_result) || {};
      const pipeSnapshot = jobPolicy.parsePipelineConfig(job) || {};
      const fixingErrorContext = job.error_message
        || (gateSnapshot && gateSnapshot.error)
        || (Array.isArray(pipeSnapshot.last_verify_reasons) ? pipeSnapshot.last_verify_reasons.join('; ') : '')
        || '';
      const fixingPrompt = promptTemplateManager.buildPrompt({
        step: 'fixing', taskCode, userPrompt: job.prompt || '', workspacePath, featureDir,
        previousContext: fileManager.loadPreviousContext(workspacePath, taskCode, 'fixing'),
        errorLogs: fixingErrorContext
      });
      const fixingGuard = guardPrompt(`${fixingPortCtx.contract || ''}${fixingPrompt}`);
      logSystemOneFallback(id, 'guard/FIXING', fixingGuard.decision);
      if (fixingGuard.scrubbed || fixingGuard.injection) {
        jobEventBus.emitJobLog(id, { text: `\n[GUARD] ⚠ Prompt FIXING: secret=${fixingGuard.hasSecret ? 'có' : 'không'} injection=${fixingGuard.injection ? 'có' : 'không'}. Tiếp tục bằng prompt đã scrub, không FAILED job.\n` });
      }
      const priorAttempt = systemone.getFixAttempt(job);
      const retryPolicy = jobPolicy.resolveMaxRetries(job);
      const maxRetries = retryPolicy.value;
      const attempt = priorAttempt + 1;

      if (attempt > maxRetries) {
        const msg = `FIXING đã vượt quá số vòng sửa tối đa (${priorAttempt}/${maxRetries} vòng). Dừng pipeline.`;
        jobEventBus.emitJobLog(id, { text: `\n[FIXING-FAILED] ❌ ${msg}\n` });
        db.updateJob(id, { status: 'FAILED', current_step: 'FIXING', error_message: msg });
        jobEventBus.emitJobStatus(id, { status: 'FAILED' });
        jobEventBus.emitJobError(id, { error: msg });
        return;
      }

      // Model SystemOne CHI doc `state` - gateway bo qua field `files` (probe 2026-10-21).
      // => phai truyen NOI DUNG file that qua state de model doc duoc file dang sua.
      // Uu tien file lien quan stack trace + file vua sua (mtime), gom ca file untracked.
      const errorHint = String(job.error_message || '').slice(0, 1000);
      const changedFiles = await fileContext.listChangedFiles(workspacePath, [], 8, errorHint);
      const fileCtx = await fileContext.collectFileContext(changedFiles, { workspacePath, maxStateTokens: 60000 });
      const fixGate = await systemone.checkFixGate({
        jobId: id, attempt, maxRetries,
        failures: { error: errorHint },
        files: changedFiles,
        fileContext: fileCtx.text
      });
      recordSystemOne(id, fixGate, 'fixgate');
      logSystemOneFallback(id, 'fixgate', fixGate);
      jobEventBus.emitJobLog(id, { text: `\n[SYSTEMONE-FIXGATE] attempt=${attempt}/${maxRetries} (source=${retryPolicy.source}) retry=${fixGate.retry} p_success=${fixGate.p_success} scope=${fixGate.fixScope}${fixGate.fallback ? ' [FALLBACK-HEURISTIC]' : ''}. File context: ${fileCtx.files.length} file, ~${fileCtx.tokens} tokens${fileCtx.truncatedFiles.length ? ` (cat: ${fileCtx.truncatedFiles.join(', ')})` : ''}.\n` });
      // QUY TAC MOI: fixGate KHONG duoc chan retry cung (chi thong bao).
      // Chi dung khi (a) het so lan retry, hoac (b) nguyen nhan loi bi TRUNG
      // voi lan truoc (kiem bang systemone.checkRepeatedCause o vong retry).
      if (fixGate && fixGate.retry === false) {
        const gateHint = fixGate.fallback
          ? `heuristic offline`
          : `p_success ${fixGate.p_success}`;
        jobEventBus.emitJobLog(id, { text: `\n[SYSTEMONE-FIXGATE] Model khong nghi retry (${gateHint}) - van cho phep retry, se kiem tra trung nguyen nhan o vong loi.\n` });
      }
      // Vong FIXING co retry: timeout/exit!=0 khong dung pipeline ngay,
      // ma thu lai cho het so lan retry (chi dung khe khi nguyen nhan TRUNG).
      const runner = runnerRegistry.getAvailableRunner(fixingAgent);
      if (!runner) {
        jobEventBus.emitJobLog(id, { text: `\n[FIXING-WARN] Không tìm thấy runner hợp lệ.\n` });
      } else {
        let fixAttempt = attempt;
        let fixingOk = false;
        let fixFailReason = '';
        let fixRepeatedStop = null;
        while (fixAttempt <= maxRetries) {
          // Lay config MOI NHAT tu DB và cập nhật số vòng sửa thực tế
          const freshJob = db.getJobById(id) || job;
          const currentPipe = systemone.withFixAttempt(freshJob, fixAttempt);
          db.updateJob(id, { runner: fixingAgent, pipeline_config: currentPipe });
          jobEventBus.emitJobStatus(id, { status: 'FIXING', runner: fixingAgent, pipeline_config: currentPipe, fix_attempt: fixAttempt });
          jobEventBus.emitJobLog(id, { text: `\n[FIXING] 🔧 Đang sửa lỗi với 🤖 Agent: ${fixingAgent} (vòng ${fixAttempt}/${maxRetries})...\n` });
          const backoffMs = jobPolicy.resolveRetryBackoffMs(fixAttempt);
          if (backoffMs > 0) {
            jobEventBus.emitJobLog(id, { text: `[RETRY-BACKOFF] Chờ ${backoffMs}ms trước vòng sửa thứ ${fixAttempt}/${maxRetries}.\n` });
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
          }
          const fixCheckCancelled = db.getJobById(id);
          if (fixCheckCancelled && fixCheckCancelled.status === 'CANCELLED') return;
          let fixingResult = null;
          // Mốc evidence trước vòng sửa: dùng để biết vòng này có ghi lại ảnh/log không.
          const evMtimeBefore = evidenceDirLatestMtime(evidenceDir);
          const fixingPromptFile = path.join(featureDir, 'prompt_fixing.md');
          try {
            fs.writeFileSync(fixingPromptFile, fixingGuard.promptToUse, 'utf8');
          } catch (err) {
            console.warn('[PROMPT-FILE] Không thể ghi prompt_fixing.md:', err.message);
          }

          try {
            fixingResult = await runner.execute({
              prompt: fixingGuard.promptToUse,
              promptFilePath: fixingPromptFile,
              env: { AIWORKER_PORT_MAP: JSON.stringify(fixingPortCtx.ports || {}) },
              featureDir,
              step: 'FIXING',
              taskCode,
              cwd: workspacePath,
              jobId: id,
              timeoutMs: stepTimeoutMs,
              onStdout: (text) => jobEventBus.emitJobLog(id, { text }),
              onStderr: (text) => jobEventBus.emitJobLog(id, { text })
            });
          } catch (fixExecErr) {
            jobEventBus.emitJobLog(id, { text: `[FIXING] Lỗi thực thi Agent: ${fixExecErr.message}\n` });
            fixingResult = { output: fixExecErr.message, exitCode: 1 };
          }
          // Rate-limit cua provider: retry vong FIXING ngay la vo nghia, nhung
          // KHONG duoc coi la loi code => tam dung cho hoi phuc (giong TESTING).
          const rl = jobPolicy.detectRateLimit(jobPolicy.collectAgentOutput(fixingResult));
          if (rl.limited) {
            const retryAfter = rl.retryAfterMs ? ` (retry-after ${Math.round(rl.retryAfterMs / 1000)}s)` : '';
            const msg = `Provider rate-limit${retryAfter}`;
            jobEventBus.emitJobLog(id, { text: `\n[RATE-LIMIT] ${msg} — tạm dừng chờ hồi phục, không retry mù.\n` });
            pauseJobForTransient(id, { step: 'FIXING', reason: msg, retryAfterMs: rl.retryAfterMs });
            return;
          }
          // Provider/agent chết tạm thời (không phải lỗi code) => pause chờ hồi phục,
          // KHÔNG tính là một vòng sửa thất bại (PHUB-679 từng đốt 3 vòng vì lỗi này).
          if (fixingResult && !fixingResult.timedOut && isTransientAgentFailure(jobPolicy.collectAgentOutput(fixingResult))) {
            const transientText = jobPolicy.collectAgentOutput(fixingResult).slice(0, 300);
            jobEventBus.emitJobLog(id, { text: `\n[FIXING] ⏳ Agent CLI không chạy được do provider tạm thời không sẵn sàng — coi là lỗi hạ tầng, tạm dừng job để thử lại.\n` });
            pauseJobForTransient(id, { step: 'FIXING', reason: `Agent CLI lỗi hạ tầng/provider: ${transientText}` });
            return;
          }
          // Xác minh service chạy đúng build worktree (chống test trên bản cũ).
          // - Có listener nhưng hash cũ/chưa restart + vòng này CÓ ghi evidence
          //   => đúng là chụp ảnh từ build cũ: đánh trượt.
          // - KHÔNG còn listener => agent đã dừng service để nhả port như prompt
          //   yêu cầu; không có build cũ nào đang chạy nên KHÔNG được đánh trượt.
          if (fixingResult && !fixingResult.timedOut && fixingResult.exitCode === 0) {
            const producedEvidence = evidenceDirLatestMtime(evidenceDir) > evMtimeBefore;
            const provFix = await verifyRuntimeProvenance(id, fixingPortCtx, 'FIXING');
            if (!provFix.ok && provFix.wrongBuild && producedEvidence && config.RUNTIME_PROVENANCE_MODE === 'strict') {
              fixingResult = {
                ...fixingResult,
                exitCode: 1,
                stderr: `${fixingResult.stderr || ''}\n[PROVENANCE] Xác minh build thất bại: ${provFix.reason || 'unknown'}`
              };
            } else if (!provFix.ok) {
              jobEventBus.emitJobLog(id, {
                text: provFix.noListener
                  ? '[PROVENANCE] ℹ️ FIXING: agent đã dừng service để nhả port (không còn listener) — chấp nhận vòng sửa, VERIFY vẫn chấm nội dung evidence.\n'
                  : '[PROVENANCE] ⚠️ FIXING: chưa xác minh được build mới nhưng vòng này không ghi lại evidence mới — cho qua (VERIFY vẫn kiểm tra nội dung ảnh).\n',
                level: 'warn'
              });
            }
          }
          if (fixingResult && !fixingResult.timedOut && fixingResult.exitCode === 0) {
            fixingOk = true;
            break;
          }
          fixFailReason = fixingResult && fixingResult.timedOut
            ? `vượt quá giới hạn thời gian (${fixingResult.timeoutMs || stepTimeoutMs}ms)`
            : `exit code ${fixingResult ? fixingResult.exitCode : 'không xác định'}`;
          // Het so lan retry => dung luon.
          if (fixAttempt >= maxRetries) break;
          // Nguyên nhân lỗi có TRÙNG lần trước không? => SystemOne quyết định.
          const dup = await evaluateRepeatedCause({
            id, step: 'FIXING', attempt: fixAttempt, maxRetries, reason: fixFailReason,
            output: jobPolicy.collectAgentOutput(fixingResult)
          });
          if (dup && dup.repeated) {
            fixRepeatedStop = dup;
            break;
          }
          jobEventBus.emitJobLog(id, { text: `\n[FIXING-RETRY] Vòng sửa ${fixAttempt}/${maxRetries} thất bại (${fixFailReason}) - thử lại vòng ${fixAttempt + 1}.\n` });
          fixAttempt += 1;
          const retryJob = db.getJobById(id) || job;
          const retryPipe = systemone.withFixAttempt(retryJob, fixAttempt);
          db.updateJob(id, { pipeline_config: retryPipe });
          jobEventBus.emitJobStatus(id, { status: 'FIXING', runner: fixingAgent, pipeline_config: retryPipe, fix_attempt: fixAttempt });
        }
        if (!fixingOk) {
          const repeatedNote = fixRepeatedStop
            ? ` (SystemOne dừng vòng lặp: ${fixRepeatedStop.reason}; nguyên nhân đã gặp ${fixRepeatedStop.occurrences} lần trước)`
            : '';
          const msg = `FIXING thất bại sau ${fixAttempt}/${maxRetries} vòng: ${fixFailReason}${repeatedNote}. Dừng pipeline.`;
          const stopNote = fixRepeatedStop
            ? `\n[FIXING-FAILED] SystemOne đã DỪNG vòng lặp: nguyên nhân lỗi giống hệt ${fixRepeatedStop.occurrences} lần trước (${fixRepeatedStop.reason}). Không retry thêm.\n`
            : `\n[FIXING-FAILED] ${msg}\n`;
          jobEventBus.emitJobLog(id, { text: stopNote });
          db.updateJob(id, { status: 'FAILED', current_step: 'FIXING', error_message: msg });
          jobEventBus.emitJobStatus(id, { status: 'FAILED' });
          jobEventBus.emitJobError(id, { error: msg });
          return;
        }
        jobEventBus.emitJobLog(id, { text: `\n[FIXING] Hoàn tất sửa lỗi (vòng ${fixAttempt}/${maxRetries}).\n` });
        const checkAfterFix = db.getJobById(id);
        if (checkAfterFix && (checkAfterFix.status === 'CANCELLED' || checkAfterFix.status === 'PAUSED')) {
          return;
        }
      }

      // Đã sửa lỗi xong, chuyển sang VERIFY để đối soát lại
      jobEventBus.emitJobLog(id, { text: `\n[FIXING] Hoàn tất sửa lỗi và cập nhật bằng chứng, chuyển sang [VERIFY] để đối soát lại...\n` });
      db.updateJob(id, { status: 'VERIFY', current_step: 'VERIFY', runner: 'verify-gate' });
      jobEventBus.emitJobStatus(id, { status: 'VERIFY', runner: 'verify-gate' });
      scheduleNextStep(id, opts, 100);
      return;
    }
    if (job.status === 'MERGING') {
      const mergingAgent = job.runner || (agentMapping.IMPLEMENT || 'claude-code');
      beginStepTimeline(id, 'MERGING', mergingAgent);
      jobEventBus.emitJobLog(id, { text: `\n================================================================================\n[6/6] >>> 🔀 [MERGING] Bắt đầu quy trình tích hợp mã nguồn vào nhánh phát triển...\n================================================================================\n` });

      const activeWorktrees = db.listActiveJobWorktrees(id);
      if (!activeWorktrees || activeWorktrees.length === 0) {
        db.updateJob(id, {
          status: 'DONE',
          current_step: 'COMPLETED',
          runner: mergingAgent,
          completed_at: new Date().toISOString(),
          error_message: null,
          gate_result: { passed: true, error: null, timeout: false, decided_at: new Date().toISOString(), mapped_from: 'MERGING', source: 'pipeline-merge' }
        });
        jobEventBus.emitJobDone(id, { status: 'DONE', runner: mergingAgent, message: `Task ${taskCode} đã hoàn tất nghiệm thu.` });
        jobEventBus.emitJobLog(id, { text: `\n[MERGING] ✅ Không có worktree phụ thuộc, hoàn thành nhiệm vụ sang [DONE]!\n` });
        return;
      }

      let ws = null;
      if (job.workspace_id) {
        ws = db.getWorkspaceById(job.workspace_id);
      }
      if (!ws) {
        const defaultWs = db.listWorkspaces().find(w => w.is_default);
        ws = defaultWs || db.listWorkspaces()[0];
      }
      let allMergedSuccessfully = true;
      let conflictService = null;
      let conflictFiles = [];
      let retestFailOutput = '';
      let retestEnvError = false;

      const wsMergeKey = ws ? (ws.path || ws.id) : (job.repo_path || './');
      jobEventBus.emitJobLog(id, { text: `\n[MERGING] ⏳ Đang yêu cầu Khóa Độc Quyền Workspace Merge để đảm bảo an toàn repo gốc...\n` });
      const wsMergeAcquired = await taskQueue.waitForWorkspaceMergeLock(wsMergeKey, id, 120000);
      if (!wsMergeAcquired) {
        throw new Error(`Timeout chờ Khóa Độc Quyền Workspace Merge. Vui lòng thử lại.`);
      }
      jobEventBus.emitJobLog(id, { text: `[MERGING] 🔒 Đã nhận Khóa Độc Quyền Workspace Merge. Bắt đầu tích hợp trên repo gốc...\n` });

      try {
        for (const wt of activeWorktrees) {
        if (wt.status === 'MERGED' || wt.status === 'CANCELLED') continue;

        const serviceKey = wt.service_key;
        let svcConfig = ws ? db.getWorkspaceServiceByKey(ws.id, serviceKey) : null;
        let repoFullPath = '';
        let targetDevBranch = wt.base_dev_branch || 'main';

        if (svcConfig) {
          targetDevBranch = wt.base_dev_branch || svcConfig.dev_branch || 'main';
          repoFullPath = path.isAbsolute(svcConfig.repo_path)
            ? svcConfig.repo_path
            : path.resolve(ws.path, svcConfig.repo_path);
        } else if (ws) {
          repoFullPath = path.resolve(ws.path, serviceKey);
        }

        if (!repoFullPath || !fs.existsSync(repoFullPath)) {
          jobEventBus.emitJobLog(id, { text: `[MERGING] ⚠ Bỏ qua service '${serviceKey}' vì đường dẫn repo không tồn tại: ${repoFullPath}\n` });
          continue;
        }

        // 1. Giành Exclusive Dev Lock trên repo gốc của service (Đơn luồng tuyệt đối)
        jobEventBus.emitJobLog(id, { text: `[MERGING] Đang yêu cầu Khóa Độc Quyền (Exclusive Dev Lock) cho repo gốc '${serviceKey}'...\n` });
        const wsId = ws ? ws.id : 'default';
        const lockAcquired = await taskQueue.waitForDevLock(serviceKey, id, wsId, 60000);
        if (!lockAcquired) {
          throw new Error(`Timeout chờ Khóa Độc Quyền cho service '${serviceKey}'. Vui lòng thử lại.`);
        }
        jobEventBus.emitJobLog(id, { text: `[MERGING] 🔒 Đã nhận Khóa Độc Quyền cho '${serviceKey}'. Bắt đầu merge...\n` });

        let stashInfo = { stashed: false };
        try {
          // 2. Đảm bảo clean working tree ở repo gốc (stash an toàn nếu có thay đổi dở dang của lập trình viên)
          stashInfo = worktreeManager.ensureCleanWorkingTree(repoFullPath);
          if (stashInfo.stashed) {
            jobEventBus.emitJobLog(id, { text: `[MERGING] Đã tự động stash uncommitted changes tại repo gốc '${serviceKey}'.\n` });
          }
          const taskBranch = wt.task_branch || `feature/${taskCode}`;

          // 2b. Tự động commit các thay đổi trong worktree lên taskBranch nếu Agent chưa commit
          if (wt.worktree_path && fs.existsSync(wt.worktree_path)) {
            try {
              // Unstage file manifest nội bộ của ai-worker nếu có
              try {
                require('node:child_process').execSync('git reset HEAD -- .task-manifest.json', { cwd: wt.worktree_path, stdio: 'ignore' });
              } catch (_) {}

              const wtStatus = require('node:child_process').execSync('git status --porcelain', {
                cwd: wt.worktree_path,
                stdio: 'pipe',
                encoding: 'utf-8'
              });
              const relevantChanges = wtStatus.split('\n').filter(l => l.trim() && !l.includes('.task-manifest.json'));
              if (relevantChanges.length > 0) {
                jobEventBus.emitJobLog(id, { text: `[MERGING] 📦 Phát hiện thay đổi mã nguồn trong worktree '${serviceKey}', tự động commit lên nhánh '${taskBranch}'...\n` });
                require('node:child_process').execSync('git add -A', { cwd: wt.worktree_path, stdio: 'pipe' });
                try {
                  require('node:child_process').execSync('git reset HEAD -- .task-manifest.json', { cwd: wt.worktree_path, stdio: 'ignore' });
                } catch (_) {}
                require('node:child_process').execSync(`git commit -m "${taskCode}: hoàn thành triển khai mã nguồn"`, { cwd: wt.worktree_path, stdio: 'pipe' });
                jobEventBus.emitJobLog(id, { text: `[MERGING] ✅ Đã commit mã nguồn lên nhánh '${taskBranch}'.\n` });
              }
            } catch (cErr) {
              jobEventBus.emitJobLog(id, { text: `[MERGING] Cảnh báo tự động commit worktree: ${cErr.message}\n` });
            }
          }

          // 3. Thực hiện merge branch task vào dev_branch
          let preMergeSha = null;
          try {
            preMergeSha = require('node:child_process').execSync('git rev-parse HEAD', { cwd: repoFullPath, stdio: 'pipe', encoding: 'utf-8' }).trim();
          } catch (_) {}

          // Message merge = NỘI DUNG ĐÃ LÀM của task (report.md, fallback summary/title).
          const mergeJob = db.getJobById(id) || job;
          const mergeFeatureDir = (() => {
            try { return resolveFeatureDirForJob(mergeJob); } catch (e) { return null; }
          })();
          const taskMergeMessage = worktreeManager.buildTaskMergeMessage(mergeJob, taskCode, mergeFeatureDir);
          jobEventBus.emitJobLog(id, { text: `[MERGING] Merge nhánh '${taskBranch}' vào nhánh phát triển '${targetDevBranch}'...\n` });
          const mRes = worktreeManager.mergeBranch({
            repoFullPath,
            targetDevBranch,
            taskBranch,
            message: taskMergeMessage
          });

          if (mRes.conflict) {
            jobEventBus.emitJobLog(id, { text: `\n[MERGING] ⚠ PHÁT HIỆN CONFLICT tại ${mRes.conflictFiles.length} file: ${mRes.conflictFiles.join(', ')}!\n[MERGING] 🤖 Kích hoạt gỡ conflict trực tiếp trên repo gốc '${serviceKey}'...\n` });

            // 1. Phân giải conflict markers trực tiếp trên các file của repo gốc
            for (const cFile of mRes.conflictFiles) {
              const fullFilePath = path.join(repoFullPath, cFile);
              if (fs.existsSync(fullFilePath)) {
                try {
                  const content = fs.readFileSync(fullFilePath, 'utf-8');
                  if (content.includes('<<<<<<<') && content.includes('=======')) {
                    const lines = content.split('\n');
                    const resolvedLines = [];
                    let inTheirs = false;
                    for (const line of lines) {
                      if (line.startsWith('<<<<<<<')) {
                        inTheirs = false;
                      } else if (line.startsWith('=======')) {
                        inTheirs = true;
                      } else if (line.startsWith('>>>>>>>')) {
                        inTheirs = false;
                      } else {
                        // Dung hòa mã nguồn: giữ các dòng không chứa marker
                        resolvedLines.push(line);
                      }
                    }
                    fs.writeFileSync(fullFilePath, resolvedLines.join('\n'), 'utf-8');
                    require('node:child_process').execSync(`git add "${cFile}"`, { cwd: repoFullPath, stdio: 'ignore' });
                  }
                } catch (resErr) {
                  jobEventBus.emitJobLog(id, { text: `[MERGING] Cảnh báo xử lý file ${cFile}: ${resErr.message}\n` });
                }
              }
            }

            // 2. Bắt buộc RE-TEST trực tiếp trên nhánh phát triển của repo gốc
            jobEventBus.emitJobLog(id, { text: `[MERGING] 🧪 Đang chạy RE-TEST trực tiếp trên nhánh '${targetDevBranch}' của repo gốc...\n` });
            const testResult = worktreeManager.runServiceTest(repoFullPath);

            if (testResult.passed) {
              jobEventBus.emitJobLog(id, { text: `[MERGING] ✅ RE-TEST PASS trên repo gốc sau khi gỡ conflict!\n` });
              worktreeManager.finalizeMergeCommit(repoFullPath, taskMergeMessage);
              worktreeManager.restoreWorkingTree(repoFullPath, stashInfo);
              worktreeManager.removeTaskWorktree(repoFullPath, wt.worktree_path);
              db.updateJobWorktreeStatus(wt.id, 'MERGED');
            } else {
              jobEventBus.emitJobLog(id, { text: `[MERGING] ❌ RE-TEST THẤT BẠI sau khi gỡ conflict! Output:\n${extractBuildErrorSnippet(testResult.output, 600)}\n[MERGING] Hoàn tác merge trên repo gốc...\n` });
              worktreeManager.abortMerge(repoFullPath);
              worktreeManager.restoreWorkingTree(repoFullPath, stashInfo);
              conflictService = serviceKey;
              conflictFiles = mRes.conflictFiles;
              retestFailOutput = testResult.output; retestEnvError = !!testResult.envError;
              allMergedSuccessfully = false;
              break;
            }
          } else if (!mRes.success) {
            throw new Error(`Merge thất bại cho service '${serviceKey}': ${mRes.error || 'Lỗi không xác định'}`);
          } else {
            // Clean Merge thành công -> VẪN BẮT BUỘC PHẢI CHẠY RE-TEST TRÊN REPO GỐC
            jobEventBus.emitJobLog(id, { text: `[MERGING] ✅ Clean merge vào nhánh '${targetDevBranch}'. Đang chạy RE-TEST trực tiếp trên repo gốc '${serviceKey}'...\n` });
            const testResult = worktreeManager.runServiceTest(repoFullPath);

            if (testResult.passed) {
              jobEventBus.emitJobLog(id, { text: `[MERGING] ✅ RE-TEST PASS trên repo gốc '${serviceKey}'!\n` });
              worktreeManager.restoreWorkingTree(repoFullPath, stashInfo);
              worktreeManager.removeTaskWorktree(repoFullPath, wt.worktree_path);
              db.updateJobWorktreeStatus(wt.id, 'MERGED');
            } else {
              jobEventBus.emitJobLog(id, { text: `[MERGING] ❌ RE-TEST THẤT BẠI trên repo gốc '${serviceKey}' sau khi merge! Output:\n${extractBuildErrorSnippet(testResult.output, 600)}\n[MERGING] Hoàn tác merge trên repo gốc...\n` });
              if (preMergeSha) {
                try {
                  require('node:child_process').execSync(`git reset --hard "${preMergeSha}"`, { cwd: repoFullPath, stdio: 'ignore' });
                } catch (_) {}
              } else {
                worktreeManager.abortMerge(repoFullPath);
              }
              worktreeManager.restoreWorkingTree(repoFullPath, stashInfo);
              conflictService = serviceKey;
              conflictFiles = ['Re-test failed on target dev branch'];
              retestFailOutput = testResult.output; retestEnvError = !!testResult.envError;
              allMergedSuccessfully = false;
              break;
            }
          }
        } catch (mErr) {
          worktreeManager.abortMerge(repoFullPath);
          worktreeManager.restoreWorkingTree(repoFullPath, stashInfo);
          taskQueue.releaseDevLock(serviceKey, id, wsId);
          throw mErr;
        } finally {
          taskQueue.releaseDevLock(serviceKey, id, wsId);
        }
      }
    } finally {
      taskQueue.releaseWorkspaceMergeLock(wsMergeKey, id);
      jobEventBus.emitJobLog(id, { text: `[MERGING] 🔓 Đã giải phóng Khóa Độc Quyền Workspace Merge.\n` });
    }

      if (!allMergedSuccessfully) {
        // Lỗi môi trường (Maven wrapper hỏng, thiếu JAVA_HOME, timeout...): agent FIXING không sửa được -> dừng, không đốt vòng lặp
        if (retestEnvError) {
          const envMsg = `RE-TEST lỗi MÔI TRƯỜNG tại service '${conflictService}' (không phải lỗi code, cần người xử lý môi trường rồi Rerun): ${extractBuildErrorSnippet(retestFailOutput, 600)}`;
          jobEventBus.emitJobLog(id, { text: `\n[MERGING] ⛔ ${envMsg}\n` });
          db.updateJob(id, { status: 'FAILED', current_step: 'MERGING', error_message: envMsg });
          jobEventBus.emitJobStatus(id, { status: 'FAILED' });
          jobEventBus.emitJobError(id, { error: envMsg });
          return;
        }
        // Có conflict -> Chuyển về FIXING bên trong worktree để giải quyết (kèm output test thật để agent biết lỗi gì)
        const outSnippet = retestFailOutput ? ` Output re-test:\n${extractBuildErrorSnippet(retestFailOutput, 1500)}` : '';
        const conflictMsg = `Phát hiện conflict khi merge service '${conflictService}' (${conflictFiles.join(', ')}). Vui lòng cập nhật code và đối soát lại.${outSnippet}`;
        jobEventBus.emitJobLog(id, { text: `\n[MERGING ➔ FIXING] ⚠ ${conflictMsg}\n` });
        db.updateJob(id, {
          status: 'FIXING',
          current_step: 'FIXING',
          had_fixing: 1,
          error_message: conflictMsg
        });
        jobEventBus.emitJobStatus(id, { status: 'FIXING' });
        scheduleNextStep(id, opts, 100);
        return;
      }

      // Toàn bộ services đã được merge thành công!
      db.updateJob(id, {
        status: 'DONE',
        current_step: 'COMPLETED',
        runner: mergingAgent,
        completed_at: new Date().toISOString(),
        error_message: null,
        gate_result: { passed: true, error: null, timeout: false, decided_at: new Date().toISOString(), mapped_from: 'MERGING', source: 'pipeline-merge' }
      });
      jobEventBus.emitJobDone(id, { status: 'DONE', runner: mergingAgent, message: `Task ${taskCode} đã hoàn tất merge code thành công.` });
      jobEventBus.emitJobLog(id, { text: `\n================================================================================\n[6/6] >>> 🏆 [DONE] Nhiệm vụ ${taskCode} ĐÃ HOÀN TẤT MERGE VÀ NGHIỆM THU THÀNH CÔNG!\n================================================================================\n` });
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

/**
 * Nguong confidence toi thieu de AI triage bat che do NHANH (quick track).
 * Chi khi model THAT rat ro rang rang task la "nhe" moi duoc dung template rut gon.
 * Do phan bo confidence quan sat duoc tren task that: 0.6-0.68 => nguong 0.5 se
 * vô tinh bat quick mode cho task trung binh (va cat timeout cua user).
 */
const QUICK_TRACK_MIN_CONFIDENCE = 0.7;
const runJobPipeline = (jobId, opts) => {
  return new Promise((resolve) => {
    const jobToStart = db.getJobById(jobId);
    const tCode = (jobToStart && (jobToStart.task_code || jobToStart.id)) || jobId;
    const currentStatus = ((jobToStart && jobToStart.status) || '').toString().trim().toUpperCase();
    // Job đã ở trạng thái kết thúc (DONE/ARCHIVED/DELETED): không có nhánh
    // executeStep nào xử lý nên resolve ngay, tránh treo Promise và khóa chết workspace.
    // `TIMED_OUT` duoc chay lai: deadline_at da duoc xoa o duoi day (ngan sach moi).
    if (TERMINAL_JOB_STATUSES.has(currentStatus) && currentStatus !== 'TIMED_OUT') {
      console.log(`[PIPELINE-SKIP] Task ${tCode} (${jobId}) đã ở trạng thái kết thúc ${currentStatus}, không chạy lại pipeline.`);
      resolve({ status: jobToStart.status, skipped: true });
      return;
    }
    console.log(`[PIPELINE-START] Bắt đầu thực thi pipeline cho Task ${tCode} (${jobId})...`);

    // Nếu đang TO DO, FAILED, CANCELLED hoặc rỗng thì bắt đầu chuyển PLANNING.
    // RESET trạng thái lần chạy trước: lich su loi + so vong fix cu + loi cu.
    // Khong reset => co che so trung nguyen nhan so loi cu cua luan chay truoc
    // (sai), va `fix_attempt` cu lam FIXING nhay o vong da het han muc.
    if (!jobToStart.status || RESTARTABLE_JOB_STATUSES.has(currentStatus)) {
      const freshPipe = jobPolicy.clearFailureHistory(jobPolicy.parsePipelineConfig(jobToStart));
      // KHONG xoa `fix_attempt` o day: truoc day moi lan Start lai deu reset
      // => max_retries vo hieu (job da chay 15 vong FIXING du khai 10).
      // Chi /rerun?mode=restart moi duoc reset ngan sach.
      delete freshPipe.last_error_kind;
      delete freshPipe.last_error_reason;
      delete freshPipe.retry_at;
      delete freshPipe.transient_retry;
      // Xoa deadline cu: lan chay moi phai co ngan sach thoi gian MOI
      // (neu giu deadline da het han, job moi se chet ngay o buoc dau tien).
      delete freshPipe.deadline_at;
      delete freshPipe.deadlineAt;
      db.updateJob(jobId, {
        status: 'PLANNING', current_step: 'PLANNING', error_message: null,
        pipeline_config: freshPipe, gate_result: null
      });
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

    executeStep(jobId, opts).catch((err) => {
      console.error(`[EXECUTE-STEP-ERR] Lỗi khi thực thi pipeline cho Job ${jobId}:`, err);
      db.updateJob(jobId, { status: 'FAILED', error_message: err.message });
      jobEventBus.emitJobStatus(jobId, { status: 'FAILED' });
      jobEventBus.emitJobError(jobId, { error: err.message });
      finish({ status: 'FAILED', error: err });
    });
  });
};

/**
 * Doc/ghi co "che do nhanh" (quick track) cho 1 job trong pipeline_config.
 * Task nhe (SystemOne triage: S/quick) -> plan rut gon + implement nhanh.
 * @param {object} job
 * @returns {boolean}
 */
function isQuickTrack(job) {
  try {
    const cfg = jobPolicy.parsePipelineConfig(job);
    return cfg && cfg.quick_track === true;
  } catch (e) { return false; }
}

/**
 * Timeout user khai TUONG MINH cho job (ms). Tra null neu user KHONG khai.
 *
 * Nguon: pipeline_config.timeout / timeout_ms / timeout_seconds / timeout_minutes
 * hoac job.timeout. Fallback null => KHONG dung DEFAULT_TIMEOUT (default = chua khai).
 * @param {object} job
 * @returns {number|null}
 */
function resolveExplicitTimeoutMs(job) {
  try {
    const ms = config.resolveJobTimeoutMs(job, null);
    const n = Number(ms);
    if (ms !== null && ms !== undefined && Number.isFinite(n) && n > 0) return n;
    return null;
  } catch (e) { return null; }
}

/**
 * User da TAT che do nhanh tuong minh (pipeline_config.quick_track === false)?
 * Phan biet "user tat" (false) voi "chua quyet dinh" (undefined).
 * @param {object} job
 * @returns {boolean}
 */
function isQuickTrackDisabledByUser(job) {
  try {
    const cfg = jobPolicy.parsePipelineConfig(job);
    return cfg && cfg.quick_track === false;
  } catch (e) { return false; }
}

/**
 * Che do NHANH co THUC SU hieu luc cho job nay khong?
 *
 * 3 dieu kien phai cung dung:
 * 1) `pipeline_config.quick_track === true` (co bat, thuong do triage tu bat),
 * 2) user CHUA tat tường minh (`quick_track === false` => user quyet dinh roi),
 * 3) user CHUA khai timeout tường minh (timeout user luon thang quick cap).
 *
 * Quan trong: cung bien nay phai dung cho chon TEMPLATE (planning-quick /
 * implement-quick) - neu chi cap timeout ma van dung template "sua IT NHAT" thi
 * task phuc tap van bi lam sai noi dung (job RSGATE-44).
 * @param {object} job
 * @returns {boolean}
 */
function resolveEffectiveQuickTrack(job) {
  if (!isQuickTrack(job)) return false;
  if (isQuickTrackDisabledByUser(job)) return false;
  if (resolveExplicitTimeoutMs(job) !== null) return false;
  return true;
}

/**
 * Bat/TAT che do nhanh cho 1 job (ghi vao pipeline_config de moi lan chay deu doc duoc).
 *
 * 3 trang thai:
 * - enabled=true  -> cfg.quick_track = true  (bat)
 * - enabled=false -> cfg.quick_track = false (tat TUONG MINH: triage khong tu bat lai)
 * - enabled=null  -> DELETE cfg.quick_track    (auto: he thong tu quyet dinh)
 *
 * Phan biet bat buoc `false` vs `auto` (xoa key): `isQuickTrackDisabledByUser`
 * chi chan khi key CÓ gia tri false. Neu auto gan false se chan triage bat lai
 * o cac lan Start sau - sai nghia.
 * @param {string} jobId
 * @param {boolean|null} enabled
 * @returns {boolean} true neu ghi thanh cong
 */
function setQuickTrack(jobId, enabled) {
  try {
    const job = db.getJobById(jobId);
    if (!job) return false;
    const cfg = jobPolicy.parsePipelineConfig(job);
    if (enabled === null || enabled === undefined) {
      delete cfg.quick_track;
    } else {
      cfg.quick_track = !!enabled;
    }
    db.updateJob(jobId, { pipeline_config: cfg });
    return true;
  } catch (e) { return false; }
}

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
    // `TIMED_OUT` duoc Start lai: deadline_at da duoc xoa o runJobPipeline
    // (restart => ngan sach thoi gian moi). Truoc day job het deadline thi
    // chi con duoc Clone - nghen user "chay lai tren chinh job do".
    if (TERMINAL_JOB_STATUSES.has(startStatusNorm) && startStatusNorm !== 'TIMED_OUT') {
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

    // 2b. SystemOne Triage + Dedup trước enqueue (fail-open về đường cũ)
    const triage = await systemone.checkTriage({ taskCode, prompt: job.prompt || job.title || '', jobId: id });
    recordSystemOne(id, triage, 'triage');
    logSystemOneFallback(id, 'triage', triage);
    // Dedup: hash LOCAL (bucketId) - khong goi model. Ket qua chi dung de gan nhan,
    // goi network o day chi ton mot call ma khong doi hanh vi gi.
    const dedup = systemone.localDedup({ taskCode, prompt: job.prompt || job.title || '' });
    jobEventBus.emitJobLog(id, { text: `\n[SYSTEMONE-TRIAGE] complexity=${triage.complexity} track=${triage.track} needBrowser=${triage.needBrowser} confidence=${triage.confidence}${triage.cached ? ' (cache)' : ''} bucket=${dedup.bucketId}.\n` });
    const explicitTimeout = resolveExplicitTimeoutMs(job);
    // Nguong bat che do NHANH: chi khi model THAT rat ro rang rang task nhe.
    // Do phan bo confidence quan sat duoc o 0.6-0.68 => nguong 0.5 se vô tinh
    // bat quick mode cho task trung binh. Raise len 0.7 de an toan.
    if (triage && triage.track === 'quick' && Number(triage.confidence) >= QUICK_TRACK_MIN_CONFIDENCE) {
      systemone.addCliSaved(1);
      // Bat che do nhanh THUC SU: plan rut gon + implement toi uu, khong chi tang priority.
      // KHONG bat khi user da TAT tuong minh (quick_track === false) hoac user da khai timeout.
      if (isQuickTrackDisabledByUser(job)) {
        jobEventBus.emitJobLog(id, { text: `\n[SYSTEMONE-TRIAGE] Bo qua che do NHANH: user da tat che do nhanh cho task nay.\n` });
      } else if (explicitTimeout !== null) {
        jobEventBus.emitJobLog(id, { text: `\n[SYSTEMONE-TRIAGE] Bo qua che do NHANH: user da khai timeout ${explicitTimeout}ms.\n` });
      } else {
        setQuickTrack(id, true);
        jobEventBus.emitJobLog(id, { text: `\n[SYSTEMONE-TRIAGE] Task nhẹ (S/quick, confidence ${Number(triage.confidence).toFixed(2)}) — chế độ NHANH: plan rút gọn, implement tối ưu tốc độ.\n` });
      }
    }
    // 3. Đưa job vào TaskQueue để quản lý Concurrency & Workspace Queue Lock
    taskQueue.enqueue(job, (queuedJob, queueOpts) => runJobPipeline(id, queueOpts), (triage && triage.track === 'quick' ? (job.priority || 0) + 1 : job.priority || 0));

    const isQueued = taskQueue.isJobQueued(id);
    if (isQueued) {
      if (!isLocked) {
        jobEventBus.emitJobLog(id, {
          text: `\n[QUEUE] ⏳ Hệ thống đang chạy tối đa ${config.CONCURRENCY} luồng song song. Task '${taskCode}' đã được xếp vào hàng đợi chờ tới lượt...\n`,
          level: 'info'
        });
      }
      jobEventBus.emitJobStatus(id, { status: job.status || 'TO DO', is_queued: true });
    }

    return res.json({
      success: true,
      message: isQueued
        ? (isLocked
            ? `Task '${taskCode}' đã được xếp vào hàng đợi do Workspace đang bận!`
            : `Task '${taskCode}' đã được xếp vào hàng đợi do đạt giới hạn song song (${config.CONCURRENCY} luồng)!`)
        : `Task '${taskCode}' đã được kích hoạt thành công!`,
      jobId: id,
      taskCode,
      status: isQueued ? (job.status || 'TO DO') : 'PLANNING',
      queued: isQueued,
      is_queued: isQueued
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

app.post('/api/v1/jobs/:id/start', handleJobStart);
app.post('/api/v1/tasks/:id/start', handleJobStart);
/**
 * POST /api/v1/jobs/:id/dequeue và POST /api/v1/tasks/:id/dequeue
 * Xóa task khỏi hàng đợi chờ (khi task đang chờ slot hoặc chờ workspace lock)
 */
app.post(['/api/v1/jobs/:id/dequeue', '/api/v1/tasks/:id/dequeue'], (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Task with ID '${id}' not found` });
    }
    const canonicalId = job.id || id;
    const result = taskQueue.dequeue(canonicalId);
    if (!result.dequeued) {
      return res.status(400).json({ success: false, error: 'Task không nằm trong hàng đợi chờ' });
    }
    const taskCode = job.task_code || job.id;
    jobEventBus.emitJobLog(canonicalId, {
      text: `\n[QUEUE] ⏹️ Task '${taskCode}' đã được xóa khỏi hàng đợi chờ theo yêu cầu người dùng.\n`
    });
    jobEventBus.emitJobStatus(canonicalId, { status: job.status || 'TO DO', is_queued: false });
    return res.json({
      success: true,
      message: `Đã xóa task '${taskCode}' khỏi hàng đợi thành công`,
      jobId: canonicalId,
      taskCode,
      is_queued: false
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

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
    delete pipeConfig.fix_attempt;
    delete pipeConfig.fixAttempt;
    // Xoa lich su loi: job moi khong duoc mang loi cua job goc (co che so trung
    // nguyen nhan se so sanh sai ngay tu vong 1).
    pipeConfig = jobPolicy.clearFailureHistory(pipeConfig);
    // Xoa deadline cu: job clone phai co ngan sach thoi gian rieng.
    delete pipeConfig.deadline_at;
    delete pipeConfig.deadlineAt;

    const sourceCode = (sourceJob.task_code || '').trim();
    const sourceTitle = (sourceJob.title || '').trim();
    let clonedTitle = sourceTitle;
    if (clonedTitle) {
      if (sourceCode && clonedTitle.includes(sourceCode)) {
        clonedTitle = clonedTitle.replace(sourceCode, safeNewTaskCode);
      } else {
        const titlePrefixMatch = clonedTitle.match(/^\s*\[[^\]]+\]/);
        if (titlePrefixMatch) {
          clonedTitle = `[${safeNewTaskCode}]` + clonedTitle.slice(titlePrefixMatch[0].length);
        }
      }
    } else {
      clonedTitle = `[${safeNewTaskCode}] Task clone tu ${sourceCode || id}`;
    }

    const newJobData = {
      id: newJobId,
      task_code: safeNewTaskCode,
      title: clonedTitle,
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
 * Tinh thu muc feature cua job (dung cho marker plan + prompt file).
 */
function resolveFeatureDirForJob(job) {
  let workspacePath = job.repo_path || job.worktree_path || './';
  let wsFeaturesDir = 'docs/features';
  try {
    let ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id) : null;
    if (!ws && typeof db.listWorkspaces === 'function') {
      ws = db.listWorkspaces().find((w) => path.resolve(w.path) === path.resolve(workspacePath));
    }
    if (ws) {
      if (ws.path) workspacePath = ws.path;
      if (ws.features_dir) wsFeaturesDir = ws.features_dir;
    }
  } catch (e) {}
  return fileManager.getFeatureDirectory(workspacePath, job.task_code || job.id, wsFeaturesDir);
}

// Cac trang thai duoc phep "chay lai / tiep tuc" tu dong hoac thu cong.
const RESUMABLE_JOB_STATUSES = new Set(['FAILED', 'TIMED_OUT', 'CANCELLED', 'PAUSED', 'PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'MERGING']);
const PHASE_STEP_NAMES = new Set(['PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING', 'MERGING']);

/**
 * Cách ly các file nằm trong `evidence/` nhưng KHÔNG được khai trong metadata.json
 * (log runtime, ảnh debug, file tạm do agent thả vào).
 *
 * Vì sao không đánh trượt job: những file này không chứng minh cho test case nào,
 * nên chúng chỉ làm bẩn thư mục evidence. Trước đây mỗi lần như vậy tốn một vòng
 * FIXING (~20-40 phút) — PHUB-679 đã lặp nhiều vòng dù 28/28 ảnh đều PASS.
 *
 * @param {string} evidenceDir thư mục evidence của feature
 * @param {string[]} files tên file (tương đối trong evidenceDir)
 * @returns {{ok:number, dir:string|null}}
 */
function quarantineUndeclaredEvidence(evidenceDir, files) {
  if (!evidenceDir || !Array.isArray(files) || files.length === 0) return { ok: 0, dir: null };
  const day = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(path.dirname(evidenceDir), 'evidence_quarantine', day);
  let ok = 0;
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (e) {
    return { ok: 0, dir: null };
  }
  for (const rel of files) {
    const src = path.join(evidenceDir, rel);
    // Chặn thoát khỏi evidenceDir (đường dẫn ..)
    if (!path.resolve(src).startsWith(path.resolve(evidenceDir))) continue;
    if (!fs.existsSync(src)) continue;
    if (fs.statSync(src).isDirectory()) continue;
    let dest = path.join(targetDir, path.basename(rel));
    if (fs.existsSync(dest)) {
      dest = path.join(targetDir, `${Date.now()}-${path.basename(rel)}`);
    }
    try {
      fs.renameSync(src, dest);
      ok += 1;
    } catch (e) {
      // Khác ổ đĩa hoặc file đang bị giữ: copy rồi xoá.
      try { fs.copyFileSync(src, dest); fs.unlinkSync(src); ok += 1; } catch (e2) {}
    }
  }
  return { ok, dir: path.relative(path.dirname(evidenceDir), targetDir) };
}

/**
 * Gom tên các file evidence được KHAI trong metadata.json (tests[].evidence|evidences|files).
 * Chấp nhận cả array, string và object (agent có thể ghi kiểu gì cũng được).
 * @param {object} metadataObj
 * @returns {Set<string>}
 */
function collectDeclaredEvidenceNames(metadataObj) {
  const declared = new Set();
  const testsArr = (metadataObj && Array.isArray(metadataObj.tests)) ? metadataObj.tests : [];
  for (const t of testsArr) {
    if (!t || typeof t !== 'object') continue;
    for (const field of ['evidence', 'evidences', 'files']) {
      const v = t[field];
      if (Array.isArray(v)) for (const f of v) declared.add(String(f));
      else if (typeof v === 'string' && v) declared.add(v);
      else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          if (typeof k === 'string' && k) declared.add(k);
          if (val && typeof val === 'object' && val.fileName) declared.add(String(val.fileName));
        }
      }
    }
  }
  return declared;
}

/**
 * Job bi loi HA TANG (model/CLI/rate-limit) => PAUSED de CHO HOI PHUC thay vi
 * FAILED/FIXING. Khong tang `fix_attempt`, nho vay khong dot ngan sach retry
 * va khong day agent vao vong FIXING vo nghia.
 * @returns {object|null} job sau cap nhat
 */
function pauseJobForTransient(jobId, { step, reason, retryAfterMs } = {}) {
  const job = db.getJobById(jobId);
  if (!job) return null;
  const resumeStep = PHASE_STEP_NAMES.has(String(step || '').toUpperCase())
    ? String(step).toUpperCase()
    : (PHASE_STEP_NAMES.has(String(job.current_step || '').toUpperCase()) ? String(job.current_step).toUpperCase() : 'PLANNING');
  const attempt = (Number(jobPolicy.parsePipelineConfig(job).transient_retry) || 0) + 1;
  if (attempt > jobPolicy.MAX_TRANSIENT_RETRIES) {
    // Da cho hoi phuc qua so lan cho phep => coi la loi that.
    db.updateJob(jobId, {
      status: 'FAILED',
      current_step: resumeStep,
      error_message: `Lỗi hạ tầng kéo dài sau ${jobPolicy.MAX_TRANSIENT_RETRIES} lần chờ hồi phục: ${String(reason || '').slice(0, 300)}`
    });
    endStepTimeline(jobId, { status: 'FAILED' });
    jobEventBus.emitJobStatus(jobId, { status: 'FAILED' });
    return db.getJobById(jobId);
  }
  const pipe = jobPolicy.markTransientFailure({ ...job, pipeline_config: JSON.stringify(jobPolicy.parsePipelineConfig(job)) }, {
    step: resumeStep,
    reason,
    retryAfterMs
  });
  const updated = db.updateJob(jobId, {
    status: 'PAUSED',
    current_step: resumeStep,
    error_message: `[TRANSIENT] ${String(reason || '').slice(0, 400)}`,
    pipeline_config: pipe
  });
  endStepTimeline(jobId, { status: 'CANCELLED' });
  try {
    if (taskQueue.isJobEnqueuedOrRunning(jobId)) taskQueue.cancel(jobId);
  } catch (e) {}
  jobEventBus.emitJobStatus(jobId, { status: 'PAUSED', current_step: resumeStep });
  jobEventBus.emitJobLog(jobId, {
    text: `\n[TRANSIENT] ⏳ Lỗi hạ tầng (không phải lỗi code). Tạm dừng job và chờ hồi phục lần ${attempt}/${jobPolicy.MAX_TRANSIENT_RETRIES}, dự kiến thử lại sau ${Math.round(jobPolicy.resolveTransientBackoffMs(attempt) / 1000)}s.\nLý do: ${String(reason || '').slice(0, 300)}\n`,
    level: 'warn'
  });
  return updated;
}

/**
 * Tiep tuc / chay lai 1 job.
 * @param {string} jobId
 * @param {object} [options]
 * @param {'resume'|'restart'} [options.mode='resume'] resume = giu plan+ngan sach;
 *        restart = xoa marker plan + fix_attempt, chay lai tu PLANNING.
 * @param {boolean} [options.auto] do vong cho hoi phuc goi (khong kiem tra lai quyen)
 * @returns {{ok: boolean, code?: number, message?: string, job?: object, resumedStep?: string}}
 */
async function resumeJobInternal(jobId, { mode = 'resume', auto = false } = {}) {
  const job = db.getJobById(jobId);
  if (!job) return { ok: false, code: 404, message: `Job with ID '${jobId}' not found` };
  const statusNorm = (job.status || '').toString().trim().toUpperCase();
  if (taskQueue.isJobEnqueuedOrRunning(jobId)) {
    return { ok: false, code: 409, message: `Task đang chạy hoặc trong hàng đợi (${job.status}), không thể chạy lại.` };
  }
  if (!RESUMABLE_JOB_STATUSES.has(statusNorm)) {
    return { ok: false, code: 409, message: `Không thể chạy lại task ở trạng thái ${job.status}. Hãy Clone sang mã mới.` };
  }
  // Preflight: runner phai that su san sang, neu khong bao ro thay vi chay roi fail.
  try {
    const detected = runnerRegistry.detectAll() || [];
    const hasInstalled = detected.some((r) => r.installed);
    if (!hasInstalled) {
      return { ok: false, code: 409, message: 'RUNNER_UNAVAILABLE: không có AI CLI nào sẵn sàng (claude/codex/omp/opencode). Kiểm tra lại môi trường rồi thử lại.' };
    }
  } catch (e) {}

  let pipe = jobPolicy.parsePipelineConfig(job);
  // UU TIEN BUOC DANG DO cua job, KHONG uu tien `paused_step` cu.
  // `paused_step` chi duoc ghi luc user bam Dung; neu job sau do da chay tiep
  // (vd dang FIXING) thi gia tri cu (PLANNING) se keo job ve dau pipeline.
  const currentPhase = String(job.current_step || '').trim().toUpperCase();
  const statusPhase = String(job.status || '').trim().toUpperCase();
  const pausedPhase = String(pipe.paused_step || '').trim().toUpperCase();
  let resumeStep = PHASE_STEP_NAMES.has(currentPhase)
    ? currentPhase
    : (PHASE_STEP_NAMES.has(statusPhase)
      ? statusPhase
      : (PHASE_STEP_NAMES.has(pausedPhase) ? pausedPhase : 'PLANNING'));

  if (mode === 'restart') {
    // Chay lai tu dau: xoa marker plan + implement + ngan sach fix cu.
    delete pipe.fix_attempt;
    delete pipe.fixAttempt;
    delete pipe.implement_status;
    delete pipe.paused_step;
    delete pipe.pause_kind;
    delete pipe.waiting_reason;
    delete pipe.next_auto_resume_at;
    delete pipe.last_error_kind;
    delete pipe.last_error_reason;
    delete pipe.retry_at;
    delete pipe.transient_retry;
    pipe = jobPolicy.clearFailureHistory(pipe);
    try { stepGate.clearPlanOkMarker(resolveFeatureDirForJob(job)); } catch (e) {}
    resumeStep = 'PLANNING';
  } else {
    // resume: GIU fix_attempt (ngan sach retry khong bi reset) + cho ngan sach thoi gian moi.
    delete pipe.paused_step;
    delete pipe.pause_kind;
    delete pipe.waiting_reason;
    delete pipe.next_auto_resume_at;
    delete pipe.last_error_kind;
    delete pipe.last_error_reason;
    delete pipe.retry_at;
    // `auto` = vong cho hoi phuc tu chay lai: GIU `transient_retry` de backoff
    // leo thang (30s -> 30m) va cham nguong MAX_TRANSIENT_RETRIES. Neu xoa o
    // day, job bi 429 se lap vo han moi 30s (vua dot token, vua day provider
    // vao rate-limit nang hon). Nguoi dung bam Chay lai => reset nhu cu.
    if (!auto) delete pipe.transient_retry;
  }
  // Moi lan chay lai duoc cap ngan sach thoi gian moi (deadline cu da het).
  delete pipe.deadline_at;
  delete pipe.deadlineAt;

  const updatedJob = db.updateJob(jobId, {
    status: resumeStep,
    current_step: resumeStep,
    error_message: null,
    completed_at: null,
    pipeline_config: pipe
  });

  jobEventBus.emitJobStatus(jobId, { status: resumeStep, current_step: resumeStep });
  jobEventBus.emitJobLog(jobId, {
    text: `\n[${mode === 'restart' ? 'RERUN-RESTART' : 'RERUN-RESUME'}] ${auto ? 'Tự động ' : ''}Tiếp tục thực thi tại bước [${resumeStep}]${mode === 'resume' ? ' (giữ nguyên ngân sách retry)' : ' (đã reset ngân sách retry)'}.\n`
  });
  if (taskQueue.isJobEnqueuedOrRunning(jobId)) {
    scheduleNextStep(jobId, {}, 100);
  } else {
    taskQueue.enqueue(updatedJob, (queuedJob, queueOpts) => runJobPipeline(jobId, queueOpts), (updatedJob && updatedJob.priority) || 0);
  }
  return { ok: true, job: updatedJob, resumedStep: resumeStep };
}

/**
 * Vong quet 15s: job PAUSED do loi HA TANG va da den gio thu lai => tu chay tiep.
 * KHONG dung toi cac job PAUSED do nguoi dung bam Dung (khong co last_error_kind).
 */
function startTransientRecoveryLoop() {
  if (global.__aiWorkerTransientRecovery) return global.__aiWorkerTransientRecovery;
  const timer = setInterval(async () => {
    try {
      const paused = db.listJobs({ status: 'PAUSED', limit: 50 }) || [];
      for (const job of paused) {
        const pipe = jobPolicy.parsePipelineConfig(job);
        if (String(pipe.last_error_kind || '') !== 'TRANSIENT') continue;
        const retryAt = Number(pipe.retry_at) || 0;
        if (!retryAt || retryAt > Date.now()) continue;
        if (taskQueue.isJobEnqueuedOrRunning(job.id)) continue;
        const attempt = Number(pipe.transient_retry) || 1;
        if (attempt > jobPolicy.MAX_TRANSIENT_RETRIES) {
          db.updateJob(job.id, {
            status: 'FAILED',
            error_message: `Lỗi hạ tầng kéo dài sau ${jobPolicy.MAX_TRANSIENT_RETRIES} lần chờ hồi phục.`
          });
          jobEventBus.emitJobStatus(job.id, { status: 'FAILED' });
          continue;
        }
        console.log(`[RECOVERY] Tự động chạy lại job ${job.task_code || job.id} sau khi hết backoff (lần ${attempt}).`);
        await resumeJobInternal(job.id, { mode: 'resume', auto: true });
      }
    } catch (e) {
      console.warn('[RECOVERY] Lỗi vòng quét chờ hồi phục:', e.message);
    }
  }, 15000);
  if (timer.unref) timer.unref();
  global.__aiWorkerTransientRecovery = timer;
  return timer;
}

/**
 * Vòng dọn tiến trình rác: mỗi 10 phút quét và kill dev server/BE bỏ hoang
 * (tiến trình đang phục vụ job chạy thật luôn được bảo vệ - xem processJanitor).
 */
function startProcessJanitorLoop() {
  return processJanitor.startJanitorLoop();
}

/**
 * POST /api/v1/jobs/:id/pause và POST /api/v1/tasks/:id/pause
 * Tạm dừng ngay tại bước đang làm và ngắt tiến trình con đang chạy
 */
app.post(['/api/v1/jobs/:id/pause', '/api/v1/tasks/:id/pause'], async (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }
    const runningStatuses = ['PLANNING', 'PENDING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'];
    if (!runningStatuses.includes((job.status || '').toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: `Không thể tạm dừng khi task không ở trạng thái đang chạy (hiện tại: ${job.status})`
      });
    }

    const pausedStep = job.status;
    let pipe = jobPolicy.parsePipelineConfig(job);
    pipe.paused_step = pausedStep;

    // Ngắt an toàn toàn bộ tiến trình con của job
    let killedCount = 0;
    try {
      const { defaultProcessManager } = require('./execution/processManager');
      if (defaultProcessManager) {
        killedCount = await defaultProcessManager.killProcessesByJobId(id, 2000);
      }
    } catch (e) {
      console.warn('[SERVER] Không thể gọi processManager khi pause:', e);
    }
    // Hủy job khỏi taskQueue để giải phóng slot concurrency
    try {
      if (taskQueue.isJobEnqueuedOrRunning(id)) {
        taskQueue.cancel(id);
      }
    } catch (e) {
      console.warn('[SERVER] Lỗi cancel taskQueue khi pause:', e);
    }

    const updatedJob = db.updateJob(id, {
      status: 'PAUSED',
      current_step: pausedStep,
      pipeline_config: pipe
    });

    jobEventBus.emitJobStatus(id, { status: 'PAUSED', current_step: pausedStep, job: updatedJob });
    jobEventBus.emitJobLog(id, {
      text: `\n[PAUSE] ⏸ Đã tạm dừng task ngay tại bước [${pausedStep}] theo yêu cầu người dùng (tiến trình dừng: ${killedCount}).\n`,
      level: 'warn'
    });

    return res.json({
      success: true,
      message: `Đã tạm dừng task tại bước ${pausedStep}`,
      paused_step: pausedStep,
      job: updatedJob
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/jobs/:id/resume và POST /api/v1/tasks/:id/resume
 * Tiếp tục thực thi ngay tại bước đang đứng trước khi tạm dừng
 */
app.post(['/api/v1/jobs/:id/resume', '/api/v1/tasks/:id/resume'], async (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }
    if ((job.status || '').toUpperCase() !== 'PAUSED') {
      return res.status(400).json({
        success: false,
        error: `Chỉ có thể tiếp tục khi task ở trạng thái PAUSED (hiện tại: ${job.status})`
      });
    }

    let pipe = jobPolicy.parsePipelineConfig(job);
    const resumeStep = pipe.paused_step || job.current_step || 'PLANNING';
    delete pipe.paused_step;

    const updatedJob = db.updateJob(id, {
      status: resumeStep,
      current_step: resumeStep,
      pipeline_config: pipe
    });

    jobEventBus.emitJobStatus(id, { status: resumeStep, current_step: resumeStep, job: updatedJob });
    jobEventBus.emitJobLog(id, {
      text: `\n[RESUME] ▶ Tiếp tục thực thi task ngay tại bước [${resumeStep}]...\n`
    });

    // Kích hoạt tiếp tục pipeline qua taskQueue để đảm bảo giới hạn concurrency (3 luồng)
    if (!taskQueue.isJobEnqueuedOrRunning(id)) {
      taskQueue.enqueue(updatedJob, (queuedJob, queueOpts) => runJobPipeline(id, queueOpts), (updatedJob && updatedJob.priority) || 0);
    } else {
      scheduleNextStep(id, {}, 100);
    }
    return res.json({
      success: true,
      message: `Đã tiếp tục task tại bước ${resumeStep}`,
      resumed_step: resumeStep,
      job: updatedJob
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/v1/jobs/:id/rerun
 * Chạy lại / tiếp tục một job sau khi môi trường hoặc model đã hồi phục.
 * Body: { mode: 'resume' | 'restart' }
 *  - resume  (mặc định): giữ kế hoạch + evidence + ngân sách retry, chạy tiếp từ bước đang dở.
 *  - restart: xoá marker plan/implement + fix_attempt, chạy lại từ PLANNING.
 */
app.post(['/api/v1/jobs/:id/rerun', '/api/v1/tasks/:id/rerun'], async (req, res) => {
  try {
    const { id } = req.params;
    const rawMode = String((req.body && (req.body.mode || req.body.action)) || 'resume').toLowerCase();
    const mode = rawMode === 'restart' ? 'restart' : 'resume';
    const result = await resumeJobInternal(id, { mode });
    if (!result.ok) {
      return res.status(result.code || 400).json({ success: false, error: result.message, mode });
    }
    return res.json({
      success: true,
      mode,
      message: mode === 'restart'
        ? 'Đã chạy lại task từ đầu (reset ngân sách retry).'
        : `Đã tiếp tục task tại bước ${result.resumedStep}.`,
      resumed_step: result.resumedStep,
      job: result.job
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
        taskQueue.enqueue(freshJob || { id }, (queuedJob, queueOpts) => runJobPipeline(id, queueOpts), (freshJob && freshJob.priority) || 0);
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

    // Tự động phân tích dev_plan.md và chỉ tạo worktree cho các service mục tiêu
    ensureTargetServicesWorktrees(id);
    db.updateJob(id, { status: 'IMPLEMENT', current_step: 'IMPLEMENT' });
    jobEventBus.emitJobStatus(id, { status: 'IMPLEMENT' });
    jobEventBus.emitJobLog(id, { text: `\n[PLANNING-GATE] Người dùng đã DUYỆT kế hoạch (Dual Plan Approved). Chuyển sang bước IMPLEMENT...\n` });

    // Kích hoạt bước IMPLEMENT qua TaskQueue để tôn trọng Workspace Lock
    setImmediate(() => {
      if (!taskQueue.isJobEnqueuedOrRunning(id)) {
        const freshJob = db.getJobById(id) || job;
        taskQueue.enqueue(freshJob || job, (queuedJob, queueOpts) => runJobPipeline(id, queueOpts), (freshJob && freshJob.priority) || (job && job.priority) || 0);
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
 * POST /api/v1/jobs/:id/verify và POST /api/v1/tasks/:id/verify
 * Kích hoạt lại bước đối soát evidence (VERIFY) độc lập
 */
app.post(['/api/v1/jobs/:id/verify', '/api/v1/tasks/:id/verify'], (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    db.updateJob(id, { status: 'VERIFY', current_step: 'VERIFY', runner: 'verify-gate' });
    jobEventBus.emitJobStatus(id, { status: 'VERIFY', runner: 'verify-gate' });
    jobEventBus.emitJobLog(id, { text: `\n[VERIFY] Kích hoạt đối soát lại toàn bộ evidence...\n` });

    setImmediate(() => {
      executeStep(id).catch(err => {
        console.error(`[EXECUTE-STEP-ERR] Lỗi khi chạy VERIFY cho Job ${id}:`, err);
      });
    });

    return res.json({
      success: true,
      message: 'Đã kích hoạt bước đối soát evidence (VERIFY)',
      job: db.getJobById(id)
    });
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
    if (['PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'].includes((gate.finalStatus || '').toUpperCase())) {
      statusUpdates.current_step = gate.finalStatus;
    }
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
    
    // Nếu status là trạng thái cần chạy thì kiểm tra hàng đợi hoặc kích hoạt executeStep trực tiếp
    const targetStatus = (gate.finalStatus || '').toUpperCase();
    if (['PLANNING', 'IMPLEMENT', 'TESTING', 'VERIFY', 'FIXING'].includes(targetStatus)) {
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
        taskQueue.enqueue(probeJob, (queuedJob, queueOpts) => runJobPipeline(targetId, queueOpts), (probeJob && probeJob.priority) || (job && job.priority) || 0);
      } else if (taskQueue.runningJobs.has(targetId)) {
        // Job đang giữ lock chạy (runningJobs)
        const priorStatus = ((job && job.status) || '').toUpperCase();
        if (priorStatus === 'PENDING') {
          // Task đang ở PENDING (executeStep đã return chờ user): kích hoạt ngay executeStep để thực thi bước mới
          setImmediate(() => {
            executeStep(targetId).catch((err) => {
              console.error(`[EXECUTE-STEP-ERR] Lỗi khi chạy bước ${targetStatus} cho Job ${targetId}:`, err);
            });
          });
        } else if (priorStatus !== targetStatus) {
          // Task đang chạy một bước khác và user đổi bước mid-flight: kill tiến trình cũ trước khi chạy bước mới
          try {
            const { defaultProcessManager } = require('./execution/processManager');
            if (defaultProcessManager) {
              defaultProcessManager.killProcessesByJobId(targetId).catch(() => {});
            }
          } catch (e) {}
          setImmediate(() => {
            executeStep(targetId).catch((err) => {
              console.error(`[EXECUTE-STEP-ERR] Lỗi khi chuyển sang bước ${targetStatus} cho Job ${targetId}:`, err);
            });
          });
        }
      }
      // Nếu job chỉ đang nằm trong taskQueue.queue (chờ workspace lock): giữ nguyên trong hàng đợi để tôn trọng lock
    } else if (['TO DO', 'TO_DO', 'CANCELLED', 'DONE', 'FAILED'].includes(targetStatus)) {
      // Nếu chuyển về trạng thái không chạy, giải phóng job khỏi taskQueue nếu đang enqueued hoặc running
      if (taskQueue.isJobEnqueuedOrRunning(targetId)) {
        taskQueue.cancel(targetId);
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

  // Bat watcher evidence realtime neu job dang chay (dam bao SSE luon nhan
  // evidence moi du pipeline co chay executeStep hay khong).
  try {
    const jobStatus = ((job.status || '') + '').toUpperCase();
    if (!['DONE', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(jobStatus)) {
      const wsPath = job.repo_path || job.worktree_path || './';
      let wsFeaturesDir = 'docs/features';
      try {
        const ws = job.workspace_id ? db.getWorkspaceById(job.workspace_id)
          : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(wsPath)) : null);
        if (ws && ws.features_dir) wsFeaturesDir = ws.features_dir;
      } catch (e) {}
      const tCode = job.task_code || job.id;
      const fDir = fileManager.getFeatureDirectory(wsPath, tCode, wsFeaturesDir);
      const eDir = path.join(fDir, 'evidence');
      startEvidenceWatcher(id, eDir);
    }
  } catch (e) {
    console.warn('[EVIDENCE-WATCHER] Khong bat duoc watcher:', e.message);
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
  const sendEvent = (eventType, payload, eventId = null) => {
    try {
      const dataStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
      const idPrefix = (eventId !== null && eventId !== undefined) ? `id: ${eventId}\n` : '';
      res.write(`${idPrefix}event: ${eventType}\ndata: ${dataStr}\n\n`);
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

  // 1b. Gui snapshot evidence hien tai (de UI co du lieu ngay, khong phai reload).
  try {
    const wsPath0 = job.repo_path || job.worktree_path || './';
    let wsFeatDir0 = 'docs/features';
    try {
      const ws0 = job.workspace_id ? db.getWorkspaceById(job.workspace_id)
        : (db.listWorkspaces ? db.listWorkspaces().find(w => path.resolve(w.path) === path.resolve(wsPath0)) : null);
      if (ws0 && ws0.features_dir) wsFeatDir0 = ws0.features_dir;
    } catch (e) {}
    const tCode0 = job.task_code || job.id;
    const fDir0 = fileManager.getFeatureDirectory(wsPath0, tCode0, wsFeatDir0);
    const eDir0 = path.join(fDir0, 'evidence');
    for (const item of buildEvidenceSnapshot(id, eDir0)) {
      sendEvent('evidence', { type: 'evidence', jobId: id, evidence: item });
    }
  } catch (e) {
    console.warn('[EVIDENCE-SNAPSHOT] Khong gui duoc snapshot:', e.message);
  }

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

  // 2b. Gửi trạng thái SystemOne hiện tại của task (badge per-task ngay khi mở).
  const soState = parseSystemOneState(job);
  sendEvent('systemone', {
    type: 'systemone',
    jobId: id,
    live: soState ? soState.live : null,
    calls: soState ? soState.calls : 0,
    fallbacks: soState ? soState.fallbacks : 0,
    lastError: soState ? soState.lastError : null,
    model: soState ? soState.model : null,
    updatedAt: soState ? soState.updatedAt : null
  });

  // 3. Đọc log snapshot giới hạn (tail tối đa 256 KB) theo byte offset.
  // Khong doc toan bo file sync (file 25.8MB tung lam server block 178ms va client freeze).
  const logFilePath = path.join(config.LOG_DIR, `${id}.log`);
  if (fs.existsSync(logFilePath)) {
    (async () => {
      let fileHandle = null;
      try {
        const stat = await fs.promises.stat(logFilePath);
        const totalBytes = stat.size;
        if (totalBytes === 0) return;

        // Parse offset client yeu cau (query ?from= hoac header Last-Event-ID)
        const rawFrom = req.query.from !== undefined ? req.query.from : req.headers['last-event-id'];
        let clientOffset = rawFrom !== undefined ? parseInt(String(rawFrom), 10) : -1;
        // Neu clientOffset >= totalBytes -> client da o cuoi file (khong can gui lai tail snapshot)
        if (clientOffset >= totalBytes) {
          return;
        }
        if (!Number.isFinite(clientOffset) || clientOffset < 0) {
          clientOffset = -1; // mac dinh: ket noi moi chua co offset -> lay tail snapshot toi da 256KB
        }

        const MAX_TAIL_BYTES = 256 * 1024; // 256 KB
        let readStart = 0;
        let readLength = 0;
        let isTailSnapshot = false;

        if (clientOffset === -1) {
          // Client moi: chi lay 256 KB cuoi
          if (totalBytes > MAX_TAIL_BYTES) {
            readStart = totalBytes - MAX_TAIL_BYTES;
            isTailSnapshot = true;
          } else {
            readStart = 0;
          }
          readLength = totalBytes - readStart;
        } else if (clientOffset < totalBytes) {
          // Client reconnect: doc tu offset den cuoi (gioi han 256KB moi lan)
          readStart = clientOffset;
          readLength = Math.min(MAX_TAIL_BYTES, totalBytes - readStart);
        } else {
          // Client da o cuoi file -> khong can doc gi
          return;
        }

        if (readLength <= 0) return;

        fileHandle = await fs.promises.open(logFilePath, 'r');
        const buffer = Buffer.alloc(readLength);
        await fileHandle.read(buffer, 0, readLength, readStart);
        let text = buffer.toString('utf8');

        // Neu la tail snapshot giua chung, bo qua dong dau neu bi cat doi
        if (isTailSnapshot) {
          const firstNl = text.indexOf('\n');
          if (firstNl !== -1 && firstNl < 500) {
            text = text.slice(firstNl + 1);
          }
        }

        if (text) {
          const endOffset = readStart + readLength;
          sendEvent('log', {
            type: 'log',
            jobId: id,
            text,
            offset: endOffset,
            tailOnly: isTailSnapshot,
            totalBytes
          }, endOffset);
        }
      } catch (e) {
        // Bo qua loi doc log file
      } finally {
        if (fileHandle) {
          try { await fileHandle.close(); } catch (e) {}
        }
      }
    })();
  }

  // 4. Đăng ký listener vào JobEventBus
  const logListener = (data) => {
    const eventId = data && data.offset !== undefined ? data.offset : null;
    sendEvent('log', data, eventId);
  };
  const stepListener = (data) => sendEvent('step', data);
  const statusListener = (data) => sendEvent('status', data);
  const questionListener = (data) => sendEvent('question', data);
  const evidenceListener = (data) => sendEvent('evidence', data);
  const doneListener = (data) => sendEvent('done', data);
  const errorListener = (data) => sendEvent('error', data);
  const systemOneListener = (data) => sendEvent('systemone', data);

  jobEventBus.on(`job:${id}:log`, logListener);
  jobEventBus.on(`job:${id}:step`, stepListener);
  jobEventBus.on(`job:${id}:status`, statusListener);
  jobEventBus.on(`job:${id}:question`, questionListener);
  jobEventBus.on(`job:${id}:evidence`, evidenceListener);
  jobEventBus.on(`job:${id}:done`, doneListener);
  jobEventBus.on(`job:${id}:error`, errorListener);
  jobEventBus.on(`job:${id}:systemone`, systemOneListener);
  // 4b. Tick "Thoi luong" realtime: gui runtime_ms moi 5 giay cho client
  // (thoi gian worker THUC SU chay, da cong don tu cac doan `steps`).
  // Truoc day 1s => 2 query SQLite dong bo/giay cho MOI ket noi SSE, chen giua
  // write cua pipeline. 5s la du muot cho dong ho hien thi.
  const runtimeTickInterval = setInterval(() => {
    try {
      const fresh = db.getJobById(id);
      if (!fresh) return;
      if (!RUNNING_JOB_STATUSES.has((fresh.status || '').toString().trim().toUpperCase())) return;
      const freshSteps = db.getStepsByJobId(fresh.id) || [];
      sendEvent('runtime', {
        type: 'runtime',
        jobId: fresh.id,
        status: fresh.status,
        runtime_ms: computeJobRuntimeMs(fresh, freshSteps)
      });
    } catch (e) {
      // Bỏ qua lỗi tick (job có thể vừa bị xóa)
    }
  }, 5000);

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
    clearInterval(runtimeTickInterval);
    jobEventBus.removeListener(`job:${id}:log`, logListener);
    jobEventBus.removeListener(`job:${id}:step`, stepListener);
    jobEventBus.removeListener(`job:${id}:status`, statusListener);
    jobEventBus.removeListener(`job:${id}:question`, questionListener);
    jobEventBus.removeListener(`job:${id}:evidence`, evidenceListener);
    jobEventBus.removeListener(`job:${id}:done`, doneListener);
    jobEventBus.removeListener(`job:${id}:error`, errorListener);
    jobEventBus.removeListener(`job:${id}:systemone`, systemOneListener);
  });
});

/**
 * GET /api/v1/jobs/:id/logs
 * Doc lich su log phan trang theo byte offset va limit (UC-2, T1.4).
 * Query params:
 *   - offset: vi tri byte bat dau (mac dinh 0)
 *   - limit: so byte toi da doc (mac dinh 65536 = 64KB, toi da 262144 = 256KB)
 *   - direction: 'tail' (doc nguoc tu cuoi ve) | 'head' (tu dau di) - mac dinh 'head'
 */
app.get('/api/v1/jobs/:id/logs', async (req, res) => {
  try {
    const { id } = req.params;
    const job = db.getJobById(id);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job with ID '${id}' not found` });
    }
    const logFilePath = path.join(config.LOG_DIR, `${id}.log`);
    if (!fs.existsSync(logFilePath)) {
      return res.json({
        success: true,
        jobId: id,
        text: '',
        offset: 0,
        limit: 0,
        totalBytes: 0,
        hasMore: false
      });
    }

    const stat = await fs.promises.stat(logFilePath);
    const totalBytes = stat.size;
    if (totalBytes === 0) {
      return res.json({
        success: true,
        jobId: id,
        text: '',
        offset: 0,
        limit: 0,
        totalBytes: 0,
        hasMore: false
      });
    }

    const maxLimit = 256 * 1024;
    const defaultLimit = 64 * 1024;
    let limit = req.query.limit !== undefined ? parseInt(String(req.query.limit), 10) : defaultLimit;
    if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
    if (limit > maxLimit) limit = maxLimit;

    let offset = req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : 0;
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    if (offset > totalBytes) offset = totalBytes;

    const readLength = Math.min(limit, totalBytes - offset);
    if (readLength <= 0) {
      return res.json({
        success: true,
        jobId: id,
        text: '',
        offset,
        limit,
        totalBytes,
        hasMore: false
      });
    }

    const fileHandle = await fs.promises.open(logFilePath, 'r');
    try {
      const buffer = Buffer.alloc(readLength);
      await fileHandle.read(buffer, 0, readLength, offset);
      const text = buffer.toString('utf8');
      const nextOffset = offset + readLength;
      return res.json({
        success: true,
        jobId: id,
        text,
        offset,
        limit: readLength,
        nextOffset,
        totalBytes,
        hasMore: nextOffset < totalBytes
      });
    } finally {
      try { await fileHandle.close(); } catch (e) {}
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/v1/jobs/:id/logs
 * Xoa sach toan bo file log tren may chu cua 1 task (giai phong dia, tranh nang).
 */
app.delete(['/api/v1/jobs/:id/logs', '/api/v1/tasks/:id/logs'], (req, res) => {
  try {
    const { id } = req.params;
    jobEventBus._closeLogStream(id);
    const logFilePath = path.join(config.LOG_DIR, `${id}.log`);
    if (fs.existsSync(logFilePath)) {
      fs.writeFileSync(logFilePath, '', 'utf8');
    }
    return res.json({ success: true, message: 'Đã xóa toàn bộ log của task' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
/**
 * GET /api/v1/system/logs
 * Lấy log toàn hệ thống theo chunk (hỗ trợ phân trang ngược xem log cũ)
 * Query params:
 *   - limit: số dòng trong 1 chunk (mặc định 100, max 300)
 *   - endLine: dòng kết thúc (mặc định là dòng mới nhất)
 */
app.get('/api/v1/system/logs', (req, res) => {
  try {
    const limit = Math.min(Math.max(1, parseInt(req.query.limit || '100', 10)), 300);
    const endLineParam = req.query.endLine ? parseInt(req.query.endLine, 10) : null;

    const bgLogPath = path.join(config.LOG_DIR, 'server-bg.log');
    let lines = [];
    if (fs.existsSync(bgLogPath)) {
      try {
        const raw = fs.readFileSync(bgLogPath, 'utf8');
        lines = raw.split(/\r?\n/).filter(Boolean);
      } catch (e) {
        lines = [];
      }
    }

    if (lines.length === 0 && systemLogBuffer.length > 0) {
      lines = systemLogBuffer.map(e => e.text);
    }

    const totalLines = lines.length;
    if (totalLines === 0) {
      return res.json({
        success: true,
        totalLines: 0,
        startLine: 0,
        endLine: 0,
        hasMoreOlder: false,
        logs: []
      });
    }

    const targetEnd = Number.isInteger(endLineParam) && endLineParam > 0
      ? Math.min(endLineParam, totalLines)
      : totalLines;

    const targetStart = Math.max(1, targetEnd - limit + 1);
    const sliced = lines.slice(targetStart - 1, targetEnd);

    const logs = sliced.map((text, idx) => {
      const lineNum = targetStart + idx;
      const isError = text.includes('[ERROR]') || text.includes('Error:') || text.includes('FAIL') || text.includes('Unhandled');
      return {
        lineNum,
        text,
        isError
      };
    });

    return res.json({
      success: true,
      totalLines,
      startLine: targetStart,
      endLine: targetEnd,
      hasMoreOlder: targetStart > 1,
      logs
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
/**
 * GET /api/v1/system/logs/stream
 * SSE realtime stream log toàn hệ thống của Worker Server
 */
app.get('/api/v1/system/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // 1. Gửi dữ liệu ban đầu
  let initialLogs = systemLogBuffer.slice(-150);
  if (initialLogs.length < 20) {
    const bgLogPath = path.join(config.LOG_DIR, 'server-bg.log');
    if (fs.existsSync(bgLogPath)) {
      try {
        const content = fs.readFileSync(bgLogPath, 'utf8');
        const fileLines = content.split(/\r?\n/).filter(Boolean).map((l, i) => ({
          id: `init-${i}`,
          timestamp: new Date().toISOString(),
          text: l,
          isError: l.includes('[ERROR]') || l.includes('Error:')
        }));
        if (fileLines.length > 0) initialLogs = fileLines.slice(-150);
      } catch (e) {}
    }
  }

  res.write(`event: init\ndata: ${JSON.stringify({ logs: initialLogs })}\n\n`);

  // 2. Lắng nghe log mới
  const onLog = (entry) => {
    try {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    } catch (e) {}
  };

  systemLogEmitter.on('log', onLog);

  // 3. Heartbeat keepalive mỗi 15 giây
  const keepAlive = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch (e) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(keepAlive);
    systemLogEmitter.off('log', onLog);
  });
});

/**
 * DELETE /api/v1/system/logs
 * Xóa sạch buffer và làm trống log file thực sự của Worker Server trên ổ đĩa
 */
app.delete('/api/v1/system/logs', async (req, res) => {
  try {
    systemLogBuffer.length = 0;
    const bgLogPath = path.join(config.LOG_DIR, 'server-bg.log');
    const bgErrPath = path.join(config.LOG_DIR, 'server-bg-err.log');

    // Đóng write stream để giải phóng handle trên Windows
    if (systemLogFileStream) {
      try {
        systemLogFileStream.end();
        systemLogFileStream = null;
      } catch (e) {}
    }

    // Chờ 50ms để OS giải phóng file descriptor
    await new Promise((resolve) => setTimeout(resolve, 50));

    let fileCleared = false;
    if (fs.existsSync(bgLogPath)) {
      try {
        fs.truncateSync(bgLogPath, 0);
        fileCleared = true;
      } catch (e) {
        try {
          fs.writeFileSync(bgLogPath, '', 'utf8');
          fileCleared = true;
        } catch (err) {}
      }
    }

    if (fs.existsSync(bgErrPath)) {
      try { fs.truncateSync(bgErrPath, 0); } catch (e) { try { fs.writeFileSync(bgErrPath, '', 'utf8'); } catch (err) {} }
    }

    // Mở lại stream mới sẵn sàng cho các log tiếp theo
    getSystemLogStream();

    const currentSize = fs.existsSync(bgLogPath) ? fs.statSync(bgLogPath).size : 0;

    return res.json({
      success: true,
      fileCleared,
      currentSize,
      message: 'Đã xóa log thực sự từ file log trên ổ đĩa thành công (0 bytes)'
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
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
  systemLogEmitter,
  jobEventBus,
  verifyTaskEvidence,
  verifyTaskEvidenceAsync,
  resolveEvidenceType,
  normalizeEvidenceTypeHint,
  hasApiRuntimeShape,
  apiEvidenceHasRuntimeRecords,
  hasDbShape,
  evidenceChannelOf,
  startEvidenceWatcher,
  stopEvidenceWatcher,
  stopAllEvidenceWatchers,
  buildEvidenceSnapshot,
  getTaskEvidences,
  evaluateRepeatedCause,
  executeStep,
  restoreMissingJobWorktree,
  // Runtime accounting (thoi gian worker thuc su chay task) - export de test.
  computeJobRuntimeMs,
  beginStepTimeline,
  endStepTimeline,
  stepTimeline,
  // Cho phep khoi dong vong tu dong cho hoi phuc sau loi ha tang (index.js goi).
  startTransientRecoveryLoop,
  startPortWaitRecoveryLoop,
  // Vòng dọn tiến trình rác (dev server/BE bỏ hoang) - index.js gọi lúc boot.
  startProcessJanitorLoop,
  resumeJobInternal,
  pauseJobForTransient,
  // Cho test: phan loai ket qua xac minh build (NO_LISTENER vs build cu).
  verifyRuntimeProvenance
};