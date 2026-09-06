// Daemon-owned maintenance uses the complete runtime inventory and each
// session's actual manager. Dashboard readers never acquire these capabilities.
var identity = require("./project-identity");
var plane = require("./coop-control-plane");
var topics = require("./global-coop-projection");
var topicLineage = require("./coop-topic-lineage");
var visibility = require("./coop-session-visibility");
var sessionLedger = require("./coop-session-ledger");
var historyStore = require("./sessions-history-store");

function inventory(projects) {
  var contexts = [];
  projects.forEach(function (project) {
    var status = project.getStatus();
    var manager = project.getSessionManager();
    if (manager) contexts.push({ project: project, status: status, manager: manager });
  });
  var leads = contexts.filter(function (item) { return item.status.projectId === identity.LEAD_PROJECT_ID; });
  if (leads.length !== 1) return null;
  var parents = contexts.filter(function (item) {
    return identity.isProjectId(item.status.projectId) && item.status.projectId !== identity.LEAD_PROJECT_ID &&
      !item.status.isMate && !item.status.isWorktree;
  });
  var targets = [];
  parents.forEach(function (parent) {
    var id = parent.status.projectId;
    if (parents.filter(function (item) { return item.status.projectId === id; }).length !== 1) {
      throw new Error("ambiguous_canonical_project");
    }
    contexts.forEach(function (item) {
      if (item.status.projectId !== id) return;
      targets.push({ projectRef: { projectId: id }, title: parent.status.title || parent.status.project || "Project",
        manager: item.manager, project: item.project });
    });
  });
  return { lead: leads[0], targets: targets, contexts: contexts };
}

function createControlMaintenance(options) {
  var pending = null;
  var interval = null;
  var running = false;
  var stopped = false;
  var lastFailure = null;
  var lastTopicKey = null;
  var schedule = options.setTimeout || setTimeout;
  var cancel = options.clearTimeout || clearTimeout;
  var repeat = options.setInterval || setInterval;
  var cancelRepeat = options.clearInterval || clearInterval;
  function migrateBinding(item, from, to) {
    var router = options.crossProject;
    if (!router || typeof router.rebindProjectCoordinator !== "function") {
      return { ok: false, reason: "binding_migration_unavailable" };
    }
    var requests = options.ownerRequests;
    var claims = requests && requests.listCoordinators ? requests.listCoordinators() : [];
    for (var i = 0; i < claims.length; i++) {
      var claim = claims[i];
      if (!claim || claim.projectId !== item.projectRef.projectId || !claim.coordinator ||
          claim.coordinator.projectId !== from.projectId || claim.coordinator.sessionStorageId !== from.sessionStorageId) continue;
      var result = requests.transferCoordinator({ topicRef: { topicId: claim.topicId }, projectRef: item.projectRef,
        from: from, to: to, reason: "coop_control_plane_migration" });
      if (!result || !result.ok) return result;
      break; // transferCoordinator moves every claim for this project atomically.
    }
    return router.rebindProjectCoordinator(item.projectRef, from, to);
  }
  function reconcileArchives(view) {
    var count = 0;
    view.lead.manager.sessions.forEach(function (root) {
      var policy = plane.projectCoordinatorPolicy(root);
      if (!policy || root._deleted) return;
      var rootRef = identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, root);
      if (!rootRef) return;
      (root.orchestrationTasks || []).forEach(function (task) {
        if (!task.externalTaskCoordinator || task.status !== "dismissed" || !task.archivedAt) return;
        var ref = identity.normalizeSessionRef(task.workerSessionRef || {
          projectId: policy.projectRef && policy.projectRef.projectId, sessionStorageId: task.workerStorageId });
        if (!ref || !policy.projectRef || ref.projectId !== policy.projectRef.projectId) return;
        var matches = [];
        view.targets.forEach(function (target) {
          if (target.projectRef.projectId !== ref.projectId) return;
          target.manager.sessions.forEach(function (session) {
            if (!session._deleted && identity.sessionStorageId(session) === ref.sessionStorageId) {
              matches.push({ target: target, session: session });
            }
          });
        });
        if (matches.length !== 1) return;
        var found = matches[0];
        var parent = identity.normalizeSessionRef(found.session.projectCoordinatorRef);
        if (!parent || parent.projectId !== rootRef.projectId || parent.sessionStorageId !== rootRef.sessionStorageId) return;
        if (visibility.hideDismissedSession(found.target.project, found.session, task)) count++;
      });
    });
    return count;
  }
  function advanceTopics(view, projects, reason) {
    var home = plane.canonicalCoop(view.lead.manager);
    if (home.isProcessing) return { ok: true, changed: false, deferred: true };
    var indexed = new Map();
    view.lead.manager.sessions.forEach(function (session) { indexed.set(identity.sessionStorageId(session), session); });
    var chain = [];
    var seen = new Set();
    var current = home;
    while (current) {
      var id = identity.sessionStorageId(current);
      if (seen.has(id)) throw new Error("topic_lineage_cycle");
      seen.add(id); chain.push(current);
      if (!current.compactedFromStorageId) break;
      current = indexed.get(current.compactedFromStorageId);
      if (!current) throw new Error("topic_lineage_unavailable");
    }
    function signature() {
      return JSON.stringify([chain.map(function (session) {
        return [identity.sessionStorageId(session), historyStore.generation(session), historyStore.historyLength(session)];
      }), view.targets.map(function (target) { return [target.projectRef.projectId, target.title]; })]);
    }
    if (reason !== "canonical_turn" && signature() === lastTopicKey) return { ok: true, changed: false };
    var cold = chain.filter(function (session) { return historyStore.isLazy(session) && !historyStore.isResident(session); });
    var result;
    try {
      var replay = topicLineage.buildReplaySession(home, view.lead.manager.sessions) || home;
      result = topics.advanceCanonicalCoopTopics({ projects: projects, coopTopicIndex: options.topicIndex }, replay);
    } finally { cold.forEach(function (session) { historyStore.release(session); }); }
    if (result && result.ok) lastTopicKey = signature();
    return result;
  }
  function run(reason) {
    if (stopped || running || !options.isReady()) return { ok: true, deferred: true };
    running = true;
    try {
      var projects = options.projects();
      var view = inventory(projects);
      if (!view || !plane.canonicalCoop(view.lead.manager)) return { ok: true, deferred: true };
      var ensured = { ok: true, changed: false };
      if (options.isLeadModeEnabled()) {
        view.targets.forEach(function (item) {
          item.migrateBinding = function (from, to) { return migrateBinding(item, from, to); };
        });
        ensured = plane.ensureControlPlane(view.lead.manager, view.targets);
        if (!ensured.ok) throw new Error(ensured.reason || "control_plane_unavailable");
        if (ensured.changed) view.lead.manager.broadcastSessionList();
        if (ensured.migrations && ensured.migrations.length) view.targets.forEach(function (item) {
          item.manager.broadcastSessionList();
        });
      }
      var advanced = advanceTopics(view, projects, reason);
      if (!advanced || !advanced.ok) throw new Error(advanced && advanced.code || "topic_maintenance_failed");
      if (options.crossProject.reconcileCoordinatorResolutions) options.crossProject.reconcileCoordinatorResolutions();
      var archived = reconcileArchives(view);
      var links = sessionLedger.topicLinksFromIndex(options.topicIndex.load());
      var reconciled = options.crossProject.reconcileSessionLedger({ topicLinks: links });
      if (!reconciled || !reconciled.ok) throw new Error(reconciled && reconciled.reason || "session_ledger_unavailable");
      lastFailure = null;
      var result = { ok: true, changed: !!(ensured.changed || advanced.changed || archived || reconciled.changed),
        archived: archived, reason: reason || "maintenance" };
      if (result.changed && options.onUpdated && reason !== "canonical_turn") options.onUpdated(result);
      return result;
    } catch (error) {
      var code = error.message || "control_maintenance_failed";
      if (code !== lastFailure && options.recordFailure) options.recordFailure(code);
      lastFailure = code;
      return { ok: false, reason: code };
    } finally { running = false; }
  }
  function request(reason) {
    if (stopped || pending) return;
    pending = schedule(function () { pending = null; run(reason); }, 50);
    if (pending && pending.unref) pending.unref();
  }
  function start() {
    if (interval || stopped) return;
    interval = repeat(function () { run("retry"); }, options.intervalMs || 5000);
    if (interval && interval.unref) interval.unref();
    request("startup");
  }
  function stop() {
    stopped = true;
    if (pending) cancel(pending);
    if (interval) cancelRepeat(interval);
    pending = null;
    interval = null;
  }
  return { run: run, request: request, start: start, stop: stop };
}

module.exports = { createControlMaintenance: createControlMaintenance };
