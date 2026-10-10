const BaseAdapter = require('./baseAdapter');

class AntigravityCliAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('antigravity-cli', 'antigravity', {
      aliases: ['antigravity'],
      ...options
    });
  }

  /**
   * Xây dựng args cho antigravity CLI
   * Format: antigravity run --headless --task "<prompt>"
   * @param {string} prompt
   * @param {object} options
   * @returns {string[]}
   */
  buildArgs(prompt, options = {}) {
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    return ['run', '--headless', '--task', prompt, ...extraArgs];
  }
}

module.exports = AntigravityCliAdapter;
