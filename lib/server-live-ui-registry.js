"use strict";

var crypto = require("crypto");

var DEFAULT_IDLE_MS = 8 * 60 * 60 * 1000;
var DEFAULT_RECONNECT_MS = 30 * 1000;
var DEFAULT_DEDUPE_LIMIT = 256;

function fail(code, message) {
  var error = new Error(message);
  error.code = code;
  throw error;
}

function required(value, name) {
  if (value === undefined || value === null || value === "") {
    fail("LIVE_UI_INVALID", name + " is required");
  }
  return value;
}

function secretHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest();
}

function secretMatches(value, expected) {
  var actual = secretHash(value);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isLoopbackOrigin(origin) {
  try {
    var parsed = new URL(origin);
    var host = parsed.hostname.toLowerCase();
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (host === "localhost" || host === "127.0.0.1" || host === "::1") &&
      parsed.origin === origin;
  } catch (error) {
    return false;
  }
}

function publicPairing(record) {
  return {
    pairingId: record.pairingId,
    userId: record.userId,
    serverInstanceId: record.serverInstanceId,
    projectSlug: record.projectSlug,
    sessionId: record.sessionId,
    writableRoot: record.writableRoot,
    extensionInstanceId: record.extensionInstanceId,
    extensionOwnerKey: record.extensionOwnerKey,
    controlClientId: record.controlClientId,
    controlOwnerKey: record.controlOwnerKey,
    targetTabId: record.targetTabId,
    allowedOrigin: record.allowedOrigin,
    state: record.state,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
    reconnectExpiresAt: record.reconnectExpiresAt || null,
    disconnectActor: record.disconnectActor || null,
    revokeReason: record.revokeReason || null
  };
}

function createLiveUiRegistry(options) {
  options = options || {};
  var now = options.now || Date.now;
  var random = options.random || function () {
    return crypto.randomBytes(32).toString("base64url");
  };
  var idleMs = options.idleMs || DEFAULT_IDLE_MS;
  var reconnectMs = options.reconnectMs || DEFAULT_RECONNECT_MS;
  var dedupeLimit = options.dedupeLimit || DEFAULT_DEDUPE_LIMIT;
  var serverInstanceId = options.serverInstanceId || random();
  var pairings = new Map();

  function getRecord(pairingId, includeRevoked) {
    var record = pairings.get(pairingId);
    if (!record) fail("LIVE_UI_NOT_FOUND", "Live UI pairing was not found");
    var timestamp = now();
    if (record.state !== "revoked" && timestamp > record.expiresAt) {
      revokeRecord(record, "expired", timestamp);
    }
    if (record.state === "reconnecting" &&
        timestamp > record.reconnectExpiresAt) {
      revokeRecord(record, "reconnect_timeout", timestamp);
    }
    if (!includeRevoked && record.state === "revoked") {
      fail("LIVE_UI_REVOKED", "Live UI pairing is revoked");
    }
    return record;
  }

  function revokeRecord(record, reason, timestamp) {
    record.state = "revoked";
    record.revokeReason = reason || "explicit";
    record.revokedAt = timestamp;
    record.reconnectExpiresAt = null;
    record.nonceHash = null;
    record.controlReconnectTokenHash = null;
    record.dedupe.clear();
    return publicPairing(record);
  }

  function assertIdentity(record, input, fields) {
    fields.forEach(function (field) {
      required(input[field], field);
      if (String(input[field]) !== String(record[field])) {
        revokeRecord(record, "identity_mismatch", now());
        fail("LIVE_UI_IDENTITY_MISMATCH", field + " does not match the pairing");
      }
    });
  }

  function touch(record) {
    record.lastSeenAt = now();
    record.expiresAt = record.lastSeenAt + idleMs;
  }

  function create(input) {
    input = input || {};
    input.extensionInstanceId =
      input.extensionInstanceId || input.extensionOwnerKey;
    input.controlClientId = input.controlClientId || input.controlOwnerKey;
    var fields = [
      "userId", "projectSlug", "sessionId", "writableRoot",
      "extensionInstanceId", "controlClientId", "targetTabId", "allowedOrigin"
    ];
    fields.forEach(function (field) { required(input[field], field); });
    if (!isLoopbackOrigin(input.allowedOrigin)) {
      fail("LIVE_UI_ORIGIN_DENIED", "Live UI 0.1 requires an exact loopback origin");
    }

    pairings.forEach(function (record) {
      var sameTarget = record.state !== "revoked" &&
        record.extensionInstanceId === input.extensionInstanceId &&
        String(record.targetTabId) === String(input.targetTabId);
      if (!sameTarget) return;
      if (!input.takeover) {
        fail("LIVE_UI_TARGET_BUSY", "The target tab already has a pairing");
      }
      revokeRecord(record, "takeover", now());
    });

    var timestamp = now();
    var nonce = random();
    var reconnectToken = random();
    var pairingId = random();
    var record = {
      pairingId: pairingId,
      userId: input.userId,
      serverInstanceId: serverInstanceId,
      projectSlug: input.projectSlug,
      sessionId: input.sessionId,
      writableRoot: input.writableRoot,
      extensionInstanceId: input.extensionInstanceId,
      extensionOwnerKey: input.extensionOwnerKey || input.extensionInstanceId,
      controlClientId: input.controlClientId,
      controlOwnerKey: input.controlOwnerKey || input.controlClientId,
      targetTabId: input.targetTabId,
      allowedOrigin: input.allowedOrigin,
      state: "pairing",
      createdAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: timestamp + idleMs,
      nonceHash: secretHash(nonce),
      controlReconnectTokenHash: secretHash(reconnectToken),
      reconnectExpiresAt: null,
      disconnectActor: null,
      revokeReason: null,
      dedupe: new Map()
    };
    pairings.set(pairingId, record);
    return {
      pairing: publicPairing(record),
      nonce: nonce,
      controlReconnectToken: reconnectToken
    };
  }

  function prove(input) {
    input = input || {};
    var record = getRecord(required(input.pairingId, "pairingId"));
    if (record.state !== "pairing") {
      fail("LIVE_UI_INVALID_STATE", "Only a pending pairing can be proved");
    }
    assertIdentity(record, input, [
      "userId", "extensionInstanceId", "targetTabId", "allowedOrigin"
    ]);
    if (!input.nonce || !record.nonceHash ||
        !secretMatches(input.nonce, record.nonceHash)) {
      revokeRecord(record, "invalid_nonce", now());
      fail("LIVE_UI_INVALID_PROOF", "The pairing proof is invalid");
    }
    record.nonceHash = null;
    record.state = "paired";
    touch(record);
    return publicPairing(record);
  }

  function reconnect(input) {
    input = input || {};
    var record = getRecord(required(input.pairingId, "pairingId"));
    if (record.state !== "reconnecting") {
      fail("LIVE_UI_INVALID_STATE", "The pairing is not reconnecting");
    }
    var actor = required(input.actor, "actor");
    if (actor !== record.disconnectActor) {
      fail("LIVE_UI_WRONG_ACTOR", "The disconnected endpoint must reconnect");
    }
    assertIdentity(record, input, ["userId", "extensionInstanceId"]);
    if (actor === "target") {
      assertIdentity(record, input, ["targetTabId", "allowedOrigin"]);
    } else if (actor === "control") {
      if (!input.controlReconnectToken ||
          !record.controlReconnectTokenHash ||
          !secretMatches(input.controlReconnectToken,
            record.controlReconnectTokenHash)) {
        revokeRecord(record, "invalid_reconnect_token", now());
        fail("LIVE_UI_INVALID_RECONNECT", "The reconnect credential is invalid");
      }
      record.controlClientId = required(input.controlClientId, "controlClientId");
      record.controlOwnerKey = input.controlOwnerKey || record.controlClientId;
    } else {
      fail("LIVE_UI_INVALID", "actor must be target or control");
    }
    var rotatedToken = null;
    if (actor === "control") {
      rotatedToken = random();
      record.controlReconnectTokenHash = secretHash(rotatedToken);
    }
    record.state = "paired";
    record.reconnectExpiresAt = null;
    record.disconnectActor = null;
    touch(record);
    var result = { pairing: publicPairing(record) };
    if (rotatedToken) result.controlReconnectToken = rotatedToken;
    return result;
  }

  function dedupe(input, createAcknowledgement) {
    input = input || {};
    var record = getRecord(required(input.pairingId, "pairingId"));
    if (record.state !== "paired") {
      fail("LIVE_UI_INVALID_STATE", "Messages require a paired target");
    }
    assertIdentity(record, input, ["userId", "extensionInstanceId"]);
    var messageId = required(input.clientMessageId, "clientMessageId");
    if (record.dedupe.has(messageId)) {
      touch(record);
      return { duplicate: true, acknowledgment: record.dedupe.get(messageId) };
    }
    if (typeof createAcknowledgement !== "function") {
      fail("LIVE_UI_INVALID", "createAcknowledgement must be a function");
    }
    var acknowledgment = createAcknowledgement();
    record.dedupe.set(messageId, acknowledgment);
    while (record.dedupe.size > dedupeLimit) {
      record.dedupe.delete(record.dedupe.keys().next().value);
    }
    touch(record);
    return { duplicate: false, acknowledgment: acknowledgment };
  }

  function disconnect(input) {
    input = input || {};
    var record = getRecord(required(input.pairingId, "pairingId"));
    assertIdentity(record, input, ["userId", "extensionInstanceId"]);
    var actor = required(input.actor, "actor");
    if (actor === "user" || actor === "extension") {
      return revokeRecord(record, actor + "_disconnect", now());
    }
    if (actor !== "target" && actor !== "control") {
      fail("LIVE_UI_INVALID", "actor must be target, control, extension, or user");
    }
    record.state = "reconnecting";
    record.disconnectActor = actor;
    record.reconnectExpiresAt = now() + reconnectMs;
    record.lastSeenAt = now();
    return publicPairing(record);
  }

  function revoke(input) {
    input = input || {};
    var record = getRecord(required(input.pairingId, "pairingId"));
    assertIdentity(record, input, ["userId"]);
    return revokeRecord(record, input.reason || "explicit", now());
  }

  function get(pairingId) {
    return publicPairing(getRecord(pairingId, true));
  }

  function acceptMessage(pairingId, clientMessageId, createAcknowledgement) {
    var record = getRecord(pairingId);
    return dedupe({
      pairingId: pairingId,
      userId: record.userId,
      extensionInstanceId: record.extensionInstanceId,
      clientMessageId: clientMessageId
    }, createAcknowledgement || function () {
      return {
        pairingId: pairingId,
        clientMessageId: clientMessageId,
        accepted: true
      };
    });
  }

  function revokePair(pairingId, reason) {
    return revokeRecord(getRecord(pairingId), reason || "explicit", now());
  }

  function disconnectClient(identity) {
    var match = typeof identity === "string" ?
      { controlClientId: identity } : (identity || {});
    var disconnected = [];
    pairings.forEach(function (record) {
      if (record.state === "revoked") return;
      var controlMatches = match.controlClientId &&
        record.controlClientId === match.controlClientId;
      var extensionMatches = match.extensionInstanceId &&
        record.extensionInstanceId === match.extensionInstanceId;
      if (!controlMatches && !extensionMatches) return;
      if (match.userId && record.userId !== match.userId) return;
      if (extensionMatches) {
        disconnected.push(revokeRecord(record, "extension_disconnect", now()));
        return;
      }
      record.state = "reconnecting";
      record.disconnectActor = "control";
      record.reconnectExpiresAt = now() + reconnectMs;
      record.lastSeenAt = now();
      disconnected.push(publicPairing(record));
    });
    return disconnected;
  }

  return {
    serverInstanceId: serverInstanceId,
    createPair: create,
    provePair: prove,
    reconnectPair: reconnect,
    acceptMessage: acceptMessage,
    getPair: get,
    revokePair: revokePair,
    disconnectClient: disconnectClient,
    create: create,
    prove: prove,
    reconnect: reconnect,
    dedupe: dedupe,
    disconnect: disconnect,
    revoke: revoke,
    get: get
  };
}

module.exports = {
  createLiveUiRegistry: createLiveUiRegistry
};
