const BaseAdapter = require('./baseAdapter');

class OpenCodeAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('opencode', 'opencode', {
      aliases: [],
      ...options
    });
  }

  /**
   * Xây dựng args cho opencode CLI
   * Format: opencode run "<prompt>" --auto-approve --no-interaction
   * MCP: `opencode run --help` không có flag/env MCP handshake/tool-search nào nên không ép flag bịa.
   * Muốn dùng MCP thì cấu hình trong opencode.json, không qua buildArgs.
   * @param {string} prompt
   * @param {object} options
   * @returns {string[]}
   */
  buildArgs(prompt, options = {}) {
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    return ['run', prompt, '--auto-approve', '--no-interaction', ...extraArgs];
  }
}

module.exports = OpenCodeAdapter;
