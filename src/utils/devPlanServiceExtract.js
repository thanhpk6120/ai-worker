'use strict';

/**
 * Trích xuất danh sách service mục tiêu từ dev_plan.md.
 * Dùng chung cho server.js và scripts/verify-worktrees.js để tránh drift.
 *
 * @param {string} devPlanText Nội dung dev_plan.md
 * @param {Array<{service_key:string}>} wsServices Danh sách service của workspace
 * @returns {string[]} Danh sách service_key mục tiêu (đã lọc theo availableKeys)
 */
function extractTargetServicesFromDevPlan(devPlanText, wsServices = []) {
  if (!devPlanText || typeof devPlanText !== 'string') return [];
  const foundServices = new Set();
  const availableKeys = wsServices.map(s => s.service_key).filter(Boolean);

  // 1. Regex tìm mục "Service mục tiêu" / "Phân hệ mục tiêu" / "Target Service"
  const targetRegexes = [
    /(?:Service\s*mục\s*tiêu|Phân\s*hệ\s*mục\s*tiêu|Module\s*mục\s*tiêu|Target\s*Service|Service\s*chính|Dịch\s*vụ\s*mục\s*tiêu)[^`\r\n]*[`'"]([a-zA-Z0-9_\-\.\/]+)[`'"]/gi,
    /(?:Service\s*mục\s*tiêu|Phân\s*hệ\s*mục\s*tiêu|Module\s*mục\s*tiêu|Target\s*Service|Service\s*chính|Dịch\s*vụ\s*mục\s*tiêu)\s*[:=]\s*[*_]*([a-zA-Z0-9_\-\.\/]+)/gi
  ];

  for (const reg of targetRegexes) {
    let match;
    while ((match = reg.exec(devPlanText)) !== null) {
      const candidate = match[1].trim();
      if (candidate) foundServices.add(candidate);
    }
  }

  // 2. Fallback: quét service_key xuất hiện trong dev_plan, bỏ qua dòng chỉ tham chiếu
  if (foundServices.size === 0 && availableKeys.length > 0) {
    const lines = devPlanText.split(/\r?\n/);
    const REF_RE = /tham\s*chiếu|reference|liên\s*quan|không\s*sửa|chỉ\s*đọc/i;
    for (const sKey of availableKeys) {
      if (sKey.toLowerCase() === 'docs') continue;
      const escapedKey = sKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const keyRegex = new RegExp(`(?:^|[^a-zA-Z0-9_-])${escapedKey}(?![a-zA-Z0-9_-])`, 'i');
      const isTarget = lines.some(line => keyRegex.test(line) && !REF_RE.test(line));
      if (isTarget) foundServices.add(sKey);
    }
  }

  let result = Array.from(foundServices);
  if (availableKeys.length > 0) {
    result = result.filter(s => availableKeys.includes(s));
  }
  return result;
}

module.exports = { extractTargetServicesFromDevPlan };
