/**
 * src/execution/localServiceManager.js
 * Quản lý khởi chạy, kiểm tra sẵn sàng và dọn dẹp các service ứng dụng chạy cục bộ
 * dưới dạng Host Child Process (không Docker).
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const treeKill = require('tree-kill');

class LocalServiceManager extends EventEmitter {
  constructor() {
    super();
    /**
     * Map lưu trữ các service đang hoạt động
     * Key: pid (number) -> Value: ServiceRecord
     */
    this.activeServices = new Map();
  }

  /**
   * Kiểm tra cổng mạng có đang sẵn sàng để bind hay không
   * @param {number} port Cổng cần kiểm tra
   * @param {string} host Địa chỉ host (mặc định 127.0.0.1)
   * @returns {Promise<boolean>} true nếu cổng còn trống, false nếu đã bị chiếm dụng
   */
  isPortAvailable(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
      const tester = net.createServer();

      tester.once('error', (err) => {
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          resolve(false);
        } else {
          resolve(false);
        }
      });

      tester.once('listening', () => {
        tester.close(() => {
          resolve(true);
        });
      });

      tester.listen(port, host);
    });
  }

  /**
   * Quét và tìm cổng mạng trống trên host
   * @param {number} startPort Cổng bắt đầu quét (mặc định 3001)
   * @param {number} maxAttempts Số lần thử tối đa (mặc định 50)
   * @returns {Promise<number>} Cổng khả dụng tìm được
   */
  async findAvailablePort(startPort = 3001, maxAttempts = 50) {
    for (let offset = 0; offset < maxAttempts; offset++) {
      const candidatePort = startPort + offset;
      const available = await this.isPortAvailable(candidatePort);
      if (available) {
        return candidatePort;
      }
    }
    throw new Error(
      `Không tìm thấy cổng mạng khả dụng sau ${maxAttempts} lần thử bắt đầu từ cổng ${startPort}`
    );
  }

  /**
   * Thực hiện một lần thăm dò HTTP GET tới probeUrl
   * @param {string} probeUrl URL đầy đủ cần probe
   * @param {number} timeoutMs Thời gian timeout cho mỗi request probe
   * @returns {Promise<boolean>} true nếu status code 200..399
   */
  _singleHttpProbe(probeUrl, timeoutMs = 1500) {
    return new Promise((resolve) => {
      try {
        const parsedUrl = new URL(probeUrl);
        const req = http.get(
          {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || 80,
            path: parsedUrl.pathname + parsedUrl.search,
            timeout: timeoutMs,
            headers: {
              'User-Agent': 'LocalServiceManager-ReadinessProbe/1.0'
            }
          },
          (res) => {
            // Tiêu thụ stream để giải phóng socket
            res.resume();
            if (res.statusCode >= 200 && res.statusCode < 400) {
              resolve(true);
            } else {
              resolve(false);
            }
          }
        );

        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });

        req.on('error', () => {
          resolve(false);
        });
      } catch (err) {
        resolve(false);
      }
    });
  }

  /**
   * Polling định kỳ mỗi 500ms cho đến khi service phản hồi HTTP 200..399 hoặc quá timeout
   * @param {string} baseUrl URL gốc (ví dụ http://localhost:3001)
   * @param {string} readinessPath Đường dẫn probe (ví dụ / hoặc /health)
   * @param {number} startupTimeoutMs Thời gian chờ tối đa (ms)
   * @param {Function} isProcessExited Callback kiểm tra xem tiến trình có chết sớm không
   * @returns {Promise<void>}
   */
  async _pollReadiness(baseUrl, readinessPath, startupTimeoutMs, isProcessExited) {
    const formattedPath = readinessPath.startsWith('/') ? readinessPath : `/${readinessPath}`;
    const probeUrl = `${baseUrl}${formattedPath}`;
    const startTime = Date.now();
    const intervalMs = 500;

    while (Date.now() - startTime < startupTimeoutMs) {
      if (isProcessExited()) {
        throw new Error(`Tiến trình đã thoát trước khi vượt qua kiểm tra readiness tại ${probeUrl}`);
      }

      const isReady = await this._singleHttpProbe(probeUrl, Math.min(1500, intervalMs));
      if (isReady) {
        return;
      }

      // Đợi 500ms trước lần thử tiếp theo
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    throw new Error(
      `Service không đạt trạng thái READY sau ${startupTimeoutMs}ms thăm dò tại ${probeUrl}`
    );
  }

  /**
   * Khởi chạy service ứng dụng trực tiếp tại local dưới dạng Host Child Process
   * @param {Object} options Tham số khởi chạy
   * @param {string} options.command Lệnh thực thi (ví dụ 'node', 'npm', 'pnpm')
   * @param {string[]} [options.args=[]] Danh sách đối số
   * @param {string} [options.cwd=process.cwd()] Thư mục làm việc
   * @param {Object} [options.env={}] Biến môi trường bổ sung
   * @param {number} [options.port] Cổng chỉ định (nếu bận sẽ tự động cấp phát cổng khác)
   * @param {string} [options.readinessPath='/'] Đường dẫn HTTP kiểm tra readiness
   * @param {number} [options.startupTimeoutMs=30000] Thời gian timeout khởi động (ms)
   * @param {boolean} [options.shell] Tuỳ chọn chạy bằng shell (mặc định tự nhận biết)
   * @returns {Promise<{ pid: number, port: number, baseUrl: string, process: import('node:child_process').ChildProcess }>}
   */
  async startService({
    command,
    args = [],
    cwd = process.cwd(),
    env = {},
    port,
    readinessPath = '/',
    startupTimeoutMs = 30000,
    shell
  }) {
    if (!command) {
      throw new Error('Tham số command là bắt buộc khi khởi chạy service');
    }

    // 1. Phân bổ cổng khả dụng
    let assignedPort = port;
    if (!assignedPort) {
      assignedPort = await this.findAvailablePort(3001, 100);
    } else {
      const isAvailable = await this.isPortAvailable(assignedPort);
      if (!isAvailable) {
        this.emit('port_conflict', {
          requestedPort: assignedPort,
          message: `Cổng ${assignedPort} đã bị chiếm dụng, đang quét cổng mới...`
        });
        assignedPort = await this.findAvailablePort(assignedPort + 1, 100);
      }
    }

    const baseUrl = `http://localhost:${assignedPort}`;
    const mergedEnv = {
      ...process.env,
      ...env,
      PORT: String(assignedPort)
    };

    // 2. Spawn Host Child Process
    const isWindows = process.platform === 'win32';
    const shouldUseShell =
      shell !== undefined
        ? shell
        : isWindows && (command.endsWith('.cmd') || command.endsWith('.bat'));

    const childProcess = spawn(command, args, {
      cwd,
      env: mergedEnv,
      shell: shouldUseShell,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const pid = childProcess.pid;
    if (!pid) {
      throw new Error(`Không thể khởi chạy tiến trình con với lệnh: ${command}`);
    }

    const stdoutLogs = [];
    const stderrLogs = [];
    let exited = false;
    let exitCode = null;

    childProcess.stdout.on('data', (data) => {
      const text = data.toString();
      stdoutLogs.push(text);
      this.emit('stdout', { pid, port: assignedPort, data: text });
      this.emit('log', { pid, port: assignedPort, type: 'stdout', data: text });
    });

    childProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderrLogs.push(text);
      this.emit('stderr', { pid, port: assignedPort, data: text });
      this.emit('log', { pid, port: assignedPort, type: 'stderr', data: text });
    });

    childProcess.on('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      const record = this.activeServices.get(pid);
      if (record) {
        record.status = 'STOPPED';
        record.exitCode = code;
        record.exitSignal = signal;
      }
      this.emit('exit', { pid, port: assignedPort, code, signal });
    });

    childProcess.on('error', (err) => {
      this.emit('error', { pid, port: assignedPort, error: err });
    });

    const serviceRecord = {
      pid,
      port: assignedPort,
      baseUrl,
      command,
      args,
      cwd,
      readinessPath,
      process: childProcess,
      status: 'STARTING',
      startedAt: new Date().toISOString(),
      stdoutLogs,
      stderrLogs
    };

    this.activeServices.set(pid, serviceRecord);

    // 3. Polling HTTP readiness probe
    try {
      await this._pollReadiness(
        baseUrl,
        readinessPath,
        startupTimeoutMs,
        () => exited
      );

      serviceRecord.status = 'RUNNING';
      this.emit('service_ready', {
        pid,
        port: assignedPort,
        baseUrl,
        readinessPath
      });

      return {
        pid,
        port: assignedPort,
        baseUrl,
        process: childProcess
      };
    } catch (err) {
      // Dọn dẹp tiến trình nếu không vượt qua readiness probe
      await this.stopService(pid).catch(() => {});
      const recentStderr = stderrLogs.slice(-10).join('');
      const recentStdout = stdoutLogs.slice(-10).join('');
      const debugInfo = recentStderr || recentStdout || '(không có log xuất ra)';
      throw new Error(
        `Khởi động service thất bại (PID ${pid}, Cổng ${assignedPort}): ${err.message}. Chi tiết log gần nhất: ${debugInfo}`
      );
    }
  }

  /**
   * Dừng an toàn tiến trình bằng tree-kill 2 giai đoạn (SIGTERM -> chờ 5s -> SIGKILL)
   * @param {number} pid PID của tiến trình cần dừng
   * @returns {Promise<void>}
   */
  stopService(pid) {
    return new Promise((resolve, reject) => {
      const record = this.activeServices.get(pid);
      if (!record && !this._isPidRunning(pid)) {
        this.activeServices.delete(pid);
        resolve();
        return;
      }

      let isResolved = false;

      // Giai đoạn 1: Gửi SIGTERM
      treeKill(pid, 'SIGTERM', (termErr) => {
        if (termErr) {
          // Thử ép buộc với SIGKILL nếu SIGTERM báo lỗi
          treeKill(pid, 'SIGKILL', (killErr) => {
            this.activeServices.delete(pid);
            this.emit('service_stopped', { pid });
            if (killErr) {
              // Bỏ qua lỗi ESRCH nếu tiến trình đã dừng
              if (killErr.message && killErr.message.includes('ESRCH')) {
                resolve();
              } else {
                resolve();
              }
            } else {
              resolve();
            }
          });
          return;
        }

        // Thiết lập Watchdog: Chờ tối đa 5 giây cho SIGTERM, nếu chưa dừng thì cưỡng chế bằng SIGKILL
        const forceKillTimer = setTimeout(() => {
          if (isResolved) return;
          treeKill(pid, 'SIGKILL', () => {
            this.activeServices.delete(pid);
            this.emit('service_stopped', { pid, forced: true });
            isResolved = true;
            resolve();
          });
        }, 5000);

        // Kiểm tra định kỳ xem process đã kết thúc chưa
        const checkInterval = setInterval(() => {
          if (!this._isPidRunning(pid)) {
            clearInterval(checkInterval);
            clearTimeout(forceKillTimer);
            if (!isResolved) {
              isResolved = true;
              this.activeServices.delete(pid);
              this.emit('service_stopped', { pid });
              resolve();
            }
          }
        }, 300);
      });
    });
  }

  /**
   * Dừng toàn bộ các service đang được quản lý
   * @returns {Promise<void>}
   */
  async stopAll() {
    const pids = Array.from(this.activeServices.keys());
    for (const pid of pids) {
      try {
        await this.stopService(pid);
      } catch (err) {
        // Tiếp tục dừng các tiến trình khác
      }
    }
  }

  /**
   * Kiểm tra một PID có đang tồn tại trên hệ thống hay không
   * @param {number} pid PID cần kiểm tra
   * @returns {boolean}
   */
  _isPidRunning(pid) {
    try {
      return process.kill(pid, 0);
    } catch (e) {
      return false;
    }
  }

  /**
   * Lấy thông tin service theo PID
   * @param {number} pid
   * @returns {Object|null}
   */
  getService(pid) {
    return this.activeServices.get(pid) || null;
  }

  /**
   * Lấy danh sách tất cả service đang quản lý
   * @returns {Array<Object>}
   */
  getActiveServices() {
    return Array.from(this.activeServices.values());
  }

  /**
   * Lấy toàn bộ log của một service
   * @param {number} pid
   * @returns {{ stdout: string[], stderr: string[] }}
   */
  getServiceLogs(pid) {
    const record = this.activeServices.get(pid);
    if (!record) {
      return { stdout: [], stderr: [] };
    }
    return {
      stdout: [...record.stdoutLogs],
      stderr: [...record.stderrLogs]
    };
  }
}

module.exports = {
  LocalServiceManager
};
