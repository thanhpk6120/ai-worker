const fs = require('node:fs');
const path = require('node:path');

class PromptTemplateManager {
  constructor(templatesDir = path.resolve('templates/prompt')) {
    this.templatesDir = templatesDir;
  }

  /**
   * Đọc file template theo tên bước
   * @param {string} step Tên bước: planning, implement, testing, fixing
   */
  getTemplate(step) {
    // step co the co suffix "-quick" (vd "planning-quick") -> dung template rieng cho task nhe.
    const filename = `${step.toLowerCase()}.md`;
    const fullPath = path.join(this.templatesDir, filename);

    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    // Fallback template mặc định nếu không tìm thấy file
    // Bước IMPLEMENT: cấm tạo evidence (chỉ sửa code + unit test hàm bị ảnh hưởng).
    const isImplement = /^implement/i.test(String(step || ''));
    const evidenceMention = isImplement ? '' : 'ảnh chụp màn hình bằng chứng (evidence/*.png), ';
    const implementRule = isImplement
      ? `3. **BƯỚC IMPLEMENT KHÔNG ĐƯỢC TẠO EVIDENCE:** TUYỆT ĐỐI KHÔNG tạo file nào trong {{FEATURE_DIR}}/evidence/ và KHÔNG tạo hay sửa evidence/metadata.json. Chỉ sửa mã nguồn + viết/thêm unit test cho các hàm bị ảnh hưởng.\n`
      : '';
    return `# Template Prompt cho bước ${step.toUpperCase()}

Task: {{TASK_CODE}}
Yêu cầu: {{PROMPT}}
Workspace: {{WORKSPACE_PATH}}
Thư mục Feature bắt buộc: {{FEATURE_DIR}}

## ⚠️ QUY TẮC BẮT BUỘC VỀ VỊ TRÍ TỆP TIN:
1. Tất cả tài liệu, dữ liệu, ${evidenceMention}logs BẮT BUỘC phải tạo bên trong: {{FEATURE_DIR}}
2. CHỈ KHI sửa code: Mới xác định service cần sửa ở workspace {{WORKSPACE_PATH}} và sửa tại service đó.
${implementRule}

{{PREVIOUS_CONTEXT}}

{{ERROR_LOGS}}

{{CUSTOM_STAGE_PROMPT}}`;
  }

  /**
   * Nạp nội dung template theo tên bước (alias cho getTemplate)
   * @param {string} step
   * @returns {string}
   */
  loadTemplate(step) {
    return this.getTemplate(step);
  }

  /**
   * Render nội dung template với các biến truyền vào
   * @param {string} template
   * @param {Record<string, any>} [variables={}]
   * @returns {string}
   */
  renderTemplate(template, variables = {}) {
    if (!template || typeof template !== 'string') {
      return '';
    }
    let result = template;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      result = result.replace(regex, value !== undefined && value !== null ? String(value) : '');
    }
    return result;
  }

  /**
   * Lưu prompt vào file BÊN TRONG feature dir của task.
   * targetDirOrPath BẮT BUỘC là file/thư mục nằm trong feature dir, từ chối workspace root.
   */
  savePromptFile(prompt, targetDirOrPath, featureDir) {
    if (!targetDirOrPath || !featureDir) {
      throw new Error('Từ chối ghi prompt: cần targetDirOrPath và featureDir, không ghi ra workspace root.');
    }
    const filePath = targetDirOrPath.endsWith('.txt')
      ? targetDirOrPath
      : path.join(targetDirOrPath, 'prompt.md');
    const resolvedOut = path.resolve(filePath);
    const resolvedFeature = path.resolve(featureDir);
    if (!(resolvedOut === resolvedFeature || resolvedOut.startsWith(resolvedFeature + path.sep))) {
      throw new Error(`Từ chối ghi prompt ra ngoài feature dir: ${filePath}`);
    }
    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    fs.writeFileSync(filePath, prompt, 'utf8');
    return filePath;
  }
  /**
   * Lấy danh sách các MCP Server đang được cấu hình trên máy (Claude Code & OMP)
   * @returns {string} Khối Markdown mô tả danh sách MCP
   */
  getActiveMcpServersSection() {
    const os = require('node:os');
    const home = os.homedir();
    const mcpServers = {};

    // 1. Đọc ~/.claude.json
    const claudePath = path.join(home, '.claude.json');
    if (fs.existsSync(claudePath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(claudePath, 'utf8'));
        if (cfg.mcpServers && typeof cfg.mcpServers === 'object') {
          Object.assign(mcpServers, cfg.mcpServers);
        }
      } catch (e) {}
    }

    // 2. Đọc ~/.omp/agent/mcp.json
    const ompMcpPath = path.join(home, '.omp', 'agent', 'mcp.json');
    if (fs.existsSync(ompMcpPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(ompMcpPath, 'utf8'));
        if (cfg.mcpServers && typeof cfg.mcpServers === 'object') {
          Object.assign(mcpServers, cfg.mcpServers);
        }
      } catch (e) {}
    }

    const serverNames = Object.keys(mcpServers);
    if (serverNames.length === 0) {
      return '';
    }

    const descriptions = {
      'company-atlassian': 'Đọc/ghi/tìm kiếm Jira issues, Confluence pages (cần dùng khi gặp mã ticket hoặc link Jira/Confluence)',
      'atlassian': 'Đọc/ghi/tìm kiếm Jira issues, Confluence pages',
      'cloakbrowser': 'Tự động hóa trình duyệt web: mở URL, click, fill, scroll, screenshot, cào dữ liệu DOM',
      'context7': 'Tra cứu tài liệu mới nhất về thư viện, framework, SDK, APIs',
      'gitnexus': 'Phân tích code graph, symbol, cấu trúc mã nguồn dự án',
      'glab': 'Tương tác với GitLab repository, Merge Requests, issues',
      'memorix': 'Quản lý ngữ cảnh, bộ nhớ dự án và bài học kỹ thuật'
    };

    const lines = [
      '## 🔌 DANH SÁCH MCP SERVERS ĐANG ĐƯỢC CẤU HÌNH VÀ KHẢ DỤNG TRONG PHIÊN LÀM VIỆC:',
      'Hệ thống phát hiện các MCP Server sau đã được kết nối sẵn:'
    ];

    for (const name of serverNames) {
      const desc = descriptions[name] || descriptions[name.toLowerCase()] || 'Công cụ chuyên dụng theo domain';
      lines.push(`- **\`${name}\`**: ${desc}`);
    }

    return lines.join('\n') + '\n';
  }

  /**
   * Sinh prompt hoàn chỉnh sau khi thay thế các placeholders
   */
  buildPrompt(options = {}) {
    const {
      step = 'planning',
      taskCode = 'TASK-UNKNOWN',
      userPrompt = '',
      workspacePath = './',
      featureDir = '',
      previousContext = '',
      errorLogs = '',
      saveToFile = false,
      savePromptFile = false,
      outputFile = null
    } = options;
    const template = this.getTemplate(step);

    let contextSection = '';
    if (previousContext && typeof previousContext === 'string' && previousContext.trim()) {
      let trimmedContext = previousContext.trim();
      const MAX_CONTEXT_LENGTH = 12000;
      if (trimmedContext.length > MAX_CONTEXT_LENGTH) {
        trimmedContext = trimmedContext.substring(0, MAX_CONTEXT_LENGTH) + '\n\n... [Ngữ cảnh đã bị cắt bớt do quá dài để đảm bảo an toàn bộ đệm]';
      }
      contextSection = `## Tài liệu & Ngữ cảnh hiện có (Previous Context):\n${trimmedContext}\n`;
    }

    let errorSection = '';
    if (errorLogs && typeof errorLogs === 'string' && errorLogs.trim()) {
      let trimmedError = errorLogs.trim();
      const MAX_ERROR_LENGTH = 8000;
      if (trimmedError.length > MAX_ERROR_LENGTH) {
        trimmedError = trimmedError.substring(0, MAX_ERROR_LENGTH) + '\n... [Logs đã bị cắt bớt do quá dài]';
      }
      errorSection = `## Chi tiết Lỗi kiểm thử (Error Logs):\n\`\`\`\n${trimmedError}\n\`\`\`\n`;
    }
    const mcpSection = (typeof this.getActiveMcpServersSection === 'function')
      ? this.getActiveMcpServersSection()
      : '';

    // Prompt per-task do PLANNING sinh (chi khi PHUC TAP): doc va ghep vao template chuan,
    // khong de LLM planning ghi de outputFile cua buoc sau. Thieu file => chuoi rong.
    let customStagePrompt = '';
    try {
      const s = String(step || '').toLowerCase();
      if (featureDir && (s === 'implement' || s === 'testing' || s === 'fixing')) {
        const customPath = path.join(featureDir, 'prompts', s + '.md');
        const resolvedCustom = path.resolve(customPath);
        const resolvedFeature = path.resolve(featureDir);
        if ((resolvedCustom === resolvedFeature || resolvedCustom.startsWith(resolvedFeature + path.sep)) && fs.existsSync(resolvedCustom)) {
          let raw = fs.readFileSync(resolvedCustom, 'utf8') || '';
          raw = raw.trim();
          const MAX_CUSTOM = 4000;
          if (raw.length > MAX_CUSTOM) raw = raw.substring(0, MAX_CUSTOM) + '\n... [Custom stage prompt da cat bot]';
          if (raw) customStagePrompt = raw;
        }
      }
    try {
            const scrub = require('../execution/secretScrubber');
            const maskFn = scrub && (scrub.maskSecrets || (scrub.SecretScrubber && scrub.SecretScrubber.maskSecrets));
            if (typeof maskFn === 'function') customStagePrompt = maskFn(customStagePrompt);
          } catch (e2) {}
        } catch (e) { customStagePrompt = ''; }
    if (!customStagePrompt) {
      customStagePrompt = '_Khong co chi dan dac thu theo scope (task khong phuc tap)._';
    }

    const filledPrompt = template
      .replace(/\{\{TASK_CODE\}\}/g, taskCode || 'TASK-UNSPECIFIED')
      .replace(/\{\{PROMPT\}\}/g, userPrompt || '')
      .replace(/\{\{WORKSPACE_PATH\}\}/g, workspacePath || './')
      .replace(/\{\{FEATURE_DIR\}\}/g, featureDir || '')
      .replace(/\{\{PREVIOUS_CONTEXT\}\}/g, contextSection)
      .replace(/\{\{ERROR_LOGS\}\}/g, errorSection)
      .replace(/\{\{MCP_SERVERS\}\}/g, mcpSection)
      .replace(/\{\{CUSTOM_STAGE_PROMPT\}\}/g, customStagePrompt);

    // KHÔNG ghi prompt ra workspace root. Nếu caller yêu cầu lưu file, chỉ cho phép
    // ghi vào thư mục feature của task (outputFile phải nằm trong featureDir).
    if (saveToFile || savePromptFile || outputFile) {
      if (!outputFile) {
        throw new Error('Từ chối ghi prompt: outputFile bắt buộc phải nằm trong feature dir, không ghi ra workspace root.');
      }
      const resolvedOut = path.resolve(outputFile);
      const resolvedFeature = featureDir ? path.resolve(featureDir) : null;
      if (!resolvedFeature || !(resolvedOut === resolvedFeature || resolvedOut.startsWith(resolvedFeature + path.sep))) {
        throw new Error(`Từ chối ghi prompt ra ngoài feature dir: ${outputFile}`);
      }
      fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
      fs.writeFileSync(resolvedOut, filledPrompt, 'utf8');
    }

    return filledPrompt;
  }
}

const defaultPromptTemplateManager = new PromptTemplateManager();

module.exports = {
  PromptTemplateManager,
  defaultPromptTemplateManager
};
