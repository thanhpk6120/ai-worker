/**
 * src/execution/jobPolicy.js
 * Quy tắc timeout/retry cho từng job. Tách riêng khỏi server.js để test được độc lập.
 *
 * Vấn đề gốc (task bd88ae0a-da46-4d35-af4e-49252e16dade):
 * - `pipeline_config.max_retries` khai 10 nhưng server.js đọc `config.MAX_FIXING_RETRIES` (env, = 3) => dừng ở 3/3.
 * - Timeout chỉ áp dụng PER STEP, không có tổng ngân sách cho job => 5 step x N retry x 1h.
 * - Không backoff giữa các vòng retry.
 * - 429 rate-limit của provider không được nhận ra => mỗi vòng lãng phí ~1h.
 */
'use strict';

const config = require('../config');

// Ngưỡng nhận diện rate-limit từ output của agent CLI.
const RATE_LIMIT_PATTERNS = [
  /\b429\b/,
  /rate_limit_error/i,
  /ALL_TARGETS_SKIPPED/i,
  /retry-after-ms=/i,
  /too many requests/i,
  /service temporarily unavailable/i
];

/**
 * Lấy giá trị số từ object/string, trả null nếu không hợp lệ.
 */
function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse `pipeline_config` (string JSON hoặc object) thành object.
 */
function parsePipelineConfig(job) {
  if (!job || typeof job !== 'object') return {};
  let pipe = job.pipeline_config !== undefined ? job.pipeline_config : job.pipelineConfig;
  if (typeof pipe === 'string') {
    try { pipe = JSON.parse(pipe); } catch (e) { pipe = null; }
  }
  return (pipe && typeof pipe === 'object') ? pipe : {};
}

/**
 * Số lần retry tối đa cho vòng FIXING.
 * Thứ tự ưu tiên: pipeline_config.max_retries -> maxRetries -> job.max_retries -> env -> default.
 * @returns {{ value: number, source: string }}
 */
function resolveMaxRetries(job, envValue) {
  const pipe = parsePipelineConfig(job);
  const candidates = [
    ['job', pipe.max_retries],
    ['job', pipe.maxRetries],
    ['job', pipe.max_fixing_retries],
    ['job', job && job.max_retries]
  ];
  for (const [source, raw] of candidates) {
    const n = toFiniteNumber(raw);
    if (n !== null && n > 0) return { value: Math.floor(n), source };
  }
  const envRaw = envValue !== undefined ? envValue : config.MAX_FIXING_RETRIES;
  const envNum = toFiniteNumber(envRaw);
  if (envNum !== null && envNum > 0) return { value: Math.floor(envNum), source: 'env' };
  return { value: 3, source: 'default' };
}

/**
 * Tổng ngân sách thời gian cho job (ms). `job_deadline_ms` trong pipeline_config.
 *
 * QUAN TRỌNG: nếu job KHÔNG khai => phải có default. Nếu không:
 *   max_retries=10 × step timeout 1h = tối đa ~10h cho 1 job treo.
 *   Job RSGATE-44 đã chạy 7h/8 step chỉ vì không có tổng ngân sách.
 *
 * DEFAULT suy từ STEP TIMEOUT (không cố định 4h):
 *   - 4 × stepTimeout: đủ cho 5 step + vòng retry mà không cắt ngang job hợp lệ.
 *     Job RSGATE-44: PLANNING 31m + IMPLEMENT 32m + TESTING 60m + FIXING ≈ 2-3h.
 *   - Sàn 2h (task nhanh vẫn có trần), trần 8h (job treo vẫn bị chặn).
 * Có thể ghi đè bằng `job_deadline_ms|_minutes|_hours`.
 */
const DEFAULT_DEADLINE_STEP_MULTIPLIER = 4;
const DEFAULT_DEADLINE_MIN_MS = 2 * 60 * 60 * 1000;   // 2 gio
const DEFAULT_DEADLINE_MAX_MS = 8 * 60 * 60 * 1000;   // 8 gio
// Fallback khi khong biet step timeout: 4 gio.
const DEFAULT_JOB_DEADLINE_MS = 4 * 60 * 60 * 1000;
function resolveJobDeadlineMs(job, stepTimeoutMs) {
  const pipe = parsePipelineConfig(job);
  const direct = toFiniteNumber(pipe.job_deadline_ms !== undefined ? pipe.job_deadline_ms : pipe.jobDeadlineMs);
  if (direct !== null && direct > 0) return direct;
  const minutes = toFiniteNumber(pipe.job_deadline_minutes !== undefined ? pipe.job_deadline_minutes : pipe.jobDeadlineMinutes);
  if (minutes !== null && minutes > 0) return minutes * 60 * 1000;
  const hours = toFiniteNumber(pipe.job_deadline_hours !== undefined ? pipe.job_deadline_hours : pipe.jobDeadlineHours);
  if (hours !== null && hours > 0) return hours * 60 * 60 * 1000;
  // Default suy tu step timeout.
  const step = toFiniteNumber(stepTimeoutMs);
  if (step !== null && step > 0) {
    const derived = step * DEFAULT_DEADLINE_STEP_MULTIPLIER;
    return Math.min(Math.max(derived, DEFAULT_DEADLINE_MIN_MS), DEFAULT_DEADLINE_MAX_MS);
  }
  return DEFAULT_JOB_DEADLINE_MS;
}

/**
 * Mốc thời gian hết hạn tuyệt đối của job.
 *
 * PHẢI là mốc TUYỆT ĐỐI, không tính lại mỗi lần chuyển step:
 * executeStep() chạy lại ở MỌI lần đổi trạng thái, nên nếu base = now
 * thì deadline trượt mãi ⇒ tổng ngân sách thời gian của job vô hiệu.
 *
 * Cơ chế: lần đầu tính rồi ghi `pipeline_config.deadline_at` (epoch ms).
 * Các lần sau đọc lại giá trị đã lưu ⇒ deadline cố định suốt vòng đời job.
 *
 * @returns {{ deadlineAt: number|null, isNew: boolean }}
 */
function resolveDeadlineAt(job, now, stepTimeoutMs) {
  const pipe = parsePipelineConfig(job);
  const stored = toFiniteNumber(pipe.deadline_at !== undefined ? pipe.deadline_at : pipe.deadlineAt);
  if (stored !== null && stored > 0) {
    return { deadlineAt: stored, isNew: false };
  }
  const deadlineMs = resolveJobDeadlineMs(job, stepTimeoutMs);
  if (!deadlineMs) return { deadlineAt: null, isNew: false };
  const t = now || Date.now();
  return { deadlineAt: t + deadlineMs, isNew: true };
}

/**
 * Tạm DỪNG deadline khi job chờ user (PENDING).
 *
 * Deadline là để chặn job TREO, không phải để phạt user ngủ. Job RSGATE-44
 * chờ duyệt kế hoạch qua đêm => resume là dính [DEADLINE] => TIMED_OUT dù
 * job không hề treo. Ghi `pending_started_at` để biết đã chờ bao lâu.
 *
 * @param {object} job
 * @returns {object} pipeline_config mới
 */
function pauseDeadlineForPending(job) {
  const pipe = parsePipelineConfig(job);
  const stored = toFiniteNumber(pipe.deadline_at !== undefined ? pipe.deadline_at : pipe.deadlineAt);
  if (stored === null || stored <= 0) return pipe;
  pipe.pending_started_at = Date.now();
  return pipe;
}

/**
 * TIẾP TỤC deadline sau khi job thoát trạng thái PENDING.
 * Cộng thêm đúng khoảng thời gian đã chờ user vào deadline_at.
 *
 * @param {object} job
 * @returns {object} pipeline_config mới
 */
function resumeDeadlineAfterPending(job) {
  const pipe = parsePipelineConfig(job);
  const pendingAt = toFiniteNumber(pipe.pending_started_at);
  if (pendingAt === null || pendingAt <= 0) return pipe;
  delete pipe.pending_started_at;
  const stored = toFiniteNumber(pipe.deadline_at !== undefined ? pipe.deadline_at : pipe.deadlineAt);
  if (stored !== null && stored > 0) {
    const waited = Math.max(0, Date.now() - pendingAt);
    pipe.deadline_at = stored + waited;
  }
  return pipe;
}

/**
 * Timeout hiệu dụng cho 1 lần gọi agent = min(stepTimeout, thời gian còn lại của job).
 * @returns {{ timeoutMs: number, expired: boolean, remainingMs: number|null }}
 */
function resolveEffectiveTimeout({ stepTimeoutMs, deadlineAt, now }) {
  const t = now || Date.now();
  const step = toFiniteNumber(stepTimeoutMs);
  const base = (step !== null && step > 0) ? step : config.DEFAULT_TIMEOUT_MS;
  if (!deadlineAt) return { timeoutMs: base, expired: false, remainingMs: null };
  const remaining = deadlineAt - t;
  if (remaining <= 0) return { timeoutMs: 0, expired: true, remainingMs: 0 };
  return { timeoutMs: Math.min(base, remaining), expired: false, remainingMs: remaining };
}

/**
 * Backoff giữa các vòng retry. attempt bắt đầu từ 1 (vòng đầu không chờ).
 */
function resolveRetryBackoffMs(attempt, options) {
  const base = (options && options.baseMs) || 5000;
  const cap = (options && options.capMs) || 60000;
  const n = toFiniteNumber(attempt);
  if (n === null || n <= 1) return 0;
  // attempt=2 => 5s, attempt=3 => 10s, attempt=4 => 20s ... (cap 60s)
  const delay = base * Math.pow(2, Math.floor(n) - 2);
  return Math.min(delay, cap);
}

/**
 * Phát hiện output của agent CLI bị provider rate-limit.
 * @param {string} output
 * @returns {{ limited: boolean, retryAfterMs: number|null }}
 */
function detectRateLimit(output) {
  const text = typeof output === 'string' ? output : '';
  if (!text) return { limited: false, retryAfterMs: null };
  const hit = RATE_LIMIT_PATTERNS.some((re) => re.test(text));
  if (!hit) return { limited: false, retryAfterMs: null };
  const m = text.match(/retry-after-ms=(\d+)/i);
  return {
    limited: true,
    retryAfterMs: m ? Number(m[1]) : null
  };
}

/**
 * Gom output của agent CLI để quét rate-limit.
 * `runner.execute()` trả `{ stdout, stderr, exitCode, timedOut }` — KHÔNG có
 * field `output`. Log 429 của CLI nằm trong stderr nên phải gom cả hai.
 * @param {Object|string} result
 * @returns {string}
 */
function collectAgentOutput(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const parts = [];
  for (const key of ['stdout', 'stderr', 'output']) {
    const v = result[key];
    if (typeof v === 'string' && v) parts.push(v);
  }
  return parts.join('\n');
}

/**
 * Timeout toi da cho 1 step cua job o CHE DO NHANH (quick track).
 *
 * LY DO: muc tieu worker la thay the prompt tung buoc va uu tien TOI UU TOC DO.
 * Task nhe (S/quick) khong nen chay 15-60 phut/step - VERIFY se kiem tra lai
 * sau, nen cap thoi gian o day la an toan.
 *
 * Uu tien: pipeline_config.quick_timeout_ms -> cap mac dinh (5 phut).
 * QUAN TRONG: quick cap KHONG BAO GIO lon hon `fallbackMs` (timeout hien co) -
 * cap chi duoc cat ngan hon, khong bao gio ngan loi them.
 * @param {object} job
 * @param {number} fallbackMs Timeout step hien tai
 * @returns {number} timeout ms (luon > 0)
 */
const QUICK_STEP_DEFAULT_MS = 5 * 60 * 1000; // 5 phut
const QUICK_STEP_MIN_MS = 60 * 1000; // 1 phut - san chan duoi cho cap nhanh
function resolveQuickStepTimeoutMs(job, fallbackMs) {
  let pipe = null;
  try { pipe = parsePipelineConfig(job); } catch (e) { pipe = null; }
  let declared = null;
  if (pipe && typeof pipe === 'object') {
    const raw = toFiniteNumber(pipe.quick_timeout_ms);
    if (raw !== null && raw > 0) declared = raw;
  }
  let cap = declared !== null ? declared : QUICK_STEP_DEFAULT_MS;
  // fallbackMs hop le => quick cap KHONG duoc lon hon timeout hien co.
  const fb = toFiniteNumber(fallbackMs);
  if (fb !== null && fb > 0) cap = Math.min(cap, fb);
  if (!Number.isFinite(cap) || cap <= 0) cap = QUICK_STEP_DEFAULT_MS;
  return cap;
}

// --- So trung nguyen nhan loi (chong lap lai cung 1 loi) ------------------

// Chuan hoa 1 mo ta loi thanh "chu ky" de so sanh giua cac vong retry.
// Bo cac phan thay doi theo lan chay (so, duong dan, timestamp, hex id)
// de 2 lan fail KHAC NHAU van cung chu ky khi thuc chat la cung 1 nguyen nhan.
const _NOISE_PATTERNS = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gi, '<ts>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  [/\b\d+(?:\.\d+)?\s*ms\b/gi, '<ms>'],
  [/\bexit code\s+-?\d+\b/gi, 'exit code <n>'],
  [/\b(?:line|column|at)\s+\d+(?::\d+)?/gi, 'at <n>'],
  [/\b[0-9a-f]{32,}\b/gi, '<hash>'],
  [/[A-Za-z]:\\[^\s'"]+/g, '<path>'],
  [/\/(?:[\w.-]+\/)+[\w.-]+/g, '<path>'],
  [/\b\d+\b/g, '<n>']
];

/**
 * Tao chu ky chuan hoa cho 1 mo ta loi.
 * @param {string} reason
 * @returns {string} chu ky rong neu khong co noi dung
 */
function buildFailureSignature(reason) {
  let text = typeof reason === 'string' ? reason : (reason == null ? '' : String(reason));
  text = text.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return '';
  for (const [re, rep] of _NOISE_PATTERNS) text = text.replace(re, rep);
  // Cat con 400 ky tu dau - loi thuong nam o dau (stack trace / message).
  // 400 x 50 muc = 20KB, pipeline_config (JSON string trong DB) van re.
  return text.slice(0, 400).trim();
}

/**
 * Lay lich su chu ky loi da ghi nhan cho 1 job.
 * Luu trong `pipeline_config.failure_history` (object) de khong can migration DB.
 * @param {object} job
 * @returns {Array<{step: string, signature: string, at: string, attempt: number}>}
 */
function getFailureHistory(job) {
  let pipe = {};
  try { pipe = parsePipelineConfig(job); } catch (e) { pipe = {}; }
  const h = pipe && pipe.failure_history;
  return Array.isArray(h) ? h.filter((x) => x && typeof x === 'object' && x.signature) : [];
}

/**
 * Kiem tra 1 chu ky loi da xuat hien trong lich su cua job chua.
 * @param {object} job
 * @param {string} signature
 * @param {string} step
 * @returns {{ repeated: boolean, previous: object|null, occurrences: number }}
 */
function findRepeatedFailure(job, signature, step) {
  const history = getFailureHistory(job);
  if (!signature) return { repeated: false, previous: null, occurrences: 0 };
  const same = history.filter((h) => h.signature === signature && (!step || h.step === step));
  return { repeated: same.length > 0, previous: same.length ? same[same.length - 1] : null, occurrences: same.length };
}

/**
 * Ghi them 1 chu ky loi vao lich su cua job.
 * @param {object} job
 * @param {string} signature
 * @param {string} step
 * @param {number} attempt
 * @returns {object} pipeline_config moi (de ghi vao DB)
 */
function appendFailureHistory(job, signature, step, attempt) {
  const pipe = parsePipelineConfig(job);
  const history = getFailureHistory(job);
  history.push({ step: step || null, signature, at: new Date().toISOString(), attempt: Number(attempt) || 0 });
  // Gioi han 50 muc - chi can so voi cac vong gan nhat.
  pipe.failure_history = history.slice(-50);
  return pipe;
}

/**
 * Xoa lich su loi (dung khi job bat dau lai / clone).
 * @param {object} pipe
 * @returns {object} pipeline_config moi
 */
function clearFailureHistory(pipe) {
  const next = { ...(pipe && typeof pipe === 'object' ? pipe : {}) };
  delete next.failure_history;
  return next;
}


module.exports = {
  parsePipelineConfig,
  resolveMaxRetries,
  resolveJobDeadlineMs,
  resolveDeadlineAt,
  resolveEffectiveTimeout,
  resolveRetryBackoffMs,
  resolveQuickStepTimeoutMs,
  detectRateLimit,
  buildFailureSignature,
  getFailureHistory,
  findRepeatedFailure,
  appendFailureHistory,
  clearFailureHistory,
  pauseDeadlineForPending,
  resumeDeadlineAfterPending,
  collectAgentOutput,
  QUICK_STEP_DEFAULT_MS,
  QUICK_STEP_MIN_MS,
  DEFAULT_JOB_DEADLINE_MS,
  RATE_LIMIT_PATTERNS
};
