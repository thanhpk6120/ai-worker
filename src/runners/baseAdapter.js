const { spawnSync } = require('node:child_process');

class BaseAdapter {
  /**
   * @param {string} name - Tên định danh của runner
   * @param {string} command - Lệnh CLI thực thi
   * @param {object} options - Các tùy chọn bổ sung (aliases, enabled, etc.)
   */
  constructor(name, command, options = {}) {
    this.name = name;
    this.command = command;
    this.options = options;
    this.aliases = Array.isArray(options.aliases)
      ? options.aliases
      : options.alias
        ? [options.alias]
        : [];
    this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : true;
  }

  /**
   * Kiểm tra CLI có được cài đặt trên hệ thống hay không
   * @returns {{ installed: boolean, version: string | null, path: string | null }}
   */
  detect() {
    try {
      const isWindows = process.platform === 'win32';
      const lookupCmd = isWindows ? 'where' : 'which';
      const lookupResult = spawnSync(lookupCmd, [this.command], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      });

      let installed = false;
      let binPath = null;
      let version = null;

      if (lookupResult.status === 0 && lookupResult.stdout && lookupResult.stdout.trim().length > 0) {
        installed = true;
        binPath = lookupResult.stdout.trim().split(/\r?\n/)[0].trim();
      }

      if (installed) {
        const verResult = spawnSync(this.command, ['--version'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000
        });

        if (verResult.status === 0 && verResult.stdout && verResult.stdout.trim().length > 0) {
          version = verResult.stdout.trim().split(/\r?\n/)[0].trim();
        } else if (verResult.stderr && verResult.stderr.trim().length > 0) {
          version = verResult.stderr.trim().split(/\r?\n/)[0].trim();
        }
      }

      return {
        installed,
        version,
        path: binPath
      };
    } catch (err) {
      return {
        installed: false,
        version: null,
        path: null,
        error: err.message
      };
    }
  }

  /**
   * Xây dựng câu lệnh và tham số thực thi
   * @param {string} prompt
   * @param {object} options
   * @returns {{ command: string, args: string[] }}
   */
  buildCommand(prompt, options = {}) {
    let effectivePrompt = prompt;
    const cwd = options.cwd || process.cwd();
    if (prompt && (prompt.length > 150 || prompt.includes('\n'))) {
      const fs = require('node:fs');
      const path = require('node:path');
      try {
        const promptFile = path.join(cwd, '.task_prompt.txt');
        fs.writeFileSync(promptFile, prompt, 'utf-8');
        const safePromptFile = process.platform === 'win32' || promptFile.includes(' ') ? `"${promptFile}"` : promptFile;
        effectivePrompt = `Đọc kỹ và thực thi toàn bộ yêu cầu trong tệp ${safePromptFile}`;
      } catch (e) {
        console.warn('Ghi tệp .task_prompt.txt cảnh báo:', e.message);
      }
    }
    return {
      command: this.command,
      args: this.buildArgs(effectivePrompt, options)
    };
  }

  /**
   * Xây dựng mảng tham số (args)
   * @param {string} prompt
   * @param {object} options
   * @returns {string[]}
   */
  buildArgs(prompt, options = {}) {
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    return [prompt, ...extraArgs];
  }

  /**
   * Che giấu các API key / token nhạy cảm trong văn bản log
   * @param {string} text
   * @returns {string}
   */
  maskSecrets(text) {
    if (typeof text !== 'string') {
      if (text === null || text === undefined) return '';
      text = String(text);
    }

    return text
      .replace(/sk-ant-[a-zA-Z0-9_\-]+/g, '***MASKED***')
      .replace(/sk-[a-zA-Z0-9_\-]+/g, '***MASKED***')
      .replace(/ghp_[a-zA-Z0-9]+/g, '***MASKED***')
      .replace(/github_pat_[a-zA-Z0-9_]+/g, '***MASKED***');
  }

  /**
   * Phân tích stream output thô thành danh sách các dòng log có cấu trúc
   * @param {string|Buffer} data
   * @param {string} type - 'stdout' | 'stderr' | 'info'
   * @returns {Array<{ timestamp: string, type: string, content: string }>}
   */
  parseOutput(data, type = 'stdout') {
    if (!data) return [];
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const lines = text.split(/\r?\n/);

    const logs = [];
    for (const line of lines) {
      if (line.length === 0) continue;
      logs.push({
        timestamp: new Date().toISOString(),
        type,
        content: this.maskSecrets(line)
      });
    }

    return logs;
  }

  /**
   * Tóm tắt kết quả chạy từ toàn bộ log output
   * @param {string} fullOutput
   * @returns {{ success: boolean, totalLines: number, errorCount: number, summary: string }}
   */
  /**
   * Xác định thư mục session log trên đĩa cho từng loại runner
   * @param {string} cwd - Thư mục làm việc hiện tại
   * @returns {string|null} Đường dẫn thư mục session hoặc null
   */
  getSessionDir(cwd = process.cwd()) {
    const os = require('node:os');
    const path = require('node:path');
    // Claude Code và các runner tạo slug bằng cách thay ký tự không phải chữ/số thành dấu gạch đơn,
    // KHÔNG được gộp dấu gạch liên tiếp (ví dụ D:\... -> D--Thanhpk-...)
    const projSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const cmd = (this.command || '').toLowerCase();

    if (cmd.includes('claude')) {
      return path.join(os.homedir(), '.claude', 'projects', projSlug);
    }
    if (cmd.includes('omp')) {
      return path.join(os.homedir(), '.omp', 'agent', 'sessions', projSlug);
    }
    if (cmd.includes('opencode')) {
      return path.join(os.homedir(), '.opencode', 'sessions', projSlug);
    }
    if (cmd.includes('codex')) {
      return path.join(os.homedir(), '.codex', 'sessions', projSlug);
    }
    if (cmd.includes('antigravity')) {
      return path.join(os.homedir(), '.antigravity', 'sessions', projSlug);
    }
    return null;
  }

  parseSummary(fullOutput) {
    if (typeof fullOutput !== 'string') {
      fullOutput = fullOutput ? String(fullOutput) : '';
    }

    const lines = fullOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const masked = this.maskSecrets(fullOutput);

    const errorRegex = /(error|failed|exception|fatal|denied)/i;
    let errorCount = 0;
    for (const line of lines) {
      if (errorRegex.test(line)) {
        errorCount++;
      }
    }

    const lastLines = lines.slice(-5).map((l) => this.maskSecrets(l)).join('; ');

    return {
      success: errorCount === 0,
      totalLines: lines.length,
      errorCount,
      summary: lastLines || (lines.length > 0 ? this.maskSecrets(lines[lines.length - 1]) : 'No output')
    };
  }

  /**
   * Thực thi tiến trình Agent CLI qua processManager
   */
  async execute(options = {}) {
    const { prompt = '', cwd = process.cwd(), onStdout = null, onStderr = null, jobId = null, extraArgs = [] } = options;
    const fs = require('node:fs');
    const path = require('node:path');
    const { defaultProcessManager } = require('../execution/processManager');

    let effectiveArgs = this.buildArgs(prompt, options);

    // An toàn tuyệt đối trên Windows: Ghi prompt ra tệp .task_prompt.txt nếu prompt dài hoặc có nhiều dòng
    if (prompt && (prompt.length > 150 || prompt.includes('\n'))) {
      try {
        const promptFile = path.join(cwd, '.task_prompt.txt');
        fs.writeFileSync(promptFile, prompt, 'utf-8');
        // Không bọc nháy kép trực tiếp vào chuỗi nếu dùng child_process.spawn() vì cmd.exe sẽ bóc tách sai và cắt mất args.
        // Node.js sẽ tự động escape đối số chứa khoảng trắng.
        const safePromptFile = promptFile;
        const safePrompt = `Please read and strictly execute all instructions in "${safePromptFile}"`;
        effectiveArgs = this.buildArgs(safePrompt, options);
      } catch (e) {
        console.warn('Ghi tệp .task_prompt.txt cảnh báo:', e.message);
      }
    }
    const detection = this.detect();
    const effectiveCommand = (detection && detection.installed && detection.path) ? detection.path : this.command;

    // In trực tiếp lệnh AI CLI thực tế ra Live Terminal
    const displayArgs = effectiveArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
    const fullCliLine = `${effectiveCommand} ${displayArgs}`;
    if (typeof onStdout === 'function') {
      onStdout(`\r\n\x1b[1;36m[AI-AGENT-PROCESS]\x1b[0m \x1b[1;32m$ ${fullCliLine}\x1b[0m\r\n\x1b[90m[Thư mục làm việc: ${cwd}]\x1b[0m\r\n\x1b[90m────────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n`);
    }

    const proc = defaultProcessManager.spawnProcess({
      command: effectiveCommand,
      args: effectiveArgs,
      cwd,
      jobId,
      onStdout,
      onStderr,
      // Đặt shell: false khi chạy trực tiếp binary .exe để tránh cmd.exe bóc tách làm mất dấu nháy và tham số
      shell: effectiveCommand.endsWith('.cmd') || effectiveCommand.endsWith('.bat'),
      timeoutMs: options.timeoutMs || 900000
    });

    // Cải tiến: Nếu stdout qua pipe bị chặn (như Claude/OMP headless ẩn stream), 
    // tự động tìm file log session nội bộ gần nhất của agent để nạp bù hiển thị ra giao diện.
    let lastOutTime = Date.now();
    proc.child.stdout.on('data', () => { lastOutTime = Date.now(); });
    
    const tailTimer = setInterval(() => {
      // Nếu stdout im lặng quá 3.5s, tự động kích hoạt Session File Watcher cho runner tương ứng
      if (Date.now() - lastOutTime > 3500) {
        const sessionDir = this.getSessionDir(cwd);

        if (sessionDir && fs.existsSync(sessionDir)) {
          try {
            const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.jsonl') || f.endsWith('.json') || f.endsWith('.log'));
            if (files.length > 0) {
              files.sort((a, b) => fs.statSync(path.join(sessionDir, b)).mtimeMs - fs.statSync(path.join(sessionDir, a)).mtimeMs);
              const latestFile = path.join(sessionDir, files[0]);
              const stat = fs.statSync(latestFile);
              if (!this._lastSize) this._lastSize = stat.size - 3000 > 0 ? stat.size - 3000 : 0;
              if (stat.size > this._lastSize) {
                const fd = fs.openSync(latestFile, 'r');
                const buffer = Buffer.alloc(stat.size - this._lastSize);
                fs.readSync(fd, buffer, 0, buffer.length, this._lastSize);
                fs.closeSync(fd);
                this._lastSize = stat.size;

                const lines = buffer.toString('utf-8').split('\n');
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;

                  // 1. Phân tích định dạng JSON/JSONL chuẩn
                  try {
                    const obj = JSON.parse(trimmed);

                    // A. THOUGHT / REASONING
                    let thoughtText = '';
                    if (obj.message && obj.message.role === 'assistant') {
                      if (Array.isArray(obj.message.content)) {
                        const thinkingPart = obj.message.content.find(c => c.type === 'thinking' || c.type === 'thought');
                        if (thinkingPart) thoughtText = thinkingPart.thinking || thinkingPart.text || '';
                        else thoughtText = obj.message.content.map(c => c.text || '').join('');
                      } else if (typeof obj.message.content === 'string') {
                        thoughtText = obj.message.content;
                      }
                    } else if (obj.type === 'thought' || obj.thought || obj.reasoning) {
                      thoughtText = obj.thought || obj.reasoning || obj.content || '';
                    }

                    if (thoughtText && typeof onStdout === 'function') {
                      const firstLine = thoughtText.split('\n')[0].trim();
                      if (firstLine) {
                        onStdout(`\x1b[36m[AGENT THOUGHT]\x1b[0m ${firstLine.substring(0, 140)}...\n`);
                      }
                    }

                    // B. ACTION
                    const actionName = obj.action || obj.title || (obj.message && obj.message.action);
                    if (actionName && typeof onStdout === 'function') {
                      onStdout(`\x1b[33m[AGENT ACTION]\x1b[0m ${String(actionName).substring(0, 140)}\n`);
                    }

                    // C. TOOL CALL
                    let toolName = '';
                    let toolInput = '';
                    if (obj.type === 'tool_use' || obj.tool) {
                      toolName = obj.name || obj.tool || 'unknown_tool';
                      toolInput = JSON.stringify(obj.input || obj.args || '').substring(0, 100);
                    } else if (obj.message && Array.isArray(obj.message.content)) {
                      const toolUsePart = obj.message.content.find(c => c.type === 'tool_use');
                      if (toolUsePart) {
                        toolName = toolUsePart.name;
                        toolInput = JSON.stringify(toolUsePart.input || '').substring(0, 100);
                      }
                    }

                    if (toolName && typeof onStdout === 'function') {
                      onStdout(`\x1b[35m[TOOL CALL]\x1b[0m ${toolName} (${toolInput})\n`);
                    }
                  } catch (e) {
                    // 2. Phân tích raw text dòng log nếu không phải JSON
                    if (typeof onStdout === 'function' && trimmed.length > 5) {
                      if (/thinking|thought|reasoning/i.test(trimmed)) {
                        onStdout(`\x1b[36m[AGENT THOUGHT]\x1b[0m ${trimmed.substring(0, 140)}\n`);
                      } else if (/executing|action|running/i.test(trimmed)) {
                        onStdout(`\x1b[33m[AGENT ACTION]\x1b[0m ${trimmed.substring(0, 140)}\n`);
                      } else if (/tool|call|function/i.test(trimmed)) {
                        onStdout(`\x1b[35m[TOOL CALL]\x1b[0m ${trimmed.substring(0, 140)}\n`);
                      }
                    }
                  }
                }
              }
            }
          } catch (e) {}
        }
      }
    }, 2000);

    const result = await proc.wait();
    clearInterval(tailTimer);
    if (typeof onStdout === 'function') {
      const exitColor = result.exitCode === 0 ? '\x1b[32m' : '\x1b[31m';
      onStdout(`\r\n\x1b[90m────────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n${exitColor}[AI-AGENT-PROCESS-EXIT] Tiến trình CLI kết thúc với mã: ${result.exitCode}\x1b[0m\r\n`);
    }
    return result;
  }
}
module.exports = BaseAdapter;
