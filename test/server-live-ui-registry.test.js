var test = require("node:test");
var assert = require("node:assert");
var createLiveUiRegistry =
  require("../lib/server-live-ui-registry").createLiveUiRegistry;

function fixture() {
  var timestamp = 1000;
  var sequence = 0;
  var registry = createLiveUiRegistry({
    now: function () { return timestamp; },
    random: function () {
      sequence += 1;
      return "secret-" + sequence;
    },
    serverInstanceId: "server-a",
    idleMs: 1000,
    reconnectMs: 30,
    dedupeLimit: 2
  });
  return {
    registry: registry,
    advance: function (milliseconds) { timestamp += milliseconds; }
  };
}

function pairingInput(overrides) {
  return Object.assign({
    userId: "user-a",
    projectSlug: "clay",
    sessionId: "session-a",
    writableRoot: "/repo/clay",
    extensionInstanceId: "extension-a",
    controlClientId: "control-a",
    targetTabId: 42,
    allowedOrigin: "http://localhost:4242"
  }, overrides || {});
}

function proveInput(created, overrides) {
  return Object.assign({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    targetTabId: 42,
    allowedOrigin: "http://localhost:4242",
    nonce: created.nonce
  }, overrides || {});
}

test("creates and proves a server-authoritative pairing", function () {
  var state = fixture();
  var created = state.registry.create(pairingInput());
  assert.strictEqual(created.pairing.serverInstanceId, "server-a");
  assert.strictEqual(created.pairing.state, "pairing");
  assert.strictEqual(created.pairing.projectSlug, "clay");
  assert.strictEqual(created.pairing.nonceHash, undefined);

  var paired = state.registry.prove(proveInput(created));
  assert.strictEqual(paired.state, "paired");
  assert.strictEqual(paired.controlClientId, "control-a");
  assert.throws(function () {
    state.registry.prove(proveInput(created));
  }, { code: "LIVE_UI_INVALID_STATE" });
});

test("rejects remote origins and prevents implicit target takeover", function () {
  var state = fixture();
  assert.throws(function () {
    state.registry.create(pairingInput({
      allowedOrigin: "https://example.com"
    }));
  }, { code: "LIVE_UI_ORIGIN_DENIED" });

  var first = state.registry.create(pairingInput());
  assert.throws(function () {
    state.registry.create(pairingInput({ sessionId: "session-b" }));
  }, { code: "LIVE_UI_TARGET_BUSY" });
  var second = state.registry.create(pairingInput({
    sessionId: "session-b",
    takeover: true
  }));
  assert.strictEqual(state.registry.get(first.pairing.pairingId).state, "revoked");
  assert.strictEqual(second.pairing.sessionId, "session-b");
});

test("identity mismatch revokes instead of leaking across users or extensions", function () {
  var state = fixture();
  var created = state.registry.create(pairingInput());
  assert.throws(function () {
    state.registry.prove(proveInput(created, { userId: "user-b" }));
  }, { code: "LIVE_UI_IDENTITY_MISMATCH" });
  assert.strictEqual(state.registry.get(created.pairing.pairingId).state, "revoked");

  var other = state.registry.create(pairingInput({ targetTabId: 43 }));
  assert.throws(function () {
    state.registry.prove(proveInput(other, {
      targetTabId: 43,
      extensionInstanceId: "extension-b"
    }));
  }, { code: "LIVE_UI_IDENTITY_MISMATCH" });
});

test("control reconnect requires and rotates its credential", function () {
  var state = fixture();
  var created = state.registry.create(pairingInput());
  state.registry.prove(proveInput(created));
  var disconnected = state.registry.disconnect({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    actor: "control"
  });
  assert.strictEqual(disconnected.state, "reconnecting");

  var reconnected = state.registry.reconnect({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    actor: "control",
    controlClientId: "control-b",
    controlReconnectToken: created.controlReconnectToken
  });
  assert.strictEqual(reconnected.pairing.controlClientId, "control-b");
  assert.notStrictEqual(reconnected.controlReconnectToken,
    created.controlReconnectToken);
});

test("target reconnect checks tab and origin and expires after grace", function () {
  var state = fixture();
  var created = state.registry.create(pairingInput());
  state.registry.prove(proveInput(created));
  state.registry.disconnect({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    actor: "target"
  });
  state.advance(31);
  assert.throws(function () {
    state.registry.reconnect({
      pairingId: created.pairing.pairingId,
      userId: "user-a",
      extensionInstanceId: "extension-a",
      actor: "target",
      targetTabId: 42,
      allowedOrigin: "http://localhost:4242"
    });
  }, { code: "LIVE_UI_REVOKED" });
});

test("target reload does not rotate the control reconnect credential", function () {
  var state = fixture();
  var created = state.registry.create(pairingInput());
  state.registry.prove(proveInput(created));
  state.registry.disconnect({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    actor: "target"
  });
  var target = state.registry.reconnect({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    actor: "target",
    targetTabId: 42,
    allowedOrigin: "http://localhost:4242"
  });
  assert.strictEqual(target.controlReconnectToken, undefined);

  state.registry.disconnect({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    actor: "control"
  });
  var control = state.registry.reconnect({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    actor: "control",
    controlClientId: "control-b",
    controlReconnectToken: created.controlReconnectToken
  });
  assert.strictEqual(control.pairing.state, "paired");
});

test("dedupe returns the original acknowledgment and remains bounded", function () {
  var state = fixture();
  var created = state.registry.create(pairingInput());
  state.registry.prove(proveInput(created));
  var calls = 0;
  function submit(messageId) {
    return state.registry.dedupe({
      pairingId: created.pairing.pairingId,
      userId: "user-a",
      extensionInstanceId: "extension-a",
      clientMessageId: messageId
    }, function () {
      calls += 1;
      return { accepted: calls };
    });
  }

  assert.deepStrictEqual(submit("one"),
    { duplicate: false, acknowledgment: { accepted: 1 } });
  assert.deepStrictEqual(submit("one"),
    { duplicate: true, acknowledgment: { accepted: 1 } });
  submit("two");
  submit("three");
  assert.strictEqual(submit("one").duplicate, false);
  assert.strictEqual(calls, 4);
});

test("explicit revoke and user disconnect terminate a pairing", function () {
  var state = fixture();
  var created = state.registry.create(pairingInput());
  state.registry.prove(proveInput(created));
  var revoked = state.registry.revoke({
    pairingId: created.pairing.pairingId,
    userId: "user-a",
    reason: "session_deleted"
  });
  assert.strictEqual(revoked.state, "revoked");
  assert.strictEqual(revoked.revokeReason, "session_deleted");

  var other = state.registry.create(pairingInput({ targetTabId: 44 }));
  state.registry.prove(proveInput(other, { targetTabId: 44 }));
  var disconnected = state.registry.disconnect({
    pairingId: other.pairing.pairingId,
    userId: "user-a",
    extensionInstanceId: "extension-a",
    actor: "user"
  });
  assert.strictEqual(disconnected.state, "revoked");
  assert.strictEqual(disconnected.revokeReason, "user_disconnect");
});

test("integration API accepts messages once and disconnects its control owner", function () {
  var state = fixture();
  var created = state.registry.createPair(pairingInput({
    extensionOwnerKey: "extension-owner",
    controlOwnerKey: "control-owner"
  }));
  state.registry.provePair(proveInput(created));
  var first = state.registry.acceptMessage(
    created.pairing.pairingId, "message-a", function () {
      return { queued: true };
    });
  var retry = state.registry.acceptMessage(
    created.pairing.pairingId, "message-a", function () {
      throw new Error("retry must not enqueue");
    });
  assert.strictEqual(first.duplicate, false);
  assert.deepStrictEqual(retry,
    { duplicate: true, acknowledgment: { queued: true } });
  assert.strictEqual(state.registry.getPair(
    created.pairing.pairingId).controlOwnerKey, "control-owner");

  var disconnected = state.registry.disconnectClient("control-a");
  assert.strictEqual(disconnected.length, 1);
  assert.strictEqual(disconnected[0].state, "reconnecting");
});
