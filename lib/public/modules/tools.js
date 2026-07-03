import { escapeHtml } from './utils.js';
import { iconHtml, refreshIcons } from './icons.js';
import { openFile } from './filebrowser.js';
import { store } from './store.js';
import {
  initAskUserTools,
  renderAskUserQuestion,
  disableMainInput,
  enableMainInput,
  markAskUserAnswered,
} from './tools-ask-user.js';
import {
  initPermissionTools,
  renderPermissionRequest,
  markPermissionResolved,
  markPermissionCancelled,
  resetPermissionTools,
} from './tools-permission.js';
import {
  initDialogTools,
  renderElicitationRequest,
  markElicitationResolved,
  renderUserDialogRequest,
  markUserDialogResolved,
  resetDialogTools,
} from './tools-dialogs.js';
import {
  initPlanTools,
  renderPlanBanner,
  renderPlanCard,
  isInPlanMode,
  getPlanContent,
  setPlanContent,
  savePlanState,
  restorePlanState,
  resetPlanState,
} from './tools-plan.js';
import {
  initTodoTools,
  handleTodoWrite,
  handleTaskCreate,
  handleTaskUpdate,
  applyDeadSessionTodoCompaction,
  saveTodoState,
  restoreTodoState,
  resetTodoState,
} from './tools-todo.js';
import {
  initThinkingTools,
  startThinking,
  appendThinking,
  stopThinking,
  resetThinkingGroup,
  updateThinkingTokens,
  saveThinkingState,
  restoreThinkingState,
  resetThinkingState,
} from './tools-thinking.js';
import {
  initToolResultTools,
  updateToolResult,
  appendToolOutput,
  markToolDone,
  markAllToolsDone,
} from './tools-results.js';
import {
  initSubagentTools,
  markAllSubagentsDone,
  updateSubagentActivity,
  addSubagentToolEntry,
  updateSubagentProgress,
  initSubagentStop,
  updateSubagentTaskStatus,
  markSubagentDone,
} from './tools-subagents.js';
import {
  initTurnMetaTools,
  resetTurnMetaCost,
  addTurnMeta,
  saveTurnMetaState,
  restoreTurnMetaState,
} from './tools-turn-meta.js';

export { renderAskUserQuestion, disableMainInput, enableMainInput, markAskUserAnswered };
export { renderPermissionRequest, markPermissionResolved, markPermissionCancelled };
export { renderElicitationRequest, markElicitationResolved, renderUserDialogRequest, markUserDialogResolved };
export { renderPlanBanner, renderPlanCard, isInPlanMode, getPlanContent, setPlanContent };
export { handleTodoWrite, handleTaskCreate, handleTaskUpdate, applyDeadSessionTodoCompaction };
export { startThinking, appendThinking, stopThinking, resetThinkingGroup, updateThinkingTokens };
export { updateToolResult, appendToolOutput, markToolDone, markAllToolsDone };
export {
  markAllSubagentsDone,
  updateSubagentActivity,
  addSubagentToolEntry,
  updateSubagentProgress,
  initSubagentStop,
  updateSubagentTaskStatus,
  markSubagentDone,
};
export { resetTurnMetaCost, addTurnMeta };

var ctx;

// During history replay, individual tool renders (todos, file edits, command
// outputs) must not auto-scroll. The history_done handler arms sticky-bottom
// which pins the viewport to the true bottom after the whole replay settles.
// Per-tool scroll calls during replay fight that and re-anchor the user to
// whichever tool widget grew last (commonly the todo widget).
function maybeScrollToBottom() {
  if (store.get('replayingHistory')) return;
  if (ctx && ctx.scrollToBottom) ctx.scrollToBottom();
}

// --- Tool tracking ---
var tools = {};

// --- Tool group tracking ---
var currentToolGroup = null;
var toolGroupCounter = 0;
var toolGroups = {};

// --- Tool helpers ---
var PLAN_MODE_TOOLS = { EnterPlanMode: 1, ExitPlanMode: 1 };
var TODO_TOOLS = { TodoWrite: 1, TaskCreate: 1, TaskUpdate: 1, TaskList: 1, TaskGet: 1 };
var HIDDEN_RESULT_TOOLS = { EnterPlanMode: 1, ExitPlanMode: 1, TaskCreate: 1, TaskUpdate: 1, TaskList: 1, TaskGet: 1, TodoWrite: 1 };

// --- Tool group helpers ---
function closeToolGroup() {
  if (currentToolGroup) {
    currentToolGroup.closed = true;
  }
  currentToolGroup = null;
}

function findToolGroup(groupId) {
  return toolGroups[groupId] || null;
}

function toolGroupSummary(group) {
  var names = group.toolNames;
  var count = names.length;
  var allDone = group.doneCount >= count;

  // Count by tool name
  var counts = {};
  for (var i = 0; i < names.length; i++) {
    counts[names[i]] = (counts[names[i]] || 0) + 1;
  }
  var uniqueNames = Object.keys(counts);

  if (uniqueNames.length === 1) {
    var name = uniqueNames[0];
    var n = counts[name];
    if (allDone) {
      switch (name) {
        case "Read": return "Read " + n + " file" + (n > 1 ? "s" : "");
        case "Edit": return "Edited " + n + " file" + (n > 1 ? "s" : "");
        case "Write": return "Wrote " + n + " file" + (n > 1 ? "s" : "");
        case "Bash": return "Ran " + n + " command" + (n > 1 ? "s" : "");
        case "Grep": return "Searched " + n + " pattern" + (n > 1 ? "s" : "");
        case "Glob": return "Found " + n + " pattern" + (n > 1 ? "s" : "");
        case "Task": return "Ran " + n + " task" + (n > 1 ? "s" : "");
        case "WebSearch": return "Searched " + n + " quer" + (n > 1 ? "ies" : "y");
        case "WebFetch": return "Fetched " + n + " URL" + (n > 1 ? "s" : "");
        default: return "Ran " + n + " tool" + (n > 1 ? "s" : "");
      }
    }
    switch (name) {
      case "Read": return "Reading " + n + " file" + (n > 1 ? "s" : "") + "...";
      case "Edit": return "Editing " + n + " file" + (n > 1 ? "s" : "") + "...";
      case "Write": return "Writing " + n + " file" + (n > 1 ? "s" : "") + "...";
      case "Bash": return "Running " + n + " command" + (n > 1 ? "s" : "") + "...";
      case "Grep": return "Searching " + n + " pattern" + (n > 1 ? "s" : "") + "...";
      case "Glob": return "Finding " + n + " pattern" + (n > 1 ? "s" : "") + "...";
      case "Task": return "Running " + n + " task" + (n > 1 ? "s" : "") + "...";
      case "WebSearch": return "Searching " + n + " quer" + (n > 1 ? "ies" : "y") + "...";
      case "WebFetch": return "Fetching " + n + " URL" + (n > 1 ? "s" : "") + "...";
      default: return "Running " + n + " tool" + (n > 1 ? "s" : "") + "...";
    }
  }

  // Mixed tools
  if (allDone) return "Ran " + count + " tools";
  return "Running " + count + " tools...";
}

function updateToolGroupHeader(group) {
  if (!group || !group.el) return;
  var label = group.el.querySelector(".tool-group-label");
  if (label) label.textContent = toolGroupSummary(group);

  var allDone = group.doneCount >= group.toolCount;
  var statusIcon = group.el.querySelector(".tool-group-status-icon");
  var bullet = group.el.querySelector(".tool-group-bullet");

  if (allDone) {
    group.el.classList.add("done");
    if (group.errorCount > 0) {
      statusIcon.innerHTML = '<span class="err-icon">' + iconHtml("alert-triangle") + '</span>';
      if (bullet) bullet.classList.add("error");
    } else {
      statusIcon.innerHTML = '<span class="check">' + iconHtml("check") + '</span>';
    }
    refreshIcons();
  }

  // Show group header only when 2+ visible tools (or always in mate DM)
  var header = group.el.querySelector(".tool-group-header");
  var isMate = group.el.classList.contains("mate-tool-group");
  if (isMate) {
    // Mate DM: hide entire group when no tools, show collapsed when tools exist
    if (group.toolCount === 0) {
      group.el.style.display = "none";
    } else {
      group.el.style.display = "";
      header.style.display = "";
      if (!group.userToggled) {
        group.el.classList.add("collapsed");
      }
    }
  } else if (group.toolCount >= 2) {
    header.style.display = "";
    // When 2+ tools, ensure collapsed by default (unless user already toggled)
    if (!group.userToggled && !group.el.classList.contains("expanded-by-user")) {
      group.el.classList.add("collapsed");
    }
  } else {
    header.style.display = "none";
    group.el.classList.remove("collapsed");
  }
}

function isPlanFile(filePath) {
  return filePath && filePath.indexOf(".claude/plans/") !== -1;
}

export function toolSummary(name, input) {
  if (!input || typeof input !== "object") return "";
  switch (name) {
    case "Read": return shortPath(input.file_path);
    case "Edit": return shortPath(input.file_path);
    case "Write": return shortPath(input.file_path);
    case "Bash": return (input.command || "").substring(0, 80);
    case "Glob": return input.pattern || "";
    case "Grep": return (input.pattern || "") + (input.path ? " in " + shortPath(input.path) : "");
    case "WebFetch": return input.url || "";
    case "WebSearch": return input.query || "";
    case "Task": return input.description || "";
    case "EnterPlanMode": return "";
    case "ExitPlanMode": return "";
    default: return JSON.stringify(input).substring(0, 60);
  }
}

export function toolActivityText(name, input) {
  if (name === "Bash" && input && input.description) return input.description;
  if (name === "Read" && input && input.file_path) return "Reading " + shortPath(input.file_path);
  if (name === "Edit" && input && input.file_path) return "Editing " + shortPath(input.file_path);
  if (name === "Write" && input && input.file_path) return "Writing " + shortPath(input.file_path);
  if (name === "Grep" && input && input.pattern) return "Searching for " + input.pattern;
  if (name === "Glob" && input && input.pattern) return "Finding " + input.pattern;
  if (name === "WebSearch" && input && input.query) return "Searching: " + input.query;
  if (name === "WebFetch") return "Fetching URL...";
  if (name === "Task" && input && input.description) return input.description;
  if (name === "EnterPlanMode") return "Entering plan mode...";
  if (name === "ExitPlanMode") return "Finalizing the plan...";
  return "Running " + name + "...";
}

function shortPath(p) {
  if (!p) return "";
  var parts = p.split("/");
  return parts.length > 3 ? ".../" + parts.slice(-3).join("/") : p;
}

// --- Tool items ---
export function createToolItem(id, name) {
  ctx.finalizeAssistantBlock();
  stopThinking();

  // Group management: create new group or reuse existing open group
  if (!currentToolGroup || currentToolGroup.closed) {
    toolGroupCounter++;
    var groupEl = document.createElement("div");
    groupEl.className = "tool-group";
    var isMateToolGroup = ctx.isMateDm();
    if (isMateToolGroup) groupEl.classList.add("mate-tool-group");
    groupEl.dataset.groupId = "g" + toolGroupCounter;

    var toolGroupInner =
      '<div class="tool-group-header" style="display:none">' +
      '<span class="tool-group-chevron">' + iconHtml("chevron-right") + '</span>' +
      '<span class="tool-group-bullet"></span>' +
      '<span class="tool-group-label">Running...</span>' +
      '<span class="tool-group-status-icon">' + iconHtml("loader", "icon-spin") + '</span>' +
      '</div>' +
      '<div class="tool-group-items"></div>';

    if (isMateToolGroup) {
      var mateAvatar = ctx.getMateAvatarUrl();
      groupEl.innerHTML =
        '<img class="dm-bubble-avatar dm-bubble-avatar-mate" src="' + escapeHtml(mateAvatar) + '" alt="">' +
        '<div class="dm-bubble-content">' + toolGroupInner + '</div>';
    } else {
      groupEl.innerHTML = toolGroupInner;
    }

    groupEl.querySelector(".tool-group-header").addEventListener("click", function () {
      groupEl.classList.toggle("collapsed");
      if (currentToolGroup) currentToolGroup.userToggled = true;
    });

    ctx.addToMessages(groupEl);
    refreshIcons();

    currentToolGroup = {
      el: groupEl,
      id: "g" + toolGroupCounter,
      toolNames: [],
      toolCount: 0,
      doneCount: 0,
      errorCount: 0,
      closed: false,
    };
    toolGroups[currentToolGroup.id] = currentToolGroup;
  }

  var el = document.createElement("div");
  el.className = "tool-item";
  el.dataset.toolId = id;
  el.innerHTML =
    '<div class="tool-header">' +
    '<span class="tool-chevron">' + iconHtml("chevron-right") + '</span>' +
    '<span class="tool-bullet"></span>' +
    '<span class="tool-name"></span>' +
    '<span class="tool-desc"></span>' +
    '<span class="tool-status-icon">' + iconHtml("loader", "icon-spin") + '</span>' +
    '</div>' +
    '<div class="tool-subtitle">' +
    '<span class="tool-connector">&#9492;</span>' +
    '<span class="tool-subtitle-text">Running...</span>' +
    '</div>';

  el.querySelector(".tool-name").textContent = name;

  // Append to group instead of messages directly
  currentToolGroup.el.querySelector(".tool-group-items").appendChild(el);
  currentToolGroup.toolNames.push(name);
  currentToolGroup.toolCount++;
  updateToolGroupHeader(currentToolGroup);

  refreshIcons();
  maybeScrollToBottom();

  tools[id] = { el: el, name: name, input: null, done: false, groupId: currentToolGroup.id };
  ctx.setActivity("Running " + name + "...");
}

export function updateToolExecuting(id, name, input) {
  var tool = tools[id];
  if (!tool) return;

  tool.input = input;
  var descEl = tool.el.querySelector(".tool-desc");
  descEl.textContent = toolSummary(name, input);

  // Make file path clickable for Read/Edit/Write tools
  var filePath = input && input.file_path;
  if (filePath && (name === "Read" || name === "Edit" || name === "Write")) {
    descEl.classList.add("tool-desc-link");
    descEl.dataset.filePath = filePath;
    descEl.insertAdjacentHTML("beforeend", '<span class="tool-desc-link-icon">' + iconHtml("external-link") + '</span>');
    refreshIcons();
    (function (toolName, toolInput) {
      descEl.onclick = function (e) {
        e.stopPropagation();
        if (toolName === "Edit" && toolInput && (toolInput.old_string || toolInput.new_string)) {
          openFile(filePath, { diff: { oldStr: toolInput.old_string || "", newStr: toolInput.new_string || "" } });
        } else {
          openFile(filePath);
        }
      };
    })(name, input);
  }

  ctx.setActivity(toolActivityText(name, input));

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = toolActivityText(name, input);

  maybeScrollToBottom();
}

// --- Tool group exports ---
export { closeToolGroup };

export function removeToolFromGroup(toolId) {
  var tool = tools[toolId];
  if (!tool || !tool.groupId) return;
  var group = findToolGroup(tool.groupId);
  if (!group) return;
  group.toolCount--;
  // Remove tool name from the names array (remove first occurrence)
  var idx = group.toolNames.indexOf(tool.name);
  if (idx !== -1) group.toolNames.splice(idx, 1);
  if (tool.done) group.doneCount--;
  updateToolGroupHeader(group);
}

// Expose state getters and reset
export function getTools() { return tools; }
export function isPlanFilePath(fp) { return isPlanFile(fp); }
export function getPlanModeTools() { return PLAN_MODE_TOOLS; }
export function getTodoTools() { return TODO_TOOLS; }
export function getHiddenResultTools() { return HIDDEN_RESULT_TOOLS; }

export function saveToolState() {
  var planState = savePlanState();
  var todoState = saveTodoState();
  var thinkingState = saveThinkingState();
  var turnMetaState = saveTurnMetaState();
  return Object.assign({}, todoState, planState, thinkingState, turnMetaState, {
    tools: tools,
    currentToolGroup: currentToolGroup,
    toolGroupCounter: toolGroupCounter,
    toolGroups: toolGroups,
  });
}

export function restoreToolState(saved) {
  tools = saved.tools;
  restoreThinkingState(saved);
  restoreTodoState(saved);
  restorePlanState(saved);
  currentToolGroup = saved.currentToolGroup;
  toolGroupCounter = saved.toolGroupCounter;
  toolGroups = saved.toolGroups;
  restoreTurnMetaState(saved);
}

export function resetToolState() {
  tools = {};
  resetThinkingState();
  resetPlanState();
  resetTodoState();
  resetPermissionTools();
  resetDialogTools();
  currentToolGroup = null;
  toolGroupCounter = 0;
  toolGroups = {};
}

export function initTools(_ctx) {
  ctx = _ctx;
  initAskUserTools(_ctx, {
    stopThinking: stopThinking,
    closeToolGroup: closeToolGroup,
  });
  initPermissionTools(_ctx, {
    stopThinking: stopThinking,
    closeToolGroup: closeToolGroup,
    maybeScrollToBottom: maybeScrollToBottom,
    shortPath: shortPath,
    toolSummary: toolSummary,
    getPlanContent: getPlanContent,
  });
  initDialogTools(_ctx, {
    stopThinking: stopThinking,
    closeToolGroup: closeToolGroup,
    maybeScrollToBottom: maybeScrollToBottom,
  });
  initPlanTools(_ctx, {
    stopThinking: stopThinking,
    closeToolGroup: closeToolGroup,
    maybeScrollToBottom: maybeScrollToBottom,
  });
  initTodoTools(_ctx, {
    maybeScrollToBottom: maybeScrollToBottom,
  });
  initThinkingTools(_ctx, {
    maybeScrollToBottom: maybeScrollToBottom,
  });
  initToolResultTools(_ctx, {
    getTools: getTools,
    findToolGroup: findToolGroup,
    updateToolGroupHeader: updateToolGroupHeader,
    maybeScrollToBottom: maybeScrollToBottom,
  });
  initSubagentTools(_ctx, {
    getTools: getTools,
    maybeScrollToBottom: maybeScrollToBottom,
  });
  initTurnMetaTools(_ctx, {
    closeToolGroup: closeToolGroup,
    maybeScrollToBottom: maybeScrollToBottom,
  });
}
