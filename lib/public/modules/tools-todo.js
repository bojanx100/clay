import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';

var ctx;
var deps = {};
var todoItems = [];
var todoWidgetEl = null;
var todoWidgetVisible = true;
var todoObserver = null;
var todoDeadCompact = false;
var todoMeta = normalizeTodoMeta();

export function initTodoTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

function maybeScrollToBottom() {
  if (deps.maybeScrollToBottom) deps.maybeScrollToBottom();
}

function todoStatusIcon(status) {
  switch (status) {
    case "completed": return iconHtml("check-circle");
    case "in_progress": return iconHtml("loader", "icon-spin");
    default: return iconHtml("circle");
  }
}

export function handleTodoWrite(input) {
  if (!input || !Array.isArray(input.todos)) return;
  todoMeta = normalizeTodoMeta(input.meta);
  todoItems = input.todos.map(function (t, i) {
    return {
      id: t.id || String(i + 1),
      content: t.content || t.subject || "",
      status: t.status || "pending",
      activeForm: t.activeForm || "",
    };
  });
  renderTodoWidget();
  applyDeadSessionTodoCompaction();
}

export function handleTaskCreate(input) {
  if (!input) return;
  todoMeta = normalizeTodoMeta();
  var id = String(todoItems.length + 1);
  todoItems.push({
    id: id,
    content: input.subject || input.description || "",
    status: "pending",
    activeForm: input.activeForm || "",
  });
  renderTodoWidget();
}

export function handleTaskUpdate(input) {
  if (!input || !input.taskId) return;
  todoMeta = normalizeTodoMeta();
  for (var i = 0; i < todoItems.length; i++) {
    if (todoItems[i].id === input.taskId) {
      if (input.status === "deleted") {
        todoItems.splice(i, 1);
      } else {
        if (input.status) todoItems[i].status = input.status;
        if (input.subject) todoItems[i].content = input.subject;
        if (input.activeForm) todoItems[i].activeForm = input.activeForm;
      }
      break;
    }
  }
  renderTodoWidget();
}

function normalizeTodoMeta(meta) {
  if (meta && meta.variant === "plan") {
    return {
      variant: "plan",
      title: "Plan",
      icon: "map",
      showProgress: false,
      showCompletedCount: false,
      stickyEnabled: false,
    };
  }
  return {
    variant: "tasks",
    title: "Tasks",
    icon: "list-checks",
    showProgress: true,
    showCompletedCount: true,
    stickyEnabled: true,
  };
}

function renderTodoWidget() {
  if (todoItems.length === 0) {
    if (todoWidgetEl) { todoWidgetEl.remove(); todoWidgetEl = null; }
    if (todoObserver) { todoObserver.disconnect(); todoObserver = null; }
    todoWidgetVisible = true;
    todoMeta = normalizeTodoMeta();
    updateTodoSticky();
    return;
  }

  var isNew = !todoWidgetEl;
  if (isNew) {
    todoWidgetEl = document.createElement("div");
    todoWidgetEl.className = "todo-widget";
  }
  todoWidgetEl.className = "todo-widget"
    + (todoMeta.variant === "plan" ? " todo-widget-plan" : "")
    + (todoDeadCompact ? " todo-widget-dead-compact" : "");

  var completed = 0;
  for (var i = 0; i < todoItems.length; i++) {
    if (todoItems[i].status === "completed") completed++;
  }

  var countText = todoMeta.showCompletedCount
    ? (completed + "/" + todoItems.length)
    : (todoItems.length + " " + (todoItems.length === 1 ? "step" : "steps"));

  var html = '<div class="todo-header">' +
    '<span class="todo-header-icon">' + iconHtml(todoMeta.icon) + '</span>' +
    '<span class="todo-header-title">' + todoMeta.title + '</span>' +
    '<span class="todo-header-count">' + countText + '</span>' +
    '</div>';
  if (todoMeta.showProgress) {
    html += '<div class="todo-progress"><div class="todo-progress-bar" style="width:' +
      (todoItems.length > 0 ? Math.round(completed / todoItems.length * 100) : 0) + '%"></div></div>';
  }
  html += '<div class="todo-items">';
  for (var j = 0; j < todoItems.length; j++) {
    var t = todoItems[j];
    var statusClass = t.status === "completed" ? "completed" : t.status === "in_progress" ? "in-progress" : "pending";
    html += '<div class="todo-item ' + statusClass + '">' +
      '<span class="todo-item-icon">' + todoStatusIcon(t.status) + '</span>' +
      '<span class="todo-item-text">' + escapeHtml(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content) + '</span>' +
      '</div>';
  }
  html += '</div>';

  todoWidgetEl.innerHTML = html;

  if (isNew) {
    ctx.addToMessages(todoWidgetEl);
    setupTodoObserver();
    todoWidgetEl.addEventListener("click", function (e) {
      if (!todoWidgetEl.classList.contains("todo-widget-dead-compact")) return;
      var header = e.target.closest(".todo-header");
      if (!header) return;
      todoWidgetEl.classList.toggle("todo-widget-dead-expanded");
    });
  }
  updateTodoSticky();
  refreshIcons();
  maybeScrollToBottom();
}

export function applyDeadSessionTodoCompaction() {
  var isLive = !!store.get('sessionIsProcessing');
  var hasUnfinished = false;
  for (var i = 0; i < todoItems.length; i++) {
    var s = todoItems[i].status;
    if (s === "in_progress" || s === "pending") { hasUnfinished = true; break; }
  }
  todoDeadCompact = !isLive && hasUnfinished;
  if (todoWidgetEl) {
    todoWidgetEl.classList.toggle("todo-widget-dead-compact", todoDeadCompact);
    if (!todoDeadCompact) todoWidgetEl.classList.remove("todo-widget-dead-expanded");
  }
}

function setupTodoObserver() {
  if (todoObserver) { todoObserver.disconnect(); todoObserver = null; }
  if (!todoWidgetEl) return;

  var messagesEl = document.getElementById("messages");
  if (!messagesEl) return;

  todoObserver = new IntersectionObserver(function (entries) {
    todoWidgetVisible = entries[0].isIntersecting;
    updateTodoStickyVisibility();
  }, { root: messagesEl, threshold: 0 });

  todoObserver.observe(todoWidgetEl);
}

function updateTodoStickyVisibility() {
  var stickyEl = document.getElementById("todo-sticky");
  if (!stickyEl) return;
  if (!todoMeta.stickyEnabled) {
    stickyEl.classList.add("hidden");
    return;
  }

  if (todoWidgetVisible) {
    stickyEl.classList.add("hidden");
  } else {
    var hasActive = false;
    for (var i = 0; i < todoItems.length; i++) {
      if (todoItems[i].status !== "completed") { hasActive = true; break; }
    }
    if (hasActive) {
      stickyEl.classList.remove("hidden");
    }
  }
}

function updateTodoSticky() {
  var stickyEl = document.getElementById("todo-sticky");
  if (!stickyEl) return;
  if (!todoMeta.stickyEnabled) {
    stickyEl.classList.add("hidden");
    stickyEl.innerHTML = "";
    return;
  }

  var hasActive = false;
  for (var i = 0; i < todoItems.length; i++) {
    if (todoItems[i].status !== "completed") { hasActive = true; break; }
  }
  if (!hasActive) {
    stickyEl.classList.add("hidden");
    return;
  }

  var completed = 0;
  for (var j = 0; j < todoItems.length; j++) {
    if (todoItems[j].status === "completed") completed++;
  }
  var pct = Math.round(completed / todoItems.length * 100);
  var wasCollapsed = stickyEl.innerHTML === "" ? true : stickyEl.classList.contains("collapsed");

  var inProgressItem = null;
  for (var k = 0; k < todoItems.length; k++) {
    if (todoItems[k].status === "in_progress") { inProgressItem = todoItems[k]; break; }
  }

  var html = '<div class="todo-sticky-inner">' +
    '<div class="todo-sticky-header">' +
    '<span class="todo-sticky-icon">' + iconHtml("list-checks") + '</span>' +
    '<span class="todo-sticky-title">Tasks</span>' +
    (inProgressItem ? '<span class="todo-sticky-active">' + iconHtml("loader", "icon-spin") + ' ' + escapeHtml(inProgressItem.activeForm || inProgressItem.content) + '</span>' : '') +
    '<span class="todo-sticky-count">' + completed + '/' + todoItems.length + '</span>' +
    '<span class="todo-sticky-chevron">' + iconHtml("chevron-down") + '</span>' +
    '</div>' +
    '<div class="todo-sticky-progress"><div class="todo-sticky-progress-bar" style="width:' + pct + '%"></div></div>' +
    '<div class="todo-sticky-items">';

  for (var n = 0; n < todoItems.length; n++) {
    var t = todoItems[n];
    var statusClass = t.status === "completed" ? "completed" : t.status === "in_progress" ? "in-progress" : "pending";
    html += '<div class="todo-sticky-item ' + statusClass + '">' +
      '<span class="todo-sticky-item-icon">' + todoStatusIcon(t.status) + '</span>' +
      '<span class="todo-sticky-item-text">' + escapeHtml(t.status === "in_progress" && t.activeForm ? t.activeForm : t.content) + '</span>' +
      '</div>';
  }

  html += '</div></div>';
  stickyEl.innerHTML = html;

  if (todoWidgetVisible) {
    stickyEl.classList.add("hidden");
  } else {
    stickyEl.classList.remove("hidden");
  }
  if (wasCollapsed) stickyEl.classList.add("collapsed");

  stickyEl.querySelector(".todo-sticky-header").addEventListener("click", function () {
    stickyEl.classList.toggle("collapsed");
  });

  refreshIcons();
}

export function saveTodoState() {
  return {
    todoWidgetEl: todoWidgetEl,
    todoMeta: todoMeta,
  };
}

export function restoreTodoState(saved) {
  todoWidgetEl = saved.todoWidgetEl;
  todoMeta = saved.todoMeta || normalizeTodoMeta();
  if (todoWidgetEl) {
    setupTodoObserver();
  }
}

export function resetTodoState() {
  todoItems = [];
  todoMeta = normalizeTodoMeta();
  todoWidgetEl = null;
  todoWidgetVisible = true;
  todoDeadCompact = false;
  if (todoObserver) { todoObserver.disconnect(); todoObserver = null; }
  var stickyEl = document.getElementById("todo-sticky");
  if (stickyEl) { stickyEl.classList.add("hidden"); stickyEl.innerHTML = ""; }
}
