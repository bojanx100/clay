// project-pr-review-comments.js - Identify top-level PR comments that should
// behave like review feedback for auto-launch.
//
// GitHub "request changes" style feedback is not always submitted as a formal
// pull request review. Some reviewers paste a structured review into the PR
// conversation as an issue comment, so the PR review source needs a narrow
// signal for those comments without treating every conversation reply as work.

var prQaVerdict = require("./project-pr-qa-verdict");

var PREVIEW_MARKER = "<!-- preview-url-comment -->";

function defaultToMs(iso) {
  var t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function cleanSignalLine(line) {
  var text = String(line || "").trim().toLowerCase();
  text = text.replace(/^[#>\s*_-]+/, "");
  text = text.replace(/^[^a-z0-9]+/, "");
  return text.trim();
}

function hasReviewChangeSignal(body) {
  var lines = String(body || "").split(/\r?\n/);
  var limit = Math.min(lines.length, 12);
  for (var i = 0; i < limit; i++) {
    var line = cleanSignalLine(lines[i]);
    if (!line) continue;
    if (line.indexOf("requesting changes") === 0) return true;
    if (line.indexOf("changes requested") === 0) return true;
    if (line.indexOf("requested changes") === 0) return true;
    if (line.indexOf("request changes") === 0) return true;
  }
  return false;
}

function commentAuthor(comment) {
  return comment && comment.user && comment.user.login ? comment.user.login : "";
}

function extractReviewChangeComments(comments, currentLogin, toMs) {
  if (!Array.isArray(comments)) return { sections: [], latestTs: 0 };
  var ms = toMs || defaultToMs;
  var sections = [];
  var latestTs = 0;
  for (var i = 0; i < comments.length; i++) {
    var comment = comments[i];
    if (!comment || !comment.body) continue;
    var body = String(comment.body || "");
    if (body.indexOf(prQaVerdict.QA_MARKER) !== -1) continue;
    if (body.indexOf(PREVIEW_MARKER) !== -1) continue;
    var login = commentAuthor(comment);
    if (login && currentLogin && login === currentLogin) continue;
    if (!hasReviewChangeSignal(body)) continue;
    var ts = ms(comment.created_at);
    if (ts > latestTs) latestTs = ts;
    sections.push("### Review-change comment by @" + (login || "reviewer") + "\n" + body.trim());
  }
  return { sections: sections, latestTs: latestTs };
}

module.exports = {
  PREVIEW_MARKER: PREVIEW_MARKER,
  hasReviewChangeSignal: hasReviewChangeSignal,
  extractReviewChangeComments: extractReviewChangeComments,
};
