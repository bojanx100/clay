// Owner-facing projection of the execution flow: what the owner asked, which
// topic it became, which projects it reaches, which coordinator owns each of
// them, and which workers those coordinators are running.
//
// Pure over plain data so the shape is testable without a daemon. The joins are
// the whole point:
//
//   owner request --(topicRef)--> topic --(projectRef)--> coordinator --> workers
//
// Two rules the rest of the stack keeps getting wrong and this module enforces:
//
//   * A hidden or terminal session is NOT working. Counting one as working is
//     how a finished topic kept a spinner alive forever.
//   * Answered is not derived from work. The unanswered list comes straight off
//     the owner-request ledger's response state, never from session activity.

var projectIdentity = require("./project-identity");
var normalizeTopicRef = require("./coop-topic-ref").normalizeTopicRefInput;

// The states a session may contribute to a topic's live work counts. Anything
// terminal, hidden or absent contributes nothing.
var LIVE_WORK_STATES = { working: true, needs_input: true };

function cleanText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, limit || 240);
}

// A session counts as live evidence only when it is actually there. A hidden
// session was dismissed, a missing one is gone, and a terminal one is finished
// -- none of them is somebody still working on the owner's request.
function isLiveSession(entry) {
  if (!entry || !entry.sessionPresent || entry.hidden) return false;
  return !!LIVE_WORK_STATES[entry.workState];
}

function sessionSummary(entry) {
  return {
    sessionRef: entry.sessionRef,
    title: cleanText(entry.title, 240),
    role: entry.role || "",
    workState: entry.workState || "idle",
    lifecycleState: entry.lifecycleState || "",
    hidden: !!entry.hidden,
    present: !!entry.sessionPresent,
    live: isLiveSession(entry),
  };
}

function sessionKey(ref) {
  return String(ref && ref.projectId) + ":" + String(ref && ref.sessionStorageId);
}

function indexSessions(sessions) {
  var list = Array.isArray(sessions) ? sessions : [];
  var byKey = {};
  var childrenByParent = {};
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.sessionRef) continue;
    byKey[sessionKey(entry.sessionRef)] = entry;
    var parent = entry.parentSessionRef;
    if (!parent) continue;
    var parentKey = sessionKey(parent);
    if (!childrenByParent[parentKey]) childrenByParent[parentKey] = [];
    childrenByParent[parentKey].push(entry);
  }
  return { byKey: byKey, childrenByParent: childrenByParent };
}

function topicMetadata(topics, topicId) {
  var source = topics && typeof topics === "object" ? topics : {};
  var topic = source[topicId];
  if (!topic) return { title: "", status: "" };
  return {
    title: cleanText(topic.title, 160),
    status: cleanText(topic.status, 40),
  };
}

// One owner request, reduced to what the owner-facing surface needs. The
// request body is deliberately absent: the ledger is reference-only and the
// canonical transcript stays the single source of what was said.
function requestSummary(record, topics) {
  var topicId = record.topicRef && record.topicRef.topicId || "";
  return {
    ingressId: record.ingressId,
    ingressSequence: record.ingressSequence,
    ingressKind: record.ingressKind,
    receivedAt: record.receivedAt,
    requestRef: record.requestRef,
    topicRef: record.topicRef,
    topicTitle: topicId ? topicMetadata(topics, topicId).title : "",
    classification: record.classification && record.classification.kind || "",
    expectsExecution: !!record.expectsExecution,
    answered: record.response.state === "answered",
    answeredAt: record.response.answeredAt,
    state: record.state,
    attention: record.attention || null,
    outcome: record.outcome,
  };
}

// The topic -> projects -> coordinators -> workers tree, plus the unanswered
// list that outranks it.
function buildOwnerRequestOverview(input) {
  var source = input || {};
  var requests = Array.isArray(source.requests) ? source.requests : [];
  var claims = Array.isArray(source.coordinators) ? source.coordinators : [];
  var topics = source.topics || {};
  var sessions = indexSessions(source.sessions);

  var unanswered = [];
  var byTopic = {};
  var order = [];

  function topicNode(topicRef) {
    var ref = normalizeTopicRef(topicRef);
    if (!ref) return null;
    if (!byTopic[ref.topicId]) {
      var metadata = topicMetadata(topics, ref.topicId);
      byTopic[ref.topicId] = {
        topicRef: ref,
        title: metadata.title,
        status: metadata.status,
        requestCount: 0,
        unansweredCount: 0,
        attentionCount: 0,
        projects: [],
        projectIndex: {},
      };
      order.push(ref.topicId);
    }
    return byTopic[ref.topicId];
  }

  function projectNode(topic, projectRef) {
    var ref = projectIdentity.normalizeProjectRef(projectRef);
    if (!topic || !ref) return null;
    if (!topic.projectIndex[ref.projectId]) {
      var node = { projectRef: ref, coordinator: null, workers: [] };
      topic.projectIndex[ref.projectId] = node;
      topic.projects.push(node);
    }
    return topic.projectIndex[ref.projectId];
  }

  for (var i = 0; i < requests.length; i++) {
    var record = requests[i];
    if (!record || !record.response) continue;
    var summary = requestSummary(record, topics);
    if (!summary.answered) unanswered.push(summary);
    var topic = topicNode(record.topicRef);
    if (!topic) continue;
    topic.requestCount += 1;
    if (!summary.answered) topic.unansweredCount += 1;
    if (record.state === "attention") topic.attentionCount += 1;
    for (var p = 0; p < record.projectRefs.length; p++) {
      projectNode(topic, record.projectRefs[p]);
    }
  }

  // Attach the canonical coordinator for every claimed (topic, project) pair,
  // and hang its workers off it. A claim for a topic no request mentions still
  // shows up: the owner should see work that exists even if the request that
  // started it was pruned.
  for (var c = 0; c < claims.length; c++) {
    var claim = claims[c];
    if (!claim || !claim.coordinator) continue;
    var claimTopic = topicNode({ topicId: claim.topicId });
    var project = projectNode(claimTopic, { projectId: claim.projectId });
    if (!project) continue;
    var entry = sessions.byKey[sessionKey(claim.coordinator)];
    project.coordinator = entry ? sessionSummary(entry) : {
      sessionRef: claim.coordinator, title: "", role: "project_coordinator",
      workState: "idle", lifecycleState: "missing", hidden: false, present: false, live: false,
    };
    var children = sessions.childrenByParent[sessionKey(claim.coordinator)] || [];
    for (var w = 0; w < children.length; w++) {
      project.workers.push(sessionSummary(children[w]));
    }
  }

  var topicList = order.map(function (topicId) {
    var node = byTopic[topicId];
    var working = 0;
    var needsInput = 0;
    for (var pi = 0; pi < node.projects.length; pi++) {
      var projectEntry = node.projects[pi];
      var members = (projectEntry.coordinator ? [projectEntry.coordinator] : [])
        .concat(projectEntry.workers);
      for (var mi = 0; mi < members.length; mi++) {
        if (!members[mi].live) continue;
        if (members[mi].workState === "working") working += 1;
        else if (members[mi].workState === "needs_input") needsInput += 1;
      }
      delete projectEntry.projectIndex;
    }
    delete node.projectIndex;
    node.workingCount = working;
    node.needsInputCount = needsInput;
    return node;
  });

  unanswered.sort(function (left, right) {
    return (left.ingressSequence || 0) - (right.ingressSequence || 0);
  });

  return {
    unanswered: unanswered,
    topics: topicList,
    counts: {
      unanswered: unanswered.length,
      topics: topicList.length,
      working: topicList.reduce(function (total, node) { return total + node.workingCount; }, 0),
      needsInput: topicList.reduce(function (total, node) { return total + node.needsInputCount; }, 0),
      attention: topicList.reduce(function (total, node) { return total + node.attentionCount; }, 0),
    },
  };
}

// Convenience wrapper for the live daemon: pulls the three sources and joins
// them. Kept separate from the pure builder so tests do not need a daemon.
function overviewFrom(ownerRequests, sessionLedger, topicIndex) {
  var topics = {};
  if (topicIndex && typeof topicIndex.load === "function") {
    var state = topicIndex.load();
    var ids = Object.keys(state && state.topics || {});
    for (var i = 0; i < ids.length; i++) {
      var topic = state.topics[ids[i]];
      topics[ids[i]] = { title: topic && topic.title || "", status: topic && topic.status || "" };
    }
  }
  return buildOwnerRequestOverview({
    requests: ownerRequests && typeof ownerRequests.list === "function" ? ownerRequests.list() : [],
    coordinators: ownerRequests && typeof ownerRequests.listCoordinators === "function"
      ? ownerRequests.listCoordinators() : [],
    // Workers are not top-level, and a hidden session still has to be visible
    // to the projection so it can be explicitly excluded from live counts
    // rather than silently missing.
    sessions: sessionLedger && typeof sessionLedger.list === "function"
      ? sessionLedger.list({ topLevelOnly: false, includeHidden: true }) : [],
    topics: topics,
  });
}

module.exports = {
  buildOwnerRequestOverview: buildOwnerRequestOverview,
  isLiveSession: isLiveSession,
  overviewFrom: overviewFrom,
};
