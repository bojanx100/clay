import { store } from './store.js';
import { addSystemMessage } from './app-rendering.js';
import { enableMainInput } from './tools.js';
import { showLoopBanner, updateLoopBanner, updateLoopInputVisibility, showRalphApprovalBar, updateRalphApprovalStatus, openRalphPreviewModal, showExecModal, updateExecModalStatus } from './app-loop-ui.js';
import { handleLoopRegistryUpdated, handleScheduleRunStarted, handleScheduleRunFinished, handleLoopScheduled, isSchedulerOpen, enterCraftingMode, exitCraftingMode, handleLoopRegistryFiles } from './scheduler.js';

var inputEl = document.getElementById("input");

export function handleLoopMessage(msg) {
  switch (msg.type) {
    case "loop_registry_updated":
      handleLoopRegistryUpdated(msg);
      return true;
    case "schedule_run_started":
      handleScheduleRunStarted(msg);
      return true;
    case "schedule_run_finished":
      handleScheduleRunFinished(msg);
      return true;
    case "loop_scheduled":
      handleLoopScheduled(msg);
      return true;
    case "loop_available":
      store.set({ loopAvailable: msg.available, loopActive: msg.active, loopIteration: msg.iteration || 0, loopMaxIterations: msg.maxIterations || 20, loopBannerName: msg.name || null });
      var availableState = store.snap();
      if (availableState.loopActive) {
        showLoopBanner(true);
        if (availableState.loopIteration > 0) {
          updateLoopBanner(availableState.loopIteration, availableState.loopMaxIterations, "running");
        }
        inputEl.disabled = true;
        inputEl.placeholder = (availableState.loopBannerName || "Loop") + " is running...";
      }
      return true;
    case "loop_started":
      store.set({ loopActive: true, ralphPhase: "executing", loopIteration: 0, loopMaxIterations: msg.maxIterations, loopBannerName: msg.name || null });
      showLoopBanner(true);
      var startedName = store.get('loopBannerName');
      addSystemMessage((startedName || "Loop") + " started (max " + msg.maxIterations + " iterations)", false);
      inputEl.disabled = true;
      inputEl.placeholder = (startedName || "Loop") + " is running...";
      return true;
    case "loop_iteration":
      store.set({ loopIteration: msg.iteration, loopMaxIterations: msg.maxIterations });
      updateLoopBanner(msg.iteration, msg.maxIterations, "running");
      var iterationName = store.get('loopBannerName');
      addSystemMessage((iterationName || "Loop") + " iteration #" + msg.iteration + " started", false);
      inputEl.disabled = true;
      inputEl.placeholder = (iterationName || "Loop") + " is running...";
      return true;
    case "loop_judging":
      var judgingState = store.snap();
      updateLoopBanner(judgingState.loopIteration, judgingState.loopMaxIterations, "judging");
      addSystemMessage("Judging iteration #" + msg.iteration + "...", false);
      inputEl.disabled = true;
      inputEl.placeholder = (judgingState.loopBannerName || "Loop") + " is judging...";
      return true;
    case "loop_verdict":
      addSystemMessage("Judge: " + msg.verdict.toUpperCase() + " - " + (msg.summary || ""), false);
      return true;
    case "loop_stopping":
      var stoppingState = store.snap();
      updateLoopBanner(stoppingState.loopIteration, stoppingState.loopMaxIterations, "stopping");
      return true;
    case "loop_finished":
      handleLoopFinished(msg);
      return true;
    case "loop_error":
      addSystemMessage((store.get('loopBannerName') || "Loop") + " error: " + msg.text, true);
      return true;
    case "ralph_phase":
      handleRalphPhase(msg);
      return true;
    case "ralph_crafting_started":
      store.set({ ralphPhase: "crafting", ralphCraftingSessionId: msg.sessionId || store.get('activeSessionId'), ralphCraftingSource: msg.source || null });
      if (msg.source !== "ralph") {
        enterCraftingMode(msg.sessionId, msg.taskId);
      }
      return true;
    case "ralph_files_status":
      handleRalphFilesStatus(msg);
      return true;
    case "loop_registry_files_content":
      handleLoopRegistryFiles(msg);
      return true;
    case "ralph_files_content":
      store.set({ ralphPreviewContent: { prompt: msg.prompt || "", judge: msg.judge || "" } });
      openRalphPreviewModal();
      return true;
    case "loop_registry_error":
      addSystemMessage("Error: " + msg.text, true);
      return true;
    default:
      return false;
  }
}

function handleLoopFinished(msg) {
  var finishedName = store.get('loopBannerName');
  store.set({ loopActive: false, ralphPhase: "done", loopBannerName: null });
  showLoopBanner(false);
  enableMainInput();
  updateLoopInputVisibility(null);
  var loopLabel = finishedName || "Loop";
  var finishMsg = msg.reason === "pass"
    ? loopLabel + " completed successfully after " + msg.iterations + " iteration(s)."
    : msg.reason === "max_iterations"
      ? loopLabel + " reached maximum iterations (" + msg.iterations + ")."
      : msg.reason === "stopped"
        ? loopLabel + " stopped."
        : loopLabel + " ended with error.";
  addSystemMessage(finishMsg, false);
}

function handleRalphPhase(msg) {
  var ralphPhaseState = { ralphPhase: msg.phase || "idle" };
  if (msg.craftingSessionId) ralphPhaseState.ralphCraftingSessionId = msg.craftingSessionId;
  if (msg.source !== undefined) ralphPhaseState.ralphCraftingSource = msg.source;
  store.set(ralphPhaseState);
  if (msg.wizardData) store.set({ wizardData: msg.wizardData });
}

function handleRalphFilesStatus(msg) {
  store.set({ ralphFilesReady: {
    promptReady: msg.promptReady,
    judgeReady: msg.judgeReady,
    bothReady: msg.bothReady,
  } });
  if (msg.bothReady) {
    var ralphFileState = store.snap();
    if (ralphFileState.ralphPhase === "crafting" || ralphFileState.ralphPhase === "approval") {
      store.set({ ralphPhase: "approval" });
      if (ralphFileState.ralphCraftingSource !== "ralph" || isSchedulerOpen()) {
        exitCraftingMode(msg.taskId);
      } else {
        showRalphApprovalBar(true);
        if (!store.get('execModalShown') && ralphFileState.ralphCraftingSource === "ralph") {
          showExecModal();
        }
      }
    }
  }
  updateRalphApprovalStatus();
  updateExecModalStatus();
}
