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
   * @param {string} prompt
   * @param {object} options
   * @returns {string[]}
   */
  buildArgs(prompt, options = {}) {
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    return ['-p', prompt, '--dangerously-skip-permissions', '--verbose', ...extraArgs];
  }
}

module.exports = ClaudeCodeAdapter;
