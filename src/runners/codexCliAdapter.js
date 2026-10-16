const BaseAdapter = require('./baseAdapter');

class CodexCliAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('codex-cli', 'codex', {
      aliases: ['codex'],
      ...options
    });
  }

  /**
   * Xây dựng args cho codex CLI
   * Format: codex exec "<prompt>" --non-interactive
   * MCP: `codex exec --help` khong co flag --mcp-.../--tool-search/handshake nao nen khong ep flag bia.
   * Muốn chỉnh MCP/timeout thì dùng -c key=value (config.toml) do caller truyền explicit, không tự thêm.
   * @param {string} prompt
   * @param {object} options
   * @returns {string[]}
   */
  buildArgs(prompt, options = {}) {
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    return ['exec', prompt, '--non-interactive', ...extraArgs];
  }
}

module.exports = CodexCliAdapter;
