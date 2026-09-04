var test = require("node:test");
var assert = require("node:assert");

var resolution = require("../lib/coop-owner-response-resolution");

function uuidEvent(uuid, messageType) {
  return { type: "message_uuid", uuid: uuid, messageType: messageType || "assistant", _ts: 1 };
}

function done(code) {
  return { type: "done", code: code || 0, _ts: 2 };
}

test("a done is anchored by the message_uuid immediately before it", function () {
  var history = [
    { type: "user_message", text: "how is the fleet?" },
    uuidEvent("11111111-1111-4111-8111-111111111111", "user"),
    { type: "delta", text: "Fine." },
    uuidEvent("22222222-2222-4222-8222-222222222222", "assistant"),
    done(0),
  ];

  assert.equal(resolution.anchorForDone(history, 4), "22222222-2222-4222-8222-222222222222");
  assert.equal(resolution.resolveDoneByAnchor(history, "22222222-2222-4222-8222-222222222222"), 4);
});

test("the nearest preceding message_uuid wins over an earlier one in the same turn", function () {
  var history = [
    { type: "user_message", text: "two replies please" },
    uuidEvent("aaaa-1"),
    { type: "delta", text: "first" },
    uuidEvent("aaaa-2"),
    { type: "delta", text: "second" },
    done(0),
  ];

  assert.equal(resolution.anchorForDone(history, 5), "aaaa-2");
  assert.equal(resolution.resolveDoneByAnchor(history, "aaaa-2"), 5);
  assert.equal(resolution.resolveDoneByAnchor(history, "aaaa-1"), -1,
    "a superseded anchor inside the same turn must not resolve to that turn's done");
});

test("the scan stops at the turn boundary rather than borrowing the previous turn", function () {
  // A done at the very start of a turn has no assistant message of its own.
  // Reaching back past the user_message would let it claim identity from a
  // reply given in an earlier turn.
  var history = [
    { type: "user_message", text: "first" },
    uuidEvent("prev-turn-uuid"),
    done(0),
    { type: "user_message", text: "second" },
    done(0),
  ];

  assert.equal(resolution.anchorForDone(history, 4), "");
  assert.equal(resolution.resolveDoneByAnchor(history, "prev-turn-uuid"), 2,
    "the earlier turn's own done still resolves");
});

test("a uuid anchoring two dones fails closed rather than picking a winner", function () {
  var history = [
    { type: "user_message", text: "go" },
    uuidEvent("shared-uuid"),
    { type: "delta", text: "reply" },
    done(0),
    done(0),
  ];

  assert.equal(resolution.anchorForDone(history, 3), "shared-uuid");
  assert.equal(resolution.anchorForDone(history, 4), "shared-uuid");
  assert.equal(resolution.resolveDoneByAnchor(history, "shared-uuid"), -1);
});

test("an error done still consumes its anchor so a collision cannot resolve to the survivor", function () {
  // The error done can never satisfy responseProof, which requires !event.code.
  // That is precisely why it must not be skipped here: skipping it would leave
  // the clean done as a unique match and quietly resolve an ambiguous anchor.
  var history = [
    { type: "user_message", text: "go" },
    uuidEvent("collide-uuid"),
    { type: "delta", text: "reply" },
    done(1),
    done(0),
  ];

  assert.equal(resolution.resolveDoneByAnchor(history, "collide-uuid"), -1);
});

test("a done with no message_uuid before it has no anchor", function () {
  var history = [
    { type: "user_message", text: "go" },
    { type: "delta", text: "reply" },
    done(0),
  ];

  assert.equal(resolution.anchorForDone(history, 2), "");
  assert.equal(resolution.resolveDoneByAnchor(history, ""), -1);
});

test("only a done is anchored, and only a usable uuid anchors it", function () {
  var history = [
    { type: "user_message", text: "go" },
    uuidEvent("usable-uuid"),
    { type: "delta", text: "reply" },
    done(0),
  ];

  assert.equal(resolution.anchorForDone(history, 2), "",
    "a delta is not an answering event and must not be given an identity");
  assert.equal(resolution.anchorForDone(history, 99), "");

  var blank = [
    { type: "user_message", text: "go" },
    uuidEvent("outer-uuid"),
    { type: "message_uuid", uuid: "" },
    done(0),
  ];
  assert.equal(resolution.anchorForDone(blank, 3), "outer-uuid",
    "an empty uuid event is skipped rather than blanking the anchor");
});

test("a done resolves by anchor after the transcript shifts under its index", function () {
  // This is the whole point. Transcript coalescing merges consecutive deltas on
  // write, so the stored index moves while the answering event does not change.
  var answering = done(0);
  var history = [
    { type: "user_message", text: "go" },
    uuidEvent("stable-uuid"),
    { type: "delta", text: "a" },
    { type: "delta", text: "b" },
    { type: "delta", text: "c" },
    answering,
  ];
  assert.equal(resolution.resolveDoneByAnchor(history, "stable-uuid"), 5);

  var coalesced = [
    { type: "user_message", text: "go" },
    uuidEvent("stable-uuid"),
    { type: "delta", text: "abc" },
    answering,
  ];
  assert.notEqual(coalesced[5], answering, "the stored index no longer names the done");
  assert.equal(resolution.resolveDoneByAnchor(coalesced, "stable-uuid"), 3);
});

test("a removed done stops resolving even when the length is unchanged", function () {
  var answering = done(0);
  var history = [
    { type: "user_message", text: "go" },
    uuidEvent("stable-uuid"),
    { type: "delta", text: "a" },
    answering,
  ];
  assert.equal(resolution.resolveDoneByAnchor(history, "stable-uuid"), 3);

  history.splice(3, 1);
  history.push({ type: "tool_executing" });
  assert.equal(history.length, 4, "the removal is invisible to a length-only check");

  assert.equal(resolution.resolveDoneByAnchor(history, "stable-uuid"), -1,
    "a done no longer in the transcript must not prove an answer");
});

test("a relocated done still resolves after the transcript shifts under it", function () {
  var answering = done(0);
  var history = [
    { type: "tool_result" },
    { type: "user_message", text: "go" },
    uuidEvent("stable-uuid"),
    answering,
  ];
  assert.equal(resolution.resolveDoneByAnchor(history, "stable-uuid"), 3);

  history.splice(0, 1);
  history.push({ type: "tool_result" });
  assert.equal(resolution.resolveDoneByAnchor(history, "stable-uuid"), 2);
});

test("a forked history resolves independently of the session it was sliced from", function () {
  var answering = done(0);
  var canonical = [
    { type: "user_message", text: "go" },
    uuidEvent("stable-uuid"),
    answering,
    { type: "tool_result" },
  ];
  var fork = canonical.slice(0, 3);

  assert.equal(resolution.resolveDoneByAnchor(canonical, "stable-uuid"), 2);
  assert.equal(resolution.resolveDoneByAnchor(fork, "stable-uuid"), 2);

  fork.length = 0;
  assert.equal(resolution.resolveDoneByAnchor(fork, "stable-uuid"), -1);
  assert.equal(resolution.resolveDoneByAnchor(canonical, "stable-uuid"), 2,
    "emptying the fork must not disturb the canonical session's resolution");
});

test("malformed input is refused rather than throwing", function () {
  assert.equal(resolution.anchorForDone(null, 0), "");
  assert.equal(resolution.anchorForDone([done(0)], "0"), "");
  assert.equal(resolution.anchorForDone([null, done(0)], 1), "");
  assert.equal(resolution.resolveDoneByAnchor(null, "u"), -1);
  assert.equal(resolution.resolveDoneByAnchor([done(0)], null), -1);
  assert.equal(resolution.resolveDoneByAnchor([done(0)], ""), -1);
  assert.equal(resolution.resolveDoneByAnchor([null, uuidEvent("u"), done(0)], "u"), 2);
});
