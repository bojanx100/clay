function isCopilotQuotaError(text) {
  var str = String(text || "").trim();
  if (!str || str.length > 200) return false;
  return /^Error: You have exceeded your monthly quota \(Request ID: [A-Za-z0-9:-]+\)$/.test(str);
}

function isProviderQuotaError(text) {
  var str = String(text || "").trim();
  if (!str || str.length > 800) return false;
  return /\b(?:quota|rate[ _-]?limit|usage[ _-]?limit|credit(?:s)?|allowance)\b.{0,80}\b(?:exceeded|exhausted|depleted|reached|insufficient|unavailable)\b/i.test(str) ||
    /\b(?:exceeded|exhausted|depleted|reached|insufficient)\b.{0,80}\b(?:quota|rate[ _-]?limit|usage[ _-]?limit|credit(?:s)?|allowance)\b/i.test(str) ||
    /\btoo many requests\b/i.test(str) || /\bresource[_ -]?exhausted\b/i.test(str) ||
    /\b(?:http|status|error|code)[ :=#-]*429\b/i.test(str) ||
    /\b429\s+(?:too many requests|rate[ _-]?limit)\b/i.test(str);
}

module.exports = {
  isCopilotQuotaError: isCopilotQuotaError,
  isProviderQuotaError: isProviderQuotaError,
};
