// Read-only classification of durable Coop session history.

var projectIdentity = require("./project-identity");

var ACTIVE_STATUSES = { pending: true, active: true, unavailable: true, queued: true,
  ready: true, running: true, reviewing: true };
var TERMINAL_STATUSES = { completed: true, dismissed: true, cancelled: true, deleted: true,
  failed: true, superseded: true, unrouted: true };
var RESOLUTION_ACTIONS = { execution_completed: true, execution_failed: true,
  execution_superseded: true, execution_deleted: true, task_completed: true,
  task_dismissed: true, task_needs_input: true, project_completed: true, session_missing: true };
var TERMINAL_ACTION_EVIDENCE = {
  execution_superseded: "execution_superseded",
  task_dismissed: "task_dismissed",
};

function bindingFor(record) {
  return record && (record.portfolioBinding || (Array.isArray(record.portfolioBindings) &&
    record.portfolioBindings.length ? record.portfolioBindings[record.portfolioBindings.length - 1] : null) ||
    record.parentPortfolioBinding || null);
}

function keyFor(record) {
  var binding = bindingFor(record);
  var project = record && record.projectRef && record.projectRef.projectId || "";
  var session = record && record.sessionStorageId || "";
  if (binding && binding.portfolioTaskId) {
    return "portfolio:" + binding.portfolioTaskId + ":" + (Number(binding.bindingRevision) || 0);
  }
  return "session:" + project + ":" + session;
}

function hasResolution(record) {
  var action = record && record.lastCoopAction && record.lastCoopAction.type;
  var binding = bindingFor(record) || {};
  var bindingStatus = String(binding.status || "").toLowerCase();
  return !!((record && record.terminalOutcome && record.terminalOutcome.status) ||
    RESOLUTION_ACTIONS[action] || TERMINAL_STATUSES[bindingStatus]);
}

function hasApprovalBlocker(record) {
  var binding = bindingFor(record) || {};
  var acceptance = binding.ownerAcceptance;
  if (binding.ownerAcceptanceRequired === true &&
      (!acceptance || acceptance.status === "pending" ||
       acceptance.status === "accepted" && acceptance.withdrawnAt != null)) return true;
  var text = [record && record.statusReason, binding.statusReason,
    record && record.lastCoopAction && record.lastCoopAction.report].join(" ").toLowerCase();
  return /approval|owner\s+(?:decision|input|approval)|(?:decision|input)\s+owner|waiting_user|needs the boss/.test(text);
}

function positiveTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function terminalEvidence(record, binding) {
  var action = record && record.lastCoopAction && record.lastCoopAction.type;
  if (action === "project_completed") return "project_completed";
  if (TERMINAL_ACTION_EVIDENCE[action]) return TERMINAL_ACTION_EVIDENCE[action];
  if (positiveTimestamp(record && record.closedAt) && positiveTimestamp(binding && binding.completedAt) &&
      record && record.terminalOutcome && String(record.terminalOutcome.status || "").trim()) {
    return "closed_terminal_outcome";
  }
  var report = String(record && record.lastCoopAction && record.lastCoopAction.report || "");
  if (positiveTimestamp(record && record.closedAt) && action === "task_needs_input" &&
      /interrupted by (?:a )?restart/i.test(report) && /not eligible for automatic resume/i.test(report)) {
    return "interrupted_not_resumable";
  }
  return null;
}

function isProjectCoordinatorRoot(record, binding) {
  if (binding && binding.portfolioTaskId) return false;
  if (!record || record.topLevel === false) return false;
  return record.role === "project_coordinator" || record.controlRole === "project_coordinator";
}

function terminalRevisionEvidence(entries) {
  var latest = {};
  var list = Array.isArray(entries) ? entries : [];
  for (var i = 0; i < list.length; i++) {
    var record = list[i] || {};
    var binding = bindingFor(record) || {};
    var taskId = String(binding.portfolioTaskId || "");
    if (!taskId || !projectIdentity.isTaskId(taskId)) continue;
    var lifecycle = String(record.lifecycleState || "").toLowerCase();
    var status = String(binding.status || "").toLowerCase();
    var terminal = TERMINAL_STATUSES[lifecycle] || TERMINAL_STATUSES[status] ||
      terminalEvidence(record, binding);
    if (!terminal || !hasResolution(record)) continue;
    var projectId = record.projectRef && record.projectRef.projectId || "";
    var revision = Number(binding.bindingRevision) || 0;
    var key = JSON.stringify([projectId, taskId]);
    if (!latest[key] || revision > latest[key].bindingRevision) {
      latest[key] = { bindingRevision: revision, sessionStorageId: record.sessionStorageId || "" };
    }
  }
  return latest;
}

function classifyHistoricalLedger(entries) {
  var list = Array.isArray(entries) ? entries : [];
  var latestTerminal = terminalRevisionEvidence(list);
  var keyCounts = {};
  var counts = {
    scanned: list.length, active: 0, terminal: 0, unrouted: 0, failed: 0,
    needs_input: 0, approval_gated: 0, superseded: 0, duplicate: 0, reconciled: 0, unreconciled: 0,
    idle: 0, control_plane: 0,
  };
  var rows = [];
  var unresolved = [];
  var i;

  for (i = 0; i < list.length; i++) {
    var historicalKey = keyFor(list[i]);
    keyCounts[historicalKey] = (keyCounts[historicalKey] || 0) + 1;
  }
  for (i = 0; i < list.length; i++) {
    var record = list[i] || {};
    var binding = bindingFor(record) || {};
    var lifecycle = String(record.lifecycleState || "").toLowerCase();
    var work = String(record.workState || "").toLowerCase();
    var status = String(binding.status || "").toLowerCase();
    var action = record.lastCoopAction && record.lastCoopAction.type;
    var key = keyFor(record);
    var duplicate = keyCounts[key] > 1;
    var projectId = record.projectRef && record.projectRef.projectId;
    var classification = "idle";
    var terminal = false;
    var evidenceCode = terminalEvidence(record, binding);
    var taskId = String(binding.portfolioTaskId || "");
    var terminalKey = JSON.stringify([projectId || "", taskId]);
    var revision = Number(binding.bindingRevision) || 0;
    var newerTerminal = taskId && latestTerminal[terminalKey] &&
      latestTerminal[terminalKey].bindingRevision > revision ? latestTerminal[terminalKey] : null;
    var supersededReason = newerTerminal ?
      "Superseded by terminal binding revision " + newerTerminal.bindingRevision : "";
    if (isProjectCoordinatorRoot(record, binding) ||
        projectId === projectIdentity.LEAD_PROJECT_ID && !binding.portfolioTaskId) {
      classification = "control_plane";
    } else if (newerTerminal) {
      classification = "superseded";
      terminal = true;
      evidenceCode = "newer_terminal_revision";
    } else if (status === "unrouted" || lifecycle === "unrouted") {
      classification = "unrouted";
      terminal = true;
    } else if (lifecycle === "superseded" || status === "superseded") {
      classification = "superseded";
      terminal = true;
    } else if (lifecycle === "failed" || status === "failed") {
      classification = "failed";
      terminal = true;
    } else if (lifecycle === "missing" && record.sessionPresent === false && action === "session_missing") {
      classification = "failed";
      terminal = true;
    } else if (evidenceCode) {
      classification = evidenceCode === "interrupted_not_resumable" ? "failed" :
        (evidenceCode === "execution_superseded" ? "superseded" : "terminal");
      terminal = true;
    } else if (TERMINAL_STATUSES[lifecycle] || TERMINAL_STATUSES[status]) {
      classification = "terminal";
      terminal = true;
    } else if (lifecycle === "needs_input" || work === "needs_input" || status === "needs_input") {
      classification = hasApprovalBlocker(record) ? "approval_gated" : "needs_input";
    } else if (ACTIVE_STATUSES[lifecycle] || ACTIVE_STATUSES[work] || ACTIVE_STATUSES[status]) {
      classification = "active";
    }
    var reconciled = terminal && (hasResolution(record) || !!newerTerminal);
    var row = {
      key: key, classification: classification, terminal: terminal, duplicate: duplicate,
      reconciled: reconciled, evidenceCode: evidenceCode,
      needsOwnerDecision: classification === "approval_gated",
      projectRef: record.projectRef || null, sessionRef: record.sessionRef || null,
      sessionStorageId: record.sessionStorageId || null, parentSessionRef: record.parentSessionRef || null,
      parentTaskId: record.parentTaskId || null, title: record.title || "",
      portfolioTaskId: binding.portfolioTaskId || null, bindingRevision: binding.bindingRevision || null,
      mode: binding.mode || null, status: binding.status || null,
      statusReason: supersededReason || binding.statusReason || record.statusReason || record.lastCoopAction &&
        record.lastCoopAction.report || "",
    };
    rows.push(row);
    if (classification !== "terminal" && counts[classification] !== undefined) counts[classification]++;
    if (duplicate) counts.duplicate++;
    if (terminal) counts.terminal++;
    if (reconciled) counts.reconciled++;
    var needsReconciliation = classification === "active" || classification === "needs_input" ||
      classification === "approval_gated" || (terminal && !reconciled) || (duplicate && !reconciled);
    if (needsReconciliation) {
      row.needsReconciliation = true;
      unresolved.push(row);
      counts.unreconciled++;
    }
  }
  return { scanned: list.length, counts: counts, unresolved: unresolved, records: rows };
}

module.exports = { classifyHistoricalLedger: classifyHistoricalLedger };
