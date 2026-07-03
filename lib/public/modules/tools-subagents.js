var ctx;
var deps = {};

export function initSubagentTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

function tools() {
  return deps.getTools ? deps.getTools() : {};
}

function maybeScrollToBottom() {
  if (deps.maybeScrollToBottom) deps.maybeScrollToBottom();
}

export function markAllSubagentsDone() {
  var allTools = tools();
  for (var id in allTools) {
    if (!allTools.hasOwnProperty(id)) continue;
    var tool = allTools[id];
    if (!tool || !tool.el) continue;
    var stopBtn = tool.el.querySelector(".subagent-stop-btn");
    if (!stopBtn) continue;
    stopBtn.remove();
    var subtitleText = tool.el.querySelector(".tool-subtitle-text");
    if (subtitleText) {
      var current = (subtitleText.textContent || "").trim();
      if (!/^Agent (finished|failed|stopped|killed)$/i.test(current)) {
        subtitleText.textContent = "Agent stopped";
      }
    }
  }
}

export function updateSubagentActivity(parentToolId, text) {
  var tool = tools()[parentToolId];
  if (!tool || !tool.el) return;

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = text;

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
  var tool = tools()[parentToolId];
  if (!tool || !tool.el) return;

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = text;

  var log = tool.el.querySelector(".subagent-log");
  if (!log) {
    log = document.createElement("div");
    log.className = "subagent-log";
    tool.el.appendChild(log);
  }

  var entry = document.createElement("div");
  entry.className = "subagent-log-entry";
  entry.innerHTML =
    '<span class="subagent-log-bullet"></span>' +
    '<span class="subagent-log-tool"></span>' +
    '<span class="subagent-log-text"></span>';
  entry.querySelector(".subagent-log-tool").textContent = toolName;
  entry.querySelector(".subagent-log-text").textContent = text;
  log.appendChild(entry);

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
  var tool = tools()[parentToolId];
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
  var tool = tools()[parentToolId];
  if (!tool || !tool.el) return;
  var header = tool.el.querySelector(".tool-header");
  if (!header || header.querySelector(".subagent-stop-btn")) return;
  var btn = document.createElement("button");
  btn.className = "subagent-stop-btn";
  btn.textContent = "Stop";
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    if (ctx.ws) ctx.ws.send(JSON.stringify({ type: "stop_task", taskId: taskId, parentToolId: parentToolId }));
    btn.disabled = true;
    btn.textContent = "Stopping...";
  });
  header.appendChild(btn);
}

export function updateSubagentTaskStatus(parentToolId, patch) {
  var tool = tools()[parentToolId];
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
  var tool = tools()[parentToolId];
  if (!tool || !tool.el) return;

  var label = "Agent finished";
  if (status === "failed") label = "Agent failed";
  else if (status === "stopped") label = "Agent stopped";

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = label;

  var stopBtn = tool.el.querySelector(".subagent-stop-btn");
  if (stopBtn) stopBtn.remove();

  if (usage) updateSubagentProgress(parentToolId, usage, null);
}
