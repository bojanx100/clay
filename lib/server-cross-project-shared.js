// Shared identity predicates for the cross-project router family.
//
// These invariants are used by the startup, owner-admission, execution
// lifecycle, and completion seams. They live in one module because the
// alternative already failed: `sameSessionRef` was declared twice inside the
// router closure, and function-declaration hoisting silently promoted the
// weaker copy over the validated one for the entire file.

var projectIdentity = require("./project-identity");

// TRUE only when both operands are legal, identical SessionRefs.
//
// Validation is part of the predicate, not a caller responsibility. A raw
// field comparison reports a match between two refs that could never name a
// real session -- two malformed ids that happen to share bytes -- which is
// exactly the authority confusion the typed identity layer exists to prevent.
function sameSessionRef(left, right) {
  var a = projectIdentity.normalizeSessionRef(left);
  var b = projectIdentity.normalizeSessionRef(right);
  return !!(a && b && a.projectId === b.projectId &&
    a.sessionStorageId === b.sessionStorageId);
}

module.exports = { sameSessionRef: sameSessionRef };
