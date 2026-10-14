/**
 * tests/processManager.test.js
 * Kiểm thử tự động ProcessManager, isPidRunning, và SecretScrubber.
 * Tuân thủ chuẩn Node.js 22+ (node:test, node:assert/strict).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { ProcessManager, isPidRunning } = require('../src/execution/processManager');
const { SecretScrubber, maskSecrets } = require('../src/execution/secretScrubber');

describe('ProcessManager & Subprocess Execution Test Suite', () => {
  let testTempDir;
  const mockCliPath = path.resolve(__dirname, 'mocks/mock-agent-cli.js');

  before(() => {
    // Tạo thư mục tạm cô lập cho test
    testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-worker-proc-test-'));
  });

  after(() => {
    // Dọn dẹp thư mục tạm
    if (testTempDir && fs.existsSync(testTempDir)) {
      try {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      } catch (err) {
        // Bỏ qua lỗi dọn dẹp nếu có file lock tạm thời
      }
    }
  });

  it('Test 1: Khởi chạy mock-agent-cli.js, bắt stdout, kiểm tra sự kiện exit, mã thoát 0', async () => {
    const pm = new ProcessManager();
    const stdoutChunks = [];
    let spawnEventData = null;
    let exitEventData = null;

    pm.on('spawn', (data) => {
      spawnEventData = data;
    });

    pm.on('stdout', (data) => {
      stdoutChunks.push(data.data);
    });

    pm.on('exit', (data) => {
      exitEventData = data;
    });

    const handle = pm.spawnProcess({
      command: process.execPath,
      args: [mockCliPath],
      cwd: testTempDir,
      jobId: 'job-test-01'
    });

    assert.ok(handle.pid > 0, 'Handle phải chứa PID hợp lệ');
    assert.strictEqual(typeof handle.wait, 'function', 'Handle phải có hàm wait()');

    const result = await handle.wait();

    // Thẩm định kết quả thực thi
    assert.strictEqual(result.exitCode, 0, 'Exit code phải là 0');
    assert.strictEqual(result.status, 'COMPLETED', 'Trạng thái tiến trình phải là COMPLETED');
    assert.strictEqual(result.timedOut, false, 'Không được đánh dấu timedOut');

    // Thẩm định sự kiện spawn và exit
    assert.ok(spawnEventData !== null, 'Sự kiện spawn phải được phát');
    assert.strictEqual(spawnEventData.pid, handle.pid, 'PID trong sự kiện spawn phải khớp');
    assert.strictEqual(spawnEventData.jobId, 'job-test-01', 'jobId trong sự kiện spawn phải khớp');

    assert.ok(exitEventData !== null, 'Sự kiện exit phải được phát');
    assert.strictEqual(exitEventData.pid, handle.pid, 'PID trong sự kiện exit phải khớp');
    assert.strictEqual(exitEventData.exitCode, 0, 'Mã thoát trong sự kiện exit phải là 0');
    assert.strictEqual(exitEventData.status, 'COMPLETED', 'Trạng thái trong sự kiện exit phải là COMPLETED');

    // Thẩm định dữ liệu stdout
    const fullStdout = stdoutChunks.join('') + result.stdout;
    assert.ok(
      fullStdout.includes('[MOCK_CLI] Hoàn tất thực thi thành công'),
      'Stdout phải ghi nhận hoàn tất thực thi từ mock-agent-cli'
    );
  });

  it('Test 2: Khởi chạy với cờ --simulate-secret, thẩm định SecretScrubber che giấu token', async () => {
    const pm = new ProcessManager();
    const rawSecret = 'sk-test-secret-123456789';

    // 1. Kiểm tra trực tiếp maskSecrets độc lập
    const maskedText = maskSecrets(`API_KEY=${rawSecret}`);
    assert.ok(!maskedText.includes(rawSecret), 'maskSecrets không được để lộ secret gốc');
    assert.ok(maskedText.includes('***MASKED***'), 'maskSecrets phải thay secret bằng ***MASKED***');

    // Kiểm tra SecretScrubber với scrubEnv
    const scrubber = new SecretScrubber();
    const scrubbedEnv = scrubber.scrubEnv({
      ANTHROPIC_API_KEY: rawSecret,
      SAFE_CONFIG: 'production-mode'
    });
    assert.strictEqual(scrubbedEnv.ANTHROPIC_API_KEY, '***MASKED***');
    assert.strictEqual(scrubbedEnv.SAFE_CONFIG, 'production-mode');

    // 2. Khởi chạy mock-agent-cli với cờ --simulate-secret qua ProcessManager
    let interceptedStdout = '';
    let interceptedStderr = '';

    const handle = pm.spawnProcess({
      command: process.execPath,
      args: [mockCliPath, '--simulate-secret'],
      cwd: testTempDir,
      onStdout: (text) => {
        interceptedStdout += text;
      },
      onStderr: (text) => {
        interceptedStderr += text;
      }
    });

    const result = await handle.wait();

    assert.strictEqual(result.exitCode, 0, 'Tiến trình phải thoát mã 0');

    // Xác thực tuyệt đối không lộ secret gốc trong cả stdoutBuffer và callback
    assert.ok(!result.stdout.includes(rawSecret), 'result.stdout không được để lộ secret gốc');
    assert.ok(!result.stderr.includes(rawSecret), 'result.stderr không được để lộ secret gốc');
    assert.ok(!interceptedStdout.includes(rawSecret), 'Callback onStdout không được để lộ secret gốc');
    assert.ok(!interceptedStderr.includes(rawSecret), 'Callback onStderr không được để lộ secret gốc');

    // Xác thực đã được che giấu bằng ***MASKED***
    assert.ok(result.stdout.includes('***MASKED***'), 'result.stdout phải chứa ***MASKED***');
    assert.ok(result.stderr.includes('***MASKED***'), 'result.stderr phải chứa ***MASKED***');
  });

  it('Test 3: Khởi chạy với --long-running, kiểm tra killProcess() với SIGTERM và kiểm tra isPidRunning(pid) chuyển sang false', async () => {
    const pm = new ProcessManager();
    let exitEventFired = false;

    pm.on('exit', (data) => {
      exitEventFired = true;
    });

    const handle = pm.spawnProcess({
      command: process.execPath,
      args: [mockCliPath, '--long-running'],
      cwd: testTempDir,
      jobId: 'job-kill-test'
    });

    // Chờ 300ms để tiến trình khởi động hoàn toàn
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Thẩm định tiến trình đang hoạt động
    assert.strictEqual(isPidRunning(handle.pid), true, 'isPidRunning(pid) phải trả về true khi tiến trình đang chạy');

    // Gọi killProcess
    const killResult = await pm.killProcess(handle.pid, 'SIGTERM', 3000);
    assert.strictEqual(killResult, true, 'killProcess phải trả về true');

    const result = await handle.wait();
    assert.strictEqual(result.status, 'KILLED', 'Trạng thái tiến trình phải chuyển thành KILLED');

    // Chờ ngắn để OS cập nhật trạng thái process table
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.strictEqual(isPidRunning(handle.pid), false, 'isPidRunning(pid) phải trả về false sau khi kill');
    assert.ok(exitEventFired, 'Sự kiện exit phải được phát khi ngắt tiến trình');
  });

  it('Test 4: Kiểm tra timeout watchdog của ProcessManager tự động ngắt tiến trình khi vượt quá timeoutMs', async () => {
    const pm = new ProcessManager();
    let timeoutEventFired = false;
    let timeoutData = null;

    pm.on('timeout', (data) => {
      timeoutEventFired = true;
      timeoutData = data;
    });

    const handle = pm.spawnProcess({
      command: process.execPath,
      args: [mockCliPath, '--sleep', '8000'],
      cwd: testTempDir,
      jobId: 'job-timeout-test',
      timeoutMs: 500 // Watchdog 500ms
    });

    const result = await handle.wait();

    assert.strictEqual(result.timedOut, true, 'Thuộc tính timedOut phải là true');
    assert.strictEqual(result.status, 'TIMED_OUT', 'Trạng thái phải là TIMED_OUT');
    assert.ok(timeoutEventFired, 'Sự kiện timeout phải được phát');
    assert.strictEqual(timeoutData.pid, handle.pid, 'PID trong sự kiện timeout phải trùng khớp');
    assert.strictEqual(timeoutData.jobId, 'job-timeout-test', 'jobId trong sự kiện timeout phải trùng khớp');

    // Chờ ngắn để đảm bảo tiến trình đã bị dọn dẹp
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(isPidRunning(handle.pid), false, 'Tiến trình phải bị ngắt hoàn toàn sau watchdog timeout');
  });
  it('Test 5: Cancel job -> killProcessesByJobId ngắt đúng toàn bộ tiến trình con của job', async () => {
    const pm = new ProcessManager();
    const targetJobId = 'job-cancel-test-42';
    let killedEventData = null;

    pm.on('killed', (data) => {
      killedEventData = data;
    });

    const handle = pm.spawnProcess({
      command: process.execPath,
      args: [mockCliPath, '--long-running'],
      cwd: testTempDir,
      jobId: targetJobId,
      timeoutMs: 30000
    });

    // Đảm bảo tiến trình đang chạy và được quản lý theo jobId
    assert.ok(isPidRunning(handle.pid), 'Tiến trình phải đang chạy');
    const activeProcs = pm.getProcessesByJobId(targetJobId);
    assert.strictEqual(activeProcs.length, 1, 'Phải tìm thấy 1 tiến trình của targetJobId');
    assert.strictEqual(activeProcs[0].pid, handle.pid, 'PID phải khớp với handle');

    // Kích hoạt hủy job: gọi killProcessesByJobId (tree-kill SIGTERM -> SIGKILL)
    const killedCount = await pm.killProcessesByJobId(targetJobId, 2000);
    assert.strictEqual(killedCount, 1, 'Số tiến trình bị ngắt phải là 1');

    const result = await handle.wait();
    assert.strictEqual(result.status, 'KILLED', 'Trạng thái tiến trình phải chuyển sang KILLED');

    // Chờ ngắn để OS giải phóng PID
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.strictEqual(isPidRunning(handle.pid), false, 'PID không còn tồn tại sau khi bị tree-kill');
    assert.ok(killedEventData !== null, 'Sự kiện killed phải được phát ra');
    assert.strictEqual(killedEventData.jobId, targetJobId, 'jobId trong sự kiện killed phải khớp');
  });

  it('Test bổ sung: isPidRunning với các giá trị PID không hợp lệ', () => {
    assert.strictEqual(isPidRunning(null), false);
    assert.strictEqual(isPidRunning(undefined), false);
    assert.strictEqual(isPidRunning(0), false);
    assert.strictEqual(isPidRunning(-1), false);
    assert.strictEqual(isPidRunning('not-a-number'), false);
    assert.strictEqual(isPidRunning(999999999), false);
  });
});
