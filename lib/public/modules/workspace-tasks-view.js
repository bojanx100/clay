import { escapeHtml } from './utils.js';

var labels = { started: "Started", waiting: "Waiting to be started", completed: "Completed" };
var icons = { started: "play", waiting: "clock-3", completed: "check" };

export function workspaceTabsHtml(selected) {
  return '<div class="ws-tabs" role="tablist" aria-label="Workspace views">' +
    '<button type="button" class="ws-tab' + (selected === "overview" ? " active" : "") +
    '" role="tab" aria-selected="' + (selected === "overview") + '" data-workspace-tab="overview">Overview</button>' +
    '<button type="button" class="ws-tab' + (selected === "tasks" ? " active" : "") +
    '" role="tab" aria-selected="' + (selected === "tasks") + '" data-workspace-tab="tasks">Tasks</button></div>';
}

function statusLabel(status) {
  if (status === "unavailable") return "Status unverified";
  return String(status || "pending").replace(/_/g, " ");
}

function rowHtml(task) {
  var session = Number.isInteger(task.sessionId) && task.sessionId > 0 ?
    ' data-workspace-task-session="' + task.sessionId + '"' : '';
  var tag = session ? "button" : "div";
  return '<' + tag + ' class="ws-task-row"' + session + (session ? ' type="button"' : '') + '>' +
    '<span class="ws-task-main"><span class="ws-task-title">' + escapeHtml(task.title) +
    '</span><span class="ws-task-project">' + escapeHtml(task.project || "This project") + '</span></span>' +
    '<span class="ws-task-status ws-task-status-' + escapeHtml(task.status) + '">' +
    escapeHtml(statusLabel(task.status)) + '</span></' + tag + '>';
}

function sectionHtml(group, rows) {
  var list = rows[group] || [];
  var content = list.length ? list.map(rowHtml).join("") :
    '<div class="ws-empty-callout">No tasks in this section.</div>';
  var title = '<span><i data-lucide="' + icons[group] + '"></i>' + labels[group] +
    '</span><span class="ws-task-count">' + list.length + '</span>';
  if (group === "completed") return '<details class="ws-task-section ws-task-completed"><summary>' + title +
    '</summary><div class="ws-task-list">' + content + '</div></details>';
  return '<section class="ws-task-section"><div class="ws-task-heading">' + title +
    '</div><div class="ws-task-list">' + content + '</div></section>';
}

export function workspaceTasksHtml(tasks) {
  var rows = { started: [], waiting: [], completed: [] };
  var list = Array.isArray(tasks) ? tasks : [];
  for (var i = 0; i < list.length; i++) {
    var group = rows[list[i].group] ? list[i].group : "started";
    rows[group].push(list[i]);
  }
  if (!list.length) return '<div class="ws-empty-callout ws-task-empty"><i data-lucide="list-todo"></i>' +
    '<span>No tasks are recorded for this workspace yet.</span></div>';
  return '<div class="ws-task-sections">' + sectionHtml("started", rows) +
    sectionHtml("waiting", rows) + sectionHtml("completed", rows) + '</div>';
}

export function wireWorkspaceTaskLinks(container, send) {
  var rows = container.querySelectorAll("[data-workspace-task-session]");
  for (var i = 0; i < rows.length; i++) rows[i].addEventListener("click", function () {
    var id = Number(this.getAttribute("data-workspace-task-session"));
    if (Number.isInteger(id) && id > 0) send({ type: "switch_session", id: id });
  });
}

export function wireWorkspaceTabs(container, selected, onSelect) {
  var tabs = container.querySelectorAll("[data-workspace-tab]");
  for (var i = 0; i < tabs.length; i++) tabs[i].addEventListener("click", function () {
    var next = this.getAttribute("data-workspace-tab");
    if (next && next !== selected) onSelect(next);
  });
}
