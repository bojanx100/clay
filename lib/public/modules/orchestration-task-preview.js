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

function isResolvedStatus(status) {
  return status === "completed" || status === "dismissed" || status === "cancelled";
}

export function activeWorkerPreviewTasks(tasks) {
  return (tasks || []).filter(function (task) {
    return task && !isResolvedStatus(task.status);
  });
}

function statusLabel(status) {
  return String(status || "queued").replace(/_/g, " ");
}

function taskMetrics(tasks) {
  var metrics = {
    total: tasks.length,
    active: 0,
    attention: 0,
    waitingUser: 0,
    completed: 0,
    dismissed: 0,
    resolved: 0,
    unresolved: 0,
  };
  for (var i = 0; i < tasks.length; i++) {
    var status = tasks[i].status || "queued";
    if (isActiveStatus(status)) {
      metrics.active++;
      metrics.unresolved++;
    } else if (isAttentionStatus(status)) {
      metrics.attention++;
      metrics.unresolved++;
    } else if (status === "waiting_user") {
      metrics.waitingUser++;
      metrics.unresolved++;
    } else if (status === "completed") {
      metrics.completed++;
      metrics.resolved++;
    } else if (status === "dismissed" || status === "cancelled") {
      metrics.dismissed++;
      metrics.resolved++;
    }
  }
  return metrics;
}

function previewState(tasks, state) {
  var metrics = state && state.metrics ? state.metrics : taskMetrics(tasks);
  var phase = state && state.phase;
  if (!phase) {
    if (metrics.attention > 0) phase = "reconciling";
    else if (metrics.active > 0) phase = "executing";
    else if (metrics.waitingUser > 0) phase = "waiting_user";
    else phase = "complete";
  }
  return { phase: phase, metrics: metrics };
}

function summaryText(metrics, state) {
  if (state.phase === "complete") {
    return metrics.resolved + "/" + metrics.total + " resolved";
  }
  if (state.phase === "stalled") {
    return "Reconciliation stalled · " + metrics.unresolved + " unresolved";
  }
  if (state.phase === "waiting_user") {
    return metrics.waitingUser + (metrics.waitingUser === 1 ? " decision needed" : " decisions needed") +
      (metrics.resolved > 0 ? " · " + metrics.resolved + " resolved" : "");
  }
  var parts = [];
  if (metrics.active > 0) parts.push(metrics.active + " active");
  if (metrics.attention > 0) {
    parts.push(metrics.attention + " resolving");
  }
  if (metrics.waitingUser > 0) parts.push(metrics.waitingUser + " decision" +
    (metrics.waitingUser === 1 ? "" : "s") + " needed");
  if (metrics.resolved > 0) parts.push(metrics.resolved + " done");
  return parts.length > 0 ? parts.join(" · ") : "No worker activity";
}

function previewTasks(tasks, state) {
  if (state.phase === "reconciling" || state.phase === "stalled") {
    var attentionFirst = tasks.filter(function (task) {
      return isAttentionStatus(task.status || "queued");
    });
    if (attentionFirst.length > 0) return attentionFirst.slice(0, MAX_PREVIEW_WORKERS);
  }
  if (state.phase === "waiting_user") {
    var waiting = tasks.filter(function (task) { return task.status === "waiting_user"; });
    if (waiting.length > 0) return waiting.slice(0, MAX_PREVIEW_WORKERS);
  }
  var active = tasks.filter(function (task) {
    return isActiveStatus(task.status || "queued");
  });
  if (active.length > 0) return active.slice(0, MAX_PREVIEW_WORKERS);
  var attention = tasks.filter(function (task) {
    return isAttentionStatus(task.status || "queued");
  });
  if (attention.length > 0) return attention.slice(0, MAX_PREVIEW_WORKERS);
  return tasks.filter(function (task) {
    return isResolvedStatus(task.status);
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
    'Close "' + (task.title || "Parallel task") + '"? Unfinished work will be recorded as dismissed, its worker will stop, and its conversation will be archived from the sidebar.',
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

function retryReconciliation() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: "retry_orchestration_reconciliation",
    sessionId: store.get("activeSessionId") || null,
  }));
}

function appendSummaryPreview(summary, tasks, state) {
  var preview = document.createElement("span");
  preview.className = "orchestration-summary-workers";
  var visibleTasks = previewTasks(tasks, state);
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

function createSummary(host, tasks, state) {
  var metrics = state.metrics;
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
  count.textContent = summaryText(metrics, state);
  heading.appendChild(label);
  heading.appendChild(count);
  summary.appendChild(heading);
  appendSummaryPreview(summary, tasks, state);

  var toggle = document.createElement("span");
  toggle.className = "orchestration-summary-toggle";
  toggle.innerHTML = iconHtml(isExpanded ? "chevron-up" : "chevron-down");
  toggle.setAttribute("aria-hidden", "true");
  summary.appendChild(toggle);
  summary.addEventListener("click", function () {
    store.set({ orchestrationTaskPreviewExpanded: !isExpanded });
    renderOrchestrationTaskPreview(host, tasks, state);
  });
  return summary;
}

function createTaskRow(task) {
  var row = document.createElement("div");
  row.className = "orchestration-task-item orchestration-task-item-" +
    (task.status || "queued");
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
  if (task.status === "waiting_user") detailParts[0] = "decision needed";
  if (task.status === "dismissed" || task.status === "cancelled") detailParts[0] = "dismissed";
  if (task.provider) detailParts.push(task.provider);
  if (task.model) detailParts.push(task.model);
  if (task.dependencies && task.dependencies.length) {
    detailParts.push("after " + task.dependencies.length + " task" +
      (task.dependencies.length === 1 ? "" : "s"));
  }
  if (task.attempt > 1) detailParts.push("attempt " + task.attempt);
  var detailText = detailParts.join(" · ");
  if (task.status === "waiting_user" && task.userQuestion) {
    detailText = "Decision needed · " + task.userQuestion;
    detail.classList.add("orchestration-task-detail-action");
  } else if (isAttentionStatus(task.status) && task.currentActivity) {
    detailText = statusLabel(task.status) + " · " + task.currentActivity;
    detail.classList.add("orchestration-task-detail-action");
  }
  detail.textContent = detailText;
  var taskTooltip = [];
  if (task.userQuestion) taskTooltip.push("Decision needed: " + task.userQuestion);
  if (task.resolutionReason) taskTooltip.push("Resolution: " + task.resolutionReason);
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

function createStalledNotice(state) {
  var notice = document.createElement("div");
  notice.className = "orchestration-reconciliation-stalled";
  var text = document.createElement("span");
  text.textContent = "The coordinator made no graph progress after three reconciliation turns.";
  var retry = document.createElement("button");
  retry.type = "button";
  retry.className = "orchestration-reconciliation-retry";
  retry.innerHTML = iconHtml("refresh-cw") + "<span>Retry reconciliation</span>";
  retry.addEventListener("click", function () {
    retry.disabled = true;
    retryReconciliation();
  });
  notice.appendChild(text);
  notice.appendChild(retry);
  notice.title = state.metrics.unresolved + " unresolved worker task" +
    (state.metrics.unresolved === 1 ? "" : "s");
  return notice;
}

export function collapseOrchestrationTaskPreview() {
  store.set({ orchestrationTaskPreviewExpanded: false });
}

export function renderOrchestrationTaskPreview(host, tasks, coordinatorState) {
  host.innerHTML = "";
  var activeTasks = activeWorkerPreviewTasks(tasks);
  if (activeTasks.length === 0) return null;
  var activeState = Object.assign({}, coordinatorState || {}, {
    metrics: taskMetrics(activeTasks),
  });
  var state = previewState(activeTasks, activeState);
  host.className = "orchestration-task-preview";
  host.dataset.phase = state.phase;
  host.appendChild(createSummary(host, activeTasks, state));
  if (!store.get("orchestrationTaskPreviewExpanded")) {
    refreshIcons();
    return null;
  }

  var list = document.createElement("div");
  list.id = "orchestration-task-details";
  list.className = "orchestration-task-list";
  if (state.phase === "stalled") list.appendChild(createStalledNotice(state));
  for (var i = 0; i < activeTasks.length; i++) list.appendChild(createTaskRow(activeTasks[i]));
  host.appendChild(list);
  refreshIcons();
  return list;
}
