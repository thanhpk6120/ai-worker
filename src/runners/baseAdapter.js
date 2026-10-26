const { spawnSync, spawn } = require('node:child_process');
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
    const now = Date.now();
    const cache = this._detectCache;

    // Cache con hieu luc -> tra cache, KHONG spawn (0ms).
    if (cache && cache.value && (now - cache.at) < config.DETECT_TTL_MS) {
      return cache.value;
    }

    // CHUA co gia tri nao -> phai tra ket qua CHINH XAC (installed that).
    // `getAvailableRunner()` (dung truoc moi pipeline step) phu thuoc `installed`,
    // tra `installed:false` gia se chon sai runner. Lan dau chi chay 1 lan,
    // cac lan sau dung cache.
    if (!cache || !cache.value) {
      const value = this._detectSync();
      this._detectCache = { at: Date.now(), value };
      return value;
    }

    // Cache da het han nhung van co gia tri cu -> tra gia tri cu (stale-while-revalidate)
    // va refresh nen bang spawn bat dong bo. Khong chan event loop.
    this._refreshDetectAsync();
    return cache.value;
  }

  /**
  * Detect dong bo (chi dung cho lan dau khoi tao cache).
  * Giu nguyen hanh vi cua ban goc: `where`/`which` + `--version`, timeout 5000ms.
  */
  _detectSync() {
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
  * Refresh ket qua detect() o background (khong chan event loop).
  * Dung `spawn` (bat dong bo) thay `spawnSync` -> moi pipeline step khong con
  * treo ~1,4s. Cap nhat cache khi hoan tat.
  */
  _refreshDetectAsync() {
    if (this._detectRefreshing) return;
    this._detectRefreshing = true;

    const isWindows = process.platform === 'win32';
    const lookupCmd = isWindows ? 'where' : 'which';

    const runCmd = (cmd, args) => new Promise((resolve) => {
      let child;
      try {
        child = spawn(cmd, args, { encoding: 'utf8', windowsHide: true });
      } catch (err) {
        resolve({ status: -1, stdout: '', stderr: String(err && err.message || err) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch (e) {}
        resolve({ status: -1, stdout, stderr });
      }, 5000);
      child.stdout && child.stdout.on('data', (d) => { stdout += d; });
      child.stderr && child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: -1, stdout, stderr: String(err && err.message || err) });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr });
      });
    });

    (async () => {
      let installed = false;
      let binPath = null;
      let version = null;
      try {
        const lookupResult = await runCmd(lookupCmd, [this.command]);
        if (lookupResult.status === 0 && lookupResult.stdout && lookupResult.stdout.trim().length > 0) {
          installed = true;
          binPath = lookupResult.stdout.trim().split(/\r?\n/)[0].trim();
        }
        if (installed) {
          const verResult = await runCmd(this.command, ['--version']);
          if (verResult.status === 0 && verResult.stdout && verResult.stdout.trim().length > 0) {
            version = verResult.stdout.trim().split(/\r?\n/)[0].trim();
          } else if (verResult.stderr && verResult.stderr.trim().length > 0) {
            version = verResult.stderr.trim().split(/\r?\n/)[0].trim();
          }
        }
        this._detectCache = {
          at: Date.now(),
          value: { installed, version, path: binPath }
        };
      } catch (err) {
        this._detectCache = {
          at: Date.now(),
          value: { installed: false, version: null, path: null, error: err.message }
        };
      } finally {
        this._detectRefreshing = false;
      }
    })();
  }

  /**
   * Tạo prompt điều phối ngắn gọn hướng dẫn Agent đọc file prompt tuyệt đối
   * Giúp tránh lỗi tràn giới hạn độ dài dòng lệnh hệ thống (ENAMETOOLONG / 32,767 ký tự) trên Windows CLI.
   * @param {string} absolutePromptPath
   * @param {object} options
   * @returns {string}
   */
  formatDispatchPrompt(absolutePromptPath, options = {}) {
    const path = require('node:path');
    const stepLabel = options.step ? ` [Bước: ${options.step}]` : '';
    const taskLabel = options.taskCode ? ` [Task: ${options.taskCode}]` : '';
    const normalizedPath = path.resolve(absolutePromptPath);
    return [
      `Hãy đọc kỹ và thực thi toàn bộ yêu cầu, chỉ dẫn được chỉ định trong tệp sau:${stepLabel}${taskLabel}`,
      `Đường dẫn tuyệt đối: ${normalizedPath}`,
      '',
      'BẮT BUỘC: Bạn phải mở và đọc toàn bộ nội dung tệp trên trước khi thực hiện bất kỳ hành động nào, sau đó tuân thủ 100% các quy tắc và chỉ dẫn trong tệp đó để hoàn thành nhiệm vụ.'
    ].join('\n');
  }

  /**
   * Xây dựng câu lệnh và tham số thực thi
   * @param {string} prompt
   * @param {object} options
   * @returns {{ command: string, args: string[] }}
   */
  buildCommand(prompt, options = {}) {
    const path = require('node:path');
    let effectivePrompt = prompt;
    if (options && !options.rawPrompt) {
      if (options.promptFilePath) {
        effectivePrompt = this.formatDispatchPrompt(options.promptFilePath, options);
      } else if (options.featureDir) {
        const stepName = String(options.step || 'task').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const promptFileName = options.promptFileName || `prompt_${stepName}.md`;
        const resolvedPromptPath = path.resolve(path.join(options.featureDir, promptFileName));
        effectivePrompt = this.formatDispatchPrompt(resolvedPromptPath, options);
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
    const candidates = [];

    try {
      for (const entry of fs.readdirSync(sessionDir)) {
        const fullPath = path.join(sessionDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          // Chỉ lấy file session .jsonl chính ở cấp sessionDir (tránh file log/temp/advisor trong thư mục con)
          if (stat.isFile() && entry.endsWith('.jsonl') && !entry.startsWith('__')) {
            candidates.push({ path: fullPath, mtime: stat.mtimeMs });
          }
        } catch (e) {}
      }
    } catch (e) {}

    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates.length > 0 ? candidates[0].path : null;
  }
  /**
   * Quét tất cả các file session và subagent đang hoạt động
   * Hỗ trợ:
   * 1. File session chính tại root sessionDir (*.jsonl)
   * 2. Mọi file subagent trong các thư mục con <sessionId>/subagents/*.jsonl (Claude Code)
   * 3. Thư mục con của OMP, Codex, OpenCode
   */
  findActiveSessionFiles(sessionDir, minMtime = 0) {
    const fs = require('node:fs');
    const path = require('node:path');
    const files = [];

    const scanDir = (dir, depth = 0) => {
      if (depth > 2 || !fs.existsSync(dir)) return;
      try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
          if (entry.startsWith('.') || entry.startsWith('__')) continue;
          const fullPath = path.join(dir, entry);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isFile() && entry.endsWith('.jsonl')) {
              if (stat.mtimeMs >= minMtime) {
                const isSubagent = fullPath.includes('subagents') || entry.startsWith('agent-');
                let agentLabel = '';
                if (isSubagent) {
                  const m = entry.match(/^agent-([a-zA-Z0-9]+)/);
                  agentLabel = m ? m[1].slice(0, 8) : 'subagent';
                }
                files.push({ path: fullPath, mtime: stat.mtimeMs, size: stat.size, isSubagent, agentLabel });
              }
            } else if (stat.isDirectory() && depth < 2) {
              if (depth === 0 || entry === 'subagents') {
                scanDir(fullPath, depth + 1);
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    };

    scanDir(sessionDir, 0);
    files.sort((a, b) => a.mtime - b.mtime);
    return files;
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
    const {
      prompt = '',
      cwd = process.cwd(),
      onStderr = null,
      jobId = null,
      extraArgs = [],
      promptFilePath = null,
      featureDir = null,
      step = null,
      taskCode = null,
      rawPrompt = false,
      promptFileName = null
    } = options;
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


    // Xử lý tạo tệp prompt hoàn chỉnh riêng để tránh lỗi giới hạn dòng lệnh Windows (ENAMETOOLONG / 32,767 ký tự)
    let effectivePrompt = prompt;
    let resolvedPromptPath = promptFilePath ? path.resolve(promptFilePath) : null;

    if (!rawPrompt) {
      const isAlreadyDispatch = typeof prompt === 'string' && prompt.includes('Đường dẫn tuyệt đối:');
      if (!isAlreadyDispatch) {
        if (resolvedPromptPath) {
          if (prompt && prompt.length > 0) {
            fs.mkdirSync(path.dirname(resolvedPromptPath), { recursive: true });
            fs.writeFileSync(resolvedPromptPath, prompt, 'utf8');
          }
          effectivePrompt = this.formatDispatchPrompt(resolvedPromptPath, { step, taskCode });
        } else if (featureDir) {
          const stepName = String(step || 'task').toLowerCase().replace(/[^a-z0-9_-]/g, '');
          const fileName = promptFileName || `prompt_${stepName}.md`;
          resolvedPromptPath = path.resolve(path.join(featureDir, fileName));
          fs.mkdirSync(path.dirname(resolvedPromptPath), { recursive: true });
          fs.writeFileSync(resolvedPromptPath, prompt, 'utf8');
          effectivePrompt = this.formatDispatchPrompt(resolvedPromptPath, { step, taskCode });
        } else if (typeof prompt === 'string' && prompt.length > 8000) {
          const os = require('node:os');
          const tempDir = path.join(os.tmpdir(), 'ai-worker-prompts');
          fs.mkdirSync(tempDir, { recursive: true });
          resolvedPromptPath = path.resolve(path.join(tempDir, `prompt_${jobId || 'job'}_${Date.now()}.md`));
          fs.writeFileSync(resolvedPromptPath, prompt, 'utf8');
          effectivePrompt = this.formatDispatchPrompt(resolvedPromptPath, { step, taskCode });
        }
      }
    }

    if (resolvedPromptPath && typeof onStdout === 'function') {
      let promptSize = 0;
      try {
        promptSize = fs.existsSync(resolvedPromptPath) ? fs.statSync(resolvedPromptPath).size : 0;
      } catch (e) {}
      const stepStr = step ? `bước ${step}` : 'nhiệm vụ';
      onStdout(`\x1b[90m[PROMPT-FILE] Đã chuẩn bị tệp prompt hoàn chỉnh cho ${stepStr}: ${resolvedPromptPath} (${promptSize} bytes)\x1b[0m\r\n`);
    }

    const effectiveArgs = this.buildArgs(effectivePrompt, options);
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
      fileOffsets: new Map(), // Lưu offset riêng theo từng file, không bao giờ reset về 0
      lineBuffers: new Map()  // Lưu buffer dòng dở dang riêng cho từng file
    };

    const tailTimer = setInterval(() => {
      // Nếu stdout im lặng quá 2s, tự động kích hoạt Session File Watcher cho runner tương ứng
      if (Date.now() - lastOutTime > 2000) {
        const sessionDir = this.getSessionDir(cwd);

        if (sessionDir && fs.existsSync(sessionDir)) {
          try {
            // Quét cả session chính lẫn mọi subagent active (kể cả subagent trong các thư mục con)
            const activeFiles = typeof this.findActiveSessionFiles === 'function'
              ? this.findActiveSessionFiles(sessionDir, executeStartTime - 60000)
              : [];

            // Nếu không quét được mảng, fallback về file session chính
            if (activeFiles.length === 0) {
              const single = this.findLatestSessionFile(sessionDir);
              if (single) activeFiles.push({ path: single, isSubagent: false, agentLabel: '' });
            }

            for (const fileInfo of activeFiles) {
              const targetFile = fileInfo.path;
              if (!fs.existsSync(targetFile)) continue;
              const stat = fs.statSync(targetFile);

              // Quản lý offset riêng cho từng file để tránh replay lịch sử cũ khi đổi file
              if (!tailState.fileOffsets.has(targetFile)) {
                // Lần đầu gặp file: nếu file đã tồn tại trước khi execute chạy, bỏ qua phần cũ
                const initOffset = (stat.mtimeMs < executeStartTime) ? stat.size : 0;
                tailState.fileOffsets.set(targetFile, initOffset);
                tailState.lineBuffers.set(targetFile, '');
              }

              const currentOffset = tailState.fileOffsets.get(targetFile) || 0;
              if (stat.size > currentOffset) {
                const readLength = stat.size - currentOffset;
                const fd = fs.openSync(targetFile, 'r');
                const buffer = Buffer.alloc(readLength);
                fs.readSync(fd, buffer, 0, readLength, currentOffset);
                fs.closeSync(fd);
                tailState.fileOffsets.set(targetFile, stat.size);
                const prevBuffer = tailState.lineBuffers.get(targetFile) || '';
                const chunkText = prevBuffer + buffer.toString('utf-8');
                const lines = chunkText.split(/\r?\n/);
                // Giữ lại phần dư chưa hoàn thành dòng cuối cùng vào lineBuffers
                tailState.lineBuffers.set(targetFile, lines.pop() || '');

                const prefix = fileInfo.isSubagent
                  ? `\x1b[38;5;208m[SUBAGENT:${fileInfo.agentLabel || 'agent'}]\x1b[0m `
                  : '';

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
                        onStdout(`${prefix}\x1b[36m[AGENT THOUGHT]\x1b[0m ${firstLine.substring(0, 140)}...\n`);
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
                          onStdout(`${prefix}\x1b[35m[TOOL CALL]\x1b[0m ${toolName} (${argsPreview})\n`);
                        }
                      }
                    }

                    // B. ACTION
                    const actionName = obj.action || obj.title || (obj.message && obj.message.action);
                    if (actionName && typeof onStdout === 'function') {
                      onStdout(`${prefix}\x1b[33m[AGENT ACTION]\x1b[0m ${String(actionName).substring(0, 140)}\n`);
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
                      onStdout(`${prefix}\x1b[35m[TOOL CALL]\x1b[0m ${toolName} (${toolInput})\n`);
                    }
                  } catch (e) {
                    // 2. Phân tích raw text dòng log nếu không phải JSON
                    if (typeof onStdout === 'function' && trimmed.length > 5) {
                      if (/thinking|thought|reasoning/i.test(trimmed)) {
                        onStdout(`${prefix}\x1b[36m[AGENT THOUGHT]\x1b[0m ${trimmed.substring(0, 140)}\n`);
                      } else if (/executing|action|running/i.test(trimmed)) {
                        onStdout(`${prefix}\x1b[33m[AGENT ACTION]\x1b[0m ${trimmed.substring(0, 140)}\n`);
                      } else if (/tool|call|function/i.test(trimmed)) {
                        onStdout(`${prefix}\x1b[35m[TOOL CALL]\x1b[0m ${trimmed.substring(0, 140)}\n`);
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
