/**
 * secretScrubber.js
 * Quản lý làm sạch và che giấu các thông tin nhạy cảm, API keys, tokens, mật khẩu
 * trong văn bản log, stream đầu ra, biến môi trường và dữ liệu cấu hình.
 */

// Danh sách các biểu thức chính quy nhận diện bí mật (secrets)
const SECRET_PATTERNS = [
  // Anthropic API keys (sk-ant-...)
  {
    name: 'anthropic_key',
    regex: /sk-ant-[a-zA-Z0-9_\-]+/g,
    replace: '***MASKED***'
  },
  // OpenAI & Generic sk keys (sk-...)
  {
    name: 'openai_key',
    regex: /sk-[a-zA-Z0-9_\-]{20,}/g,
    replace: '***MASKED***'
  },
  // GitLab Personal Access Tokens (glpat-...)
  {
    name: 'gitlab_pat',
    regex: /glpat-[a-zA-Z0-9_\-]{20,}/g,
    replace: '***MASKED***'
  },
  // GitHub Personal Access Tokens (ghp_...)
  {
    name: 'github_pat',
    regex: /ghp_[a-zA-Z0-9]{30,}/g,
    replace: '***MASKED***'
  },
  // GitHub OAuth Tokens (gho_...)
  {
    name: 'github_oauth',
    regex: /gho_[a-zA-Z0-9]{30,}/g,
    replace: '***MASKED***'
  },
  // GitHub User-to-Server Tokens (ghu_...)
  {
    name: 'github_user',
    regex: /ghu_[a-zA-Z0-9]{30,}/g,
    replace: '***MASKED***'
  },
  // GitHub Server-to-Server Tokens (ghs_...)
  {
    name: 'github_server',
    regex: /ghs_[a-zA-Z0-9]{30,}/g,
    replace: '***MASKED***'
  },
  // GitHub Refresh Tokens (ghr_...)
  {
    name: 'github_refresh',
    regex: /ghr_[a-zA-Z0-9]{30,}/g,
    replace: '***MASKED***'
  },
  // GitHub Fine-grained Tokens (github_pat_...)
  {
    name: 'github_fine_grained',
    regex: /github_pat_[a-zA-Z0-9_]{30,}/g,
    replace: '***MASKED***'
  },
  // Bearer Tokens (Bearer eyJ... hoặc Bearer <alphanumeric>)
  {
    name: 'bearer_token',
    regex: /(Bearer\s+)[a-zA-Z0-9_\-\.=+~]{15,}/gi,
    replace: '$1***MASKED***'
  },
  // JSON Web Tokens (JWT: eyJ...)
  {
    name: 'jwt_token',
    regex: /eyJ[a-zA-Z0-9_\-]{10,}\.eyJ[a-zA-Z0-9_\-]{10,}\.[a-zA-Z0-9_\-]{10,}/g,
    replace: '***MASKED***'
  },
  // AWS Access Key ID
  {
    name: 'aws_access_key',
    regex: /AKIA[0-9A-Z]{16}/g,
    replace: '***MASKED***'
  },
  // Slack Tokens
  {
    name: 'slack_token',
    regex: /xox[baprs]-[0-9a-zA-Z]{10,48}/g,
    replace: '***MASKED***'
  },
  // Private Key Blocks (PEM)
  {
    name: 'private_key_pem',
    regex: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g,
    replace: '***MASKED***'
  },
  // URL Basic Auth (https://user:password@host)
  {
    name: 'url_basic_auth',
    regex: /(https?:\/\/[^\s/:@]+:)([^\s/@]+)(@)/gi,
    replace: '$1***MASKED***$3'
  },
  // Key-value / JSON / CLI arguments: password, token, secret, api_key
  {
    name: 'key_value_secrets',
    regex: /(["']?(?:password|passwd|pwd|secret|api_key|apikey|access_token|auth_token|client_secret)["']?\s*[:=]\s*["']?)([^"',\s\r\n]{3,})(["']?)/gi,
    replace: '$1***MASKED***$3'
  }
];

// Danh sách các tên trường nhạy cảm trong biến môi trường hoặc object cấu hình
const SENSITIVE_KEY_REGEX = /(?:password|passwd|pwd|secret|key|token|auth|credential|cert|passphrase|signature|private)/i;

/**
 * Hàm che giấu tất cả các bí mật trong chuỗi văn bản
 * @param {string|Buffer|any} text - Chuỗi hoặc dữ liệu cần làm sạch
 * @returns {string} Chuỗi văn bản đã được che giấu toàn bộ secrets
 */
function maskSecrets(text) {
  if (text === null || text === undefined) {
    return '';
  }

  let result = typeof text === 'string' ? text : String(text);

  for (const item of SECRET_PATTERNS) {
    result = result.replace(item.regex, item.replace);
  }

  return result;
}

/**
 * Class SecretScrubber cung cấp các tiện ích xử lý stream, object và biến môi trường
 */
class SecretScrubber {
  /**
   * Khởi tạo bộ làm sạch với các mẫu tùy chỉnh (nếu có)
   * @param {Array<{ name?: string, regex: RegExp, replace: string }>} customPatterns
   */
  constructor(customPatterns = []) {
    this.customPatterns = Array.isArray(customPatterns) ? customPatterns : [];
  }

  /**
   * Che giấu bí mật trong chuỗi văn bản
   * @param {string|any} text
   * @returns {string}
   */
  scrub(text) {
    let result = maskSecrets(text);

    for (const item of this.customPatterns) {
      if (item && item.regex) {
        result = result.replace(item.regex, item.replace || '***MASKED***');
      }
    }

    return result;
  }

  /**
   * Đăng ký lắng nghe Readable Stream và làm sạch dữ liệu theo thời gian thực
   * @param {import('node:stream').Readable} stream - Luồng dữ liệu (stdout/stderr)
   * @param {(data: string) => void} onData - Callback nhận chuỗi đã làm sạch
   * @returns {{ stop: () => void }} Hàm hủy đăng ký
   */
  scrubStream(stream, onData) {
    if (!stream || typeof stream.on !== 'function') {
      throw new Error('Stream không hợp lệ để làm sạch dữ liệu');
    }

    const handler = (chunk) => {
      const rawText = chunk instanceof Buffer ? chunk.toString('utf8') : String(chunk);
      const cleanText = this.scrub(rawText);
      if (typeof onData === 'function') {
        onData(cleanText);
      }
    };

    stream.on('data', handler);

    return {
      stop: () => {
        stream.removeListener('data', handler);
      }
    };
  }

  /**
   * Đệ quy làm sạch object, mảng hoặc giá trị JSON
   * @param {any} obj - Object hoặc giá trị cần làm sạch
   * @returns {any} Bản sao đã được làm sạch
   */
  scrubObject(obj) {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'string') {
      return this.scrub(obj);
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.scrubObject(item));
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        cleaned[key] = '***MASKED***';
      } else {
        cleaned[key] = this.scrubObject(value);
      }
    }

    return cleaned;
  }

  /**
   * Làm sạch bảng biến môi trường (process.env) trước khi log hoặc chia sẻ
   * @param {Record<string, string>} env
   * @returns {Record<string, string>}
   */
  scrubEnv(env) {
    if (!env || typeof env !== 'object') {
      return {};
    }

    const cleanedEnv = {};
    for (const [key, value] of Object.entries(env)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        cleanedEnv[key] = '***MASKED***';
      } else {
        cleanedEnv[key] = typeof value === 'string' ? this.scrub(value) : value;
      }
    }

    return cleanedEnv;
  }
}

// Gắn static method tiện ích
SecretScrubber.maskSecrets = maskSecrets;

module.exports = {
  maskSecrets,
  SecretScrubber
};
