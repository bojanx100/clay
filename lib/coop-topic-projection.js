// Client-facing shaping of durable Coop topics.
//
// Split out of coop-topic-index.js, which owns the durable index. This module
// owns the narrower question: given a stored topic, what may an actor see? It
// bounds every text field, drops full membership when a summary was asked for,
// and reduces linked work to links to top-level canonical project sessions.

var projectIdentity = require("./project-identity");
var lineage = require("./coop-topic-lineage");
var topicRelevance = require("./coop-topic-relevance");
var topicAnchors = require("./coop-topic-anchors");
var topicPromotion = require("./coop-topic-promotion");

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

// Project identity for a handed-off Thread comes from its durable execution
// links, not from the classification bucket where the owner first described
// it. A cross-project or still-uncategorized Thread can therefore become the
// same container beneath every project coordinator that is executing it.
function executionProjectRefs(topic, options, normalizeExecution) {
  var list = Array.isArray(topic.relatedExecutions) ? topic.relatedExecutions : [];
  var refs = [];
  var seen = {};
  if (typeof normalizeExecution !== "function") return refs;
  for (var i = 0; i < list.length; i++) {
    var execution = normalizeExecution(list[i], 0);
    var projectRef = execution && (execution.projectRef ||
      execution.sessionRef && projectIdentity.projectRef(execution.sessionRef.projectId));
    if (!projectRef || seen[projectRef.projectId] || !canProject(options, projectRef)) continue;
    seen[projectRef.projectId] = true;
    refs.push(copyRef(projectRef));
  }
  return refs;
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
    // Optimistic-concurrency token: the client echoes the revision it
    // rendered with any decision, so a decision aimed at an older record --
    // even one carrying the same three-word state -- is rejected as stale.
    revision: (function () {
      var revision = Number(disposition.revision);
      return isFinite(revision) && revision >= 1 ? Math.floor(revision) : 1;
    })(),
  };
}

function orderedRefs(refs, history, absoluteIndexFor) {
  var copied = copyRef(Array.isArray(refs) ? refs : []);
  if (!history || typeof absoluteIndexFor !== "function") return copied;
  return copied.map(function (ref, index) {
    return { ref: ref, index: index, absoluteIndex: absoluteIndexFor(ref) };
  }).sort(function (a, b) {
    var aHas = Number.isInteger(a.absoluteIndex);
    var bHas = Number.isInteger(b.absoluteIndex);
    if (aHas && bHas && a.absoluteIndex !== b.absoluteIndex) return a.absoluteIndex - b.absoluteIndex;
    return a.index - b.index;
  }).map(function (item) { return item.ref; });
}

function topicProjectionMetadata(topic, history) {
  var refs = orderedRefs(topic.eventRefs, history, function (ref) {
    return lineage.absoluteIndexFor(history, ref && ref.sessionStorageId, ref && ref.eventIndex);
  });
  var turns = orderedRefs(topic.turnRefs, history, function (ref) {
    return lineage.absoluteIndexFor(history, ref && ref.sessionStorageId, ref && ref.startEventIndex);
  });
  return {
    topicRef: copyRef(topic.topicRef),
    threadRef: copyRef(topic.threadRef || { threadId: topic.topicRef.topicId }),
    threadState: topic.threadState || (topic.status === "closed" ? "closed" : "exploring"),
    closeOutcome: topic.closeOutcome || null,
    hidden: topic.hidden === true,
    lastTurnRef: turns.length ? copyRef(turns[turns.length - 1]) : null,
    title: topic.title, group: copyRef(topic.group),
    source: topic.source, status: topic.status,
    createdAt: topic.createdAt, updatedAt: topic.updatedAt,
    eventCount: refs.length, turnCount: turns.length,
    firstEventRef: refs.length ? copyRef(refs[0]) : null,
    lastEventRef: refs.length ? copyRef(refs[refs.length - 1]) : null,
    eventRefs: refs,
    turnRefs: turns,
    // Durable owner-disposition record, an input to the state derivation and
    // the inspectable provenance of any state that came from it.
    ownerDisposition: dispositionSummary(topic.ownerDisposition),
  };
}

function computedTopicState(topic, metadata, options) {
  var computed = options && typeof options.computeTopicState === "function"
    ? options.computeTopicState(copyRef(topic.topicRef), metadata) || {} : {};
  var turnCount = metadata.turnCount;
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
    // How many pieces of linked work back this state. Linked work is also one of
    // the signals that promotes a quiet automatic topic, so the count has to
    // reach the projection filter rather than being reduced to a label first.
    linkedWorkCount: Number.isInteger(computed.taskCount) && computed.taskCount > 0 ? computed.taskCount : 0,
  };
}

function publicTopic(topic, options, deps) {
  var metadata = topicProjectionMetadata(topic, options && options.history);
  var computed = computedTopicState(topic, metadata, options);
  var summaryOnly = !!(options && options.summaryOnly);
  var relatedSessions = relatedSessionLinks(topic, options, deps && deps.normalizeExecution);
  var executionProjects = executionProjectRefs(topic, options, deps && deps.normalizeExecution);
  var threadState = metadata.threadState;
  if (threadState !== "closed" && (computed.linkedWorkCount > 0 || relatedSessions.length > 0)) threadState = "handed_off";
  return {
    topicRef: copyRef(topic.topicRef), threadRef: metadata.threadRef,
    threadState: threadState, closeOutcome: metadata.closeOutcome,
    hidden: metadata.hidden,
    lastTurnRef: metadata.lastTurnRef,
    title: topic.title, group: copyRef(topic.group), source: topic.source,
    status: computed.status, createdAt: topic.createdAt, updatedAt: topic.updatedAt,
    eventCount: metadata.eventCount, turnCount: metadata.turnCount,
    firstEventRef: metadata.firstEventRef, lastEventRef: metadata.lastEventRef,
    eventRefs: summaryOnly ? [] : copyRef(metadata.eventRefs),
    turnRefs: summaryOnly ? [] : copyRef(metadata.turnRefs),
    rollingSummary: computed.rollingSummary, decisions: computed.decisions,
    unreadCount: computed.unreadCount, attention: computed.attention,
    currentActivity: computed.currentActivity,
    workState: computed.workState, awaitingAcceptance: computed.awaitingAcceptance,
    stateSource: computed.stateSource, linkedWorkCount: computed.linkedWorkCount,
    ownerDisposition: metadata.ownerDisposition,
    relatedSessions: relatedSessions,
    executionProjectRefs: executionProjects,
  };
}

// Every group of topics one actor may see, each already reduced to its public
// shape. Four independent filters, in order: lifecycle status, at least one
// owner-relevant turn, anchor trust, and project access -- then the promotion
// threshold that holds back quiet single-turn automatic topics.
function projectTopics(index, options, deps) {
  var groups = {}; var topics = Object.keys(index.topics);
  for (var i = 0; i < topics.length; i++) {
    var topic = index.topics[topics[i]]; var group = deps.normalizeGroup(topic.group);
    var queueAuthorization = options && options.history &&
      topicPromotion.hasQueueAuthorization(topic, options.history);
    // Open topics project as live rows; explicitly closed topics still
    // project so a resolved topic stays discoverable (the client collapses
    // them into a compact Done section). Merged topics are gone for good --
    // their membership lives on in the merge target.
    if (topic.status !== "open" && topic.status !== "closed") continue;
    // A topic earns its place by holding at least one owner-relevant turn.
    // Internal-only activity is not enough: those turns are already dropped
    // from replay, so such a topic would open onto an empty transcript.
    // Visibility only -- the durable index keeps every membership, so nothing
    // is lost and the topic appears the moment a relevant turn lands.
    if (options && options.history &&
        !topicRelevance.topicHasRelevantTurn(topic, options.history) && !queueAuthorization) continue;
    // Fail closed on drifted anchors. A topic whose membership spans no
    // longer start at an owner turn cannot be trusted for its title, its
    // state or its transcript -- every one of those reads whatever record the
    // stale index happens to hit. Withheld from the owner rather than shown
    // with fabricated content; the durable membership is untouched.
    if (options && options.history &&
        !topicAnchors.isProjectable(topic, options.history) && !queueAuthorization) continue;
    if (!group || group.kind === "project" && !canProject(options, group.projectRef)) continue;
    // Quiet single-turn automatic topics stay durable and searchable but claim
    // no row until the owner shows they are a real thread. Built before the
    // filter because linked work is one of the promotion signals and only the
    // computed view knows how much linked work there is.
    var publicView = publicTopic(topic, options, deps);
    if (!topicPromotion.isProjectable(topic, publicView, options)) continue;
    var key = group.kind === "project" ? "project:" + group.projectRef.projectId : group.kind;
    if (!groups[key]) groups[key] = { kind: group.kind, projectRef: group.projectRef || null, topics: [], threads: [] };
    groups[key].topics.push(publicView);
    groups[key].threads.push(publicView);
  }
  var list = Object.keys(groups).map(function (key) { return groups[key]; });
  list.sort(function (a, b) { return String(a.kind + (a.projectRef && a.projectRef.projectId || "")).localeCompare(String(b.kind + (b.projectRef && b.projectRef.projectId || ""))); });
  return { type: "coop_topic_projection", threadType: "coop_thread_projection",
    canonicalSessionRef: index.canonicalSessionStorageId ? { projectId: projectIdentity.LEAD_PROJECT_ID, sessionStorageId: index.canonicalSessionStorageId } : null,
    groups: list };
}

module.exports = {
  projectTopics: projectTopics,
  canProject: canProject,
  cleanProjectionText: cleanProjectionText,
  publicTopic: publicTopic,
  executionProjectRefs: executionProjectRefs,
  relatedSessionLinks: relatedSessionLinks,
  topicProjectionMetadata: topicProjectionMetadata,
};
