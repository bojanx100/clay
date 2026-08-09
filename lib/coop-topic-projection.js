// Client-facing shaping of durable Coop topics.
//
// Split out of coop-topic-index.js, which owns the durable index. This module
// owns the narrower question: given a stored topic, what may an actor see? It
// bounds every text field, drops full membership when a summary was asked for,
// and reduces linked work to links to top-level canonical project sessions.

var projectIdentity = require("./project-identity");

var MAX_TITLE = 160;
var MAX_RELATED_SESSIONS = 12;
var MAX_PROJECTION_TEXT = 240;
var MAX_DECISIONS = 8;

function copyRef(ref) {
  return JSON.parse(JSON.stringify(ref));
}

function cleanProjectionText(value, limit) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ")
    .trim().slice(0, limit || MAX_PROJECTION_TEXT);
}

function canProject(options, ref) {
  if (!ref) return true;
  return !options || typeof options.canAccessProject !== "function" ||
    options.canAccessProject(options.actor, ref) === true;
}

// The topic expander links to top-level canonical project sessions only. Only
// depth-0 session references are considered, and each one must be confirmed by
// the caller's resolver as accessible and parentless. Nested execution trees,
// task references, worker sessions, and historical attempts are never projected,
// so the owner-visible payload holds a title plus an exact
// ProjectRef/SessionRef and nothing else.
//
// Without a resolver this returns nothing: a caller that cannot answer
// "is this session top-level and visible?" gets no links rather than guesses.
function relatedSessionLinks(topic, options, normalizeExecution) {
  var list = Array.isArray(topic.relatedExecutions) ? topic.relatedExecutions : [];
  var resolve = options && typeof options.resolveRelatedSession === "function" ? options.resolveRelatedSession : null;
  var seen = {};
  var links = [];
  if (!resolve || typeof normalizeExecution !== "function") return links;
  for (var i = 0; i < list.length && links.length < MAX_RELATED_SESSIONS; i++) {
    var execution = normalizeExecution(list[i], 0);
    var sessionRef = execution && execution.sessionRef;
    if (!sessionRef) continue;
    var projectRef = projectIdentity.projectRef(sessionRef.projectId);
    if (!projectRef || !canProject(options, projectRef)) continue;
    var key = sessionRef.projectId + ":" + sessionRef.sessionStorageId;
    if (seen[key]) continue;
    var resolved = resolve(projectRef, sessionRef);
    if (!resolved || !resolved.topLevel) continue;
    seen[key] = true;
    links.push({
      sessionRef: copyRef(sessionRef),
      projectRef: copyRef(projectRef),
      title: cleanProjectionText(resolved.title, MAX_TITLE) || "Project session",
    });
  }
  return links;
}

function dispositionSummary(disposition) {
  if (!disposition || typeof disposition !== "object") return null;
  var status = String(disposition.status || "");
  if (status !== "done" && status !== "needs_input") return null;
  return {
    status: status,
    source: cleanProjectionText(disposition.source, 64),
    at: typeof disposition.at === "number" ? disposition.at : null,
    note: cleanProjectionText(disposition.note, 500),
  };
}

function topicProjectionMetadata(topic) {
  var refs = Array.isArray(topic.eventRefs) ? topic.eventRefs : [];
  var turns = Array.isArray(topic.turnRefs) ? topic.turnRefs : [];
  return {
    topicRef: copyRef(topic.topicRef), title: topic.title, group: copyRef(topic.group),
    source: topic.source, status: topic.status,
    createdAt: topic.createdAt, updatedAt: topic.updatedAt,
    eventCount: refs.length, turnCount: turns.length,
    firstEventRef: refs.length ? copyRef(refs[0]) : null,
    lastEventRef: refs.length ? copyRef(refs[refs.length - 1]) : null,
    // Durable owner-disposition record, an input to the state derivation and
    // the inspectable provenance of any state that came from it.
    ownerDisposition: dispositionSummary(topic.ownerDisposition),
  };
}

function computedTopicState(topic, options) {
  var computed = options && typeof options.computeTopicState === "function"
    ? options.computeTopicState(copyRef(topic.topicRef), topicProjectionMetadata(topic)) || {} : {};
  var turnCount = Array.isArray(topic.turnRefs) ? topic.turnRefs.length : 0;
  var activity = cleanProjectionText(computed.currentActivity || computed.activity);
  var summary = cleanProjectionText(computed.rollingSummary || computed.summary) ||
    (turnCount + " canonical turn" + (turnCount === 1 ? "" : "s"));
  var decisions = Array.isArray(computed.decisions) ? computed.decisions.map(function (item) {
    return cleanProjectionText(typeof item === "string" ? item : item && (item.summary || item.title || item.text));
  }).filter(Boolean).slice(0, MAX_DECISIONS) : [];
  return {
    status: cleanProjectionText(computed.status, 32) || topic.status,
    rollingSummary: summary,
    decisions: decisions,
    unreadCount: Number.isInteger(computed.unreadCount) && computed.unreadCount > 0 ? computed.unreadCount : 0,
    attention: !!computed.attention,
    currentActivity: activity,
    // Derived owner-facing work state, kept distinct from the durable topic
    // lifecycle status: a topic can be Done and still open.
    workState: cleanProjectionText(computed.workState, 32),
    awaitingAcceptance: !!computed.awaitingAcceptance,
    // Why the state is what it is -- task evidence, foreground work, an owner
    // disposition, an explicit close, or the unlinked-historical default.
    stateSource: cleanProjectionText(computed.stateSource, 64),
  };
}

function publicTopic(topic, options, deps) {
  var computed = computedTopicState(topic, options);
  var summaryOnly = !!(options && options.summaryOnly);
  var metadata = topicProjectionMetadata(topic);
  return {
    topicRef: copyRef(topic.topicRef), title: topic.title, group: copyRef(topic.group), source: topic.source,
    status: computed.status, createdAt: topic.createdAt, updatedAt: topic.updatedAt,
    eventCount: metadata.eventCount, turnCount: metadata.turnCount,
    firstEventRef: metadata.firstEventRef, lastEventRef: metadata.lastEventRef,
    eventRefs: summaryOnly ? [] : copyRef(topic.eventRefs),
    turnRefs: summaryOnly ? [] : copyRef(topic.turnRefs),
    rollingSummary: computed.rollingSummary, decisions: computed.decisions,
    unreadCount: computed.unreadCount, attention: computed.attention,
    currentActivity: computed.currentActivity,
    workState: computed.workState, awaitingAcceptance: computed.awaitingAcceptance,
    stateSource: computed.stateSource,
    ownerDisposition: metadata.ownerDisposition,
    relatedSessions: relatedSessionLinks(topic, options, deps && deps.normalizeExecution),
  };
}

module.exports = {
  canProject: canProject,
  cleanProjectionText: cleanProjectionText,
  publicTopic: publicTopic,
  relatedSessionLinks: relatedSessionLinks,
  topicProjectionMetadata: topicProjectionMetadata,
};
