// Stable identities shared by candidate admission, canonical automation
// Threads, and the cross-project binding boundary.

var crypto = require("crypto");

var UNSAFE = /[^A-Za-z0-9._:-]+/g;

function sanitizeSegment(value) {
  return String(value || "").replace(UNSAFE, "-").replace(/^-+/, "");
}

function identityDigest(projectId, itemKey) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([String(projectId || ""), String(itemKey || "")]))
    .digest("hex").slice(0, 24);
}

function portfolioTaskIdFor(candidate) {
  var projectId = candidate && candidate.projectRef ? candidate.projectRef.projectId : "";
  var itemKey = candidate && candidate.itemKey;
  var digest = identityDigest(projectId, itemKey);
  var label = sanitizeSegment(itemKey).slice(0, 120);
  return ("auto:" + digest + ":" + label).slice(0, 200);
}

function idempotencyKeyFor(portfolioTaskId, bindingRevision) {
  return sanitizeSegment("admit-" + portfolioTaskId + "-r" + bindingRevision).slice(0, 200);
}

function threadRefFor(candidate) {
  var projectId = candidate && candidate.projectRef ? candidate.projectRef.projectId : "";
  var itemKey = candidate && candidate.itemKey;
  if (!projectId || !itemKey) return null;
  return { threadId: "automation-" + identityDigest(projectId, itemKey) };
}

module.exports = {
  identityDigest: identityDigest,
  idempotencyKeyFor: idempotencyKeyFor,
  portfolioTaskIdFor: portfolioTaskIdFor,
  sanitizeSegment: sanitizeSegment,
  threadRefFor: threadRefFor,
};
