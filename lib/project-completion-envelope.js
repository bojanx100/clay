// Reads a project coordinator's PROJECT_COMPLETED envelope out of its written
// turn.
//
// Why this exists: the envelope is authored by a language model in a normal
// chat turn, so it arrives formatted. Live coordinators emitted
//
//   **PROJECT_COMPLETED**
//   **SUMMARY:** ...
//   **ESCALATION_REQUIRED: no**
//
// while the raw field reader matched only bare `NAME: value` at line start.
// Every such envelope was therefore read as "no completion requested" and
// dropped with no trace, leaving the portfolio execution binding projecting
// active/running for days after the work had finished.
//
// Normalizing emphasis is a *presentation* concern only. It deliberately does
// not relax the completion contract: the marker still has to be the entire
// content of its own line, so the many "I am not emitting PROJECT_COMPLETED"
// sentences these coordinators also write can never be mistaken for an
// envelope.
// Decoration is stripped only at the line edges and around a field label,
// never from inside a value. Blanket emphasis stripping would corrupt real
// evidence: `VERIFICATION: node --test "test/*.test.js"` must survive intact,
// and `_` is a character of the label names themselves (PROJECT_COMPLETED).
var LINE_PREFIX = /^[\s>]*(?:#{1,6}\s*)?(?:[-*+]\s+)?/;
var LEADING_EMPHASIS = /^(?:\*\*|__|`|\*|_)+/;
var TRAILING_EMPHASIS = /(?:\*\*|__|`|\*|_)+\s*$/;
var LABELLED_FIELD = /^([A-Z][A-Z0-9_]{1,39})(?:\*\*|__|`|\*|_)*\s*:\s*(?:\*\*|__|`|\*|_)*\s*/;

// Rewrites each line into the plain `LABEL: value` shape the field readers
// expect, so a coordinator that formatted its envelope still lands.
function normalizeEnvelopeText(text) {
  var lines = String(text || "").split("\n");
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(LINE_PREFIX, "").replace(LEADING_EMPHASIS, "")
      .replace(TRAILING_EMPHASIS, "").replace(LABELLED_FIELD, "$1: ");
    out.push(line.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

// True only when some line, once stripped of decoration, is exactly the
// completion marker: `PROJECT_COMPLETED` or `PROJECT_COMPLETED: yes`.
function envelopeRequested(text) {
  var lines = normalizeEnvelopeText(text).split("\n");
  for (var i = 0; i < lines.length; i++) {
    if (/^PROJECT_COMPLETED\s*(?::\s*yes\s*\.?)?$/i.test(lines[i].trim())) return true;
  }
  return false;
}

// The ordered contract fields a coordinator must supply. Missing entries are
// named back to the coordinator instead of being silently discarded.
function missingEnvelopeFields(report) {
  var missing = [];
  if (!report.summary) missing.push("SUMMARY");
  if (!report.verification) missing.push("VERIFICATION");
  if (!report.integrationVerification || !report.integrationVerified) {
    missing.push("INTEGRATION_VERIFIED: yes");
  }
  if (!report.escalationVerified) missing.push("ESCALATION_REQUIRED: no");
  return missing;
}

function refusalPrompt(reason, missing) {
  var lines = [
    "[Clay coordinator completion gate]",
    "Your PROJECT_COMPLETED envelope was received but refused: " + reason + ".",
  ];
  if (missing.length) {
    lines.push("", "Missing or unverified envelope fields:");
    for (var i = 0; i < missing.length; i++) lines.push("- " + missing[i]);
  }
  lines.push(
    "",
    "The portfolio execution binding is still open and will keep reading as in-flight",
    "work until a conforming envelope lands. Re-emit the complete envelope on plain",
    "lines once the missing evidence is real:",
    "PROJECT_COMPLETED: yes",
    "SUMMARY: integrated outcome",
    "VERIFICATION: project acceptance evidence",
    "INTEGRATION_VERIFIED: yes",
    "ESCALATION_REQUIRED: no",
    "Do not invent evidence. If the missing field cannot honestly be satisfied,",
    "report WORKER_STATUS: needs_input with the precise blocker instead."
  );
  return lines.join("\n");
}

module.exports = {
  envelopeRequested: envelopeRequested,
  missingEnvelopeFields: missingEnvelopeFields,
  normalizeEnvelopeText: normalizeEnvelopeText,
  refusalPrompt: refusalPrompt,
};
