const { spawnSync } = require('node:child_process');
const config = require('../config');
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
    // KHÔNG ghi file prompt ra cwd/workspace root. Prompt đã được build sẵn
    // từ templates/prompt/*.md và file ngữ cảnh trong feature dir, truyền trực tiếp qua args.
    return {
      command: this.command,
      args: this.buildArgs(prompt, options)
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
    const rawSlug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const cmd = (this.command || '').toLowerCase();

    if (cmd.includes('claude')) {
      return path.join(os.homedir(), '.claude', 'projects', rawSlug);
    }
    if (cmd.includes('omp')) {
      // OMP bọc 2 gạch 2 đầu và 2 gạch cuối: D:\... -> --D--Thanhpk-...-services--
      const fs = require('node:fs');
      const ompBase = path.join(os.homedir(), '.omp', 'agent', 'sessions');
      const exact = path.join(ompBase, `--${rawSlug}--`);
      try {
        if (fs.existsSync(exact)) return exact;
        if (fs.existsSync(ompBase)) {
          const hit = fs.readdirSync(ompBase).find((f) => f.includes(rawSlug));
          if (hit) return path.join(ompBase, hit);
        }
      } catch (e) {}
      return exact;
    }
    if (cmd.includes('opencode')) {
      return path.join(os.homedir(), '.opencode', 'sessions', rawSlug);
    }
    if (cmd.includes('codex')) {
      return path.join(os.homedir(), '.codex', 'sessions', rawSlug);
    }
    if (cmd.includes('antigravity')) {
      return path.join(os.homedir(), '.antigravity', 'sessions', rawSlug);
    }
    return null;
  }

  /**
   * Quét file log mới nhất: hỗ trợ cả file trực tiếp và file trong thư mục con 1 cấp (OMP)
   */
  findLatestSessionFile(sessionDir) {
    const fs = require('node:fs');
    const path = require('node:path');
    const exts = ['.jsonl', '.json', '.log'];
    const candidates = [];

    for (const entry of fs.readdirSync(sessionDir)) {
      const fullPath = path.join(sessionDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && exts.some(e => entry.endsWith(e))) {
          candidates.push({ path: fullPath, mtime: stat.mtimeMs });
        } else if (stat.isDirectory()) {
          // OMP lồng session trong thư mục con cùng tên: quét sâu thêm 1 cấp
          for (const sub of fs.readdirSync(fullPath)) {
            const subPath = path.join(fullPath, sub);
            try {
              const subStat = fs.statSync(subPath);
              if (subStat.isFile() && exts.some(e => sub.endsWith(e))) {
                candidates.push({ path: subPath, mtime: subStat.mtimeMs });
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.length > 0 ? candidates[0].path : null;
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
    const { prompt = '', cwd = process.cwd(), onStderr = null, jobId = null, extraArgs = [] } = options;
    const originalOnStdout = options.onStdout;
    const fs = require('node:fs');
    const path = require('node:path');
    const { defaultProcessManager } = require('../execution/processManager');
    let proc = null;
    let earlyExitTriggered = false;
    let earlyExitKilled = false;
    let earlyExitTimer = null;
    let lastThoughtNorm = '';
    let thoughtRepeatCount = 0;
    let stallWarned = false;
    // Phát hiện thought lặp đơn giản: cùng 1 thought (chuẩn hóa 140 ký tự đầu) lặp 3 lần liên tiếp -> cảnh báo STALL 1 lần, không kill (tránh over-build).
    const checkThoughtRepeat = (chunk) => {
      if (stallWarned) return;
      const raw = typeof chunk === 'string' ? chunk : String(chunk);
      const clean = raw.replace(/\x1b\[[0-9;]*m/g, '');
      if (clean.includes('[AI-AGENT-PROCESS')) return;
      const norm = clean.trim().slice(0, 140);
      if (!norm) return;
      if (norm === lastThoughtNorm) {
        thoughtRepeatCount += 1;
      } else {
        lastThoughtNorm = norm;
        thoughtRepeatCount = 1;
      }
      if (thoughtRepeatCount >= 3) {
        stallWarned = true;
        if (typeof originalOnStdout === 'function') {
          originalOnStdout('\n[STALL] Phat hien thought/output lap 3 lan lien tiep — agent co the bi ket, theo doi them.\n');
        }
      }
    };
    const checkEarlyExit = (chunk) => {
      if (earlyExitTriggered) return;
      const text = typeof chunk === 'string' ? chunk : String(chunk);
      const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
      if (clean.includes('[TOOL CALL] yield') || clean.includes('"reason": "Status: DONE') || clean.includes('Status: DONE')) {
        earlyExitTriggered = true;
        earlyExitTimer = setTimeout(async () => {
          try {
            if (!proc || !proc.child) return;
            if (proc.child.exitCode !== null || proc.child.signalCode !== null) return;
            const record = typeof defaultProcessManager.getProcess === 'function' ? defaultProcessManager.getProcess(proc.pid) : null;
            if (record && record.status && record.status !== 'RUNNING') return;
            earlyExitKilled = true;
            if (typeof originalOnStdout === 'function') {
              originalOnStdout('\n[EARLY-EXIT] Phát hiện tín hiệu hoàn tất từ Agent (yield / Status: DONE). Đã tự động kết thúc tiến trình an toàn.\n');
            }
            if (jobId) {
              await defaultProcessManager.killProcessesByJobId(jobId, 2000).catch(() => {});
            } else if (proc && typeof proc.kill === 'function') {
              await proc.kill(2000).catch(() => {});
            }
          } catch (e) {}
        }, 6000);
        if (earlyExitTimer && typeof earlyExitTimer.unref === 'function') earlyExitTimer.unref();
      }
    };
    const onStdout = (chunk) => {
      if (typeof originalOnStdout === 'function') {
        try { originalOnStdout(chunk); } catch (e) {}
      }
      try { checkEarlyExit(chunk); } catch (e) {}
      try { checkThoughtRepeat(chunk); } catch (e) {}
    };


    // Truyền trực tiếp prompt vào args qua buildArgs, không tạo file đệm prompt.md
    // Tránh sinh file rác, tránh lỗi quyền thư mục và Agent không phải tốn turn đọc file
    const effectiveArgs = this.buildArgs(prompt, options);
    const detection = this.detect();
    const effectiveCommand = (detection && detection.installed && detection.path) ? detection.path : this.command;

    // In trực tiếp lệnh AI CLI thực tế ra Live Terminal
    const displayArgs = effectiveArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
    const fullCliLine = `${effectiveCommand} ${displayArgs}`;
    if (typeof onStdout === 'function') {
      onStdout(`\r\n\x1b[1;36m[AI-AGENT-PROCESS]\x1b[0m \x1b[1;32m$ ${fullCliLine}\x1b[0m\r\n\x1b[90m[Thư mục làm việc: ${cwd}]\x1b[0m\r\n\x1b[90m────────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n`);
    }

    // MCP handshake/tool-search qua env: chỉ áp cho claude/omp (CLI có cơ chế MCP xác minh được).
    // codex/opencode/antigravity: grep --help không có flag/env MCP tương ứng nên không ép (xem comment từng adapter).
    const mcpHandshakeTimeout = String(config.MCP_HANDSHAKE_TIMEOUT_MS !== undefined && config.MCP_HANDSHAKE_TIMEOUT_MS !== null ? config.MCP_HANDSHAKE_TIMEOUT_MS : 60000);
    const mcpToolSearch = config.MCP_TOOL_SEARCH_ENABLED ? 'true' : 'false';
    const cmdForMcpCheck = String((typeof effectiveCommand === 'string' && effectiveCommand) || this.command || '');
    const isMcpManagedRunner = /(^|[^a-z])(claude|omp)([^a-z]|$)/i.test(cmdForMcpCheck) || this.name === 'claude-code' || this.name === 'omp';
    const mcpEnv = isMcpManagedRunner ? {
      MCP_TIMEOUT: mcpHandshakeTimeout,
      MCP_HANDSHAKE_TIMEOUT: mcpHandshakeTimeout,
      MCP_HANDSHAKE_TIMEOUT_MS: mcpHandshakeTimeout,
      OMP_MCP_TIMEOUT_MS: mcpHandshakeTimeout,
      ENABLE_TOOL_SEARCH: mcpToolSearch
    } : {};
    const procEnv = Object.assign({}, process.env, mcpEnv);

    proc = defaultProcessManager.spawnProcess({
      command: effectiveCommand,
      args: effectiveArgs,
      cwd,
      env: procEnv,
      jobId,
      onStdout,
      onStderr,
      // Đặt shell: false khi chạy trực tiếp binary .exe để tránh cmd.exe bóc tách làm mất dấu nháy và tham số
      shell: effectiveCommand.endsWith('.cmd') || effectiveCommand.endsWith('.bat'),
      timeoutMs: config.normalizeTimeoutMs(options, config.DEFAULT_TIMEOUT_MS)
    });

    // Cải tiến: Nếu stdout qua pipe bị chặn (như Claude/OMP headless ẩn stream),
    // tự động tìm file log session nội bộ gần nhất của agent để nạp bù hiển thị ra giao diện.
    let lastOutTime = Date.now();
    proc.child.stdout.on('data', () => { lastOutTime = Date.now(); });

    // Biến state cục bộ cho mỗi lần execute (tránh lỗi cache kích thước file cũ giữa các lần chạy)
    const executeStartTime = Date.now();
    const tailState = {
      currentFile: null,
      readOffset: 0,
      lineBuffer: ''
    };

    const tailTimer = setInterval(() => {
      // Nếu stdout im lặng quá 2s, tự động kích hoạt Session File Watcher cho runner tương ứng
      if (Date.now() - lastOutTime > 2000) {
        const sessionDir = this.getSessionDir(cwd);

        if (sessionDir && fs.existsSync(sessionDir)) {
          try {
            const latestFile = this.findLatestSessionFile(sessionDir);
            if (latestFile) {
              const stat = fs.statSync(latestFile);

              // Nếu chuyển sang file session mới hoặc file bị reset: đặt lại offset đọc
              if (tailState.currentFile !== latestFile || stat.size < tailState.readOffset) {
                tailState.currentFile = latestFile;
                // Tránh phát lại toàn bộ history của file cũ: Nếu file sửa đổi TRƯỚC khi execute() chạy,
                // hoặc đây là lần đầu thấy file nhưng file đã có sẵn nội dung từ trước -> bỏ qua phần cũ.
                tailState.readOffset = (stat.mtimeMs < executeStartTime) ? stat.size : 0;
                tailState.lineBuffer = '';
              }

              if (stat.size > tailState.readOffset) {
                const readLength = stat.size - tailState.readOffset;
                const fd = fs.openSync(latestFile, 'r');
                const buffer = Buffer.alloc(readLength);
                fs.readSync(fd, buffer, 0, readLength, tailState.readOffset);
                fs.closeSync(fd);
                tailState.readOffset = stat.size;

                const chunkText = tailState.lineBuffer + buffer.toString('utf-8');
                const lines = chunkText.split(/\r?\n/);
                // Giữ lại phần dư chưa hoàn thành dòng cuối cùng vào lineBuffer
                tailState.lineBuffer = lines.pop() || '';

                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  try { checkEarlyExit(trimmed); } catch (e) {}

                  // 1. Phân tích định dạng JSON/JSONL chuẩn
                  try {
                    const obj = JSON.parse(trimmed);
                    // A. THOUGHT / REASONING: hỗ trợ định dạng Claude (message.content) và OMP (content.text)
                    let thoughtText = '';
                    if (obj.message && obj.message.role === 'assistant') {
                      if (Array.isArray(obj.message.content)) {
                        const thinkingPart = obj.message.content.find(c => c.type === 'thinking' || c.type === 'thought');
                        if (thinkingPart) thoughtText = thinkingPart.thinking || thinkingPart.text || '';
                        else {
                          // OMP dùng type text/toolCall: chỉ gom phần text thuần
                          thoughtText = obj.message.content
                            .filter(c => c.type === 'text' && c.text)
                            .map(c => c.text)
                            .join('\n');
                        }
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

                    // B2. TOOL CALL của OMP: content[].type === 'toolCall' (camelCase)
                    if (obj.message && Array.isArray(obj.message.content)) {
                      for (const part of obj.message.content) {
                        if ((part.type === 'toolCall' || part.type === 'tool_call' || (part.name && part.arguments)) && typeof onStdout === 'function') {
                          const toolName = part.name || part.tool || 'tool';
                          let argsPreview = '';
                          try {
                            argsPreview = JSON.stringify(part.arguments || part.input || {}).substring(0, 100);
                          } catch (e) {}
                          onStdout(`\x1b[35m[TOOL CALL]\x1b[0m ${toolName} (${argsPreview})\n`);
                        }
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
    if (earlyExitTimer) {
      clearTimeout(earlyExitTimer);
      earlyExitTimer = null;
    }
    
    // Ghi đè trạng thái nếu đây là early exit thành công
    if (earlyExitKilled) {
      result.exitCode = 0;
      result.timedOut = false;
      result.status = 'COMPLETED';
    }

    clearInterval(tailTimer);
    if (typeof onStdout === 'function') {
      const exitColor = result.exitCode === 0 ? '\x1b[32m' : '\x1b[31m';
      onStdout(`\r\n\x1b[90m────────────────────────────────────────────────────────────────────────────────\x1b[0m\r\n${exitColor}[AI-AGENT-PROCESS-EXIT] Tiến trình CLI kết thúc với mã: ${result.exitCode}\x1b[0m\r\n`);
    }
    return result;
  }
}
module.exports = BaseAdapter;
