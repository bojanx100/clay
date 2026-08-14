// Reference-only owner-request moves that accompany Coop Thread corrections.

var records = require("./coop-owner-request-records");
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;

var clone = records.clone;
var pushUnique = records.pushUnique;
var sessionKey = records.sessionKey;

function snapshot(seam, from, to, kind) {
  var state = seam.state;
  var ids = {};
  ids[from.topicId] = true;
  ids[to.topicId] = true;
  return {
    kind: kind,
    fromTopicRef: clone(from),
    toTopicRef: clone(to),
    requests: state.requests.filter(function (entry) {
      return entry.topicRef && ids[entry.topicRef.topicId];
    }).map(function (entry) {
      return { ingressId: entry.ingressId, topicRef: clone(entry.topicRef),
        coordinatorLinks: clone(entry.links && entry.links.coordinators || []) };
    }),
    coordinators: state.coordinators.filter(function (claim) {
      return ids[claim.topicId];
    }).map(clone),
    restoreCoordinators: kind === "merge",
  };
}

function finishSnapshot(seam, correction) {
  var state = seam.state;
  var from = correction.fromTopicRef;
  var to = correction.toTopicRef;
  correction.requests.forEach(function (item) {
    var current = seam.find(item.ingressId);
    item.afterTopicRef = current ? clone(current.topicRef) : null;
    item.afterCoordinatorLinks = current
      ? clone(current.links && current.links.coordinators || []) : [];
  });
  correction.requests = correction.requests.filter(function (item) {
    var beforeTopic = item.topicRef && item.topicRef.topicId || "";
    var afterTopic = item.afterTopicRef && item.afterTopicRef.topicId || "";
    return beforeTopic !== afterTopic || JSON.stringify(item.coordinatorLinks || []) !==
      JSON.stringify(item.afterCoordinatorLinks || []);
  });
  correction.afterCoordinators = state.coordinators.filter(function (claim) {
    return claim.topicId === from.topicId || claim.topicId === to.topicId;
  }).map(clone);
  return correction;
}

function retopicTurn(seam, fromTopicRef, toTopicRef, turnRef) {
  var state = seam.state;
  var from = normalizeTopicRef(fromTopicRef);
  var to = normalizeTopicRef(toTopicRef);
  var turn = turnRef && typeof turnRef === "object" ? turnRef : {};
  if (!from || !to || from.topicId === to.topicId || !turn.sessionStorageId ||
      !Number.isInteger(turn.startEventIndex) || !Number.isInteger(turn.endEventIndex)) {
    return { ok: false, reason: "invalid_turn", requests: 0 };
  }
  var matched = [];
  for (var i = 0; i < state.requests.length; i++) {
    var entry = state.requests[i];
    var ref = entry.requestRef;
    if (!entry.topicRef || entry.topicRef.topicId !== from.topicId || !ref ||
        ref.sessionStorageId !== turn.sessionStorageId ||
        ref.eventIndex < turn.startEventIndex || ref.eventIndex > turn.endEventIndex) continue;
    var links = entry.links || {};
    if (entry.expectsExecution || (links.tasks || []).length || (links.sessions || []).length ||
        (links.coordinators || []).length) {
      return { ok: false, reason: "execution_already_admitted", requests: 0 };
    }
    matched.push(entry);
  }
  var correction = {
    kind: "reassign",
    fromTopicRef: clone(from),
    toTopicRef: clone(to),
    turnRef: clone(turn),
    requests: matched.map(function (entry) {
      return { ingressId: entry.ingressId, topicRef: clone(entry.topicRef),
        afterTopicRef: clone(to), coordinatorLinks: [], afterCoordinatorLinks: [] };
    }),
    coordinators: [],
    restoreCoordinators: false,
  };
  for (var mi = 0; mi < matched.length; mi++) {
    matched[mi].topicRef = clone(to);
    matched[mi].updatedAt = seam.now();
  }
  if (matched.length && !seam.persist()) {
    for (var ri = 0; ri < correction.requests.length; ri++) {
      var original = seam.find(correction.requests[ri].ingressId);
      if (original) original.topicRef = clone(correction.requests[ri].topicRef);
    }
    return { ok: false, reason: "persistence_failed", requests: 0 };
  }
  return { ok: true, requests: matched.length, undo: correction };
}

function claimKey(claim) {
  return String(claim.topicId || "") + ":" + String(claim.projectId || "") +
    ":" + sessionKey(claim.coordinator);
}

function restoreRequest(seam, snapshot) {
  var request = seam.find(snapshot.ingressId);
  if (!request) return false;
  if (!snapshot.afterTopicRef || !request.topicRef ||
      request.topicRef.topicId === snapshot.afterTopicRef.topicId) {
    request.topicRef = clone(snapshot.topicRef);
  }
  var beforeLinks = snapshot.coordinatorLinks || [];
  var afterLinks = snapshot.afterCoordinatorLinks || [];
  var currentLinks = request.links && request.links.coordinators || [];
  var beforeKeys = {};
  var afterKeys = {};
  beforeLinks.forEach(function (ref) { beforeKeys[sessionKey(ref)] = true; });
  afterLinks.forEach(function (ref) { afterKeys[sessionKey(ref)] = true; });
  currentLinks = currentLinks.filter(function (ref) {
    var key = sessionKey(ref);
    return beforeKeys[key] || !afterKeys[key];
  });
  beforeLinks.forEach(function (ref) {
    if (!afterKeys[sessionKey(ref)]) pushUnique(currentLinks, clone(ref), sessionKey);
  });
  request.links.coordinators = currentLinks;
  request.updatedAt = seam.now();
  return true;
}

function restoreClaims(state, correction) {
  var before = correction.coordinators || [];
  var after = correction.afterCoordinators || [];
  var beforeKeys = {};
  var afterKeys = {};
  before.forEach(function (claim) { beforeKeys[claimKey(claim)] = true; });
  after.forEach(function (claim) { afterKeys[claimKey(claim)] = true; });
  state.coordinators = state.coordinators.filter(function (claim) {
    var key = claimKey(claim);
    return beforeKeys[key] || !afterKeys[key];
  });
  var current = {};
  state.coordinators.forEach(function (claim) { current[claimKey(claim)] = true; });
  before.forEach(function (claim) {
    var key = claimKey(claim);
    if (!afterKeys[key] && !current[key]) {
      state.coordinators.push(clone(claim));
      current[key] = true;
    }
  });
}

function restore(seam, corrections) {
  var state = seam.state;
  var list = Array.isArray(corrections) ? corrections : [];
  if (!list.length) return { ok: true, requests: 0 };
  var requestsBefore = state.requests.map(clone);
  var coordinatorsBefore = state.coordinators.map(clone);
  var restored = 0;
  for (var ci = list.length - 1; ci >= 0; ci--) {
    var correction = list[ci] || {};
    var snapshots = Array.isArray(correction.requests) ? correction.requests : [];
    for (var si = 0; si < snapshots.length; si++) {
      if (!restoreRequest(seam, snapshots[si])) {
        state.requests = requestsBefore;
        state.coordinators = coordinatorsBefore;
        seam.reindex();
        return { ok: false, reason: "request_not_found", requests: 0 };
      }
      restored++;
    }
    if (correction.restoreCoordinators) restoreClaims(state, correction);
  }
  if (!seam.persist()) {
    state.requests = requestsBefore;
    state.coordinators = coordinatorsBefore;
    seam.reindex();
    return { ok: false, reason: "persistence_failed", requests: 0 };
  }
  seam.reindex();
  return { ok: true, requests: restored };
}

module.exports = {
  snapshot: snapshot,
  finishSnapshot: finishSnapshot,
  retopicTurn: retopicTurn,
  restore: restore,
};
