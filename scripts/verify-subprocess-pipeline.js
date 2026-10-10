/**
 * scripts/verify-subprocess-pipeline.js
 * 
 * Kịch bản kiểm thử tích hợp toàn diện (E2E Verification Pipeline):
 * 1. Khởi tạo Express server và kết nối cơ sở dữ liệu SQLite (node:sqlite).
 * 2. Tạo một Job thử nghiệm với prompt dài (> 150 ký tự) có chứa chuỗi bí mật (API key).
 * 3. Kiểm tra cơ chế tự động ghi tệp .task_prompt.txt trong thư mục workspace/repo chống tràn bộ đệm Windows.
 * 4. Kích hoạt tiến trình subprocess an toàn trên Host OS Windows, mô phỏng Agent CLI in log chứa token.
 * 5. Thẩm định luồng stdout/stderr được làm sạch thời gian thực qua SecretScrubber (token -> ***MASKED***).
 * 6. Kiểm tra cơ chế giám sát PID và 2-phase safe tree-kill (SIGTERM -> grace period -> SIGKILL).
 * 7. Kích hoạt MultiVerificationGate để thẩm định độc lập 4 kênh:
 *    - Kênh 1: UI Screenshot Verifier (UiEvidenceCollector)
 *    - Kênh 2: API Test Runner (ApiTestRunner)
 *    - Kênh 3: Log Scanner (LogScanner)
 *    - Kênh 4: Database Verifier (DatabaseVerifier)
 * 8. Tổng hợp và báo cáo kết quả chi tiết từng giai đoạn (PASS/FAIL).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

// Import các module cốt lõi từ src
const { initDb, getDb, createJob, getJobById } = require('../src/storage/db');
const { app } = require('../src/server');
const { defaultProcessManager, ProcessManager, isPidRunning } = require('../src/execution/processManager');
const { SecretScrubber, maskSecrets } = require('../src/execution/secretScrubber');
const BaseAdapter = require('../src/runners/baseAdapter');
const { MultiVerificationGate } = require('../src/verification/multiVerificationGate');
const config = require('../src/config');

// Mã màu ANSI phục vụ in kết quả ra terminal trực quan
const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m'
};

function logHeader(text) {
  console.log(`\n${COLORS.bold}${COLORS.cyan}================================================================================${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}>>> ${text}${COLORS.reset}`);
  console.log(`${COLORS.bold}${COLORS.cyan}================================================================================${COLORS.reset}`);
}

function logStep(stepNum, title) {
  console.log(`\n${COLORS.bold}${COLORS.yellow}[GIAI ĐOẠN ${stepNum}] ${title}${COLORS.reset}`);
}

function logSuccess(message) {
  console.log(`  ${COLORS.green}✔ [PASS] ${message}${COLORS.reset}`);
}

function logFailure(message) {
  console.log(`  ${COLORS.red}✖ [FAIL] ${message}${COLORS.reset}`);
}

function logInfo(message) {
  console.log(`  ${COLORS.gray}ℹ [INFO] ${message}${COLORS.reset}`);
}

// 1x1 Transparent PNG binary buffer chuẩn (68 bytes) để làm mock evidence
const MOCK_PNG_BUFFER = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C489' +
  '0000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082',
  'hex'
);

/**
 * Adapter mô phỏng dùng trong kiểm thử kế thừa BaseAdapter
 */
class VerifyMockCliAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('verify-mock-agent', process.execPath, options);
    this.secretTokenToEcho = options.secretToken || '';
  }

  detect() {
    return {
      installed: true,
      version: process.version,
      path: process.execPath
    };
  }

  buildArgs(prompt, options = {}) {
    const cwd = options.cwd || process.cwd();
    const mockScriptPath = path.join(cwd, '.mock_agent_runner.js');
    const mockCliCode = [
      'console.log("[AGENT_CLI_INIT] Agent CLI khoi dong thanh cong tren Host OS.");',
      `console.log("[AGENT_CLI_CONFIG] API_KEY = " + ${JSON.stringify(this.secretTokenToEcho)});`,
      `console.log("[AGENT_CLI_PROMPT] Nhap yeu cau: " + ${JSON.stringify(prompt.slice(0, 80))} + "...");`,
      `console.error("[AGENT_CLI_STDERR] Warning diagnostic token: " + ${JSON.stringify(this.secretTokenToEcho)});`,
      'console.log("[AGENT_CLI_EXEC] Dang phan tich ma nguon va sinh artifacts...");',
      'console.log("[AGENT_CLI_DONE] Hoan tat thuc thi agent cong viec.");'
    ].join('\n');
    fs.writeFileSync(mockScriptPath, mockCliCode, 'utf-8');
    return [mockScriptPath];
  }
}

async function runPipelineVerification() {
  const startTime = Date.now();
  const summaryReport = [];
  let testServer = null;
  let serverBaseUrl = '';
  let tempWorkspaceDir = '';

  logHeader('BẮT ĐẦU KIỂM THỬ E2E SUBPROCESS PIPELINE & AGENT CODE');
  console.log(`Hệ điều hành: ${process.platform} (${process.arch})`);
  console.log(`Node.js Runtime: ${process.version}`);
  console.log(`Thư mục làm việc: ${process.cwd()}`);

  try {
    // ------------------------------------------------------------------------
    // GIAI ĐOẠN 1: Khởi tạo Express Server & SQLite Database
    // ------------------------------------------------------------------------
    logStep(1, 'Khởi tạo Express Server và Cơ sở dữ liệu SQLite');

    // 1.1 Khởi tạo SQLite DB
    logInfo('Đang khởi tạo cơ sở dữ liệu SQLite qua initDb()...');
    initDb();
    const db = getDb();
    if (!db || typeof db.prepare !== 'function') {
      throw new Error('Không thể kết nối hoặc khởi tạo SQLite DatabaseSync!');
    }
    logSuccess(`Cơ sở dữ liệu SQLite đã sẵn sàng (đường dẫn: ${config.DB_PATH})`);

    // 1.2 Khởi động Express HTTP Server
    logInfo('Đang khởi chạy HTTP Server phục vụ REST API trên cổng khả dụng...');
    await new Promise((resolve, reject) => {
      // Lắng nghe trên cổng ngẫu nhiên do OS cấp phát để tránh xung đột cổng
      testServer = app.listen(0, '127.0.0.1', () => {
        const address = testServer.address();
        serverBaseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
      testServer.on('error', reject);
    });
    logSuccess(`Express HTTP Server đang lắng nghe tại: ${serverBaseUrl}`);

    // Tạo thư mục workspace cô lập phục vụ test
    tempWorkspaceDir = path.join(os.tmpdir(), `ai-worker-verify-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tempWorkspaceDir, { recursive: true });
    logInfo(`Thư mục workspace cô lập: ${tempWorkspaceDir}`);

    summaryReport.push({ step: '1. Khởi tạo Server & Database', passed: true });

    // ------------------------------------------------------------------------
    // GIAI ĐOẠN 2: Tạo Job thử nghiệm với Prompt dài (> 150 ký tự) & Chuỗi bí mật
    // ------------------------------------------------------------------------
    logStep(2, 'Tạo Job thử nghiệm với prompt dài và chuỗi bí mật (API Key)');

    const FAKE_SECRET_TOKEN = 'sk-ant-api03-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const LONG_SECRET_PROMPT = 
      `Kịch bản kiểm thử quy trình thực thi tự động của AI Agent Worker trên nền tảng Windows. ` +
      `Mục tiêu chính: Thẩm định khả năng phân tích mã nguồn, tạo kế hoạch và ngăn chặn rò rỉ bảo mật. ` +
      `Yêu cầu an toàn thông tin tối cao: Tuyệt đối không được in hoặc lưu lại khóa bí mật Anthropic: ` +
      `${FAKE_SECRET_TOKEN} trong bất kỳ tệp log, console, hay bằng chứng kiểm thử nào. ` +
      `Tất cả luồng dữ liệu đều phải được lọc qua bộ làm sạch chuyên dụng trước khi chuyển tiếp ra ngoài.`;

    logInfo(`Độ dài của prompt kiểm thử: ${LONG_SECRET_PROMPT.length} ký tự (yêu cầu > 150 ký tự)`);
    if (LONG_SECRET_PROMPT.length <= 150) {
      throw new Error('Prompt kiểm thử không đủ độ dài > 150 ký tự theo yêu cầu!');
    }

    const testJob = createJob({
      task_code: 'TASK-E2E-VERIFY',
      title: 'Xác thực E2E Subprocess Pipeline & Security Masking',
      prompt: LONG_SECRET_PROMPT,
      repo_path: tempWorkspaceDir,
      runner: 'claude-code',
      status: 'PLANNING'
    });

    if (!testJob || !testJob.id) {
      throw new Error('Không tạo được Job trong SQLite!');
    }

    // Xác thực lại trong CSDL
    const savedJob = getJobById(testJob.id);
    if (!savedJob || savedJob.id !== testJob.id) {
      throw new Error(`Job ${testJob.id} không tìm thấy trong SQLite sau khi tạo!`);
    }

    logSuccess(`Job đã được tạo thành công trong SQLite với ID: ${testJob.id}`);
    logSuccess(`Task Code: ${testJob.task_code} | Status: ${testJob.status}`);
    summaryReport.push({ step: '2. Tạo Job trong SQLite với prompt dài', passed: true });

    // ------------------------------------------------------------------------
    // GIAI ĐOẠN 3: Kiểm tra việc tạo tệp .task_prompt.txt trong workspace
    // ------------------------------------------------------------------------
    logStep(3, 'Kiểm tra cơ chế chống tràn bộ đệm Windows: Tạo tệp .task_prompt.txt');

    const expectedPromptFile = path.join(tempWorkspaceDir, '.task_prompt.txt');
    logInfo(`Đường dẫn tệp mong đợi: ${expectedPromptFile}`);

    // Khởi tạo adapter kế thừa BaseAdapter với token bí mật
    const mockAdapter = new VerifyMockCliAdapter({
      secretToken: FAKE_SECRET_TOKEN
    });

    let capturedStdout = '';
    let capturedStderr = '';

    // Thực thi adapter để kích hoạt cơ chế ghi .task_prompt.txt và spawn process
    logInfo('Kích hoạt mockAdapter.execute() với prompt dài...');
    const execResult = await mockAdapter.execute({
      prompt: LONG_SECRET_PROMPT,
      cwd: tempWorkspaceDir,
      jobId: testJob.id,
      onStdout: (chunk) => {
        capturedStdout += chunk;
      },
      onStderr: (chunk) => {
        capturedStderr += chunk;
      }
    });

    // Kiểm tra sự tồn tại của tệp .task_prompt.txt
    if (!fs.existsSync(expectedPromptFile)) {
      throw new Error(`Tệp .task_prompt.txt KHÔNG được tạo tại ${expectedPromptFile}!`);
    }

    const savedPromptContent = fs.readFileSync(expectedPromptFile, 'utf-8');
    if (savedPromptContent !== LONG_SECRET_PROMPT) {
      throw new Error('Nội dung tệp .task_prompt.txt không khớp hoàn toàn với prompt gốc!');
    }

    logSuccess('Tệp .task_prompt.txt đã được tạo tự động và lưu đúng nội dung prompt.');
    logSuccess(`Dung lượng tệp .task_prompt.txt: ${Buffer.byteLength(savedPromptContent, 'utf-8')} bytes.`);
    summaryReport.push({ step: '3. Tạo tệp an toàn .task_prompt.txt', passed: true });

    // ------------------------------------------------------------------------
    // GIAI ĐOẠN 4: Thẩm định SecretScrubber trên luồng stdout/stderr của Subprocess
    // ------------------------------------------------------------------------
    logStep(4, 'Thẩm định SecretScrubber lọc chuỗi bí mật trên stdout/stderr');

    logInfo('Dữ liệu thu thập từ stdout:\n' + capturedStdout.trim());
    logInfo('Dữ liệu thu thập từ stderr:\n' + capturedStderr.trim());

    // 4.1 Kiểm tra chuỗi gốc hoàn toàn biến mất
    const stdoutContainsRaw = capturedStdout.includes(FAKE_SECRET_TOKEN);
    const stderrContainsRaw = capturedStderr.includes(FAKE_SECRET_TOKEN);

    if (stdoutContainsRaw || stderrContainsRaw) {
      throw new Error(`RÒ RỈ BẢO MẬT: Token gốc "${FAKE_SECRET_TOKEN}" vẫn còn xuất hiện trong luồng output!`);
    }
    logSuccess('Xác nhận: Token bí mật gốc KHÔNG xuất hiện trong stdout và stderr.');

    // 4.2 Kiểm tra chuỗi ***MASKED*** đã được thay thế
    const stdoutMasked = capturedStdout.includes('***MASKED***');
    const stderrMasked = capturedStderr.includes('***MASKED***');

    if (!stdoutMasked && !stderrMasked) {
      throw new Error('Không tìm thấy chuỗi thay thế "***MASKED***" trong output!');
    }
    logSuccess('Xác nhận: Chuỗi bí mật đã được chuyển đổi thành "***MASKED***" thành công.');

    // 4.3 Kiểm tra trực tiếp class SecretScrubber độc lập
    const scrubberInstance = new SecretScrubber();
    const testDirectText = `Anthropic key: ${FAKE_SECRET_TOKEN} and generic sk: sk-1234567890abcdef1234567890`;
    const cleanedDirectText = scrubberInstance.scrub(testDirectText);
    if (cleanedDirectText.includes(FAKE_SECRET_TOKEN)) {
      throw new Error('Lỗi trong SecretScrubber.scrub()!');
    }
    logSuccess('Xác nhận: SecretScrubber xử lý độc lập đạt chuẩn bảo mật.');
    summaryReport.push({ step: '4. SecretScrubber lọc chuỗi bí mật', passed: true });

    // ------------------------------------------------------------------------
    // GIAI ĐOẠN 5: Kiểm tra giám sát PID và 2-phase Safe Tree-Kill
    // ------------------------------------------------------------------------
    logStep(5, 'Kiểm tra cơ chế giám sát PID và 2-phase Safe Tree-Kill');

    const customProcManager = new ProcessManager();

    // 5.1 Khởi chạy tiến trình nền chạy lặp vô tận
    logInfo('Khởi chạy tiến trình nền chạy lặp vô tận (watchdog target)...');
    const bgProc = customProcManager.spawnProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => { console.log("tick"); }, 200);'],
      cwd: tempWorkspaceDir,
      jobId: testJob.id
    });

    const targetPid = bgProc.pid;
    logInfo(`Tiến trình nền đã được cấp phát PID: ${targetPid}`);

    if (!targetPid || typeof targetPid !== 'number') {
      throw new Error('Không lấy được PID hợp lệ từ tiến trình con!');
    }

    // 5.2 Kiểm tra trạng thái PID đang chạy
    const isRunningBefore = isPidRunning(targetPid);
    if (!isRunningBefore) {
      throw new Error(`Tiến trình với PID ${targetPid} không được ghi nhận là đang chạy!`);
    }
    logSuccess(`Xác nhận: Tiến trình PID ${targetPid} đang hoạt động bình thường.`);

    // 5.3 Thực hiện 2-phase safe tree-kill
    logInfo(`Kích hoạt 2-phase safe tree-kill trên PID ${targetPid} với grace period 800ms...`);
    const killResult = await bgProc.kill('SIGTERM', 800);
    logInfo(`Kết quả gọi kill: ${JSON.stringify(killResult)}`);

    // Chờ 300ms để hệ điều hành dọn dẹp tiến trình
    await new Promise(r => setTimeout(r, 300));

    // 5.4 Kiểm tra tiến trình đã chấm dứt
    const isRunningAfter = isPidRunning(targetPid);
    if (isRunningAfter) {
      throw new Error(`Tiến trình PID ${targetPid} vẫn còn tồn tại sau khi gọi 2-phase tree-kill!`);
    }
    logSuccess(`Xác nhận: Tiến trình PID ${targetPid} đã bị ngắt an toàn và dọn dẹp hoàn toàn.`);
    summaryReport.push({ step: '5. Giám sát PID và Safe Tree-Kill', passed: true });

    // ------------------------------------------------------------------------
    // GIAI ĐOẠN 6: Kích hoạt MultiVerificationGate thẩm định 4 kênh
    // ------------------------------------------------------------------------
    logStep(6, 'Kích hoạt MultiVerificationGate thẩm định 4 kênh độc lập');

    // 6.1 Chuẩn bị kênh 1 (UI Screenshot)
    const evidenceDir = path.join(tempWorkspaceDir, 'feature', 'TASK-E2E-VERIFY', 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    
    // Ghi file ảnh screenshot hợp lệ (> 0 bytes)
    const screenshotPath = path.join(evidenceDir, 'dashboard-overview.png');
    fs.writeFileSync(screenshotPath, MOCK_PNG_BUFFER);
    
    // Ghi file metadata.json hợp lệ không có visual defects
    const metadataPath = path.join(evidenceDir, 'metadata.json');
    fs.writeFileSync(metadataPath, JSON.stringify({
      hasVisualDefects: false,
      consoleErrors: [],
      timestamp: new Date().toISOString()
    }, null, 2));

    logInfo(`Đã tạo bằng chứng UI tại: ${evidenceDir}`);

    // 6.2 Cấu hình MultiVerificationGate
    const gate = new MultiVerificationGate({
      dbInstance: db
    });

    // Lắng nghe sự kiện từ Gate
    gate.on('verification_started', (e) => logInfo(`Gate started: ${e.featureName}`));
    gate.on('gate_passed', (e) => logSuccess(`Sự kiện Gate Passed: ${e.featureName}`));
    gate.on('gate_failed', (e) => logFailure(`Sự kiện Gate Failed: ${e.summary}`));

    const cleanLogs = `${capturedStdout}\n${capturedStderr}\n[INFO] All tasks finished cleanly and successfully without unhandled exceptions.`;

    logInfo('Đang chạy evaluateAll trên cả 4 kênh...');
    const gateResult = await gate.evaluateAll({
      featureName: 'TASK-E2E-VERIFY',
      baseUrl: serverBaseUrl,
      jobId: testJob.id,
      testPlan: {
        evidenceDir,
        uiCheckpoints: [
          { id: 'dashboard-overview', name: 'Dashboard Overview Screen' }
        ],
        apiTestSuite: [
          {
            name: 'API Health Endpoint Check',
            method: 'GET',
            path: '/api/v1/health',
            expectedStatus: 200
          },
          {
            name: 'API Job Detail Check',
            method: 'GET',
            path: `/api/v1/jobs/${testJob.id}`,
            expectedStatus: 200
          }
        ],
        dbAssertions: [
          {
            name: 'Xác thực Job tồn tại trong CSDL SQLite',
            query: 'SELECT id, task_code, status FROM jobs WHERE id = ?',
            params: [testJob.id],
            expectedRowCount: 1,
            expectedValues: {
              id: testJob.id,
              task_code: 'TASK-E2E-VERIFY'
            }
          }
        ]
      },
      logs: cleanLogs,
      dbConfig: null,
      retryAttempt: 1
    });

    console.log('\n--- KẾT QUẢ ĐÁNH GIÁ 4 KÊNH ---');
    console.log(`1. UI Channel:     ${gateResult.channels.ui.passed ? COLORS.green + 'PASSED' : COLORS.red + 'FAILED'}${COLORS.reset} - ${gateResult.channels.ui.summary}`);
    console.log(`2. API Channel:    ${gateResult.channels.api.passed ? COLORS.green + 'PASSED' : COLORS.red + 'FAILED'}${COLORS.reset} - ${gateResult.channels.api.summary}`);
    console.log(`3. Log Scanner:    ${gateResult.channels.log.passed ? COLORS.green + 'PASSED' : COLORS.red + 'FAILED'}${COLORS.reset} - ${gateResult.channels.log.summary}`);
    console.log(`4. Database Ver:   ${gateResult.channels.db.passed ? COLORS.green + 'PASSED' : COLORS.red + 'FAILED'}${COLORS.reset} - ${gateResult.channels.db.summary}`);

    if (!gateResult.passed) {
      throw new Error(`MultiVerificationGate THẤT BẠI: ${gateResult.summary}`);
    }

    logSuccess('MultiVerificationGate HOÀN TẤT: 100% cả 4 kênh đều đạt điều kiện PASS.');
    summaryReport.push({ step: '6. MultiVerificationGate 4 kênh', passed: true });

  } catch (err) {
    console.error(`\n${COLORS.red}${COLORS.bold}LỖI TRONG QUÁ TRÌNH KIỂM THỬ: ${err.message}${COLORS.reset}`);
    if (err.stack) {
      console.error(`${COLORS.gray}${err.stack}${COLORS.reset}`);
    }
    summaryReport.push({ step: 'Quy trình kiểm thử', passed: false, error: err.message });
  } finally {
    // Dọn dẹp tài nguyên
    if (testServer) {
      logInfo('Đóng Express HTTP Server...');
      testServer.close();
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logHeader(`TỔNG KẾT KẾT QUẢ KIỂM THỬ PIPELINE (${duration}s)`);

    let allPassed = true;
    for (const item of summaryReport) {
      const statusIcon = item.passed ? `${COLORS.green}✔ PASS${COLORS.reset}` : `${COLORS.red}✖ FAIL${COLORS.reset}`;
      console.log(`  [${statusIcon}] ${item.step}`);
      if (!item.passed) {
        allPassed = false;
      }
    }

    console.log('\n--------------------------------------------------------------------------------');
    if (allPassed) {
      console.log(`${COLORS.bold}${COLORS.green}🎉 TẤT CẢ CÁC BƯỚC KIỂM THỬ ĐÃ VƯỢT QUA THÀNH CÔNG (E2E PIPELINE PASSED)!${COLORS.reset}`);
      console.log('--------------------------------------------------------------------------------\n');
      process.exit(0);
    } else {
      console.log(`${COLORS.bold}${COLORS.red}❌ KẾT QUẢ KIỂM THỬ KHÔNG ĐẠT YÊU CẦU.${COLORS.reset}`);
      console.log('--------------------------------------------------------------------------------\n');
      process.exit(1);
    }
  }
}

// Chạy trực tiếp nếu script được gọi qua command line
if (require.main === module) {
  runPipelineVerification();
}

module.exports = {
  runPipelineVerification,
  VerifyMockCliAdapter
};
