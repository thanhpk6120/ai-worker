/**
 * Multi-Verification Evidence Gate Engine
 * 
 * Hệ thống thẩm định nghiệm thu đa kênh tích hợp 4 kênh kiểm chứng bắt buộc:
 * 1. 📸 UI Screenshot Verifier (UiEvidenceCollector)
 * 2. 🌐 API Test Runner (ApiTestRunner)
 * 3. 📋 Log Scanner (LogScanner)
 * 4. 🗄️ Database Verifier (DatabaseVerifier)
 * 
 * Quy tắc Gating nghiêm ngặt:
 * - PASS: Chỉ khi 100% cả 4 kênh đều đạt (passed: true) -> Chuyển sang DONE.
 * - FAIL: Bất kỳ kênh nào không đạt -> Chuyển sang FIXING kèm FixingContextPack.
 */

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

// Fallback scrub secrets nếu module secretScrubber chưa load được
function defaultMaskSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(?:sk-ant-|sk-|glpat-|ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_-]{10,}/g, '***MASKED***')
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{20,}/gi, 'Bearer ***MASKED***')
    .replace(/(?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?([^"',\s&]+)["']?/gi, (match, p1) => {
      return match.replace(p1, '***MASKED***');
    });
}

function getMaskSecrets() {
  try {
    const scrubber = require('../execution/secretScrubber');
    if (typeof scrubber.maskSecrets === 'function') {
      return scrubber.maskSecrets;
    }
    if (scrubber.SecretScrubber && typeof scrubber.SecretScrubber.prototype.scrub === 'function') {
      const instance = new scrubber.SecretScrubber();
      return (txt) => instance.scrub(txt);
    }
  } catch (err) {
    // Sử dụng fallback nội bộ
  }
  return defaultMaskSecrets;
}

/**
 * 📸 KÊNH 1: UI Screenshot Verifier (UiEvidenceCollector)
 * Kiểm tra các file ảnh chụp màn hình trong thư mục evidence, phát hiện visual defect,
 * bố cục bị vỡ hoặc thiếu screenshot theo kịch bản test.
 */
class UiEvidenceCollector {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Thẩm định bằng chứng UI từ thư mục evidence hoặc testPlan
   * @param {Object} params
   * @param {string} params.featureName - Tên tính năng (feature/<featureName>)
   * @param {Object} [params.testPlan] - Kế hoạch kiểm thử chứa danh sách checkpoint UI
   * @param {string} [params.evidenceDir] - Đường dẫn thư mục chứa ảnh chụp
   * @param {Object} [params.browserRunner] - Đối tượng BrowserRunner nếu cần gọi trực tiếp
   * @returns {Promise<Object>} ChannelResult
   */
  async verify({ featureName, testPlan = {}, evidenceDir = null, browserRunner = null, executionLogs = null }) {
    const targetDir = evidenceDir || path.resolve(process.cwd(), 'feature', featureName || 'default', 'evidence');
    const defects = [];
    const foundScreenshots = [];
    const missingScreenshots = [];
    const duplicateGroups = [];
    let metadata = null;

    // Kiểm tra sự tồn tại của thư mục evidence
    if (!fs.existsSync(targetDir)) {
      // Nếu testPlan có yêu cầu UI nhưng thư mục hoàn toàn không tồn tại -> FAIL
      const requiresUi = (testPlan.uiCheckpoints && testPlan.uiCheckpoints.length > 0) ||
                         (testPlan.uiSteps && testPlan.uiSteps.length > 0) ||
                         (testPlan.browserSteps && testPlan.browserSteps.length > 0);

      if (requiresUi) {
        return {
          passed: false,
          channel: 'ui',
          status: 'FAILED',
          evidenceDir: targetDir,
          totalCheckpoints: (testPlan.uiCheckpoints || testPlan.uiSteps || []).length,
          foundScreenshots: [],
          missingScreenshots: testPlan.uiCheckpoints || testPlan.uiSteps || [],
          defects: [{
            type: 'MISSING_EVIDENCE_DIRECTORY',
            message: `Thư mục bằng chứng UI không tồn tại: ${targetDir}`
          }],
          duplicateGroups: [],
          summary: 'Thất bại: Không tìm thấy thư mục lưu ảnh chụp màn hình UI'
        };
      }

      // Nếu không có yêu cầu UI rõ ràng -> PASS (mặc định thông qua)
      return {
        passed: true,
        channel: 'ui',
        status: 'PASSED',
        evidenceDir: targetDir,
        totalCheckpoints: 0,
        foundScreenshots: [],
        missingScreenshots: [],
        defects: [],
        duplicateGroups: [],
        summary: 'Bỏ qua kiểm chứng UI: Tính năng không có kịch bản tương tác giao diện'
      };
    }

    // Đọc danh sách các tệp tin trong thư mục evidence
    let files = [];
    try {
      files = fs.readdirSync(targetDir);
    } catch (err) {
      return {
        passed: false,
        channel: 'ui',
        status: 'FAILED',
        evidenceDir: targetDir,
        totalCheckpoints: 0,
        foundScreenshots: [],
        missingScreenshots: [],
        defects: [{ type: 'FS_READ_ERROR', message: `Lỗi đọc thư mục evidence: ${err.message}` }],
        duplicateGroups: [],
        summary: `Lỗi đọc thư mục bằng chứng UI: ${err.message}`
      };
    }

    // Đọc metadata.json nếu có
    const metadataFile = files.find(f => f.toLowerCase() === 'metadata.json');
    if (metadataFile) {
      try {
        const rawContent = fs.readFileSync(path.join(targetDir, metadataFile), 'utf-8');
        metadata = JSON.parse(rawContent);

        // Kiểm tra cờ visual defects trong metadata
        if (metadata && metadata.hasVisualDefects === true) {
          defects.push({
            type: 'VISUAL_DEFECT_FLAGGED',
            message: metadata.visualDefectReason || 'Metadata ghi nhận tồn tại visual defect trong giao diện'
          });
        }

        // Kiểm tra lỗi console hoặc runtime của trình duyệt ghi nhận trong metadata
        if (metadata && Array.isArray(metadata.consoleErrors) && metadata.consoleErrors.length > 0) {
          defects.push({
            type: 'BROWSER_CONSOLE_ERROR',
            message: `Phát hiện ${metadata.consoleErrors.length} lỗi trong console trình duyệt`,
            errors: metadata.consoleErrors
          });
        }
      } catch (e) {
        defects.push({
          type: 'INVALID_METADATA_JSON',
          message: `Tệp metadata.json không hợp lệ: ${e.message}`
        });
      }
    }

    // Thu thập danh sách ảnh screenshot (.png, .jpg, .jpeg, .webp) và kiểm tra toàn vẹn
    const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const fileStatsMap = new Map();

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (imageExtensions.has(ext)) {
        const fullPath = path.join(targetDir, file);
        try {
          const stats = fs.statSync(fullPath);
          fileStatsMap.set(file, stats);
          if (stats.size === 0) {
            defects.push({
              type: 'EMPTY_SCREENSHOT',
              file,
              message: `Tệp ảnh chụp màn hình rỗng (0 bytes): ${file}`
            });
            continue;
          }

          // Kiểm tra PNG magic bytes đối với file .png
          if (ext === '.png') {
            let isValidPng = false;
            try {
              const headerBuf = Buffer.alloc(8);
              const fd = fs.openSync(fullPath, 'r');
              const bytesRead = fs.readSync(fd, headerBuf, 0, 8, 0);
              fs.closeSync(fd);
              if (bytesRead === 8 && headerBuf.equals(PNG_MAGIC)) {
                isValidPng = true;
              }
            } catch (errMagic) {
              isValidPng = false;
            }

            if (!isValidPng) {
              defects.push({
                type: 'INVALID_PNG',
                file,
                message: `Tệp PNG không hợp lệ (sai magic bytes 89 50 4E 47 0D 0A 1A 0A): ${file}`
              });
              continue;
            }
          }

          foundScreenshots.push(file);
        } catch (e) {
          defects.push({
            type: 'FILE_ACCESS_ERROR',
            file,
            message: `Không thể đọc tệp ${file}: ${e.message}`
          });
        }
      }
    }

    // Kiểm tra trùng lặp ảnh bằng MD5 và SHA256
    try {
      const hashMap = new Map();
      for (const file of foundScreenshots) {
        try {
          const buf = fs.readFileSync(path.join(targetDir, file));
          const md5 = crypto.createHash('md5').update(buf).digest('hex');
          const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
          if (!hashMap.has(md5)) {
            hashMap.set(md5, { hash: md5, sha256, files: [] });
          }
          hashMap.get(md5).files.push(file);
        } catch { /* bỏ qua lỗi đọc file, đã ghi nhận */ }
      }

      for (const entry of hashMap.values()) {
        if (entry.files.length >= 2) {
          duplicateGroups.push({
            hash: entry.hash,
            sha256: entry.sha256,
            files: [...entry.files]
          });
          defects.push({
            type: 'DUPLICATE_SCREENSHOT',
            files: [...entry.files],
            hash: entry.hash,
            sha256: entry.sha256,
            message: `Phát hiện ${entry.files.length} ảnh chụp trùng lặp nội dung (MD5=${entry.hash}): ${entry.files.join(', ')}`
          });
        }
      }
    } catch { /* không chặn luồng */ }

    // Kiểm tra tính nhất quán của metadata.json (nếu metadata khai báo danh sách screenshots)
    if (metadata && typeof metadata === 'object') {
      const declaredScreenshots = Array.isArray(metadata)
        ? metadata
        : (Array.isArray(metadata.screenshots)
          ? metadata.screenshots
          : (Array.isArray(metadata.records) ? metadata.records : null));

      if (Array.isArray(declaredScreenshots)) {
        const declaredNames = new Set();
        for (const item of declaredScreenshots) {
          const rawName = typeof item === 'string' ? item : (item && (item.fileName || item.filename || item.name || item.filePath));
          if (rawName && typeof rawName === 'string') {
            const baseName = path.basename(rawName);
            declaredNames.add(baseName);

            // Kiểm tra file trên đĩa có tồn tại không
            if (!files.includes(baseName)) {
              defects.push({
                type: 'METADATA_SCREENSHOT_MISSING_ON_DISK',
                file: baseName,
                message: `metadata khai báo ảnh "${baseName}" nhưng file không tồn tại trên đĩa`
              });
            }

            // Kiểm tra fileSizeBytes nếu item là object
            if (item && typeof item === 'object' && item.fileSizeBytes !== undefined && item.fileSizeBytes !== null) {
              const claimedSize = Number(item.fileSizeBytes);
              if (Number.isFinite(claimedSize)) {
                const diskStats = fileStatsMap.get(baseName);
                if (diskStats && diskStats.size !== claimedSize) {
                  defects.push({
                    type: 'METADATA_FILESIZE_MISMATCH',
                    file: baseName,
                    claimedSize,
                    actualSize: diskStats.size,
                    message: `metadata khai báo fileSizeBytes=${claimedSize} cho "${baseName}" nhưng kích thước thực tế là ${diskStats.size}`
                  });
                }
              }
            }
          }
        }

        // Kiểm tra file ảnh trên đĩa thừa so với metadata
        for (const diskImg of foundScreenshots) {
          if (!declaredNames.has(diskImg)) {
            defects.push({
              type: 'DISK_SCREENSHOT_EXTRA_NOT_IN_METADATA',
              file: diskImg,
              message: `File ảnh "${diskImg}" tồn tại trên đĩa nhưng không được khai báo trong metadata`
            });
          }
        }
      }
    }

    // Kiểm tra log browser capture thật (01_test_execution.log hoặc executionLogs truyền vào)
    let testExecutionLogContent = '';
    const logFilePath = path.join(targetDir, '01_test_execution.log');
    if (fs.existsSync(logFilePath)) {
      try {
        testExecutionLogContent = fs.readFileSync(logFilePath, 'utf-8');
      } catch { /* bỏ qua lỗi đọc */ }
    } else if (typeof executionLogs === 'string' && executionLogs.trim().length > 0) {
      testExecutionLogContent = executionLogs;
    }

    // Nếu có phát hiện screenshots hoặc testPlan yêu cầu UI, bắt buộc kiểm tra log browser capture
    const requiresBrowserCaptureCheck = foundScreenshots.length > 0 ||
                                        (testPlan.uiCheckpoints && testPlan.uiCheckpoints.length > 0) ||
                                        (testPlan.uiSteps && testPlan.uiSteps.length > 0) ||
                                        (testPlan.browserSteps && testPlan.browserSteps.length > 0);

    if (requiresBrowserCaptureCheck) {
      if (!testExecutionLogContent || testExecutionLogContent.trim().length === 0) {
        defects.push({
          type: 'no-browser-capture',
          message: 'Không tìm thấy nhật ký thực thi (01_test_execution.log) để xác thực phiên chụp màn hình từ trình duyệt thật'
        });
      } else {
        const browserKeywords = [
          'browser', 'capture', 'screenshot', 'playwright', 'chromium',
          'puppeteer', 'cloakbrowser', 'mcp__cloakbrowser', 'webdriver', 'selenium',
          'mcp__cloakbrowser_screenshot', 'mcp__cloakbrowser_navigate', 'page.screenshot'
        ];
        const lowerLog = testExecutionLogContent.toLowerCase();
        const hasBrowserProof = browserKeywords.some(kw => lowerLog.includes(kw));
        if (!hasBrowserProof) {
          defects.push({
            type: 'no-browser-capture',
            message: 'Nhật ký kiểm thử (01_test_execution.log) không chứa từ khóa chứng minh tương tác hoặc chụp ảnh từ trình duyệt thật'
          });
        }
      }
    }

    // Đối chiếu với các checkpoint bắt buộc từ testPlan
    const expectedCheckpoints = testPlan.uiCheckpoints || testPlan.uiSteps || [];
    for (const checkpoint of expectedCheckpoints) {
      const checkpointName = typeof checkpoint === 'string' ? checkpoint : (checkpoint.id || checkpoint.name || '');
      const matched = foundScreenshots.some(f => f.toLowerCase().includes(checkpointName.toLowerCase()));
      if (!matched) {
        missingScreenshots.push(checkpointName);
        defects.push({
          type: 'MISSING_CHECKPOINT_SCREENSHOT',
          checkpoint: checkpointName,
          message: `Thiếu ảnh chụp màn hình cho checkpoint bắt buộc: "${checkpointName}"`
        });
      }
    }

    const passed = defects.length === 0 && (expectedCheckpoints.length === 0 || missingScreenshots.length === 0);

    return {
      passed,
      channel: 'ui',
      status: passed ? 'PASSED' : 'FAILED',
      evidenceDir: targetDir,
      totalCheckpoints: expectedCheckpoints.length,
      foundScreenshots,
      missingScreenshots,
      duplicateGroups,
      defects,
      metadata,
      summary: passed
        ? `UI Screenshot Verifier ĐẠT: Tìm thấy ${foundScreenshots.length} ảnh chụp, không phát hiện lỗi trực quan.`
        : `UI Screenshot Verifier THẤT BẠI: Phát hiện ${defects.length} lỗi/khiếm khuyết giao diện và thiếu ${missingScreenshots.length} checkpoint.`
    };
  }
}

/**
 * 🌐 KÊNH 2: API Test Runner (ApiTestRunner)
 * Gửi HTTP requests (GET, POST, PUT, DELETE, PATCH) đến local service,
 * kiểm tra HTTP status code mong đợi và JSON schema/payload assertion.
 */
class ApiTestRunner {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Thực hiện gửi một HTTP request độc lập
   */
  async executeRequest({ baseUrl, path: reqPath = '/', method = 'GET', headers = {}, body = null, timeoutMs = 10000 }) {
    const fullUrl = new URL(reqPath, baseUrl).toString();
    const parsedUrl = new URL(fullUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const httpLib = isHttps ? https : http;

    // Chuẩn bị payload nếu có
    let payloadStr = null;
    const finalHeaders = { ...headers };
    if (body !== null && body !== undefined) {
      if (typeof body === 'object') {
        payloadStr = JSON.stringify(body);
        if (!finalHeaders['content-type'] && !finalHeaders['Content-Type']) {
          finalHeaders['Content-Type'] = 'application/json';
        }
      } else {
        payloadStr = String(body);
      }
      finalHeaders['Content-Length'] = Buffer.byteLength(payloadStr);
    }

    return new Promise((resolve) => {
      const startTime = Date.now();
      const req = httpLib.request(fullUrl, {
        method: method.toUpperCase(),
        headers: finalHeaders,
        timeout: timeoutMs
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf-8');
          const durationMs = Date.now() - startTime;
          let jsonBody = null;
          let isJson = false;

          try {
            jsonBody = JSON.parse(rawBody);
            isJson = true;
          } catch (e) {
            // Không phải JSON body
          }

          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            headers: res.headers,
            rawBody,
            jsonBody,
            isJson,
            durationMs,
            error: null
          });
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`Quá thời gian kết nối (Timeout ${timeoutMs}ms)`));
      });

      req.on('error', (err) => {
        resolve({
          ok: false,
          status: 0,
          headers: {},
          rawBody: '',
          jsonBody: null,
          isJson: false,
          durationMs: Date.now() - startTime,
          error: err.message
        });
      });

      if (payloadStr) {
        req.write(payloadStr);
      }
      req.end();
    });
  }

  /**
   * So sánh JSON schema / trường dữ liệu mong đợi
   */
  assertJsonSchema(jsonBody, schema) {
    if (!schema || typeof schema !== 'object') return { valid: true };
    if (!jsonBody || typeof jsonBody !== 'object') {
      return { valid: false, error: 'Phản hồi không phải là JSON object' };
    }

    // Kiểm tra các trường bắt buộc (required: string[])
    if (Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in jsonBody)) {
          return { valid: false, error: `Thiếu trường bắt buộc trong response: "${field}"` };
        }
      }
    }

    // Kiểm tra type của các properties (properties: { [k]: { type: 'string'|'number'|'boolean'|'object'|'array' } })
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, propRule] of Object.entries(schema.properties)) {
        if (key in jsonBody && propRule && propRule.type) {
          const actualVal = jsonBody[key];
          const expectedType = propRule.type;
          if (expectedType === 'array') {
            if (!Array.isArray(actualVal)) {
              return { valid: false, error: `Trường "${key}" mong đợi kiểu array nhưng nhận được ${typeof actualVal}` };
            }
          } else if (expectedType === 'null') {
            if (actualVal !== null) {
              return { valid: false, error: `Trường "${key}" mong đợi null` };
            }
          } else {
            if (typeof actualVal !== expectedType) {
              return { valid: false, error: `Trường "${key}" mong đợi kiểu ${expectedType} nhưng nhận được ${typeof actualVal}` };
            }
          }
        }
      }
    }

    return { valid: true };
  }

  /**
   * Chạy toàn bộ test suite API
   * @param {Object} params
   * @param {string} params.baseUrl - Địa chỉ máy chủ (vd: http://localhost:3001)
   * @param {Array<Object>} [params.testSuite] - Danh sách kịch bản kiểm thử API
   * @param {Object} [params.headers] - Headers mặc định
   * @param {number} [params.timeoutMs] - Timeout cho mỗi request
   * @returns {Promise<Object>} ChannelResult
   */
  async runTests({ baseUrl, testSuite = [], headers = {}, timeoutMs = 10000 }) {
    if (!baseUrl) {
      return {
        passed: false,
        channel: 'api',
        status: 'FAILED',
        total: 0,
        passedCount: 0,
        failedCount: 1,
        failures: [{ name: 'BASE_URL_CHECK', error: 'Chưa cung cấp baseUrl cho API Test Runner' }],
        details: [],
        summary: 'Thất bại: Thiếu baseUrl kiểm thử API'
      };
    }

    if (!Array.isArray(testSuite) || testSuite.length === 0) {
      return {
        passed: true,
        channel: 'api',
        status: 'PASSED',
        total: 0,
        passedCount: 0,
        failedCount: 0,
        failures: [],
        details: [],
        summary: 'Bỏ qua kiểm thử API: Không có kịch bản test API trong testPlan'
      };
    }

    const details = [];
    const failures = [];

    for (const testCase of testSuite) {
      const caseName = testCase.name || `${testCase.method || 'GET'} ${testCase.path || '/'}`;
      const expectedStatus = testCase.expectedStatus !== undefined ? testCase.expectedStatus : 200;

      const res = await this.executeRequest({
        baseUrl,
        path: testCase.path || '/',
        method: testCase.method || 'GET',
        headers: { ...headers, ...(testCase.headers || {}) },
        body: testCase.body !== undefined ? testCase.body : null,
        timeoutMs: testCase.timeoutMs || timeoutMs
      });

      let casePassed = true;
      let failureReason = null;

      // 1. Kiểm tra lỗi mạng / kết nối
      if (res.error) {
        casePassed = false;
        failureReason = `Lỗi kết nối HTTP: ${res.error}`;
      } else {
        // 2. Kiểm tra status code
        let statusMatched = false;
        if (Array.isArray(expectedStatus)) {
          statusMatched = expectedStatus.includes(res.status);
        } else if (typeof expectedStatus === 'function') {
          statusMatched = expectedStatus(res.status);
        } else {
          statusMatched = res.status === expectedStatus;
        }

        if (!statusMatched) {
          casePassed = false;
          failureReason = `Status code không khớp: Mong đợi ${JSON.stringify(expectedStatus)}, Thực tế nhận được ${res.status}`;
        }

        // 3. Kiểm tra JSON Schema nếu status đã khớp
        if (casePassed && testCase.schema) {
          const schemaResult = this.assertJsonSchema(res.jsonBody, testCase.schema);
          if (!schemaResult.valid) {
            casePassed = false;
            failureReason = `Xác thực Schema JSON thất bại: ${schemaResult.error}`;
          }
        }

        // 4. Kiểm tra trường dữ liệu cụ thể (expectedFields)
        if (casePassed && Array.isArray(testCase.expectedFields)) {
          if (!res.jsonBody || typeof res.jsonBody !== 'object') {
            casePassed = false;
            failureReason = 'Phản hồi không chứa JSON body để kiểm tra expectedFields';
          } else {
            for (const f of testCase.expectedFields) {
              if (!(f in res.jsonBody)) {
                casePassed = false;
                failureReason = `Thiếu trường dữ liệu mong đợi trong body: "${f}"`;
                break;
              }
            }
          }
        }

        // 5. Custom validator nếu có
        if (casePassed && typeof testCase.validator === 'function') {
          try {
            const validResult = testCase.validator(res.jsonBody, res);
            if (validResult === false || (validResult && validResult.passed === false)) {
              casePassed = false;
              failureReason = (validResult && validResult.message) || 'Custom validator trả về false';
            }
          } catch (valErr) {
            casePassed = false;
            failureReason = `Custom validator phát sinh lỗi: ${valErr.message}`;
          }
        }
      }

      const caseResult = {
        name: caseName,
        method: (testCase.method || 'GET').toUpperCase(),
        path: testCase.path || '/',
        expectedStatus,
        actualStatus: res.status,
        durationMs: res.durationMs,
        passed: casePassed,
        error: failureReason,
        responseSnippet: res.rawBody ? res.rawBody.slice(0, 300) : null
      };

      details.push(caseResult);
      if (!casePassed) {
        failures.push(caseResult);
      }
    }

    const passed = failures.length === 0;

    return {
      passed,
      channel: 'api',
      status: passed ? 'PASSED' : 'FAILED',
      total: testSuite.length,
      passedCount: testSuite.length - failures.length,
      failedCount: failures.length,
      failures,
      details,
      summary: passed
        ? `API Test Runner ĐẠT: 100% (${testSuite.length}/${testSuite.length}) endpoint phản hồi chính xác.`
        : `API Test Runner THẤT BẠI: ${failures.length}/${testSuite.length} endpoint kiểm thử không đạt tiêu chuẩn.`
    };
  }
}

/**
 * 📋 KÊNH 3: Log Scanner (LogScanner)
 * Quét toàn bộ log stdout/stderr từ Local Service và Runner.
 * Làm sạch secrets bằng SecretScrubber, phát hiện unhandled exceptions,
 * fatal errors, uncaught errors và trích xuất stack trace đầy đủ.
 */
class LogScanner {
  constructor(options = {}) {
    this.options = options;
    this.maskSecrets = options.maskSecrets || getMaskSecrets();
  }

  /**
   * Danh sách regex phát hiện lỗi nghiêm trọng
   */
  getDefaultErrorPatterns() {
    return [
      { type: 'UNHANDLED_PROMISE_REJECTION', regex: /(?:UnhandledPromiseRejection|UnhandledPromiseRejectionWarning|unhandledRejection)/i },
      { type: 'UNCAUGHT_EXCEPTION', regex: /(?:uncaughtException|Uncaught Exception)/i },
      { type: 'FATAL_ERROR', regex: /\b(?:FATAL|CRITICAL)\b/i },
      { type: 'JAVASCRIPT_RUNTIME_ERROR', regex: /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|URIError|EvalError):\s+[^\n\r]+/ },
      { type: 'GENERIC_ERROR_TRACE', regex: /\bError:\s+[^\n\r]+/ },
      { type: 'STACK_TRACE_LINE', regex: /^\s*at\s+[\w\d_.$<>]+\s+\([^)]+:\d+:\d+\)/m },
      { type: 'PROCESS_CRASH', regex: /(?:Process crashed|died unexpectedly|SIGSEGV|SIGABRT|exit code [1-9]\d*)/i }
    ];
  }

  /**
   * Bộ lọc bỏ các false-positive đã biết (ví dụ thông tin debug vô hại)
   */
  isFalsePositive(line) {
    if (!line || typeof line !== 'string') return true;
    const lower = line.toLowerCase();
    // Bỏ qua các log thông báo test mong đợi hoặc log INFO bình thường
    if (lower.includes('[expected error in test]') ||
        lower.includes('[debug]') ||
        lower.includes('ignore-gate-log')) {
      return true;
    }
    return false;
  }

  /**
   * Quét và phân tích luồng log
   * @param {string|string[]} logs - Luồng log thô
   * @param {Object} [options]
   * @param {Array<RegExp>} [options.customPatterns] - Các pattern lỗi tùy chỉnh
   * @param {Array<string>} [options.allowlist] - Các chuỗi log được phép bỏ qua
   * @returns {Object} ChannelResult
   */
  scanLogs(logs, options = {}) {
    const rawText = Array.isArray(logs) ? logs.join('\n') : (typeof logs === 'string' ? logs : String(logs || ''));

    // 1. Luôn làm sạch bí mật trước khi lưu vết hoặc phân tích
    const scrubbedLogs = this.maskSecrets(rawText);

    const requireBrowserCapture = Boolean(options && (options.requireBrowserCapture ?? options.requireBrowserEvidence ?? options.logRequireBrowserCapture));
    const hasBrowserCapture = /(screenshot|metadata(\.json)?|browser[-\s]?capture|capture|evidence)/i.test(scrubbedLogs || '');
    if (requireBrowserCapture && !hasBrowserCapture) {
      const emptyNote = (!scrubbedLogs || scrubbedLogs.trim().length === 0) ? ' (log trống, không có nội dung)' : '';
      return {
        passed: false,
        channel: 'log',
        status: 'FAILED',
        clean: false,
        errorCount: 1,
        violations: [{
          line: '',
          errorType: 'MISSING_BROWSER_CAPTURE',
          lineNumber: 0
        }],
        stackTraces: [],
        scrubbedLogs,
        summary: `Log Scanner THẤT BẠI: Log không chứa dấu vết browser capture${emptyNote} (không tìm thấy screenshot/metadata/capture trong log, nghi ngờ thiếu bằng chứng trình duyệt).`
      };
    }
    if (!scrubbedLogs || scrubbedLogs.trim().length === 0) {
      return {
        passed: true,
        channel: 'log',
        status: 'PASSED',
        clean: true,
        errorCount: 0,
        violations: [],
        stackTraces: [],
        scrubbedLogs: '',
        summary: 'Log Scanner ĐẠT: Không có log lỗi nào được ghi nhận.'
      };
    }

    const lines = scrubbedLogs.split(/\r?\n/);
    const patterns = options.customPatterns || this.getDefaultErrorPatterns();
    const violations = [];
    const stackTraces = [];

    let currentStackTrace = [];
    let isCapturingStack = false;

    lines.forEach((line, index) => {
      if (this.isFalsePositive(line)) {
        return;
      }

      // Kiểm tra pattern stack trace line
      const isStackLine = /^\s*at\s+[\w\d_.$<>]+\s+\([^)]+:\d+:\d+\)/.test(line) ||
                          /^\s*at\s+async\s+[\w\d_.$<>]+\s+\([^)]+:\d+:\d+\)/.test(line) ||
                          /^\s*at\s+[^\n\r]+:\d+:\d+/.test(line);

      if (isStackLine) {
        if (!isCapturingStack) {
          isCapturingStack = true;
          currentStackTrace = [];
          // Lấy dòng ngữ cảnh phía trước nếu có
          if (index > 0 && lines[index - 1]) {
            currentStackTrace.push(lines[index - 1].trim());
          }
        }
        currentStackTrace.push(line.trim());
      } else {
        if (isCapturingStack) {
          stackTraces.push(currentStackTrace.join('\n'));
          isCapturingStack = false;
          currentStackTrace = [];
        }

        // Kiểm tra các regex lỗi khác
        for (const p of patterns) {
          if (p.regex.test(line)) {
            violations.push({
              line: line.trim(),
              errorType: p.type,
              lineNumber: index + 1
            });
            break;
          }
        }
      }
    });

    if (isCapturingStack && currentStackTrace.length > 0) {
      stackTraces.push(currentStackTrace.join('\n'));
    }

    const totalErrors = violations.length + stackTraces.length;
    const passed = totalErrors === 0;

    return {
      passed,
      channel: 'log',
      status: passed ? 'PASSED' : 'FAILED',
      clean: passed,
      errorCount: totalErrors,
      violations,
      stackTraces,
      scrubbedLogs,
      summary: passed
        ? 'Log Scanner ĐẠT: Toàn bộ log sạch sẽ, không có runtime crash hay unhandled exception.'
        : `Log Scanner THẤT BẠI: Phát hiện ${violations.length} lỗi nghiêm trọng và ${stackTraces.length} khối stack trace trong log.`
    };
  }
}

/**
 * 🗄️ KÊNH 4: Database Verifier (DatabaseVerifier)
 * Kết nối truy vấn DB (hỗ trợ SQLite built-in qua node:sqlite DatabaseSync hoặc file DB, SQL assertion).
 * Xác thực dữ liệu thực tế đã được chèn/cập nhật đúng nghiệp vụ.
 */
class DatabaseVerifier {
  constructor(options = {}) {
    this.options = options;
  }

  /**
   * Tạo kết nối tạm thời tới SQLite nếu cấu hình là file
   */
  getSqliteConnection(dbConfig, dbInstance) {
    if (dbInstance) {
      return { db: dbInstance, shouldClose: false };
    }

    if (!dbConfig) return null;

    try {
      const { DatabaseSync } = require('node:sqlite');
      const dbPath = typeof dbConfig === 'string' ? dbConfig : (dbConfig.path || dbConfig.database || ':memory:');
      const db = new DatabaseSync(dbPath);
      return { db, shouldClose: true };
    } catch (err) {
      return { error: `Không thể khởi tạo SQLite DatabaseSync: ${err.message}` };
    }
  }

  /**
   * Thực hiện chạy câu truy vấn SQL an toàn
   */
  executeQuery(db, query, params = []) {
    // 1. Kiểm tra interface DatabaseSync built-in
    if (typeof db.prepare === 'function') {
      const stmt = db.prepare(query);
      if (typeof stmt.all === 'function') {
        return stmt.all(...params);
      }
      if (typeof stmt.get === 'function') {
        const row = stmt.get(...params);
        return row ? [row] : [];
      }
      if (typeof stmt.run === 'function') {
        const res = stmt.run(...params);
        return [res];
      }
    }

    // 2. Custom db wrapper có hàm query hoặc all
    if (typeof db.all === 'function') {
      return db.all(query, params);
    }
    if (typeof db.query === 'function') {
      return db.query(query, params);
    }

    throw new Error('Đối tượng Database không cung cấp phương thức truy vấn hợp lệ');
  }

  /**
   * Thẩm định dữ liệu trong CSDL
   * @param {Object} params
   * @param {Object|string} [params.dbConfig] - Cấu hình DB (đường dẫn file sqlite)
   * @param {Array<Object>} [params.assertions] - Danh sách câu SQL assertion
   * @param {Object} [params.dbInstance] - Instance DB đã có sẵn
   * @returns {Promise<Object>} ChannelResult
   */
  async verify({ dbConfig = null, assertions = [], dbInstance = null }) {
    if (!Array.isArray(assertions) || assertions.length === 0) {
      return {
        passed: true,
        channel: 'db',
        status: 'PASSED',
        total: 0,
        passedCount: 0,
        failedCount: 0,
        inconsistencies: [],
        details: [],
        summary: 'Bỏ qua kiểm chứng Database: Kế hoạch không yêu cầu xác thực CSDL'
      };
    }

    const connWrapper = this.getSqliteConnection(dbConfig, dbInstance);
    if (!connWrapper) {
      return {
        passed: false,
        channel: 'db',
        status: 'FAILED',
        total: assertions.length,
        passedCount: 0,
        failedCount: assertions.length,
        inconsistencies: [{ name: 'DB_CONNECTION', error: 'Thiếu cấu hình kết nối CSDL để kiểm tra assertions' }],
        details: [],
        summary: 'Thất bại: Không có thông tin kết nối CSDL'
      };
    }

    if (connWrapper.error) {
      return {
        passed: false,
        channel: 'db',
        status: 'FAILED',
        total: assertions.length,
        passedCount: 0,
        failedCount: assertions.length,
        inconsistencies: [{ name: 'DB_INIT_ERROR', error: connWrapper.error }],
        details: [],
        summary: `Thất bại: Lỗi kết nối CSDL: ${connWrapper.error}`
      };
    }

    const { db, shouldClose } = connWrapper;
    const details = [];
    const inconsistencies = [];

    try {
      for (const assertion of assertions) {
        const assertName = assertion.name || assertion.query;
        let actualRows = [];
        let executionError = null;

        try {
          actualRows = this.executeQuery(db, assertion.query, assertion.params || []);
        } catch (err) {
          executionError = err.message;
        }

        let passed = true;
        let diffReason = null;

        if (executionError) {
          passed = false;
          diffReason = `Lỗi thực thi truy vấn SQL: ${executionError}`;
        } else {
          // 1. Kiểm tra số dòng (expectedRowCount)
          if (assertion.expectedRowCount !== undefined) {
            const count = actualRows.length;
            if (count !== assertion.expectedRowCount) {
              passed = false;
              diffReason = `Số lượng dòng không khớp: Mong đợi ${assertion.expectedRowCount}, Thực tế nhận được ${count}`;
            }
          }

          // 2. Kiểm tra expectedValues trên dòng đầu tiên
          if (passed && assertion.expectedValues && typeof assertion.expectedValues === 'object') {
            const firstRow = actualRows[0];
            if (!firstRow) {
              passed = false;
              diffReason = 'Truy vấn không trả về dòng dữ liệu nào để đối chiếu expectedValues';
            } else {
              for (const [col, expectedVal] of Object.entries(assertion.expectedValues)) {
                if (firstRow[col] !== expectedVal) {
                  passed = false;
                  diffReason = `Cột "${col}" không khớp: Mong đợi ${JSON.stringify(expectedVal)}, Thực tế nhận được ${JSON.stringify(firstRow[col])}`;
                  break;
                }
              }
            }
          }

          // 3. Custom check function
          if (passed && typeof assertion.customCheck === 'function') {
            try {
              const checkResult = assertion.customCheck(actualRows);
              if (checkResult === false || (checkResult && checkResult.passed === false)) {
                passed = false;
                diffReason = (checkResult && checkResult.message) || 'Hàm customCheck trả về false';
              }
            } catch (fnErr) {
              passed = false;
              diffReason = `Hàm customCheck phát sinh lỗi: ${fnErr.message}`;
            }
          }
        }

        const assertResult = {
          name: assertName,
          query: assertion.query,
          passed,
          rowCount: actualRows ? actualRows.length : 0,
          error: diffReason,
          rows: actualRows
        };

        details.push(assertResult);
        if (!passed) {
          inconsistencies.push(assertResult);
        }
      }
    } finally {
      if (shouldClose && typeof db.close === 'function') {
        try {
          db.close();
        } catch (e) {
          // Bỏ qua lỗi đóng kết nối
        }
      }
    }

    const passed = inconsistencies.length === 0;

    return {
      passed,
      channel: 'db',
      status: passed ? 'PASSED' : 'FAILED',
      total: assertions.length,
      passedCount: assertions.length - inconsistencies.length,
      failedCount: inconsistencies.length,
      inconsistencies,
      details,
      summary: passed
        ? `Database Verifier ĐẠT: 100% (${assertions.length}/${assertions.length}) kiểm tra tính toàn vẹn dữ liệu chính xác.`
        : `Database Verifier THẤT BẠI: ${inconsistencies.length}/${assertions.length} truy vấn dữ liệu sai lệch so với nghiệp vụ.`
    };
  }
}

/**
 * 📦 FixingContextPackGenerator
 * Đóng gói toàn bộ bằng chứng đa kênh (Ảnh lỗi, API lỗi, Stack Traces, DB sai lệch)
 * thành gói ngữ cảnh có cấu trúc cho AI Agent ở bước FIXING.
 */
class FixingContextPackGenerator {
  static generate({ featureName, channels = {}, retryAttempt = 1, metadata = {} }) {
    const failedChannels = [];
    const failedChannelsSummary = [];

    // 1. Phân tích UI
    const uiEvidence = [];
    if (channels.ui && !channels.ui.passed) {
      failedChannels.push('ui');
      failedChannelsSummary.push(`[UI] ${channels.ui.summary}`);
      if (Array.isArray(channels.ui.defects)) {
        channels.ui.defects.forEach(d => uiEvidence.push(d));
      }
    }

    // 2. Phân tích API
    const apiFailures = [];
    if (channels.api && !channels.api.passed) {
      failedChannels.push('api');
      failedChannelsSummary.push(`[API] ${channels.api.summary}`);
      if (Array.isArray(channels.api.failures)) {
        channels.api.failures.forEach(f => apiFailures.push({
          endpoint: `${f.method} ${f.path}`,
          expectedStatus: f.expectedStatus,
          actualStatus: f.actualStatus,
          error: f.error,
          responseSnippet: f.responseSnippet
        }));
      }
    }

    // 3. Phân tích Log
    const logStackTraces = [];
    if (channels.log && !channels.log.passed) {
      failedChannels.push('log');
      failedChannelsSummary.push(`[Log] ${channels.log.summary}`);
      if (Array.isArray(channels.log.stackTraces)) {
        channels.log.stackTraces.forEach(st => logStackTraces.push(st));
      }
      if (Array.isArray(channels.log.violations)) {
        channels.log.violations.forEach(v => logStackTraces.push(`[Line ${v.lineNumber} - ${v.errorType}]: ${v.line}`));
      }
    }

    // 4. Phân tích DB
    const dbInconsistencies = [];
    if (channels.db && !channels.db.passed) {
      failedChannels.push('db');
      failedChannelsSummary.push(`[Database] ${channels.db.summary}`);
      if (Array.isArray(channels.db.inconsistencies)) {
        channels.db.inconsistencies.forEach(i => dbInconsistencies.push({
          name: i.name,
          query: i.query,
          error: i.error
        }));
      }
    }

    // 5. Sinh gợi ý tự động (suggestedFixHints)
    const suggestedFixHints = [];
    if (apiFailures.length > 0) {
      suggestedFixHints.push('Kiểm tra routes, controller và logic xử lý HTTP status code tại các API endpoints bị lỗi.');
    }
    if (logStackTraces.length > 0) {
      suggestedFixHints.push('Khắc phục các unhandled promise rejections hoặc exception stack traces trong file log.');
    }
    if (dbInconsistencies.length > 0) {
      suggestedFixHints.push('Kiểm tra câu lệnh insert/update CSDL, bảo đảm transaction được commit đúng cách.');
    }
    if (uiEvidence.length > 0) {
      suggestedFixHints.push('Kiểm tra các phần tử UI, CSS layout hoặc bổ sung ảnh chụp màn hình cho checkpoint còn thiếu.');
    }

    return {
      featureName: featureName || 'unknown-feature',
      timestamp: new Date().toISOString(),
      retryAttempt,
      failedChannels,
      failedChannelsSummary,
      uiEvidence,
      apiFailures,
      logStackTraces,
      dbInconsistencies,
      suggestedFixHints,
      metadata
    };
  }

  /**
   * Định dạng Markdown báo cáo trực quan cho Agent
   */
  static toMarkdown(pack) {
    let md = `# 🚨 FIXING CONTEXT HANDOFF PACK (Lần thử ${pack.retryAttempt})\n\n`;
    md += `**Tính năng:** \`${pack.featureName}\`\n`;
    md += `**Thời gian tạo:** ${pack.timestamp}\n`;
    md += `**Các kênh thất bại:** ${pack.failedChannels.map(c => `\`${c}\``).join(', ')}\n\n`;

    md += `## 1. Tóm tắt các kênh thất bại\n`;
    pack.failedChannelsSummary.forEach(s => {
      md += `- ${s}\n`;
    });
    md += `\n`;

    if (pack.apiFailures.length > 0) {
      md += `## 2. Chi tiết lỗi API (${pack.apiFailures.length})\n`;
      pack.apiFailures.forEach((f, idx) => {
        md += `### ${idx + 1}. \`${f.endpoint}\`\n`;
        md += `- **Mong đợi:** Status \`${JSON.stringify(f.expectedStatus)}\`\n`;
        md += `- **Thực tế:** Status \`${f.actualStatus}\`\n`;
        md += `- **Lỗi:** ${f.error}\n`;
        if (f.responseSnippet) {
          md += `\`\`\`json\n${f.responseSnippet}\n\`\`\`\n`;
        }
      });
      md += `\n`;
    }

    if (pack.logStackTraces.length > 0) {
      md += `## 3. Log Stack Traces & Runtime Errors (${pack.logStackTraces.length})\n`;
      pack.logStackTraces.forEach((st, idx) => {
        md += `\`\`\`text\n${st}\n\`\`\`\n`;
      });
      md += `\n`;
    }

    if (pack.dbInconsistencies.length > 0) {
      md += `## 4. Sai lệch CSDL (${pack.dbInconsistencies.length})\n`;
      pack.dbInconsistencies.forEach((dbi, idx) => {
        md += `- **${dbi.name}:** ${dbi.error} (Truy vấn: \`${dbi.query}\`)\n`;
      });
      md += `\n`;
    }

    if (pack.uiEvidence.length > 0) {
      md += `## 5. Khiếm khuyết giao diện UI (${pack.uiEvidence.length})\n`;
      pack.uiEvidence.forEach((u, idx) => {
        md += `- [${u.type}] ${u.message}\n`;
      });
      md += `\n`;
    }

    if (pack.suggestedFixHints.length > 0) {
      md += `## 6. Gợi ý hành động khắc phục (Fixing Hints)\n`;
      pack.suggestedFixHints.forEach(h => {
        md += `- 👉 ${h}\n`;
      });
      md += `\n`;
    }

    return md;
  }
}

/**
 * 🚪 MultiVerificationGate
 * Lớp điều phối kiểm chứng đa kênh kế thừa EventEmitter.
 */
class MultiVerificationGate extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.uiCollector = options.uiCollector || new UiEvidenceCollector(options);
    this.apiRunner = options.apiRunner || new ApiTestRunner(options);
    this.logScanner = options.logScanner || new LogScanner(options);
    this.dbVerifier = options.dbVerifier || new DatabaseVerifier(options);
    this.stateMachine = options.stateMachine || null;
    this.db = options.db || null;
  }

  /**
   * Thẩm định đồng thời hoặc tuần tự toàn bộ 4 kênh kiểm chứng
   * @param {Object} params
   * @param {string} params.featureName - Tên tính năng
   * @param {string} params.baseUrl - Địa chỉ local service
   * @param {Object} [params.testPlan] - Kế hoạch test (chứa uiCheckpoints, apiTestSuite, dbAssertions)
   * @param {string|string[]} [params.logs] - Log thu thập được từ Host Child Process
   * @param {Object|string} [params.dbConfig] - Cấu hình DB hoặc file path
   * @param {number} [params.retryAttempt] - Lần retry hiện tại (mặc định 1)
   * @param {string} [params.jobId] - ID của job đang xử lý
   * @returns {Promise<Object>} MultiVerificationResult
   */
  async evaluateAll({
    featureName,
    baseUrl,
    testPlan = {},
    logs = '',
    dbConfig = null,
    retryAttempt = 1,
    jobId = null
  }) {
    this.emit('verification_started', { featureName, jobId, retryAttempt, timestamp: new Date().toISOString() });

    // 1. Chạy song song cả 4 kênh thẩm định
    const [uiSettled, apiSettled, logSettled, dbSettled] = await Promise.allSettled([
      this.uiCollector.verify({
        featureName,
        testPlan,
        evidenceDir: testPlan.evidenceDir || null,
        browserRunner: this.options.browserRunner || null,
        executionLogs: logs
      }),
      this.apiRunner.runTests({
        baseUrl,
        testSuite: testPlan.apiTestSuite || testPlan.apiTests || [],
        headers: testPlan.apiHeaders || {},
        timeoutMs: testPlan.apiTimeoutMs || 10000
      }),
      Promise.resolve(this.logScanner.scanLogs(logs, {
        customPatterns: testPlan.logPatterns || testPlan.logCustomPatterns || null,
        requireBrowserCapture: testPlan.requireBrowserCapture ?? testPlan.requireBrowserEvidence ?? testPlan.logRequireBrowserCapture ?? false
      })),
      this.dbVerifier.verify({
        dbConfig: dbConfig || testPlan.dbConfig || null,
        assertions: testPlan.dbAssertions || testPlan.databaseAssertions || [],
        dbInstance: this.db || this.options.dbInstance || null
      })
    ]);

    // Trích xuất kết quả an toàn
    const uiResult = uiSettled.status === 'fulfilled' ? uiSettled.value : {
      passed: false,
      channel: 'ui',
      status: 'CRASHED',
      summary: `UI Verifier bị lỗi không mong muốn: ${uiSettled.reason?.message || uiSettled.reason}`
    };

    const apiResult = apiSettled.status === 'fulfilled' ? apiSettled.value : {
      passed: false,
      channel: 'api',
      status: 'CRASHED',
      summary: `API Test Runner bị lỗi không mong muốn: ${apiSettled.reason?.message || apiSettled.reason}`
    };

    const logResult = logSettled.status === 'fulfilled' ? logSettled.value : {
      passed: false,
      channel: 'log',
      status: 'CRASHED',
      summary: `Log Scanner bị lỗi không mong muốn: ${logSettled.reason?.message || logSettled.reason}`
    };

    const dbResult = dbSettled.status === 'fulfilled' ? dbSettled.value : {
      passed: false,
      channel: 'db',
      status: 'CRASHED',
      summary: `Database Verifier bị lỗi không mong muốn: ${dbSettled.reason?.message || dbSettled.reason}`
    };

    const channels = {
      ui: uiResult,
      api: apiResult,
      log: logResult,
      db: dbResult
    };

    // 2. Quyết định GateVerdict: CHỈ KHI CẢ 4 KÊNH ĐỀU PASS
    const passed = Boolean(uiResult.passed && apiResult.passed && logResult.passed && dbResult.passed);
    const failedChannels = [];
    if (!uiResult.passed) failedChannels.push('ui');
    if (!apiResult.passed) failedChannels.push('api');
    if (!logResult.passed) failedChannels.push('log');
    if (!dbResult.passed) failedChannels.push('db');

    let summary = '';
    let fixingPack = null;

    if (passed) {
      summary = `✅ HÀNG RÀO KIỂM CHỨNG ĐẠT 100%: Cả 4 kênh (UI, API, Log, Database) đều vượt qua kiểm định thành công. Sẵn sàng hoàn thành Job.`;
      
      this.emit('gate_passed', {
        featureName,
        jobId,
        channels,
        summary
      });

      // Tự động kích hoạt chuyển trạng thái DONE nếu có stateMachine
      if (this.stateMachine && jobId) {
        try {
          if (typeof this.stateMachine.transition === 'function') {
            await this.stateMachine.transition(jobId, 'DONE', { summary, channels });
          }
        } catch (stateErr) {
          this.emit('state_transition_error', { jobId, targetState: 'DONE', error: stateErr.message });
        }
      }
    } else {
      summary = `❌ HÀNG RÀO KIỂM CHỨNG THẤT BẠI: Phát hiện vi phạm tại các kênh [${failedChannels.join(', ')}]. Tự động chuyển sang trạng thái FIXING.`;
      
      fixingPack = FixingContextPackGenerator.generate({
        featureName,
        channels,
        retryAttempt,
        metadata: { jobId, baseUrl }
      });

      this.emit('gate_failed', {
        featureName,
        jobId,
        channels,
        failedChannels,
        fixingPack,
        summary
      });

      // Tự động kích hoạt chuyển trạng thái FIXING nếu có stateMachine
      if (this.stateMachine && jobId) {
        try {
          if (typeof this.stateMachine.transition === 'function') {
            await this.stateMachine.transition(jobId, 'FIXING', {
              failedChannels,
              fixingPack,
              summary
            });
          }
        } catch (stateErr) {
          this.emit('state_transition_error', { jobId, targetState: 'FIXING', error: stateErr.message });
        }
      }
    }

    return {
      passed,
      channels,
      ui: {
        ...uiResult,
        duplicateGroups: uiResult.duplicateGroups || []
      },
      duplicateGroups: uiResult.duplicateGroups || [],
      failedChannels,
      summary,
      fixingPack
    };
  }
}

module.exports = {
  MultiVerificationGate,
  UiEvidenceCollector,
  ApiTestRunner,
  LogScanner,
  DatabaseVerifier,
  FixingContextPackGenerator,
  defaultMaskSecrets
};
