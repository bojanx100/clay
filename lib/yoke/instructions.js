// YOKE Instruction Scanner
// ------------------------
// Scans a project directory for vendor-specific instruction files
// (CLAUDE.md, AGENTS.md, .cursorrules, etc.) and merges them into
// a single string that any adapter can inject as context.
//
// Each adapter declares which files its vendor reads natively so
// those are excluded from the merged output (no double-injection).

var fs = require("fs");
var path = require("path");

// Known instruction files in priority order.
// { file: relative path, label: human-readable label }
var KNOWN_FILES = [
  { file: "CLAUDE.md", label: "CLAUDE.md" },
  { file: "AGENTS.md", label: "AGENTS.md" },
  { file: ".cursorrules", label: ".cursorrules" },
  { file: ".github/copilot-instructions.md", label: ".github/copilot-instructions.md" },
  { file: "COPILOT.md", label: "COPILOT.md" },
];

// Files each vendor reads natively (skip these to avoid duplication).
var NATIVE_FILES = {
  claude: ["CLAUDE.md"],
  codex: ["AGENTS.md"],
};

// Scan projectDir for instruction files and return merged text.
// Excludes files the given vendor already reads natively.
//
// Returns "" if no files found (callers can skip injection).
function scanAndMerge(projectDir, vendor) {
  if (!projectDir) return "";

  var exclude = NATIVE_FILES[vendor] || [];
  var sections = [];

  for (var i = 0; i < KNOWN_FILES.length; i++) {
    var entry = KNOWN_FILES[i];
    if (exclude.indexOf(entry.file) !== -1) continue;

    var filePath = path.join(projectDir, entry.file);
    try {
      var content = fs.readFileSync(filePath, "utf8").trim();
      if (content) {
        sections.push("--- Instructions from " + entry.label + " ---\n" + content);
      }
    } catch (e) {
      // File doesn't exist or unreadable, skip.
    }
  }

  return sections.join("\n\n");
}

// Marker the Codex adapter appends after the injected instructions block when
// prepending it to a conversation's first message. Codex rollouts record that
// composed string as the user message, so without a deterministic boundary the
// rollout importer (cli-sessions.js) cannot separate Clay-injected context from
// what the user actually said — and "--- Instructions from CLAUDE.md ---"
// leaked into visible chat bubbles.
var INSTRUCTIONS_END_MARKER = "--- End of injected project instructions ---";

// Strip a leading injected-instructions block from a rollout-recorded user
// message. Returns the user's actual text, or the input unchanged when no
// injected block is detected.
function stripInjectedInstructions(text, projectDir, vendor) {
  if (typeof text !== "string" || text.indexOf("--- Instructions from ") !== 0) return text;
  // New format: explicit end marker.
  var mi = text.indexOf("\n" + INSTRUCTIONS_END_MARKER);
  if (mi !== -1) {
    return text.slice(mi + 1 + INSTRUCTIONS_END_MARKER.length).replace(/^\n+/, "");
  }
  // Legacy format (no marker): the injected block was exactly scanAndMerge()'s
  // output followed by a blank line. Only strips when the instruction files
  // haven't changed since the rollout was written; otherwise leave as-is.
  if (projectDir) {
    var merged = scanAndMerge(projectDir, vendor || "codex");
    if (merged && text.indexOf(merged + "\n\n") === 0) {
      return text.slice(merged.length + 2);
    }
  }
  return text;
}

module.exports = {
  scanAndMerge: scanAndMerge,
  stripInjectedInstructions: stripInjectedInstructions,
  INSTRUCTIONS_END_MARKER: INSTRUCTIONS_END_MARKER,
  KNOWN_FILES: KNOWN_FILES,
  NATIVE_FILES: NATIVE_FILES,
};
