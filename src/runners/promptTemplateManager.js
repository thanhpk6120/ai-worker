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
   * Lưu nội dung prompt ra tệp UTF-8 (.task_prompt.txt mặc định)
   * @param {string} prompt
   * @param {string} [targetDirOrPath='./']
   * @returns {string} Đường dẫn tệp đã lưu
   */
  savePromptFile(prompt, targetDirOrPath = './') {
    const filePath = targetDirOrPath.endsWith('.txt')
      ? targetDirOrPath
      : path.join(targetDirOrPath, '.task_prompt.txt');
    fs.writeFileSync(filePath, prompt, 'utf8');
    return filePath;
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

    const filledPrompt = template
      .replace(/\{\{TASK_CODE\}\}/g, taskCode || 'TASK-UNSPECIFIED')
      .replace(/\{\{PROMPT\}\}/g, userPrompt || '')
      .replace(/\{\{WORKSPACE_PATH\}\}/g, workspacePath || './')
      .replace(/\{\{FEATURE_DIR\}\}/g, featureDir || '')
      .replace(/\{\{PREVIOUS_CONTEXT\}\}/g, contextSection)
      .replace(/\{\{ERROR_LOGS\}\}/g, errorSection);

    if (saveToFile || savePromptFile || outputFile) {
      const targetPath = outputFile || path.join(workspacePath || './', '.task_prompt.txt');
      fs.writeFileSync(targetPath, filledPrompt, 'utf8');
    }

    return filledPrompt;
  }
}

const defaultPromptTemplateManager = new PromptTemplateManager();

module.exports = {
  PromptTemplateManager,
  defaultPromptTemplateManager
};
