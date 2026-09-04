// The Lead's owner-answer path: link-cap agreement, batching, and the
// positional-vs-identity question behind requestRef.
//
// Two separate claims are pinned here, and they are pinned for different
// reasons.
//
// LINK CAP (a real defect, fixed by the module under test). lead-loop's
// answerableRequests applied no bound at all and ownerResponseLink emitted
// every answerable request in one flat array, while the MCP gate validated
// link_owner_response with an independent literal cap and
// coop-owner-response-linkage carried a THIRD copy of the same number. With
// 20 unanswered requests in live state against a cap of 16 the gate refused
// the entire call with a typed `too_big`, so the Lead's highest-priority
// decision could never be linked, never drained, and the backlog only grew.
// Nothing threw: a rejected link is silent, which is how this class of bug
// produced owner requests sitting unanswered for days (audit 2026-08-12).
//
// The guard that matters is the AGREEMENT test, not the batching test. It is
// written behaviourally -- exactly CAP parses, CAP+1 is refused -- so it fails
// whichever side is edited alone. Raising the literal on one side only is the
// exact mistake that created the deadlock, and a bigger literal on BOTH sides
// would merely move the deadlock to a higher threshold; batching removes the
// threshold as a failure mode.
//
// REQUEST REF IDENTITY (already solved in this codebase; pinned as a
// regression guard). requestRef.eventIndex is a raw offset into a transcript
// the persistence layer re-indexes on every write (delta coalescing,
// cf7f197ee1), so it rots. The durable identity is coopIngressId, stamped on
// the owner turn itself and resolved by coop-owner-event-resolution, with the
// offset kept only as a fast path. These tests pin both halves of that
// contract -- identity survives a reorder, and a legacy record carrying only
// an offset still resolves -- because the fast path is an optimisation that
// must never become the only path again.

var test = require("node:test");
var assert = require("node:assert/strict");
var z = require("zod");

var batching = require("../lib/coop-owner-request-batching");
var loop = require("../lib/lead-loop");
var mcp = require("../lib/coop-control-ledger-reconciliation-mcp-server");
var resolution = require("../lib/coop-owner-event-resolution");
var sessionHistory = require("../lib/sessions-history");

var LEAD = "system-lead";
var COOP = "871a194b-8879-40f7-a1fe-656e48e722af";
var CAP = batching.MAX_OWNER_REQUEST_BATCH;

// An unanswered, answerable owner request as the Lead gatherer supplies it.
function unanswered(sequence) {
  return {
    ingressId: "coop:" + COOP + ":" + sequence,
    ingressSequence: sequence,
    state: "open",
    receivedAt: 1788400000000 + sequence,
    requestRef: { projectId: LEAD, sessionStorageId: COOP, eventIndex: 1000 + sequence },
  };
}

function unansweredRun(count, firstSequence) {
  var start = firstSequence || 1;
  var list = [];
  for (var i = 0; i < count; i++) list.push(unanswered(start + i));
  return list;
}

// The live zod schema the daemon actually validates link_owner_response with.
// Read off getToolDefs rather than reconstructed, so a change to the real
// schema is visible here.
function linkRequestsSchema() {
  var defs = mcp.getToolDefs({ sm: null });
  var link = null;
  for (var i = 0; i < defs.length; i++) {
    if (defs[i].name === "link_owner_response") link = defs[i];
  }
  assert.ok(link, "link_owner_response must still be advertised");
  assert.ok(link.inputSchema && link.inputSchema.requests,
    "zod must be loaded; the schema degrades to {} without it and would vacuously pass");
  return z.object({ requests: link.inputSchema.requests });
}

function acceptsBatchOf(schema, size) {
  return schema.safeParse({ requests: batchOf(size) }).success;
}

function batchOf(size) {
  var requests = [];
  for (var i = 0; i < size; i++) {
    requests.push({
      ingressId: "coop:" + COOP + ":" + (i + 1),
      requestRef: { projectId: LEAD, sessionStorageId: COOP, eventIndex: i + 1 },
    });
  }
  return requests;
}

test("both sides import the shared cap instead of re-typing the literal", function () {
  // The behavioural agreement test below cannot see the difference between
  // "imports the constant" and "happens to hardcode the same number today",
  // because both produce identical behaviour while the numbers coincide. That
  // is not a hypothetical gap: during development of this very fix the imports
  // were reverted out of both files and every behavioural test still passed,
  // because the stale literals were also 16. Re-typing the literal is how the
  // original deadlock was built, so pin the mechanism, not just the value.
  var fs = require("node:fs");
  var path = require("node:path");
  var sources = ["coop-control-ledger-reconciliation-mcp-server.js",
    "coop-owner-response-linkage.js", "lead-loop.js"];
  for (var i = 0; i < sources.length; i++) {
    var file = path.join(__dirname, "..", "lib", sources[i]);
    var text = fs.readFileSync(file, "utf8");
    assert.match(text, /require\((?:"|')\.\/coop-owner-request-batching(?:"|')\)/,
      sources[i] + " must import the shared cap module");
    // Strip comments before hunting for a re-typed literal, so prose that
    // explains the history (which necessarily mentions the number) does not
    // trip this. Only the SHARED cap value is forbidden as a literal --
    // unrelated bounds in these files (.max(32) on ingressIds, .max(128) on
    // the idempotency key) are legitimately their own numbers.
    var code = text.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(code, new RegExp("\\.max\\(\\s*" + CAP + "\\s*\\)"),
      sources[i] + " re-types the shared cap as a literal instead of importing it");
    assert.doesNotMatch(code, /MAX_LINKED_REQUESTS\s*=\s*\d/,
      sources[i] + " re-types the linked-request cap as a literal");
  }
});

test("the Lead's batch size and the control gate's cap are the same constant", function () {
  // Deliberately behavioural rather than an equality check against an
  // introspected zod internal: this fails if EITHER side is changed alone.
  // Enlarging the schema's literal makes CAP+1 start parsing; shrinking it, or
  // raising the shared constant without the schema, makes CAP stop parsing.
  var schema = linkRequestsSchema();

  assert.equal(acceptsBatchOf(schema, CAP), true,
    "the gate must accept a full batch of exactly MAX_OWNER_REQUEST_BATCH");
  assert.equal(acceptsBatchOf(schema, CAP + 1), false,
    "the gate must refuse one more than the shared constant -- if this passes, " +
    "the schema's cap was raised without raising MAX_OWNER_REQUEST_BATCH");

  // The batcher must never emit a batch the gate would refuse, for any size.
  var batches = batching.batchOwnerRequests(batchOf(CAP * 3 + 1));
  for (var i = 0; i < batches.length; i++) {
    assert.ok(batches[i].length <= CAP, "batch " + i + " exceeds the gate's cap");
  }
});

test("coop-owner-response-linkage enforces that same shared cap", function () {
  // The third copy of the literal used to live in this module. It imports the
  // constant now, and the guard has to be BIDIRECTIONAL to be worth anything:
  // asserting only that an over-cap set is refused still passes when the module
  // re-hardcodes a SMALLER bound than the Lead batches to, which is precisely
  // the deadlock again. So pin both edges by their distinct typed codes --
  // exactly CAP must get past the size check, CAP+1 must not.
  var responseLinkage = require("../lib/coop-owner-response-linkage");

  function stage(size) {
    return responseLinkage.stageOwnerResponse({
      session: { coopHome: true, storageId: COOP, localId: 1, isProcessing: true,
        history: [{ type: "user_message", text: "tick", _ts: 1 }],
        coopConversationIngress: { nextSequence: 1, recent: [], activeIngressId: null } },
      ownerRequests: null,
      requests: batchOf(size),
      saveSession: function () {},
    });
  }

  var overCap = stage(CAP + 1);
  assert.equal(overCap.ok, false,
    "an over-cap request set must be refused, never silently truncated");
  assert.equal(overCap.code, "invalid_request_links",
    "over-cap must be refused by the SIZE check specifically");

  // A full batch must clear the size check. It still fails further down for a
  // different reason (no ledger is wired in here), and that different code is
  // the proof: anything other than invalid_request_links means the size check
  // let it through.
  var atCap = stage(CAP);
  assert.notEqual(atCap.code, "invalid_request_links",
    "a batch of exactly MAX_OWNER_REQUEST_BATCH must clear this module's size " +
    "check -- if it does not, this module's bound is smaller than the one the " +
    "Lead batches to and every full batch will be refused");
});

test("the live 20-unanswered-request backlog now links instead of failing too_big", function () {
  // Reproduces the measured live condition: 20 unanswered, answerable owner
  // requests against a cap of 16. Before batching, ownerResponseLink emitted a
  // single flat `requests` array of all 20 and the gate refused the whole call
  // with too_big, so nothing was ever linked.
  var requests = unansweredRun(20);
  assert.ok(requests.length > CAP, "the fixture must actually exceed the cap");

  var decisions = loop.leadTick({ unansweredRequests: requests });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, "answer_owner");

  var link = decisions[0].responseLink;
  assert.equal(link.version, 2);
  assert.equal(link.totalRequests, 20);
  assert.equal(link.maxRequestsPerCall, CAP);
  assert.equal(link.requests, undefined,
    "the flat over-cap array must be gone, not kept as a first-batch alias");

  // Every batch the Lead emits is accepted by the real gate schema.
  var schema = linkRequestsSchema();
  assert.ok(link.batches.length > 1, "20 requests must span more than one call");
  for (var i = 0; i < link.batches.length; i++) {
    var parsed = schema.safeParse({ requests: link.batches[i] });
    assert.equal(parsed.success, true,
      "batch " + i + " (" + link.batches[i].length + " refs) was refused by the gate: " +
      JSON.stringify(parsed.error && parsed.error.issues));
  }
});

test("no owner request is dropped or duplicated when the backlog exceeds the cap", function () {
  // Truncating to the first CAP would satisfy the gate and lose the rest with
  // nothing recording it, which is strictly worse than failing closed. Pin
  // exact conservation over a range of sizes, including the boundaries.
  var sizes = [1, CAP - 1, CAP, CAP + 1, 20, CAP * 2, CAP * 2 + 1, 97];
  for (var s = 0; s < sizes.length; s++) {
    var size = sizes[s];
    var requests = unansweredRun(size);
    var link = loop.leadTick({ unansweredRequests: requests })[0].responseLink;

    var seen = Object.create(null);
    var flattened = [];
    for (var b = 0; b < link.batches.length; b++) {
      assert.ok(link.batches[b].length >= 1, "an empty batch would be a refused call");
      assert.ok(link.batches[b].length <= CAP, "batch exceeds the gate cap at size " + size);
      for (var r = 0; r < link.batches[b].length; r++) {
        var id = link.batches[b][r].ingressId;
        assert.equal(seen[id], undefined,
          "ingress " + id + " appears in more than one batch at size " + size);
        seen[id] = true;
        flattened.push(id);
      }
    }

    assert.equal(flattened.length, size, "request count changed at size " + size);
    assert.equal(link.totalRequests, size);
    // Exact set AND exact oldest-first order, not merely the same membership.
    var expected = requests.map(function (request) { return request.ingressId; });
    assert.deepEqual(flattened, expected,
      "batches must concatenate back to the input, in order, at size " + size);
  }
});

test("an owner ref still resolves after a chronological replay reorders history", function () {
  // Drives the REAL reorder shipped in 48e6337759 rather than a hand-permuted
  // fixture, so this test tracks that function's behaviour.
  var turn = { type: "user_message", text: "please fix the gate",
    coopIngressId: "coop:" + COOP + ":27", _ts: 500 };
  var queuedEarlier = { type: "user_message", text: "queued but older",
    coopIngressId: "coop:" + COOP + ":26", queuedDuringProcessing: true, _ts: 100 };
  var history = [
    { type: "thinking_delta", _ts: 50 },
    turn,
    { type: "done", _ts: 600 },
    queuedEarlier,
  ];

  var storedIndex = history.indexOf(turn);
  assert.equal(resolution.resolveIndexByIngressId(history, turn.coopIngressId), storedIndex);

  var reordered = sessionHistory.orderQueuedHistoryItems(history);
  assert.notEqual(reordered.indexOf(turn), storedIndex,
    "the replay must actually move the owner turn, or this proves nothing");

  // The stored positional offset now points at the wrong record entirely...
  var atStoredIndex = reordered[storedIndex];
  assert.notEqual(atStoredIndex && atStoredIndex.coopIngressId, turn.coopIngressId,
    "the bare index must be shown to be wrong before identity is shown to be right");

  // ...while the durable identity still finds the correct owner turn.
  assert.equal(resolution.resolveByIngressId(reordered, turn.coopIngressId), turn);
  assert.equal(reordered[resolution.resolveIndexByIngressId(reordered, turn.coopIngressId)], turn);
});

test("a legacy record carrying only eventIndex still resolves positionally", function () {
  // Backward compatibility: records written before identity resolution carry
  // nothing but the offset. While that offset still lands on the right turn it
  // must be honoured as the fast path -- resolution must not require a field
  // old records do not have.
  var turn = { type: "user_message", text: "older question",
    coopIngressId: "coop:" + COOP + ":9", _ts: 10 };
  var history = [{ type: "tool_result" }, turn, { type: "done" }];
  var legacyRef = { projectId: LEAD, sessionStorageId: COOP, eventIndex: 1 };

  // The fast path: the stored offset is correct and dereferences directly.
  var direct = history[legacyRef.eventIndex];
  assert.equal(direct, turn, "an unrotted legacy offset must still dereference");
  assert.equal(direct.type, "user_message");

  // And the same record resolves by identity, so a record with only an offset
  // is never worse off than one carrying identity too.
  assert.equal(resolution.resolveByIngressId(history, turn.coopIngressId), turn);

  // requestRef stays a bare three-field coordinate on purpose: the control
  // store validates it with an exact-field allowlist and throws on extras, so
  // identity lives on the event, not on the ref.
  assert.deepEqual(Object.keys(legacyRef).sort(),
    ["eventIndex", "projectId", "sessionStorageId"]);
});
