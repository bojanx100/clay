var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

function fileExists(fsImpl, pathImpl, dir, name) {
  try {
    fsImpl.accessSync(pathImpl.join(dir, name));
    return true;
  } catch (e) {
    return false;
  }
}

function loopFileStatus(options) {
  var dir = options.dir;
  var fsImpl = options.fs || fs;
  var pathImpl = options.path || path;
  var promptReady = !!dir && fileExists(fsImpl, pathImpl, dir, "PROMPT.md");
  var judgeReady = !!dir && fileExists(fsImpl, pathImpl, dir, "JUDGE.md");
  var loopJsonReady = !!dir && fileExists(fsImpl, pathImpl, dir, "LOOP.json");
  return {
    promptReady: promptReady,
    judgeReady: judgeReady,
    loopJsonReady: loopJsonReady,
    bothReady: options.isSimple ? promptReady : (promptReady && judgeReady),
  };
}

function checkLoopFilesExist(options) {
  return loopFileStatus(options).bothReady;
}

function readText(fsImpl, pathImpl, filePath) {
  try {
    return fsImpl.readFileSync(filePath, "utf8");
  } catch (e) {
    return null;
  }
}

function readJson(fsImpl, filePath) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
  } catch (e) {
    return {};
  }
}

function prepareLoopStart(options) {
  var fsImpl = options.fs || fs;
  var pathImpl = options.path || path;
  var promptPath = pathImpl.join(options.dir, "PROMPT.md");
  var promptText = readText(fsImpl, pathImpl, promptPath);
  if (promptText === null) {
    return { error: "Missing PROMPT.md in " + options.dir };
  }
  var judgeText = readText(fsImpl, pathImpl, pathImpl.join(options.dir, "JUDGE.md"));
  var loopConfig = readJson(fsImpl, pathImpl.join(options.dir, "LOOP.json"));
  var execFileSync = options.execFileSync || childProcess.execFileSync;
  var baseCommit;
  try {
    baseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: options.cwd, encoding: "utf8", timeout: 5000,
    }).trim();
  } catch (e) {
    return { error: "Failed to get git HEAD: " + e.message };
  }
  return {
    promptText: promptText,
    judgeText: judgeText,
    loopConfig: loopConfig,
    baseCommit: baseCommit,
  };
}

function executionState(loopOpts, startData, isSimple) {
  var requested = loopOpts.maxIterations >= 1 ? loopOpts.maxIterations : null;
  var configured = startData.loopConfig.maxIterations;
  var maxIterations = isSimple ? (requested || configured || 5) :
    (startData.judgeText ? (requested || configured || 20) : 1);
  return {
    promptText: startData.promptText,
    judgeText: isSimple ? null : startData.judgeText,
    maxIterations: maxIterations,
    baseCommit: startData.baseCommit,
    settings: startData.loopConfig.settings || null,
  };
}

function extractLoopTitle(history) {
  if (!Array.isArray(history)) return null;
  for (var i = history.length - 1; i >= 0; i--) {
    var text = (history[i] && history[i].text) || "";
    var match = text.match(/\[\[LOOP_TITLE:\s*(.+?)\]\]/);
    if (match && match[1].trim()) return match[1].trim();
  }
  return null;
}

function broadcastLoopFilesStatus(options) {
  var status = loopFileStatus({
    fs: options.fs,
    path: options.path,
    dir: options.loopDir(),
    isSimple: options.isSimple(),
  });
  options.send({
    type: "ralph_files_status",
    promptReady: status.promptReady,
    judgeReady: status.judgeReady,
    loopJsonReady: status.loopJsonReady,
    bothReady: status.bothReady,
    taskId: options.loopState.loopId,
  });
  if (!status.bothReady || options.loopState.phase !== "crafting") return;
  options.loopState.phase = "approval";
  options.saveLoopState();
  var session = options.getCraftingSession(options.loopState.craftingSessionId);
  var title = session && extractLoopTitle(session.history);
  if (title && options.loopState.loopId) {
    options.updateRecord(options.loopState.loopId, { name: title });
  }
}

function createLoopFileWatcher(options) {
  var watcher = null;
  var debounce = null;

  function start() {
    if (watcher) return;
    var dir = options.loopDir();
    if (!dir) return;
    try { options.fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    try {
      watcher = options.fs.watch(dir, function () {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(options.broadcast, 300);
      });
      watcher.on("error", function () {});
    } catch (e) {
      console.error("[ralph-loop] Failed to watch .claude/:", e.message);
    }
  }

  function stop() {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    if (debounce) {
      clearTimeout(debounce);
      debounce = null;
    }
  }

  return { start: start, stop: stop };
}

function saveLoopSettings(options, settings) {
  if (!settings || Object.keys(settings).length === 0) return;
  var dir = options.loopDir();
  if (!dir) return;
  var loopJsonPath = options.path.join(dir, "LOOP.json");
  var loopJson = readJson(options.fs, loopJsonPath);
  loopJson.settings = settings;
  options.fs.writeFileSync(loopJsonPath, JSON.stringify(loopJson, null, 2), "utf8");
}

module.exports = {
  checkLoopFilesExist: checkLoopFilesExist,
  loopFileStatus: loopFileStatus,
  prepareLoopStart: prepareLoopStart,
  executionState: executionState,
  extractLoopTitle: extractLoopTitle,
  broadcastLoopFilesStatus: broadcastLoopFilesStatus,
  createLoopFileWatcher: createLoopFileWatcher,
  saveLoopSettings: saveLoopSettings,
  readJson: readJson,
};
