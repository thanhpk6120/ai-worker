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
