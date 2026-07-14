function normalizeInformationalContent(content) {
  return String(content || "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\[(?:0|1|2|22|39|49)(?:;[0-9]+)*m\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isModelSwitchInformational(content) {
  var text = normalizeInformationalContent(content);
  return /^Set model to\s+.+$/i.test(text);
}

module.exports = {
  isModelSwitchInformational: isModelSwitchInformational,
  normalizeInformationalContent: normalizeInformationalContent,
};
