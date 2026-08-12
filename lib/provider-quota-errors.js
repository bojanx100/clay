function isCopilotQuotaError(text) {
  var str = String(text || "").trim();
  if (!str || str.length > 200) return false;
  return /^Error: You have exceeded your monthly quota \(Request ID: [A-Za-z0-9:-]+\)$/.test(str);
}

module.exports = {
  isCopilotQuotaError: isCopilotQuotaError,
};
