var test = require("node:test");
var assert = require("node:assert");

var {
  PREVIEW_MARKER,
  hasReviewChangeSignal,
  extractReviewChangeComments,
} = require("../lib/project-pr-review-comments");
var { QA_MARKER } = require("../lib/project-pr-qa-verdict");

test("hasReviewChangeSignal detects structured requesting-changes headings", function () {
  assert.strictEqual(hasReviewChangeSignal("### Requesting changes\nNeeds work"), true);
  assert.strictEqual(hasReviewChangeSignal("### 🔴 Requesting changes\nNeeds work"), true);
  assert.strictEqual(hasReviewChangeSignal("Changes requested\nNeeds work"), true);
  assert.strictEqual(hasReviewChangeSignal("> Requested changes\nNeeds work"), true);
});

test("hasReviewChangeSignal ignores non-actionable conversation", function () {
  assert.strictEqual(hasReviewChangeSignal("Looks good after these changes"), false);
  assert.strictEqual(hasReviewChangeSignal("No changes requested from me."), false);
  assert.strictEqual(hasReviewChangeSignal("Preview Environment Ready"), false);
});

test("extractReviewChangeComments returns external top-level review-change comments", function () {
  var comments = [
    {
      user: { login: "github-actions[bot]" },
      body: PREVIEW_MARKER + "\nPreview ready",
      created_at: "2026-07-16T08:10:00Z",
    },
    {
      user: { login: "bojantv" },
      body: "### Requesting changes\nMy own note should not launch.",
      created_at: "2026-07-16T08:20:00Z",
    },
    {
      user: { login: "fbrooks" },
      body: "### 🔴 Requesting changes\nI ran a review and found a webapp regression.",
      created_at: "2026-07-16T08:33:36Z",
    },
    {
      user: { login: "qa-bot" },
      body: QA_MARKER + "\nQA Verdict: FAIL",
      created_at: "2026-07-16T08:40:00Z",
    },
  ];

  var result = extractReviewChangeComments(comments, "bojantv");
  assert.strictEqual(result.sections.length, 1);
  assert.ok(result.sections[0].indexOf("@fbrooks") !== -1);
  assert.ok(result.sections[0].indexOf("webapp regression") !== -1);
  assert.strictEqual(result.latestTs, Date.parse("2026-07-16T08:33:36Z"));
});
