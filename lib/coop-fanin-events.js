var crypto = require("crypto");

function sessionStorageId(session) {
  return session && (session.storageId || session.cliSessionId) || null;
}

function stableTransitionTime(task, transition, opts) {
  var value = transition && transition.occurredAt;
  if (!Number.isFinite(value)) value = task && task.statusTransitionAt;
  if (!Number.isFinite(value)) value = task && task.updatedAt;
  if (!Number.isFinite(value)) value = opts && opts.now;
  if (!Number.isFinite(value)) {
    throw new TypeError("Coop fan-in event requires a finite transition timestamp");
  }
  return value;
}

function summaryText(session, task, transition) {
  var text = transition && transition.summary;
  if (!text && task) text = task.resultSummary || task.resolutionSummary || task.currentActivity;
  if (!text && session) text = session.title || "";
  return String(text || "").replace(/\s+/g, " ").trim();
}

function buildFanInEvent(session, task, transition, opts) {
  var controlledBy = session && session.coopControlledBy || null;
  var controlledSessionStorageId = sessionStorageId(session);
  var taskId = task && task.taskId ? String(task.taskId) : "";
  var status = String((transition && transition.status) || (task && task.status) || "").trim();
  var coopSessionStorageId = controlledBy && controlledBy.coopSessionStorageId || null;
  if (!controlledSessionStorageId || !taskId || !status || !coopSessionStorageId) return null;
  var occurredAt = stableTransitionTime(task, transition, opts);
  var hashInput = [
    "coop-fanin-v1",
    coopSessionStorageId,
    controlledSessionStorageId,
    taskId,
    status,
    String(occurredAt),
  ].join(":");
  return {
    eventId: crypto.createHash("sha256").update(hashInput).digest("hex"),
    type: "coop_task_transition",
    coopSessionStorageId: coopSessionStorageId,
    sessionStorageId: controlledSessionStorageId,
    taskId: taskId,
    status: status,
    summary: summaryText(session, task, transition),
    occurredAt: occurredAt,
    schemaVersion: 1,
  };
}

module.exports = {
  buildFanInEvent: buildFanInEvent,
};
