var projectIdentity = require("./project-identity");
var coopTopicIndex = require("./coop-topic-index");
var topicLineage = require("./coop-topic-lineage");
var coopActionQueue = require("./coop-action-queue");
var coopNowIndex = require("./coop-now-index");
var ownerSidebarProjection = require("./coop-owner-sidebar-projection");
var ownerSidebarPriority = require("./coop-owner-sidebar-priority");
var ownerWorkIdentity = require("./coop-owner-work-identity");
var coopControlProvenance = require("./coop-control-provenance");
var isCoopControlled = coopControlProvenance.isCoopControlled;
var normalizeControlledBy = coopControlProvenance.normalizeControlledBy;
var coopControlPlane = require("./coop-control-plane");
var coopControlSessionProjection = require("./coop-control-session-projection");
var clientTopicProjection = require("./global-coop-topic-client");
var coordinatorTreeProjection =
  require("./global-coop-coordinator-tree").attachGlobalCoopCoordinatorTree({
    canAccessSession: canAccessSession,
    cleanText: cleanText,
    sessionList: sessionList,
  });

var MAX_ITEMS = 4;
var MAX_TEXT = 240;
var ACTIVE_STATUSES = { queued: true, ready: true, running: true, reviewing: true };
var ATTENTION_STATUSES = { blocked: true, failed: true, needs_input: true, waiting_user: true };
function cleanText(value, fallback) {
  var text = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return text || fallback || "";
}
function projectContexts(projects) {
  if (Array.isArray(projects)) return projects.slice();
  var list = [];
  if (projects && typeof projects.forEach === "function") {
    projects.forEach(function (project) { list.push(project); });
  }
  return list;
}
function projectStatus(project) {
  return project && typeof project.getStatus === "function" ? project.getStatus() : project || {};
}
function projectIdFor(project, status) {
  var projectId = project && project.projectId || status && status.projectId;
  return projectIdentity.isProjectId(projectId) ? projectId : null;
}
function sessionManager(project) {
  if (project && typeof project.getSessionManager === "function") return project.getSessionManager();
  return project && project.sm || null;
}
function sessionList(project) {
  var manager = sessionManager(project);
  var sessions = manager && manager.sessions;
  var list = [];
  if (sessions && typeof sessions.forEach === "function") {
    sessions.forEach(function (session) { list.push(session); });
  }
  return list;
}
function projectForSession(project, session) {
  var runtimes = project && project._coopRuntimeProjects;
  if (!Array.isArray(runtimes)) return project;
  for (var i = 0; i < runtimes.length; i++) {
    if (sessionList(runtimes[i]).indexOf(session) !== -1) return runtimes[i];
  }
  return project;
}
function canAccessProject(options, project) {
  return !options.canAccessProject || options.canAccessProject(options.actor, project);
}
function canAccessSession(options, project, session) {
  if (!session || session.hidden) return false;
  var owner = projectForSession(project, session);
  return !options.canAccessSession || options.canAccessSession(options.actor, owner, session);
}
function isConfiguredProject(status, projectId) {
  return !!(projectId && projectId !== projectIdentity.LEAD_PROJECT_ID && status &&
    !status.isMate && !status.isWorktree);
}

function runtimeProjectsFor(contexts, projectId) {
  var result = [];
  for (var i = 0; i < contexts.length; i++) {
    if (projectIdFor(contexts[i], projectStatus(contexts[i])) === projectId) {
      result.push(contexts[i]);
    }
  }
  return result;
}

function projectWithRuntimeSessions(project, runtimes) {
  var members = Array.isArray(runtimes) ? runtimes : [];
  if (members.length <= 1) return project;
  var sessions = new Map();
  for (var ri = 0; ri < members.length; ri++) {
    var list = sessionList(members[ri]);
    for (var si = 0; si < list.length; si++) {
      sessions.set(String(ri) + ":" + sessionStorageId(list[si]), list[si]);
    }
  }
  var aggregate = Object.assign({}, project);
  var sourceManager = sessionManager(project);
  // Projection reads every sibling runtime, but control-plane maintenance still
  // writes to the canonical parent manager. Keep that operational manager
  // surface intact instead of exposing a read-only { sessions } facade.
  var aggregateManager = { sessions: sessions };
  if (sourceManager) {
    Object.keys(sourceManager).forEach(function (key) {
      aggregateManager[key] = typeof sourceManager[key] === "function"
        ? sourceManager[key].bind(sourceManager)
        : sourceManager[key];
    });
    aggregateManager.sessions = sessions;
  }
  aggregate._coopRuntimeProjects = members;
  aggregate.getSessionManager = function () { return aggregateManager; };
  return aggregate;
}

function taskTitle(task) {
  return cleanText(task && (task.title || task.objective), "Delegated work");
}

function taskActivity(task) {
  return cleanText(task && (task.currentActivity || task.userQuestion || task.waitingReason), "");
}

function taskSummary(task) {
  return {
    title: taskTitle(task),
    status: cleanText(task && task.status, "unknown"),
    activity: taskActivity(task),
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : null,
  };
}

function sessionStorageId(session) {
  return session && (session.storageId || session.cliSessionId) || null;
}

function parentStorageId(session) {
  var parent = session && (session.orchestrationGroupParent || session.orchestrationParent);
  return parent && parent.sessionStorageId || null;
}

function isProjectedProjectCoordinator(options, project, session) {
  var controlledBy = normalizeControlledBy(session && session.coopControlledBy);
  return !!(options.expectedCoopStorageId && canAccessSession(options, project, session) &&
    !(session && (session.orchestrationGroupParent || session.orchestrationParent)) &&
    session.coordinationRole === "project_coordinator" && isCoopControlled(session) &&
    controlledBy && controlledBy.coopSessionStorageId === options.expectedCoopStorageId);
}

function pushBounded(list, value) {
  if (value && list.length < MAX_ITEMS) list.push(value);
}

function summaryForProject(options, project) {
  var goals = [];
  var decisions = [];
  var activeWork = [];
  var attention = [];
  var outcomes = [];
  var freshestAt = 0;
  var hasProjectedProjectCoordinator = false;
  var sessions = sessionList(project);
  for (var i = 0; i < sessions.length; i++) {
    var session = sessions[i];
    if (!isProjectedProjectCoordinator(options, project, session)) continue;
    hasProjectedProjectCoordinator = true;
    freshestAt = Math.max(freshestAt, session.lastActivity || 0, session.lastViewedAt || 0);
    var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
    for (var ti = 0; ti < tasks.length; ti++) {
      var task = tasks[ti] || {};
      var status = cleanText(task.status, "unknown");
      freshestAt = Math.max(freshestAt, task.updatedAt || task.createdAt || 0);
      if (ACTIVE_STATUSES[status]) {
        pushBounded(activeWork, taskSummary(task));
        pushBounded(goals, cleanText(task.objective || task.title, "Current project goal"));
      }
      if (ATTENTION_STATUSES[status] || task.userQuestion || task.waitingReason) {
        pushBounded(attention, taskSummary(task));
      }
    }
    var completion = session.orchestrationProjectCompletion;
    if (completion && completion.status === "completed" && completion.summary) {
      pushBounded(outcomes, {
        summary: cleanText(completion.summary, "Verified project outcome"),
        verifiedAt: typeof completion.completedAt === "number" ? completion.completedAt : null,
      });
      freshestAt = Math.max(freshestAt, completion.completedAt || 0);
    }
  }
  var projectId = projectIdFor(project, projectStatus(project));
  var tree = coordinatorTreeProjection.build(options, project, projectId);
  // Control-plane executions live in the Lead root while their canonical
  // task-coordinator sessions live in the target project. In that shape there
  // is no target-local project-coordinator session for the summary loop above
  // to inspect, even though the exact tree already proved the live binding.
  // Project only those proven tree descendants; never infer activity from a
  // loose session or from terminal/hidden records that the tree rejected.
  if (!hasProjectedProjectCoordinator) {
    function addTreeActivity(node) {
      if (!node) return;
      var status = cleanText(node.status, "");
      var role = cleanText(node.role, "");
      if (role === "task_coordinator" || role === "worker") {
        freshestAt = Math.max(freshestAt, node.updatedAt || 0);
        if (ACTIVE_STATUSES[status]) pushBounded(activeWork, {
          title: cleanText(node.title, "Delegated work"),
          status: status,
          activity: cleanText(node.activity, ""),
          updatedAt: typeof node.updatedAt === "number" ? node.updatedAt : null,
        });
        if (ATTENTION_STATUSES[status]) pushBounded(attention, {
          title: cleanText(node.title, "Delegated work"),
          status: status,
          activity: cleanText(node.activity, ""),
          updatedAt: typeof node.updatedAt === "number" ? node.updatedAt : null,
        });
      }
      var children = Array.isArray(node.children) ? node.children : [];
      for (var ci = 0; ci < children.length; ci++) addTreeActivity(children[ci]);
    }
    var coordinators = Array.isArray(tree.coordinators) ? tree.coordinators : [];
    for (var ri = 0; ri < coordinators.length; ri++) addTreeActivity(coordinators[ri]);
  }
  var health = attention.length > 0 ? "attention" :
    (tree.activeCoordinatorCount > 0 ? "active" : "quiet");
  var nextAction = attention.length > 0
    ? "Open this project channel to resolve attention."
    : (activeWork.length > 0
      ? "Open this project channel to review active delegated work."
      : "Open this project channel to set the next action.");
  return {
    goals: goals,
    decisions: decisions,
    activeWork: activeWork,
    attention: attention,
    outcomes: outcomes,
    freshness: { updatedAt: freshestAt || null, stale: !freshestAt },
    nextAction: nextAction,
    metrics: {
      activeCoordinators: tree.activeCoordinatorCount,
      activeWorkers: tree.taskCoordinatorCount,
      activeTaskWorkers: tree.workerCount,
      health: health,
    },
    coordinatorTree: tree.coordinators,
  };
}

function coopHome(options, leadProject, leadProjectId) {
  var sessions = sessionList(leadProject);
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i].coopHome && canAccessSession(options, leadProject, sessions[i])) {
      return {
        sessionRef: projectIdentity.sessionRef({ projectId: leadProjectId }, sessions[i]),
        localId: sessions[i].localId,
        title: "Coop",
      };
    }
  }
  return null;
}

function projectChannelProjection(options, leadProject, project, status, projectId) {
  var coop = coopHome(options, leadProject, projectIdentity.LEAD_PROJECT_ID);
  if (!coop || !coop.sessionRef) return null;
  var summaryOptions = Object.assign({}, options, {
    expectedCoopStorageId: coop.sessionRef.sessionStorageId,
    leadProject: leadProject,
  });
  return {
    projectRef: { projectId: projectId },
    slug: cleanText(status.slug || project.slug, ""),
    title: cleanText(status.title || status.project || project.project, "Project"),
    icon: cleanText(status.icon, ""),
    channel: {
      sessionRef: coop.sessionRef,
      localId: coop.localId,
      isLens: true,
    },
    summary: summaryForProject(summaryOptions, project),
  };
}

function canonicalCoopSession(leadProject) {
  var sessions = sessionList(leadProject);
  for (var i = 0; i < sessions.length; i++) {
    if (sessions[i] && sessions[i].coopHome && !sessions[i].hidden) return sessions[i];
  }
  return null;
}

// This is intentionally safe to call from the terminal-event path. The index
// cursor makes subsequent calls scan only a newly completed canonical turn.
function advanceCanonicalCoopTopics(options, canonicalSession) {
  var opts = options || {};
  var contexts = projectContexts(opts.projects);
  var leadProject = null;
  for (var i = 0; i < contexts.length; i++) {
    var status = projectStatus(contexts[i]);
    if (projectIdFor(contexts[i], status) === projectIdentity.LEAD_PROJECT_ID) {
      leadProject = contexts[i];
      break;
    }
  }
  var session = canonicalSession || canonicalCoopSession(leadProject);
  if (!leadProject || !session || !session.coopHome) {
    return { ok: false, code: "canonical_coop_required" };
  }
  var current = canonicalCoopSession(leadProject);
  if (current && sessionStorageId(current) !== sessionStorageId(session)) {
    return { ok: false, code: "canonical_session_mismatch" };
  }
  var index = opts.coopTopicIndex || coopTopicIndex.getDefaultTopicIndex();
  var retro = index.ensureRetro(session, {
    projects: contexts,
    expectedCanonicalStorageId: opts.expectedCoopTopicStorageId || null,
  });
  // The one daemon path proven to run with the real cached canonical session
  // (topics render through here), so the exactly-once title migration lives
  // here rather than behind message-ingress routing that genuine owner Coop
  // traffic bypassed. Stamped in the index: a completed migration is a single
  // property check per projection.
  if (retro.ok && typeof index.ensureTitleRetrofit === "function") {
    index.ensureTitleRetrofit(session);
  }
  // Same exactly-once contract again, and deliberately ordered AFTER the title
  // retrofit and BEFORE the disposition backfill. After it, because consolidation
  // groups on settled titles and keywords; before it, because a fragment folded
  // into its conversation must not first be handed its own "unlinked_historical"
  // needs-input record -- that would put the row back on the owner's screen as a
  // question, which is the sprawl this pass exists to remove.
  if (retro.ok && typeof index.ensureTopicConsolidation === "function") {
    index.ensureTopicConsolidation(session);
  }
  // Same exactly-once contract for the disposition backfill: after this every
  // projectable topic either derives live state from linked tasks or carries a
  // durable owner-disposition record, so no row can render blank.
  if (retro.ok && typeof index.ensureDispositionBackfill === "function") {
    index.ensureDispositionBackfill(session);
  }
  return retro;
}

function projectContextFor(contexts, projectId) {
  var fallback = null;
  for (var i = 0; i < contexts.length; i++) {
    var project = contexts[i];
    var status = projectStatus(project);
    if (projectIdFor(project, status) !== projectId) continue;
    if (!fallback) fallback = project;
    if (!status.isWorktree) return project;
  }
  return fallback;
}

// Resolves a topic's linked session to a link the sidebar may show. It answers
// "topLevel" only for an accessible, existing, parentless project session, so
// worker sessions and revoked projects fail closed to no link at all.
function relatedSessionResolver(options, contexts) {
  return function (projectRef, sessionRef) {
    var runtimes = runtimeProjectsFor(contexts, projectRef.projectId);
    for (var ri = 0; ri < runtimes.length; ri++) {
      var project = runtimes[ri];
      if (!canAccessProject(options, project)) continue;
      var sessions = sessionList(project);
      for (var i = 0; i < sessions.length; i++) {
        var session = sessions[i];
        if (sessionStorageId(session) !== sessionRef.sessionStorageId) continue;
        if (!canAccessSession(options, project, session)) return null;
        if (parentStorageId(session)) return null;
        return { topLevel: true, title: cleanText(session.title, "Project session") };
      }
    }
    return null;
  };
}

function topicProjection(options, contexts, leadProject) {
  var session = canonicalCoopSession(leadProject);
  if (!session || !canAccessSession(options, leadProject, session)) return null;
  var replaySession = topicLineage.buildReplaySession(session, sessionList(leadProject));
  var index = options.coopTopicIndex || coopTopicIndex.getDefaultTopicIndex();
  var retro = advanceCanonicalCoopTopics(options, replaySession || session);
  if (!retro.ok) return null;
  return index.project({
    actor: options.actor,
    summaryOnly: true,
    // The canonical transcript, so the projection can drop a topic whose only
    // memberships are internal turns and would open onto an empty lens.
    history: replaySession || session,
    computeTopicState: options.computeCoopTopicState,
    resolveRelatedSession: relatedSessionResolver(options, contexts),
    canAccessProject: function (actor, ref) {
      var project = projectContextFor(contexts, ref.projectId);
      return !!project && canAccessProject(options, project);
    },
  });
}

function canonicalReplay(leadProject) {
  var canonical = canonicalCoopSession(leadProject);
  return topicLineage.buildReplaySession(canonical, sessionList(leadProject)) || canonical;
}

function buildGlobalCoopProjection(options) {
  var opts = options || {};
  var contexts = projectContexts(opts.projects);
  var leadProject = null;
  var configured = [];
  for (var i = 0; i < contexts.length; i++) {
    var status = projectStatus(contexts[i]);
    var projectId = projectIdFor(contexts[i], status);
    if (projectId === projectIdentity.LEAD_PROJECT_ID) leadProject = contexts[i];
    if (isConfiguredProject(status, projectId) && canAccessProject(opts, contexts[i])) {
      configured.push({ project: contexts[i], status: status, projectId: projectId });
    }
  }
  for (var ci = 0; ci < configured.length; ci++) {
    configured[ci].project = projectWithRuntimeSessions(configured[ci].project,
      runtimeProjectsFor(contexts, configured[ci].projectId));
  }
  if (!leadProject || !canAccessProject(opts, leadProject)) {
    return { type: "global_coop_projection", coop: null, projects: [], topics: [], threads: [],
      topicProjection: null, actionQueue: [], nowIndex: [] };
  }
  if (typeof opts.ensureControlPlane === "function") {
    opts.ensureControlPlane({
      leadManager: sessionManager(leadProject),
      projects: configured.map(function (item) {
        return {
          projectRef: { projectId: item.projectId },
          title: cleanText(item.status.title || item.status.project || item.project.project, "Project"),
          manager: sessionManager(item.project),
        };
      }),
    });
  }
  // Threads must be projected before project coordinator trees: a successful
  // handoff moves the same canonical ThreadRef out of the top-level Threads
  // list and into the matching ProjectRef-bound coordinator as a container.
  var indexedTopics = topicProjection(opts, contexts, leadProject);
  var topics = clientTopicProjection.clientTopics(indexedTopics);
  var controlPlane = coopControlSessionProjection.projectControlPlane(Object.assign({}, opts, {
    coopThreads: topics,
  }), contexts, leadProject);
  coopControlSessionProjection.attachResults(topics, controlPlane.results);
  var projectionOptions = Object.assign({}, opts, { coopThreads: topics });
  var projects = [];
  // Raw, ACL-filtered project contexts for the owner queue. It reads
  // orchestration tasks and sessions directly, which the client-facing channel
  // projection deliberately does not carry.
  var queueProjects = [];
  // Canonical Coop can itself hold a typed plan decision. It is not an
  // implementation project, but omitting it here made a deliberately staged
  // owner choice durable yet invisible to the same popup queue as approvals.
  if (canAccessProject(opts, leadProject)) {
    var leadStatus = projectStatus(leadProject);
    queueProjects.push({
      projectRef: { projectId: projectIdentity.LEAD_PROJECT_ID },
      slug: leadStatus && leadStatus.slug || "lead",
      title: leadStatus && (leadStatus.title || leadStatus.project) || "Coop",
      sessions: sessionList(leadProject).filter(function (session) {
        return canAccessSession(opts, leadProject, session);
      }),
    });
  }
  for (var pi = 0; pi < configured.length; pi++) {
    var item = configured[pi];
    var projection = projectChannelProjection(projectionOptions, leadProject,
      item.project, item.status, item.projectId);
    if (projection) projects.push(projection);
    if (!canAccessProject(opts, item.project)) continue;
    queueProjects.push({
      projectRef: { projectId: item.projectId },
      slug: item.status && item.status.slug || "",
      title: item.status && (item.status.title || item.status.project) || "",
      sessions: sessionList(item.project).filter(function (session) {
        return canAccessSession(opts, item.project, session);
      }),
    });
  }
  var actionQueue = opts.includeActionQueue === false
    ? [] : coopActionQueue.buildActionQueue(queueProjects, {});
  var nowIndex = coopNowIndex.buildNowIndex(topics, actionQueue);
  var replay = canonicalReplay(leadProject);
  var requestContexts = ownerWorkIdentity.requestContexts(opts.ownerRequests, replay);
  var projectTitles = configured.map(function (item) {
    return { projectRef: { projectId: item.projectId }, title: cleanText(
      item.status.title || item.status.project || item.project.project, "Project") };
  });
  // The Coop Session Context is an owner-request ledger, not a thread/activity
  // summary. Feed it the durable records directly: topic/tree state remains
  // useful navigation context but cannot relabel historical execution as live.
  var ownerSidebar = ownerSidebarProjection.buildOwnerSidebar({
    requests: Array.isArray(opts.ownerRequests) ? opts.ownerRequests : [],
    topics: topics,
    sessions: Array.isArray(opts.ownerLedgerSessions) ? opts.ownerLedgerSessions : [],
    executionBindings: Array.isArray(opts.portfolioBindings) ? opts.portfolioBindings : [],
    actionQueue: actionQueue,
    requestContexts: requestContexts,
    projectTitles: projectTitles,
    visibility: opts.ownerSidebarVisibility || ownerSidebarPriority.priorityRecord(),
  });
  return {
    type: "global_coop_projection",
    // Top-level owner queue: what needs the boss, across every project they can
    // see, without entering any of them.
    // Owner-only. Defaults to on so existing server-side callers and tests keep
    // working; server.js supplies the connected-owner answer.
    actionQueue: actionQueue,
    // The link-only "Now" index: genuinely current topics only -- owner
    // attention first, then actively working -- one entry per canonical
    // TopicRef, quiet historical and terminal work excluded.
    nowIndex: nowIndex,
    ownerSidebar: ownerSidebar,
    coop: coopHome(opts, leadProject, projectIdentity.LEAD_PROJECT_ID),
    controlPlaneSessions: controlPlane.sessions,
    controlPlaneResults: controlPlane.results,
    projects: projects,
    topics: topics,
    threads: topics,
    topicProjection: indexedTopics,
  };
}

module.exports = {
  advanceCanonicalCoopTopics: advanceCanonicalCoopTopics,
  buildGlobalCoopProjection: buildGlobalCoopProjection,
  summaryForProject: summaryForProject,
};
