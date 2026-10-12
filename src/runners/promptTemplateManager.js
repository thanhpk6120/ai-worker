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
    const filename = `${step.toLowerCase()}.md`;
    const fullPath = path.join(this.templatesDir, filename);

    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath, 'utf-8');
    }
    // Fallback template mặc định nếu không tìm thấy file
    return `# Template Prompt cho bước ${step.toUpperCase()}

Task: {{TASK_CODE}}
Yêu cầu: {{PROMPT}}
Workspace: {{WORKSPACE_PATH}}
Thư mục Feature bắt buộc: {{FEATURE_DIR}}

## ⚠️ QUY TẮC BẮT BUỘC VỀ VỊ TRÍ TỆP TIN:
1. Tất cả tài liệu, dữ liệu, ảnh chụp màn hình bằng chứng (evidence/*.png), logs BẮT BUỘC phải tạo bên trong: {{FEATURE_DIR}}
2. CHỈ KHI sửa code: Mới xác định service cần sửa ở workspace {{WORKSPACE_PATH}} và sửa tại service đó.

{{PREVIOUS_CONTEXT}}

{{ERROR_LOGS}}`;
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
    if (previousContext && previousContext.trim()) {
      contextSection = `## Tài liệu & Ngữ cảnh hiện có (Previous Context):\n${previousContext}\n`;
    }

    let errorSection = '';
    if (errorLogs && errorLogs.trim()) {
      errorSection = `## Chi tiết Lỗi kiểm thử (Error Logs):\n\`\`\`\n${errorLogs}\n\`\`\`\n`;
    }

    const mcpSection = (typeof this.getActiveMcpServersSection === 'function')
      ? this.getActiveMcpServersSection()
      : '';

    const filledPrompt = template
      .replace(/\{\{TASK_CODE\}\}/g, taskCode || 'TASK-UNSPECIFIED')
      .replace(/\{\{PROMPT\}\}/g, userPrompt || '')
      .replace(/\{\{WORKSPACE_PATH\}\}/g, workspacePath || './')
      .replace(/\{\{FEATURE_DIR\}\}/g, featureDir || '')
      .replace(/\{\{PREVIOUS_CONTEXT\}\}/g, contextSection)
      .replace(/\{\{ERROR_LOGS\}\}/g, errorSection)
      .replace(/\{\{MCP_SERVERS\}\}/g, mcpSection);

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
