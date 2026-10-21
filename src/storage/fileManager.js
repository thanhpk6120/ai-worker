const fs = require('node:fs');
const path = require('node:path');

class FileManager {
  /**
   * Chuẩn hóa đường dẫn workspace tuyệt đối, xử lý đúng trên cả Windows và Linux
   * Tránh lỗi ghép nhầm cwd vào đường dẫn tuyệt đối (join vs resolve)
   */
  resolveWorkspacePath(workspacePath = './') {
    let ws = String(workspacePath || './').trim();
    // Xử lý leading slash trước drive letter kiểu unix trên Windows (/D:/... -> D:/...)
    if (/^\/[a-zA-Z]:[/\\]/.test(ws)) {
      ws = ws.slice(1);
    }
    // Nếu đã là đường dẫn tuyệt đối (ví dụ D:\... hoặc /var/...) thì normalize trực tiếp
    if (path.isAbsolute(ws)) {
      return path.normalize(ws);
    }
    return path.resolve(process.cwd(), ws);
  }

  /**
   * Xác định đường dẫn thư mục feature cho task
   * Chuẩn bắt buộc: <workspacePath>/docs/features/<taskCode>/
   * Hỗ trợ tương thích ngược với docs/features/ hoặc feature/ nếu thư mục đó đã tồn tại trước
   */
  getFeatureDirectory(workspacePath = './', taskCode = 'DEFAULT-TASK', featuresDir = 'docs/features') {
    const cleanTaskCode = String(taskCode || '').trim().replace(/[/\\?%*:|"<>]/g, '-');
    const resolvedWorkspace = this.resolveWorkspacePath(workspacePath);

    // Chuẩn chính thức: <workspace>/<featuresDir>/<taskCode>
    const primaryPath = path.resolve(resolvedWorkspace, featuresDir, cleanTaskCode);

    // Tương thích ngược nếu đã tồn tại trước đó:
    const legacyFeaturesPath = path.resolve(resolvedWorkspace, 'docs', 'features', cleanTaskCode);
    const legacyFeaturePath = path.resolve(resolvedWorkspace, 'feature', cleanTaskCode);

    if (fs.existsSync(primaryPath)) {
      return primaryPath;
    }
    if (fs.existsSync(legacyFeaturesPath)) {
      return legacyFeaturesPath;
    }
    if (fs.existsSync(legacyFeaturePath)) {
      return legacyFeaturePath;
    }

    return primaryPath;
  }

  /**
   * Kiểm tra xem thư mục feature cho task đã tồn tại hay chưa
   */
  checkFeatureDirectoryExists(workspacePath, taskCode, featuresDir = 'docs/features') {
    const rawTaskCode = String(taskCode || '').trim();
    if (!rawTaskCode) return false;

    const resolvedWorkspace = this.resolveWorkspacePath(workspacePath || './');
    const cleanTaskCode = rawTaskCode.replace(/[/\\?%*:|"<>]/g, '-');

    const primaryPath = path.resolve(resolvedWorkspace, featuresDir, cleanTaskCode);
    const legacyFeaturesPath = path.resolve(resolvedWorkspace, 'docs', 'features', cleanTaskCode);
    const legacyFeaturePath = path.resolve(resolvedWorkspace, 'feature', cleanTaskCode);

    return fs.existsSync(primaryPath) || fs.existsSync(legacyFeaturesPath) || fs.existsSync(legacyFeaturePath);
  }

  /**
   * Tự động tính toán mã task gợi ý tiếp theo với hậu tố (ví dụ: -v2, -v3...)
   * cho đến khi tìm được mã chưa có thư mục trên workspace
   */
  suggestNextTaskCode(workspacePath, taskCode, featuresDir = 'docs/features') {
    const rawTaskCode = String(taskCode || '').trim();
    if (!rawTaskCode) return 'TASK-01';

    // Kiểm tra xem taskCode đã có đuôi dạng -v(\d+) chưa
    const vMatch = rawTaskCode.match(/^(.*?)-v(\d+)$/i);
    let baseCode = rawTaskCode;
    let counter = 2;

    if (vMatch) {
      baseCode = vMatch[1];
      counter = parseInt(vMatch[2], 10) + 1;
    } else {
      // Kiểm tra đuôi dạng -(\d+)
      const numMatch = rawTaskCode.match(/^(.*?)-(\d+)$/);
      if (numMatch && parseInt(numMatch[2], 10) > 0) {
        baseCode = numMatch[1];
        counter = parseInt(numMatch[2], 10) + 1;
      }
    }

    let candidate = `${baseCode}-v${counter}`;
    while (this.checkFeatureDirectoryExists(workspacePath, candidate, featuresDir)) {
      counter += 1;
      candidate = `${baseCode}-v${counter}`;
      if (counter > 100) break; // Giới hạn an toàn
    }

    return candidate;
  }

  /**
   * Bỏ các mục "bằng chứng" (evidence) khỏi nội dung markdown.
   * Dùng cho bước IMPLEMENT: kế hoạch thu evidence là việc của bước TESTING,
   * IMPLEMENT không tạo evidence nên không cần đọc phần đó.
   */
  stripEvidenceSections(content) {
    if (!content) return content;
    const lines = String(content).split(/\r?\n/);
    const isEvidenceHeading = (t) => /b[aă]ng\s*ch[aứ]ng|bang\s*chung|evidence/i.test(t);
    const headingLevel = (line) => {
      const m = /^(#{1,6})\s/.exec(line);
      return m ? m[1].length : 0;
    };
    const out = [];
    let skipLevel = 0;
    for (const line of lines) {
      const lvl = headingLevel(line);
      if (skipLevel) {
        // Đang bỏ mục -> dừng khi gặp heading cùng cấp hoặc cao hơn.
        if (lvl && lvl <= skipLevel) skipLevel = 0;
        else continue;
      }
      if (lvl && isEvidenceHeading(line)) { skipLevel = lvl; continue; }
      out.push(line);
    }
    return out.join('\n');
  }

  /**
   * Đảm bảo thư mục feature và thư mục evidence tồn tại
   * @param {string} workspacePath Đường dẫn workspace
   * @param {string} taskCode Mã task
   * @param {object} options Tùy chọn: allowExisting (mặc định false cho tạo mới)
   */
  ensureFeatureDirectory(workspacePath, taskCode, { allowExisting = false, featuresDir = 'docs/features' } = {}) {
    const rawTaskCode = String(taskCode || '').trim();
    if (!rawTaskCode) {
      throw new Error('Mã task không được để trống.');
    }

    const resolvedWorkspace = this.resolveWorkspacePath(workspacePath || './');
    if (!fs.existsSync(resolvedWorkspace)) {
      throw new Error(`Đường dẫn workspace '${workspacePath}' không tồn tại trên hệ thống.`);
    }

    const dir = this.getFeatureDirectory(workspacePath, rawTaskCode, featuresDir);
    const evidenceDir = path.join(dir, 'evidence');
    console.log(`[FileManager] ensureFeatureDirectory: dir=${dir}, allowExisting=${allowExisting}, exists=${fs.existsSync(dir)}`);

    // Nếu không cho phép thư mục đã tồn tại mà thư mục đã có từ trước: Báo lỗi và gợi ý hậu tố
    if (!allowExisting && fs.existsSync(dir)) {
      const suggested = this.suggestNextTaskCode(workspacePath, rawTaskCode, featuresDir);
      console.log(`[FileManager] Directory already exists: ${dir} -> suggest: ${suggested}`);
      const err = new Error(`Thư mục 'docs/features/${rawTaskCode}' đã tồn tại trên workspace. Vui lòng chọn mã task khác.`);
      err.code = 'FOLDER_ALREADY_EXISTS';
      err.suggestedTaskCode = suggested;
      throw err;
    }
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(evidenceDir)) {
        fs.mkdirSync(evidenceDir, { recursive: true });
      }
    } catch (err) {
      throw new Error(`Không thể tạo thư mục tính năng tại '${dir}': ${err.message}. Vui lòng kiểm tra quyền truy cập hoặc ký tự trong mã task.`);
    }

    return { dir, evidenceDir };
  }
  /**
   * Ghi file expect.md ban đầu khi tạo task
   */
  saveExpectFile(workspacePath, taskCode, { title, prompt, author = 'User', featuresDir = 'docs/features', allowExisting = true }) {
    const { dir } = this.ensureFeatureDirectory(workspacePath, taskCode, { allowExisting, featuresDir });
    const filePath = path.join(dir, 'expect.md');
    const content = `# Đặc tả yêu cầu (expect.md)
## Task: ${taskCode} - ${title || 'Chưa đặt tên'}

- **Mã Task:** \`${taskCode}\`
- **Người tạo:** ${author}
- **Ngày tạo:** ${new Date().toISOString()}
- **Thư mục Feature:** \`${dir}\`

---

### 1. Yêu cầu nghiệp vụ (User Prompt)
${prompt || 'Không có mô tả chi tiết.'}

---

### 2. Quy tắc bắt buộc về lưu trữ tệp (Storage Rules)
- **TẤT CẢ** các tài liệu kỹ thuật (\`plan.md\`, \`dev_plan.md\`, \`test_plan.md\`, \`tasks.md\`, \`testcase.md\`, \`impact.md\`, \`report.md\`, \`deploy.md\`...), tệp dữ liệu, tệp ảnh màn hình bằng chứng (\`evidence/*.png\`), và log kiểm thử **BẮT BUỘC** phải được tạo bên trong thư mục này (\`${dir}\`).
- **CHỈ KHI SỬA CODE**: Mới xác định service/module cụ thể cần sửa trong workspace và thực hiện sửa đổi mã nguồn tại workspace đó.

---

### 3. Tiêu chí nghiệm thu ban đầu
- Hoàn thành đầy đủ các yêu cầu nêu trên.
- Kiểm thử thành công qua Browser Testing và Multi-Verification Gate.
- Không phát sinh lỗi runtime hay exception.
`;

    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Ghi nội dung Dev Plan và Test Plan ra tệp .md trong thư mục feature
   */
  saveDualPlanFiles(workspacePath, taskCode, { devPlanMarkdown, testPlanMarkdown, featuresDir = 'docs/features' }) {
    const { dir } = this.ensureFeatureDirectory(workspacePath, taskCode, { allowExisting: true, featuresDir });

    const devPlanPath = path.join(dir, 'dev_plan.md');
    const testPlanPath = path.join(dir, 'test_plan.md');

    if (devPlanMarkdown) {
      fs.writeFileSync(devPlanPath, devPlanMarkdown, 'utf-8');
    }

    if (testPlanMarkdown) {
      fs.writeFileSync(testPlanPath, testPlanMarkdown, 'utf-8');
    }

    return { devPlanPath, testPlanPath };
  }

  /**
   * Đọc trực tiếp các file plan markdown từ thư mục feature
   */
  readPlanFiles(workspacePath, taskCode, featuresDir = 'docs/features') {
    const dir = this.getFeatureDirectory(workspacePath, taskCode, featuresDir);

    let devPlan = null;
    let testPlan = null;
    let expect = null;

    const devPlanPath = path.join(dir, 'dev_plan.md');
    const planFallback = path.join(dir, 'plan.md');
    if (fs.existsSync(devPlanPath)) {
      devPlan = fs.readFileSync(devPlanPath, 'utf-8');
    } else if (fs.existsSync(planFallback)) {
      devPlan = fs.readFileSync(planFallback, 'utf-8');
    }

    const testPlanPath = path.join(dir, 'test_plan.md');
    const testcaseFallback = path.join(dir, 'testcase.md');
    if (fs.existsSync(testPlanPath)) {
      testPlan = fs.readFileSync(testPlanPath, 'utf-8');
    } else if (fs.existsSync(testcaseFallback)) {
      testPlan = fs.readFileSync(testcaseFallback, 'utf-8');
    }

    const expectPath = path.join(dir, 'expect.md');
    if (fs.existsSync(expectPath)) {
      expect = fs.readFileSync(expectPath, 'utf-8');
    }

    return {
      featureDir: dir,
      expect,
      devPlan,
      testPlan
    };
  }

  /**
   * Nạp toàn bộ các file .md trong thư mục feature để làm ngữ cảnh truyền cho AI
   */
  loadPreviousContext(workspacePath, taskCode, step = null, featuresDir = 'docs/features') {
    if (typeof step === 'string' && (step.includes('/') || step.includes('\\'))) {
      featuresDir = step;
      step = null;
    }
    const dir = this.getFeatureDirectory(workspacePath, taskCode, featuresDir);
    if (!fs.existsSync(dir)) return '';

    let context = '';
    let filesToLoad = [];

    const stepLower = step ? String(step).toLowerCase() : null;
    // Bước IMPLEMENT (kể cả implement-quick): bỏ mục bằng chứng khỏi test_plan.md.
    const isImplementStep = stepLower === 'implement' || stepLower === 'implement-quick';
    let stripEvidenceFrom = null;
    
    if (stepLower === 'planning') {
      filesToLoad = ['expect.md', 'context.md'];
    } else if (isImplementStep) {
      filesToLoad = ['dev_plan.md', 'test_plan.md'];
      // Bước IMPLEMENT không được thấy phần "bằng chứng" của test_plan.md:
      // kế hoạch thu evidence là việc của bước TESTING, còn IMPLEMENT chỉ
      // sửa mã nguồn + viết unit test cho hàm bị ảnh hưởng.
      stripEvidenceFrom = 'test_plan.md';
      if (!fs.existsSync(path.join(dir, 'dev_plan.md')) && fs.existsSync(path.join(dir, 'plan.md'))) {
        filesToLoad.push('plan.md');
      }
    } else if (stepLower === 'testing') {
      filesToLoad = ['dev_plan.md', 'test_plan.md', 'report.md'];
    } else if (stepLower === 'fixing') {
      filesToLoad = ['dev_plan.md', 'test_plan.md', 'test_report.md', 'report.md'];
      if (!fs.existsSync(path.join(dir, 'dev_plan.md')) && fs.existsSync(path.join(dir, 'plan.md'))) {
        filesToLoad.push('plan.md');
      }
    } else {
      filesToLoad = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    }

    filesToLoad = [...new Set(filesToLoad)];
    const MAX_SECTION_LENGTH = 8000;

    for (const file of filesToLoad) {
      try {
        const fullPath = path.join(dir, file);
        if (fs.existsSync(fullPath)) {
          let fileContent = fs.readFileSync(fullPath, 'utf-8');
          if (stripEvidenceFrom && file === stripEvidenceFrom) {
            fileContent = this.stripEvidenceSections(fileContent);
          }
          if (fileContent.length > MAX_SECTION_LENGTH) {
            fileContent = fileContent.substring(0, MAX_SECTION_LENGTH) + '\n... [Nội dung đã bị cắt bớt do vượt quá giới hạn 8,000 ký tự để tránh tràn bộ đệm CLI]';
          }
          context += `### Tệp \`${file}\`:\n\`\`\`markdown\n${fileContent}\n\`\`\`\n\n`;
        }
      } catch (e) {
        // bỏ qua nếu lỗi đọc
      }
    }

    return context;
  }
}

const defaultFileManager = new FileManager();

module.exports = {
  FileManager,
  defaultFileManager
};
