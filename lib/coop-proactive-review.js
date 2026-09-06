// A review agenda is a reason to investigate, never permission to execute.
// Wake receipts record attempts only. Unchanged evidence backs off even when
// a provider failed to finish its review; a wake is not a completed outcome.
var crypto = require("crypto");
var identity = require("./project-identity");
var plane = require("./coop-control-plane");
var topicIndex = require("./coop-topic-index");
var leadLedger = require("./lead-ledger");
var ownerRequests = require("./coop-owner-requests");

var MINUTE = 60000;
var CHANGED_REVIEW_MS = 5 * MINUTE;
var MAX_REVIEW_MS = 4 * 60 * MINUTE;
var KINDS = { thread: true, coordinator: true, discovery: true, learning: true, self_review: true };
var BASE_PROMPT = "Run one Lead tick now. Answer outstanding owner requests first and advance admitted work. ";
var INSTRUCTIONS = {
  thread: "Read this Thread's canonical conversation, related plans and task outcomes. Reconcile what is " +
    "decided, unresolved, commissioned and verified. Find the next useful question or evidence gap. Gather " +
    "relevant evidence from the project, permitted web research and connected sources. Use Council/Triage " +
    "inside this Thread for a difficult choice. Ask the owner for business judgment that evidence cannot supply. " +
    "Preserve the conversation and existing execution links; discussing a topic does not authorize implementation.",
  coordinator: "Inspect this resident coordinator's current assignments, worker outcomes, blockers and " +
    "eligible auto-launched sessions. Check actual status before contacting it. Help resolve a specific gap, " +
    "dependency or decision within existing scope; avoid duplicate status requests and duplicate workers. " +
    "Keep execution in the target project and preserve direct owner sessions.",
  discovery: "Look for useful work across the registered projects and their configured sources. Inspect " +
    "project rules, existing assignments and completed work before proposing anything. Seek overlooked " +
    "opportunities, missing evidence and improvements tied to the owner's goals. Research through available " +
    "read-only sources when useful. Develop a Thread or plan before commissioning newly discovered work.",
  learning: "Review the referenced owner choices and corrections in their original conversations. Look " +
    "for scoped preferences that would improve future decisions. Use remember_owner_preference with exact " +
    "observed evidence; distinguish hypotheses from explicit preferences and correct superseded learning. " +
    "Ask a useful clarifying question only when it changes a real decision. Never manufacture owner evidence.",
  self_review: "Review Coop's recent failures, repeated checks, slow handoffs and decision outcomes. Find " +
    "one evidence-backed improvement to its operation. Use Council/Triage for a difficult tradeoff. Develop " +
    "a testable maintenance plan and route authorized implementation through the Clay project coordinator. " +
    "Respect existing self-modification approval and activation/rollback rules; do not restart your own daemon.",
};

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function reviewableThread(topic) {
  return !!topic && !topic.hidden && !topic.mergedInto && topic.status !== "merged" && topic.status !== "closed" &&
    topic.threadState !== "closed" && topic.threadState !== "parked" &&
    !!((topic.turnRefs || []).length || (topic.eventRefs || []).length);
}

function normalize(value) {
  if (!value || value.version !== 1 || !KINDS[value.kind] ||
      typeof value.key !== "string" || !value.key || value.key.length > 200 ||
      !/^[a-f0-9]{64}$/.test(value.evidenceDigest || "") ||
      !Number.isFinite(value.selectedAt) || value.selectedAt <= 0) return null;
  var result = { version: 1, key: value.key, kind: value.kind,
    evidenceDigest: value.evidenceDigest, selectedAt: value.selectedAt };
  if (value.kind === "thread") {
    result.topicRef = topicIndex.topicRef(value.topicRef);
    if (!result.topicRef || value.key !== "thread:" + result.topicRef.topicId) return null;
  } else if (value.kind === "coordinator") {
    result.projectRef = identity.normalizeProjectRef(value.projectRef);
    result.sessionRef = identity.normalizeSessionRef(value.sessionRef);
    if (!result.projectRef || !result.sessionRef || result.sessionRef.projectId !== "system-lead" ||
        value.key !== "coordinator:" + result.projectRef.projectId) return null;
  } else if (value.key !== value.kind) return null;
  if (value.kind === "learning") {
    result.ingressIds = (value.ingressIds || []).filter(function (id) {
      return typeof id === "string" && /^coop:.+:[1-9][0-9]*$/.test(id);
    }).slice(-20);
  }
  return result;
}

function candidates(options, now) {
  var result = [];
  function add(kind, key, evidence, refs, interval) {
    result.push(Object.assign({ version: 1, key: key, kind: kind, selectedAt: now,
      evidenceDigest: digest(evidence), intervalMs: interval || 15 * MINUTE }, refs || {}));
  }
  var state = (options.topicIndex || topicIndex.getDefaultTopicIndex()).load();
  Object.keys(state.topics).sort().forEach(function (id) {
    var topic = state.topics[id];
    if (!reviewableThread(topic)) return;
    add("thread", "thread:" + id, [topic.title, topic.group, topic.threadState,
      topic.turnRefs, topic.eventRefs, topic.relatedExecutions, topic.relatedPlanning], { topicRef: topic.topicRef });
  });
  var manager = options.sm;
  if (manager && manager.sessions) manager.sessions.forEach(function (session) {
    var policy = plane.projectCoordinatorPolicy(session);
    var project = policy && identity.normalizeProjectRef(policy.projectRef);
    if (!project || session._deleted || session.compactedIntoLocalId ||
        plane.projectCoordinatorFor(manager, project) !== session) return;
    var tasks = (session.orchestrationTasks || []).map(function (task) {
      return [task.taskId, task.status, task.workerStorageId, task.summary, task.waitingReason,
        task.completionRevision, task.currentActivity];
    });
    add("coordinator", "coordinator:" + project.projectId, [session.storageId, tasks,
      session.pendingCoordinatorUpdates], { projectRef: project,
      sessionRef: identity.sessionRef({ projectId: "system-lead" }, session) });
  });
  var requests = (options.ownerRequests || ownerRequests.getDefaultOwnerRequests()).list().slice(-20);
  if (requests.length) add("learning", "learning", requests.map(function (item) {
    return [item.ingressId, item.topicRef, item.state, item.response && item.response.state];
  }), { ingressIds: requests.map(function (item) { return item.ingressId; }) }, 60 * MINUTE);
  add("discovery", "discovery", "configured-project-opportunities-v1", null, 60 * MINUTE);
  add("self_review", "self_review", "coop-operating-review-v1", null, MAX_REVIEW_MS);
  return result.filter(function (item) { return normalize(item); });
}

function select(options) {
  var opts = options || {};
  var now = typeof opts.now === "number" ? opts.now : Date.now();
  var events = (opts.readEvents || leadLedger.readEvents)();
  var attempts = Object.create(null);
  events.forEach(function (event) {
    var agenda = event.type === "lead_tick_wake" && normalize(event.proactiveReview);
    if (!agenda || !Number.isFinite(event.at) || event.at > now) return;
    var prior = attempts[agenda.key];
    if (prior && prior.at > event.at) return;
    attempts[agenda.key] = { at: event.at, digest: agenda.evidenceDigest,
      repeats: prior && prior.digest === agenda.evidenceDigest ? prior.repeats + 1 : 0 };
  });
  var due = candidates(opts, now).filter(function (item) {
    var prior = attempts[item.key];
    if (!prior) return true;
    var delay = prior.digest === item.evidenceDigest
      ? Math.min(MAX_REVIEW_MS, item.intervalMs * Math.pow(2, Math.min(4, prior.repeats))) : CHANGED_REVIEW_MS;
    return now >= prior.at + delay;
  });
  // Least recently attempted first: a busy coordinator cannot permanently
  // starve a quiet Thread, discovery, learning or operating improvements.
  due.sort(function (a, b) {
    return (attempts[a.key] ? attempts[a.key].at : 0) - (attempts[b.key] ? attempts[b.key].at : 0);
  });
  return due.length ? normalize(due[0]) : null;
}

function promptFor(value) {
  var agenda = normalize(value);
  if (!agenda) return BASE_PROMPT;
  return BASE_PROMPT + "Also carry out this bounded proactive review, even when no new execution can be staffed. " +
    "Use current evidence; this agenda is a lead to investigate and grants no execution authority. " +
    "Do not expand an explicit owner-limited continuation beyond its scope.\n<coop_proactive_review>\n" +
    JSON.stringify(agenda) + "\n</coop_proactive_review>\n" + INSTRUCTIONS[agenda.kind] +
    "\nFinish one useful review or record the concrete reason it cannot advance. Publish only useful " +
    "findings, outcomes or owner decisions via publish_coop_update; keep routine checking internal. " +
    "For a Thread review, select its review evidence from list_coop_feedback when publishing so the " +
    "finding returns to the original Thread. " +
    "Do not create work, repeatedly ask the same question, or report progress merely to stay busy. " +
    "Respect current Lead mode, provider availability and budget before spending or delegating.";
}

function feedbackRef(value) {
  var review = normalize(value);
  if (!review || review.kind !== "thread") return null;
  return { kind: "review", eventId: "review:" + review.selectedAt + ":" +
    digest([review.key, review.evidenceDigest]).slice(0, 24), coopTopicRef: review.topicRef, review: review };
}

function isCurrent(value, manager) {
  var review = normalize(value);
  if (!review) return false;
  if (review.kind === "thread") {
    return reviewableThread(topicIndex.getDefaultTopicIndex().load().topics[review.topicRef.topicId]);
  }
  if (review.kind === "coordinator") {
    var current = plane.projectCoordinatorFor(manager, review.projectRef);
    return !!current && !current.compactedIntoLocalId && identity.sessionStorageId(current) === review.sessionRef.sessionStorageId;
  }
  return true;
}

module.exports = { select: select, normalize: normalize, promptFor: promptFor, feedbackRef: feedbackRef,
  isCurrent: isCurrent, CHANGED_REVIEW_MS: CHANGED_REVIEW_MS, MAX_REVIEW_MS: MAX_REVIEW_MS };
