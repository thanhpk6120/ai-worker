const BaseAdapter = require('./baseAdapter');

class OmpAdapter extends BaseAdapter {
  constructor(options = {}) {
    super('omp', 'omp', {
      aliases: [],
      ...options
    });
  }

  /**
   * Xây dựng args cho omp CLI
   * Format: omp run "<prompt>" --mode headless --yes
   * @param {string} prompt
   * @param {object} options
   * @returns {string[]}
   */
  buildArgs(prompt, options = {}) {
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    return ['-p', prompt, '--auto-approve', ...extraArgs];
  }
}

module.exports = OmpAdapter;
