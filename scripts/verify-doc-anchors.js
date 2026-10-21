#!/usr/bin/env node
/**
 * scripts/verify-doc-anchors.js
 * Kiem tra tham chieu "file:line" trong thu muc docs/features co con dung
 * voi ma nguon hien tai hay khong.
 *
 * Cach kiem tra:
 *   1. Moi tham chieu deu ton tai (file co that, dong trong pham vi file).
 *   2. Moi tham chieu deu "co chu de": dinh danh (ten ham/const) viet trong
 *      backtick o CUNG segment cua tham chieu do phai xuat hien trong
 *      khoang dong duoc trich.
 *
 * "Segment" = phan dong doc tach ra boi cac dau tach: "->", ";", ",".
 * Vi du:
 *   `src/server.js:2562` `buildPrompt(step:planning)`
 *     -> `src/server.js:2586` `runnerRegistry.getAvailableRunner(planningAgent)`
 * tach thanh 2 segment, moi segment doi chieu 1 tham chieu + 1 dinh danh.
 *
 * Mien kiem tra (SKIP_DIRS):
 *   - docs/features/TASK-PIPELINE-FIX/ : TAI LIEU LICH SU. Cac tham chieu
 *     tro toi code TRUOC khi commit 85cb540 sua loi - la bang chung bug tai
 *     thoi diem lap ke hoach, khong phai tham chieu stale. KHONG sua so dong
 *     o day: doi lai se lam cau sai nghia lich su.
 *
 * Usage:
 *   node scripts/verify-doc-anchors.js                      # kiem tra tat ca docs/features
 *   node scripts/verify-doc-anchors.js docs/features/X.md   # kiem tra 1 file
 *
 * Exit code: 0 = tat ca OK, 1 = co loi.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOCS = path.join(ROOT, 'docs', 'features');

// Thu muc MIEN kiem tra (xem header). Tai lieu lich su, khong phai tham chieu stale.
const SKIP_DIRS = new Set(['TASK-PIPELINE-FIX']);

const FILE_PATH_RE = /(?:src|tests|public|scripts|docs|templates)\/[\w/.-]+\.(?:js|html|css|md|json)/g;
// Tham chieu dang viet tat ":123" - chi chap nhan khi ky tu truoc khong phai
// chu/số (tranh bat "timeoutMs:900000").
const SHORT_REF_RE = /(?<![A-Za-z0-9_]):(\d+)(?:-(\d+))?/g;
// Dinh danh trong backtick: co the kem doi so "buildPrompt(step:planning)".
const IDENT_RE = /`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?(?:\([^`]*\))?)`/g;
// Dau tach segment.
const SEG_SPLIT_RE = /(?:→|->|;|,)/;

/** Lay phan danh danh (bo phan doi so) cua mot chuoi backtick. */
function identifierOf(raw) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)/.exec(raw);
  return m ? m[1] : null;
}

/** Co phai la dinh danh (ten ham/const) hay chu thuong? */
// Token khong phai dinh danh trong ma nguon (HTTP method, global cua Node,
// tu khoa JS) -> khong doi chieu, vi khong xuat hien trong file nao.
const NON_CODE_TOKENS = new Set([
  'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS',
  'fetch', 'AbortController', 'AbortSignal', 'URL', 'URLSearchParams',
  'JSON', 'Math', 'Date', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'console', 'process', 'Buffer', 'Error', 'TypeError', 'RegExp', 'Proxy',
  'Symbol', 'Reflect', 'BigInt', 'Intl', 'Array', 'Object', 'String', 'Number', 'Boolean',
]);

function isIdentifier(tok) {
  if (NON_CODE_TOKENS.has(tok)) return false;
  const t = tok.split('.').pop();
  if (t.includes('_')) return true; // snake_case
  if (/[a-z][A-Z]/.test(t)) return true; // camelCase
  return t.length > 1 && t[1] === t[1].toUpperCase(); // PascalCase
}

/** Ten viet HOA (FIXING, FAILED...) - so sanh khong phan biet hoa/thuong. */
function isAllCaps(tok) {
  return tok === tok.toUpperCase() && /[A-Z]/.test(tok);
}

/** Identifier co khop noi dung trong khoang dong trich? */
function matchesInRange(identifier, rangeText) {
  if (rangeText.includes(identifier)) return true;
  if (isAllCaps(identifier)) {
    return rangeText.toLowerCase().includes(identifier.toLowerCase());
  }
  // "A.b" -> cho phep khop theo tung phan ("b" hoac "A.b" deu duoc).
  const parts = identifier.split('.');
  if (parts.length > 1 && rangeText.includes(parts[parts.length - 1])) return true;
  return false;
}

function readLines(absPath) {
  return fs.readFileSync(absPath, 'utf8').split('\n');
}

/**
 * Tra ve danh sach loi cho 1 file doc.
 * @returns {Array<{docLine:number, file:string, from:number, to:number, identifier:string, reason:string}>}
 */
function checkDoc(absDocPath) {
  const doc = fs.readFileSync(absDocPath, 'utf8');
  const docLines = doc.split('\n');
  const errors = [];

  docLines.forEach((line, idx) => {
    if (line.trim() === '') return;

    // Tach dong thanh segment, giu nguyen chi so de dua ve dong goc.
    const segs = [];
    let start = 0;
    const splitter = new RegExp(SEG_SPLIT_RE.source, 'g');
    let m;
    while ((m = splitter.exec(line)) !== null) {
      segs.push({ text: line.slice(start, m.index), offset: start });
      start = m.index + m[0].length;
    }
    segs.push({ text: line.slice(start), offset: start });

    // File "hien tai" cho dang viet tat ":123" (cung file voi ref truoc do).
    let lastFile = null;
    for (const seg of segs) {
      const segFile = /((?:src|tests|public|scripts|docs|templates)\/[\w/.-]+\.(?:js|html|css|md|json))/.exec(seg.text);
      if (segFile) lastFile = segFile[1];

      // Moi segment: tim moi tham chieu (file + dong) va dinh danh.
      let ref = null;
      const fp = /((?:src|tests|public|scripts|docs|templates)\/[\w/.-]+\.(?:js|html|css|md|json)):(\d+)(?:-(\d+))?/.exec(seg.text);
      if (fp) {
        ref = { file: fp[1], from: Number(fp[2]), to: fp[3] ? Number(fp[3]) : Number(fp[2]), start: fp.index, end: fp.index + fp[0].length };
      } else {
        const sp = /(?<![A-Za-z0-9_]):(\d+)(?:-(\d+))?/.exec(seg.text);
        if (sp && lastFile) {
          ref = { file: lastFile, from: Number(sp[1]), to: sp[2] ? Number(sp[2]) : Number(sp[1]), start: sp.index, end: sp.index + sp[0].length };
        }
      }
      if (!ref) continue;

      // Dinh danh trong segment: chi lay identifier NAM SAU tham chieu.
      // (Identifier o truoc tham chieu thuoc ve claim truoc do, khong phai claim nay.)
      let identifier = null;
      for (const im of seg.text.matchAll(IDENT_RE)) {
        if (im.index < ref.start) continue;
        const cand = identifierOf(im[1]);
        if (cand && isIdentifier(cand)) { identifier = cand; break; }
      }
      // Kiem tra file + pham vi dong TRUOC: ref hong (file khong ton tai, dong
      // ngoai pham vi) la loi doc lap, khong phu thuoc co identifier hay khong.
      const absTarget = path.join(ROOT, ref.file);
      if (!fs.existsSync(absTarget)) {
        errors.push({
          docLine: idx + 1, file: ref.file, from: ref.from, to: ref.to, identifier,
          reason: 'FILE KHONG TON TAI',
        });
        continue;
      }

      const target = readLines(absTarget);
      if (ref.from > target.length) {
        errors.push({
          docLine: idx + 1, file: ref.file, from: ref.from, to: ref.to, identifier,
          reason: `DONG NGOAI PHAM VI (file chi co ${target.length} dong)`,
        });
        continue;
      }

      if (!identifier) continue; // tham chieu hop le nhung khong co "chu de" de doi chieu

      // Con tro dang viet tat: "tai `:1257`" -> dung dong do de doi chieu,
      // vi du "... 4 kenh tai `:1257`" tro toi Promise.allSettled.
      const ptrMatch = /`?:(\d+)(?:-(\d+))?`?/.exec(seg.text.slice(ref.end));
      const ptrLine = ptrMatch ? Number(ptrMatch[1]) : null;

      const rangeText = target.slice(ref.from - 1, ref.to).join('\n');
      if (matchesInRange(identifier, rangeText)) continue;

      // Con tro rieng ("tai `:1257`") -> doi chieu tai dong con tro.
      if (ptrLine && ptrLine <= target.length && matchesInRange(identifier, target[ptrLine - 1])) continue;

      const hits = [];
      target.forEach((l, j) => { if (l.includes(identifier)) hits.push(j + 1); });
      errors.push({
        docLine: idx + 1, file: ref.file, from: ref.from, to: ref.to, identifier,
        reason: `KHONG KHOp "${identifier}" - dang o dong ${hits.slice(0, 6).join(', ') || 'KHONG TON TAI'}`,
      });
    }
  });

  return errors;
}

function collectDocs(targets) {
  if (targets.length) {
    const out = [];
    for (const t of targets) {
      const abs = path.resolve(ROOT, t);
      if (!fs.existsSync(abs)) { console.log(`KHONG TON TAI: ${t}`); continue; }
      if (fs.statSync(abs).isDirectory()) {
        (function walk(dir) {
          if (SKIP_DIRS.has(path.basename(dir))) return; // xem SKIP_DIRS
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const q = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(q);
            else if (entry.name.endsWith('.md')) out.push(q);
          }
        })(abs);
      } else {
        out.push(abs);
      }
    }
    return out;
  }
  if (!fs.existsSync(DOCS)) return [];
  const out = [];
  (function walk(dir) {
    if (SKIP_DIRS.has(path.basename(dir))) return; // xem SKIP_DIRS
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) out.push(p);
    }
  })(DOCS);
  return out;
}

function main() {
  const targets = process.argv.slice(2);
  const files = collectDocs(targets);
  let total = 0;

  for (const f of files) {
    const errors = checkDoc(f);
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    if (errors.length === 0) {
      console.log(`OK    ${rel}`);
      continue;
    }
    total += errors.length;
    console.log(`LOI   ${rel} (${errors.length})`);
    for (const e of errors) {
      console.log(`        doc L${e.docLine}  ${e.file}:${e.from}-${e.to}  ->  ${e.reason}`);
    }
  }

  console.log('');
  console.log(total === 0
    ? `Tat ca tham chieu trong ${files.length} file doc deu dung.`
    : `Tong loi: ${total} (trong ${files.length} file doc)`);
  process.exit(total === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { checkDoc, collectDocs, isIdentifier, matchesInRange };
