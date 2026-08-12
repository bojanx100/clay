// Owner-confirmable bulk closure of topics that no longer track anything.
//
// Owner ingress 134: "close all open topic except ones that have matching
// session in one of the projects". Taken literally that is a silent bulk close
// of most of the sidebar, and a silent bulk close is exactly the wrong shape for
// it: closing is the owner recording a resolution, and this pass cannot know
// which of 20 rows they still care about. It is also irreversible in spirit --
// a closed topic never auto-reopens (coop-topic-classification.openTopic), so a
// wrong sweep costs the owner an explicit reopen per row.
//
// So the instruction is honoured in two halves. This module SELECTS, deriving
// the candidate set deterministically and naming the reason per row, and
// persists that exact set as a proposal with a content-addressed id. Closing
// then requires the owner to confirm THAT id, so what gets closed is provably
// the set they were shown -- not whatever the set has drifted into by the time
// they tap. Declining closes nothing and is recorded.
//
// A topic is a candidate when it has neither of the two things that make a topic
// still live:
//   * a matching session in one of the projects (the owner's own criterion, and
//     the same "topics should match session names" idea from ingress 167), or
//   * a linked execution -- real work hanging off the topic.
//
// Deliberately never a candidate: the uncategorised catch-all, because it is the
// fallback every unroutable turn depends on. Closing it is what broke live
// classification before -- with the catch-all sealed there is nowhere for a
// low-information turn to go, so it mints a fragment instead, which is the very
// sprawl this work is undoing.
//
// Nothing here reads the clock for identity: the proposal id is a hash of the
// candidate ids, so the same candidate set always produces the same id.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");

var UNCATEGORISED_ID = "uncategorised-conversations";
var CLOSURE_REASON = "no_matching_session_or_execution";

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function sessionNames(sessions) {
  var list = Array.isArray(sessions) ? sessions : [];
  var names = {};
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var status = item && typeof item.getStatus === "function" ? item.getStatus() : item || {};
    var candidates = [status.name, status.title, status.sessionName, item && item.name, item && item.title];
    for (var c = 0; c < candidates.length; c++) {
      var name = normalizeName(candidates[c]);
      if (name) names[name] = true;
    }
  }
  return names;
}

// Whether some session in some project carries this topic's name. Title equality
// after normalisation, which is the owner's stated model ("topics should match
// session names once created"): a topic whose name is a live session's name is
// still tracking that work.
function hasMatchingSession(topic, names) {
  var title = normalizeName(topic && topic.title);
  return !!(title && names[title]);
}

var topicState = require("./coop-topic-state");

function topicIdOf(ref) {
  return ref && String(ref.topicId || "").trim() || "";
}

// Work that is still moving, or that the owner has to act on. Both protect a
// topic: the first is unfinished, the second is the owner being blocked.
function unfinished(status) {
  var value = String(status || "");
  return !!(topicState.WORKING_STATUSES[value] || topicState.ATTENTION_STATUSES[value]);
}

// Any task still running or awaiting the owner, on this exact topic.
function hasLiveTask(topicId, tasks) {
  var list = Array.isArray(tasks) ? tasks : [];
  for (var i = 0; i < list.length; i++) {
    if (!list[i] || topicIdOf(list[i].coopTopicRef) !== topicId) continue;
    if (unfinished(list[i].status)) return true;
  }
  return false;
}

// Any execution binding on this topic that has not reached a terminal state.
function hasLiveBinding(topicId, bindings) {
  var list = Array.isArray(bindings) ? bindings : [];
  for (var i = 0; i < list.length; i++) {
    var binding = list[i];
    if (!binding || topicIdOf(binding.coopTopicRef) !== topicId) continue;
    if (binding.hidden === true) continue;
    var mapped = topicState.BINDING_STATUS_TO_TASK[String(binding.status || "")];
    if (mapped && unfinished(mapped)) return true;
  }
  return false;
}

// A session that is actually present and not dismissed still tracks its topic.
// A hidden or missing one proves nothing and must not block the sweep.
function hasPresentSession(topicId, evidence) {
  var list = Array.isArray(evidence) ? evidence : [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || entry.hidden === true || entry.sessionPresent === false) continue;
    var refs = Array.isArray(entry.coopTopicRefs) ? entry.coopTopicRefs : [];
    for (var r = 0; r < refs.length; r++) {
      if (topicIdOf(refs[r]) === topicId) return true;
    }
  }
  return false;
}

// The owner is blocked on this topic. Closing it would hide their own
// outstanding decision, which is the one thing this sweep must never do.
function ownerBlocked(topic) {
  var disposition = topic && topic.ownerDisposition;
  return !!(disposition && disposition.status === "needs_input");
}

// A recorded execution link is history. It protects the topic only while the
// thing it names still exists: a link to a session the owner has since
// dismissed, or one that is gone, protected the topic PERMANENTLY -- the sweep
// could never close it however finished it was.
//
// Absent evidence is not proof of absence: with no session evidence supplied at
// all, a link still protects, because the safe default is to keep a topic.
function dismissedSession(sessionRef, evidence) {
  var list = Array.isArray(evidence) ? evidence : [];
  var wanted = projectIdentity.normalizeSessionRef(sessionRef);
  if (!wanted || !list.length) return false;
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    var ref = entry && projectIdentity.normalizeSessionRef(entry.sessionRef);
    if (!ref || ref.sessionStorageId !== wanted.sessionStorageId) continue;
    return entry.hidden === true || entry.sessionPresent === false;
  }
  return false;
}

function hasLinkedExecution(topic, evidence) {
  var links = Array.isArray(topic && topic.relatedExecutions) ? topic.relatedExecutions : [];
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    if (!link || typeof link !== "object") continue;
    if (projectIdentity.normalizeSessionRef(link.sessionRef)) {
      if (dismissedSession(link.sessionRef, evidence)) continue;
      return true;
    }
    if (projectIdentity.normalizeTaskRef(link.taskRef)) return true;
    if (projectIdentity.normalizeProjectRef(link.projectRef)) return true;
  }
  return false;
}

// The single blocking predicate. Selection and confirmation both consult it, so
// a topic can never be offered under one rule and closed under a weaker one.
// Returns the reason code, or "" when nothing blocks closure.
function blockedBy(topicId, topic, options) {
  var opts = options || {};
  if (ownerBlocked(topic)) return "owner_needs_input";
  if (opts.outstandingTopicIds && opts.outstandingTopicIds[topicId]) return "owner_request_unanswered";
  if (hasLiveTask(topicId, opts.tasks)) return "task_in_flight";
  if (hasLiveBinding(topicId, opts.bindings)) return "binding_in_flight";
  if (hasPresentSession(topicId, opts.sessionEvidence)) return "session_present";
  return "";
}

// The single reason-to-keep predicate. Used when building a proposal AND again
// when the owner confirms it, because the window in which they are reading the
// proposal is exactly when a new question or a failing task is most likely to
// arrive -- and confirming used to re-check only that the topic was still open.
// Returns a bounded code naming what protects it, or "" when nothing does.
function blockingReason(topicId, topic, opts) {
  if (!topic || typeof topic !== "object" || !topic.topicRef) return "absent";
  if (topic.status !== "open") return "not_open";
  if (topicId === UNCATEGORISED_ID) return "catch_all";
  if (hasLinkedExecution(topic, opts.sessionEvidence)) return "linked_execution";
  if (ownerBlocked(topic)) return "owner_needs_input";
  if (hasLiveTask(topicId, opts.tasks)) return "live_task";
  if (hasLiveBinding(topicId, opts.bindings)) return "live_binding";
  if (hasPresentSession(topicId, opts.sessionEvidence)) return "present_session";
  if (opts.outstandingTopicIds && opts.outstandingTopicIds[topicId]) return "unanswered_request";
  return "";
}

// Every open topic with no matching session and no linked execution, in sorted
// id order. Callers may override the session test with options.hasMatchingSession
// when they can resolve sessions properly; the default matches on name.
function selectClosureCandidates(index, options) {
  var opts = options || {};
  var names = sessionNames(opts.sessions);
  var matches = typeof opts.hasMatchingSession === "function"
    ? opts.hasMatchingSession
    : function (topic) { return hasMatchingSession(topic, names); };
  var topics = (index && index.topics) || {};
  var ids = Object.keys(topics).sort();
  var candidates = [];
  for (var i = 0; i < ids.length; i++) {
    var topic = topics[ids[i]];
    if (!topic || typeof topic !== "object" || !topic.topicRef) continue;
    if (topic.status !== "open") continue;
    if (ids[i] === UNCATEGORISED_ID) continue;
    if (matches(topic)) continue;
    if (hasLinkedExecution(topic, opts.sessionEvidence)) continue;
    // Authoritative evidence. Anything the sweep cannot prove finished stays
    // open: a wrongly-kept topic is a row the owner can close later, a wrongly
    // closed one is evidence they lose without being asked.
    if (blockedBy(ids[i], topic, opts)) continue;
    candidates.push({ topicId: ids[i], title: topic.title, reason: CLOSURE_REASON, turnCount: Array.isArray(topic.turnRefs) ? topic.turnRefs.length : 0 });
  }
  return candidates;
}

// Content-addressed identity for a candidate set. No clock, no randomness: the
// same set always hashes the same, and any drift in the set invalidates the id,
// which is what makes a stale confirmation detectable instead of destructive.
function proposalId(candidates) {
  var ids = candidates.map(function (entry) { return entry.topicId; }).sort();
  return "close-" + crypto.createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16);
}

// Records the proposal on the index and returns it for the owner to rule on.
// Closes nothing.
function proposeClosures(index, options) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var candidates = selectClosureCandidates(index, opts);
  var id = proposalId(candidates);
  index.closureProposal = {
    proposalId: id, proposedAt: now(), reason: CLOSURE_REASON,
    candidates: candidates.map(function (entry) {
      return { topicId: entry.topicId, title: entry.title, reason: entry.reason, turnCount: entry.turnCount };
    }),
  };
  return { ok: true, proposalId: id, candidates: index.closureProposal.candidates };
}

// Applies the owner's ruling on a recorded proposal. Only the exact recorded id
// may be confirmed, and only once: a resolved proposal replays its outcome
// instead of sweeping a second time.
function applyClosureProposal(index, decision, options) {
  var opts = options || {};
  var now = typeof opts.now === "function" ? opts.now : Date.now;
  var request = decision || {};
  var proposal = index && index.closureProposal;
  var requested = request.proposalId != null ? String(request.proposalId) : "";
  if (!proposal || !requested || proposal.proposalId !== requested) {
    return { ok: false, code: "closure_proposal_stale" };
  }
  if (proposal.resolvedAt) {
    return { ok: true, duplicate: true, closed: 0, confirmed: proposal.confirmed === true };
  }
  if (request.confirmed !== true) {
    proposal.resolvedAt = now();
    proposal.confirmed = false;
    return { ok: true, closed: 0, declined: proposal.candidates.length, confirmed: false };
  }
  var closed = 0;
  var skipped = 0;
  var blocked = [];
  var topics = (index && index.topics) || {};
  for (var i = 0; i < proposal.candidates.length; i++) {
    var topicId = proposal.candidates[i].topicId;
    var topic = topics[topicId];
    // Anything that changed status since the proposal was shown is left alone:
    // the owner ruled on an open row, not on whatever it has become.
    if (!topic || topic.status !== "open") { skipped += 1; continue; }
    // And re-run the FULL blocking predicate against current evidence. The
    // owner ruled on a list; between seeing it and confirming it they may have
    // asked something new, a task may have failed, a coordinator may have
    // started. Checking only status closed topics that had become blocked.
    var reason = blockedBy(topicId, topic, opts);
    if (reason) {
      blocked.push({ topicId: topicId, title: topic.title, reason: reason });
      continue;
    }
    topic.status = "closed";
    topic.updatedAt = now();
    topic.closureAudit = { proposalId: proposal.proposalId, reason: CLOSURE_REASON, closedAt: now() };
    closed += 1;
  }
  proposal.resolvedAt = now();
  proposal.confirmed = true;
  proposal.closed = closed;
  return { ok: true, closed: closed, skipped: skipped, blocked: blocked, confirmed: true };
}

module.exports = {
  CLOSURE_REASON: CLOSURE_REASON,
  selectClosureCandidates: selectClosureCandidates,
  proposalId: proposalId,
  proposeClosures: proposeClosures,
  applyClosureProposal: applyClosureProposal,
};
