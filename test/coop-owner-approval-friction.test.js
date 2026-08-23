// Characterization of the owner-approval friction measured on 2026-08-23.
//
// These tests assert what the admission wording parsers CURRENTLY do, including
// the parts the owner experiences as friction. They exist because the friction
// was diagnosed three times from prose and re-derived from scratch each time;
// see memory/2026-08-23-owner-approval-friction-brief.md for the analysis and
// the proposed fix.
//
// Read them as a tripwire, not as an endorsement. Every assertion below that is
// marked FRICTION is behavior we want to change; when the follow-up widens the
// verb allowlist or makes a turn bind more than one task, these tests must fail
// and be updated DELIBERATELY, rather than the change landing unnoticed.
//
// Nothing here loosens or tightens any gate: this file only observes.

var test = require("node:test");
var assert = require("node:assert");

var intent = require("../lib/coop-thread-implementation-intent");
var pendingQuestion = require("../lib/coop-pending-question-admission");

function decision(text) {
  return intent.explicitImplementationDecision(text);
}

// The whole recognized set, verbatim from coop-thread-implementation-intent's
// three regexes. coop-owner-request-records.normalizeImplementationDecision
// accepts these plus "hand_off", which only the deictic branches can mint.
var RECOGNIZED_VERBS = ["build", "fix", "implement", "ship", "deploy", "code"];

test("every recognized verb binds a project, and the set is exactly six", function () {
  RECOGNIZED_VERBS.forEach(function (verb) {
    assert.deepEqual(decision(verb + " the ledger in clay"),
      { intent: verb, projectName: "clay" }, verb + " must bind");
  });
});

// FRICTION (a): the verb allowlist has no synonyms, no stemming, and no
// morphological fallback, so an ordinary imperative naming a real project is
// refused owner_implementation_decision_required. This is the exact pair the
// owner hit live: ingress 675/679 vs the retry that worked.
test("FRICTION: an unlisted imperative verb binds nothing, however well formed", function () {
  assert.equal(decision("Backfill the responseRef anchors in clay"), null,
    "the live failing turn: refused purely because 'backfill' is not one of six verbs");
  assert.deepEqual(decision("Fix the responseRef anchor backfill in clay"),
    { intent: "fix", projectName: "clay" },
    "the live succeeding retry: identical work, and 'backfill' is now an ignored object");

  // Not cherry-picked. These are ordinary ways to state implementation work.
  ["Migrate the ledger in clay", "Refactor the admission in clay",
    "Update the anchors in clay", "Rewrite the parser in clay",
    "Add a guard in clay", "Remove the dead route in clay",
    "Wire the gate in clay", "Patch the regex in clay",
    "Repair the binding in clay", "Finish the backfill in clay",
  ].forEach(function (text) {
    assert.equal(decision(text), null, "currently refused: " + JSON.stringify(text));
  });
});

// FRICTION (c): the decision model is single-valued end to end. The verb match
// is ^-anchored and non-global, so only a leading verb is ever seen; the one
// branch that reads past "and" (compoundImplementationDecision) collapses the
// pair into ONE intent and uses the first clause only as a veto filter.
test("FRICTION: a compound turn binds one clause and silently drops the rest", function () {
  assert.deepEqual(decision("fix the anchors and backfill the ledger in clay"),
    { intent: "fix", projectName: "clay" },
    "the second clause is inert text; nothing records that work was requested");

  // The mirror image: the compound branch requires a deictic object
  // ("and fix IT"), and then it is the LAST clause that wins and the first that
  // is discarded -- so which clause survives depends on the sentence shape.
  assert.deepEqual(decision("Backfill the anchors and fix it in clay"),
    { intent: "fix", projectName: "clay" },
    "here the leading clause is the one dropped");

  // Either way the result is a single {intent, projectName}. There is no
  // plural decision field to hold a second task, which is why "pick both"
  // and "fix X and Y" can never staff two items from one turn.
  var compound = decision("fix the anchors and ship it in clay");
  assert.ok(compound && typeof compound.intent === "string",
    "the return shape is one object, never a list");
});

// FRICTION: the project capture is a single non-global match anchored to the end
// of the string, so the EARLIEST in/for/to wins and swallows every later clause.
// The resulting projectName resolves to no project, and the dispatch then fails
// as project_target_unavailable rather than as a wording problem -- which is why
// this one is especially hard for the owner to diagnose.
test("FRICTION: a two-project turn captures a garbage project name", function () {
  assert.deepEqual(decision("Fix the anchors in lib/coop and the tests in clay"),
    { intent: "fix", projectName: "lib/coop and the tests in clay" },
    "one greedy capture, so neither named target is resolvable");
});

// The referential route is the one that is SUPPOSED to absorb natural wording,
// and its assent allowlist is genuinely broad. The gap is not the wording here;
// it is that the route needs a pending waiting_user record whose clientRef is
// portfolio:<task>:<revision>, and that record can only exist for work that has
// already been delegated. See the brief.
test("the assent allowlist already accepts the owner's natural answers", function () {
  ["yes", "Ok", "do it", "both", "1 and 2", "do 1 and 2 what you think is best",
    "go ahead", "proceed", "your call", "sure",
  ].forEach(function (text) {
    assert.equal(pendingQuestion.explicitOwnerAssent(text), true,
      "must be assent: " + JSON.stringify(text));
  });
});

// FRICTION (c) again, on the referential side: assent is read from the FIRST
// SENTENCE only, so a turn that agrees and then adds a second instruction has
// its tail ignored. This is the accepted boundary recorded in
// coop-pending-question-admission's header, restated here as a live assertion.
test("FRICTION: assent reads only the first sentence, so a tail is ignored", function () {
  assert.equal(pendingQuestion.explicitOwnerAssent("Yes. Also do the other one"), true,
    "this binds the answered question only; 'the other one' is dropped silently");
  assert.equal(pendingQuestion.explicitOwnerAssent("yes and also fix the tests"), false,
    "a single-sentence compound answer is refused outright instead of binding one part");
});
