var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var test = require("node:test");

var conversationControl = require("../lib/coop-conversation-control");
var ownerRequests = require("../lib/coop-owner-requests");
var responseLinkage = require("../lib/coop-owner-response-linkage");
var responseResolution = require("../lib/coop-owner-response-resolution");

var LEAD = "system-lead";
var COOP = "871a194b-8879-40f7-a1fe-656e48e722af";

function requestLink(sequence, eventIndex) {
  return {
    ingressId: "coop:" + COOP + ":" + sequence,
    requestRef: { projectId: LEAD, sessionStorageId: COOP, eventIndex: eventIndex },
  };
}

function recordRequest(ledger, sequence, eventIndex) {
  var link = requestLink(sequence, eventIndex);
  ledger.record({
    ingressId: link.ingressId,
    ingressSequence: sequence,
    sessionRef: { projectId: LEAD, sessionStorageId: COOP },
    requestRef: link.requestRef,
  });
  return link;
}

function harness() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-owner-response-link-"));
  var file = path.join(dir, "requests.json");
  var ledger = ownerRequests.attachCoopOwnerRequests({ file: file, now: function () { return 90; } });
  var session = {
    coopHome: true,
    storageId: COOP,
    localId: 7,
    isProcessing: true,
    history: [{ type: "user_message", text: "↻ Lead tick",
      autoAction: true, synthetic: true, _ts: 10 }],
    coopConversationIngress: { nextSequence: 300, recent: [], activeIngressId: null },
  };
  var saves = 0;
  return {
    dir: dir,
    file: file,
    ledger: ledger,
    session: session,
    save: function () { saves++; },
    saveCount: function () { return saves; },
  };
}

test("one Lead response settles only its exact durable request links", function () {
  var h = harness();
  var first = recordRequest(h.ledger, 292, 20);
  var second = recordRequest(h.ledger, 295, 40);
  var newer = recordRequest(h.ledger, 296, 60);
  var blocked = recordRequest(h.ledger, 297, 80);
  h.ledger.setState(blocked.ingressId, "needs_input");

  var staged = responseLinkage.stageOwnerResponse({
    session: h.session,
    ownerRequests: h.ledger,
    requests: [first, second],
    saveSession: h.save,
  });
  assert.equal(staged.ok, true);
  assert.equal(staged.link.requests.length, 2);

  h.session.history.push({ type: "tool_result", text: "linked" });
  h.session.history.push({ type: "delta_replace", text: "Answered 292 and 295 exactly." });
  h.session.history.push({ type: "done", code: 0, _ts: 100 });
  var controller = conversationControl.attachCoopConversationControl({
    coopOwnerRequests: h.ledger,
    sm: { saveSessionFile: h.save },
    sendToSession: function () {},
  });

  assert.equal(controller.markAnswered(h.session), true);
  assert.equal(h.ledger.get(first.ingressId).response.responseRef.eventIndex, 3);
  assert.equal(h.ledger.get(second.ingressId).response.responseRef.eventIndex, 3);
  assert.equal(h.ledger.get(newer.ingressId).response.state, "unanswered");
  assert.equal(h.ledger.get(blocked.ingressId).response.state, "unanswered");
  assert.equal(h.session.coopConversationIngress.pendingOwnerResponse, undefined);
  assert.equal(h.saveCount(), 2);
});

test("staging rejects stale, blocked, superseded, and mismatched request refs", function () {
  var h = harness();
  var open = recordRequest(h.ledger, 292, 20);
  var blocked = recordRequest(h.ledger, 295, 40);
  var superseded = recordRequest(h.ledger, 296, 60);
  h.ledger.setState(blocked.ingressId, "attention");
  h.ledger.supersede(superseded.ingressId, "owner_repeat");

  var blockedResult = responseLinkage.stageOwnerResponse({
    session: h.session, ownerRequests: h.ledger, requests: [blocked], saveSession: h.save,
  });
  var supersededResult = responseLinkage.stageOwnerResponse({
    session: h.session, ownerRequests: h.ledger, requests: [superseded], saveSession: h.save,
  });
  var mismatchedResult = responseLinkage.stageOwnerResponse({
    session: h.session,
    ownerRequests: h.ledger,
    requests: [Object.assign({}, open, { requestRef: Object.assign({}, open.requestRef, { eventIndex: 21 }) })],
    saveSession: h.save,
  });
  var nonDurableResult = responseLinkage.stageOwnerResponse({
    session: h.session, ownerRequests: h.ledger, requests: [open],
  });

  assert.equal(blockedResult.code, "request_not_answerable");
  assert.equal(supersededResult.code, "request_not_unanswered");
  assert.equal(mismatchedResult.code, "request_ref_mismatch");
  assert.equal(nonDurableResult.code, "session_persistence_unavailable");
  assert.equal(h.session.coopConversationIngress.pendingOwnerResponse, undefined);
  assert.equal(h.saveCount(), 0);
});

test("a request superseded after staging stays superseded while its exact peer is answered", function () {
  var h = harness();
  var first = recordRequest(h.ledger, 292, 20);
  var second = recordRequest(h.ledger, 295, 40);
  responseLinkage.stageOwnerResponse({
    session: h.session, ownerRequests: h.ledger, requests: [first, second], saveSession: h.save,
  });
  h.ledger.supersede(first.ingressId, "owner_repeat");
  h.session.history.push({ type: "delta_replace", text: "Exact later answer." });
  h.session.history.push({ type: "done", code: 0, _ts: 100 });

  var finalized = responseLinkage.finalizeOwnerResponse({
    session: h.session,
    ownerRequests: h.ledger,
    responseEvent: { answered: true, eventIndex: 2 },
    saveSession: h.save,
  });

  assert.deepEqual(finalized, { ok: true, answered: 1, preserved: 1 });
  assert.equal(h.ledger.get(first.ingressId).response.state, "superseded");
  assert.equal(h.ledger.get(second.ingressId).response.state, "answered");
});

test("restart replay is idempotent and byte-stable after linked finalization", function () {
  var h = harness();
  var first = recordRequest(h.ledger, 292, 20);
  var second = recordRequest(h.ledger, 295, 40);
  responseLinkage.stageOwnerResponse({
    session: h.session, ownerRequests: h.ledger, requests: [first, second], saveSession: h.save,
  });
  h.session.history.push({ type: "delta_replace", text: "Exact answer." });
  h.session.history.push({ type: "done", code: 0, _ts: 100 });

  var restored = JSON.parse(JSON.stringify(h.session));
  var reloaded = ownerRequests.attachCoopOwnerRequests({ file: h.file, now: function () { return 100; } });
  responseLinkage.finalizeOwnerResponse({
    session: restored,
    ownerRequests: reloaded,
    responseEvent: { answered: true, eventIndex: 2 },
    saveSession: function () {},
  });
  var firstBytes = fs.readFileSync(h.file, "utf8");
  var replay = responseLinkage.finalizeOwnerResponse({
    session: restored,
    ownerRequests: reloaded,
    responseEvent: { answered: true, eventIndex: 2 },
    saveSession: function () {},
  });

  assert.equal(replay.code, "no_pending_response");
  assert.equal(fs.readFileSync(h.file, "utf8"), firstBytes);
  assert.equal(reloaded.get(first.ingressId).response.state, "answered");
  assert.equal(reloaded.get(second.ingressId).response.state, "answered");
});

var ANSWER_UUID = "8f2c0f1e-6d3b-4a17-9c22-0b7e5d41aa93";

test("a linked answer stamps every settled request with the answering event's anchor", function () {
  var h = harness();
  var first = recordRequest(h.ledger, 292, 20);
  var second = recordRequest(h.ledger, 295, 40);
  responseLinkage.stageOwnerResponse({
    session: h.session, ownerRequests: h.ledger, requests: [first, second], saveSession: h.save,
  });
  h.session.history.push({ type: "message_uuid", uuid: ANSWER_UUID, messageType: "assistant" });
  h.session.history.push({ type: "delta_replace", text: "Answered both." });
  h.session.history.push({ type: "done", code: 0, _ts: 100 });

  var finalized = responseLinkage.finalizeOwnerResponse({
    session: h.session,
    ownerRequests: h.ledger,
    responseEvent: { answered: true, eventIndex: 3 },
    saveSession: h.save,
  });

  assert.equal(finalized.ok, true);
  assert.deepEqual(h.ledger.get(first.ingressId).response.responseRef, {
    projectId: LEAD, sessionStorageId: COOP, eventIndex: 3, messageUuid: ANSWER_UUID,
  });
  assert.deepEqual(h.ledger.get(second.ingressId).response.responseRef,
    h.ledger.get(first.ingressId).response.responseRef,
    "one answering event means one anchor for every request it settled");
});

test("the foreground turn stamps the anchor and survives the index drifting under it", function () {
  var h = harness();
  var ingressId = "coop:" + COOP + ":301";
  h.session.history = [{ type: "user_message", text: "how is the fleet?",
    coopIngressId: ingressId, _ts: 10 }];
  h.session.coopConversationIngress = {
    nextSequence: 302, recent: [], activeIngressId: ingressId, activeResponseStartIndex: 1,
  };
  h.ledger.record({
    ingressId: ingressId,
    ingressSequence: 301,
    sessionRef: { projectId: LEAD, sessionStorageId: COOP },
    requestRef: { projectId: LEAD, sessionStorageId: COOP, eventIndex: 0 },
  });
  var answering = { type: "done", code: 0, _ts: 100 };
  h.session.history.push({ type: "message_uuid", uuid: ANSWER_UUID, messageType: "assistant" });
  h.session.history.push({ type: "delta", text: "The fleet " });
  h.session.history.push({ type: "delta", text: "is fine." });
  h.session.history.push(answering);

  var controller = conversationControl.attachCoopConversationControl({
    coopOwnerRequests: h.ledger,
    sm: { saveSessionFile: h.save },
    sendToSession: function () {},
  });
  assert.equal(controller.markAnswered(h.session), true);

  var stored = h.ledger.get(ingressId).response.responseRef;
  assert.equal(stored.eventIndex, 4);
  assert.equal(stored.messageUuid, ANSWER_UUID);

  // Reload rebases session.history onto the coalesced transcript: the two
  // consecutive deltas were written as one line, so every later index moved
  // down by one. The stored index now names the wrong event; the anchor does
  // not move.
  var coalesced = [
    { type: "user_message", text: "how is the fleet?", coopIngressId: ingressId, _ts: 10 },
    { type: "message_uuid", uuid: ANSWER_UUID, messageType: "assistant" },
    { type: "delta", text: "The fleet is fine." },
    answering,
  ];
  assert.notEqual(coalesced[stored.eventIndex], answering,
    "the stored index no longer lands on the answering event");
  assert.equal(responseResolution.resolveDoneByAnchor(coalesced, stored.messageUuid), 3);
  assert.equal(coalesced[3], answering);
});

test("an answering event with no anchor is recorded exactly as it was before", function () {
  var h = harness();
  var first = recordRequest(h.ledger, 292, 20);
  responseLinkage.stageOwnerResponse({
    session: h.session, ownerRequests: h.ledger, requests: [first], saveSession: h.save,
  });
  h.session.history.push({ type: "delta_replace", text: "No uuid was emitted." });
  h.session.history.push({ type: "done", code: 0, _ts: 100 });

  var finalized = responseLinkage.finalizeOwnerResponse({
    session: h.session,
    ownerRequests: h.ledger,
    responseEvent: { answered: true, eventIndex: 2 },
    saveSession: h.save,
  });

  assert.equal(finalized.ok, true);
  assert.deepEqual(h.ledger.get(first.ingressId).response.responseRef,
    { projectId: LEAD, sessionStorageId: COOP, eventIndex: 2 });
  assert.equal(Object.prototype.hasOwnProperty.call(
    h.ledger.get(first.ingressId).response.responseRef, "messageUuid"), false,
    "an absent anchor is omitted, not stored empty");
});

test("a record written without an anchor round-trips byte-identically", function () {
  var h = harness();
  var first = recordRequest(h.ledger, 292, 20);
  h.ledger.markAnswered(first.ingressId, { eventIndex: 2, at: 95 });
  var beforeBytes = fs.readFileSync(h.file, "utf8");

  var reloaded = ownerRequests.attachCoopOwnerRequests({
    file: h.file, now: function () { return 100; },
  });
  var record = reloaded.get(first.ingressId);
  assert.deepEqual(record.response.responseRef,
    { projectId: LEAD, sessionStorageId: COOP, eventIndex: 2 });

  reloaded.record({
    ingressId: first.ingressId,
    sessionRef: { projectId: LEAD, sessionStorageId: COOP },
  });
  assert.equal(fs.readFileSync(h.file, "utf8"), beforeBytes,
    "an anchorless record must not gain a field on reload");
});

test("an anchor survives reload and an unusable one never invalidates the ref", function () {
  var h = harness();
  var good = recordRequest(h.ledger, 292, 20);
  var bad = recordRequest(h.ledger, 293, 21);
  var overlong = recordRequest(h.ledger, 294, 22);
  h.ledger.markAnswered(good.ingressId, { eventIndex: 2, at: 95, messageUuid: ANSWER_UUID });
  h.ledger.markAnswered(bad.ingressId, { eventIndex: 3, at: 95, messageUuid: "not a uuid" });
  h.ledger.markAnswered(overlong.ingressId,
    { eventIndex: 4, at: 95, messageUuid: new Array(200).join("a") });

  var reloaded = ownerRequests.attachCoopOwnerRequests({
    file: h.file, now: function () { return 100; },
  });
  assert.equal(reloaded.get(good.ingressId).response.responseRef.messageUuid, ANSWER_UUID);
  assert.deepEqual(reloaded.get(bad.ingressId).response.responseRef,
    { projectId: LEAD, sessionStorageId: COOP, eventIndex: 3 },
    "prose is refused as an anchor but the ref itself stays valid");
  assert.deepEqual(reloaded.get(overlong.ingressId).response.responseRef,
    { projectId: LEAD, sessionStorageId: COOP, eventIndex: 4 });
});
