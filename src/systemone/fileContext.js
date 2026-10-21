/**
 * fileContext.js - Gom noi dung file de dua vao `state` cua SystemOne typed-decision.
 *
 * VI SAO: endpoint /v1/systemone CHI doc `state` (string) + `questions`.
 * Cac field khac (files/file/content/attachments) bi gateway bo qua - probe 2026-10-21:
 * `input_tokens` khong doi (286 vs 286) khi them cac field do.
 * => Muon model "doc file", phai truyen noi dung file qua chinh `state`.
 *
 * HAN CHE CONTEXT (quan trong):
 * - Model chiu toi da ~180k input tokens; tren do gateway tra 400 max_tokens_exceeded.
 * - FileContext nen giu `state` o duoi ~60k tokens de con duyet cho cau hoi + output.
 * - nen cat theo TUNG file (khong cat giua 1 file) va bao cao file bi cat.
 *
 * Dung cho: FIXING (checkFixGate) - model can thay file nao bi sai gi de quyet dinh retry.
 */
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');

// 1 token ~ 4 ky tu (tieng Anh + code). dung he so nay de uoc luong nhanh.
// Calibrate: 240KB state -> usage.input_tokens ~41k => ~5.8 ky tu/token (nhung code ASCII
// thi ~4). Dung 4 de uoc luong thi trong (an toan).
const CHARS_PER_TOKEN = 4;
// Ngan sach mac dinh cho `state` (tokens). 60k => ~240KB, an toan duoi 180k.
const DEFAULT_MAX_STATE_TOKENS = 60000;
// Chi doc file text. File binary/nhanh khong duoc gui (base64 lam no context vo va loi).
const TEXT_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.mdx', '.txt', '.log',
  '.yml', '.yaml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.sql', '.sh', '.bat',
  '.py', '.java', '.kt', '.go', '.rs', '.rb', '.php', '.cs', '.c', '.h', '.cpp', '.hpp',
  '.vue', '.svelte', '.gradle', '.properties', '.env.example', '.gitignore', '.dockerignore'
]);
// File thuoc ve build/dep - bo qua (khong can model xem, rat lon).
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'target', 'coverage', '.next', 'out', 'vendor', '__pycache__', '.venv', 'venv']);

/**
 * @param {string} filePath
 * @returns {boolean} true neu nen doc noi dung file nay
 */
function isReadableTextFile(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (!ext) {
    // File khong extension: chi doc neu ten la README/LICENSE/CHANGELOG...
    return /(readme|license|changelog|makefile|dockerfile)$/i.test(path.basename(String(filePath || '')));
  }
  if (!TEXT_EXT.has(ext)) return false;
  let st = null;
  try { st = fs.statSync(filePath); } catch (e) { return false; }
  return st.isFile();
}

/**
 * Doc MOT PHAN noi dung file (khong nap ca file vao RAM).
 * File lon (log, dump) co the hang tram MB - nap toan bo se block event loop
 * va ngam RAM. Dung fd + Buffer.alloc de chi doc phan can.
 *
 * @param {string} filePath
 * @param {number} maxChars So ky tu toi da can
 * @returns {Promise<{content: string, truncated: boolean, bytes: number}|null>}
 */
async function readFileWithin(filePath, maxChars) {
  let st = null;
  try { st = await fsp.stat(filePath); } catch (e) { return null; }
  if (!st.isFile()) return null;

  // Doc toi da maxChars ky tu (nhin chung 1 byte/ky tu cho ASCII; dung 4x cho UTF-8 da byte).
  const wantBytes = Math.max(1024, maxChars * 4);
  let handle = null;
  let buf = null;
  try {
    handle = await fsp.open(filePath, 'r');
    buf = Buffer.alloc(Math.min(wantBytes, st.size));
    if (buf.length > 0) await handle.read(buf, 0, buf.length, 0);
  } catch (e) {
    return null;
  } finally {
    if (handle) { try { await handle.close(); } catch (e) {} }
  }
  if (!buf) return null;

  let raw = buf.toString('utf8');
  // BOM -> bo ky tu dieu khong mang thong tin.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const bytes = st.size;
  if (raw.length <= maxChars && bytes <= buf.length) return { content: raw, truncated: false, bytes };

  // Cat theo dong de noi dung con doc duoc (khong cat giua 1 dong).
  const cut = raw.slice(0, maxChars);
  const lastNl = cut.lastIndexOf('\n');
  const body = lastNl > maxChars * 0.5 ? cut.slice(0, lastNl) : cut;
  return { content: `${body}\n... [TRUNCATED]`, truncated: true, bytes };
}

/**
 * Kiem tra duong dan nam trong workspace (chong doc file ngoài workspace).
 * Dung path.relative: startsWith() sai vi `C:\a\ws` la prefix cua `C:\a\ws-evil`.
 *
 * @param {string} absPath
 * @param {string} wsAbs
 * @returns {boolean}
 */
function isInsideWorkspace(absPath, wsAbs) {
  const rel = path.relative(wsAbs, absPath);
  if (!rel) return false;              // chinh workspace (khong phai file)
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

/**
 * Gom noi dung nhieu file vao mot chuoi co gioi han tokens.
 * File duoc xu ly theo thu tu truyen vao (uoc luong do lon nguoc).
 *
 * @param {string[]} filePaths Danh sach file (duong dan tuyet doi hoac relative to workspace)
 * @param {object} opts
 * @param {string} [opts.workspacePath] Goc de resolve duong dan relative
 * @param {number} [opts.maxStateTokens] Ngan sach token cho state (mac dinh 60000)
 * @returns {Promise<{text: string, files: string[], truncatedFiles: string[], tokens: number, skipped: string[]}>}
 */
async function collectFileContext(filePaths, { workspacePath = '.', maxStateTokens = DEFAULT_MAX_STATE_TOKENS } = {}) {
  const list = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
  const budgetChars = Math.max(0, Math.floor(maxStateTokens * CHARS_PER_TOKEN));
  const wsAbs = path.resolve(workspacePath || '.');
  const parts = [];
  const included = [];
  const truncatedFiles = [];
  const skipped = [];
  let used = 0;

  for (const raw of list) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(wsAbs, raw);
    // Bao ve: chi doc file nam trong workspace.
    if (!isInsideWorkspace(abs, wsAbs)) { skipped.push(raw); continue; }
    // Bo qua file trong thu muc build/dep.
    const rel = path.relative(wsAbs, abs);
    if (rel.split(path.sep).some((seg) => SKIP_DIR.has(seg))) { skipped.push(raw); continue; }
    if (!isReadableTextFile(abs)) { skipped.push(raw); continue; }

    const remain = budgetChars - used;
    if (remain <= 200) { skipped.push(raw); continue; }

    const res = await readFileWithin(abs, remain);
    if (!res) { skipped.push(raw); continue; }

    // Normalize separator ve '/' cho nhat quan giua Windows/POSIX.
    const relLabel = rel.split(path.sep).join('/');
    parts.push(`--- FILE: ${relLabel} ---\n${res.content}`);
    included.push(relLabel);
    used += res.content.length + relLabel.length + 32;
    if (res.truncated) truncatedFiles.push(relLabel);
  }

  return {
    text: parts.join('\n\n'),
    files: included,
    truncatedFiles,
    tokens: Math.ceil(used / CHARS_PER_TOKEN),
    skipped
  };
}

/**
 * Ghep noi dung file vao `state` theo mau: <prefix> + <file context>.
 * @param {string} state State goc
 * @param {string} fileText Noi dung file da gom
 * @param {number} maxStateTokens
 * @returns {string}
 */
function mergeStateWithFiles(state, fileText, maxStateTokens = DEFAULT_MAX_STATE_TOKENS) {
  const budgetChars = Math.max(0, Math.floor(maxStateTokens * CHARS_PER_TOKEN));
  const base = String(state || '');
  const room = budgetChars - base.length;
  // State goc da vuot budget => cat no lai (neu cat duoi thi con dung file).
  if (room <= 0) return base.slice(0, budgetChars);
  const filePart = String(fileText || '').slice(0, room);
  return filePart ? `${base}\n\n${filePart}` : base;
}

/**
 * Chay lenh git, tra ve stdout (string) hoac null neu loi.
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function runGit(args, cwd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || '')));
  });
}

/**
 * Lay danh sach file da thay doi trong workspace.
 * - Dung `git status --porcelain` de gom ca file UNTRACKED (file agent TAO MOI o
 *   buoc IMPLEMENT) - `git diff` chi thay file da track.
 * - Uu tien file co ten xuat hien trong stack trace (failures.error) truoc.
 * - Con lai sap xep theo mtime giam dan (file vua sua truoc).
 *
 * @param {string} workspacePath
 * @param {string[]} fallbackFiles
 * @param {number} maxFiles
 * @param {string} errorHint Noi dung loi (stack trace) de uu tien file lien quan
 * @returns {Promise<string[]>}
 */
async function listChangedFiles(workspacePath = '.', fallbackFiles = [], maxFiles = 8, errorHint = '') {
  const ws = path.resolve(workspacePath || '.');
  const files = [];
  const seen = new Set();

  // 1) File da track thay doi (git diff HEAD).
  const diff = await runGit(['diff', '--name-only', 'HEAD'], ws);
  if (diff) {
    for (const f of diff.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (!seen.has(f)) { seen.add(f); files.push(f); }
    }
  }
  // 2) File UNTRACKED (file agent tao moi) - `git diff` KHONG thay duoc.
  const status = await runGit(['status', '--porcelain'], ws);
  if (status) {
    for (const line of status.split(/\r?\n/)) {
      if (!line) continue;
      // Format porcelain: XY <path>  (XY = trang thai, 2 ky tu)
      const p = line.slice(3).trim();
      if (!p || p.includes(' -> ')) {
        // Rename: "old -> new" -> lay phan moi.
        const arrow = p.split(' -> ').pop();
        if (arrow && !seen.has(arrow)) { seen.add(arrow); files.push(arrow); }
        continue;
      }
      if (!seen.has(p)) { seen.add(p); files.push(p); }
    }
  }

  if (!files.length) return (Array.isArray(fallbackFiles) ? fallbackFiles : []).slice(0, maxFiles);

  // 3) Uu tien file co xuat hien trong stack trace / error.
  const hint = String(errorHint || '');
  const base = (f) => path.basename(f).toLowerCase();
  const prioritized = files.slice().sort((a, b) => {
    const aHit = hint && hint.toLowerCase().includes(base(a)) ? 0 : 1;
    const bHit = hint && hint.toLowerCase().includes(base(b)) ? 0 : 1;
    if (aHit !== bHit) return aHit - bHit;
    return 0; // giu thu tu git (da la thu tu alphabet) khi khong co uu tien
  });

  // 4) Con lai sap xep theo mtime giam dan (file vua sua truoc).
  const withMtime = await Promise.all(prioritized.map(async (f) => {
    let mtime = 0;
    try { mtime = (await fsp.stat(path.resolve(ws, f))).mtimeMs; } catch (e) {}
    return { f, mtime };
  }));
  withMtime.sort((a, b) => {
    const aHit = hint && hint.toLowerCase().includes(base(a.f)) ? 0 : 1;
    const bHit = hint && hint.toLowerCase().includes(base(b.f)) ? 0 : 1;
    if (aHit !== bHit) return aHit - bHit;
    return b.mtime - a.mtime;
  });

  return withMtime.map((x) => x.f).slice(0, maxFiles);
}

module.exports = {
  collectFileContext,
  mergeStateWithFiles,
  listChangedFiles,
  isReadableTextFile,
  isInsideWorkspace,
  CHARS_PER_TOKEN,
  DEFAULT_MAX_STATE_TOKENS
};
