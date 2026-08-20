"use strict";

// Pure commit-message rules shared by the `commit-msg` git hook
// (.githooks/commit-msg -> scripts/check-commit-message.js) and by the
// test-suite backstop (test/commit-message-guard.test.js). No I/O here on
// purpose: every rule is a pure function of the message text so both callers
// and the tests see identical behaviour.
//
// The two rules come straight from CLAUDE.md:
//   "Never add `Co-Authored-By` lines to git commit messages."
//   "Commit messages must follow Conventional Commits (`feat:`, `fix:`,
//    `docs:`, `chore:`, `refactor:`, `perf:`, `test:`, `style:`, `ci:`,
//    `build:`). Use `!` or `BREAKING CHANGE:` footer for breaking changes."

var COAUTHOR_RULE = "no-co-authored-by";
var CONVENTIONAL_RULE = "conventional-commits";
var EMPTY_RULE = "empty-message";

var COAUTHOR_QUOTE =
  "CLAUDE.md: \"Never add `Co-Authored-By` lines to git commit messages.\"";
var CONVENTIONAL_QUOTE =
  "CLAUDE.md: \"Commit messages must follow Conventional Commits (`feat:`, " +
  "`fix:`, `docs:`, `chore:`, `refactor:`, `perf:`, `test:`, `style:`, `ci:`, " +
  "`build:`). Use `!` or `BREAKING CHANGE:` footer for breaking changes.\"";

// The ten types CLAUDE.md mandates, plus `revert`. `revert` is deliberately
// accepted even though CLAUDE.md's list omits it: this repo's own history
// already uses `revert: ...` subjects, the Conventional Commits spec treats
// revert as a recognized type, and semantic-release understands it. Rejecting
// it would block an established, legitimate practice rather than enforce the
// rule's intent.
var CONVENTIONAL_TYPES = [
  "feat", "fix", "docs", "chore", "refactor", "perf", "test", "style", "ci",
  "build", "revert",
];

// <type>[(scope)][!]: <description>
// The scope may not be empty and may not contain parentheses; the colon must be
// followed by a space and a non-empty description, exactly as the spec requires.
var SUBJECT_PATTERN = new RegExp(
  "^(" + CONVENTIONAL_TYPES.join("|") + ")(\\([^()]+\\))?(!)?: \\S"
);

// Subjects git itself generates, or that mean "this is not a new logical
// change". Blocking any of these would break ordinary merge, revert and
// autosquash workflows, so they are exempt from the Conventional Commits check.
// They are still subject to the Co-Authored-By rule.
var EXEMPT_SUBJECT_PATTERNS = [
  /^Merge /,                    // git merge, git pull, GitHub "Merge pull request #n"
  /^Revert /,                   // git revert
  /^Reapply /,                  // git revert of a revert (git >= 2.44)
  /^(fixup|squash|amend)! /,    // git commit --fixup/--squash, rebase --autosquash
  /^Release \d/,                // release automation already in this repo's history
];

// `git commit --verbose` appends the staged diff after this scissors line. The
// diff routinely contains the literal text of the rules themselves (this file,
// CLAUDE.md), so everything past the scissors must be ignored or the guard
// would reject commits that merely edit the guard.
var SCISSORS_PATTERN = /^#\s*-+\s*>8\s*-+/;
var COMMENT_PATTERN = /^#/;

// Matched at the start of a line, case-insensitively. See
// `validateCommitMessage` for why position inside the message does not matter
// and why anchoring at line start is what keeps prose about the rule legal.
var COAUTHOR_PATTERN = /^co-authored-by:/i;

function normalizeText(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

// Returns the lines git will actually keep, each tagged with its 1-based number
// in the original message so an error can name the offending line as the author
// sees it.
//
// `stripComments` is true for the hook (git has not cleaned the message yet)
// and false for history scanning (git cleaned it when the commit was made, so a
// body line starting with `#` is real content).
function contentLines(text, stripComments) {
  var raw = normalizeText(text).split("\n");
  var lines = [];
  for (var i = 0; i < raw.length; i++) {
    if (stripComments) {
      if (SCISSORS_PATTERN.test(raw[i])) break;
      if (COMMENT_PATTERN.test(raw[i])) continue;
    }
    lines.push({ number: i + 1, text: raw[i] });
  }
  return lines;
}

function subjectLine(lines) {
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].text.trim() !== "") return lines[i];
  }
  return null;
}

function isExemptSubject(subject) {
  for (var i = 0; i < EXEMPT_SUBJECT_PATTERNS.length; i++) {
    if (EXEMPT_SUBJECT_PATTERNS[i].test(subject)) return true;
  }
  return false;
}

function isConventionalSubject(subject) {
  return SUBJECT_PATTERN.test(subject);
}

// A Co-Authored-By line is rejected wherever it appears, not only in the last
// paragraph that `git interpret-trailers` would call the trailer block.
// Rationale: the rule's intent is that the attribution never reaches the log,
// and GitHub parses co-author lines more loosely than git's own trailer
// grammar, so a mid-body line still produces a co-authored commit. Anchoring at
// the start of a trimmed line is what keeps legitimate prose about the rule
// legal -- "- Never add `Co-Authored-By` lines" and "> Co-authored-by: ..." do
// not match, because neither line begins with the trailer itself.
function coauthorLines(lines) {
  var hits = [];
  for (var i = 0; i < lines.length; i++) {
    if (COAUTHOR_PATTERN.test(lines[i].text.trim())) hits.push(lines[i]);
  }
  return hits;
}

function validateCommitMessage(text, options) {
  var stripComments = !(options && options.stripComments === false);
  var lines = contentLines(text, stripComments);
  var subject = subjectLine(lines);
  var errors = [];

  if (!subject) {
    errors.push({
      rule: EMPTY_RULE,
      line: 1,
      text: "",
      message: "The commit message is empty.",
      detail: [
        "Write a Conventional Commits subject, for example:",
        "  fix: stop the retry loop from double-counting failures",
      ],
    });
    return { ok: false, errors: errors, subject: "", exempt: false };
  }

  var exempt = isExemptSubject(subject.text);
  if (!exempt && !isConventionalSubject(subject.text)) {
    errors.push({
      rule: CONVENTIONAL_RULE,
      line: subject.number,
      text: subject.text,
      message: "The subject does not follow Conventional Commits.",
      detail: [
        CONVENTIONAL_QUOTE,
        "Expected: <type>[(scope)][!]: <description>",
        "Types:    " + CONVENTIONAL_TYPES.join(", "),
        "Examples: fix: stop the retry loop from double-counting failures",
        "          feat(scripts): add a WAL-safe control-store snapshot",
        "          feat!: drop the legacy relay route",
        "Merge, Revert, Reapply and fixup!/squash! subjects are exempt.",
      ],
    });
  }

  var hits = coauthorLines(lines);
  for (var i = 0; i < hits.length; i++) {
    errors.push({
      rule: COAUTHOR_RULE,
      line: hits[i].number,
      text: hits[i].text,
      message: "A Co-Authored-By line is forbidden in this repo.",
      detail: [
        COAUTHOR_QUOTE,
        "Fix: delete that line from the commit message and commit again.",
      ],
    });
  }

  errors.sort(function (a, b) { return a.line - b.line; });
  return {
    ok: errors.length === 0,
    errors: errors,
    subject: subject.text,
    exempt: exempt,
  };
}

// Human-readable report for a failed validation. Kept here so the hook and the
// test backstop print the same thing.
function formatErrors(result, heading) {
  var out = [];
  var count = result.errors.length;
  out.push(heading + " -- " + count + " problem" + (count === 1 ? "" : "s") +
    " found:");
  for (var i = 0; i < count; i++) {
    var error = result.errors[i];
    out.push("");
    out.push("  " + (i + 1) + ". " + error.message + "  [line " + error.line +
      ", rule: " + error.rule + "]");
    if (error.text !== "") out.push("       > " + error.text);
    for (var j = 0; j < error.detail.length; j++) {
      out.push("     " + error.detail[j]);
    }
  }
  return out.join("\n");
}

module.exports = {
  CONVENTIONAL_TYPES: CONVENTIONAL_TYPES,
  COAUTHOR_RULE: COAUTHOR_RULE,
  CONVENTIONAL_RULE: CONVENTIONAL_RULE,
  EMPTY_RULE: EMPTY_RULE,
  contentLines: contentLines,
  isExemptSubject: isExemptSubject,
  isConventionalSubject: isConventionalSubject,
  validateCommitMessage: validateCommitMessage,
  formatErrors: formatErrors,
};
