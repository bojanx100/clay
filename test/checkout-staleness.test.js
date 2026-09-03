var test = require("node:test");
var assert = require("node:assert/strict");
var staleness = require("../lib/checkout-staleness").staleness;
var stalenessMessage = require("../lib/checkout-staleness").stalenessMessage;
var followedRefFromReflog = require("../lib/checkout-staleness").followedRefFromReflog;

// A packaged install updates through npx. A git checkout does not: restarting
// re-execs lib/daemon.js from the same working tree, so a restart after a merge
// re-runs the OLD commit and the merged work sits inert with nothing saying so.

test("a checkout behind its tracking branch is reported as stale", function () {
  var verdict = staleness({
    isGitCheckout: true, upstream: "origin/bojan", behind: 8, head: "777f06388f",
  });
  assert.equal(verdict.stale, true);
  assert.equal(verdict.reason, "behind_tracking_branch");
  assert.equal(verdict.behind, 8);
  assert.equal(verdict.upstream, "origin/bojan");
});

test("a checkout level with its tracking branch is not stale", function () {
  var verdict = staleness({ isGitCheckout: true, upstream: "origin/bojan", behind: 0 });
  assert.equal(verdict.stale, false);
  assert.equal(verdict.reason, "up_to_date");
});

// This runs on every restart, so guessing towards stale would cry wolf on
// packaged installs and repos with no comparable remote ref. (A detached
// checkout IS judged -- see the reflog cases below.) Unknown must stay quiet.
test("states that cannot prove staleness stay quiet rather than warn", function () {
  assert.deepEqual(staleness({ isGitCheckout: false }),
    { stale: false, reason: "not_a_git_checkout" });
  assert.deepEqual(staleness(null),
    { stale: false, reason: "not_a_git_checkout" });
  assert.equal(staleness({ isGitCheckout: true, upstream: "" }).reason,
    "no_comparable_ref",
    "with neither a tracking branch nor a followed ref there is no baseline to judge against");
  assert.equal(staleness({ isGitCheckout: true, upstream: "origin/bojan", behind: null }).reason,
    "behind_count_unresolvable",
    "an unreadable count is not evidence of staleness");
  assert.equal(staleness({ isGitCheckout: true, upstream: "origin/bojan", behind: -1 }).reason,
    "behind_count_unresolvable");
});

// The whole failure mode is someone believing a restart was enough, so the
// message has to say plainly that it was not.
test("the warning names the gap and says a restart alone will not close it", function () {
  var state = { isGitCheckout: true, upstream: "origin/bojan", behind: 8, head: "777f06388fabc" };
  var message = stalenessMessage(staleness(state), state);
  assert.match(message, /8 commits behind origin\/bojan/);
  assert.match(message, /777f06388f/);
  assert.match(message, /will NOT take effect/);
  assert.equal(message.indexOf("uncommitted") === -1, true,
    "a clean tree must not be told about uncommitted changes");
});

test("an uncommitted tree is told why it was left alone", function () {
  var state = { isGitCheckout: true, upstream: "origin/bojan", behind: 1, head: "abc123", dirty: true };
  var message = stalenessMessage(staleness(state), state);
  assert.match(message, /1 commit behind/, "one commit reads as singular");
  assert.match(message, /uncommitted changes/);
});

test("a healthy checkout produces no message at all", function () {
  var state = { isGitCheckout: true, upstream: "origin/bojan", behind: 0 };
  assert.equal(stalenessMessage(staleness(state), state), "");
  assert.equal(stalenessMessage(null, null), "");
});

// The real incident happened in a DETACHED checkout, where @{u} does not
// resolve at all. A detector that needs a tracking branch would have stayed
// silent through the exact failure it exists to catch, so these cover the
// path that actually mattered.
test("a detached checkout is still judged, using the ref it follows", function () {
  var state = {
    isGitCheckout: true, upstream: "", followedRef: "origin/bojan",
    behind: 8, head: "777f06388f", dirty: false,
  };
  var verdict = staleness(state);
  assert.equal(verdict.stale, true,
    "a detached tree 8 commits behind is stale, tracking branch or not");
  assert.equal(verdict.upstream, "origin/bojan");
  assert.match(stalenessMessage(verdict, state), /8 commits behind origin\/bojan/);
});

test("the followed ref is read from the reflog, not guessed from origin/HEAD", function () {
  var ref = followedRefFromReflog([
    "merge origin/bojan: Fast-forward",
    "checkout: moving from 777f06388f to origin/bojan",
  ]);
  assert.equal(ref, "origin/bojan",
    "the most recent remote ref the tree followed is the honest comparison point");
});

test("a bare commit-ish in the reflog is not mistaken for a branch", function () {
  assert.equal(followedRefFromReflog(["merge 00182c1ea2: Fast-forward"]), "",
    "a raw sha says nothing about upstream movement");
  assert.equal(followedRefFromReflog(["checkout: moving from main to hotfix"]), "",
    "a local branch name is not a remote-tracking ref");
  assert.equal(followedRefFromReflog([]), "");
  assert.equal(followedRefFromReflog(null), "");
});

test("with nothing comparable, it stays quiet instead of inventing a baseline", function () {
  var verdict = staleness({ isGitCheckout: true, upstream: "", followedRef: "", behind: 8 });
  assert.equal(verdict.stale, false,
    "no comparison point means no claim; a wrong count is worse than no count");
  assert.equal(verdict.reason, "no_comparable_ref");
});
