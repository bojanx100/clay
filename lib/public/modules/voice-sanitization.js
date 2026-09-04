// Voice output is a separate trust boundary from the visible transcript.
// Executor output can contain logs, tokens, or pasted credentials that are
// useful on screen but must never be read aloud.

var SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)_[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}\b/gi,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripCode(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "");
}

export function sanitizeVoiceText(value, limit) {
  var text = stripCode(value);
  for (var i = 0; i < SECRET_PATTERNS.length; i++) {
    text = text.replace(SECRET_PATTERNS[i], "[redacted]");
  }
  text = normalizeWhitespace(text);
  var max = Number.isInteger(limit) && limit > 0 ? limit : 640;
  if (text.length > max) text = text.slice(0, max - 1).trim() + "…";
  return text;
}
