import { iconHtml, refreshIcons } from './icons.js';
import { getWs } from './ws-ref.js';
import { store } from './store.js';
import { showConfirm } from './app-misc.js';

var MAX_PREVIEW_WORKERS = 3;

function isActiveStatus(status) {
  return status === "queued" || status === "ready" || status === "running";
}

function isAttentionStatus(status) {
  return status === "blocked" || status === "failed" ||
    status === "needs_input" || status === "reviewing";
}

function statusLabel(status) {
  return String(status || "queued").replace(/_/g, " ");
}

function taskMetrics(tasks) {
  var metrics = { active: 0, attention: 0, completed: 0 };
  for (var i = 0; i < tasks.length; i++) {
    var status = tasks[i].status || "queued";
    if (isActiveStatus(status)) metrics.active++;
    else if (isAttentionStatus(status)) metrics.attention++;
    else if (status === "completed") metrics.completed++;
  }
  return metrics;
}

function summaryText(metrics) {
  var parts = [];
  if (metrics.active > 0) parts.push(metrics.active + " active");
  if (metrics.attention > 0) {
    parts.push(metrics.attention + (metrics.attention === 1 ? " needs attention" : " need attention"));
  }
  if (metrics.completed > 0) parts.push(metrics.completed + " completed");
  return parts.length > 0 ? parts.join(" · ") : "No worker activity";
}

function previewTasks(tasks) {
  var active = tasks.filter(function (task) {
    return isActiveStatus(task.status || "queued");
  });
  if (active.length > 0) return active.slice(0, MAX_PREVIEW_WORKERS);
  var attention = tasks.filter(function (task) {
    return isAttentionStatus(task.status || "queued");
  });
  if (attention.length > 0) return attention.slice(0, MAX_PREVIEW_WORKERS);
  return tasks.filter(function (task) {
    return task.status === "completed";
  }).slice(-MAX_PREVIEW_WORKERS).reverse();
}

function openTaskSession(sessionId) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !sessionId) return;
  ws.send(JSON.stringify({ type: "switch_session", id: sessionId }));
}

function closeTask(task) {
  var ws = getWs();
  if (!ws || ws.readyState !== 1 || !task || !task.taskId) return;
  showConfirm(
    'Close "' + (task.title || "Parallel task") + '"? Its worker will stop and its conversation will be archived from the sidebar.',
    function () {
      ws.send(JSON.stringify({
        type: "close_orchestration_task",
        taskId: task.taskId,
        sessionId: store.get("activeSessionId") || null,
      }));
    },
    "Close task",
    true,
    "Keep task"
  );
}

function appendSummaryPreview(summary, tasks) {
  var preview = document.createElement("span");
  preview.className = "orchestration-summary-workers";
  var visibleTasks = previewTasks(tasks);
  for (var i = 0; i < visibleTasks.length; i++) {
    var task = visibleTasks[i];
    var worker = document.createElement("span");
    worker.className = "orchestration-summary-worker";
    worker.title = (task.title || "Parallel task") + " · " + statusLabel(task.status);
    var status = document.createElement("span");
    status.className = "orchestration-task-status orchestration-task-status-" + (task.status || "queued");
    status.setAttribute("aria-hidden", "true");
    var title = document.createElement("span");
    title.className = "orchestration-summary-worker-title";
    title.textContent = task.title || "Parallel task";
    worker.appendChild(status);
    worker.appendChild(title);
    preview.appendChild(worker);
  }
  summary.appendChild(preview);
}

function createSummary(host, tasks) {
  var metrics = taskMetrics(tasks);
  var isExpanded = !!store.get("orchestrationTaskPreviewExpanded");
  var summary = document.createElement("button");
  summary.type = "button";
  summary.className = "orchestration-task-summary";
  summary.setAttribute("aria-expanded", isExpanded ? "true" : "false");
  summary.setAttribute("aria-controls", "orchestration-task-details");
  summary.title = isExpanded ? "Collapse worker details" : "Expand worker details";

  var heading = document.createElement("span");
  heading.className = "orchestration-summary-heading";
  var label = document.createElement("span");
  label.className = "orchestration-summary-label";
  label.textContent = "Workers";
  var count = document.createElement("span");
  count.className = "orchestration-summary-count";
  count.textContent = summaryText(metrics);
  heading.appendChild(label);
  heading.appendChild(count);
  summary.appendChild(heading);
  appendSummaryPreview(summary, tasks);

  var toggle = document.createElement("span");
  toggle.className = "orchestration-summary-toggle";
  toggle.innerHTML = iconHtml(isExpanded ? "chevron-up" : "chevron-down");
  toggle.setAttribute("aria-hidden", "true");
  summary.appendChild(toggle);
  summary.addEventListener("click", function () {
    store.set({ orchestrationTaskPreviewExpanded: !isExpanded });
    renderOrchestrationTaskPreview(host, tasks);
  });
  return summary;
}

function createTaskRow(task) {
  var row = document.createElement("div");
  row.className = "orchestration-task-item";
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  row.addEventListener("click", function () {
    openTaskSession(task.workerSessionId);
  });
  row.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openTaskSession(task.workerSessionId);
    }
  });

  var status = document.createElement("span");
  status.className = "orchestration-task-status orchestration-task-status-" + (task.status || "queued");
  status.setAttribute("aria-hidden", "true");
  var body = document.createElement("span");
  body.className = "queued-message-body";
  var title = document.createElement("span");
  title.className = "orchestration-task-title";
  title.textContent = task.title || "Parallel task";
  var detail = document.createElement("span");
  detail.className = "orchestration-task-detail";
  var detailParts = [statusLabel(task.status)];
  if (task.provider) detailParts.push(task.provider);
  if (task.model) detailParts.push(task.model);
  if (task.dependencies && task.dependencies.length) {
    detailParts.push("after " + task.dependencies.length + " task" +
      (task.dependencies.length === 1 ? "" : "s"));
  }
  if (task.attempt > 1) detailParts.push("attempt " + task.attempt);
  detail.textContent = detailParts.join(" · ");
  var taskTooltip = [];
  if (task.currentActivity) taskTooltip.push(task.currentActivity);
  if (task.routingRationale) taskTooltip.push(task.routingRationale);
  if (taskTooltip.length) title.title = taskTooltip.join("\n");
  body.appendChild(title);
  body.appendChild(detail);

  var open = document.createElement("span");
  open.className = "orchestration-task-open";
  open.innerHTML = iconHtml("arrow-up-right");
  var close = document.createElement("button");
  close.type = "button";
  close.className = "orchestration-task-close";
  close.title = "Close task and archive worker conversation";
  close.setAttribute("aria-label", "Close task and archive worker conversation");
  close.innerHTML = iconHtml("x");
  close.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    closeTask(task);
  });
  row.appendChild(status);
  row.appendChild(body);
  row.appendChild(open);
  row.appendChild(close);
  return row;
}

export function collapseOrchestrationTaskPreview() {
  store.set({ orchestrationTaskPreviewExpanded: false });
}

export function renderOrchestrationTaskPreview(host, tasks) {
  host.innerHTML = "";
  if (!tasks || tasks.length === 0) return null;
  host.className = "orchestration-task-preview";
  host.appendChild(createSummary(host, tasks));
  if (!store.get("orchestrationTaskPreviewExpanded")) {
    refreshIcons();
    return null;
  }

  var list = document.createElement("div");
  list.id = "orchestration-task-details";
  list.className = "orchestration-task-list";
  for (var i = 0; i < tasks.length; i++) list.appendChild(createTaskRow(tasks[i]));
  host.appendChild(list);
  refreshIcons();
  return list;
}
