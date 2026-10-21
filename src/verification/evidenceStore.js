/**
 * src/verification/evidenceStore.js
 * Nguồn chân lý của evidence: thư mục `docs/features/<TASK>/evidence/` + `metadata.json`.
 *
 * Vòng đời trạng thái (yêu cầu TASK-PIPELINE-FIX):
 *   NOT VERIFY (mới sinh) -> PASS (verify thành công) | FAILED (verify lỗi)
 *
 * ⚠ QUAN TRỌNG — metadata.json có 3 shape đang cùng tồn tại, KHÔNG được ép về 1 format:
 *   1. ARRAY              : [{ fileName, stepName, ... }]              (browserRunner ghi)
 *   2. OBJECT MAP        : { "file.png": { ... } }                     (handleUpdateEvidenceStatus ghi)
 *   3. OBJECT CÓ tests[] : { taskCode, verdict, tests: [ {...} ] }      (CLI agent ghi)
 * Shape 3 chứa `tests[]` — đây là dữ liệu verifyTaskEvidence đọc để quyết định gate.
 * Ghi đè metadata.json mà không giữ shape gốc sẽ XOÁ tests[] và làm mọi job fail verify.
 *
 * Vì vậy: đọc/ghi LUÔN giữ nguyên shape hiện có, chỉ bổ sung field per-file.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATUS = {
  NOT_VERIFY: 'NOT VERIFY',
  PASS: 'PASS',
  FAILED: 'FAILED'
};

const SHAPE = {
  ARRAY: 'array',
  MAP: 'map',
  TESTS: 'tests',
  EMPTY: 'empty'
};

// Chi khop key co extension file that. Dung de phan biet key "a.png" (evidence)
// voi key metadata goc nhu "taskCode"/"verdict"/"notes" (string/array).
const EVIDENCE_FILE_RE = /\.(png|jpe?g|webp|gif|svg|bmp|log|txt|json|sql|db|sqlite|csv|xml|html|pdf|har)$/i;

/**
 * Chuẩn hóa mọi biến thể trạng thái về 3 giá trị chuẩn.
 * LƯU Ý: giá trị trung gian là 'NOT VERIFY' (không phải 'NOT VERIFIED') —
 * regex chống báo cáo lừng dối trong verifyTaskEvidence là /not\s*verified/i,
 * nên 'NOT VERIFY' không bị trigger. Đổi sang 'NOT VERIFIED' sẽ làm fail mọi job.
 */
function normalizeStatus(raw) {
  if (raw === undefined || raw === null) return STATUS.NOT_VERIFY;
  const v = String(raw).trim().toUpperCase();
  if (!v) return STATUS.NOT_VERIFY;
  if (v === 'PASS' || v === 'PASSED' || v === 'OK' || v === 'SUCCESS' || v === 'VERIFIED') return STATUS.PASS;
  if (v === 'FAIL' || v === 'FAILED' || v === 'ERROR' || v === 'REJECTED') return STATUS.FAILED;
  // 'CAPTURED', 'PENDING', 'NOT VERIFY', ... => chưa verify
  return STATUS.NOT_VERIFY;
}

function verdictOf(status) {
  if (status === STATUS.PASS) return 'PASS';
  if (status === STATUS.FAILED) return 'FAIL';
  return null;
}
/**
 * Evidence chỉ được coi là PASS/FAILED khi HỆ THỐNG (bước VERIFY) đã xác nhận.
 * Agent tự ghi `status` trong metadata.json => KHÔNG được tin.
 * Dấu hiệu xác nhận: field `verified === true` (chỉ writeMetadata/system ghi).
 */
const isVerified = (rec) => !!(rec && rec.verified === true);

/**
 * Đưa về NOT VERIFY + verdict null mọi trạng thái chưa được hệ thống xác nhận.
 */
function suppressUnverified(rec) {
  if (!rec || rec.verified === true) return rec;
  if (rec.status === STATUS.NOT_VERIFY) {
    rec.verified = false;
    return rec;
  }
  rec.status = STATUS.NOT_VERIFY;
  rec.verdict = null;
  rec.verified = false;
  return rec;
}

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : (v != null && typeof v !== 'object' ? String(v) : null));

/**
 * Chuẩn hóa 1 record per-file.
 */
function normalizeRecord(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const status = normalizeStatus(r.status !== undefined ? r.status : r.verdict);
  return {
    ...r,
    evidenceId: str(r.evidenceId) || str(r.evidence_id) || str(r.id) || null,
    fileName: str(r.fileName) || str(r.file_name) || str(r.filename) || null,
    name: str(r.name) || str(r.title) || null,
    description: str(r.description) || str(r.desc) || str(r.caption) || null,
    passCriteria: str(r.passCriteria) || str(r.pass_criteria) || str(r.criteria) || str(r.expected) || null,
    stepId: str(r.stepId) || str(r.step_id) || null,
    stepName: str(r.stepName) || str(r.step_name) || (typeof r.step === 'string' ? r.step : null) || null,
    stepIndex: num(r.stepIndex !== undefined ? r.stepIndex : r.step_index),
    order: num(r.order !== undefined ? r.order : r.sequence),
    timestamp: str(r.timestamp) || str(r.capturedAt) || str(r.captured_at) || str(r.created_at) || null,
    status,
    verdict: verdictOf(status),
    verified: isVerified(r),
    type: str(r.type) || str(r.evidence_type) || null,
    channel: str(r.channel) || null,
    testCase: str(r.testCase) || str(r.testcase) || (typeof r.case === 'string' ? r.case : null) || null,
    currentUrl: str(r.currentUrl) || str(r.current_url) || str(r.pageUrl) || null
  };
}

/**
 * Đọc metadata.json RAW + nhận diện shape.
 * @returns {{ shape: string, raw: any, records: Array<Object> }}
 */
function readMetadata(evidenceDir) {
  const metadataPath = path.join(evidenceDir, 'metadata.json');
  const empty = { shape: SHAPE.EMPTY, raw: null, records: [] };
  if (!evidenceDir || !fs.existsSync(metadataPath)) return empty;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch (e) {
    return empty;
  }
  if (parsed === null || parsed === undefined) return empty;

  // Shape 1: ARRAY
  if (Array.isArray(parsed)) {
    const records = [];
    for (const item of parsed) {
      const rec = suppressUnverified(normalizeRecord(item));
      // server.js getEvidenceFileMeta tìm theo fileName | name | file | file_path.
      // Phải tạo record cho mọi biến thể đó, nếu không server.js rơi về
      // metadata RAW và đọc thẳng status do agent tự khai (bypass NOT VERIFY).
      // Chỉ nhận tên có đuôi file thật, tránh biến tiêu đề (vd name:
      // "Man hinh danh sach") thành record ma (gây đếm FAILED sai).
      if (!rec.fileName) {
        const alt = str(item && (item.file || item.name)) || null;
        if (alt && EVIDENCE_FILE_RE.test(alt)) rec.fileName = alt;
        else {
          const fp = str(item && (item.filePath || item.file_path)) || null;
          const base = fp ? path.basename(String(fp).replace(/\\/g, '/')) : null;
          if (base && EVIDENCE_FILE_RE.test(base)) rec.fileName = base;
        }
      }
      if (rec.fileName) records.push(rec);
    }
    return { shape: SHAPE.ARRAY, raw: parsed, records };
  }

  if (typeof parsed === 'object') {
    // Shape 3: OBJECT có tests[] — ưu tiên nhận diện TRƯỚC shape map
    if (Array.isArray(parsed.tests)) {
      const records = [];
      for (const t of parsed.tests) {
        if (!t || typeof t !== 'object') continue;
        const testStatus = normalizeStatus(t.status !== undefined ? t.status : t.verdict);
        const testName = str(t.name) || str(t.caseName) || str(t.testCase) || str(t.id) || null;
        const files = Array.isArray(t.evidence) ? t.evidence
          : (Array.isArray(t.evidences) ? t.evidences
            : (Array.isArray(t.files) ? t.files : []));
        for (const f of files) {
          const fileName = str(f);
          if (!fileName) continue;
          // Agent có thể ghi đường dẫn đầy đủ -> lấy basename cho khớp tên file
          // trên đĩa (server.js so khớp theo tên file).
          const baseName = path.basename(String(fileName).replace(/\\/g, '/'));
          records.push(suppressUnverified(normalizeRecord({
            fileName: baseName,
            name: testName,
            description: str(t.description) || str(t.note) || str(t.summary) || null,
            passCriteria: str(t.passCriteria) || str(t.expected) || str(t.criteria) || null,
            testCase: testName,
            stepName: str(t.stepName) || str(t.step) || null,
            stepIndex: num(t.stepIndex !== undefined ? t.stepIndex : t.step_index),
            order: num(t.order !== undefined ? t.order : t.sequence),
            timestamp: str(t.timestamp) || str(t.capturedAt) || null,
            // Khong mac dinh 'UI_SCREENSHOT': file .xlsx/.csv/.pdf... khong phai anh,
            // gan sai se render <img> -> "Anh chua san sang". De server suy ra theo
            // extension (resolveEvidenceType) khi metadata khong khai type.
            type: str(t.type) || str(t.evidence_type) || null,
            channel: str(t.channel) || null,
            currentUrl: str(t.currentUrl) || str(t.url) || null,
            status: testStatus
          })));
        }
      }
      // File nào có trong evidenceStatus mà ĐÃ ĐƯỢC hệ thống xác nhận (verified === true)
      // thì ưu tiên trạng thái đó. Mục evidenceStatus do agent tự viết (không có cờ
      // verified) KHÔNG được tin -> giữ NOT VERIFY cho tới khi VERIFY chạy.
      const statusMap = (parsed.evidenceStatus && typeof parsed.evidenceStatus === 'object') ? parsed.evidenceStatus : {};
      for (const rec of records) {
        const key = String(rec.fileName || '').toLowerCase();
        const over = statusMap[rec.fileName] || statusMap[key];
        if (!over || typeof over !== 'object' || over.verified !== true) continue;
        const s = normalizeStatus(over.status);
        rec.status = s;
        rec.verdict = verdictOf(s);
        rec.verified = true;
      }
      // Key top-level là TÊN FILE THẬT (vd "01_ui_list.png": {...}) -> cũng là evidence
      // agent tự khai, phải có record để server đọc đúng (mặc định NOT VERIFY).
      for (const [key, val] of Object.entries(parsed)) {
        if (key === 'tests' || key === 'records' || key === 'evidenceStatus') continue;
        if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
        if (!EVIDENCE_FILE_RE.test(key)) continue;
        if (records.some((r) => String(r.fileName || '').toLowerCase() === key.toLowerCase())) continue;
        const rec = suppressUnverified(normalizeRecord(val));
        if (!rec.fileName) rec.fileName = key;
        if (!rec.name) rec.name = str(val && val.name) || null;
        records.push(rec);
      }
      return { shape: SHAPE.TESTS, raw: parsed, records };
    }

    // Shape 1b: OBJECT có records[]
    if (Array.isArray(parsed.records)) {
      const records = [];
      for (const item of parsed.records) {
        const rec = suppressUnverified(normalizeRecord(item));
        if (!rec.fileName) {
          const alt = str(item && (item.file || item.name)) || null;
          if (alt && EVIDENCE_FILE_RE.test(alt)) rec.fileName = alt;
          else {
            const fp = str(item && (item.filePath || item.file_path)) || null;
            const base = fp ? path.basename(String(fp).replace(/\\/g, '/')) : null;
            if (base && EVIDENCE_FILE_RE.test(base)) rec.fileName = base;
          }
        }
        if (rec.fileName) records.push(rec);
      }
      return { shape: SHAPE.ARRAY, raw: parsed, records };
    }

    // Shape 2: OBJECT MAP { "file.png": {...} }
    // CHỈ nhận key là TÊN FILE THẬT (có extension). Key metadata gốc
    // (taskCode, verdict, notes, hasVisualDefects, consoleErrors...) là string/array
    // => bỏ qua. Nếu không, chúng thành record giả và khi ghi lại sẽ
    // GHI ĐÈ field gốc bằng object => đổi hành vi gate.
    const records = [];
    for (const [key, val] of Object.entries(parsed)) {
      if (key === 'records' || key === 'evidenceStatus') continue;
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue;
      if (!EVIDENCE_FILE_RE.test(key)) continue;
      const rec = suppressUnverified(normalizeRecord(val));
      if (!rec.fileName) rec.fileName = key;
      if (!rec.name) rec.name = str(val && val.name) || null;
      records.push(rec);
    }
    return { shape: SHAPE.MAP, raw: parsed, records };
  }

  return empty;
}

/**
 * Ghi metadata.json, GIỮ NGUYÊN shape hiện có.
 * @param {string} evidenceDir
 * @param {string} shape
 * @param {any} raw - object đã mutate sẵn (được ghi nguyên trạng)
 * @param {Array<Object>} records - records chuẩn hóa tương ứng shape
 */
function writeMetadata(evidenceDir, shape, raw, records) {
  const metadataPath = path.join(evidenceDir, 'metadata.json');
  let payload = raw;
  // Ghi metadata.json là hành động của hệ thống (VERIFY / API) => mọi record có
  // trạng thái thật đều được đánh dấu đã xác minh. Record agent tự khai đã bị đưa
  // về NOT VERIFY lúc đọc nên không bị đánh dấu nhầm.
  for (const rec of records || []) {
    if (rec && rec.status !== STATUS.NOT_VERIFY && rec.verified !== true) rec.verified = true;
  }
  if (shape === SHAPE.ARRAY) {
    payload = records;
  } else if (shape === SHAPE.MAP) {
    // Giữ NGUYÊN các key gốc (taskCode, verdict, notes...) chỉ cập nhật
    // entry của file evidence. Xoá key gốc sẽ mất metadata do agent ghi.
    payload = { ...(raw && typeof raw === 'object' ? raw : {}) };
    for (const rec of records) {
      if (!rec.fileName) continue;
      payload[rec.fileName] = rec;
    }
  } else if (shape === SHAPE.TESTS) {
    // Giữ nguyên tests[] + mọi field khác; chỉ ghi đè evidenceStatus.
    payload = { ...(raw && typeof raw === 'object' ? raw : {}) };
    const statusMap = { ...(payload.evidenceStatus && typeof payload.evidenceStatus === 'object' ? payload.evidenceStatus : {}) };
    for (const rec of records) {
      if (!rec.fileName) continue;
      const key = String(rec.fileName);
      if (rec.status !== STATUS.NOT_VERIFY) statusMap[key] = { status: rec.status, verdict: rec.verdict, verified: true };
    }
    payload.evidenceStatus = statusMap;
  } else {
    payload = records;
  }
  try {
    fs.writeFileSync(metadataPath, JSON.stringify(payload, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Ghi trạng thái cho nhiều file, giữ nguyên shape.
 * @param {string} evidenceDir
 * @param {Object<string,string>} statusMap - { fileName: 'PASS'|'FAILED'|'NOT VERIFY' }
 * @returns {boolean}
 */
function setStatuses(evidenceDir, statusMap) {
  if (!evidenceDir || !statusMap || typeof statusMap !== 'object') return false;
  const { shape, raw, records } = readMetadata(evidenceDir);
  const byFile = new Map();
  for (const rec of records) byFile.set(String(rec.fileName || '').toLowerCase(), rec);

  let changed = false;
  for (const [fileName, status] of Object.entries(statusMap)) {
    const s = normalizeStatus(status);
    const key = String(fileName).toLowerCase();
    if (byFile.has(key)) {
      const rec = byFile.get(key);
      rec.status = s;
      rec.verdict = verdictOf(s);
      changed = true;
    } else {
      // File có thật trên đĩa nhưng chưa có trong metadata -> thêm record mới
      const rec = normalizeRecord({ fileName, status: s, timestamp: new Date().toISOString() });
      records.push(rec);
      byFile.set(key, rec);
      changed = true;
    }
  }
  if (!changed) return false;
  return writeMetadata(evidenceDir, shape, raw, records);
}

/**
 * Cập nhật trạng thái của 1 file evidence.
 */
function updateStatus(evidenceDir, fileName, status, extra) {
  if (extra && typeof extra === 'object') {
    const { shape, raw, records } = readMetadata(evidenceDir);
    const key = String(fileName).toLowerCase();
    const rec = records.find((r) => String(r.fileName || '').toLowerCase() === key);
    if (rec) Object.assign(rec, extra);
    return writeMetadata(evidenceDir, shape, raw, records);
  }
  return setStatuses(evidenceDir, { [fileName]: status });
}

/**
 * Sắp xếp evidence theo thứ tự step test:
 *   order -> stepIndex -> timestamp -> tên file
 */
function sortRecords(records) {
  return records.slice().sort((a, b) => {
    const ao = a.order, bo = b.order;
    if (ao !== null && bo !== null && ao !== bo) return ao - bo;
    if (ao !== null && bo === null) return -1;
    if (ao === null && bo !== null) return 1;
    const as = a.stepIndex, bs = b.stepIndex;
    if (as !== null && bs !== null && as !== bs) return as - bs;
    if (as !== null && bs === null) return -1;
    if (as === null && bs !== null) return 1;
    const at = Date.parse(a.timestamp || '') || 0;
    const bt = Date.parse(b.timestamp || '') || 0;
    if (at !== bt) return at - bt;
    return String(a.fileName || '').localeCompare(String(b.fileName || ''));
  });
}

/**
 * Tìm record của 1 file (không phân biệt hoa thường).
 */
function findByFileName(records, fileName) {
  if (!fileName) return null;
  const target = String(fileName).trim().toLowerCase();
  return records.find((r) => String(r.fileName || '').trim().toLowerCase() === target) || null;
}

/**
 * Gom metadata + file thực tế thành danh sách evidence hoàn chỉnh, đã sort.
 * @param {string} evidenceDir
 * @param {Function} classify - hàm phân loại type cho file (tùy chọn)
 */
function listEvidence(evidenceDir, classify) {
  if (!evidenceDir || !fs.existsSync(evidenceDir)) return [];
  const { records } = readMetadata(evidenceDir);
  const byFile = new Map();
  for (const rec of records) byFile.set(String(rec.fileName || '').toLowerCase(), rec);

  const items = [];
  let files = [];
  try { files = fs.readdirSync(evidenceDir); } catch (e) { return []; }
  for (const file of files) {
    if (file === 'metadata.json' || file.startsWith('.')) continue;
    const fullPath = path.join(evidenceDir, file);
    let stat;
    try { stat = fs.statSync(fullPath); } catch (e) { continue; }
    if (!stat.isFile()) continue;
    const rec = byFile.get(file.toLowerCase()) || normalizeRecord({ fileName: file });
    const ext = path.extname(file).toLowerCase();
    const type = (typeof classify === 'function') ? classify({ filename: file, ext, meta: rec }) : (rec.type || 'UI_SCREENSHOT');
    items.push({
      ...rec,
      fileName: file,
      ext,
      type,
      evidence_type: rec.type || type,
      channel: rec.channel || null,
      status: normalizeStatus(rec.status),
      verdict: verdictOf(rec.status),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  return sortRecords(items);
}

module.exports = {
  STATUS,
  SHAPE,
  normalizeStatus,
  normalizeRecord,
  verdictOf,
  readMetadata,
  writeMetadata,
  setStatuses,
  updateStatus,
  sortRecords,
  findByFileName,
  listEvidence
};
