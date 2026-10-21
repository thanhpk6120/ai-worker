/**
 * src/execution/stepGate.js
 * Quyet dinh buoc nao duoc BO QUA dua tren trang thai THAT cua feature dir.
 *
 * NGUYEN TAC (user chot 2026-10-22):
 * 1) PLANNING chi lam viec PLANNING, xong PHAI chuyen qua buoc khac.
 *    Ke hoach da duoc verify o luot truoc (marker `.plan_ok.json`) => bo qua
 *    agent PLANNING, chuyen thang sang IMPLEMENT.
 * 2) IMPLEMENT phai xac dinh code da duoc implement chua. Ket luan do
 *    PLANNING ghi vao dev_plan.md (dong marker `IMPLEMENT_STATUS:`) - PLANNING
 *    da verify plan voi code that nen day la nguon su that, khong do bang.
 * 3) TESTING va cac buoc sau LUON PHAI CHAY LAI. Bai chung cu phai reset ve
 *    NOT VERIFY truoc khi chay - khong duoc dua vao ket qua cu.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PLAN_OK_MARKER = '.plan_ok.json';
// Dong marker trong dev_plan.md: `<!-- IMPLEMENT_STATUS: DONE -->` hoac `NEEDED`
const IMPLEMENT_STATUS_RE = /<!--\s*IMPLEMENT_STATUS\s*:\s*(DONE|NEEDED)\s*-->/i;

/**
 * Ghi marker "ke hoach da duoc verify va con hieu luc".
 * @param {string} featureDir
 * @param {object} extra
 */
function writePlanOkMarker(featureDir, extra = {}) {
  try {
    if (!featureDir) return false;
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, PLAN_OK_MARKER), JSON.stringify({
      at: new Date().toISOString(),
      ...extra
    }, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Doc marker ke hoach hop le.
 * @param {string} featureDir
 * @returns {object|null}
 */
function readPlanOkMarker(featureDir) {
  try {
    if (!featureDir) return null;
    const p = path.join(featureDir, PLAN_OK_MARKER);
    if (!fs.existsSync(p)) return null;
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch (e) {
    return null;
  }
}

/**
 * Xoa marker (plan bi sua => phai verify lai).
 * @param {string} featureDir
 */
function clearPlanOkMarker(featureDir) {
  try {
    if (!featureDir) return false;
    const p = path.join(featureDir, PLAN_OK_MARKER);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Doc trang thai implement da ghi trong dev_plan.md.
 * @param {string} devPlanText
 * @returns {'DONE'|'NEEDED'|null} null = chua co ket luan (phai chay IMPLEMENT)
 */
function readImplementStatus(devPlanText) {
  const m = String(devPlanText || '').match(IMPLEMENT_STATUS_RE);
  if (!m) return null;
  return m[1].toUpperCase() === 'DONE' ? 'DONE' : 'NEEDED';
}

/**
 * Ghi trang thai implement vao dev_plan.md (noi luon 1 dong marker).
 * @param {string} devPlanText
 * @param {'DONE'|'NEEDED'} status
 * @returns {string} dev_plan moi
 */
function writeImplementStatus(devPlanText, status) {
  const text = String(devPlanText || '');
  const marker = `<!-- IMPLEMENT_STATUS: ${status} -->`;
  if (IMPLEMENT_STATUS_RE.test(text)) {
    return text.replace(IMPLEMENT_STATUS_RE, marker);
  }
  // Chen ngay sau tieu de dau tien (neu co) hoac dau file.
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => /^#\s+\S/.test(l));
  const at = idx >= 0 ? idx + 1 : 0;
  lines.splice(at, 0, marker, '');
  return lines.join('\n');
}

module.exports = {
  PLAN_OK_MARKER,
  IMPLEMENT_STATUS_RE,
  writePlanOkMarker,
  readPlanOkMarker,
  clearPlanOkMarker,
  readImplementStatus,
  writeImplementStatus
};
