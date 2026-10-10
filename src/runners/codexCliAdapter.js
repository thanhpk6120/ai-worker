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
