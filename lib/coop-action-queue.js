// The owner-facing "Action required" queue, derived across every project the
// owner can see and surfaced at the top of Coop -- without entering a project.
//
// Two rules shape it, and they are the whole point:
//
//   1. One item per canonical piece of work. Not one per task, and never one
//      per internal coordinator. A reconciliation coordinator is implementation
//      machinery: it exists so Coop can manage its own workers, and grouping the
//      owner's decisions underneath it buries the actual questions inside a row
//      that means nothing to them. Its decisions are lifted out and stand alone.
//
//   2. Identity is canonical, so the same work cannot appear twice. If a piece
//      of work already has a visible session, the item LINKS to that session
//      rather than inviting the owner to start a second one.
//
// Reference-only, like every other Coop projection: ids, titles, the decision
// text the worker actually asked for, and links. No transcript bodies.

var MAX_ITEMS = 50;
var MAX_TEXT = 240;
// A decision has to be scannable in a sidebar row. Real workers write multi-
// sentence status paragraphs into userQuestion/waitingReason, so the raw text
// arrives far longer than the row can show.
var MAX_DECISION = 160;

// Statuses where the owner is the blocker. Deliberately the same vocabulary
// used by coop-work-activity and global-coop-projection, so "needs input" means
// one thing across the system.
var ATTENTION_STATUSES = {
  blocked: true, failed: true, needs_input: true, waiting_user: true,
};

// Work the worker finished but the owner has not accepted. This is the other
// half of the owner's rule that a terminal implementation session is NOT Done:
// such work must surface as a durable owner-facing item rather than quietly
// disappearing, otherwise the Done state is unreachable because nothing ever
// writes ownerAcceptance.
function isAwaitingAcceptance(task) {
  if (!task || task.status !== "completed") return false;
  var acceptance = task.ownerAcceptance;
  // A rejection is a decision the owner already gave. Without this it read as
  // "not accepted" and the item stayed in the queue asking to be accepted or
  // sent back -- which is exactly what the owner had just done to it.
  if (acceptance && acceptance.status === "rejected") return false;
  if (!acceptance || acceptance.status !== "accepted") return true;
  return acceptance.withdrawnAt != null;
}

// A task that exists to coordinate other tasks is machinery. It is hidden even
// when it is itself waiting, because what the owner must decide always lives on
// a leaf; the coordinator is just the thing that will act on the answer.
function isInternalCoordinator(task, childrenByParent) {
  if (!task) return true;
  var kids = childrenByParent[task.taskId];
  return !!(kids && kids.length > 0);
}

function cleanText(value, fallback) {
  var text = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return text || fallback || "";
}

// Canonical work identity, in preference order:
//   1. the issue number -- the identity the owner actually reasons about, and
//      the only one two independent representations of the same work agree on;
//   2. an explicit namespaced clientRef, for work with no issue;
//   3. the task id, which at least keeps distinct work distinct.
//
// The identity is what dedupes, so it must be stable across restarts and must
// not depend on wording.
function canonicalIdentity(task, projectId) {
  // Issue identity FIRST. A clientRef is whatever the caller happened to stamp,
  // so two representations of the same issue with different refs deduped to two
  // independently decidable cards for one piece of work. The issue number is
  // the canonical identity the owner reasons about; the ref is only a fallback
  // for work that has no issue.
  var issue = issueNumberOf(task);
  if (issue) return { kind: "issue", key: projectId + "|issue#" + issue };
  var ref = typeof task.clientRef === "string" ? task.clientRef.trim() : "";
  if (ref) return { kind: "ref", key: projectId + "|" + ref };
  return { kind: "task", key: projectId + "|task:" + String(task.taskId || "") };
}

// The canonical topic this work belongs to, when the task carries the durable
// link. The sidebar index navigates by TopicRef, so the item must state it
// rather than leaving the client to guess from titles.
function topicRefOf(task) {
  var ref = task && task.coopTopicRef;
  if (!ref) return null;
  var topicId = String(ref.topicId || ref.topicKey || ref.id || ref.key || "").trim();
  return topicId ? { topicId: topicId } : null;
}

function issueNumberOf(task) {
  if (!task) return "";
  var direct = task.issueNumber || task.issue_number ||
    (task.source && (task.source.issueNumber || task.source.number));
  if (direct != null && String(direct).trim()) return String(direct).trim();
  // A namespaced clientRef of the form "...#2503" carries it too.
  var ref = typeof task.clientRef === "string" ? task.clientRef : "";
  var match = ref.match(/#(\d+)\s*$/);
  return match ? match[1] : "";
}

function linksFor(task) {
  var links = [];
  function push(label, url) {
    var clean = cleanText(url, "");
    if (!clean) return;
    for (var i = 0; i < links.length; i++) if (links[i].url === clean) return;
    links.push({ label: cleanText(label, "Link"), url: clean });
  }
  var issue = issueNumberOf(task);
  push(issue ? "Issue #" + issue : "Issue", task.issueUrl || task.issue_url);
  var pr = task.prNumber || task.pr_number;
  push(pr ? "PR #" + pr : "Pull request", task.prUrl || task.pr_url);
  return links;
}

// The exact thing the owner is being asked. A worker that asked a real question
// gets to phrase it; otherwise the durable status is stated plainly rather than
// dressed up.
var STATUS_DECISIONS = {
  needs_input: "Needs your decision",
  waiting_user: "Waiting for your answer",
  blocked: "Blocked -- needs you to unblock it",
  failed: "Failed -- decide whether to retry or drop it",
};

// Truncating at a fixed offset cuts mid-word ("... Registry questio"), which
// reads like corruption rather than an abbreviation. Back up to the last word
// boundary and mark the elision.
function truncateWords(text, limit) {
  if (text.length <= limit) return text;
  var cut = text.slice(0, limit);
  var space = cut.lastIndexOf(" ");
  // Only honour the boundary if it leaves a useful amount of text; a single
  // very long token (a URL) has no boundary to back up to.
  if (space > limit * 0.6) cut = cut.slice(0, space);
  return cut.replace(/[\s.,;:(\[-]+$/, "") + "…";
}

// Bare URLs are dropped: the item already carries the issue and PR as real,
// clickable links, so repeating a raw URL inside the question spends the row's
// entire width on something the owner cannot click.
function decisionText(value) {
  var stripped = String(value == null ? "" : value)
    .replace(/\(\s*https?:\/\/\S+\s*\)/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
  return truncateWords(cleanText(stripped, ""), MAX_DECISION);
}

function decisionFor(task) {
  var asked = decisionText(task.userQuestion);
  if (asked) return asked;
  var reason = decisionText(task.waitingReason);
  if (reason) return reason;
  return STATUS_DECISIONS[task.status] || "Needs your attention";
}

// An existing session for this work, so the item opens what the owner already
// has instead of creating a duplicate. Sessions record the task they belong to
// via orchestrationParent, which is the durable link.
function sessionIndexFor(project) {
  var index = {};
  var sessions = project && Array.isArray(project.sessions) ? project.sessions : [];
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    var parent = session && session.orchestrationParent;
    var taskId = parent && parent.taskId;
    if (taskId && !index[taskId]) index[taskId] = session;
  }
  return index;
}

function childrenIndex(tasks) {
  var byParent = {};
  for (var i = 0; i < tasks.length; i++) {
    var parentId = tasks[i] && tasks[i].parentTaskId;
    if (!parentId) continue;
    if (!byParent[parentId]) byParent[parentId] = [];
    byParent[parentId].push(tasks[i]);
  }
  return byParent;
}

// The destination is consumed verbatim by openResolvedGlobalSession, which
// requires exactly { ref, slug, localId } and returns false on anything else.
// An earlier shape ({ projectId, sessionStorageId, localId }) satisfied the
// queue's own tests but failed that guard silently, so tapping a row closed the
// sheet and went nowhere. Build the resolution the consumer actually accepts,
// and emit nothing rather than something unopenable.
function destinationFor(projectId, slug, session) {
  if (!session) return null;
  var storageId = session.storageId || session.cliSessionId || null;
  var localId = typeof session.localId === "number" ? session.localId : null;
  if (!storageId || localId == null || !slug) return null;
  return {
    ref: { projectId: projectId, sessionStorageId: storageId },
    slug: slug,
    localId: localId,
  };
}

// Detail panels need the typed worker evidence, not the sidebar-sized decision
// summary. Keep it reference-only and bounded: the task graph remains the
// source of truth, while the canonical worker SessionRef gives the owner a
// precise place to inspect the live record.
function workerDetailFor(task, projectRef, destination, sourceDestination, awaiting) {
  // A task-owned worker is preferred. If its session was compacted or is no
  // longer openable, the visible coordinator session that supplied the task is
  // the canonical source record. Do not emit raw task worker ids here: they may
  // point to a session the owner cannot open.
  var sessionRef = destination && destination.ref || sourceDestination && sourceDestination.ref || null;
  var sourceKind = destination && destination.ref ? "worker" :
    (sourceDestination && sourceDestination.ref ? "source" : "");
  var project = projectRef && projectRef.projectId ? { projectId: projectRef.projectId } : null;
  if (awaiting) {
    return {
      type: "worker_result",
      resolution: cleanText(task.resultSummary || task.resolutionSummary || task.currentActivity,
        "Worker reported completion"),
      verification: cleanText(task.verification, ""),
      projectRef: project,
      sessionRef: sessionRef ? { projectId: sessionRef.projectId, sessionStorageId: sessionRef.sessionStorageId } : null,
      sourceKind: sourceKind,
    };
  }
  return {
    type: "worker_question",
    question: cleanText(task.userQuestion || task.waitingReason || task.currentActivity,
      STATUS_DECISIONS[task.status] || "Needs your decision"),
    reason: cleanText(task.waitingReason, ""),
    projectRef: project,
    sessionRef: sessionRef ? { projectId: sessionRef.projectId, sessionStorageId: sessionRef.sessionStorageId } : null,
    sourceKind: sourceKind,
  };
}

// Builds the queue for one project. `project` is the shape the projection
// already works with: { projectRef, slug, title, sessions }.
function projectActionItems(project) {
  var projectRef = project && project.projectRef || null;
  var projectId = projectRef && projectRef.projectId || "";
  var items = [];
  var sessions = project && Array.isArray(project.sessions) ? project.sessions : [];
  var bySession = sessionIndexFor(project);

  for (var s = 0; s < sessions.length; s++) {
    var tasks = sessions[s] && Array.isArray(sessions[s].orchestrationTasks)
      ? sessions[s].orchestrationTasks : [];
    var byParent = childrenIndex(tasks);
    for (var t = 0; t < tasks.length; t++) {
      var task = tasks[t];
      if (!task) continue;
      var awaiting = isAwaitingAcceptance(task);
      if (!ATTENTION_STATUSES[task.status] && !awaiting) continue;
      // Machinery never becomes owner work; its leaves already will.
      if (isInternalCoordinator(task, byParent)) continue;

      var identity = canonicalIdentity(task, projectId);
      var existing = bySession[task.taskId] || null;
      var slug = cleanText(project.slug, "");
      var destination = destinationFor(projectId, slug, existing);
      var sourceDestination = destinationFor(projectId, slug, sessions[s]);
      items.push({
        itemId: identity.key,
        identity: identity,
        projectRef: projectRef,
        projectSlug: slug,
        projectTitle: cleanText(project.title || project.slug, "Project"),
        title: cleanText(task.title || task.objective, "Untitled work"),
        // Acceptance items ask a different question from a blocked one.
        kind: awaiting ? "acceptance" : "decision",
        decision: awaiting
          ? (decisionText(task.resolutionSummary) ||
             "Finished and waiting for you to accept it, or send it back")
          : decisionFor(task),
        // Concise supporting context for the decision panel. Reference-only,
        // like everything else here: the coordinator's own summary of where the
        // work stands, never transcript bodies.
        evidence: cleanText(task.resolutionSummary || task.currentActivity || "", ""),
        status: cleanText(task.status, "needs_input"),
        taskId: String(task.taskId || ""),
        // Canonical topic linkage, so the owner index can open the topic this
        // decision lives in rather than duplicating it as a second inventory.
        topicRef: topicRefOf(task),
        // Where the owner lands. An existing session wins: the item must not
        // invite a second session for work that already has one.
        destination: destination,
        // Reflects an OPENABLE session, not merely a linked one: a row that
        // claims a session but cannot open it is worse than one that routes to
        // the project.
        hasExistingSession: !!destination,
        workerDetail: workerDetailFor(task, projectRef, destination, sourceDestination, awaiting),
        links: linksFor(task),
        updatedAt: typeof task.updatedAt === "number" ? task.updatedAt
          : (typeof task.createdAt === "number" ? task.createdAt : 0),
      });
    }
  }
  return items;
}

// One item per canonical identity. When the same work surfaces more than once,
// the entry that already has a session wins, then the most recently updated --
// so the owner is sent to the live thing rather than a stale duplicate.
function dedupeByIdentity(items) {
  var byKey = {};
  var order = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var seen = byKey[item.itemId];
    if (!seen) {
      byKey[item.itemId] = item;
      order.push(item.itemId);
      continue;
    }
    var better = (item.topicRef && !seen.topicRef) ||
      (!!item.topicRef === !!seen.topicRef &&
        ((item.hasExistingSession && !seen.hasExistingSession) ||
         (item.hasExistingSession === seen.hasExistingSession && item.updatedAt > seen.updatedAt)));
    if (better) byKey[item.itemId] = mergeLinks(item, seen);
    else byKey[item.itemId] = mergeLinks(seen, item);
  }
  return order.map(function (key) { return byKey[key]; });
}

// Keep every link either copy knew about: an item that found the PR and one
// that found the issue describe the same work from different angles.
function mergeLinks(winner, other) {
  var links = winner.links.slice();
  for (var i = 0; i < other.links.length; i++) {
    var candidate = other.links[i];
    var duplicate = false;
    for (var j = 0; j < links.length; j++) if (links[j].url === candidate.url) duplicate = true;
    if (!duplicate) links.push(candidate);
  }
  return Object.assign({}, winner, { links: links });
}

// Stable ordering: oldest waiting first, so the queue does not reshuffle under
// the owner while they work down it, with the identity as a deterministic
// tiebreak.
function sortItems(items) {
  return items.slice().sort(function (a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
    return a.itemId < b.itemId ? -1 : (a.itemId > b.itemId ? 1 : 0);
  });
}

// The whole queue, across every project the caller says the owner may see.
function buildActionQueue(projects, options) {
  var opts = options || {};
  var list = Array.isArray(projects) ? projects : [];
  var collected = [];
  for (var i = 0; i < list.length; i++) {
    var project = list[i];
    if (typeof opts.canAccessProject === "function" && !opts.canAccessProject(project)) continue;
    collected = collected.concat(projectActionItems(project));
  }
  return sortItems(dedupeByIdentity(collected)).slice(0, MAX_ITEMS);
}

module.exports = {
  ATTENTION_STATUSES: ATTENTION_STATUSES,
  MAX_ITEMS: MAX_ITEMS,
  buildActionQueue: buildActionQueue,
  canonicalIdentity: canonicalIdentity,
  decisionFor: decisionFor,
  dedupeByIdentity: dedupeByIdentity,
  isInternalCoordinator: isInternalCoordinator,
  issueNumberOf: issueNumberOf,
  projectActionItems: projectActionItems,
  sortItems: sortItems,
};
