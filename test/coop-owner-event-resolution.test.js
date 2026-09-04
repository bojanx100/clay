var test = require("node:test");
var assert = require("node:assert");

var resolution = require("../lib/coop-owner-event-resolution");

function ownerTurn(ingressId) {
  return { type: "user_message", text: "implement it", coopIngressId: ingressId };
}

test("an owner turn resolves by its ingress wherever it moved to", function () {
  var turn = ownerTurn("coop:coop-home:459");
  var history = [{ type: "tool_result" }, { type: "thinking_stop" }, turn];

  assert.equal(resolution.resolveByIngressId(history, "coop:coop-home:459"), turn);
  assert.equal(resolution.resolveByIngressId(history, "coop:coop-home:460"), null);
});

test("only owner-stamped user messages are resolvable", function () {
  // Synthetic pushes and tool traffic carry no coopIngressId, and nothing that
  // is not a user_message may ever stand in for an owner turn.
  var history = [
    { type: "tool_result", coopIngressId: "coop:coop-home:1" },
    { type: "assistant_message", coopIngressId: "coop:coop-home:2" },
    { type: "user_message", synthetic: true },
  ];

  assert.equal(resolution.resolveByIngressId(history, "coop:coop-home:1"), null);
  assert.equal(resolution.resolveByIngressId(history, "coop:coop-home:2"), null);
});

test("a duplicated ingress fails closed rather than picking a winner", function () {
  var first = ownerTurn("coop:coop-home:459");
  var second = ownerTurn("coop:coop-home:459");
  var third = ownerTurn("coop:coop-home:459");

  assert.equal(resolution.resolveByIngressId([first, second], "coop:coop-home:459"), null,
    "guessing which turn the owner meant is the fail-open move");
  assert.equal(resolution.resolveByIngressId([first, second, third], "coop:coop-home:459"), null,
    "a third occurrence must not collapse back to a unique match");
});

test("a removed owner turn stops resolving even when the length is unchanged", function () {
  // The cache is keyed on the history array, so it needs invalidation. Keying on
  // length alone is not enough: an in-place removal that also appends leaves the
  // length identical while the owner turn is gone from the transcript. On this
  // gate that would let a deleted owner turn keep authorizing dispatches, so the
  // resolver verifies its hit still sits where it was indexed.
  var turn = ownerTurn("coop:coop-home:459");
  var history = [{ type: "tool_result" }, { type: "thinking_stop" }, turn, { type: "tool_executing" }];

  assert.equal(resolution.resolveByIngressId(history, "coop:coop-home:459"), turn);

  history.splice(2, 1);
  history.push({ type: "tool_executing" });
  assert.equal(history.length, 4, "the removal is invisible to a length-only check");

  assert.equal(resolution.resolveByIngressId(history, "coop:coop-home:459"), null,
    "a turn no longer in the transcript must not resolve");
});

test("a relocated owner turn still resolves after the transcript shifts under it", function () {
  // The legitimate counterpart: coalescing moves the turn but does not remove it.
  var turn = ownerTurn("coop:coop-home:459");
  var history = [{ type: "tool_result" }, turn, { type: "tool_executing" }];

  assert.equal(resolution.resolveByIngressId(history, "coop:coop-home:459"), turn);

  history.splice(0, 1);
  history.push({ type: "tool_result" });
  assert.equal(resolution.resolveByIngressId(history, "coop:coop-home:459"), turn);
});

test("a forked history resolves independently of the session it was sliced from", function () {
  // Forks slice their history, so they share event objects with the canonical
  // session. The cache is keyed on the array, so each gets its own index.
  var turn = ownerTurn("coop:coop-home:459");
  var canonical = [turn, { type: "tool_result" }];
  var fork = canonical.slice(0, 1);

  assert.equal(resolution.resolveByIngressId(canonical, "coop:coop-home:459"), turn);
  assert.equal(resolution.resolveByIngressId(fork, "coop:coop-home:459"), turn);

  fork.length = 0;
  assert.equal(resolution.resolveByIngressId(fork, "coop:coop-home:459"), null);
  assert.equal(resolution.resolveByIngressId(canonical, "coop:coop-home:459"), turn,
    "emptying the fork must not disturb the canonical session's resolution");
});

test("malformed input is refused rather than throwing", function () {
  assert.equal(resolution.resolveByIngressId(null, "coop:coop-home:1"), null);
  assert.equal(resolution.resolveByIngressId([ownerTurn("a")], ""), null);
  assert.equal(resolution.resolveByIngressId([ownerTurn("a")], null), null);
});
