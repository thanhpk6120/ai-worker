/**
 * Dual Planning Generator
 * 
 * Chịu trách nhiệm trong trạng thái PLANNING:
 * - Tự động sinh đồng thời 2 bản kế hoạch: dev_plan.md và test_plan.md
 * - Kiểm tra tính nhất quán (Consistency Gate) giữa Dev Plan và Test Plan
 * - Lưu trữ các bản kế hoạch vào thư mục đích chuẩn hóa
 */

const fs = require('node:fs');
const path = require('node:path');

class DualPlanningGenerator {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseOutputDir]
   */
  constructor(options = {}) {
    this.baseOutputDir = options.baseOutputDir || path.resolve(process.cwd(), 'feature');
  }

  /**
   * Sinh kế hoạch triển khai mã nguồn (dev_plan.md)
   * 
   * @param {Object} params
   * @param {string} params.featureName - Tên tính năng (ví dụ: Create-AI-Worker)
   * @param {string} params.prompt - Mô tả yêu cầu / nghiệp vụ ban đầu
   * @param {string} [params.techStack] - Công nghệ sử dụng (Node.js, Express, ...)
   * @param {Object} [params.context] - Ngữ cảnh bổ sung (kiến trúc, phụ thuộc)
   * @returns {Object} { content, planId, featureName, architectureOverview, modules, filesToCreate, filesToModify, apiEndpoints, createdAt }
   */
  generateDevPlan({ featureName, prompt, techStack = 'Node.js 24 (CommonJS), Express', context = {} }) {
    if (!featureName) {
      throw new Error('featureName là bắt buộc khi sinh Dev Plan');
    }

    const planId = `dev-plan-${Date.now()}`;
    const createdAt = new Date().toISOString();

    // Chuẩn bị danh sách module và files mẫu dựa trên prompt/context
    const architectureOverview = context.architectureOverview || 
      `Kiến trúc Single Server mô đun hóa cho ${featureName}, chạy trên nền tảng ${techStack}. Tách biệt rõ ràng các tầng Router, Controller, Business Service, Data Access và Process Orchestration.`;

    const modules = context.modules || [
      {
        moduleName: 'Core Engine',
        responsibility: 'Quản lý vòng đời tiến trình, điều phối trạng thái và hàng đợi',
        dependencies: ['node:events', 'node:child_process']
      },
      {
        moduleName: 'Service Layer',
        responsibility: 'Hiện thực hóa các quy tắc nghiệp vụ và logic tính năng cốt lõi',
        dependencies: ['storage', 'config']
      },
      {
        moduleName: 'API & Gateway',
        responsibility: 'Cung cấp REST API endpoints và tương tác SSE/WebSocket cho client',
        dependencies: ['express', 'cors']
      }
    ];

    const filesToCreate = context.filesToCreate || [
      {
        filePath: `src/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '_')}/index.js`,
        purposeOrChanges: `Điểm khởi tạo chính cho module tính năng ${featureName}`,
        isNew: true
      },
      {
        filePath: `src/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '_')}/service.js`,
        purposeOrChanges: `Xử lý nghiệp vụ logic và tương tác dữ liệu cho ${featureName}`,
        isNew: true
      }
    ];

    const filesToModify = context.filesToModify || [
      {
        filePath: 'src/config.js',
        purposeOrChanges: 'Bổ sung biến môi trường và cấu hình cần thiết',
        isNew: false
      }
    ];

    const apiEndpoints = context.apiEndpoints || [
      {
        method: 'GET',
        path: `/api/v1/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '-')}/status`,
        description: 'Kiểm tra trạng thái sẵn sàng và thông tin tổng quan của tính năng'
      },
      {
        method: 'POST',
        path: `/api/v1/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '-')}/execute`,
        description: 'Kích hoạt luồng thực thi nghiệp vụ chính'
      }
    ];

    const implementationSequence = context.implementationSequence || [
      {
        order: 1,
        title: 'Khởi tạo cấu trúc module và tệp cấu hình',
        details: 'Tạo các tệp tin cơ sở, khai báo biến cấu hình và kết nối cơ sở dữ liệu.'
      },
      {
        order: 2,
        title: 'Hiện thực tầng Service và xử lý nghiệp vụ',
        details: 'Viết logic nghiệp vụ cốt lõi, bắt ngoại lệ và đảm bảo tính toàn vẹn dữ liệu.'
      },
      {
        order: 3,
        title: 'Đăng ký REST Endpoints và tích hợp API Gateway',
        details: 'Định tuyến các API endpoints, kiểm tra hợp lệ dữ liệu đầu vào và phân quyền.'
      },
      {
        order: 4,
        title: 'Hoàn thiện cơ chế Checkpoint và Rollback an toàn',
        details: 'Thiết lập các điểm khôi phục trạng thái khi gặp sự cố trong quá trình thực thi.'
      }
    ];

    // Xây dựng nội dung Markdown chuẩn hóa cho dev_plan.md
    const markdownLines = [
      `# Kế Hoạch Triển Khai Phát Triển (Dev Plan): ${featureName}`,
      '',
      `> **Mã kế hoạch:** \`${planId}\``,
      `> **Tính năng:** \`${featureName}\``,
      `> **Thời gian tạo:** \`${createdAt}\``,
      `> **Tech Stack:** \`${techStack}\``,
      '',
      '---',
      '',
      '## 1. Yêu Cầu & Mục Tiêu Kỹ Thuật (Objective & Prompt)',
      prompt ? prompt.trim() : 'Triển khai tính năng theo đặc tả kỹ thuật và tiêu chí nghiệm thu.',
      '',
      '## 2. Tổng Quan Kiến Trúc (Architecture Overview)',
      architectureOverview,
      '',
      '## 3. Phân Rã Module & Trách Nhiệm (Module Decomposition)',
      '| Module | Trách nhiệm chính | Dependencies |',
      '|---|---|---|'
    ];

    for (const mod of modules) {
      const deps = Array.isArray(mod.dependencies) ? mod.dependencies.join(', ') : (mod.dependencies || '-');
      markdownLines.push(`| \`${mod.moduleName}\` | ${mod.responsibility} | \`${deps}\` |`);
    }

    markdownLines.push(
      '',
      '## 4. Danh Sách Tệp Mã Nguồn Cần Tạo Mới (Files To Create)',
      '| STT | Đường dẫn tệp | Mục đích triển khai |',
      '|---|---|---|'
    );

    filesToCreate.forEach((file, index) => {
      markdownLines.push(`| ${index + 1} | \`${file.filePath}\` | ${file.purposeOrChanges} |`);
    });

    markdownLines.push(
      '',
      '## 5. Danh Sách Tệp Mã Nguồn Cần Chỉnh Sửa (Files To Modify)',
      '| STT | Đường dẫn tệp | Thay đổi dự kiến |',
      '|---|---|---|'
    );

    filesToModify.forEach((file, index) => {
      markdownLines.push(`| ${index + 1} | \`${file.filePath}\` | ${file.purposeOrChanges} |`);
    });

    markdownLines.push(
      '',
      '## 6. Thiết Kế API Endpoints (API Specification)',
      '| Method | Đường dẫn Endpoint | Mô tả chức năng |',
      '|---|---|---|'
    );

    for (const api of apiEndpoints) {
      markdownLines.push(`| **${api.method}** | \`${api.path}\` | ${api.description} |`);
    }

    markdownLines.push(
      '',
      '## 7. Trình Tự Triển Khai (Implementation Sequence)',
      ''
    );

    for (const step of implementationSequence) {
      markdownLines.push(`### Bước ${step.order}: ${step.title}`);
      markdownLines.push(`${step.details}`);
      markdownLines.push('');
    }

    markdownLines.push(
      '## 8. Ràng Buộc Kỹ Thuật & Xử Lý Biên (Constraints & Edge Cases)',
      '- Tuân thủ chuẩn CommonJS (`require` / `module.exports`) trong môi trường Node.js 24.',
      '- Không để lộ thông tin nhạy cảm (API Keys, Passwords, Tokens) ra console log hoặc phản hồi HTTP.',
      '- Xử lý lỗi ngoại lệ tập trung, trả về mã lỗi HTTP chuẩn (400, 404, 500) kèm thông điệp rõ ràng.',
      '- Đảm bảo tài nguyên và tiến trình con được giải phóng triệt để khi hoàn tất.',
      '',
      '## 9. Kế Hoạch Hoàn Tác & Rollback (Checkpoint & Rollback Plan)',
      '- Trước khi thực hiện thay đổi, lưu lại trạng thái snapshot của Git working tree.',
      '- Trong trường hợp quá trình thực thi bị hủy hoặc kiểm thử thất bại sau số lần thử tối đa, hoàn tác các file chưa commit.',
      '- Bảo vệ dữ liệu hiện có trong cơ sở dữ liệu bằng transaction hoặc bản sao lưu trước khi di chuyển schema.'
    );

    const content = markdownLines.join('\n');

    return {
      content,
      planId,
      featureName,
      architectureOverview,
      modules,
      filesToCreate,
      filesToModify,
      apiEndpoints,
      implementationSequence,
      createdAt
    };
  }

  /**
   * Sinh kế hoạch kiểm thử đa kênh (test_plan.md)
   * 
   * @param {Object} params
   * @param {string} params.featureName - Tên tính năng
   * @param {string} params.prompt - Mô tả yêu cầu nghiệp vụ
   * @param {Object|string} params.devPlan - Kế hoạch Dev Plan đã sinh
   * @param {string} [params.baseUrl] - Địa chỉ dịch vụ kiểm thử
   * @param {Object} [params.context] - Ngữ cảnh cấu hình kiểm thử bổ sung
   * @returns {Object} { content, testPlanId, featureName, baseUrl, serviceConfig, testSteps, screenshotCheckpoints, apiTestRequirements, databaseTestRequirements, mockDataRequirements, createdAt }
   */
  generateTestPlan({ featureName, prompt, devPlan, baseUrl = 'http://localhost:3000', context = {} }) {
    if (!featureName) {
      throw new Error('featureName là bắt buộc khi sinh Test Plan');
    }

    const testPlanId = `test-plan-${Date.now()}`;
    const createdAt = new Date().toISOString();

    // Trích xuất endpoints từ devPlan nếu có
    let extractedApis = [];
    if (devPlan && typeof devPlan === 'object' && Array.isArray(devPlan.apiEndpoints)) {
      extractedApis = devPlan.apiEndpoints;
    } else if (typeof devPlan === 'string') {
      // Phân tích sơ bộ regex nếu devPlan là string markdown
      const apiRegex = /\|\s*\*\*(GET|POST|PUT|DELETE|PATCH)\*\*\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/g;
      let match;
      while ((match = apiRegex.exec(devPlan)) !== null) {
        extractedApis.push({
          method: match[1],
          path: match[2].trim(),
          description: match[3].trim()
        });
      }
    }

    if (extractedApis.length === 0) {
      extractedApis = [
        {
          method: 'GET',
          path: `/api/v1/${featureName.toLowerCase().replace(/[^a-z0-9]/g, '-')}/status`,
          description: 'Kiểm tra trạng thái sẵn sàng'
        }
      ];
    }

    const serviceConfig = context.serviceConfig || {
      startCommand: 'npm start',
      defaultPort: 3000,
      readinessProbePath: '/',
      startupTimeoutMs: 30000
    };

    const mockDataRequirements = context.mockDataRequirements || [
      {
        entity: `${featureName}MockPayload`,
        mockDataJson: JSON.stringify({ testMode: true, timestamp: Date.now() }, null, 2),
        description: 'Dữ liệu mẫu kiểm thử khởi tạo tính năng'
      }
    ];

    const testSteps = context.testSteps || [
      {
        stepId: 'step_nav_dashboard',
        order: 1,
        name: 'Điều hướng tới trang Dashboard',
        actionType: 'navigate',
        value: `${baseUrl}/`,
        description: 'Mở trang giao diện chính của hệ thống kiểm thử',
        captureScreenshotAfter: true,
        screenshotCheckpointId: 'cp_initial_dashboard'
      },
      {
        stepId: 'step_verify_title',
        order: 2,
        name: 'Chờ tiêu đề hiển thị',
        actionType: 'wait_for_selector',
        selector: 'h1, .header, #app',
        timeoutMs: 5000,
        description: 'Xác nhận phần tử tiêu đề trang web đã tải thành công',
        captureScreenshotAfter: false
      },
      {
        stepId: 'step_interact_action',
        order: 3,
        name: 'Tương tác điều khiển giao diện',
        actionType: 'click',
        selector: 'button, .btn-primary, [data-action="test"]',
        description: 'Kích hoạt nút tương tác chính trên giao diện',
        captureScreenshotAfter: true,
        screenshotCheckpointId: 'cp_after_action'
      }
    ];

    const screenshotCheckpoints = context.screenshotCheckpoints || [
      {
        checkpointId: 'cp_initial_dashboard',
        stepId: 'step_nav_dashboard',
        evidenceFileNamePattern: '01_dashboard_loaded.png',
        title: 'Màn hình khởi động Dashboard',
        visualAssertionCriteria: 'Giao diện hiển thị đầy đủ thanh điều hướng, không xuất hiện thanh cuộn lỗi hay màn hình trắng',
        expectedDomElements: ['h1', 'nav', 'main']
      },
      {
        checkpointId: 'cp_after_action',
        stepId: 'step_interact_action',
        evidenceFileNamePattern: '02_action_executed.png',
        title: 'Màn hình sau khi thực hiện tương tác',
        visualAssertionCriteria: 'Hiển thị kết quả tương tác hoặc thông báo trạng thái thành công, không có modal báo lỗi',
        expectedDomElements: ['.status-success', '.result-panel', 'table']
      }
    ];

    // Tạo kịch bản kiểm thử API tương ứng với từng endpoint của Dev Plan
    const apiTestRequirements = context.apiTestRequirements || extractedApis.map((api, idx) => ({
      testId: `api_test_${idx + 1}`,
      name: `Kiểm tra ${api.method} ${api.path}`,
      endpoint: api.path,
      method: api.method,
      requestHeaders: { 'Content-Type': 'application/json' },
      requestBody: api.method === 'POST' || api.method === 'PUT' ? { test: true } : undefined,
      expectedStatus: api.method === 'POST' ? 201 : 200,
      expectedJsonSchema: { type: 'object' }
    }));

    const databaseTestRequirements = context.databaseTestRequirements || [
      {
        queryId: 'db_verify_01',
        name: 'Kiểm tra tính nhất quán dữ liệu trong cơ sở dữ liệu',
        dbType: 'sqlite',
        queryString: 'SELECT count(*) as count FROM sqlite_master WHERE type="table"',
        expectedResultPattern: 'count >= 0',
        description: 'Đảm bảo cấu trúc cơ sở dữ liệu nguyên vẹn và có thể truy vấn bình thường'
      }
    ];

    const logScanCriteria = context.logScanCriteria || [
      'Không chứa từ khóa FATAL hoặc UNHANDLED_REJECTION trong luồng thực thi',
      'Không chứa chuỗi SyntaxError hoặc ReferenceError trong stdout/stderr',
      'Không xuất hiện thông tin rò rỉ secret hoặc token chưa được mask'
    ];

    // Xây dựng Markdown chuẩn hóa cho test_plan.md
    const markdownLines = [
      `# Kế Hoạch Kiểm Thử Toàn Diện (Test Plan): ${featureName}`,
      '',
      `> **Mã kế hoạch kiểm thử:** \`${testPlanId}\``,
      `> **Tính năng:** \`${featureName}\``,
      `> **Địa chỉ dịch vụ (Base URL):** \`${baseUrl}\``,
      `> **Thời gian tạo:** \`${createdAt}\``,
      '',
      '---',
      '',
      '## 1. Phạm Vi Kiểm Thử (Test Scope)',
      prompt ? prompt.trim() : 'Thẩm định tự động đa kênh bao gồm: Giao diện người dùng (UI), REST API, Cơ sở dữ liệu và Console Logs.',
      '',
      '## 2. Cấu Hình Dịch Vụ Kiểm Thử (Service Config)',
      `- **Start Command:** \`${serviceConfig.startCommand}\``,
      `- **Default Port:** \`${serviceConfig.defaultPort}\``,
      `- **Readiness Probe Path:** \`${serviceConfig.readinessProbePath}\``,
      `- **Startup Timeout:** \`${serviceConfig.startupTimeoutMs}ms\``,
      '',
      '## 3. Dữ Liệu Mẫu & Giả Lập (Mock Data Requirements)',
      '| Thực thể | Mô tả dữ liệu | Cấu trúc JSON |',
      '|---|---|---|'
    ];

    for (const mock of mockDataRequirements) {
      const cleanJson = (mock.mockDataJson || '{}').replace(/\n/g, ' ');
      markdownLines.push(`| \`${mock.entity}\` | ${mock.description} | \`${cleanJson}\` |`);
    }

    markdownLines.push(
      '',
      '## 4. Kịch Bản & Thao Tác UI Tự Động (Browser Test Steps)',
      '| Thứ tự | ID Bước | Tên thao tác | Loại hành động | Selector / Tham số | Chụp màn hình |',
      '|---|---|---|---|---|---|'
    );

    for (const step of testSteps) {
      const targetParam = step.selector || step.value || '-';
      const snap = step.captureScreenshotAfter ? `Có (\`${step.screenshotCheckpointId}\`)` : 'Không';
      markdownLines.push(`| ${step.order} | \`${step.stepId}\` | ${step.name} | **${step.actionType}** | \`${targetParam}\` | ${snap} |`);
    }

    markdownLines.push(
      '',
      '## 5. Điểm Kiểm Tra Bằng Chứng Hình Ảnh (Screenshot Checkpoints)',
      '| Checkpoint ID | Bước liên kết | Tệp bằng chứng dự kiến | Tiêu chí thẩm định thị giác |',
      '|---|---|---|---|'
    );

    for (const cp of screenshotCheckpoints) {
      markdownLines.push(`| \`${cp.checkpointId}\` | \`${cp.stepId}\` | \`${cp.evidenceFileNamePattern}\` | ${cp.visualAssertionCriteria} |`);
    }

    markdownLines.push(
      '',
      '## 6. Kịch Bản Thẩm Định API (API Test Suite)',
      '| ID | Method | Endpoint | Expected Status | Mô tả kiểm tra |',
      '|---|---|---|---|---|'
    );

    for (const api of apiTestRequirements) {
      markdownLines.push(`| \`${api.testId}\` | **${api.method}** | \`${api.endpoint}\` | \`${api.expectedStatus}\` | ${api.name} |`);
    }

    markdownLines.push(
      '',
      '## 7. Truy Vấn Xác Thực Cơ Sở Dữ Liệu (Database Queries)',
      '| Query ID | DB Type | Câu lệnh SQL | Kỳ vọng |',
      '|---|---|---|---|'
    );

    for (const db of databaseTestRequirements) {
      markdownLines.push(`| \`${db.queryId}\` | \`${db.dbType}\` | \`${db.queryString}\` | \`${db.expectedResultPattern}\` |`);
    }

    markdownLines.push(
      '',
      '## 8. Tiêu Chí Quét Log Lỗi (Log Error Scanning Criteria)',
      ''
    );

    for (const crit of logScanCriteria) {
      markdownLines.push(`- ${crit}`);
    }

    const content = markdownLines.join('\n');

    return {
      content,
      testPlanId,
      featureName,
      baseUrl,
      serviceConfig,
      testSteps,
      screenshotCheckpoints,
      apiTestRequirements,
      databaseTestRequirements,
      mockDataRequirements,
      logScanCriteria,
      createdAt
    };
  }

  /**
   * Consistency Gate: Kiểm tra tính nhất quán giữa Dev Plan và Test Plan
   * Đảm bảo mọi API endpoint và tính năng cốt lõi trong Dev Plan đều có kịch bản test tương ứng.
   * 
   * @param {Object|string} devPlan - Bản Dev Plan (Object hoặc chuỗi markdown)
   * @param {Object|string} testPlan - Bản Test Plan (Object hoặc chuỗi markdown)
   * @returns {Object} { valid, score, errors, warnings, coverage }
   */
  verifyConsistency(devPlan, testPlan) {
    const errors = [];
    const warnings = [];

    if (!devPlan) {
      errors.push('Dev Plan không tồn tại hoặc rỗng');
    }
    if (!testPlan) {
      errors.push('Test Plan không tồn tại hoặc rỗng');
    }

    if (errors.length > 0) {
      return {
        valid: false,
        score: 0,
        errors,
        warnings,
        coverage: {
          apiTotal: 0,
          apiCovered: 0,
          apiCoveragePercentage: 0,
          hasUiTests: false,
          hasDbTests: false,
          hasLogCriteria: false
        }
      };
    }

    // Trích xuất thông tin Dev Plan
    let devApis = [];
    if (typeof devPlan === 'object' && Array.isArray(devPlan.apiEndpoints)) {
      devApis = devPlan.apiEndpoints;
    } else {
      const devStr = typeof devPlan === 'string' ? devPlan : (devPlan.content || '');
      const apiRegex = /\|\s*\*\*(GET|POST|PUT|DELETE|PATCH)\*\*\s*\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/g;
      let m;
      while ((m = apiRegex.exec(devStr)) !== null) {
        devApis.push({ method: m[1], path: m[2].trim() });
      }
    }

    // Trích xuất thông tin Test Plan
    let testApis = [];
    let hasUiSteps = false;
    let hasDbQueries = false;
    let hasLogChecks = false;

    if (typeof testPlan === 'object') {
      if (Array.isArray(testPlan.apiTestRequirements)) {
        testApis = testPlan.apiTestRequirements;
      }
      if (Array.isArray(testPlan.testSteps) && testPlan.testSteps.length > 0) {
        hasUiSteps = true;
      }
      if (Array.isArray(testPlan.databaseTestRequirements) && testPlan.databaseTestRequirements.length > 0) {
        hasDbQueries = true;
      }
      if (Array.isArray(testPlan.logScanCriteria) && testPlan.logScanCriteria.length > 0) {
        hasLogChecks = true;
      }
    }

    // Nếu testPlan là markdown string, kiểm tra qua regex / text scan
    const testStr = typeof testPlan === 'string' ? testPlan : (testPlan.content || '');
    if (testApis.length === 0 && testStr) {
      const testApiRegex = /\|\s*`[^`]+`\s*\|\s*\*\*(GET|POST|PUT|DELETE|PATCH)\*\*\s*\|\s*`([^`]+)`\s*\|/g;
      let tm;
      while ((tm = testApiRegex.exec(testStr)) !== null) {
        testApis.push({ method: tm[1], endpoint: tm[2].trim() });
      }
    }
    if (testStr.includes('## 4. Kịch Bản & Thao Tác UI Tự Động') || testStr.includes('Browser Test Steps')) {
      hasUiSteps = true;
    }
    if (testStr.includes('## 7. Truy Vấn Xác Thực Cơ Sở Dữ Liệu') || testStr.includes('Database Queries')) {
      hasDbQueries = true;
    }
    if (testStr.includes('## 8. Tiêu Chí Quét Log Lỗi') || testStr.includes('Log Error Scanning')) {
      hasLogChecks = true;
    }

    // Kiểm tra độ bao phủ API
    let coveredCount = 0;
    for (const dApi of devApis) {
      const matched = testApis.some((tApi) => {
        const tPath = tApi.endpoint || tApi.path;
        const tMethod = tApi.method;
        return tPath === dApi.path && tMethod === dApi.method;
      });

      if (matched) {
        coveredCount++;
      } else {
        warnings.push(`Endpoint [${dApi.method} ${dApi.path}] trong Dev Plan chưa có kịch bản test trực tiếp trong Test Plan`);
      }
    }

    const apiCoveragePercentage = devApis.length > 0 ? Math.round((coveredCount / devApis.length) * 100) : 100;

    if (apiCoveragePercentage < 50 && devApis.length > 0) {
      errors.push(`Độ bao phủ API của Test Plan quá thấp (${apiCoveragePercentage}%). Yêu cầu tối thiểu 50% endpoints có test case.`);
    }

    if (!hasUiSteps) {
      warnings.push('Test Plan thiếu kịch bản kiểm thử giao diện người dùng (UI Test Steps)');
    }

    if (!hasDbQueries) {
      warnings.push('Test Plan thiếu kịch bản kiểm thử xác nhận cơ sở dữ liệu (Database Queries)');
    }

    if (!hasLogChecks) {
      warnings.push('Test Plan thiếu tiêu chí kiểm tra lỗi Log stdout/stderr');
    }

    // Tính điểm chất lượng tổng thể (Score từ 0 đến 100)
    let score = apiCoveragePercentage * 0.5; // 50% trọng số API
    if (hasUiSteps) score += 20;            // 20% trọng số UI
    if (hasDbQueries) score += 15;          // 15% trọng số DB
    if (hasLogChecks) score += 15;          // 15% trọng số Log

    const valid = errors.length === 0;

    return {
      valid,
      score: Math.min(100, Math.round(score)),
      errors,
      warnings,
      coverage: {
        apiTotal: devApis.length,
        apiCovered: coveredCount,
        apiCoveragePercentage,
        hasUiTests: hasUiSteps,
        hasDbTests: hasDbQueries,
        hasLogCriteria: hasLogChecks
      }
    };
  }

  /**
   * Lưu trữ các bản kế hoạch vào thư mục đích
   * 
   * @param {Object} params
   * @param {string} [params.outputDir] - Thư mục lưu trữ (mặc định theo featureName)
   * @param {string} [params.featureName] - Tên tính năng
   * @param {string} params.devPlanContent - Nội dung Markdown của dev_plan.md
   * @param {string} params.testPlanContent - Nội dung Markdown của test_plan.md
   * @returns {Object} { devPlanPath, testPlanPath, saved: boolean }
   */
  savePlans({ outputDir, featureName, devPlanContent, testPlanContent }) {
    if (!devPlanContent || !testPlanContent) {
      throw new Error('Cần cung cấp đầy đủ devPlanContent và testPlanContent để lưu');
    }

    const targetDir = outputDir || path.resolve(this.baseOutputDir, featureName || 'unnamed-feature');

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const devPlanPath = path.join(targetDir, 'dev_plan.md');
    const testPlanPath = path.join(targetDir, 'test_plan.md');

    fs.writeFileSync(devPlanPath, devPlanContent, 'utf8');
    fs.writeFileSync(testPlanPath, testPlanContent, 'utf8');

    return {
      devPlanPath,
      testPlanPath,
      saved: true
    };
  }
}

module.exports = {
  DualPlanningGenerator
};
