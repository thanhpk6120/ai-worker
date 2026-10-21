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

  // Xoa bien SYSTEMONE_* ke thua tu shell agent. config.js CHI nap .env khi
  // process.env[key] === undefined => gia tri cu (ke ca chuoi rong) se che do
  // .env => server chay sai model/API key.
  const childEnv = { ...process.env };
  for (const k of ['SYSTEMONE_MODEL', 'SYSTEMONE_API_KEY', 'SYSTEMONE_BASE_URL', 'SYSTEMONE_ENABLED']) {
    delete childEnv[k];
  }
  // spawn detached: tiến trình con của explorer, KHÔNG phải của shell agent.
  // stdio: 'ignore' => không giữ pipe nào sang shell cha.
  const child = spawn(node, ['src/index.js'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv,
  });
  child.unref();
  writePid(child.pid);
  console.log(`Worker da start (PID ${child.pid}) - node: ${node}`);
  console.log(`  cwd    : ${ROOT}`);
  console.log(`  log    : ${LOG_FILE}`);

  // Cho server kip listen.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const h = await health();
    if (h.code === 200) {
      console.log(`  health : HTTP 200 (sau ${((i + 1) * 0.5).toFixed(1)}s)`);
      return 0;
    }
  }
  console.log('  health : chua phan hoi sau 10s - xem logs/server-bg.log');
  return 0;
}

function stop() {
  const pid = readPid() || pidByPort(PORT);
  if (!pid || !isAlive(pid)) {
    clearPid();
    console.log('Worker khong chay.');
    return 0;
  }
  console.log(`Dang dung worker (PID ${pid})...`);
  // 2-phase: SIGTERM-equivalent truoc, force sau.
  try { process.kill(pid, 'SIGTERM'); } catch (e) {}
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isAlive(pid)) {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Sleep -Milliseconds 250`]);
  }
  if (isAlive(pid)) {
    console.log('  Con sau 5s -> force kill.');
    ps(`Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`);
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
