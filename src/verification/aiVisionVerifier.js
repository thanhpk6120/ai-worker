/**
 * src/verification/aiVisionVerifier.js
 * Thẩm định bằng chứng hình ảnh (UI_SCREENSHOT) hoàn toàn bằng AI Vision.
 * TUYỆT ĐỐI KHÔNG sử dụng OCR để tránh sai sót chữ và layout.
 *
 * Nhận vào: đường dẫn file ảnh, tiêu chí kỳ vọng (expected criteria / pass criteria), tên test case.
 * Trả về JSON: { passed: boolean, reason: string, details?: string }
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/**
 * Đọc API key & Base URL từ môi trường hoặc settings local (không bao giờ hardcode trong source)
 */
function resolveVisionConfig() {
  let apiKey = process.env.AI_VISION_API_KEY || '';
  let baseUrl = process.env.AI_VISION_BASE_URL || '';

  // Đọc từ ~/.claude/settings.json (nơi cấu hình omniroute và token thật của agent)
  try {
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(claudeSettingsPath)) {
      const raw = fs.readFileSync(claudeSettingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const env = parsed && parsed.env ? parsed.env : {};
      if (!baseUrl && env.ANTHROPIC_BASE_URL) baseUrl = env.ANTHROPIC_BASE_URL;
      if (!apiKey && env.ANTHROPIC_AUTH_TOKEN) apiKey = env.ANTHROPIC_AUTH_TOKEN;
    }
  } catch (e) {}

  // Fallback sang các biến môi trường hệ thống khác nếu vẫn chưa có
  if (!baseUrl) {
    baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://omniroute.thanhpk.io.vn/v1';
  }
  // Các model Vision có tiền tố 9r/* chỉ định tuyến được trên omniroute gateway (trên 9router báo lỗi thiếu provider)
  if (baseUrl.includes('9router.thanhpk.io.vn')) {
    baseUrl = 'https://omniroute.thanhpk.io.vn/v1';
  }
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.SYSTEMONE_API_KEY || '';
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey
  };
}

const PRIMARY_MODEL = process.env.AI_VISION_MODEL || '9r/claude-sonnet-5';
const FALLBACK_MODELS = ['9r/claude-sonnet-5-medium', '9r/claude-sonnet-5-low'];

/**
 * Xác định MIME type từ đuôi file
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'image/png';
  }
}

/**
 * Gọi AI Vision để thẩm định một file ảnh theo Expectation
 * @param {object} params
 * @param {string} params.imagePath Đường dẫn file ảnh trên đĩa
 * @param {string} [params.expectedCriteria] Tiêu chí nghiệm thu cần đạt được trong ảnh
 * @param {string} [params.testCaseName] Tên test case / bước kiểm thử
 * @param {string} [params.stepName] Tên step hoặc mô tả
 * @param {number} [params.timeoutMs=35000] Timeout gọi API
 * @returns {Promise<{ passed: boolean, reason: string, details: string, modelUsed: string }>}
 */
async function verifyImageWithAI({
  imagePath,
  expectedCriteria = '',
  testCaseName = '',
  stepName = '',
  timeoutMs = 35000
}) {
  if (!fs.existsSync(imagePath)) {
    return {
      passed: false,
      reason: `File ảnh không tồn tại trên đĩa: ${path.basename(imagePath)}`,
      details: 'File missing from evidence directory',
      modelUsed: 'none'
    };
  }

  let imgBuffer;
  try {
    imgBuffer = fs.readFileSync(imagePath);
    if (!imgBuffer || imgBuffer.length < 50) {
      return {
        passed: false,
        reason: `File ảnh ${path.basename(imagePath)} rỗng hoặc dung lượng quá nhỏ (${imgBuffer ? imgBuffer.length : 0} bytes)`,
        details: 'Empty or corrupted image file',
        modelUsed: 'none'
      };
    }
  } catch (err) {
    return {
      passed: false,
      reason: `Không thể đọc file ảnh ${path.basename(imagePath)}: ${err.message}`,
      details: err.stack,
      modelUsed: 'none'
    };
  }

  const base64Data = imgBuffer.toString('base64');
  const mimeType = getMimeType(imagePath);
  const dataUrl = `data:${mimeType};base64,${base64Data}`;

  const caseTitle = testCaseName || stepName || path.basename(imagePath);
  const criteriaText = expectedCriteria && expectedCriteria.trim()
    ? expectedCriteria.trim()
    : 'Hình ảnh phải hiển thị giao diện phần mềm hoàn chỉnh, rõ ràng, có dữ liệu thực tế, không bị lỗi render trắng trang hoặc giao diện trống (blank layout).';

  const userPrompt = `Bạn là Chuyên gia QA Kiểm thử Thẩm định Bằng chứng (AI Vision Quality Verifier).
Nhiệm vụ của bạn là thẩm định hình ảnh kiểm thử đính kèm theo tiêu chí kỳ vọng (Expectation / Pass Criteria).

Test Case: "${caseTitle}"
Tiêu chí kỳ vọng cần đạt (Expectation):
"${criteriaText}"

YÊU CẦU THẨM ĐỊNH (BẮT BUỘC):
1. Quan sát trực tiếp bằng thị giác máy học toàn bộ nội dung hình ảnh (giao diện, bảng biểu, thanh trạng thái, form dữ liệu, thông báo kết quả...).
2. TUYỆT ĐỐI KHÔNG dùng OCR ước lượng chữ. Hãy phân tích trực quan toàn diện.
3. Đánh giá xem hình ảnh có THỰC SỰ đáp ứng đúng Tiêu chí kỳ vọng hay không:
   - Nếu ảnh đúng giao diện/tính năng, đúng dữ liệu hoặc trạng thái kỳ vọng: passed = true.
   - Nếu ảnh bị trắng trang, sai màn hình, thiếu thành phần kỳ vọng, báo lỗi không mong muốn hoặc không liên quan: passed = false.
4. BẮT BUỘC trả về định dạng JSON DUY NHẤT (không thêm văn bản ngoài JSON):
{
  "passed": true | false,
  "reason": "Mô tả ngắn gọn, rõ ràng lý do đạt hoặc không đạt",
  "details": "Chi tiết những gì nhìn thấy trên ảnh so với tiêu chí kỳ vọng"
}`;

  const { baseUrl, apiKey } = resolveVisionConfig();
  if (!apiKey) {
    return {
      passed: false,
      reason: 'Thiếu API Key để gọi AI Vision verifier (cần cấu hình AI_VISION_API_KEY hoặc ANTHROPIC_AUTH_TOKEN)',
      details: 'Missing vision API credentials',
      modelUsed: 'none'
    };
  }

  const modelsToTry = [PRIMARY_MODEL, ...FALLBACK_MODELS];
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: userPrompt },
                { type: 'image_url', image_url: { url: dataUrl } }
              ]
            }
          ],
          max_tokens: 300,
          response_format: { type: 'json_object' }
        }),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        lastError = new Error(`AI Vision HTTP ${response.status} (${model}): ${errBody.slice(0, 150)}`);
        continue;
      }

      const resData = await response.json();
      const content = resData.choices && resData.choices[0] && resData.choices[0].message && resData.choices[0].message.content;
      if (!content) {
        lastError = new Error(`AI Vision trả về rỗng (${model})`);
        continue;
      }

      let parsedResult;
      try {
        const cleanJson = content.replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
        parsedResult = JSON.parse(cleanJson);
      } catch (parseErr) {
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          parsedResult = JSON.parse(match[0]);
        } else {
          lastError = new Error(`Không thể parse JSON từ AI Vision (${model}): ${content.slice(0, 100)}`);
          continue;
        }
      }

      return {
        passed: parsedResult.passed === true,
        reason: parsedResult.reason || (parsedResult.passed ? 'Hình ảnh đáp ứng đầy đủ tiêu chí kỳ vọng' : 'Hình ảnh không đạt tiêu chí kỳ vọng'),
        details: parsedResult.details || '',
        modelUsed: model
      };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    passed: false,
    reason: `Lỗi kết nối AI Vision khi thẩm định ảnh ${path.basename(imagePath)}: ${lastError ? lastError.message : 'Unknown error'}`,
    details: lastError ? lastError.stack : '',
    modelUsed: 'failed-all'
  };
}

module.exports = {
  verifyImageWithAI,
  getMimeType,
  resolveVisionConfig
};
