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
   * MCP: `omp --help` khong co flag --mcp-.../--tool-search nao nen khong them flag.
   * Timeout/handshake + tool-search truyền qua env mergedEnv (MCP_TIMEOUT/MCP_HANDSHAKE_TIMEOUT(_MS), OMP_MCP_TIMEOUT_MS tương thích, ENABLE_TOOL_SEARCH).
   * @param {string} prompt
   * @param {object} options
   * @returns {string[]}
   */
  buildArgs(prompt, options = {}) {
    const extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    const args = ['-p', prompt, '--auto-approve'];
    if (options.advisor === true) {
      args.push('--advisor');
    }
    return [...args, ...extraArgs];
  }
}

module.exports = OmpAdapter;
