var fs = require("fs");
var path = require("path");

function persistedState(loopState) {
  return {
    phase: loopState.phase,
    active: loopState.active,
    iteration: loopState.iteration,
    maxIterations: loopState.maxIterations,
    baseCommit: loopState.baseCommit,
    results: loopState.results,
    wizardData: loopState.wizardData,
    startedAt: loopState.startedAt,
    loopId: loopState.loopId,
    loopFilesId: loopState.loopFilesId || null,
  };
}

function applyPersistedState(loopState, data) {
  loopState.phase = data.phase || "idle";
  loopState.active = data.active || false;
  loopState.iteration = data.iteration || 0;
  loopState.maxIterations = data.maxIterations || 20;
  loopState.baseCommit = data.baseCommit || null;
  loopState.results = data.results || [];
  loopState.wizardData = data.wizardData || null;
  loopState.startedAt = data.startedAt || null;
  loopState.loopId = data.loopId || null;
  loopState.loopFilesId = data.loopFilesId || null;
  loopState.currentSessionId = null;
  loopState.judgeSessionId = null;
  loopState.craftingSessionId = null;
  loopState.stopping = false;
  if (loopState.phase === "executing" && loopState.active) loopState._needsResume = true;
}

function orphanLoop(fsImpl, pathImpl, dir) {
  try {
    fsImpl.accessSync(pathImpl.join(dir, "PROMPT.md"));
    fsImpl.accessSync(pathImpl.join(dir, "LOOP.json"));
    var config = JSON.parse(fsImpl.readFileSync(pathImpl.join(dir, "LOOP.json"), "utf8"));
    if (config.loopMode !== "simple") fsImpl.accessSync(pathImpl.join(dir, "JUDGE.md"));
    return config;
  } catch (e) {
    return null;
  }
}

function findOrphanLoop(options) {
  var base = options.path.join(options.cwd, ".claude", "loops");
  var entries;
  try {
    entries = options.fs.readdirSync(base).filter(function (name) { return name.indexOf("loop_") === 0; });
  } catch (e) {
    return null;
  }
  for (var i = 0; i < entries.length; i++) {
    var id = entries[i];
    var config = orphanLoop(options.fs, options.path, options.path.join(base, id));
    if (config) return { id: id, config: config };
  }
  return null;
}

function recoverCrafting(loopState, checkLoopFiles, save) {
  if (loopState.phase !== "crafting") return;
  loopState.phase = checkLoopFiles() ? "approval" : "idle";
  save();
}

function recoverOrphan(loopState, options, save) {
  if (loopState.phase !== "idle") return;
  var orphan = findOrphanLoop(options);
  if (!orphan) return;
  loopState.loopId = orphan.id;
  loopState.phase = "approval";
  loopState.maxIterations = orphan.config.maxIterations || 20;
  if (!loopState.wizardData) loopState.wizardData = {};
  loopState.wizardData.loopMode = orphan.config.loopMode || "judge";
  save();
  console.log("[ralph-loop] Recovered orphaned loop: " + orphan.id);
}

function createLoopStateStore(options) {
  var fsImpl = options.fs || fs;
  var pathImpl = options.path || path;
  var stateDir = options.stateDir || pathImpl.dirname(options.statePath);
  var statePath = options.statePath;

  function save() {
    try {
      fsImpl.mkdirSync(stateDir, { recursive: true });
      var tmpPath = statePath + ".tmp";
      fsImpl.writeFileSync(tmpPath, JSON.stringify(persistedState(options.loopState), null, 2));
      fsImpl.renameSync(tmpPath, statePath);
    } catch (e) {
      console.error("[ralph-loop] Failed to save state:", e.message);
    }
  }

  function load() {
    try {
      var raw = fsImpl.readFileSync(statePath, "utf8");
      applyPersistedState(options.loopState, JSON.parse(raw));
    } catch (e) {}
    recoverCrafting(options.loopState, options.checkLoopFiles, save);
    recoverOrphan(options.loopState, { cwd: options.cwd, fs: fsImpl, path: pathImpl }, save);
  }

  function clear() {
    var state = options.loopState;
    state.active = false;
    state.phase = "idle";
    state.promptText = "";
    state.judgeText = "";
    state.iteration = 0;
    state.maxIterations = 20;
    state.baseCommit = null;
    state.currentSessionId = null;
    state.judgeSessionId = null;
    state.results = [];
    state.stopping = false;
    state.wizardData = null;
    state.craftingSessionId = null;
    state.startedAt = null;
    state.loopId = null;
    state.loopFilesId = null;
    save();
  }

  return { save: save, load: load, clear: clear };
}

function finishSession(sessionManager, session) {
  if (!session) return false;
  session.singleTurn = false;
  if (session.loop) session.loop.active = false;
  sessionManager.saveSessionFile(session);
  return true;
}

function hasRequiredFiles(fsImpl, pathImpl, dir, isSimple) {
  if (!dir) return false;
  var prompt = false;
  var judge = false;
  try { fsImpl.accessSync(pathImpl.join(dir, "PROMPT.md")); prompt = true; } catch (e) {}
  try { fsImpl.accessSync(pathImpl.join(dir, "JUDGE.md")); judge = true; } catch (e) {}
  return isSimple ? prompt : (prompt && judge);
}

function connectionMessages(options) {
  var state = options.loopState;
  var isSimple = state.wizardData && state.wizardData.loopMode === "simple";
  var root = options.path.join(options.cwd, ".claude");
  var available = hasRequiredFiles(options.fs, options.path, root, isSimple);
  if (!available && state.loopId) available = hasRequiredFiles(options.fs, options.path, options.loopDir(), isSimple);
  var source = state.wizardData ? (state.wizardData.source || null) : null;
  var messages = [{
    type: "loop_available",
    available: available,
    active: state.active,
    iteration: state.iteration,
    maxIterations: state.maxIterations,
    name: state.name || null,
  }, {
    type: "ralph_phase",
    phase: state.phase,
    wizardData: state.wizardData,
    craftingSessionId: state.craftingSessionId || null,
    source: source,
  }];
  if (state.phase === "crafting" || state.phase === "approval") {
    var status = options.fileStatus(options.loopDir(), isSimple);
    messages.push({
      type: "ralph_files_status",
      promptReady: status.promptReady,
      judgeReady: status.judgeReady,
      bothReady: status.bothReady,
      taskId: state.loopId,
    });
  }
  return messages;
}

module.exports = {
  persistedState: persistedState,
  applyPersistedState: applyPersistedState,
  createLoopStateStore: createLoopStateStore,
  finishSession: finishSession,
  connectionMessages: connectionMessages,
  hasRequiredFiles: hasRequiredFiles,
};
