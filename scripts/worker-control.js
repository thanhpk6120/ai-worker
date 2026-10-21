/**
 * scripts/worker-control.js
 * Dieu khien worker ai-worker: start / stop / status / restart.
 *
 * Worker CHAY DOC LAP voi session agent: duoc spawn boi `Start-Process` voi
 * `-WindowStyle Hidden` (tiến trình con của explorer, không phải của shell
 * agent) nên không bị reap khi shell agent đóng. Đây là nguyên nhân worker
 * chết giữa chừng trước đây: `restart-worker.bat` dùng `start "" /MIN cmd`
 * => tiến trình thuộc cây con của shell cha, bị reap theo.
 *
 * Khong tu dong bat (user muon tuyet) va khong tu dong khoi dong.
 *
 * Dung:
 *   node scripts/worker-control.js start
 *   node scripts/worker-control.js stop
 *   node scripts/worker-control.js status
 *   node scripts/worker-control.js restart
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PID_FILE = path.join(ROOT, 'logs', 'worker.pid');
const LOG_FILE = path.join(ROOT, 'logs', 'server-bg.log');
const ERR_FILE = path.join(ROOT, 'logs', 'server-bg-err.log');
const PORT = parseInt(process.env.PORT || '3000', 10);

// Node that on may xoa khi shell cua agent dong -> phai dung ban cai dat
// o dinh (fnm node-versions), KHONG dung fnm_multishells.
const NODE_CANDIDATES = [
  'C:\\Users\\ThanhPK\\AppData\\Roaming\\fnm\\node-versions\\v24.21.0\\installation\\node.exe',
];

function findNode() {
  for (const c of NODE_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback: node trong PATH (chi dung khi can chay ngay).
  try {
    const p = execFileSync('where', ['node'], { encoding: 'utf8' })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (p.length) return p[0];
  } catch (e) {}
  return null;
}

function readPid() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (e) { return null; }
}

function writePid(pid) {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(pid), 'utf8');
}

function clearPid() {
  try { if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE); } catch (e) {}
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) { return false; }
}

function ps(cmdArgs) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmdArgs], { encoding: 'utf8' });
  } catch (e) { return ''; }
}

/** Tim PID worker theo port (fallback khi PID file mat). */
function pidByPort(port) {
  const out = ps(`netstat -ano | Select-String ':${port} ' | Select-String 'LISTENING' | ForEach-Object { ($_ -split '\\s+')[-1] }`);
  const pid = parseInt((out || '').trim().split(/\r?\n/).filter(Boolean)[0] || '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function health() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/v1/status`, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: body.slice(0, 300) }));
    });
    req.on('error', (e) => resolve({ code: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ code: 0, error: 'timeout' }); });
  });
}

async function start() {
  const existing = readPid();
  if (isAlive(existing)) {
    console.log(`Worker dang chay (PID ${existing}). Khong can start.`);
    return 0;
  }
  const byPort = pidByPort(PORT);
  if (byPort) {
    writePid(byPort);
    console.log(`Worker da chay tren port ${PORT} (PID ${byPort}) - da cap nhat PID file.`);
    return 0;
  }

  const node = findNode();
  if (!node) {
    console.error('Khong tim thay node.exe. Cai dat node o dinh khong duoc.');
    return 1;
  }
  if (!fs.existsSync(LOG_FILE)) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

  // TAO PROCESS QUA WMI (Win32_Process.Create) => process chay trong WMI
  // Provider Host, DOC LAP hoan toan voi job object cua shell agent.
  //
  // LY DO: `spawn(detached:true)` VA `Start-Process` deu bi ghep vao job object
  // cua shell agent tren Windows. Khi shell agent bi timeout/ket thuc, ca job
  // object bi reap => worker chet theo (da xay 2 lan: 18:55:53Z va 19:15:21Z,
  // ca hai lan job log + server-bg.log dung cung luc, step de lai RUNNING mo coi).
  // WMI Provider Host khong nam trong job object cua shell => khong bi reap.
  // EP PATH TUONG MINH: process tao qua WMI nhan environment block cua WMI
  // Provider Host, KHONG phai cua shell agent. Agent CLI (`claude`) chi nam o
  // `C:\Users\ThanhPK\.local\bin` - `BaseAdapter.detect()` resolve bang
  // `where claude` => neu PATH thieu, `getAvailableRunner('claude-code')` tra
  // null va pipeline chay tiep ma KHONG chay agent. Ep PATH de khong phu thuoc
  // env cua WmiPrvSE (WmiPrvSE co the restart voi env khac).
  const PATH_ENTRIES = [
    'C:\\Users\\ThanhPK\\.local\\bin',
    'C:\\Users\\ThanhPK\\AppData\\Roaming\\fnm\\node-versions\\v24.21.0\\installation',
    'C:\\Users\\ThanhPK\\AppData\\Local\\omp',
    '%PATH%',
  ].join(';');
  const psScript = [
    `$ErrorActionPreference='Stop'`,
    `$cmd = 'cmd.exe /c "set PATH=${PATH_ENTRIES} && ""${node}"" src/index.js >> ""${LOG_FILE}"" 2>&1"'`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = '${ROOT}' }`,
    `Write-Output $r.ProcessId`,
  ].join('; ');
  const out = ps(psScript).trim().split(/\r?\n/).filter(Boolean);
  const pid = parseInt(out[out.length - 1], 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    console.error('Khong tao duoc worker qua WMI. Output:', out.join(' | '));
    return 1;
  }
  // PID tra ve tu WMI la PID cua cmd.exe BOOC. Process that giu port 3000 la
  // node CON. => doi PID file sang PID that sau khi server listen, va giu ca
  // PID cmd de stop() diet duoc cay.
  writePid(pid);
  console.log(`Worker da start (cmd wrapper PID ${pid}) - node: ${node}`);
  console.log(`  cwd    : ${ROOT}`);
  console.log(`  log    : ${LOG_FILE}`);
  console.log(`  parent : WMI Provider Host (doc lap voi shell agent)`);

  // Cho server kip listen.
  let realPid = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const h = await health();
    if (h.code === 200) {
      realPid = pidByPort(PORT);
      if (realPid) writePid(realPid);
      console.log(`  health : HTTP 200 (sau ${((i + 1) * 0.5).toFixed(1)}s)`);
      console.log(`  node   : PID ${realPid || '?'} (giu port ${PORT})`);
      return 0;
    }
  }
  return 0;
}

function stop() {
  // PID file tro ve PID cua cmd.exe BOOC (WMI tao `cmd.exe /c ... node ...`).
  // Process that giu port 3000 la node CON (PPID = pid trong file).
  // => phai taskkill /T de diet ca cay, khong phai chi process.kill.
  const pid = readPid() || pidByPort(PORT);
  if (!pid || !isAlive(pid)) {
    clearPid();
    console.log('Worker khong chay.');
    return 0;
  }
  console.log(`Dang dung worker (PID ${pid} + cay con)...`);
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } catch (e) {}

  // Cho den khi port 3000 that su duoc giai phong.
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!pidByPort(PORT)) break;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Milliseconds 250']);
  }
  const still = pidByPort(PORT);
  if (still) {
    console.log(`  Port ${PORT} van bi giu boi PID ${still} -> force kill.`);
    try { execFileSync('taskkill', ['/F', '/T', '/PID', String(still)], { stdio: 'ignore' }); } catch (e) {}
  }
  clearPid();
  console.log('Worker da dung.');
  return 0;
}

async function status() {
  const pid = readPid() || pidByPort(PORT);
  const alive = isAlive(pid);
  const h = await health();
  console.log('=== AI WORKER STATUS ===');
  console.log('pid file   :', PID_FILE, pid ? `(PID ${pid})` : '(khong co)');
  console.log('process    :', alive ? `DANG CHAY (PID ${pid})` : 'KHONG CHAY');
  console.log(`http :${PORT} :`, h.code === 200 ? 'HTTP 200 (OK)' : `HTTP ${h.code || 'khong phan hoi'} ${h.error || ''}`);
  if (h.code === 200) console.log('response   :', h.body.replace(/\s+/g, ' ').slice(0, 200));
  return alive ? 0 : 1;
}

async function main() {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  switch (cmd) {
    case 'start': return start();
    case 'stop': return stop();
    case 'restart': stop(); return start();
    case 'status': return status();
    default:
      console.log('Dung: node scripts/worker-control.js <start|stop|restart|status>');
      return 1;
  }
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('Loi:', e.message);
  process.exit(1);
});
