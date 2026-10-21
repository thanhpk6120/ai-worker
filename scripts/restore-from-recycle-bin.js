/**
 * scripts/restore-from-recycle-bin.js
 * Khoi phuc file tu Windows Recycle Bin bang cach quet truc tiep
 * `D:\$Recycle.Bin\<SID>\` (khong dung COM Shell).
 *
 * VI SAO: `InvokeVerb('restore')` fail khi Recycle Bin luu "DeletedFrom" bi cat
 * (chi con `...\\runtime`, khong co ten file) => file bi xoa khoi bin ma khong
 * duoc dat lai. `ShellItem.CopyHere` lai nhan THU MUC la dich (khong phai
 * duong dan file) => khong dung duoc.
 *
 * CO CHE:
 *  - Moi file trong Recycle Bin co 2 cap: `$I<suffix>.<ext>` (metadata) va
 *    `$R<suffix>.<ext>` (du lieu that).
 *  - `$I` layout (Windows Vista+):
 *      offset  0: int64  version (0x02)
 *      offset  8: int64  file size
 *      offset 16: int64  FILETIME (thoi diem xoa)
 *      offset 24: int32  do dai duong dan goc (so ký tự, ke ca null)
 *      offset 28: UTF-16LE duong dan goc
 *  - Doc `$I` => biet duong dan goc => file nao can khoi phuc.
 *  - Copy `$R<suffix>.<ext>` (cung suffix) ra dich mong muon.
 *
 * Dung: node scripts/restore-from-recycle-bin.js <featureDir> <destSubdir> [file1,file2,...]
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const featureDir = process.argv[2];
const destSub = process.argv[3] || 'runtime';
const wanted = (process.argv[4] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

if (!featureDir) {
  console.log('Dung: node scripts/restore-from-recycle-bin.js <featureDir> <destSubdir> [file1,file2,...]');
  process.exit(1);
}
const destDir = path.join(featureDir, destSub);

/** Doc duong dan goc tu file metadata `$I`. */
function parseOriginalPath(buf) {
  if (buf.length < 28) return null;
  const version = buf.readBigUInt64LE(0);
  if (version !== 2n) return null;
  const nameLen = buf.readInt32LE(24);
  if (nameLen <= 0 || 28 + nameLen * 2 > buf.length) return null;
  return buf.toString('utf16le', 28, 28 + nameLen * 2).replace(/\0+$/, '');
}

/** Tim thu muc Recycle Bin cua user hien tai. */
function recycleRoots() {
  const roots = [];
  const drives = ['C:', 'D:', 'E:', 'F:'];
  for (const d of drives) {
    const base = path.join(`${d}\\`, '$Recycle.Bin');
    if (!fs.existsSync(base)) continue;
    for (const sid of fs.readdirSync(base)) {
      const p = path.join(base, sid);
      try {
        if (fs.statSync(p).isDirectory()) roots.push(p);
      } catch (e) {}
    }
  }
  return roots;
}

const roots = recycleRoots();
console.log(`Recycle Bin roots: ${roots.length}`);
for (const r of roots) console.log(`  ${r}`);

const wantedSet = new Set(wanted);
const found = [];

for (const root of roots) {
  let entries;
  try { entries = fs.readdirSync(root); } catch (e) { continue; }
  for (const name of entries) {
    if (!name.startsWith('$I')) continue;
    const suffix = name.slice(2);           // pha sau $I
    const metaPath = path.join(root, name);
    let origPath;
    try {
      origPath = parseOriginalPath(fs.readFileSync(metaPath));
    } catch (e) { continue; }
    if (!origPath) continue;
    if (!origPath.toLowerCase().includes('rsgate-44')) continue;

    const base = path.basename(origPath);
    if (wantedSet.size && !wantedSet.has(base.toLowerCase())) continue;

    // File du lieu `$R` cung suffix.
    const dataPath = path.join(root, `$R${suffix}`);
    if (!fs.existsSync(dataPath)) {
      console.log(`  THIEU $R cho ${name} (${base})`);
      continue;
    }
    found.push({ base, origPath, dataPath, size: fs.statSync(dataPath).size });
  }
}

console.log(`\n=== TIM DUOC ${found.length} FILE ===`);
for (const f of found) console.log(`  ${f.base}  (${f.size} bytes)`);

if (!found.length) {
  console.log('\nKhong tim thay file de khoi phuc.');
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
let ok = 0;
let fail = 0;
for (const f of found) {
  const dest = path.join(destDir, f.base);
  try {
    fs.copyFileSync(f.dataPath, dest);
    console.log(`  OK   ${f.base}`);
    ok++;
  } catch (e) {
    console.log(`  FAIL ${f.base}: ${e.message}`);
    fail++;
  }
}

console.log(`\nKhoi phuc: ${ok} | that bai: ${fail}`);
console.log(`\n=== ${destDir} ===`);
if (fs.existsSync(destDir)) {
  for (const f of fs.readdirSync(destDir).sort()) console.log(`  ${f}`);
}
