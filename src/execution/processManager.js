/**
 * processManager.js
 * Quản lý vòng đời tiến trình con (Child Process) của AI Agent CLI.
 * Tích hợp tự động:
 * - Secret Scrubbing lọc log stdout/stderr
 * - Timeout Watchdog Timer (ngắt tự động khi quá thời gian)
 * - Safe Tree-kill 2 giai đoạn: SIGTERM -> grace period 5s -> SIGKILL
 * - Phát sự kiện qua EventEmitter (spawn, stdout, stderr, timeout, exit, error)
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const treeKill = require('tree-kill');
const { maskSecrets } = require('./secretScrubber');
const config = require('../config');

/**
 * Kiểm tra xem một tiến trình (PID) còn đang tồn tại hay không
 * @param {number} pid
 * @returns {boolean}
 */
function isPidRunning(pid) {
  if (!pid || typeof pid !== 'number' || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM nghĩa là tiến trình vẫn sống nhưng không có quyền gửi signal
    return err.code === 'EPERM';
  }
}

/**
 * Helper bọc tree-kill thành Promise
 * @param {number} pid
 * @param {string} signal
 * @returns {Promise<{ success: boolean, error?: any }>}
 */
function treeKillAsync(pid, signal = 'SIGTERM') {
  return new Promise((resolve) => {
    try {
      treeKill(pid, signal, (err) => {
        if (err) {
          resolve({ success: false, error: err });
        } else {
          resolve({ success: true });
        }
      });
    } catch (err) {
      resolve({ success: false, error: err });
    }
  });
}

/**
 * Lớp ProcessManager quản lý tập trung toàn bộ tiến trình Agent CLI
 */
class ProcessManager extends EventEmitter {
  constructor() {
    super();
    /**
     * Danh sách lưu trữ tiến trình theo PID
     * @type {Map<number, object>}
     */
    this.processes = new Map();
  }

  /**
   * Khởi chạy tiến trình con
   * @param {object} options
   * @param {string} options.command - Lệnh thực thi (ví dụ: 'claude', 'node', 'opencode')
   * @param {Array<string>} [options.args=[]] - Danh sách tham số
   * @param {string} [options.cwd=process.cwd()] - Thư mục làm việc
   * @param {Record<string, string>} [options.env={}] - Biến môi trường bổ sung
   * @param {number} [options.timeoutMs] - Thời gian tối đa (ms), mặc định lấy từ config.DEFAULT_TIMEOUT
   * @param {(data: string) => void} [options.onStdout] - Callback nhận dữ liệu stdout đã làm sạch
   * @param {(data: string) => void} [options.onStderr] - Callback nhận dữ liệu stderr đã làm sạch
   * @param {string} [options.jobId=null] - Mã định danh tác vụ liên kết
   * @param {boolean} [options.shell=process.platform === 'win32'] - Chạy dưới shell hay trực tiếp
   * @returns {object} Đối tượng điều khiển tiến trình (pid, child, promise, kill, wait)
   */
  spawnProcess(options = {}) {
    const {
      command,
      args = [],
      cwd = process.cwd(),
      env = {},
      onStdout = null,
      onStderr = null,
      jobId = null,
      shell = options.shell !== undefined ? options.shell : (process.platform === 'win32')
    } = options;

    if (!command || typeof command !== 'string') {
      throw new Error('Tham số command là bắt buộc và phải là chuỗi ký tự');
    }

    // Timeout mac dinh tu config.DEFAULT_TIMEOUT (giay) -> ms; uu tien timeout truyen xuong (ms/giay/phut).
    const defaultTimeoutMs = config.DEFAULT_TIMEOUT_MS || ((config.DEFAULT_TIMEOUT ? config.DEFAULT_TIMEOUT : 900) * 1000);
    const timeoutMs = typeof config.normalizeTimeoutMs === 'function'
      ? config.normalizeTimeoutMs(options, defaultTimeoutMs)
      : (typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? options.timeoutMs
        : defaultTimeoutMs);

    // MCP handshake/tool-search: chỉ truyền cho claude/omp (CLI có cơ chế MCP xác minh được).
    // Giữ OMP_MCP_TIMEOUT_MS để tương thích với bản cứng 60000 trước đây ở baseAdapter.
    const mcpHandshakeTimeoutMs = String(config.MCP_HANDSHAKE_TIMEOUT_MS !== undefined && config.MCP_HANDSHAKE_TIMEOUT_MS !== null ? config.MCP_HANDSHAKE_TIMEOUT_MS : 60000);
    const mcpToolSearchFlag = config.MCP_TOOL_SEARCH_ENABLED ? 'true' : 'false';
    const isMcpManagedCommand = typeof command === 'string' && /(^|[^a-z])(claude|omp)([^a-z]|$)/i.test(command);
    const mcpEnv = isMcpManagedCommand ? {
      MCP_TIMEOUT: mcpHandshakeTimeoutMs,
      MCP_HANDSHAKE_TIMEOUT: mcpHandshakeTimeoutMs,
      MCP_HANDSHAKE_TIMEOUT_MS: mcpHandshakeTimeoutMs,
      OMP_MCP_TIMEOUT_MS: mcpHandshakeTimeoutMs,
      ENABLE_TOOL_SEARCH: mcpToolSearchFlag
    } : {};
    const mergedEnv = {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      FORCE_COLOR: '1',
      CI: '1',
      TERM: 'xterm-256color',
      COLUMNS: '250',
      LINES: '50',
      ...mcpEnv,
      ...env
    };

    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: mergedEnv,
        shell,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (err) {
      this.emit('error', {
        jobId,
        command,
        args,
        error: err,
        timestamp: new Date().toISOString()
      });
      throw err;
    }

    const pid = child.pid;

    // Bản ghi thông tin tiến trình
    const record = {
      pid,
      jobId,
      command,
      args,
      cwd,
      status: 'RUNNING', // 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'KILLED'
      startTime: new Date().toISOString(),
      endTime: null,
      exitCode: null,
      signal: null,
      timedOut: false,
      stdoutBuffer: [],
      stderrBuffer: [],
      childProcess: child,
      timeoutTimer: null
    };

    this.processes.set(pid, record);

    // Kích hoạt Timeout Watchdog Timer
    if (timeoutMs > 0) {
      record.timeoutTimer = setTimeout(async () => {
        if (record.status === 'RUNNING') {
          record.timedOut = true;
          record.status = 'TIMED_OUT';

          this.emit('timeout', {
            pid,
            jobId,
            timeoutMs,
            command,
            timestamp: new Date().toISOString()
          });

          // Ngắt tiến trình 2 giai đoạn khi timeout
          await this.killProcess(pid, 'SIGTERM', 5000, 'TIMED_OUT');
        }
      }, timeoutMs);

      // Đảm bảo watchdog timer không chặn việc đóng runtime nếu cần
      if (record.timeoutTimer.unref) {
        record.timeoutTimer.unref();
      }
    }

    // Phát sự kiện spawn
    this.emit('spawn', {
      pid,
      jobId,
      command,
      args,
      cwd,
      timeoutMs,
      timestamp: record.startTime
    });

    // Lắng nghe stdout và lọc bí mật
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        const rawText = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
        const cleanText = maskSecrets(rawText);

        record.stdoutBuffer.push(cleanText);

        if (typeof onStdout === 'function') {
          try {
            onStdout(cleanText);
          } catch (err) {
            // Tránh làm sập tiến trình do callback ngoại vi
          }
        }

        this.emit('stdout', {
          pid,
          jobId,
          data: cleanText,
          timestamp: new Date().toISOString()
        });
      });
    }

    // Lắng nghe stderr và lọc bí mật
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const rawText = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
        const cleanText = maskSecrets(rawText);

        record.stderrBuffer.push(cleanText);

        if (typeof onStderr === 'function') {
          try {
            onStderr(cleanText);
          } catch (err) {
            // Tránh làm sập tiến trình do callback ngoại vi
          }
        }

        this.emit('stderr', {
          pid,
          jobId,
          data: cleanText,
          timestamp: new Date().toISOString()
        });
      });
    }

    // Đóng stdin ngay lập tức nếu không có luồng input để báo hiệu EOF cho các CLI agent như claude-code
    if (child.stdin) {
      try {
        if (options.input) {
          child.stdin.end(options.input);
        } else {
          child.stdin.end();
        }
      } catch (stdinErr) {
        // Bỏ qua nếu stream đã đóng
      }
    }

    // Xử lý khi tiến trình hoàn tất hoặc gặp lỗi
    const completionPromise = new Promise((resolve) => {
      let settled = false;

      const finalize = (exitCode, signal) => {
        if (settled) return;
        settled = true;

        if (record.timeoutTimer) {
          clearTimeout(record.timeoutTimer);
          record.timeoutTimer = null;
        }

        record.endTime = new Date().toISOString();
        record.exitCode = exitCode;
        record.signal = signal;

        if (record.timedOut) {
          record.status = 'TIMED_OUT';
        } else if (record.status === 'KILLED') {
          // Giữ nguyên trạng thái KILLED
        } else if (exitCode === 0) {
          record.status = 'COMPLETED';
        } else {
          record.status = 'FAILED';
        }

        const summary = {
          pid,
          jobId,
          status: record.status,
          exitCode: record.exitCode,
          signal: record.signal,
          timedOut: record.timedOut,
          stdout: record.stdoutBuffer.join(''),
          stderr: record.stderrBuffer.join(''),
          startTime: record.startTime,
          endTime: record.endTime
        };

        this.emit('exit', {
          ...summary,
          timestamp: record.endTime
        });

        resolve(summary);
      };

      child.on('close', (code, signal) => {
        finalize(code, signal);
      });

      child.on('error', (err) => {
        if (record.timeoutTimer) {
          clearTimeout(record.timeoutTimer);
          record.timeoutTimer = null;
        }

        if (record.status === 'RUNNING') {
          record.status = 'FAILED';
        }

        this.emit('error', {
          pid,
          jobId,
          error: err,
          timestamp: new Date().toISOString()
        });

        finalize(-1, null);
      });
    });

    const handle = {
      pid,
      child,
      jobId,
      promise: completionPromise,
      wait: () => completionPromise,
      kill: (gracePeriodMs = 5000) => this.killProcess(pid, 'SIGTERM', gracePeriodMs),
      then: (onfulfilled, onrejected) => completionPromise.then(onfulfilled, onrejected),
      catch: (onrejected) => completionPromise.catch(onrejected)
    };

    return handle;
  }

  /**
   * Ngắt tiến trình an toàn 2 giai đoạn:
   * Giai đoạn 1: Gửi SIGTERM
   * Chờ gracePeriodMs (mặc định 5s). Nếu tiến trình vẫn sống:
   * Giai đoạn 2: Gửi SIGKILL cưỡng bức
   *
   * @param {number} pid - ID tiến trình
   * @param {string} [reason='SIGTERM'] - Tín hiệu hoặc lý do ngắt
   * @param {number} [gracePeriodMs=5000] - Thời gian ân hạn trước khi cưỡng bức (ms)
   * @param {string} [targetStatus='KILLED'] - Trạng thái đích ('KILLED' hoặc 'TIMED_OUT')
   * @returns {Promise<boolean>} Kết quả ngắt thành công
   */
  async killProcess(pid, reason = 'SIGTERM', gracePeriodMs = 5000, targetStatus = 'KILLED') {
    if (!pid || typeof pid !== 'number') {
      return false;
    }

    const record = this.processes.get(pid);
    if (record) {
      if (record.timeoutTimer) {
        clearTimeout(record.timeoutTimer);
        record.timeoutTimer = null;
      }
      record.status = targetStatus;
    }

    if (!isPidRunning(pid)) {
      return true;
    }

    // Giai đoạn 1: Gửi SIGTERM an toàn
    await treeKillAsync(pid, 'SIGTERM');

    // Chờ tối đa gracePeriodMs xem tiến trình đã kết thúc chưa
    const startTime = Date.now();
    const intervalMs = 250;

    let stillRunning = isPidRunning(pid);
    while (stillRunning && (Date.now() - startTime) < gracePeriodMs) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      stillRunning = isPidRunning(pid);
    }

    // Giai đoạn 2: Nếu sau gracePeriodMs tiến trình vẫn chưa dừng -> Gửi SIGKILL
    if (stillRunning) {
      await treeKillAsync(pid, 'SIGKILL');
      // Chờ một nhịp nhỏ cho hệ thống thu hồi PID
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    this.emit('killed', {
      pid,
      jobId: record ? record.jobId : null,
      reason,
      status: targetStatus,
      timestamp: new Date().toISOString()
    });

    return true;
  }

  /**
   * Lấy thông tin chi tiết một tiến trình theo PID
   * @param {number} pid
   * @returns {object|null}
   */
  getProcess(pid) {
    const record = this.processes.get(pid);
    if (!record) {
      return null;
    }
    return this._formatProcessInfo(record);
  }

  /**
   * Lấy danh sách toàn bộ tiến trình đã ghi nhận
   * @returns {Array<object>}
   */
  getAllProcesses() {
    return Array.from(this.processes.values()).map((record) => this._formatProcessInfo(record));
  }

  /**
   * Lấy danh sách các tiến trình đang hoạt động (RUNNING)
   * @returns {Array<object>}
   */
  getActiveProcesses() {
    return this.getAllProcesses().filter((proc) => proc.status === 'RUNNING');
  }

  /**
   * Lấy danh sách tiến trình theo jobId
   * @param {string} jobId
   * @returns {Array<object>}
   */
  getProcessesByJobId(jobId) {
    if (!jobId) return [];
    return this.getAllProcesses().filter((proc) => proc.jobId === jobId);
  }

  /**
   * Dừng toàn bộ tiến trình của một jobId
   * @param {string} jobId
   * @param {number} [gracePeriodMs=5000]
   * @returns {Promise<number>} Số lượng tiến trình đã ngắt
   */
  async killProcessesByJobId(jobId, gracePeriodMs = 5000) {
    if (!jobId) return 0;
    const targets = this.getActiveProcesses().filter((proc) => proc.jobId === jobId);
    for (const target of targets) {
      await this.killProcess(target.pid, 'SIGTERM', gracePeriodMs);
    }
    return targets.length;
  }

  /**
   * Dọn dẹp ngắt toàn bộ tiến trình đang hoạt động trong pool
   * @param {number} [gracePeriodMs=5000]
   * @returns {Promise<void>}
   */
  async killAll(gracePeriodMs = 5000) {
    const activeList = this.getActiveProcesses();
    const killPromises = activeList.map((proc) =>
      this.killProcess(proc.pid, 'SIGTERM', gracePeriodMs)
    );
    await Promise.all(killPromises);
  }

  /**
   * Chuẩn hóa đối tượng thông tin tiến trình để trả về (loại bỏ circular reference)
   * @private
   * @param {object} record
   * @returns {object}
   */
  _formatProcessInfo(record) {
    return {
      pid: record.pid,
      jobId: record.jobId,
      command: record.command,
      args: record.args,
      cwd: record.cwd,
      status: record.status,
      startTime: record.startTime,
      endTime: record.endTime,
      exitCode: record.exitCode,
      signal: record.signal,
      timedOut: record.timedOut,
      stdoutLength: record.stdoutBuffer.reduce((sum, chunk) => sum + chunk.length, 0),
      stderrLength: record.stderrBuffer.reduce((sum, chunk) => sum + chunk.length, 0)
    };
  }
}

// Khởi tạo instance mặc định kiểu singleton
const defaultProcessManager = new ProcessManager();

module.exports = {
  ProcessManager,
  defaultProcessManager,
  isPidRunning,
  treeKillAsync
};
