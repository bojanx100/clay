var fs = require("fs");
var path = require("path");
var config = require("./config");
var cleanupPolicy = require("./coop-self-cleanup");
var normalizeControlledBy = require("./coop-control-provenance").normalizeControlledBy;
var leadBacklog = require("./lead-backlog");
var leadLedger = require("./lead-ledger");
var leadLoop = require("./lead-loop");
var ownerRequests = require("./coop-owner-requests");
var portfolioBindings = require("./portfolio-execution-bindings");
var createMaintenanceRetry = require("./coop-self-cleanup-retry").createMaintenanceRetry;

var AUDIT_TYPE = "coop_self_cleanup_audit";
var DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
var LEAD_WAKE_INTERVAL_MS = 15 * 60 * 1000;
var LEAD_WAKE_PROMPT = "Run one Lead tick now. Continue the admitted backlog autonomously. " +
  "Staff, verify, close, and advance safe work; ask the owner only for genuine approval-class decisions.";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function storageIdForSession(session) {
  return session && (session.storageId || session.cliSessionId) || null;
}

function targetKey(target) {
  if (target && target.storageId) return "storage:" + target.storageId;
  if (target && target.localId != null) return "local:" + target.localId;
  return "unknown";
}

function actionKey(projectSlug, item) {
  var target = item && item.target || {};
  return [projectSlug, item.operation, targetKey(target), target.taskId || ""].join("|");
}

function recordsFromLoad(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.events)) return value.events;
  return [];
}

var ACTIVE_STATUSES = { queued: true, ready: true, running: true, reviewing: true };
var ATTENTION_STATUSES = { blocked: true, needs_input: true, waiting_user: true, failed: true };

function auditFileForProject(projectSlug) {
  var safeSlug = String(projectSlug || "unknown-project").replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(config.CONFIG_DIR, "coop-self-cleanup", safeSlug + ".jsonl");
}

function createFilePersistence(projectSlug) {
  var file = auditFileForProject(projectSlug);
  return {
    load: function () {
      var lines;
      try { lines = fs.readFileSync(file, "utf8").split("\n"); } catch (e) { return []; }
      var events = [];
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        try {
          var event = JSON.parse(lines[i]);
          if (event && event.type === AUDIT_TYPE) events.push(event);
        } catch (e) {}
      }
      return events;
    },
    append: function (event) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(event) + "\n");
      return event;
    },
  };
}

function openLeadItems() {
  var file = path.join(config.CONFIG_DIR, "lead", "items.json");
  var items;
  try { items = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  if (Array.isArray(items)) return items;
  if (items && Array.isArray(items.items)) return items.items;
  return [];
}

function hasAnswerableOwnerRequest() {
  var requests = ownerRequests.getDefaultOwnerRequests().unanswered();
  for (var i = 0; i < requests.length; i++) {
    var state = requests[i] && requests[i].state;
    if (state !== "needs_input" && state !== "attention") return true;
  }
  return false;
}

function hasOpenLeadItem() {
  var items = openLeadItems();
  for (var i = 0; i < items.length; i++) {
    var normalized = leadBacklog.normalizeLooseItem(items[i], items[i] && items[i].project);
    var legacyState = String(items[i] && (items[i].state || items[i].status) || "")
      .trim().toLowerCase();
    if (normalized && normalized.state === "open") return true;
    if (legacyState === "pending" || legacyState === "ready") return true;
  }
  return false;
}

function hasTypedWork() {
  var loaded = portfolioBindings.readPortfolioExecutionBindings();
  if (!loaded.ok) return true;
  var records = loaded.bindings;
  for (var i = 0; i < records.length; i++) {
    if (leadLoop.bindingConsumesCapacity(records[i])) return true;
  }
  return false;
}

function hasUnreconciledHistory() {
  var file = path.join(config.CONFIG_DIR, "lead", "coop-session-ledger.json");
  var parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
  if (!parsed || !Array.isArray(parsed.entries)) return true;
  var classified = leadLedger.classifyHistoricalLedger(parsed.entries);
  var loaded = portfolioBindings.readPortfolioExecutionBindings();
  if (!loaded.ok) return true;
  var plan = leadLoop.historicalReconciliationPlan(classified.unresolved, loaded.bindings);
  return plan.actionable.length > 0;
}

function standupIsDue(nowValue) {
  var events = leadLedger.readEvents();
  var lastStandupAt = 0;
  for (var i = 0; i < events.length; i++) {
    if ((events[i].type === "standup_composed" || events[i].type === "lead_tick_wake") &&
        events[i].at > lastStandupAt) {
      lastStandupAt = events[i].at;
    }
  }
  return nowValue - lastStandupAt >= leadLoop.STANDUP_INTERVAL_MS;
}

// This is the lightweight wake predicate, not the full Lead tick gatherer.
// It deliberately avoids provider-health and budget scans while consulting
// every durable source that can require a managerial action. Any unreadable
// source wakes Lead so the foreground tick reports the error instead of
// silently converting corrupted state into "nothing to do".
function defaultHasPendingWork(nowValue) {
  try {
    if (hasAnswerableOwnerRequest()) return true;
    if (hasOpenLeadItem()) return true;
    if (leadLedger.inFlight().length > 0) return true;
    if (hasTypedWork()) return true;
    if (hasUnreconciledHistory()) return true;
    return standupIsDue(nowValue);
  } catch (e) {
    return true;
  }
}

function coopHomeSession(sm) {
  var home = null;
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return home;
  sm.sessions.forEach(function (session) {
    if (!home && session && session.coopHome) home = session;
  });
  return home;
}

function homeIsIdle(home) {
  // Codex keeps a resident query alive between turns. It is deliberately
  // reusable: project-user-message-queue dispatches the next turn through
  // pushMessage when isProcessing is false. Treating that transport as busy
  // leaves a completed foreground owner turn with no path to wake Lead.
  return !!home && !home.destroying && !home.isProcessing && !home.scheduledMessage;
}

function homeHasOwnerIngress(home) {
  if (!home) return false;
  if (Array.isArray(home.pendingCoopIngress) && home.pendingCoopIngress.length > 0) return true;
  return !!(home.coopConversationIngress && home.coopConversationIngress.activeIngressId);
}

function createLeadWakeHandler(ctx) {
  var hasPendingWork = ctx.hasPendingWork || defaultHasPendingWork;
  var scheduleMessage = ctx.scheduleMessage;
  var now = ctx.now || Date.now;
  return function (tick, options) {
    if (ctx.projectSlug !== "lead" || !tick || tick.leadMode !== true) return false;
    if (typeof scheduleMessage !== "function") return false;
    var nowValue = now();
    if ((!options || options.force !== true) && !hasPendingWork(nowValue)) return false;
    var home = coopHomeSession(ctx.sm);
    if (homeHasOwnerIngress(home)) return false;
    if (!homeIsIdle(home)) return false;
    scheduleMessage(home, "lead tick", nowValue, LEAD_WAKE_PROMPT, "↻ Lead tick", { autoAction: true });
    leadLedger.appendEvent({ type: "lead_tick_wake" }, { now: nowValue });
    return true;
  };
}

function attachCoopSelfCleanupRuntime(ctx) {
  var sm = ctx.sm;
  var projectSlug = ctx.projectSlug || "unknown-project";
  var compactAndContinue = ctx.compactAndContinue || null;
  var mutations = ctx.mutations || {};
  var persistence = ctx.persistence || createFilePersistence(projectSlug);
  var now = ctx.now || Date.now;
  var setIntervalFn = ctx.setInterval || setInterval;
  var clearIntervalFn = ctx.clearInterval || clearInterval;
  var intervalMs = finiteNumber(ctx.intervalMs) ? ctx.intervalMs : DEFAULT_INTERVAL_MS;
  var getLeadMode = ctx.getLeadMode || function () { return false; };
  var onTick = typeof ctx.onTick === "function" ? ctx.onTick : null;
  var timerId = null;
  var appliedKeys = {};
  var recordedTicks = {};
  var maintenanceRetry = createMaintenanceRetry({
    sm: sm,
    run: runTick,
    isRunning: function () { return !!timerId; },
    setImmediate: ctx.setImmediate,
  });

  function restoreAudit() {
    var records;
    try { records = recordsFromLoad(persistence.load()); } catch (e) { records = []; }
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (!record || record.type !== AUDIT_TYPE) continue;
      if (record.projectSlug !== projectSlug) continue;
      if (record.outcome === "applied" || record.outcome === "already_applied") {
        appliedKeys[record.actionKey] = true;
      }
      if (record.operation === "tick" && record.actionKey) recordedTicks[record.actionKey] = true;
    }
  }

  function persist(record) {
    try { persistence.append(record); } catch (e) {}
  }

  function persistTick(nowValue, leadMode, result) {
    var key = projectSlug + "|tick|" + nowValue;
    if (recordedTicks[key]) return;
    recordedTicks[key] = true;
    persist({
      type: AUDIT_TYPE,
      schemaVersion: 1,
      at: nowValue,
      projectSlug: projectSlug,
      actionKey: key,
      operation: "tick",
      category: "runtime",
      outcome: leadMode ? "evaluated" : "skipped",
      reasonCode: leadMode ? "lead_mode_on" : "lead_mode_off",
      leadMode: leadMode,
      counts: result ? {
        archive: result.archiveWorkerSessions.length,
        prune: result.pruneProjection.length,
        maintenance: result.maintenanceRequests.length,
      } : { archive: 0, prune: 0, maintenance: 0 },
    });
  }

  function sessionList() {
    if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return [];
    var result = [];
    sm.sessions.forEach(function (session) { result.push(session); });
    return result;
  }

  function taskList(sessions) {
    var tasks = [];
    for (var i = 0; i < sessions.length; i++) {
      var source = sessions[i];
      if (!Array.isArray(source.orchestrationTasks)) continue;
      for (var ti = 0; ti < source.orchestrationTasks.length; ti++) {
        if (source.orchestrationTasks[ti]) tasks.push(source.orchestrationTasks[ti]);
      }
    }
    return tasks;
  }

  function buildSnapshot() {
    var sessions = sessionList();
    return { sessions: sessions, tasks: taskList(sessions) };
  }

  function findSession(target) {
    if (!target) return null;
    if (sm && sm.sessions && target.localId != null && sm.sessions.get) {
      var byLocalId = sm.sessions.get(target.localId);
      if (byLocalId) return byLocalId;
    }
    var storageId = target.storageId;
    var sessions = sessionList();
    for (var i = 0; i < sessions.length; i++) {
      if (storageId && storageIdForSession(sessions[i]) === storageId) return sessions[i];
    }
    return null;
  }

  function isDirectOwner(session) {
    return !!(session && session.ownerId && !normalizeControlledBy(session.coopControlledBy));
  }

  function isCurrentActiveSession(session) {
    return !!(sm && typeof sm.getActiveSession === "function" && sm.getActiveSession() === session);
  }

  function hasUnsafeTasks(session) {
    var tasks = session && session.orchestrationTasks;
    if (!Array.isArray(tasks)) return false;
    for (var i = 0; i < tasks.length; i++) {
      var status = tasks[i] && tasks[i].status;
      if (ACTIVE_STATUSES[status] || ATTENTION_STATUSES[status]) return true;
    }
    return false;
  }

  function basicSessionGuard(session) {
    if (!session) return "target_missing";
    if (isCurrentActiveSession(session) && !session.coopHome && !session.coopChannel) return "active_session";
    if (session.isProcessing) return "runtime_active";
    if (session.unread === true || Number(session.unread || session.unreadCount || 0) > 0) return "unread_activity";
    if (session.needsAttention || session.attention || Number(session.attentionCount || 0) > 0) return "attention_flag";
    return "";
  }

  function workSessionGuard(session) {
    if (session.activeBinding || session.bindingActive) return "active_binding";
    if (hasUnsafeTasks(session)) return "unresolved_work";
    return "";
  }

  function sessionSafetyGuard(session) {
    var basic = basicSessionGuard(session);
    if (basic) return basic;
    var work = workSessionGuard(session);
    if (work) return work;
    if (session.coopHome || session.coopChannel) return "permanent_coop_conversation";
    if (isDirectOwner(session)) return "direct_owner_session";
    return "";
  }

  function liveProjectionGuard(session, item) {
    var guard = sessionSafetyGuard(session);
    if (guard) return guard;
    if (item.category === "worker" && !normalizeControlledBy(session.coopControlledBy)) {
      return "not_coop_controlled";
    }
    return "";
  }

  function hideProjection(session) {
    if (session.hidden) return { ok: true, outcome: "already_applied" };
    if (!sm || typeof sm.hideSession !== "function") return { ok: false, reason: "projection_mutation_unavailable" };
    sm.hideSession(session.localId, null, { projectionOnly: true });
    return session.hidden ? { ok: true, outcome: "applied" } : { ok: false, reason: "projection_not_hidden" };
  }

  function projectionMutation(session, item) {
    var mutate = item.category === "worker" ? mutations.archiveProjection : mutations.pruneProjection;
    if (typeof mutate === "function") return mutate(session, item);
    return hideProjection(session);
  }

  function persistAction(item, nowValue, outcome, reason) {
    var key = actionKey(projectSlug, item);
    persist({
      type: AUDIT_TYPE,
      schemaVersion: 1,
      at: nowValue,
      projectSlug: projectSlug,
      actionKey: key,
      operation: item.operation,
      category: item.category,
      outcome: outcome,
      reasonCode: reason || item.reasonCode,
      reason: item.reason,
      target: item.target,
      observed: item.observed,
      effect: item.effect,
      leadMode: true,
    });
    if (outcome === "applied" || outcome === "already_applied") appliedKeys[key] = true;
  }

  function applyProjection(item, nowValue) {
    var key = actionKey(projectSlug, item);
    if (appliedKeys[key]) return;
    var session = findSession(item.target);
    var guard = liveProjectionGuard(session, item);
    if (guard) {
      persistAction(item, nowValue, "skipped", guard);
      return;
    }
    var outcome;
    try { outcome = projectionMutation(session, item) || {}; } catch (e) {
      persistAction(item, nowValue, "deferred", "projection_mutation_failed");
      return;
    }
    if (outcome.ok) persistAction(item, nowValue, outcome.outcome || "applied");
    else persistAction(item, nowValue, "deferred", outcome.reason || "projection_mutation_deferred");
  }

  function applyMaintenance(item, nowValue) {
    var key = actionKey(projectSlug, item);
    if (appliedKeys[key]) return;
    var session = findSession(item.target);
    var guard = liveProjectionGuard(session, item);
    if (guard && guard !== "permanent_coop_conversation") {
      persistAction(item, nowValue, "skipped", guard);
      return;
    }
    if (typeof compactAndContinue !== "function") {
      persistAction(item, nowValue, "deferred", "compaction_path_unavailable");
      return;
    }
    var rotation = item.operation === "request_rotation";
    var continuation;
    try {
      continuation = compactAndContinue(session, {
        reason: rotation ? "coop_cleanup_rotation" : "coop_cleanup_compaction",
        currentText: "Continue from the compacted Coop context.",
        rotation: rotation,
      });
    } catch (e) {
      persistAction(item, nowValue, "deferred", "compaction_path_failed");
      return;
    }
    if (continuation) persistAction(item, nowValue, "applied");
    else persistAction(item, nowValue, "deferred", "compaction_deferred");
  }

  function processActions(result, nowValue) {
    var archive = result.archiveWorkerSessions;
    var prune = result.pruneProjection;
    var maintenance = result.maintenanceRequests;
    for (var i = 0; i < archive.length; i++) applyProjection(archive[i], nowValue);
    for (var pi = 0; pi < prune.length; pi++) applyProjection(prune[pi], nowValue);
    for (var mi = 0; mi < maintenance.length; mi++) applyMaintenance(maintenance[mi], nowValue);
  }

  function runTick() {
    var nowValue = now();
    if (!finiteNumber(nowValue)) throw new TypeError("Coop cleanup runtime requires a finite now value");
    var leadMode = getLeadMode() === true;
    if (!leadMode) {
      persistTick(nowValue, false, null);
      var skipped = { leadMode: false, archiveWorkerSessions: [], pruneProjection: [], maintenanceRequests: [], audit: [] };
      try { if (onTick) onTick(skipped); } catch (e) {}
      return skipped;
    }
    var snapshot = buildSnapshot();
    var result = cleanupPolicy.classifyCoopSelfCleanup(snapshot, { now: nowValue, thresholds: ctx.thresholds });
    processActions(result, nowValue);
    maintenanceRetry.observe(result);
    persistTick(nowValue, true, result);
    result.leadMode = true;
    try { if (onTick) onTick(result); } catch (e) {}
    return result;
  }

  function start(immediate) {
    if (timerId) return;
    if (immediate === true) runTick();
    timerId = setIntervalFn(runTick, intervalMs);
    if (timerId && typeof timerId.unref === "function") timerId.unref();
  }

  function stop() {
    maintenanceRetry.stop();
    if (!timerId) return;
    clearIntervalFn(timerId);
    timerId = null;
  }

  restoreAudit();
  return {
    start: start,
    stop: stop,
    tick: runTick,
    isRunning: function () { return !!timerId; },
  };
}

module.exports = {
  AUDIT_TYPE: AUDIT_TYPE,
  DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
  LEAD_WAKE_INTERVAL_MS: LEAD_WAKE_INTERVAL_MS,
  createLeadWakeHandler: createLeadWakeHandler,
  attachCoopSelfCleanupRuntime: attachCoopSelfCleanupRuntime,
};
