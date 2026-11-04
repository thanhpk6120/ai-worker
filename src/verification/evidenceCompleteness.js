/**
 * Luật hoàn tất bằng chứng (evidence completeness).
 *
 * Ba lỗ hổng từ PHUB-678 — job DONE dù việc thật chưa xong:
 *  (a) metadata.json khai `pendingItems` ở trạng thái PENDING nhưng gate không đọc
 *      => job vẫn DONE. Ở PHUB-678 là migration Oracle chưa chạy.
 *  (b) test_plan.md nhắc DDL/migration cho CSDL nhưng không có bằng chứng kênh DB
 *      nào => không ai kiểm tra schema thật.
 *  (c) test bị @Disabled/Skipped vẫn được tính là đạt vì dòng "Skipped: 3" không
 *      bị soi theo nghĩa "3 test không chạy".
 *
 * Nguyên tắc: mỗi hạng mục mở phải ĐÓNG được bằng chứng thật, HOẶC được miễn trừ
 * tường minh (NOT_APPLICABLE / ACCEPTED_RISK + lý do). Miễn trừ vẫn phải hiện ra
 * trong báo cáo, không được im lặng.
 */

'use strict';

const TERMINAL_PENDING_STATUS_RE = /^(DONE|PASSED|PASS|COMPLETED|COMPLETE|RESOLVED|CLOSED|NOT_APPLICABLE|NOT APPLICABLE|N\/A|NA|ACCEPTED_RISK|ACCEPTED|WAIVED)$/i;
const WAIVER_STATUS_RE = /^(NOT_APPLICABLE|NOT APPLICABLE|N\/A|NA|ACCEPTED_RISK|ACCEPTED|WAIVED)$/i;
const MIN_REASON_LEN = 10;

// Dấu hiệu kế hoạch kiểm thử có hạng mục CSDL cần chứng minh bằng bằng chứng thật.
const DDL_HINT_RE = /(\bddl\b|\bmigration\b|\bmigrate\b|alter\s+table|create\s+table|\bflyway\b|\bliquibase\b|schema\s+(change|migration|update)|cập nhật\s+schema|chạy\s+script\s+sql)/i;
// Tên file bằng chứng thuộc kênh DB.
const DB_EVIDENCE_NAME_RE = /(database|db[_-]?(assert|assertion|verify|verification|check|result)|reconciliation|schema[_-]?(verify|check|assert)|migration[_-]?(verify|result)|sql[_-]?(verify|result))/i;
// Key chứng minh nội dung bằng chứng là truy vấn CSDL thật.
const DB_CONTENT_KEY_RE = /"(sql|query|statement|rowCount|rows|resultRows|columns|tableName|table_name)"\s*:/i;
// Dòng tổng kết test của Maven/Gradle có số test bị bỏ qua.
const SKIPPED_SUMMARY_RE = /Tests run:\s*(\d+)\s*,\s*Failures:\s*(\d+)\s*,\s*Errors:\s*(\d+)\s*,\s*Skipped:\s*(\d+)/i;
const SKIPPED_GENERIC_RE = /\bskipped\s*[:=]\s*(\d+)/i;
const DISABLED_MARK_RE = /@Disabled\b|@Ignore\b|\bdisabledTests?\b/i;

const str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** Rút gọn một mục pending thành một dòng dễ đọc trong log. */
function describePendingItem(item) {
  if (!item) return '(rỗng)';
  const id = str(item.id || item.key);
  const text = str(item.item || item.title || item.description || item.name) || '(không mô tả)';
  const status = str(item.status || item.state || item.verdict) || 'KHÔNG RÕ';
  return `${id ? id + ': ' : ''}${text} [${status}]`.slice(0, 200);
}

/**
 * Đọc `metadata.json.pendingItems` và phân loại ĐÓNG / CÒN MỞ.
 * Một mục chỉ được coi là đóng khi:
 *  - status là DONE/PASSED/COMPLETED/RESOLVED/CLOSED, hoặc
 *  - status là miễn trừ (NOT_APPLICABLE/ACCEPTED_RISK/...) VÀ có lý do >= 10 ký tự.
 */
function analyzePendingItems(metadataObj) {
  const list = (metadataObj && !Array.isArray(metadataObj) && Array.isArray(metadataObj.pendingItems))
    ? metadataObj.pendingItems
    : [];
  const unresolved = [];
  const resolved = [];
  const waivers = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const status = str(raw.status || raw.state || raw.verdict);
    if (!status) {
      unresolved.push({ item: raw, why: 'thiếu trường status' });
      continue;
    }
    if (!TERMINAL_PENDING_STATUS_RE.test(status)) {
      unresolved.push({ item: raw, why: `status "${status}" chưa phải trạng thái đóng` });
      continue;
    }
    if (WAIVER_STATUS_RE.test(status)) {
      const reason = str(raw.reason || raw.note || raw.justification || raw.evidence || raw.why);
      if (reason.length < MIN_REASON_LEN) {
        unresolved.push({ item: raw, why: `miễn trừ "${status}" nhưng thiếu lý do cụ thể` });
        continue;
      }
      waivers.push(raw);
    }
    resolved.push(raw);
  }
  return { total: list.filter((x) => x && typeof x === 'object').length, unresolved, resolved, waivers };
}

/** Kế hoạch kiểm thử / báo cáo có nhắc hạng mục DDL, migration, schema không. */
function textsMentionDdl(texts) {
  for (const t of (Array.isArray(texts) ? texts : [texts])) {
    if (typeof t === 'string' && DDL_HINT_RE.test(t)) return true;
  }
  return false;
}

/**
 * Có bằng chứng kênh DB thật không.
 * Chấp nhận theo TÊN file (db_assert*, reconciliation*, schema_verify*...)
 * hoặc theo NỘI DUNG json (có sql/query/rowCount/columns...).
 */
function hasDbEvidence(fileNames, readFile) {
  const names = Array.isArray(fileNames) ? fileNames : [];
  for (const name of names) {
    const base = String(name).split(/[\\/]/).pop() || '';
    if (!DB_EVIDENCE_NAME_RE.test(base)) continue;
    if (!/\.json$/i.test(base)) {
      if (/\.log$|\.txt$/i.test(base)) continue;
      return base;
    }
    let content = '';
    try { content = typeof readFile === 'function' ? (readFile(name) || '') : ''; } catch (e) { content = ''; }
    if (!content || DB_CONTENT_KEY_RE.test(content)) return base;
  }
  return null;
}

/**
 * Quét nội dung log để tìm test bị bỏ qua và tính là "đạt" một cách vô hình.
 * Trả về mảng {file, skipped, line}.
 */
function findSkippedTests(logEntries) {
  const hits = [];
  for (const entry of (Array.isArray(logEntries) ? logEntries : [])) {
    const file = entry && entry.name ? String(entry.name) : '(unknown)';
    const content = entry && typeof entry.content === 'string' ? entry.content : '';
    if (!content) continue;
    let matched = false;
    const m = content.match(SKIPPED_SUMMARY_RE);
    if (m && Number(m[4]) > 0) {
      hits.push({ file, skipped: Number(m[4]), line: m[0] });
      matched = true;
    }
    if (!matched) {
      const g = content.match(SKIPPED_GENERIC_RE);
      if (g && Number(g[1]) > 0) {
        hits.push({ file, skipped: Number(g[1]), line: g[0] });
        matched = true;
      }
    }
    if (!matched && DISABLED_MARK_RE.test(content)) {
      hits.push({ file, skipped: 0, line: '@Disabled/@Ignore xuất hiện trong log' });
    }
  }
  return hits;
}

/**
 * Đánh giá tổng hợp. Trả về danh sách VI PHẠM để tầng trên chuyển FIXING kèm lý do.
 *
 * @param {object} p
 * @param {object} p.metadataObj metadata.json đã parse
 * @param {string[]} p.validEvidenceFiles file evidence hợp lệ (không gồm metadata.json)
 * @param {Array<{name:string,content:string}>} p.logEntries log/txt để soi skipped
 * @param {string[]} p.planTexts nội dung test_plan.md + báo cáo để dò DDL
 * @param {Function} [p.readEvidenceFile] hàm đọc file evidence theo tên
 * @returns {{violations: string[], warnings: string[], dbEvidence: string|null}}
 */
function evaluateEvidenceCompleteness({
  metadataObj,
  validEvidenceFiles,
  logEntries,
  planTexts,
  readEvidenceFile
} = {}) {
  const violations = [];
  const warnings = [];

  // (a) pendingItems còn mở.
  const pending = analyzePendingItems(metadataObj);
  const waiverText = pending.waivers
    .map((w) => `${str(w.id)} ${str(w.item || w.title || w.description)} ${str(w.reason)}`)
    .join(' ');
  for (const u of pending.unresolved) {
    violations.push(
      `metadata.json còn hạng mục CHƯA ĐÓNG (pendingItems): ${describePendingItem(u.item)} — ${u.why}. ` +
      'Phải hoàn tất bằng chứng thật, hoặc đổi status sang NOT_APPLICABLE/ACCEPTED_RISK kèm lý do cụ thể.'
    );
  }

  // (b) Kế hoạch nhắc DDL nhưng không có bằng chứng kênh DB.
  const dbEvidence = hasDbEvidence(validEvidenceFiles, readEvidenceFile);
  const ddlRequired = textsMentionDdl(planTexts);
  if (ddlRequired && !dbEvidence) {
    const waivedByPending = DDL_HINT_RE.test(waiverText);
    if (waivedByPending) {
      warnings.push(
        'Kế hoạch có hạng mục DDL/migration và KHÔNG có bằng chứng kênh DB, ' +
        'nhưng đã có miễn trừ tường minh trong pendingItems — ghi rõ trong report, không tính là đạt.'
      );
    } else {
      violations.push(
        'Kế hoạch kiểm thử có hạng mục DDL/migration/schema cho CSDL nhưng evidence KHÔNG có ' +
        'bằng chứng kênh DB (file db_assert*/reconciliation*/schema_verify* chứa sql, query, rowCount, columns...). ' +
        'Unit test trên CSDL in-memory không chứng minh schema thật. ' +
        'Phải bổ sung bằng chứng DB thật, hoặc khai pendingItems status NOT_APPLICABLE/ACCEPTED_RISK kèm lý do.'
      );
    }
  }

  // (c) Test bị bỏ qua không được tính là đạt.
  const skippedHits = findSkippedTests(logEntries);
  for (const hit of skippedHits) {
    const detail = hit.skipped > 0 ? `${hit.skipped} test bị skipped` : 'có test bị @Disabled/@Ignore';
    const waived = /(skipped|disabled|bỏ qua|tắt)/i.test(waiverText);
    if (waived) {
      warnings.push(`${hit.file}: ${detail} (${hit.line}) — đã có miễn trừ trong pendingItems.`);
    } else {
      violations.push(
        `${hit.file} ghi nhận ${detail} ("${hit.line}"). Test không chạy KHÔNG phải bằng chứng đạt. ` +
        'Bỏ @Disabled/@Ignore và chạy thật, hoặc khai pendingItems NOT_APPLICABLE/ACCEPTED_RISK kèm lý do.'
      );
    }
  }

  return { violations, warnings, dbEvidence, ddlRequired };
}

module.exports = {
  TERMINAL_PENDING_STATUS_RE,
  WAIVER_STATUS_RE,
  DDL_HINT_RE,
  DB_EVIDENCE_NAME_RE,
  analyzePendingItems,
  textsMentionDdl,
  hasDbEvidence,
  findSkippedTests,
  evaluateEvidenceCompleteness,
  describePendingItem
};
