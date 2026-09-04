var fs = require("fs");
var path = require("path");

function writeAtomic(fsImpl, pathImpl, filePath, value) {
  var tmpPath = filePath + ".tmp";
  fsImpl.writeFileSync(tmpPath, value);
  fsImpl.renameSync(tmpPath, filePath);
}

function readText(fsImpl, filePath) {
  try { return fsImpl.readFileSync(filePath, "utf8"); } catch (e) { return ""; }
}

function wizardState(data) {
  return {
    name: data.name || data.task || "Untitled",
    task: data.task || "",
    maxIterations: data.maxIterations || null,
    cron: data.cron || null,
    loopMode: data.loopMode || "judge",
    promptAuthor: data.promptAuthor || "clay",
    judgeAuthor: data.judgeAuthor || null,
    source: data.source === "task" ? null : "ralph",
  };
}

function craftPrompt(data, dir) {
  var prefix = "Use the /clay-ralph skill to design a Ralph Loop for the following task. " +
    "You MUST invoke the clay-ralph skill — do NOT execute the task yourself. ";
  if (data.loopMode === "simple") {
    return prefix + "This is a Simple Loop (no judge). Your job is to create ONLY a PROMPT.md file " +
      "that a future autonomous session will execute. Do NOT create a JUDGE.md file.\n\n" +
      "## Task\n" + (data.task || "") + "\n\n## Loop Directory\n" + dir;
  }
  if (data.judgeAuthor === "me") {
    return prefix + "The user will provide their own JUDGE.md, so create ONLY a PROMPT.md file " +
      "that a future autonomous session will execute. Do NOT create a JUDGE.md file.\n\n" +
      "## Task\n" + (data.task || "") + "\n\n## Loop Directory\n" + dir;
  }
  return prefix + "Your job is to interview me, then create PROMPT.md and JUDGE.md files " +
    "that a future autonomous session will execute.\n\n## Task\n" + (data.task || "") +
    "\n\n## Loop Directory\n" + dir;
}

function judgeCraftPrompt(data, dir) {
  return "Use the /clay-ralph skill to design ONLY a JUDGE.md for an existing Ralph Loop. " +
    "The user has already provided PROMPT.md, so do NOT create or modify PROMPT.md. " +
    "You MUST invoke the clay-ralph skill — do NOT execute the task yourself. " +
    "Your job is to read the existing PROMPT.md and create a JUDGE.md " +
    "that will evaluate whether the coder session completed the task successfully.\n\n" +
    "## Task\n" + (data.task || "") + "\n\n## Loop Directory\n" + dir;
}

function readLoopFiles(options, id) {
  var dir = options.path.join(options.cwd, ".claude", "loops", id);
  return {
    dir: dir,
    prompt: readText(options.fs, options.path.join(dir, "PROMPT.md")),
    judge: readText(options.fs, options.path.join(dir, "JUDGE.md")),
    settings: options.files.readJson(options.fs, options.path.join(dir, "LOOP.json")).settings || null,
  };
}

function sendRegistryFiles(options, ws, id) {
  var values = readLoopFiles(options, id);
  var send = ws ? function (payload) { options.sendTo(ws, payload); } : options.send;
  send({
    type: "loop_registry_files_content",
    id: id,
    prompt: values.prompt,
    judge: values.judge,
    settings: values.settings,
  });
}

function createCraftingSession(options, prompt, id, source, name, status) {
  var isRalph = source === "ralph";
  var session = options.sm.createSession();
  session.title = (isRalph ? "Ralph" : "Task") + (name ? " " + name : "") + " Crafting";
  session.ralphCraftingMode = true;
  session.loop = { active: true, iteration: 0, role: "crafting", loopId: id, name: name, source: source, startedAt: options.loopState.startedAt };
  options.sm.saveSessionFile(session);
  options.sm.switchSession(session.localId, null, options.hydrateImageRefs);
  options.loopState.craftingSessionId = session.localId;
  options.loopRegistry.updateRecord(id, { craftingSessionId: session.localId });
  options.startClaudeDirWatch();
  session.history.push({ type: "user_message", text: prompt });
  options.sm.appendToSessionFile(session, { type: "user_message", text: prompt });
  options.sendToSession(session.localId, { type: "user_message", text: prompt });
  session.isProcessing = true;
  options.onProcessingChanged();
  session.sentToolResults = {};
  options.sendToSession(session.localId, { type: "status", status: "processing" });
  options.sdk.startQuery(session, prompt, undefined, options.getLinuxUserForSession(session));
  options.send({ type: "ralph_crafting_started", sessionId: session.localId, taskId: id, source: source });
  options.send({ type: "ralph_phase", phase: "crafting", wizardData: options.loopState.wizardData, craftingSessionId: session.localId });
  if (status) options.send(Object.assign({ type: "ralph_files_status" }, status));
  return session;
}

function startApproval(options, source, status) {
  options.loopState.phase = "approval";
  options.saveLoopState();
  options.send({ type: "ralph_phase", phase: "approval", source: source, wizardData: options.loopState.wizardData });
  options.send(Object.assign({ type: "ralph_files_status" }, status));
}

function startJudgeCrafting(options, data, id, source, name, dir) {
  options.loopState.phase = "crafting";
  options.saveLoopState();
  createCraftingSession(
    options,
    judgeCraftPrompt(data, dir),
    id,
    source,
    name,
    { promptReady: true, judgeReady: false, bothReady: false }
  );
}

function handleOwnWizard(options, data, id, source, name, dir) {
  if (!(data.mode === "own" && data.promptText)) return false;
  writeAtomic(options.fs, options.path, options.path.join(dir, "PROMPT.md"), data.promptText);
  if (data.judgeText) {
    writeAtomic(options.fs, options.path, options.path.join(dir, "JUDGE.md"), data.judgeText);
    startApproval(options, source, { promptReady: true, judgeReady: true, bothReady: true });
    return true;
  }
  if (data.loopMode === "simple" || !source) {
    startApproval(options, source, { promptReady: true, judgeReady: false, bothReady: true });
    return true;
  }
  startJudgeCrafting(options, data, id, source, name, dir);
  return true;
}

function handleDraftWizard(options, data, id, source, name, dir) {
  if (data.judgeText && data.judgeAuthor === "me") {
    writeAtomic(options.fs, options.path, options.path.join(dir, "JUDGE.md"), data.judgeText);
  }
  createCraftingSession(options, craftPrompt(data, dir), id, source, name, null);
}

function handleWizardComplete(options, ws, msg) {
  var data = msg.data || {};
  var id = options.generateLoopId();
  var startedAt = Date.now();
  var state = wizardState(data);
  options.loopState.loopId = id;
  options.loopState.wizardData = state;
  options.loopState.phase = "crafting";
  options.loopState.startedAt = startedAt;
  options.saveLoopState();
  options.loopRegistry.register({
    id: id,
    name: state.name,
    task: data.task || "",
    cron: state.cron,
    enabled: state.cron ? true : false,
    maxIterations: state.maxIterations,
    source: state.source,
  });
  var dir = options.loopDir();
  try { options.fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  var loopJsonPath = options.path.join(dir, "LOOP.json");
  writeAtomic(options.fs, options.path, loopJsonPath, JSON.stringify({
    maxIterations: state.maxIterations,
    loopMode: data.loopMode || "judge",
  }, null, 2));
  if (handleOwnWizard(options, data, id, state.source, state.name, dir)) return true;
  handleDraftWizard(options, data, id, state.source, state.name, dir);
  return true;
}

function handleLoopStart(options, ws, msg) {
  if (options.loopState.wizardData && options.loopState.wizardData.cron) {
    options.loopState.active = false;
    options.loopState.phase = "done";
    options.saveLoopState();
    options.send({ type: "loop_finished", reason: "scheduled", iterations: 0, results: [] });
    options.send({ type: "ralph_phase", phase: "idle", wizardData: null });
    options.send({ type: "loop_scheduled", recordId: options.loopState.loopId, cron: options.loopState.wizardData.cron });
    return true;
  }
  options.files.saveLoopSettings({ loopDir: options.loopDir, fs: options.fs, path: options.path }, msg.settings);
  options.startLoop({ maxIterations: msg.maxIterations });
  return true;
}

function cleanupLoop(options) {
  options.stopClaudeDirWatch();
  var dir = options.loopDir();
  if (dir) {
    try { options.fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
  options.clearLoopState();
  options.send({ type: "ralph_phase", phase: "idle", wizardData: null });
}

function handleCancelCrafting(options, ws, msg) {
  if (options.loopState.craftingSessionId != null) {
    var session = options.sm.sessions.get(options.loopState.craftingSessionId) || null;
    if (session && session.abortController) session.abortController.abort();
  }
  cleanupLoop(options);
  return true;
}

function handleSaveRegistryFiles(options, ws, msg) {
  var dir = options.path.join(options.cwd, ".claude", "loops", msg.id);
  try {
    options.fs.mkdirSync(dir, { recursive: true });
    if (msg.prompt !== undefined) options.fs.writeFileSync(options.path.join(dir, "PROMPT.md"), msg.prompt, "utf8");
    if (msg.judge !== undefined) options.fs.writeFileSync(options.path.join(dir, "JUDGE.md"), msg.judge, "utf8");
    if (msg.settings !== undefined) {
      var jsonPath = options.path.join(dir, "LOOP.json");
      var json = options.files.readJson(options.fs, jsonPath);
      json.settings = msg.settings;
      options.fs.writeFileSync(jsonPath, JSON.stringify(json, null, 2), "utf8");
    }
    options.send({ type: "loop_registry_save_files_result", id: msg.id, ok: true });
    sendRegistryFiles(options, null, msg.id);
  } catch (e) {
    options.send({ type: "loop_registry_save_files_result", id: msg.id, ok: false, error: e.message });
  }
  return true;
}

function handlePreview(options, ws, msg) {
  var dir = options.loopDir();
  var prompt = dir ? readText(options.fs, options.path.join(dir, "PROMPT.md")) : "";
  var judge = dir ? readText(options.fs, options.path.join(dir, "JUDGE.md")) : "";
  options.sendTo(ws, { type: "ralph_files_content", prompt: prompt, judge: judge });
  return true;
}

function handleScheduleCreate(options, ws, msg) {
  options.loopRegistry.register(scheduleRecord(msg.data || {}));
  return true;
}

function scheduleRecord(data) {
  return {
    name: data.name || "Untitled", task: data.name || "", description: data.description || "",
    date: data.date || null, time: data.time || null, allDay: data.allDay !== undefined ? data.allDay : true,
    linkedTaskId: data.taskId || null, cron: data.cron || null,
    enabled: data.cron ? (data.enabled !== false) : false, maxIterations: data.maxIterations || 3,
    source: "schedule", color: data.color || null, recurrenceEnd: data.recurrenceEnd || null,
    skipIfRunning: data.skipIfRunning !== undefined ? data.skipIfRunning : true,
    intervalEnd: data.intervalEnd || null,
  };
}

function handleRegistryList(options, ws, msg) {
  options.sendTo(ws, { type: "loop_registry_updated", records: options.getHubSchedules() });
  return true;
}

function handleRegistryUpdate(options, ws, msg) {
  if (!options.loopRegistry.update(msg.id, msg.data || {})) {
    options.sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
  }
  return true;
}

function handleRegistryRename(options, ws, msg) {
  if (msg.id && msg.name) {
    options.loopRegistry.updateRecord(msg.id, { name: String(msg.name).substring(0, 100) });
    options.sm.broadcastSessionList();
  }
  return true;
}

function handleRegistryRemove(options, ws, msg) {
  if (!options.loopRegistry.remove(msg.id)) {
    options.sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
  }
  return true;
}

function handleRegistryConvert(options, ws, msg) {
  if (msg.id) {
    options.loopRegistry.updateRecord(msg.id, { source: null });
    options.sm.broadcastSessionList();
  }
  return true;
}

function handleDeleteGroup(options, ws, msg) {
  var loopId = msg.loopId;
  if (!loopId) return true;
  var sessionIds = [];
  options.sm.sessions.forEach(function (session, id) {
    if (session.loop && session.loop.loopId === loopId) sessionIds.push(id);
  });
  for (var i = 0; i < sessionIds.length; i++) options.sm.deleteSessionQuiet(sessionIds[i]);
  options.loopRegistry.remove(loopId);
  options.sm.broadcastSessionList();
  return true;
}

function handleRegistryToggle(options, ws, msg) {
  if (!options.loopRegistry.toggleEnabled(msg.id)) {
    options.sendTo(ws, { type: "loop_registry_error", text: "Record not found or not scheduled" });
  }
  return true;
}

function handleRegistryRerun(options, ws, msg) {
  var state = options.loopState;
  if (state.active || state.phase === "executing" || state.phase === "crafting") {
    options.sendTo(ws, { type: "loop_registry_error", text: "A loop is already running" });
    return true;
  }
  var record = options.loopRegistry.getById(msg.id);
  if (!record) {
    options.sendTo(ws, { type: "loop_registry_error", text: "Record not found" });
    return true;
  }
  var dir = options.path.join(options.cwd, ".claude", "loops", record.id);
  try { options.fs.accessSync(options.path.join(dir, "PROMPT.md")); } catch (e) {
    options.sendTo(ws, { type: "loop_registry_error", text: "PROMPT.md missing for " + record.id });
    return true;
  }
  state.loopId = record.id;
  state.loopFilesId = null;
  options.setActiveRegistryId(null);
  options.send({ type: "loop_rerun_started", recordId: record.id });
  options.startLoop();
  return true;
}

function createLoopMessageHandler(options) {
  var handlers = {
    loop_start: handleLoopStart.bind(null, options),
    loop_stop: function () { options.stopLoop(); return true; },
    ralph_wizard_complete: handleWizardComplete.bind(null, options),
    ralph_wizard_cancel: function () { cleanupLoop(options); return true; },
    ralph_cancel_crafting: handleCancelCrafting.bind(null, options),
    ralph_preview_files: handlePreview.bind(null, options),
    schedule_create: handleScheduleCreate.bind(null, options),
    hub_schedules_list: function (ws) { options.sendTo(ws, { type: "hub_schedules", schedules: options.getHubSchedules() }); return true; },
    loop_registry_list: handleRegistryList.bind(null, options),
    loop_registry_update: handleRegistryUpdate.bind(null, options),
    loop_registry_rename: handleRegistryRename.bind(null, options),
    loop_registry_remove: handleRegistryRemove.bind(null, options),
    loop_registry_convert: handleRegistryConvert.bind(null, options),
    delete_loop_group: handleDeleteGroup.bind(null, options),
    loop_registry_toggle: handleRegistryToggle.bind(null, options),
    loop_registry_rerun: handleRegistryRerun.bind(null, options),
    loop_registry_files: function (ws, msg) { sendRegistryFiles(options, null, msg.id); return true; },
    loop_registry_save_files: handleSaveRegistryFiles.bind(null, options),
  };

  return function handleLoopMessage(ws, msg) {
    var messageType = msg && msg.type;
    if (!Object.prototype.hasOwnProperty.call(handlers, messageType)) return false;
    var handler = handlers[messageType];
    return handler ? handler(ws, msg) : false;
  };
}

module.exports = {
  createLoopMessageHandler: createLoopMessageHandler,
  craftPrompt: craftPrompt,
  judgeCraftPrompt: judgeCraftPrompt,
  wizardState: wizardState,
};
