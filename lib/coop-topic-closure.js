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

function hasLinkedExecution(topic) {
  var links = Array.isArray(topic && topic.relatedExecutions) ? topic.relatedExecutions : [];
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    if (!link || typeof link !== "object") continue;
    if (projectIdentity.normalizeSessionRef(link.sessionRef)) return true;
    if (projectIdentity.normalizeTaskRef(link.taskRef)) return true;
    if (projectIdentity.normalizeProjectRef(link.projectRef)) return true;
  }
  return false;
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
    if (hasLinkedExecution(topic)) continue;
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
  var topics = (index && index.topics) || {};
  for (var i = 0; i < proposal.candidates.length; i++) {
    var topic = topics[proposal.candidates[i].topicId];
    // Anything that changed status since the proposal was shown is left alone:
    // the owner ruled on an open row, not on whatever it has become.
    if (!topic || topic.status !== "open") { skipped += 1; continue; }
    topic.status = "closed";
    topic.updatedAt = now();
    topic.closureAudit = { proposalId: proposal.proposalId, reason: CLOSURE_REASON, closedAt: now() };
    closed += 1;
  }
  proposal.resolvedAt = now();
  proposal.confirmed = true;
  proposal.closed = closed;
  return { ok: true, closed: closed, skipped: skipped, confirmed: true };
}

module.exports = {
  CLOSURE_REASON: CLOSURE_REASON,
  selectClosureCandidates: selectClosureCandidates,
  proposalId: proposalId,
  proposeClosures: proposeClosures,
  applyClosureProposal: applyClosureProposal,
};
