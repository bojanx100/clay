var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var schedulerModule = require("../lib/project-scheduler-service");

function makeRegistry() {
  var records = [];
  function getById(id) {
    return records.find(function (record) { return record.id === id; }) || null;
  }
  return {
    records: records,
    getAll: function () { return records; },
    getById: getById,
    register: function (data) {
      var now = Date.now();
      var record = Object.assign({
        mode: "loop", createdAt: now, updatedAt: now, runs: [], nextRunAt: now + 60000,
      }, data);
      records.push(record);
      return record;
    },
    update: function (id, data) {
      var record = getById(id);
      if (!record) return null;
      Object.assign(record, data, { updatedAt: Date.now() + 1 });
      record.nextRunAt = record.enabled ? Date.now() + 60000 : null;
      return record;
    },
    updateRecord: function (id, data) {
      var record = getById(id);
      if (!record) return null;
      Object.assign(record, data, { updatedAt: Date.now() + 1 });
      return record;
    },
    remove: function (id) {
      var index = records.findIndex(function (record) { return record.id === id; });
      if (index === -1) return false;
      records.splice(index, 1);
      return true;
    },
    toggleEnabled: function (id) {
      var record = getById(id);
      if (!record || !record.cron) return null;
      record.enabled = !record.enabled;
      return record;
    },
  };
}

function makeHarness() {
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-scheduler-service-"));
  var registry = makeRegistry();
  var started = [];
  var service = schedulerModule.attachProjectScheduler({
    cwd: cwd,
    fs: fs,
    path: path,
    loopRegistry: registry,
    runRecordNow: function (id) {
      started.push(id);
      return { ok: true, started: true, recordId: id };
    },
  });
  return {
    cwd: cwd,
    registry: registry,
    service: service,
    started: started,
    cleanup: function () { fs.rmSync(cwd, { recursive: true, force: true }); },
  };
}

test("cron validation rejects parser footguns and out-of-range fields", function () {
  assert.equal(schedulerModule.validateCron("0 * * * *"), true);
  assert.equal(schedulerModule.validateCron("*/5 0-23 * * 1-5"), true);
  assert.equal(schedulerModule.validateCron("*/0 * * * *"), false);
  assert.equal(schedulerModule.validateCron("60 * * * *"), false);
  assert.equal(schedulerModule.validateCron("0 24 * * *"), false);
  assert.equal(schedulerModule.validateCron("0 10-2 * * *"), false);
  assert.equal(schedulerModule.validateCron("0 * * *"), false);
});

test("create is idempotent and persists the prompt and model settings", function () {
  var h = makeHarness();
  try {
    var input = {
      name: "Hourly health check",
      prompt: "Check both public hosts.",
      cron: "0 * * * *",
      idempotencyKey: "urban-stay-hourly-v1",
      model: "haiku",
      thinking: "disabled",
      maxIterations: 1,
    };
    var first = h.service.create(input);
    var second = h.service.create(input);
    assert.equal(first.ok, true);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.record.id, first.record.id);
    assert.equal(h.registry.records.length, 1);
    var dir = path.join(h.cwd, ".claude", "loops", first.record.id);
    assert.equal(fs.readFileSync(path.join(dir, "PROMPT.md"), "utf8"), input.prompt);
    assert.equal(fs.readFileSync(path.join(dir, "JUDGE.md"), "utf8"), "");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "LOOP.json"), "utf8")), {
      maxIterations: 1,
      loopMode: "simple",
      settings: { model: "haiku", thinking: "disabled" },
    });
  } finally { h.cleanup(); }
});

test("read, update, pause, resume, run, history, and guarded delete share one record", function () {
  var h = makeHarness();
  try {
    var created = h.service.create({
      name: "Monitor", prompt: "Check it", cron: "*/10 * * * *", idempotencyKey: "monitor-v1",
    });
    var id = created.record.id;
    var initial = h.service.get(id);
    assert.equal(initial.files.prompt, "Check it");
    assert.equal(h.service.update(id, {
      expectedUpdatedAt: initial.record.updatedAt + 1,
      prompt: "Do not overwrite",
    }).code, "conflict");

    var updated = h.service.update(id, {
      expectedUpdatedAt: initial.record.updatedAt,
      name: "Monitor public site",
      prompt: "Check apex and www",
      cron: "0 * * * *",
      effort: "low",
    });
    assert.equal(updated.ok, true);
    assert.equal(h.service.get(id).files.prompt, "Check apex and www");
    assert.equal(h.service.get(id).files.settings.effort, "low");
    assert.equal(h.service.pause(id).record.enabled, false);
    assert.equal(h.service.resume(id).record.enabled, true);
    assert.equal(h.service.runNow(id).started, true);
    assert.deepEqual(h.started, [id]);

    h.registry.getById(id).runs.push({ startedAt: 1, finishedAt: 2, result: "pass", iterations: 1 });
    assert.equal(h.service.history(id, 1).runs.length, 1);
    assert.equal(h.service.remove(id, "wrong").code, "confirmation_required");
    var deleted = h.service.remove(id, "Monitor public site");
    assert.equal(deleted.ok, true);
    assert.equal(deleted.filesRetained, true);
    assert.equal(fs.existsSync(path.join(h.cwd, ".claude", "loops", id, "PROMPT.md")), true);
    assert.equal(h.registry.records.length, 0);
  } finally { h.cleanup(); }
});

test("list is project-local and filters disabled schedules without exposing autolaunch jobs", function () {
  var h = makeHarness();
  try {
    h.service.create({ name: "Enabled", prompt: "A", cron: "0 * * * *" });
    h.service.create({ name: "Paused", prompt: "B", cron: "5 * * * *", enabled: false });
    h.registry.register({ id: "legacy", name: "Legacy", cron: "10 * * * *", enabled: true });
    delete h.registry.getById("legacy").mode;
    h.registry.register({ id: "internal", name: "Internal", cron: "* * * * *", mode: "autolaunch", enabled: true });
    assert.deepEqual(h.service.list({ enabledOnly: true }).schedules.map(function (record) { return record.name; }), ["Enabled", "Legacy"]);
    assert.deepEqual(h.service.list().schedules.map(function (record) { return record.name; }), ["Enabled", "Paused", "Legacy"]);
  } finally { h.cleanup(); }
});

test("invalid direct inputs, timezone, and corrupted record paths fail closed", function () {
  var h = makeHarness();
  try {
    assert.equal(h.service.create({
      name: "Bad enabled", prompt: "A", cron: "0 * * * *", enabled: "yes",
    }).code, "invalid_enabled");
    assert.equal(h.service.create({
      name: "Bad settings", prompt: "A", cron: "0 * * * *", effort: "fastest",
    }).code, "invalid_effort");
    assert.equal(h.service.create({
      name: "Bad key", prompt: "A", cron: "0 * * * *", idempotencyKey: 7,
    }).code, "invalid_idempotency_key");
    assert.equal(h.service.create({
      name: "Bad zone", prompt: "A", cron: "0 * * * *", timezone: "Not/A_Real_Zone",
    }).code, "invalid_timezone");
    assert.equal(h.service.list({ enabledOnly: "yes" }).code, "invalid_enabled_only");
    assert.equal(h.registry.records.length, 0);
    h.registry.register({ id: "../outside", name: "Corrupt", cron: "0 * * * *", mode: "loop" });
    assert.equal(h.service.get("../outside").code, "invalid_record_path");
  } finally { h.cleanup(); }
});
