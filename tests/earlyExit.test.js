/**
 * tests/earlyExit.test.js
 * Kiểm tra cơ chế Early-Exit tự động đóng tiến trình an toàn khi phát hiện tín hiệu hoàn tất từ Agent.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const BaseAdapter = require('../src/runners/baseAdapter');

describe('BaseAdapter Early-Exit Suite', () => {
  const mockCliPath = path.resolve(__dirname, 'mocks/mock-agent-cli.js');

  class TestRunner extends BaseAdapter {
    constructor() {
      super('test-early-exit-runner', process.execPath);
    }
    buildArgs(prompt, options = {}) {
      return [mockCliPath, ...(options.extraArgs || [])];
    }
  }

  it('Tự động ngắt an toàn và trả về exitCode: 0 khi phát hiện [TOOL CALL] yield', async () => {
    const runner = new TestRunner();
    const stdoutLogs = [];

    const startTime = Date.now();
    const result = await runner.execute({
      jobId: 'test-job-yield',
      extraArgs: ['--emit-yield', '--sleep', '30000'],
      onStdout: (data) => stdoutLogs.push(data)
    });
    const duration = Date.now() - startTime;

    // Phải ngắt trong khoảng 6 - 10s (grace period 6s + overhead), không bị treo tới 30s
    assert.ok(duration < 15000, `Tiến trình phải hoàn thành sớm (duration: ${duration}ms < 15000ms)`);
    assert.strictEqual(result.exitCode, 0, 'exitCode phải được đánh dấu 0 (thành công)');
    assert.strictEqual(result.timedOut, false, 'timedOut phải là false');
    assert.strictEqual(result.status, 'COMPLETED', 'status phải là COMPLETED');

    const fullLog = stdoutLogs.join('');
    assert.ok(
      fullLog.includes('[EARLY-EXIT] Phát hiện tín hiệu hoàn tất từ Agent (yield / Status: DONE). Đã tự động kết thúc tiến trình an toàn.'),
      'Phải emit thông báo [EARLY-EXIT] ra log'
    );
  });

  it('Tự động ngắt an toàn và trả về exitCode: 0 khi phát hiện Status: DONE', async () => {
    const runner = new TestRunner();
    const stdoutLogs = [];

    const startTime = Date.now();
    const result = await runner.execute({
      jobId: 'test-job-done',
      extraArgs: ['--emit-done', '--sleep', '30000'],
      onStdout: (data) => stdoutLogs.push(data)
    });
    const duration = Date.now() - startTime;

    assert.ok(duration < 15000, `Tiến trình phải hoàn thành sớm (duration: ${duration}ms < 15000ms)`);
    assert.strictEqual(result.exitCode, 0, 'exitCode phải được đánh dấu 0 (thành công)');
    assert.strictEqual(result.timedOut, false, 'timedOut phải là false');
    assert.strictEqual(result.status, 'COMPLETED', 'status phải là COMPLETED');

    const fullLog = stdoutLogs.join('');
    assert.ok(
      fullLog.includes('[EARLY-EXIT] Phát hiện tín hiệu hoàn tất từ Agent (yield / Status: DONE). Đã tự động kết thúc tiến trình an toàn.'),
      'Phải emit thông báo [EARLY-EXIT] ra log'
    );
  });

  it('Tiến trình kết thúc tự nhiên trước grace period không bị coi là lỗi', async () => {
    const runner = new TestRunner();
    const result = await runner.execute({
      jobId: 'test-job-normal',
      extraArgs: ['--emit-done'] // không có sleep, kết thúc ngay lập tức
    });

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.timedOut, false);
  });
});
