// checkout-staleness.js - Does a restart actually pick up newer code?
//
// A packaged install updates by resolving a fresh clay-server through npx
// (see the "update" IPC in daemon.js). A git checkout has no equivalent: the
// daemon re-execs lib/daemon.js from the SAME working tree, so restarting
// after a merge faithfully re-runs the OLD commit. Merged work then sits inert
// with nothing reporting it, and the only symptom is that a fix which is
// provably on the branch does not happen. That has already bitten twice.
//
// This module answers one question -- would this restart run different code
// than what the tracking branch holds? -- and nothing more. It is deliberately
// REPORT-ONLY. Fast-forwarding automatically would mean mutating a working
// tree that may hold uncommitted work, during shutdown, with no one watching.
// Reporting is safe in every state; moving someone's tree is not.
//
// Pure: callers supply the git output. Nothing here spawns a process, so the
// decision logic stays testable without a repository.

// Unknown is NOT stale. This runs on every restart, so guessing wrong towards
// "stale" would cry wolf on packaged installs, detached checkouts used
// deliberately, and repos with no upstream -- all perfectly normal states.
// Only a definite, positive count of missing commits is worth interrupting for.
// Which ref does a detached checkout actually follow? origin/HEAD is the
// tempting answer and the wrong one: it points at the repo's default branch,
// which may be nothing to do with the branch this tree is kept on. Comparing
// against it would produce confidently wrong counts.
//
// The reflog records what really happened to this tree -- the ref it was
// checked out to, and the ref it merges. Reading the most recent of those is
// the difference between a fact and a guess. Only remote-tracking refs are
// accepted, since a local branch name says nothing about upstream movement.
function followedRefFromReflog(messages) {
  var lines = Array.isArray(messages) ? messages : [];
  for (var i = 0; i < lines.length; i++) {
    var line = typeof lines[i] === "string" ? lines[i].trim() : "";
    if (!line) continue;
    var moved = /^checkout: moving from \S+ to (\S+)$/.exec(line);
    var merged = /^merge (\S+?):/.exec(line);
    var ref = (moved && moved[1]) || (merged && merged[1]) || "";
    if (ref && ref.indexOf("/") !== -1 && !/^[0-9a-f]{7,40}$/i.test(ref)) return ref;
  }
  return "";
}

function staleness(input) {
  var state = input && typeof input === "object" ? input : {};
  if (state.isGitCheckout !== true) {
    return { stale: false, reason: "not_a_git_checkout" };
  }
  // A detached checkout has no @{u}, and that is precisely the state the real
  // incident happened in: the tree sat detached at an old commit while the
  // branch it follows moved on. Requiring a tracking branch would therefore
  // have stayed silent through the exact failure this exists to catch, so fall
  // back to the ref the checkout demonstrably follows.
  var upstream = typeof state.upstream === "string" ? state.upstream.trim() : "";
  if (!upstream) upstream = typeof state.followedRef === "string" ? state.followedRef.trim() : "";
  if (!upstream) {
    return { stale: false, reason: "no_comparable_ref" };
  }
  // Number(null) is 0, which would quietly read an unreadable count as
  // "up to date". Require an actual number before trusting it.
  var behind = typeof state.behind === "number" ? state.behind : NaN;
  if (!Number.isInteger(behind) || behind < 0) {
    return { stale: false, reason: "behind_count_unresolvable" };
  }
  if (behind === 0) {
    return { stale: false, reason: "up_to_date", upstream: upstream };
  }
  return {
    stale: true,
    reason: "behind_tracking_branch",
    upstream: upstream,
    behind: behind,
    head: typeof state.head === "string" ? state.head.trim() : "",
  };
}

// Names the manual step, because the whole failure mode is someone believing a
// restart was enough. Mentions uncommitted work only when there is some: that
// is exactly when the obvious "git pull" needs care, and noise in the other
// case would train people to ignore the line.
function stalenessMessage(verdict, state) {
  if (!verdict || verdict.stale !== true) return "";
  var head = verdict.head ? verdict.head.slice(0, 10) : "the current commit";
  var plural = verdict.behind === 1 ? "commit" : "commits";
  var message = "Restarting on stale code: this checkout is " + verdict.behind + " " +
    plural + " behind " + verdict.upstream + " (running " + head + "). " +
    "A restart re-runs the current checkout, so merged changes will NOT take effect " +
    "until the checkout is updated.";
  if (state && state.dirty === true) {
    message += " This working tree has uncommitted changes, so it was not updated automatically.";
  }
  return message;
}

// The other half of the same failure, and the half that actually keeps
// happening: the daemon boots on a current checkout, the checkout then moves
// ahead (a merge, a pull), and the daemon keeps serving the OLD code with
// nothing saying so. staleness() cannot see this -- at the next restart the
// checkout is perfectly up to date, so it correctly stays silent, and the
// owner is left wondering why merged work has no effect.
//
// The comparison is deliberately "what did this process load" vs "what is on
// disk now", not anything about the remote. Being behind origin is a checkout
// problem; being behind your own checkout is a restart problem, and only the
// second one is fixed by restarting.
function bootDrift(bootSha, currentSha) {
  var boot = typeof bootSha === "string" ? bootSha.trim() : "";
  var current = typeof currentSha === "string" ? currentSha.trim() : "";
  if (!boot || !current) return { drifted: false, reason: "unknown_commit" };
  if (boot === current) return { drifted: false, reason: "up_to_date" };
  return { drifted: true, reason: "checkout_moved", bootSha: boot, currentSha: current };
}

function bootDriftMessage(verdict) {
  if (!verdict || verdict.drifted !== true) return "";
  return "This Clay daemon is running code from " + verdict.bootSha.slice(0, 10) +
    ", but the checkout has since moved to " + verdict.currentSha.slice(0, 10) + ". " +
    "Restart Clay to pick up the newer code.";
}

module.exports = {
  staleness: staleness,
  followedRefFromReflog: followedRefFromReflog,
  stalenessMessage: stalenessMessage,
  bootDrift: bootDrift,
  bootDriftMessage: bootDriftMessage,
};
