const BaseAdapter = require('./baseAdapter');

class ClaudeCodeAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('claude-code', 'claude', {
      aliases: ['claude'],
      ...options
    });
  }

  /**
   * Xây dựng args cho claude CLI
   * Format: claude -p "<prompt>" --dangerously-skip-permissions
   * MCP (xác minh qua `claude --help`): --mcp-config (dòng 132), --strict-mcp-config (dòng 229).
   * Chỉ thêm khi caller opt-in qua options.mcpConfig/options.strictMcpConfig để giữ mặc định cũ.
   * Timeout/handshake + tool-search truyền qua env mergedEnv (MCP_TIMEOUT/MCP_HANDSHAKE_TIMEOUT(_MS), ENABLE_TOOL_SEARCH).
   * @param {string} prompt
   * @param {object} options
   * @returns {string[]}
   */
  buildArgs(prompt, options = {}) {
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    const args = ['-p', prompt, '--dangerously-skip-permissions'];
    const mcpConfigs = Array.isArray(options.mcpConfig) ? options.mcpConfig : (typeof options.mcpConfig === 'string' && options.mcpConfig ? [options.mcpConfig] : []);
    for (const cfg of mcpConfigs) {
      args.push('--mcp-config', cfg);
    }
    if (options.strictMcpConfig === true) {
      args.push('--strict-mcp-config');
    }
    return [...args, ...extraArgs];
  }
}

module.exports = ClaudeCodeAdapter;
