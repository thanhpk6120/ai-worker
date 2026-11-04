/**
 * src/index.js
 * Điểm khởi chạy chính của hệ thống AI Worker
 */

// 0. Global crash handler — PHẢI đăng ký TRƯỚC mọi require: nếu module ném lỗi
// lúc load, handler chưa tồn tại thì process chết không dấu vết.
// Ghi stack ra stderr rồi thoát mã 1; không nuốt lỗi để người vận hành biết.
function logFatal(kind, err) {
  const ts = new Date().toISOString();
  const detail = err && err.stack ? err.stack : String(err);
  console.error(`\n>>> [FATAL] ${ts} ${kind}\n${detail}\n`);
  if (err && err.code) console.error(`>>> [FATAL] code=${err.code}`);
  if (err && err.errno) console.error(`>>> [FATAL] errno=${err.errno}`);
  if (err && err.syscall) console.error(`>>> [FATAL] syscall=${err.syscall}`);
}
process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err);
  // Cho stderr kịp flush rồi thoát cứng — process ở trạng thái không xác định.
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (reason) => {
  logFatal('unhandledRejection', reason);
  // Không thoát: promise lỗi lẻ không nhất thiết làm hỏng server.
});

const { initDb, getDb, closeOrphanRunningSteps } = require('./storage/db');
const { runnerRegistry } = require('./runners/runnerRegistry');
const { app, startTransientRecoveryLoop, startPortWaitRecoveryLoop } = require('./server');
const config = require('./config');
const { taskQueue } = require('./queue/taskQueue');
// 1. Khởi tạo Database SQLite
console.log('>>> [BOOT] Đang khởi tạo cơ sở dữ liệu SQLite...');
try {
  initDb();
  console.log(`>>> [BOOT] SQLite đã sẵn sàng tại: ${config.DB_PATH}`);
} catch (dbErr) {
  console.error('>>> [BOOT ERROR] Không thể khởi tạo SQLite:', dbErr);
  process.exit(1);
}

// 1b. Đối soát step mồ côi: `stepTimeline` chỉ nằm trong RAM nên sau khi restart
// mọi row `steps` còn RUNNING đều không còn ai đóng. Không dọn thì UI hiển thị
// nhiều bước "đang chạy" cùng lúc và "Thời lượng" bị tính sai vĩnh viễn.
try {
  const closedSteps = closeOrphanRunningSteps({ status: 'CANCELLED' });
  if (closedSteps > 0) {
    console.log(`>>> [BOOT] Đã đóng ${closedSteps} step RUNNING mồ côi từ lần chạy trước (status=CANCELLED).`);
  }
} catch (reconcileErr) {
  console.warn('>>> [BOOT WARN] Không đối soát được step RUNNING mồ côi:', reconcileErr.message);
}

// 1c. Thu hồi toàn bộ port lease của lần chạy trước. Restart đã kill cây tiến
// trình nên các port này phải được trả lại pool; port nào còn bị process rác
// giữ sẽ được `isPortFree` phát hiện và bỏ qua khi cấp phát.
try {
  const portLeaseManager = require('./execution/portLeaseManager');
  const clearedLeases = portLeaseManager.clearAllLeases();
  if (clearedLeases > 0) {
    console.log(`>>> [BOOT] Đã thu hồi ${clearedLeases} port lease từ lần chạy trước.`);
  }
} catch (leaseErr) {
  console.warn('>>> [BOOT WARN] Không thu hồi được port lease:', leaseErr.message);
}

// 2. Kiểm tra Runners Availability
console.log('>>> [BOOT] Đang kiểm tra trạng thái các Runner CLI...');
try {
  const detectedRunners = runnerRegistry.detectAll();
  detectedRunners.forEach((r) => {
    const statusIcon = r.installed ? '✓' : '✗';
    const statusText = r.installed
      ? `Sẵn sàng (${r.version || 'installed'}) tại ${r.path || 'PATH'}`
      : `Chưa cài đặt (${r.error || 'not found in PATH'})`;
    console.log(`    [${statusIcon}] Runner '${r.name}': ${statusText}`);
  });
} catch (runnerErr) {
  console.warn('>>> [BOOT WARN] Lỗi khi kiểm tra runners:', runnerErr.message);
}

// 3. Khởi chạy HTTP Server
const PORT = config.PORT || 3000;
const server = app.listen(PORT, () => {
  const banner = `
========================================================================
   ___    ____   _       __ ____   ____   __ __ ______ ____ 
  /   |  /  _/  | |     / // __ \\ / __ \\ / // // ____// __ \\
 / /| |  / /    | | /| / // / / // /_/ // // // __/  / /_/ /
/ ___ |_/ /     | |/ |/ // /_/ // _, _// // // /___ / _, _/ 
/_/  |_/___/     |__/|__/ \\____//_/ |_|/_//_//_____//_/ |_|  
========================================================================
 AI Worker - Autonomous Multi-Agent Pipeline & Verification Server
------------------------------------------------------------------------
 Web UI Dashboard:     http://localhost:${PORT}
 Health Endpoint:      http://localhost:${PORT}/api/v1/health
 Status Endpoint:      http://localhost:${PORT}/api/v1/status
 Runners List:         http://localhost:${PORT}/api/v1/runners
 Jobs API:             http://localhost:${PORT}/api/v1/jobs
 Concurrency Limit:    ${config.CONCURRENCY}
 Worktree Base Dir:    ${config.WORKTREE_BASE_DIR}
 Log Dir:              ${config.LOG_DIR}
========================================================================
`;
  console.log(banner);
  // 3b. Vòng tự động chạy lại job khi lỗi hạ tầng (rate-limit, CLI timeout...)
  // đã hết backoff. Không đụng job PAUSED do người dùng tự bấm Dừng.
  try {
    startTransientRecoveryLoop();
    startPortWaitRecoveryLoop();
  } catch (recoveryErr) {
    console.warn('>>> [BOOT WARN] Không khởi động được vòng chờ hồi phục:', recoveryErr.message);
  }
});

// 4. Xử lý Graceful Shutdown
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n>>> [SHUTDOWN] Nhận tín hiệu ${signal}. Bắt đầu quá trình tắt an toàn...`);

  // Dừng nhận request mới
  server.close(() => {
    console.log('>>> [SHUTDOWN] HTTP Server đã đóng tiếp nhận kết nối mới.');

    try {
      // Hủy hoặc chờ các task đang chạy trong taskQueue nếu cần
      const runningJobs = taskQueue.getRunningJobs();
      if (runningJobs.length > 0) {
        console.log(`>>> [SHUTDOWN] Đang hủy ${runningJobs.length} job đang thực thi trong queue...`);
        runningJobs.forEach((j) => {
          taskQueue.cancel(j.id);
        });
      }
    } catch (qErr) {
      console.warn('>>> [SHUTDOWN] Lỗi dừng queue:', qErr.message);
    }

    try {
      // Đóng kết nối SQLite
      const db = getDb();
      if (db && typeof db.close === 'function') {
        db.close();
        console.log('>>> [SHUTDOWN] Đã đóng kết nối SQLite Database.');
      }
    } catch (dbCloseErr) {
      // DatabaseSync có thể tự flush khi process kết thúc
    }

    console.log('>>> [SHUTDOWN] Toàn bộ dịch vụ đã dừng an toàn. Tạm biệt!\n');
    process.exit(0);
  });

  // Timeout ép buộc dừng nếu server treo quá 10 giây
  setTimeout(() => {
    console.error('>>> [SHUTDOWN TIMEOUT] Ép buộc kết thúc tiến trình sau 10 giây.');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = {
  server,
  app
};
