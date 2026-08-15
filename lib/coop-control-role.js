// Durable semantic classification for owner-visible Coop control executions.
//
// coordinationRole describes graph mechanics (project/task coordinator). This
// role describes the owner surface that owns an execution. Keeping them
// separate prevents a Council or Triage execution from degrading into a
// generic task coordinator after dispatch, restart, or provider recovery.

var ROLES = {
  project_coordinator: true,
  council: true,
  triage: true,
};

function clean(value) {
  return String(value || "").trim().toLowerCase();
}

function normalize(value) {
  var role = clean(value).replace(/[ -]+/g, "_");
  return ROLES[role] ? role : "";
}

function namedRole(value) {
  var text = clean(value);
  if (/^council(?:\b|\s|:|-)/.test(text) || /(?:^|[-_])council(?:[-_]|$)/.test(text)) {
    return "council";
  }
  if (/^triage(?:\b|\s|:|-)/.test(text) || /(?:^|[-_])triage(?:[-_]|$)/.test(text)) {
    return "triage";
  }
  return "";
}

function forExecution(value) {
  var input = value && typeof value === "object" ? value : {};
  if (input.mode !== "project_coordinator") return "";
  return normalize(input.controlRole) || namedRole(input.title) ||
    namedRole(input.portfolioTaskId) || "project_coordinator";
}

function forSession(session, task, binding) {
  var execution = session && session.orchestrationPolicy &&
    session.orchestrationPolicy.portfolioExecution || {};
  var source = Object.assign({}, binding || {}, execution || {});
  source.mode = source.mode || task && task.mode ||
    (session && session.coordinationMode ? "project_coordinator" : "");
  source.controlRole = source.controlRole || task && task.controlRole;
  source.title = source.title || session && session.title || task && task.title;
  source.portfolioTaskId = source.portfolioTaskId || task && task.clientRef || "";
  return forExecution(source);
}

function isPeer(value) {
  var role = normalize(value);
  return role === "council" || role === "triage";
}

module.exports = {
  ROLES: ROLES,
  forExecution: forExecution,
  forSession: forSession,
  isPeer: isPeer,
  normalize: normalize,
};
