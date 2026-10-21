/**
 * src/systemone/policy.js
 * Heuristic offline thuần local cho 6 UC SYSTEMONE-01.
 * Không mạng, <50ms, không đọc file ngoài payload, confidence <= 0.4.
 */
'use strict';

const crypto = require('node:crypto');

const LOW_CONF = 0.3;

function sha16(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

function norm(s) {
  return String(s || '').slice(0, 2000);
}

// Bo dau + lowercase: de regex so sanh duoc ca text co dau va khong dau
// (user hay go tieng Viet khong dau khi paste tu nguon ngoai).
function fold(s) {
  return norm(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function routerHeuristic({ preferredName = 'claude-code' } = {}) {
  return { runner: preferredName, confidence: LOW_CONF, reason: 'fallback', cached: false, fallback: true, source: 'heuristic' };
}

// Regex phan loai nhanh (tức thì, 0 network call).
// `quick` = prompt ngan + khong phai bug/sua -> task de -> plan rut gon.
// `large` = migrate/refactor/monorepo hoac prompt rat dai -> task phuc tap.
// Regex phan loai nhanh (tuc thi, 0 network call).
// THU TU QUAN TRONG: `large` check TRUOC `quick` - truoc day "migrate ..." bi
// phan loai nhầm thanh quick vi len ngan (<200) va khong chua fix|bug|error.
function triageSignals({ prompt = '' } = {}) {
  const p = fold(prompt);
  const raw = norm(prompt);
  // Dau hieu task KHONG nho: doc truy xuat ticket/story, nhieu tai lieu,
  // nhieu module. Job RSGATE-44 ("doc task jira ..., truy xuat task/story lon,
  // tai lieu conf ... trien khai") bi model phan loai S/quick => chet 3 lan.
  const heavySignal = /jira|confluence|story|task lon|tai lieu conf|repository|monorepo/.test(p)
    && /truy xuat|phan tich|trien khai|implement|lam|doc /.test(p);
  const large = /migrate|refactor|multi-module|microservice|monorepo/.test(p) || raw.length > 4000 || heavySignal;
  const quick = /^(kiem tra|xac minh|test|check|ping|khao sat)\s/.test(p) || (raw.length < 200 && !/fix|bug|error|sua|loi/.test(p));
  const needBrowser = /browser|screenshot|giao dien|\bui\b/.test(p);
  return { quick: !large && quick, large, needBrowser, heavySignal };
}

function triageHeuristic({ prompt = '' } = {}) {
  const sig = triageSignals({ prompt });
  if (sig.large) return { complexity: 'L', track: 'full', needBrowser: sig.needBrowser, confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
  if (sig.quick) return { complexity: 'S', track: 'quick', needBrowser: sig.needBrowser, confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
  return { complexity: 'M', track: 'full', needBrowser: sig.needBrowser, confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
}

function fixGateHeuristic({ attempt = 0, maxRetries = 3 } = {}) {
  return {
    retry: Number(attempt) < Number(maxRetries),
    p_success: LOW_CONF,
    fixScope: 'scoped',
    confidence: LOW_CONF,
    cached: false,
    // Heuristic offline KHONG phai model that. Khong duoc dung p_success gia de
    // quyet dinh dung retry (da gay job bd88ae0a that bai o attempt 3/3).
    fallback: true,
    source: 'heuristic'
  };
}

/**
 * Heuristic offline cho "nguyen nhan loi co trung voi lan truoc khong?".
 * Khong co model => chi dua tren CHU KY loi (signature) da chuan hoa.
 * Chu ky giong het => chay lai cung ket qua => dung vong lap.
 * @param {object} args
 * @returns {{repeated: boolean, will_repeat: boolean, confidence: number, reason: string, cached: boolean, fallback: boolean}}
 */
function repeatedCauseHeuristic({ history = [], signature = '' } = {}) {
  const list = Array.isArray(history) ? history.filter((h) => h && h.signature) : [];
  if (list.length === 0 || !signature) {
    return { repeated: false, will_repeat: false, confidence: LOW_CONF, reason: 'chua co loi truoc de so sanh', cached: false, fallback: true, source: 'heuristic' };
  }
  // Chu ky loi hien tai co giong het mot lan truoc nao khong?
  const same = list.filter((h) => h.signature === signature);
  const repeated = same.length > 0;
  const prev = same.length ? same[same.length - 1] : null;
  return {
    repeated,
    will_repeat: repeated,
    confidence: repeated ? 0.9 : 0.3,
    reason: repeated
      ? `nguyen nhan giong hop ${same.length} lan truoc (vong ${prev && prev.attempt}, step ${prev && prev.step})`
      : 'nguyen nhan khac cac lan truoc',
    cached: false,
    fallback: true,
    source: 'heuristic'
  };
}


function preJudgeHeuristic() {
  return { pass: false, failedFields: ['ui', 'api', 'log', 'db'], confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
}

function guardHeuristic() {
  // fail-closed an toàn: scrub rồi spawn
  return { hasSecret: false, hasInjection: false, action: 'scrub', confidence: LOW_CONF, cached: false, fallback: true, source: 'heuristic' };
}

function dedupHeuristic({ taskCode = '', prompt = '' } = {}) {
  const bucketId = sha16(`${String(taskCode).trim().toLowerCase()}\n${norm(prompt).trim().toLowerCase()}`);
  return { bucketId, confidence: LOW_CONF, cached: false, isDuplicate: false, isNoise: false, fallback: true, source: 'heuristic' };
}

module.exports = {
  LOW_CONF,
  sha16,
  routerHeuristic,
  triageHeuristic,
  triageSignals,
  fold,
  fixGateHeuristic,
  preJudgeHeuristic,
  guardHeuristic,
  repeatedCauseHeuristic,
  dedupHeuristic
};
