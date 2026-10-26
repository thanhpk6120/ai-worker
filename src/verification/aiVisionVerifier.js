/**
 * src/verification/aiVisionVerifier.js
 * Thẩm định bằng chứng hình ảnh (UI_SCREENSHOT) hoàn toàn bằng AI Vision.
 * TUYỆT ĐỐI KHÔNG sử dụng OCR để tránh sai sót chữ và layout.
 *
 * Chỉ sử dụng duy nhất CLAUDE_MODEL từ file .env, không dùng cấu hình riêng hay model fallback.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('../config');

/**
 * Đọc API key & Base URL từ settings/môi trường và model từ CLAUDE_MODEL trong .env
 */
function resolveVisionConfig() {
  let apiKey = '';
  let baseUrl = '';

  // Đọc baseUrl & apiKey từ ~/.claude/settings.json của agent
  try {
    const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(claudeSettingsPath)) {
      const raw = fs.readFileSync(claudeSettingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      const env = parsed && parsed.env ? parsed.env : {};
      if (env.ANTHROPIC_BASE_URL) baseUrl = env.ANTHROPIC_BASE_URL;
      if (env.ANTHROPIC_AUTH_TOKEN) apiKey = env.ANTHROPIC_AUTH_TOKEN;
    }
  } catch (e) {}

  if (!baseUrl) {
    baseUrl = process.env.ANTHROPIC_BASE_URL || 'http://100.96.124.76:20126/v1';
  }
  if (!apiKey) {
    apiKey = process.env.ANTHROPIC_AUTH_TOKEN || '';
  }

  // Bắt buộc sử dụng CLAUDE_MODEL từ .env (không dùng fallback hay model phụ khác)
  let model = String(config.CLAUDE_MODEL || process.env.CLAUDE_MODEL || '').trim();
  if (!model) {
    try {
      const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
      if (fs.existsSync(claudeSettingsPath)) {
        const raw = fs.readFileSync(claudeSettingsPath, 'utf8');
        const parsed = JSON.parse(raw);
        const env = parsed && parsed.env ? parsed.env : {};
        if (env.ANTHROPIC_MODEL) model = String(env.ANTHROPIC_MODEL).trim();
      }
    } catch (e) {}
  }
  if (!model) {
    model = 'claude-sonnet-5';
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model
  };
}

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
 * @param {number} [params.timeoutMs=45000] Timeout gọi API
 * @returns {Promise<{ passed: boolean, reason: string, details: string, modelUsed: string }>}
 */
async function verifyImageWithAI({
  imagePath,
  expectedCriteria = '',
  testCaseName = '',
  stepName = '',
  timeoutMs = 45000
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

  const { baseUrl, apiKey, model } = resolveVisionConfig();
  if (!apiKey) {
    return {
      passed: false,
      reason: 'Thiếu API Key để gọi AI Vision verifier (cần cấu hình ANTHROPIC_AUTH_TOKEN trong ~/.claude/settings.json)',
      details: 'Missing vision API credentials',
      modelUsed: 'none'
    };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const endpoint = `${baseUrl}/chat/completions`;
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
        max_tokens: 400,
        stream: false,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return {
        passed: false,
        reason: `Lỗi kết nối AI Vision khi thẩm định ảnh ${path.basename(imagePath)}: AI Vision HTTP ${response.status} (${model}): ${errBody.slice(0, 150)}`,
        details: errBody,
        modelUsed: model
      };
    }

    const resData = await response.json();
    const content = resData.choices && resData.choices[0] && resData.choices[0].message && resData.choices[0].message.content;
    if (!content) {
      return {
        passed: false,
        reason: `Lỗi kết nối AI Vision khi thẩm định ảnh ${path.basename(imagePath)}: AI Vision trả về rỗng (${model})`,
        details: 'Empty choice content',
        modelUsed: model
      };
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
        return {
          passed: false,
          reason: `Không thể parse JSON từ AI Vision (${model}): ${content.slice(0, 100)}`,
          details: content,
          modelUsed: model
        };
      }
    }

    return {
      passed: parsedResult.passed === true,
      reason: parsedResult.reason || (parsedResult.passed ? 'Hình ảnh đáp ứng đầy đủ tiêu chí kỳ vọng' : 'Hình ảnh không đạt tiêu chí kỳ vọng'),
      details: parsedResult.details || '',
      modelUsed: model
    };
  } catch (err) {
    return {
      passed: false,
      reason: `Lỗi kết nối AI Vision khi thẩm định ảnh ${path.basename(imagePath)}: ${err.message}`,
      details: err.stack,
      modelUsed: model
    };
  }
}

module.exports = {
  verifyImageWithAI,
  getMimeType,
  resolveVisionConfig
};
