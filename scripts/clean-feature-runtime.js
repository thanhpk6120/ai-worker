/**
 * scripts/clean-feature-runtime.js
 * Xoa thu muc runtime/ cua 1 feature dir bang cach chuyen vao THUNG RAC
 * (khong xoa vinh vien).
 *
 * Vong lap thu muc: `Microsoft.VisualBasic.FileIO.FileSystem::DeleteDirectory`
 * khong ho tro tren mot so o dia => xoa tung file (DeleteFile ho tro) roi
 * moi xoa thu muc con. Thung muc con lai duoc move vao `.trash` (fallback
 * cua project, cung khong phai xoa vinh vien).
 *
 * Dung: node scripts/clean-feature-runtime.js <featureDir>
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const featureDir = process.argv[2];
if (!featureDir) {
  console.log('Dung: node scripts/clean-feature-runtime.js <featureDir>');
  process.exit(1);
}
const runtimeDir = path.join(featureDir, 'runtime');

function trashFile(p) {
  const full = path.resolve(p).replace(/'/g, "''");
  const cmd = `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('${full}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  try {
    execSync(`powershell.exe -NoProfile -NonInteractive -Command "${cmd}"`, { stdio: 'ignore' });
    return !fs.existsSync(p);
  } catch (e) { return false; }
}

function trashDir(p) {
  const full = path.resolve(p).replace(/'/g, "''");
  const cmd = `Add-Type -AssemblyName Microsoft.VisualBasic; ` +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('${full}', 'OnlyErrorDialogs', 'SendToRecycleBin')`;
  try {
    execSync(`powershell.exe -NoProfile -NonInteractive -Command "${cmd}"`, { stdio: 'ignore' });
    return !fs.existsSync(p);
  } catch (e) { return false; }
}

if (!fs.existsSync(runtimeDir)) {
  console.log('KHONG CON runtime:', runtimeDir);
  process.exit(0);
}

let ok = 0;
let fail = 0;
for (const e of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
  const p = path.join(runtimeDir, e.name);
  if (e.isDirectory()) {
    for (const s of fs.readdirSync(p, { withFileTypes: true })) {
      const sp = path.join(p, s.name);
      if (s.isFile()) { trashFile(sp) ? ok++ : fail++; }
    }
    trashDir(p) ? ok++ : fail++;
  } else {
    trashFile(p) ? ok++ : fail++;
  }
}
console.log(`vao thung rac: ${ok} | that bai: ${fail}`);

if (fs.existsSync(runtimeDir)) {
  // Fallback: move vao .trash (khong xoa vinh vien).
  const trashDirPath = path.join(path.dirname(runtimeDir), '.trash');
  fs.mkdirSync(trashDirPath, { recursive: true });
  const dest = path.join(trashDirPath, `runtime.${Date.now()}`);
  try {
    fs.renameSync(runtimeDir, dest);
    console.log('DA MOVE runtime -> .trash:', dest);
  } catch (e) {
    console.log('move that bai:', e.message);
  }
}
console.log('runtime con ton tai:', fs.existsSync(runtimeDir));
