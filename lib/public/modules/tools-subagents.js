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

// Per-run live state, keyed by parentToolId. Drives a local 1s ticker so the
// widget keeps advancing between server progress events (which can be many
// seconds apart during a long tool call).
var runState = {};
// Rolling history of completed run durations (ms), used as the ETA baseline.
var recentDurations = [];
var MAX_HISTORY = 20;

function avgBudget() {
  if (!recentDurations.length) return 0;
  var sum = 0;
  for (var i = 0; i < recentDurations.length; i++) sum += recentDurations[i];
  return sum / recentDurations.length;
}

function stopRunTimer(parentToolId) {
  var st = runState[parentToolId];
  if (st && st.timerId) {
    clearInterval(st.timerId);
    st.timerId = null;
  }
}

function ensureRun(parentToolId, usage) {
  var st = runState[parentToolId];
  if (!st) {
    var elapsedBase = usage && usage.duration_ms ? usage.duration_ms : 0;
    st = {
      startMs: Date.now() - elapsedBase,
      timerId: null,
      usage: usage || null,
      lastToolName: null,
      done: false,
      failed: false,
      finalElapsed: null,
    };
    runState[parentToolId] = st;
  } else if (usage) {
    st.usage = usage;
  }
  // Reconcile the local clock with server-reported elapsed: if the server says
  // more time has passed than our local ticker (late start, backgrounded tab),
  // pull startMs back so we never under-report. Never fast-forward past it.
  if (usage && usage.duration_ms && Date.now() - st.startMs < usage.duration_ms) {
    st.startMs = Date.now() - usage.duration_ms;
  }
  if (!st.timerId && !st.done) {
    st.timerId = setInterval(function () {
      renderProgressLine(parentToolId);
    }, 1000);
  }
  return st;
}

function finalizeRun(parentToolId, usage, record) {
  stopRunTimer(parentToolId);
  var st = runState[parentToolId];
  if (!st) return;
  st.done = true;
  if (usage) st.usage = usage;
  var elapsed = usage && usage.duration_ms ? usage.duration_ms : Date.now() - st.startMs;
  st.finalElapsed = elapsed;
  if (record && elapsed > 0) {
    recentDurations.push(elapsed);
    if (recentDurations.length > MAX_HISTORY) recentDurations.shift();
  }
}

function ensureProgressEls(tool) {
  var el = tool.el;
  var row = el.querySelector(".subagent-progress");
  if (!row) {
    row = document.createElement("div");
    row.className = "subagent-progress";
    row.innerHTML =
      '<span class="subagent-pulse"></span>' +
      '<span class="subagent-progress-text"></span>' +
      '<span class="subagent-progress-eta"></span>';
    var log = el.querySelector(".subagent-log");
    if (log) el.insertBefore(row, log);
    else el.appendChild(row);
  }
  var bar = el.querySelector(".subagent-progressbar");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "subagent-progressbar";
    bar.innerHTML = '<div class="subagent-progressbar-fill"></div>';
    if (row.nextSibling) row.parentNode.insertBefore(bar, row.nextSibling);
    else row.parentNode.appendChild(bar);
  }
  return {
    row: row,
    bar: bar,
    text: row.querySelector(".subagent-progress-text"),
    eta: row.querySelector(".subagent-progress-eta"),
    fill: bar.querySelector(".subagent-progressbar-fill"),
    pulse: row.querySelector(".subagent-pulse"),
  };
}

function setSummary(tool, text) {
  var summaryEl = tool.el.querySelector(".subagent-summary");
  if (!summaryEl) {
    summaryEl = document.createElement("div");
    summaryEl.className = "subagent-summary";
    var anchor = tool.el.querySelector(".subagent-progressbar") || tool.el.querySelector(".subagent-progress");
    if (anchor) anchor.parentNode.insertBefore(summaryEl, anchor.nextSibling);
    else tool.el.appendChild(summaryEl);
  }
  summaryEl.textContent = text;
}

function renderProgressLine(parentToolId) {
  var tool = tools()[parentToolId];
  if (!tool || !tool.el) {
    stopRunTimer(parentToolId);
    return;
  }
  var st = runState[parentToolId];
  if (!st) return;
  var els = ensureProgressEls(tool);
  var usage = st.usage || {};
  var elapsed = st.done && st.finalElapsed != null ? st.finalElapsed : Date.now() - st.startMs;

  var parts = [];
  if (usage.total_tokens) parts.push(fmtTokens(usage.total_tokens) + " tokens");
  if (usage.tool_uses) parts.push(usage.tool_uses + " tools");
  parts.push(fmtDuration(elapsed));
  if (st.lastToolName) parts.push(st.lastToolName);

  if (st.done) {
    els.text.textContent = parts.join(" · ");
    els.eta.textContent = "";
    els.bar.classList.remove("indeterminate");
    els.bar.classList.toggle("failed", !!st.failed);
    els.fill.style.width = "100%";
    els.pulse.style.display = "none";
    return;
  }

  els.pulse.style.display = "";
  var budget = avgBudget();
  if (budget > 0) {
    els.bar.classList.remove("indeterminate");
    var frac = elapsed / budget;
    if (frac < 0) frac = 0;
    if (frac > 0.95) frac = 0.95;
    els.fill.style.width = (frac * 100).toFixed(1) + "%";
    var remain = budget - elapsed;
    if (remain < 0) remain = 0;
    els.eta.textContent = "~" + fmtDuration(remain) + " left (est.)";
    els.text.textContent = parts.join(" · ");
  } else {
    els.bar.classList.add("indeterminate");
    els.fill.style.width = "";
    els.eta.textContent = "";
    els.text.textContent = "working… " + parts.join(" · ");
  }
}

export function markAllSubagentsDone() {
  for (var pid in runState) {
    if (!runState.hasOwnProperty(pid)) continue;
    stopRunTimer(pid);
    var run = runState[pid];
    if (run && !run.done) {
      run.done = true;
      if (run.finalElapsed == null) run.finalElapsed = Date.now() - run.startMs;
      renderProgressLine(pid);
    }
  }
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
  var st = ensureRun(parentToolId, usage);
  if (usage) st.usage = usage;
  if (lastToolName) st.lastToolName = lastToolName;
  renderProgressLine(parentToolId);
  if (summary) setSummary(tool, summary);
}

export function initSubagentStop(parentToolId, taskId) {
  var tool = tools()[parentToolId];
  if (!tool || !tool.el) return;
  // Start the live clock the moment the agent starts, before any progress event.
  ensureRun(parentToolId, null);
  renderProgressLine(parentToolId);
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
  if (patch.description) setSummary(tool, patch.description);
  if (patch.status === "failed" || patch.status === "killed") {
    var subtitleText = tool.el.querySelector(".tool-subtitle-text");
    if (subtitleText) subtitleText.textContent = patch.status === "failed" ? "Agent failed" : "Agent killed";
    var stopBtn = tool.el.querySelector(".subagent-stop-btn");
    if (stopBtn) stopBtn.remove();
    finalizeRun(parentToolId, null, false);
    var st = runState[parentToolId];
    if (st) st.failed = true;
    renderProgressLine(parentToolId);
  }
}

export function markSubagentDone(parentToolId, status, summary, usage) {
  var isFail = status === "failed" || status === "killed" || status === "stopped";
  var st = runState[parentToolId];
  if (st) st.failed = isFail;
  // Record only successful runs into the ETA baseline.
  finalizeRun(parentToolId, usage, !isFail);

  var tool = tools()[parentToolId];
  if (!tool || !tool.el) return;

  var label = "Agent finished";
  if (status === "failed") label = "Agent failed";
  else if (status === "killed") label = "Agent killed";
  else if (status === "stopped") label = "Agent stopped";

  var subtitleText = tool.el.querySelector(".tool-subtitle-text");
  if (subtitleText) subtitleText.textContent = label;

  var stopBtn = tool.el.querySelector(".subagent-stop-btn");
  if (stopBtn) stopBtn.remove();

  if (summary) setSummary(tool, summary);
  renderProgressLine(parentToolId);
}
