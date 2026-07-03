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

export { renderAskUserQuestion, disableMainInput, enableMainInput, markAskUserAnswered };
export { renderPermissionRequest, markPermissionResolved, markPermissionCancelled };
export { renderElicitationRequest, markElicitationResolved, renderUserDialogRequest, markUserDialogResolved };
export { renderPlanBanner, renderPlanCard, isInPlanMode, getPlanContent, setPlanContent };
export { handleTodoWrite, handleTaskCreate, handleTaskUpdate, applyDeadSessionTodoCompaction };
export { startThinking, appendThinking, stopThinking, resetThinkingGroup, updateThinkingTokens };
export { updateToolResult, appendToolOutput, markToolDone, markAllToolsDone };

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

// Finalize any sub-agent (Task) blocks still showing "Running…" when a turn
// ends without an explicit subagent_done (e.g. API error, interrupt, empty
// turn, watchdog abort). A running sub-agent still has its Stop button; without
// this the Agent row is stuck on "Running…" forever even though the turn ended.
export function markAllSubagentsDone() {
  for (var id in tools) {
    if (!tools.hasOwnProperty(id)) continue;
    var tool = tools[id];
    if (!tool || !tool.el) continue;
    var stopBtn = tool.el.querySelector(".subagent-stop-btn");
    if (!stopBtn) continue; // not a sub-agent that's still running
    stopBtn.remove();
    var subtitleText = tool.el.querySelector(".tool-subtitle-text");
    if (subtitleText) {
      var current = (subtitleText.textContent || "").trim();
      // Don't clobber an already-terminal label.
      if (!/^Agent (finished|failed|stopped|killed)$/i.test(current)) {
        subtitleText.textContent = "Agent stopped";
      }
    }
  }
}

// --- Sub-agent (Task tool) log ---
export function updateSubagentActivity(parentToolId, text) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;

  // Update subtitle text with current activity
  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = text;

  // Update or create the subagent log
  var log = tool.el.querySelector(".subagent-log");
  if (!log) {
    log = document.createElement("div");
    log.className = "subagent-log";
    tool.el.appendChild(log);
  }

  ctx.setActivity(text);
  maybeScrollToBottom();
}

export function addSubagentToolEntry(parentToolId, toolName, toolId, text) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;

  // Update subtitle
  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = text;

  // Create log if needed
  var log = tool.el.querySelector(".subagent-log");
  if (!log) {
    log = document.createElement("div");
    log.className = "subagent-log";
    tool.el.appendChild(log);
  }

  // Add entry
  var entry = document.createElement("div");
  entry.className = "subagent-log-entry";
  entry.innerHTML =
    '<span class="subagent-log-bullet"></span>' +
    '<span class="subagent-log-tool"></span>' +
    '<span class="subagent-log-text"></span>';
  entry.querySelector(".subagent-log-tool").textContent = toolName;
  entry.querySelector(".subagent-log-text").textContent = text;
  log.appendChild(entry);

  // Auto-scroll to latest entry
  log.scrollTop = log.scrollHeight;

  ctx.setActivity(text);
  maybeScrollToBottom();
}

function fmtTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return String(n);
}

function fmtDuration(ms) {
  var secs = Math.floor(ms / 1000);
  if (secs >= 60) return Math.floor(secs / 60) + "m " + (secs % 60) + "s";
  return secs + "s";
}

export function updateSubagentProgress(parentToolId, usage, lastToolName, summary) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;
  var progressEl = tool.el.querySelector(".subagent-progress");
  if (!progressEl) {
    progressEl = document.createElement("div");
    progressEl.className = "subagent-progress";
    var log = tool.el.querySelector(".subagent-log");
    if (log) tool.el.insertBefore(progressEl, log);
    else tool.el.appendChild(progressEl);
  }
  var parts = [];
  if (usage) {
    if (usage.total_tokens) parts.push(fmtTokens(usage.total_tokens) + " tokens");
    if (usage.tool_uses) parts.push(usage.tool_uses + " tools");
    if (usage.duration_ms) parts.push(fmtDuration(usage.duration_ms));
  }
  if (lastToolName) parts.push(lastToolName);
  progressEl.textContent = parts.join(" · ");

  // AI-generated progress summary (agentProgressSummaries)
  if (summary) {
    var summaryEl = tool.el.querySelector(".subagent-summary");
    if (!summaryEl) {
      summaryEl = document.createElement("div");
      summaryEl.className = "subagent-summary";
      progressEl.parentNode.insertBefore(summaryEl, progressEl.nextSibling);
    }
    summaryEl.textContent = summary;
  }
}

export function initSubagentStop(parentToolId, taskId) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;
  var header = tool.el.querySelector(".tool-header");
  if (!header || header.querySelector(".subagent-stop-btn")) return;
  var btn = document.createElement("button");
  btn.className = "subagent-stop-btn";
  btn.textContent = "Stop";
  btn.addEventListener("click", function(e) {
    e.stopPropagation();
    if (ctx.ws) ctx.ws.send(JSON.stringify({ type: "stop_task", taskId: taskId, parentToolId: parentToolId }));
    btn.disabled = true;
    btn.textContent = "Stopping...";
  });
  header.appendChild(btn);
}

export function updateSubagentTaskStatus(parentToolId, patch) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;
  if (patch.description) {
    var summaryEl = tool.el.querySelector(".subagent-summary");
    if (!summaryEl) {
      var progressEl = tool.el.querySelector(".subagent-progress");
      if (progressEl) {
        summaryEl = document.createElement("div");
        summaryEl.className = "subagent-summary";
        progressEl.parentNode.insertBefore(summaryEl, progressEl.nextSibling);
      }
    }
    if (summaryEl) summaryEl.textContent = patch.description;
  }
  if (patch.status === "failed" || patch.status === "killed") {
    var subtitleText = tool.el.querySelector(".tool-subtitle-text");
    if (subtitleText) subtitleText.textContent = patch.status === "failed" ? "Agent failed" : "Agent killed";
    var stopBtn = tool.el.querySelector(".subagent-stop-btn");
    if (stopBtn) stopBtn.remove();
  }
}

export function markSubagentDone(parentToolId, status, summary, usage) {
  var tool = tools[parentToolId];
  if (!tool || !tool.el) return;

  var label = "Agent finished";
  if (status === "failed") label = "Agent failed";
  else if (status === "stopped") label = "Agent stopped";

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = label;

  // Remove stop button
  var stopBtn = tool.el.querySelector(".subagent-stop-btn");
  if (stopBtn) stopBtn.remove();

  // Final usage update
  if (usage) updateSubagentProgress(parentToolId, usage, null);
}

var _lastCumulativeCost = 0;

export function resetTurnMetaCost() {
  _lastCumulativeCost = 0;
}

export function addTurnMeta(cost, duration) {
  closeToolGroup();
  var div = document.createElement("div");
  div.className = "turn-meta";
  div.dataset.turn = ctx.turnCounter;
  var parts = [];
  if (cost != null) {
    // cost is cumulative total_cost_usd from the SDK.
    // When the SDK session restarts, total_cost_usd resets to 0 so cost
    // can drop below _lastCumulativeCost.  In that case the entire cost
    // value IS the delta for this turn (fresh SDK session).
    var delta = cost - _lastCumulativeCost;
    if (delta < 0) delta = cost;
    _lastCumulativeCost = cost;
    var deltaStr = delta > 0 ? "+$" + delta.toFixed(4) : "$0.0000";
    parts.push(deltaStr + " \u2192 $" + cost.toFixed(4));
  }
  if (duration != null) parts.push((duration / 1000).toFixed(1) + "s");
  if (parts.length) {
    div.textContent = parts.join(" \u00b7 ");
    ctx.addToMessages(div);
    maybeScrollToBottom();
  }
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
  return Object.assign({}, todoState, planState, thinkingState, {
    tools: tools,
    currentToolGroup: currentToolGroup,
    toolGroupCounter: toolGroupCounter,
    toolGroups: toolGroups,
    lastCumulativeCost: _lastCumulativeCost,
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
  _lastCumulativeCost = saved.lastCumulativeCost || 0;
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
  // NOTE: do NOT reset _lastCumulativeCost here — it must persist across
  // turns so addTurnMeta can compute per-turn deltas.  It is only cleared
  // on new conversation via resetTurnMetaCost().
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
}
