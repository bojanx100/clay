var test = require("node:test");
var assert = require("node:assert/strict");
var staleness = require("../lib/checkout-staleness").staleness;
var stalenessMessage = require("../lib/checkout-staleness").stalenessMessage;
var followedRefFromReflog = require("../lib/checkout-staleness").followedRefFromReflog;
var bootDrift = require("../lib/checkout-staleness").bootDrift;
var bootDriftMessage = require("../lib/checkout-staleness").bootDriftMessage;

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

// The recurring failure staleness() CANNOT see: the daemon boots on a current
// checkout, the checkout moves ahead, and the process keeps serving old code.
// At the next restart the checkout is up to date, so staleness() correctly
// stays silent -- and the owner is left wondering why merged work did nothing.
test("a checkout that moved past the running process is reported", function () {
  var verdict = bootDrift("777f06388f814a2f7bba15b30fb8289e99faa482",
                          "4098f94d7270517ba486ca89392ae1abf92da6c9");
  assert.equal(verdict.drifted, true);
  assert.equal(verdict.reason, "checkout_moved");
  var message = bootDriftMessage(verdict);
  assert.match(message, /running code from 777f06388f/);
  assert.match(message, /moved to 4098f94d72/);
  assert.match(message, /Restart Clay/,
    "the fix is a restart, and the message must say so");
});

test("a process running the checkout it booted from says nothing", function () {
  var same = "4098f94d7270517ba486ca89392ae1abf92da6c9";
  var verdict = bootDrift(same, same);
  assert.equal(verdict.drifted, false);
  assert.equal(verdict.reason, "up_to_date");
  assert.equal(bootDriftMessage(verdict), "");
});

test("an unknown commit on either side is not reported as drift", function () {
  assert.equal(bootDrift("", "abc123").drifted, false,
    "a packaged install has no boot commit to compare");
  assert.equal(bootDrift("abc123", "").drifted, false,
    "an unreadable HEAD is not evidence the checkout moved");
  assert.equal(bootDrift(null, null).reason, "unknown_commit");
  assert.equal(bootDriftMessage(null), "");
  assert.equal(bootDriftMessage({ drifted: false }), "");
});

test("boot drift and checkout staleness answer different questions", function () {
  // Being behind origin is a CHECKOUT problem: restarting alone will not fix
  // it. Being behind your own checkout is a RESTART problem: restarting is
  // exactly the fix. Conflating them sends the owner to the wrong action.
  var stale = staleness({
    isGitCheckout: true, followedRef: "origin/bojan", behind: 3, head: "aaa1111111",
  });
  assert.equal(stale.stale, true);
  assert.match(stalenessMessage(stale, null), /will NOT take effect/);

  var drift = bootDrift("aaa1111111", "bbb2222222");
  assert.match(bootDriftMessage(drift), /Restart Clay to pick up the newer code/);
  assert.equal(/Restart Clay to pick up/.test(stalenessMessage(stale, null)), false,
    "a stale checkout must not tell the owner a restart is sufficient");
});
