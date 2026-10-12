const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Trích xuất cấu hình Jira từ ~/.claude.json hoặc ~/.omp/agent/mcp.json
 */
function getJiraConfig() {
  const home = os.homedir();
  const claudeCfg = path.join(home, '.claude.json');
  if (fs.existsSync(claudeCfg)) {
    try {
      const c = JSON.parse(fs.readFileSync(claudeCfg, 'utf8'));
      const s = c.mcpServers && (c.mcpServers['company-atlassian'] || c.mcpServers.atlassian);
      if (s && s.env && s.env.JIRA_PERSONAL_TOKEN) {
        return {
          baseUrl: s.env.JIRA_URL || 'https://jira.cybertech.vn',
          token: s.env.JIRA_PERSONAL_TOKEN
        };
      }
    } catch (e) {}
  }
  const ompCfg = path.join(home, '.omp', 'agent', 'mcp.json');
  if (fs.existsSync(ompCfg)) {
    try {
      const c = JSON.parse(fs.readFileSync(ompCfg, 'utf8'));
      const s = c.mcpServers && (c.mcpServers['company-atlassian'] || c.mcpServers.atlassian);
      if (s && s.env && s.env.JIRA_PERSONAL_TOKEN) {
        return {
          baseUrl: s.env.JIRA_URL || 'https://jira.cybertech.vn',
          token: s.env.JIRA_PERSONAL_TOKEN
        };
      }
    } catch (e) {}
  }
  return null;
}

/**
 * Tự động tìm issue key (VD RSGATE-50) trong văn bản
 */
function extractIssueKey(text) {
  if (!text) return null;
  const urlMatch = text.match(/https?:\/\/[^\s"',]+\/browse\/([A-Z0-9]+-\d+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  const bareMatch = text.match(/\b([A-Z]{2,10}-\d+)\b/);
  if (bareMatch) return bareMatch[1].toUpperCase();
  return null;
}

/**
 * Gọi REST API v2 lấy chi tiết ticket Jira
 */
async function fetchJiraIssue(issueKey) {
  const cfg = getJiraConfig();
  if (!cfg || !cfg.token || !issueKey) return null;

  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/rest/api/2/issue/${encodeURIComponent(issueKey)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const fields = data.fields || {};
    return {
      key: data.key,
      summary: fields.summary || '',
      description: fields.description || '',
      status: fields.status ? fields.status.name : '',
      issuetype: fields.issuetype ? fields.issuetype.name : '',
      priority: fields.priority ? fields.priority.name : '',
      assignee: fields.assignee ? fields.assignee.displayName : '',
      raw: data
    };
  } catch (err) {
    return null;
  }
}

/**
 * Định dạng issue thành khối Markdown bổ sung ngữ cảnh cho prompt của Agent
 */
function formatIssueAsMarkdown(issue) {
  if (!issue) return '';
  return `
## 📋 NỘI DUNG TICKET JIRA ĐÃ ĐƯỢC GIẢI MÃ TỰ ĐỘNG (${issue.key}):
- **Key:** \`${issue.key}\`
- **Tiêu đề (Summary):** ${issue.summary}
- **Loại:** ${issue.issuetype} | **Mức độ:** ${issue.priority} | **Trạng thái:** ${issue.status}
- **Mô tả chi tiết (Description):**
\`\`\`markdown
${issue.description || '(Không có mô tả chi tiết)'}
\`\`\`
*(Agent KHÔNG CẦN mở trình duyệt hay truy cập URL Jira nữa, hãy sử dụng trực tiếp nội dung mô tả trên để phân tích và lập kế hoạch)*
`;
}

module.exports = {
  getJiraConfig,
  extractIssueKey,
  fetchJiraIssue,
  formatIssueAsMarkdown
};
