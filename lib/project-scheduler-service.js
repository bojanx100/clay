var crypto = require("crypto");

function error(code, message) {
  return { ok: false, code: code, message: message };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeAtomic(fsImpl, filePath, value) {
  var tmpPath = filePath + ".tmp";
  fsImpl.writeFileSync(tmpPath, value, "utf8");
  fsImpl.renameSync(tmpPath, filePath);
}

function readText(fsImpl, filePath) {
  try { return fsImpl.readFileSync(filePath, "utf8"); } catch (e) { return ""; }
}

function readJson(fsImpl, filePath) {
  try { return JSON.parse(fsImpl.readFileSync(filePath, "utf8")); } catch (e) { return {}; }
}

function cronNumber(value, min, max) {
  if (!/^\d+$/.test(value)) return false;
  var parsed = parseInt(value, 10);
  return parsed >= min && parsed <= max;
}

function validCronBase(value, min, max) {
  if (value === "*") return true;
  if (value.indexOf("-") === -1) return cronNumber(value, min, max);
  var bounds = value.split("-");
  if (bounds.length !== 2 || !cronNumber(bounds[0], min, max) ||
      !cronNumber(bounds[1], min, max)) return false;
  return parseInt(bounds[0], 10) <= parseInt(bounds[1], 10);
}

function validCronPart(value, min, max) {
  var stepParts = value.split("/");
  if (stepParts.length > 2 || !validCronBase(stepParts[0], min, max)) return false;
  if (stepParts.length === 2) {
    if (!/^\d+$/.test(stepParts[1])) return false;
    var step = parseInt(stepParts[1], 10);
    if (step < 1 || step > (max - min + 1)) return false;
  }
  return true;
}

function validCronField(value, min, max) {
  var parts = value.split(",");
  if (!parts.length) return false;
  for (var i = 0; i < parts.length; i++) {
    if (!validCronPart(parts[i], min, max)) return false;
  }
  return true;
}

function validateCron(value) {
  if (typeof value !== "string") return false;
  var fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return validCronField(fields[0], 0, 59) &&
    validCronField(fields[1], 0, 23) &&
    validCronField(fields[2], 1, 31) &&
    validCronField(fields[3], 1, 12) &&
    validCronField(fields[4], 0, 6);
}

function currentTimezone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch (e) { return "UTC"; }
}

function cleanSettings(input) {
  var settings = {};
  if (!input) return settings;
  if (input.model) settings.model = String(input.model).substring(0, 100);
  if (input.permissionMode) settings.permissionMode = input.permissionMode;
  if (input.effort) settings.effort = input.effort;
  if (input.thinking) settings.thinking = input.thinking;
  if (input.thinkingBudget) settings.thinkingBudget = input.thinkingBudget;
  return settings;
}

function includes(values, value) {
  return values.indexOf(value) !== -1;
}

function validateOptionalSettings(input) {
  if (input.description !== undefined &&
      (typeof input.description !== "string" || input.description.length > 500)) {
    return error("invalid_description", "Description must contain at most 500 characters.");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    return error("invalid_enabled", "enabled must be a boolean.");
  }
  if (input.skipIfRunning !== undefined && typeof input.skipIfRunning !== "boolean") {
    return error("invalid_skip_if_running", "skipIfRunning must be a boolean.");
  }
  if (input.model !== undefined &&
      (typeof input.model !== "string" || !input.model || input.model.length > 100)) {
    return error("invalid_model", "model must contain 1 to 100 characters.");
  }
  if (input.permissionMode !== undefined && !includes(
      ["default", "plan", "acceptEdits", "bypassPermissions"], input.permissionMode)) {
    return error("invalid_permission_mode", "permissionMode is not supported.");
  }
  if (input.effort !== undefined && !includes(
      ["minimal", "low", "medium", "high", "xhigh", "max", "ultracode", "ultra", "sol"], input.effort)) {
    return error("invalid_effort", "effort is not supported.");
  }
  if (input.thinking !== undefined &&
      !includes(["disabled", "adaptive", "budget"], input.thinking)) {
    return error("invalid_thinking", "thinking is not supported.");
  }
  if (input.thinkingBudget !== undefined &&
      (!Number.isInteger(input.thinkingBudget) || input.thinkingBudget < 1024 || input.thinkingBudget > 128000)) {
    return error("invalid_thinking_budget", "thinkingBudget must be an integer from 1024 to 128000.");
  }
  if (input.expectedUpdatedAt !== undefined && !Number.isInteger(input.expectedUpdatedAt)) {
    return error("invalid_expected_updated_at", "expectedUpdatedAt must be an integer timestamp.");
  }
  return null;
}

function attachProjectScheduler(ctx) {
  var cwd = ctx.cwd;
  var fsImpl = ctx.fs;
  var pathImpl = ctx.path;
  var loopRegistry = ctx.loopRegistry;
  var runRecordNow = ctx.runRecordNow;
  var loopsRoot = pathImpl.resolve(cwd, ".claude", "loops");

  function safeLoopDir(id) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,160}$/.test(id)) return null;
    var resolved = pathImpl.resolve(loopsRoot, id);
    if (resolved !== loopsRoot && resolved.indexOf(loopsRoot + pathImpl.sep) === 0) return resolved;
    return null;
  }

  function recordById(id) {
    var record = loopRegistry.getById(String(id || ""));
    if (!record || (record.mode && record.mode !== "loop")) return null;
    return record;
  }

  function filesForRecord(record) {
    var filesId = record.linkedTaskId || record.id;
    var dir = safeLoopDir(filesId);
    if (!dir) return error("invalid_record_path", "The schedule has an invalid loop file id.");
    var config = readJson(fsImpl, pathImpl.join(dir, "LOOP.json"));
    return {
      ok: true,
      filesId: filesId,
      prompt: readText(fsImpl, pathImpl.join(dir, "PROMPT.md")),
      judge: readText(fsImpl, pathImpl.join(dir, "JUDGE.md")),
      settings: config.settings || null,
      loopMode: config.loopMode || "judge",
    };
  }

  function list(options) {
    options = options || {};
    if (options.enabledOnly !== undefined && typeof options.enabledOnly !== "boolean") {
      return error("invalid_enabled_only", "enabledOnly must be a boolean.");
    }
    return {
      ok: true,
      timezone: currentTimezone(),
      schedules: loopRegistry.getAll().filter(function (record) {
        return (!record.mode || record.mode === "loop") && !!record.cron;
      }).filter(function (record) {
        return !options.enabledOnly || record.enabled;
      }).map(function (record) { return clone(record); }),
    };
  }

  function get(id) {
    var record = recordById(id);
    if (!record) return error("not_found", "Schedule not found in this project.");
    var files = filesForRecord(record);
    if (!files.ok) return files;
    return { ok: true, timezone: currentTimezone(), record: clone(record), files: files };
  }

  function validateTimezone(value) {
    if (value === undefined || value === currentTimezone()) return null;
    if (typeof value !== "string" || !value || value.length > 100) {
      return error("invalid_timezone", "Use a valid IANA timezone name.");
    }
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date()); }
    catch (e) { return error("invalid_timezone", "Use a valid IANA timezone name."); }
    return error("unsupported_timezone", "Schedules currently run in the Clay server timezone: " + currentTimezone() + ".");
  }

  function validateCommon(input, creating) {
    if (creating || input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 100) {
        return error("invalid_name", "Name must contain 1 to 100 characters.");
      }
    }
    if (creating || input.cron !== undefined) {
      if (!validateCron(input.cron)) {
        return error("invalid_cron", "Cron must be a valid five-field expression using the Clay server timezone.");
      }
    }
    if (creating || input.prompt !== undefined) {
      if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 50000) {
        return error("invalid_prompt", "Prompt must contain 1 to 50000 characters.");
      }
    }
    if (input.judge !== undefined && (typeof input.judge !== "string" || input.judge.length > 50000)) {
      return error("invalid_judge", "Judge must contain at most 50000 characters.");
    }
    if (input.maxIterations !== undefined &&
        (!Number.isInteger(input.maxIterations) || input.maxIterations < 1 || input.maxIterations > 100)) {
      return error("invalid_max_iterations", "maxIterations must be an integer from 1 to 100.");
    }
    var settingsError = validateOptionalSettings(input);
    if (settingsError) return settingsError;
    return validateTimezone(input.timezone);
  }

  function create(input) {
    input = input || {};
    var invalid = validateCommon(input, true);
    if (invalid) return invalid;
    if (input.idempotencyKey !== undefined && typeof input.idempotencyKey !== "string") {
      return error("invalid_idempotency_key", "idempotencyKey must be a string.");
    }
    var key = input.idempotencyKey || "";
    if (key && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
      return error("invalid_idempotency_key", "idempotencyKey may contain letters, numbers, dot, underscore, colon, and hyphen.");
    }
    if (key) {
      var existing = loopRegistry.getAll().find(function (record) {
        return record.schedulerIdempotencyKey === key;
      });
      if (existing) return { ok: true, created: false, record: clone(existing) };
    }

    var id = "loop_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
    var dir = safeLoopDir(id);
    var maxIterations = input.maxIterations || 1;
    var judge = input.judge || "";
    var loopMode = judge.trim() ? "judge" : "simple";
    var settings = cleanSettings(input);
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      writeAtomic(fsImpl, pathImpl.join(dir, "PROMPT.md"), input.prompt);
      writeAtomic(fsImpl, pathImpl.join(dir, "JUDGE.md"), judge);
      writeAtomic(fsImpl, pathImpl.join(dir, "LOOP.json"), JSON.stringify({
        maxIterations: maxIterations,
        loopMode: loopMode,
        settings: settings,
      }, null, 2));
    } catch (e) {
      return error("file_write_failed", e.message || "Failed to save schedule files.");
    }
    var record = loopRegistry.register({
      id: id,
      name: input.name.trim(),
      task: input.prompt.substring(0, 500),
      description: input.description || "",
      cron: input.cron.trim(),
      enabled: input.enabled !== false,
      maxIterations: maxIterations,
      source: null,
      mode: "loop",
      skipIfRunning: input.skipIfRunning !== false,
      schedulerIdempotencyKey: key || null,
    });
    return { ok: true, created: true, timezone: currentTimezone(), record: clone(record) };
  }

  function update(id, input) {
    input = input || {};
    var record = recordById(id);
    if (!record || !record.cron) return error("not_found", "Schedule not found in this project.");
    if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== record.updatedAt) {
      return error("conflict", "Schedule changed since it was read. Read it again before updating.");
    }
    var invalid = validateCommon(input, false);
    if (invalid) return invalid;
    var files = filesForRecord(record);
    if (!files.ok) return files;
    var fileChanges = input.prompt !== undefined || input.judge !== undefined ||
      input.model !== undefined || input.permissionMode !== undefined ||
      input.effort !== undefined || input.thinking !== undefined ||
      input.thinkingBudget !== undefined || input.maxIterations !== undefined;
    if (fileChanges) {
      var dir = safeLoopDir(files.filesId);
      var nextPrompt = input.prompt !== undefined ? input.prompt : files.prompt;
      var nextJudge = input.judge !== undefined ? input.judge : files.judge;
      var nextSettings = Object.assign({}, files.settings || {}, cleanSettings(input));
      var nextMax = input.maxIterations !== undefined ? input.maxIterations : record.maxIterations;
      try {
        writeAtomic(fsImpl, pathImpl.join(dir, "PROMPT.md"), nextPrompt);
        writeAtomic(fsImpl, pathImpl.join(dir, "JUDGE.md"), nextJudge);
        writeAtomic(fsImpl, pathImpl.join(dir, "LOOP.json"), JSON.stringify({
          maxIterations: nextMax,
          loopMode: nextJudge.trim() ? "judge" : "simple",
          settings: nextSettings,
        }, null, 2));
      } catch (e) {
        return error("file_write_failed", e.message || "Failed to update schedule files.");
      }
    }
    var recordChanges = {};
    var allowed = ["name", "description", "cron", "enabled", "maxIterations", "skipIfRunning"];
    for (var i = 0; i < allowed.length; i++) {
      if (input[allowed[i]] !== undefined) recordChanges[allowed[i]] = input[allowed[i]];
    }
    if (recordChanges.name) recordChanges.name = recordChanges.name.trim();
    var updated = Object.keys(recordChanges).length ? loopRegistry.update(record.id, recordChanges) :
      loopRegistry.updateRecord(record.id, {});
    return { ok: true, timezone: currentTimezone(), record: clone(updated) };
  }

  function pause(id) {
    return update(id, { enabled: false });
  }

  function resume(id) {
    return update(id, { enabled: true });
  }

  function runNow(id) {
    var record = recordById(id);
    if (!record || !record.cron) return error("not_found", "Schedule not found in this project.");
    return runRecordNow(record.id);
  }

  function runTaskNow(id) {
    var record = recordById(id);
    if (!record) return error("not_found", "Task not found in this project.");
    return runRecordNow(record.id);
  }

  function history(id, limit) {
    var record = recordById(id);
    if (!record || !record.cron) return error("not_found", "Schedule not found in this project.");
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 20)) {
      return error("invalid_limit", "limit must be an integer from 1 to 20.");
    }
    var count = Math.min(20, Math.max(1, limit || 20));
    return { ok: true, recordId: record.id, runs: clone((record.runs || []).slice(-count)) };
  }

  function remove(id, confirmName) {
    var record = recordById(id);
    if (!record || !record.cron) return error("not_found", "Schedule not found in this project.");
    if (confirmName !== record.name) {
      return error("confirmation_required", "confirmName must exactly match the current schedule name.");
    }
    var filesId = record.linkedTaskId || record.id;
    if (!loopRegistry.remove(record.id)) return error("delete_failed", "The schedule could not be deleted.");
    return { ok: true, deleted: true, recordId: record.id, filesRetained: true, filesId: filesId };
  }

  function createScheduleRecord(data) {
    data = data || {};
    return loopRegistry.register({
      name: data.name || "Untitled",
      task: data.name || "",
      description: data.description || "",
      date: data.date || null,
      time: data.time || null,
      allDay: data.allDay !== undefined ? data.allDay : true,
      linkedTaskId: data.taskId || null,
      cron: data.cron || null,
      enabled: data.cron ? data.enabled !== false : false,
      maxIterations: data.maxIterations || 3,
      source: "schedule",
      color: data.color || null,
      recurrenceEnd: data.recurrenceEnd || null,
      skipIfRunning: data.skipIfRunning !== undefined ? data.skipIfRunning : true,
      intervalEnd: data.intervalEnd || null,
    });
  }

  function updateRecord(id, data) {
    var updated = loopRegistry.update(id, data || {});
    return updated ? { ok: true, record: clone(updated) } :
      error("not_found", "Task not found in this project.");
  }

  function renameRecord(id, name) {
    var updated = loopRegistry.updateRecord(id, { name: String(name || "").substring(0, 100) });
    return updated ? { ok: true, record: clone(updated) } :
      error("not_found", "Task not found in this project.");
  }

  function removeRecord(id) {
    return loopRegistry.remove(id) ? { ok: true, recordId: id } :
      error("not_found", "Task not found in this project.");
  }

  function toggleRecord(id) {
    var updated = loopRegistry.toggleEnabled(id);
    return updated ? { ok: true, record: clone(updated) } :
      error("not_found", "Task not found or not scheduled.");
  }

  function saveFiles(id, changes) {
    var record = recordById(id);
    if (!record) return error("not_found", "Task not found in this project.");
    var files = filesForRecord(record);
    if (!files.ok) return files;
    var dir = safeLoopDir(files.filesId);
    try {
      fsImpl.mkdirSync(dir, { recursive: true });
      if (changes.prompt !== undefined) writeAtomic(fsImpl, pathImpl.join(dir, "PROMPT.md"), changes.prompt);
      if (changes.judge !== undefined) writeAtomic(fsImpl, pathImpl.join(dir, "JUDGE.md"), changes.judge);
      if (changes.settings !== undefined) {
        var config = readJson(fsImpl, pathImpl.join(dir, "LOOP.json"));
        config.settings = changes.settings;
        writeAtomic(fsImpl, pathImpl.join(dir, "LOOP.json"), JSON.stringify(config, null, 2));
      }
    } catch (e) {
      return error("file_write_failed", e.message || "Failed to save task files.");
    }
    return filesForRecord(record);
  }

  return {
    list: list,
    get: get,
    create: create,
    update: update,
    pause: pause,
    resume: resume,
    runNow: runNow,
    runTaskNow: runTaskNow,
    history: history,
    remove: remove,
    createScheduleRecord: createScheduleRecord,
    updateRecord: updateRecord,
    renameRecord: renameRecord,
    removeRecord: removeRecord,
    toggleRecord: toggleRecord,
    saveFiles: saveFiles,
    validateCron: validateCron,
  };
}

module.exports = {
  attachProjectScheduler: attachProjectScheduler,
  validateCron: validateCron,
};
