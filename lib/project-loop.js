var fs = require("fs");
var path = require("path");
var crypto = require("crypto");
var { execFileSync } = require("child_process");
var { createLoopRegistry } = require("./scheduler");
var loopFilesModule = require("./project-loop-files");
var loopStateModule = require("./project-loop-state");
var loopHandlersModule = require("./project-loop-handlers");

/**
 * Attach loop engine to a project context.
 *
 * ctx fields:
 *   cwd, slug, sm, sdk, send, sendTo, sendToSession, pushModule,
 *   getHubSchedules, getLinuxUserForSession, onProcessingChanged,
 *   hydrateImageRefs
 */
function attachLoop(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var pushModule = ctx.pushModule;
  var notificationsModule = ctx.notificationsModule;
  var getHubSchedules = ctx.getHubSchedules;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var onProcessingChanged = ctx.onProcessingChanged;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var onScheduledTrigger = ctx.onScheduledTrigger;

  // --- Ralph Loop state ---
  var loopState = {
    active: false,
    phase: "idle", // idle | crafting | approval | executing | done
    promptText: "",
    judgeText: "",
    iteration: 0,
    maxIterations: 20,
    baseCommit: null,
    currentSessionId: null,
    judgeSessionId: null,
    results: [],
    stopping: false,
    wizardData: null,
    craftingSessionId: null,
    startedAt: null,
    loopId: null,
    loopFilesId: null,
  };

  function loopDir() {
    var id = loopState.loopFilesId || loopState.loopId;
    if (!id) return null;
    return path.join(cwd, ".claude", "loops", id);
  }

  function generateLoopId() {
    return "loop_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
  }

  // Loop state persistence
  var _loopConfig = require("./config");
  var _loopUtils = require("./utils");
  var _loopDir = path.join(_loopConfig.CONFIG_DIR, "loops");
  var _loopEncodedCwd = _loopUtils.resolveEncodedFile(_loopDir, cwd, ".json");
  var _loopStatePath = path.join(_loopDir, _loopEncodedCwd + ".json");
  var loopFileWatcher;
  var stateStore = loopStateModule.createLoopStateStore({
    cwd: cwd,
    fs: fs,
    path: path,
    statePath: _loopStatePath,
    loopState: loopState,
    checkLoopFiles: function () {
      return loopFilesModule.checkLoopFilesExist({
        fs: fs, path: path, dir: loopDir(),
        isSimple: !!(loopState.wizardData && loopState.wizardData.loopMode === "simple"),
      });
    },
  });
  var saveLoopState = stateStore.save;
  var clearLoopState = stateStore.clear;
  function checkLoopFilesExist() {
    return loopFilesModule.checkLoopFilesExist({
      fs: fs, path: path, dir: loopDir(),
      isSimple: !!(loopState.wizardData && loopState.wizardData.loopMode === "simple"),
    });
  }
  function broadcastLoopFilesStatus() {
    return loopFilesModule.broadcastLoopFilesStatus({
      fs: fs, path: path, loopDir: loopDir,
      isSimple: function () { return !!(loopState.wizardData && loopState.wizardData.loopMode === "simple"); },
      loopState: loopState, send: send, saveLoopState: saveLoopState,
      getCraftingSession: function (id) { return id == null ? null : sm.sessions.get(id); },
      updateRecord: function (id, data) { return loopRegistry.updateRecord(id, data); },
    });
  }
  loopFileWatcher = loopFilesModule.createLoopFileWatcher({ fs: fs, loopDir: loopDir, broadcast: broadcastLoopFilesStatus });
  function startClaudeDirWatch() { loopFileWatcher.start(); }
  function stopClaudeDirWatch() { loopFileWatcher.stop(); }
  stateStore.load();

  // --- Loop Registry (unified one-off + scheduled) ---
  var activeRegistryId = null; // track which registry record triggered current loop
  var pendingTriggers = []; // queue for deferred triggers when skipIfRunning=false

  function triggerFromQueue(record) {
    // For schedule records, resolve the linked task to get loop files
    var loopFilesId = record.id;
    if (record.source === "schedule") {
      if (!record.linkedTaskId) {
        console.error("[loop-registry] Schedule has no linked task: " + record.name);
        return;
      }
      loopFilesId = record.linkedTaskId;
      console.log("[loop-registry] Schedule triggered: " + record.name + " -> linked task " + loopFilesId);
    }

    // Verify the loop directory and PROMPT.md exist
    var recDir = path.join(cwd, ".claude", "loops", loopFilesId);
    try {
      fs.accessSync(path.join(recDir, "PROMPT.md"));
    } catch (e) {
      console.error("[loop-registry] PROMPT.md missing for " + loopFilesId);
      return;
    }
    // Set the loopId to the schedule's own id (not the linked task) so sidebar groups correctly
    loopState.loopId = record.id;
    loopState.loopFilesId = loopFilesId;
    // Restore loopMode from LOOP.json so simple loops work correctly on trigger
    var _triggerCfg = {};
    try { _triggerCfg = JSON.parse(fs.readFileSync(path.join(recDir, "LOOP.json"), "utf8")); } catch (e) {}
    loopState.wizardData = { loopMode: _triggerCfg.loopMode || "judge" };
    activeRegistryId = record.id;
    console.log("[loop-registry] Auto-starting loop: " + record.name + " (" + loopState.loopId + ")");
    send({ type: "schedule_run_started", recordId: record.id });
    startLoop({ maxIterations: record.maxIterations, name: record.name });
  }

  var loopRegistry = createLoopRegistry({
    cwd: cwd,
    onTrigger: function (record) {
      // Non-Ralph scheduled records (e.g. auto-launch) are delegated out and
      // never participate in the loop-active gating below.
      if (record && record.mode === "autolaunch") {
        if (onScheduledTrigger) {
          try { onScheduledTrigger(record); } catch (e) {
            console.error("[loop-registry] onScheduledTrigger error:", e.message);
          }
        }
        return;
      }
      // Skip or queue trigger if a loop is already active (including crafting phase,
      // before the first iteration starts — otherwise a scheduled trigger can fire
      // while the user is still setting up the loop and spawn a duplicate run).
      if (loopState.active || loopState.phase === "executing" || loopState.phase === "crafting") {
        if (record.skipIfRunning !== false) {
          console.log("[loop-registry] Skipping trigger for " + record.name + " — loop already active (skipIfRunning)");
          return;
        }
        console.log("[loop-registry] Loop active, queuing trigger for " + record.name);
        pendingTriggers.push(record);
        return;
      }

      triggerFromQueue(record);
    },
    onChange: function () {
      send({ type: "loop_registry_updated", records: getHubSchedules() });
    },
  });
  loopRegistry.load();
  loopRegistry.startTimer();

  // Wire loop info resolution for session list broadcasts
  sm.setResolveLoopInfo(function (loopId) {
    var rec = loopRegistry.getById(loopId);
    if (!rec) return null;
    return { name: rec.name || null, source: rec.source || null };
  });

  function startLoop(opts) {
    var loopOpts = opts || {};
    var dir = loopDir();
    if (!dir) {
      send({ type: "loop_error", text: "No loop directory. Run the wizard first." });
      return;
    }
    var startData = loopFilesModule.prepareLoopStart({ fs: fs, path: path, dir: dir, cwd: cwd, execFileSync: execFileSync });
    if (startData.error) {
      send({ type: "loop_error", text: startData.error });
      return;
    }
    var isSimple = loopState.wizardData && loopState.wizardData.loopMode === "simple";
    var execution = loopFilesModule.executionState(loopOpts, startData, isSimple);
    loopState.active = true;
    loopState.phase = "executing";
    loopState.promptText = execution.promptText;
    loopState.judgeText = execution.judgeText;
    loopState.iteration = 0;
    loopState.maxIterations = execution.maxIterations;
    loopState.baseCommit = execution.baseCommit;
    loopState.currentSessionId = null;
    loopState.judgeSessionId = null;
    loopState.results = [];
    loopState.stopping = false;
    loopState.name = loopOpts.name || null;
    loopState.settings = execution.settings;
    loopState.startedAt = Date.now();
    saveLoopState();

    stopClaudeDirWatch();

    send({ type: "loop_started", maxIterations: loopState.maxIterations, name: loopState.name });
    runNextIteration();
  }

  function runNextIteration() {
    console.log("[ralph-loop] runNextIteration called, iteration: " + loopState.iteration + ", active: " + loopState.active + ", stopping: " + loopState.stopping);
    if (!loopState.active || loopState.stopping) {
      finishLoop("stopped");
      return;
    }

    loopState.iteration++;
    if (loopState.iteration > loopState.maxIterations) {
      finishLoop("max_iterations");
      return;
    }

    var session = sm.createSession();
    var loopSource = loopRegistry.getById(loopState.loopId);
    var loopName = (loopState.wizardData && loopState.wizardData.name) || (loopSource && loopSource.name) || "";
    var loopSourceTag = (loopSource && loopSource.source) || null;
    var isRalphLoop = loopSourceTag === "ralph";
    session.loop = { active: true, iteration: loopState.iteration, role: "coder", loopId: loopState.loopId, name: loopName, source: loopSourceTag, startedAt: loopState.startedAt };
    session.title = (isRalphLoop ? "Ralph" : "Task") + (loopName ? " " + loopName : "") + " #" + loopState.iteration;
    sm.saveSessionFile(session);
    sm.broadcastSessionList();

    loopState.currentSessionId = session.localId;

    send({
      type: "loop_iteration",
      iteration: loopState.iteration,
      maxIterations: loopState.maxIterations,
      sessionId: session.localId,
    });

    var coderCompleted = false;
    session.onQueryComplete = function(completedSession) {
      if (coderCompleted) return;
      coderCompleted = true;
      if (coderWatchdog) { clearTimeout(coderWatchdog); coderWatchdog = null; }
      console.log("[ralph-loop] Coder #" + loopState.iteration + " onQueryComplete fired, history length: " + completedSession.history.length);
      if (!loopState.active) { console.log("[ralph-loop] Coder: loopState.active is false, skipping"); return; }
      // Check if session ended with error
      var lastItems = completedSession.history.slice(-3);
      var hadError = false;
      for (var i = 0; i < lastItems.length; i++) {
        if (lastItems[i].type === "error" || (lastItems[i].type === "done" && lastItems[i].code === 1)) {
          hadError = true;
          break;
        }
      }
      if (hadError) {
        loopState.results.push({
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Iteration ended with error",
        });
        send({
          type: "loop_verdict",
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Iteration ended with error, retrying...",
        });
        setTimeout(function() { runNextIteration(); }, 2000);
        return;
      }
      var _isSimple = loopState.wizardData && loopState.wizardData.loopMode === "simple";
      if (_isSimple) {
        // Simple mode: no judge, proceed to next iteration or finish
        if (loopState.iteration >= loopState.maxIterations) {
          finishLoop("complete");
        } else {
          setTimeout(function() { runNextIteration(); }, 1000);
        }
      } else if (loopState.judgeText && loopState.maxIterations > 1) {
        runJudge();
      } else {
        finishLoop("pass");
      }
    };

    // Watchdog: if onQueryComplete hasn't fired after 10 minutes, force error and retry
    var coderWatchdog = setTimeout(function() {
      if (!coderCompleted && loopState.active && !loopState.stopping) {
        console.error("[ralph-loop] Coder #" + loopState.iteration + " watchdog triggered — onQueryComplete never fired");
        coderCompleted = true;
        loopState.results.push({
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Coder session timed out (no completion signal)",
        });
        send({
          type: "loop_verdict",
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Coder session timed out, retrying...",
        });
        setTimeout(function() { runNextIteration(); }, 2000);
      }
    }, 10 * 60 * 1000);

    var userMsg = { type: "user_message", text: loopState.promptText };
    session.history.push(userMsg);
    sm.appendToSessionFile(session, userMsg);

    session.isProcessing = true;
    onProcessingChanged();
    session.sentToolResults = {};
    sendToSession(session.localId, { type: "status", status: "processing" });
    session.acceptEditsAfterStart = true;
    session.singleTurn = true;
    if (loopState.settings) session.loopSettings = loopState.settings;
    sdk.startQuery(session, loopState.promptText, undefined, getLinuxUserForSession(session));
  }

  function runJudge() {
    if (!loopState.active || loopState.stopping) {
      finishLoop("stopped");
      return;
    }

    var diff;
    try {
      diff = execFileSync("git", ["diff", loopState.baseCommit], {
        cwd: cwd, encoding: "utf8", timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (e) {
      send({ type: "loop_error", text: "Failed to generate git diff: " + e.message });
      finishLoop("error");
      return;
    }

    var gitLog = "";
    try {
      gitLog = execFileSync("git", ["log", "--oneline", loopState.baseCommit + "..HEAD"], {
        cwd: cwd, encoding: "utf8", timeout: 10000,
      }).trim();
    } catch (e) {}

    var judgePrompt = "You are a judge evaluating whether a coding task has been completed.\n\n" +
      "## Original Task (PROMPT.md)\n\n" + loopState.promptText + "\n\n" +
      "## Evaluation Criteria (JUDGE.md)\n\n" + loopState.judgeText + "\n\n" +
      "## Commit History\n\n```\n" + (gitLog || "(no commits yet)") + "\n```\n\n" +
      "## Changes Made (git diff)\n\n```diff\n" + diff + "\n```\n\n" +
      "Based on the evaluation criteria, has the task been completed successfully?\n\n" +
      "IMPORTANT: The git diff above may not show everything. If criteria involve checking whether " +
      "specific files, classes, or features exist, use tools (Read, Glob, Grep, Bash) to verify " +
      "directly in the codebase. Do NOT assume something is missing just because it is not in the diff.\n\n" +
      "After your evaluation, respond with exactly one of:\n" +
      "- PASS: [brief explanation]\n" +
      "- FAIL: [brief explanation of what is still missing]";

    var judgeSession = sm.createSession();
    var judgeSource = loopRegistry.getById(loopState.loopId);
    var judgeName = (loopState.wizardData && loopState.wizardData.name) || (judgeSource && judgeSource.name) || "";
    var judgeSourceTag = (judgeSource && judgeSource.source) || null;
    var isRalphJudge = judgeSourceTag === "ralph";
    judgeSession.loop = { active: true, iteration: loopState.iteration, role: "judge", loopId: loopState.loopId, name: judgeName, source: judgeSourceTag, startedAt: loopState.startedAt };
    judgeSession.title = (isRalphJudge ? "Ralph" : "Task") + (judgeName ? " " + judgeName : "") + " Judge #" + loopState.iteration;
    sm.saveSessionFile(judgeSession);
    sm.broadcastSessionList();
    loopState.judgeSessionId = judgeSession.localId;

    send({
      type: "loop_judging",
      iteration: loopState.iteration,
      sessionId: judgeSession.localId,
    });

    var judgeCompleted = false;
    judgeSession.onQueryComplete = function(completedSession) {
      if (judgeCompleted) return;
      judgeCompleted = true;
      if (judgeWatchdog) { clearTimeout(judgeWatchdog); judgeWatchdog = null; }
      console.log("[ralph-loop] Judge #" + loopState.iteration + " onQueryComplete fired, history length: " + completedSession.history.length);
      var verdict = parseJudgeVerdict(completedSession);
      console.log("[ralph-loop] Judge verdict: " + (verdict.pass ? "PASS" : "FAIL") + " - " + verdict.explanation);

      loopState.results.push({
        iteration: loopState.iteration,
        verdict: verdict.pass ? "pass" : "fail",
        summary: verdict.explanation,
      });

      send({
        type: "loop_verdict",
        iteration: loopState.iteration,
        verdict: verdict.pass ? "pass" : "fail",
        summary: verdict.explanation,
      });

      if (verdict.pass) {
        finishLoop("pass");
      } else {
        setTimeout(function() { runNextIteration(); }, 1000);
      }
    };

    // Watchdog: judge may use tools to verify, so allow more time
    var judgeWatchdog = setTimeout(function() {
      if (!judgeCompleted && loopState.active && !loopState.stopping) {
        console.error("[ralph-loop] Judge #" + loopState.iteration + " watchdog triggered — onQueryComplete never fired");
        judgeCompleted = true;
        loopState.results.push({
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Judge session timed out (no completion signal)",
        });
        send({
          type: "loop_verdict",
          iteration: loopState.iteration,
          verdict: "error",
          summary: "Judge session timed out, retrying...",
        });
        setTimeout(function() { runNextIteration(); }, 2000);
      }
    }, 10 * 60 * 1000);

    var userMsg = { type: "user_message", text: judgePrompt };
    judgeSession.history.push(userMsg);
    sm.appendToSessionFile(judgeSession, userMsg);

    judgeSession.isProcessing = true;
    onProcessingChanged();
    judgeSession.sentToolResults = {};
    judgeSession.acceptEditsAfterStart = true;
    judgeSession.singleTurn = true;
    if (loopState.settings) judgeSession.loopSettings = loopState.settings;
    sdk.startQuery(judgeSession, judgePrompt, undefined, getLinuxUserForSession(judgeSession));
  }

  function parseJudgeVerdict(session) {
    var text = "";
    for (var i = 0; i < session.history.length; i++) {
      var h = session.history[i];
      if (h.type === "delta" && h.text) text += h.text;
      if (h.type === "text" && h.text) text += h.text;
    }
    console.log("[ralph-loop] Judge raw text (last 500 chars): " + text.slice(-500));
    var upper = text.toUpperCase();
    var passIdx = upper.indexOf("PASS");
    var failIdx = upper.indexOf("FAIL");
    if (passIdx !== -1 && (failIdx === -1 || passIdx < failIdx)) {
      var explanation = text.substring(passIdx + 4).replace(/^[\s:]+/, "").split("\n")[0].trim();
      return { pass: true, explanation: explanation || "Task completed" };
    }
    if (failIdx !== -1) {
      var explanation = text.substring(failIdx + 4).replace(/^[\s:]+/, "").split("\n")[0].trim();
      return { pass: false, explanation: explanation || "Task not yet complete" };
    }
    return { pass: false, explanation: "Could not parse judge verdict" };
  }

  function finishLoop(reason) {
    console.log("[ralph-loop] finishLoop called, reason: " + reason + ", iteration: " + loopState.iteration);

    // Unlock the last coder session so users can continue interacting with it
    if (loopState.currentSessionId) {
      var lastCoderSession = sm.sessions.get(loopState.currentSessionId);
      if (lastCoderSession) {
        loopStateModule.finishSession(sm, lastCoderSession);
      }
    }

    loopState.active = false;
    loopState.phase = "done";
    loopState.stopping = false;
    loopState.currentSessionId = null;
    loopState.judgeSessionId = null;
    saveLoopState();

    send({
      type: "loop_finished",
      reason: reason,
      iterations: loopState.iteration,
      results: loopState.results,
    });

    // Record result in loop registry
    if (loopState.loopId) {
      loopRegistry.recordRun(loopState.loopId, {
        reason: reason,
        startedAt: loopState.startedAt,
        iterations: loopState.iteration,
      });
    }
    if (activeRegistryId) {
      send({ type: "schedule_run_finished", recordId: activeRegistryId, reason: reason, iterations: loopState.iteration });
      activeRegistryId = null;
    }

    if (pushModule) {
      var _finishBody = reason === "pass" || reason === "complete"
        ? "Completed after " + loopState.iteration + " iteration(s)"
        : reason === "max_iterations"
          ? "Reached max iterations (" + loopState.maxIterations + ")"
          : reason === "stopped" ? "Stopped by user" : "Ended due to error";
      pushModule.sendPush({
        type: "done", slug: slug, title: "Loop Complete", body: _finishBody, tag: "ralph-loop-done",
      });
    }

    if (notificationsModule) {
      notificationsModule.notify("loop_complete", {
        reason: reason,
        name: loopState.name,
        iterations: loopState.iteration,
        maxIterations: loopState.maxIterations,
        sessionId: loopState.currentSessionId,
      });
    }

    // Process next queued trigger if any
    if (pendingTriggers.length > 0) {
      var next = pendingTriggers.shift();
      console.log("[loop-registry] Processing queued trigger: " + next.name);
      setTimeout(function () {
        triggerFromQueue(next);
      }, 1000);
    }
  }

  function resumeLoop() {
    var dir = loopDir();
    if (!dir) {
      console.error("[ralph-loop] Cannot resume: no loop directory");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    try {
      loopState.promptText = fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8");
    } catch (e) {
      console.error("[ralph-loop] Cannot resume: missing PROMPT.md");
      loopState.active = false;
      loopState.phase = "idle";
      saveLoopState();
      return;
    }
    var _isSimpleResume = loopState.wizardData && loopState.wizardData.loopMode === "simple";
    if (!_isSimpleResume) {
      try {
        loopState.judgeText = fs.readFileSync(path.join(dir, "JUDGE.md"), "utf8");
      } catch (e) {
        console.error("[ralph-loop] Cannot resume: missing JUDGE.md");
        loopState.active = false;
        loopState.phase = "idle";
        saveLoopState();
        return;
      }
    } else {
      loopState.judgeText = null;
    }
    // Retry the interrupted iteration (runNextIteration will increment)
    if (loopState.iteration > 0) {
      loopState.iteration--;
    }
    console.log("[ralph-loop] Resuming loop, next iteration will be " + (loopState.iteration + 1) + "/" + loopState.maxIterations);
    send({ type: "loop_started", maxIterations: loopState.maxIterations });
    runNextIteration();
  }

  function stopLoop() {
    if (!loopState.active) return;
    console.log("[ralph-loop] stopLoop called");
    loopState.stopping = true;

    // Abort all loop-related sessions (coder + judge)
    var sessionIds = [loopState.currentSessionId, loopState.judgeSessionId];
    for (var i = 0; i < sessionIds.length; i++) {
      if (sessionIds[i] == null) continue;
      var s = sm.sessions.get(sessionIds[i]);
      if (!s) continue;
      // End message queue so SDK exits prompt wait
      if (s.messageQueue) { try { s.messageQueue.end(); } catch (e) {} }
      // Abort active API call
      if (s.abortController) { try { s.abortController.abort(); } catch (e) {} }
    }

    send({ type: "loop_stopping" });

    // Fallback: force finish if onQueryComplete hasn't fired after 5s
    setTimeout(function() {
      if (loopState.active && loopState.stopping) {
        console.log("[ralph-loop] Stop fallback triggered — forcing finishLoop");
        finishLoop("stopped");
      }
    }, 5000);
  }

  // --- Message handler for loop-related messages ---
  var handleLoopMessage = loopHandlersModule.createLoopMessageHandler({
    cwd: cwd, fs: fs, path: path, files: loopFilesModule,
    loopState: loopState, loopDir: loopDir, saveLoopState: saveLoopState,
    clearLoopState: clearLoopState, send: send, sendTo: sendTo,
    sendToSession: sendToSession, sm: sm, sdk: sdk,
    loopRegistry: loopRegistry, getHubSchedules: getHubSchedules,
    getLinuxUserForSession: getLinuxUserForSession,
    onProcessingChanged: onProcessingChanged, hydrateImageRefs: hydrateImageRefs,
    startLoop: startLoop, stopLoop: stopLoop,
    generateLoopId: generateLoopId, startClaudeDirWatch: startClaudeDirWatch,
    stopClaudeDirWatch: stopClaudeDirWatch,
    setActiveRegistryId: function (id) { activeRegistryId = id; },
  });

  // --- Connection state: send loop state to newly connected client ---
  function sendConnectionState(ws) {
    var messages = loopStateModule.connectionMessages({
      cwd: cwd, fs: fs, path: path, loopState: loopState, loopDir: loopDir,
      fileStatus: function (dir, isSimple) {
        return loopFilesModule.loopFileStatus({ fs: fs, path: path, dir: dir, isSimple: isSimple });
      },
    });
    for (var i = 0; i < messages.length; i++) sendTo(ws, messages[i]);
  }

  // --- Public API ---
  return {
    loopState: loopState,
    loopRegistry: loopRegistry,
    loopDir: loopDir,
    startLoop: startLoop,
    stopLoop: stopLoop,
    resumeLoop: resumeLoop,
    handleLoopMessage: handleLoopMessage,
    sendConnectionState: sendConnectionState,
    stopClaudeDirWatch: stopClaudeDirWatch,
    getSchedules: function () { return loopRegistry.getAll(); },
    importSchedule: function (data) { return loopRegistry.register(data); },
    removeSchedule: function (id) { return loopRegistry.remove(id); },
    stopTimer: function () { loopRegistry.stopTimer(); },
  };
}

module.exports = { attachLoop: attachLoop };
