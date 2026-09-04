var sanitizeSelectionPacket =
  require("./project-live-ui-context").sanitizeSelectionPacket;

var MAX_REPORTS = 200;
var VALID_STATUSES = {
  working: true,
  needs_input: true,
  completed: true,
  failed: true,
};

function boundedText(value, max) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#55A7FF";
}

function safeSelection(value) {
  if (!value) return null;
  var sanitized = sanitizeSelectionPacket(value);
  return sanitized.ok ? sanitized.packet : null;
}

function normalizedRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var reportId = boundedText(value.reportId, 128);
  var taskId = boundedText(value.taskId, 128);
  if (!reportId || !taskId) return null;
  return {
    reportId: reportId,
    taskId: taskId,
    title: boundedText(value.title, 90) || "Live UI report",
    status: VALID_STATUSES[value.status] ? value.status : "working",
    message: boundedText(value.message, 500) || "Being worked on.",
    selection: safeSelection(value.selection),
    workerSessionId: typeof value.workerSessionId === "number" ?
      value.workerSessionId : null,
    workerColor: safeColor(value.workerColor),
    dismissed: value.dismissed === true,
  };
}

function isLiveUiTask(task) {
  return !!(task && typeof task.clientRef === "string" &&
    (task.clientRef.indexOf("live-ui:") === 0 ||
     task.clientRef.indexOf("live-ui-report:") === 0) &&
    task.status !== "dismissed" && task.status !== "cancelled");
}

function reportIdForTask(task) {
  var prefix = "live-ui-report:";
  if (task.clientRef.indexOf(prefix) === 0) {
    return boundedText(task.clientRef.slice(prefix.length), 128) || task.taskId;
  }
  return boundedText(task.taskId, 128);
}

function attachLiveUiReportStore(ctx) {
  var cache = new WeakMap();

  function serialize(records) {
    return Array.from(records.values()).slice(-MAX_REPORTS).map(function (record) {
      return normalizedRecord(record);
    }).filter(Boolean);
  }

  function persist(session, records) {
    session.liveUiReports = serialize(records);
    if (ctx.persistSession) ctx.persistSession(session);
  }

  function recoverTasks(session, records) {
    var tasks = Array.isArray(session.orchestrationTasks) ?
      session.orchestrationTasks.slice(-MAX_REPORTS) : [];
    var taskIds = {};
    records.forEach(function (record) { taskIds[record.taskId] = true; });
    var changed = false;
    for (var i = 0; i < tasks.length; i++) {
      var task = tasks[i];
      if (!isLiveUiTask(task) || taskIds[task.taskId]) continue;
      var presentation = ctx.presentTask(task);
      var record = normalizedRecord({
        reportId: reportIdForTask(task),
        taskId: task.taskId,
        title: task.title,
        status: presentation.status,
        message: presentation.message,
        selection: null,
        workerSessionId: task.workerSessionId,
        workerColor: task.workerColor,
      });
      if (!record || records.has(record.reportId)) continue;
      records.set(record.reportId, record);
      taskIds[record.taskId] = true;
      changed = true;
    }
    return changed;
  }

  function recordsFor(session) {
    if (cache.has(session)) return cache.get(session);
    var records = new Map();
    var source = Array.isArray(session.liveUiReports) ?
      session.liveUiReports.slice(-MAX_REPORTS) : [];
    for (var i = 0; i < source.length; i++) {
      var record = normalizedRecord(source[i]);
      if (record) records.set(record.reportId, record);
    }
    cache.set(session, records);
    if (recoverTasks(session, records)) persist(session, records);
    return records;
  }

  return {
    persist: persist,
    recordsFor: recordsFor,
  };
}

module.exports = {
  attachLiveUiReportStore: attachLiveUiReportStore,
};
