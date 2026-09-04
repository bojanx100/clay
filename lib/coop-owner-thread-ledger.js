// Threads are the durable backlog entries of the owner open-work ledger.
//
// A session is an execution attempt against a Thread, never the work item
// itself. When an attempt fails, is dismissed, or its session record
// disappears entirely, the Thread must stay on the open-work list: the owner
// asked for something and is still owed it. Only the owner closing the Thread
// -- verified completion, or an explicit decision not to pursue -- takes the
// entry off that list.
//
// A Thread carries no owner ingress of its own, so it contributes durable
// existence, an owner-facing title and its own execution evidence. Any
// matching owner request or action row merges into it through shared TopicRef
// evidence. These candidates are therefore anchor-only: they hold a row on the
// ledger, but they never take the row's principal identity or overrule the
// owner's visibility decision about it.
//
// This module also owns the reference-link helpers that every ledger row
// shares, so the projection and the Thread candidates cannot drift on how a
// row reports its sessions and projects.

var workRows = require("./coop-owner-work-rows");
var workLinks = require("./coop-owner-sidebar-links");
var workIdentity = require("./coop-owner-work-identity");

// The catch-all conversation Thread is a routing bucket, not requested work.
var CATCH_ALL_THREAD_ID = "uncategorised-conversations";

function text(value, fallback) {
  var result = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function copy(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function sessionKey(ref) {
  return ref && ref.projectId && ref.sessionStorageId
    ? ref.projectId + ":" + ref.sessionStorageId : "";
}

// --- shared row reference helpers -------------------------------------------

function projectTitleIndex(projects) {
  var result = {};
  var list = Array.isArray(projects) ? projects : [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    var ref = item.projectRef || item;
    if (!ref.projectId || result[ref.projectId]) continue;
    result[ref.projectId] = text(item.title, "Project");
  }
  return result;
}

function sessionIndex(sessions) {
  var result = {};
  var list = Array.isArray(sessions) ? sessions : [];
  for (var i = 0; i < list.length; i++) {
    var session = list[i] || {};
    var key = sessionKey(session.sessionRef);
    if (key) result[key] = session;
  }
  return result;
}

function sessionLink(entry) {
  return {
    sessionRef: copy(entry.sessionRef),
    title: text(entry.title, "Project session"),
    role: text(entry.controlRole || entry.role, "session"),
    lifecycleState: text(entry.lifecycleState, "idle"),
    hidden: !!entry.hidden,
    present: entry.sessionPresent !== false,
  };
}

function addLink(list, entry) {
  var key = sessionKey(entry && entry.sessionRef);
  if (!key) return;
  for (var i = 0; i < list.length; i++) {
    if (sessionKey(list[i].sessionRef) === key) return;
  }
  list.push(sessionLink(entry));
}

function entryLinks(record, input, related) {
  var links = [];
  for (var i = 0; i < related.length; i++) addLink(links, related[i]);
  var source = record.links || {};
  var direct = [].concat(source.coordinators || [], source.sessions || []);
  var byRef = sessionIndex(input.sessions);
  for (var d = 0; d < direct.length; d++) {
    var ref = direct[d];
    var found = byRef[sessionKey(ref)];
    addLink(links, found || { sessionRef: ref, title: "Archived project session", sessionPresent: false });
  }
  return links;
}

function projectLinks(record, bindings, titles) {
  var result = [];
  var seen = {};
  function add(ref) {
    if (!ref || !ref.projectId || seen[ref.projectId]) return;
    seen[ref.projectId] = true;
    result.push({ projectRef: copy(ref), title: text(titles[ref.projectId], "Project") });
  }
  var refs = Array.isArray(record && record.projectRefs) ? record.projectRefs : [];
  for (var i = 0; i < refs.length; i++) add(refs[i]);
  for (var bi = 0; bi < bindings.length; bi++) add(bindings[bi] && bindings[bi].targetProject);
  return result;
}

// --- Thread candidates ------------------------------------------------------

// Not every Thread is requested work. An exploring or parked Thread is a
// conversation and belongs in the Threads list, not the work ledger; putting
// it here would bury the real backlog in discussion. A Thread becomes a
// durable work entry once work has actually been dispatched against it. That
// is also the only case the ledger has to defend, because only dispatched
// work has an execution attempt that can fail and take the entry down with it.
//
// A durable `handed_off` state is the strongest signal, but it is not
// sufficient alone. The projection recomputes that upgrade from live evidence
// on every pass, so a Thread dispatched only through a task binding -- never
// through linkExecution, which is what writes the state durably -- falls back
// to `exploring` the moment its task record is pruned. A typed portfolio
// binding naming the Thread is independent dispatch evidence that outlives
// both the session and the task, which is why it is consulted too.
function hasRequestedWork(topic, dispatched) {
  if (text(topic.threadState, "") === "handed_off") return true;
  if (dispatched[topicId(topic.topicRef)]) return true;
  return listOf(topic.relatedExecutions).length > 0 ||
    listOf(topic.relatedSessions).length > 0 ||
    listOf(topic.executionProjectRefs).length > 0;
}

// TopicRefs a typed execution binding claims. Reference-only: a binding
// without a usable TopicRef establishes nothing.
function dispatchedTopics(bindings) {
  var result = {};
  var list = listOf(bindings);
  for (var i = 0; i < list.length; i++) {
    var id = topicId(list[i] && list[i].coopTopicRef);
    if (id) result[id] = true;
  }
  return result;
}

// A merged Thread is not a work item: its backlog entry now lives on the
// Thread it was merged into, and projecting both would double-count the ask.
function isProjectableThread(topic, dispatched) {
  var id = topicId(topic && topic.topicRef);
  if (!id || id === CATCH_ALL_THREAD_ID) return false;
  if (text(topic.status, "open") === "merged") return false;
  return hasRequestedWork(topic, dispatched);
}

// Only an explicit owner decision closes a ledger entry, and `closeOutcome` is
// the record of that decision -- setThreadState refuses to close a Thread
// without one. A Thread carrying `status: "closed"` and no outcome was closed
// by the automated closure sweep, which does not protect a Thread whose linked
// session has gone. Reading that as "not pursuing" would file an entry under a
// decision the owner never made and drop it off the open-work list, so it is
// deliberately not treated as a closure at all: the ask stays open until the
// owner rules on it.
function ownerClosedStatus(topic) {
  var outcome = text(topic.closeOutcome, "");
  if (outcome === "implemented_resolved") return "completed";
  return outcome === "not_pursuing" ? "dismissed" : "";
}

// Project identity for a handed-off Thread comes from where it is executing,
// which is why the execution links lead. The classification group is only a
// fallback: it records where the owner first described the ask, not where the
// work went. The client projection exposes that group as a `projectRef`
// sibling and a `group` kind string, while a durable topic record nests it as
// `group.projectRef` -- both are accepted so this reads either input.
function threadProjectRefs(topic) {
  var refs = [];
  var seen = {};
  function add(ref) {
    if (!ref || !ref.projectId || seen[ref.projectId]) return;
    seen[ref.projectId] = true;
    refs.push({ projectId: ref.projectId });
  }
  var executions = listOf(topic.executionProjectRefs);
  for (var e = 0; e < executions.length; e++) add(executions[e]);
  var sessions = listOf(topic.relatedSessions);
  for (var s = 0; s < sessions.length; s++) {
    var link = sessions[s] || {};
    add(link.projectRef);
    add(link.sessionRef ? { projectId: link.sessionRef.projectId } : null);
  }
  var durable = listOf(topic.relatedExecutions);
  for (var d = 0; d < durable.length; d++) {
    var execution = durable[d] || {};
    add(execution.projectRef);
    add(execution.sessionRef ? { projectId: execution.sessionRef.projectId } : null);
  }
  var group = topic.group && typeof topic.group === "object" ? topic.group : {};
  add(topic.projectRef || group.projectRef);
  return refs;
}

// Shaped like an owner request record so the Thread row derives its state from
// exactly the same typed session and binding evidence every other row uses.
// It deliberately claims no outcome of its own: a Thread does not report that
// work succeeded, the execution records do.
function threadSessionRefs(topic) {
  var refs = [];
  var sessions = listOf(topic.relatedSessions);
  for (var s = 0; s < sessions.length; s++) {
    if (sessions[s] && sessions[s].sessionRef) refs.push(copy(sessions[s].sessionRef));
  }
  var durable = listOf(topic.relatedExecutions);
  for (var d = 0; d < durable.length; d++) {
    if (durable[d] && durable[d].sessionRef) refs.push(copy(durable[d].sessionRef));
  }
  return refs;
}

function threadRecord(topic) {
  return {
    ingressId: "",
    ingressSequence: 0,
    topicRef: copy(topic.topicRef),
    // The Thread's own execution links seed the session join, so an attempt
    // the owner can still navigate to stays reachable from the row even after
    // it has dropped out of the reconciled session ledger.
    links: { coordinators: [], tasks: [], sessions: threadSessionRefs(topic) },
    projectRefs: threadProjectRefs(topic),
    response: { state: "unanswered" },
    state: "open",
    expectsExecution: true,
    outcome: null,
    receivedAt: finite(topic.createdAt) || finite(topic.updatedAt),
    updatedAt: Math.max(finite(topic.updatedAt), finite(topic.threadStateUpdatedAt)),
  };
}

// A placeholder or control-lane label is not an owner-facing title. The same
// screen guards the request rows, and without it here a Thread called
// "Council" would outrank a real owner request's text: `titleEntry` ranks a
// topic-sourced title above every other source.
function meaningfulTitle(value) {
  var result = text(value, "");
  if (!result || /^owner request\s*#/i.test(result) || /^(council|triage)$/i.test(result)) return "";
  return result;
}

function threadReason(topic, state, record, bindings) {
  if (state.status === "completed" && ownerClosedStatus(topic) === "completed") {
    return "Owner closed this Thread as implemented";
  }
  if (state.status === "dismissed" && ownerClosedStatus(topic)) {
    return "Owner is not pursuing this Thread";
  }
  if (state.status === "planned") {
    return text(topic.threadState, "") === "handed_off"
      ? "Handed off with no execution attempt still on record"
      : "Open Thread with no execution attempt recorded";
  }
  return workRows.reasonFor(record, state, bindings);
}

function threadEntry(topic, input, titles, hidden) {
  var record = threadRecord(topic);
  var related = workLinks.topicSessions(record, input.sessions);
  var bindings = workLinks.latestBindings(record, related, input.executionBindings);
  var closed = ownerClosedStatus(topic);
  var state = closed ? { status: closed } : workRows.statusFor(record, related, bindings);
  var id = topicId(topic.topicRef);
  var entryId = "thread:" + id;
  var title = meaningfulTitle(topic.title);
  return {
    entryId: entryId,
    ingressId: "",
    ingressSequence: 0,
    title: title || "Open Thread",
    titleSource: title ? "topic" : "unavailable",
    status: state.status,
    reason: threadReason(topic, state, record, bindings),
    disposition: state.disposition, reconciled: state.reconciled,
    historicalUnresolved: state.historicalUnresolved,
    activity: "",
    evidence: state.evidence || "",
    updatedAt: Math.max(finite(record.updatedAt), finite(record.receivedAt)),
    receivedAt: finite(record.receivedAt),
    topicRef: copy(topic.topicRef),
    threadRef: { threadId: id },
    requestRef: null,
    canonicalEventRef: null,
    sourceSessionRef: null,
    responseState: "unanswered",
    projectRefs: copy(record.projectRefs) || [],
    projects: projectLinks(record, bindings, titles),
    sessions: entryLinks(record, input, related),
    taskRefs: [],
    bindings: copy(bindings) || [],
    ingressIds: [],
    requestRefs: [],
    sourceSessionRefs: [],
    canonicalKey: workIdentity.canonicalKey({ topicRef: topic.topicRef }),
    clearable: false,
    // Identity and description belong to the owner ingress or action row this
    // Thread merges with: an anchor holds the row on the ledger, it does not
    // rename or restate it. Visibility still has to be recorded, because a
    // Thread-only row has no other component to carry the owner's Clear.
    anchorOnly: true,
    hidden: !!hidden[entryId],
  };
}

// One candidate per projectable Thread. Shared TopicRef evidence lets the
// canonical grouper merge these with the owner request and action rows for the
// same ask instead of producing a second row for it.
//
// The identity is the TopicRef and nothing else. A Thread's derived bindings
// are display evidence, not identity: one coordinator session legitimately
// serves several Threads, so publishing its portfolio task as Thread identity
// would union two unrelated asks into a single row and silently delete an open
// backlog entry.
function threadCandidates(input, hidden) {
  var value = input || {};
  var titles = projectTitleIndex(value.projectTitles);
  var cleared = hidden || {};
  var dispatched = dispatchedTopics(value.executionBindings);
  var list = Array.isArray(value.topics) ? value.topics : [];
  var candidates = [];
  for (var i = 0; i < list.length; i++) {
    var topic = list[i] || {};
    if (!isProjectableThread(topic, dispatched)) continue;
    candidates.push({ entry: threadEntry(topic, value, titles, cleared),
      identity: { topicRef: topic.topicRef } });
  }
  return candidates;
}

module.exports = {
  CATCH_ALL_THREAD_ID: CATCH_ALL_THREAD_ID,
  threadCandidates: threadCandidates,
  ownerClosedStatus: ownerClosedStatus,
  meaningfulTitle: meaningfulTitle,
  projectTitleIndex: projectTitleIndex,
  sessionIndex: sessionIndex,
  sessionLink: sessionLink,
  addLink: addLink,
  entryLinks: entryLinks,
  projectLinks: projectLinks,
};
