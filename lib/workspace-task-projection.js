// Read-only Workspace task projection. Durable execution bindings establish
// cross-project task identity; coordinator task records add human titles and
// local session links. This deliberately never changes task lifecycle state.

var STARTED = { active: true, running: true, reviewing: true, blocked: true,
  failed: true, needs_input: true, waiting_user: true, unavailable: true };
var WAITING = { pending: true, queued: true, ready: true, unrouted: true };
var COMPLETED = { completed: true, cancelled: true, dismissed: true, superseded: true, deleted: true };

function text(value, fallback) {
  var result = String(value || "").replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

var BARE_ASSENT = /^(?:do it|yes(?:[, ]+(?:now|please|proceed|go ahead|do it))?|continue|go ahead|proceed|ship it|okay|ok|yep|yeah|sure|y|approve|approved)[.!?]*$/i;

function meaningfulText(value) {
  var result = text(value, "");
  if (!result || BARE_ASSENT.test(result)) return "";
  if (/^(?:project execution|project task|task)[.!?]*$/i.test(result)) return "";
  return result;
}

function taskTitle(task, id) {
  var title = meaningfulText(task && task.title);
  var objective = meaningfulText(task && task.objective);
  var context = meaningfulText(task && task.context);
  return title || objective || context || "Unresolved task context for " + id;
}

function number(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }

function bindingKey(binding) {
  return text(binding && binding.portfolioTaskId, "");
}

function newer(left, right) {
  if (!right) return true;
  if (number(left.bindingRevision) !== number(right.bindingRevision)) {
    return number(left.bindingRevision) > number(right.bindingRevision);
  }
  return number(left.updatedAt) >= number(right.updatedAt);
}

function groupFor(status) {
  var value = text(status, "pending").toLowerCase();
  if (COMPLETED[value]) return "completed";
  if (WAITING[value]) return "waiting";
  return "started";
}

function taskSession(task) {
  return Number.isInteger(task && task.workerSessionId) ? task.workerSessionId : null;
}

function taskFromCoordinator(task, session) {
  var id = text(task && task.taskId, "");
  if (!id) return null;
  var clientRef = text(task.clientRef, "");
  var match = clientRef.match(/^portfolio:([^:]+):(\d+)$/);
  return {
    key: match ? match[1] : "local:" + text(session && (session.storageId || session.cliSessionId || session.localId), "unknown") + ":" + id,
    portfolioTaskId: match ? match[1] : null,
    title: taskTitle(task, id),
    status: text(task.status, "pending").toLowerCase(),
    project: text(session && (session.projectTitle || session._projectTitle), "This project"),
    sessionId: taskSession(task) || (Number.isInteger(session && session.localId) ? session.localId : null),
    taskId: id,
    bindingRevision: match ? Number(match[2]) : null,
    updatedAt: number(task.updatedAt),
  };
}

function projectTasks(input) {
  var options = input || {};
  var projectId = text(options.projectId, "");
  var records = {};
  var bindings = Array.isArray(options.bindings) ? options.bindings : [];
  var sessions = Array.isArray(options.sessions) ? options.sessions : [];
  var i;
  for (i = 0; i < bindings.length; i++) {
    var binding = bindings[i] || {};
    if (!projectId || !binding.targetProject || binding.targetProject.projectId !== projectId) continue;
    var key = bindingKey(binding);
    if (!key || !newer(binding, records[key] && records[key].binding)) continue;
    records[key] = { binding: binding, task: records[key] && records[key].task || null };
  }
  for (i = 0; i < sessions.length; i++) {
    var session = sessions[i] || {};
    var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
    for (var j = 0; j < tasks.length; j++) {
      var task = taskFromCoordinator(tasks[j], session);
      if (!task) continue;
      if (task.portfolioTaskId && records[task.portfolioTaskId] &&
          records[task.portfolioTaskId].binding &&
          Number(records[task.portfolioTaskId].binding.bindingRevision) !== task.bindingRevision) continue;
      if (!records[task.key]) records[task.key] = { binding: null, task: task };
      else if (!records[task.key].task || task.updatedAt >= records[task.key].task.updatedAt) records[task.key].task = task;
    }
  }
  var rows = Object.keys(records).map(function (key) {
    var record = records[key];
    var binding = record.binding;
    var task = record.task;
    var status = binding ? text(binding.status, "pending").toLowerCase() : task.status;
    return {
      key: key,
      title: task ? task.title : text(binding && (binding.title || binding.workIdentity), "Task " + key),
      project: task ? task.project : "This project",
      status: status,
      group: groupFor(status),
      sessionId: task && task.sessionId,
      taskId: task && task.taskId,
      bindingRevision: binding && binding.bindingRevision || null,
      updatedAt: Math.max(number(binding && binding.updatedAt), number(task && task.updatedAt)),
    };
  });
  rows.sort(function (left, right) { return right.updatedAt - left.updatedAt || left.title.localeCompare(right.title); });
  return rows;
}

module.exports = { projectTasks: projectTasks, groupFor: groupFor };
