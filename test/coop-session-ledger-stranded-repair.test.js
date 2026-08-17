var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");

var attachCoopSessionLedger =
  require("../lib/coop-session-ledger").attachCoopSessionLedger;
var repair = require("../lib/coop-session-ledger-stranded-repair");

var CLAY_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var REAL_PROJECT_IDS = [CLAY_ID, "system-lead"];
var IN_WINDOW = 1786528970477; // 2026-08-12T10:02:50.477Z

function strandedEntry(row, overrides) {
  return Object.assign({
    projectRef: { projectId: row.projectId },
    sessionRef: { projectId: row.projectId, sessionStorageId: row.sessionStorageId },
    sessionStorageId: row.sessionStorageId,
    title: "Project session",
    sessionPresent: false,
    coopCreated: true,
    coopTouched: true,
    topLevel: true,
    role: "project_coordinator",
    portfolioBinding: { portfolioTaskId: row.portfolioTaskId, bindingRevision: 1,
      status: "active" },
    portfolioBindings: [],
    coopTopicRefs: [],
    createdAt: IN_WINDOW,
    updatedAt: IN_WINDOW,
    hidden: false,
    lifecycleState: "active",
    workState: "working",
  }, overrides || {});
}

function realEntry(storageId) {
  return {
    projectRef: { projectId: CLAY_ID },
    sessionRef: { projectId: CLAY_ID, sessionStorageId: storageId },
    sessionStorageId: storageId,
    title: "Real owner session",
    sessionPresent: true,
    topLevel: true,
    role: "project_coordinator",
    portfolioBinding: null,
    portfolioBindings: [],
    coopTopicRefs: [],
    createdAt: IN_WINDOW,
    updatedAt: IN_WINDOW,
    hidden: false,
    lifecycleState: "active",
    workState: "working",
  };
}

// Seed a ledger file with every pinned row, plus one real row that must survive.
function seedLedger(mutate) {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-stranded-repair-"));
  var file = path.join(dir, "coop-session-ledger.json");
  var entries = repair.STRANDED_ROWS.map(function (row) {
    return strandedEntry(row, mutate && mutate(row));
  });
  entries.push(realEntry("real-owner-session"));
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.coop_session_ledger", version: 1, entries: entries,
  }));
  return file;
}

test("the stranded-row repair removes exactly the pinned rows and is idempotent", function () {
  var file = seedLedger();
  var result = repair.migrateProduction(attachCoopSessionLedger({ file: file }),
    { knownProjectIds: REAL_PROJECT_IDS });
  assert.equal(result.ok, true);
  assert.equal(result.noop, false);
  assert.equal(result.removed, repair.STRANDED_ROWS.length);

  var after = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].sessionStorageId, "real-owner-session");

  // Second run proves the repair has fully applied and writes nothing.
  var again = repair.migrateProduction(attachCoopSessionLedger({ file: file }),
    { knownProjectIds: REAL_PROJECT_IDS });
  assert.equal(again.ok, true);
  assert.equal(again.noop, true);
  assert.equal(again.removed, 0);
});

test("the stranded-row repair fails closed when pinned evidence drifts", function () {
  // A different portfolio task id under a pinned session id means this is no
  // longer the row the fingerprint was taken from.
  var drifted = seedLedger(function (row) {
    return row.sessionStorageId === "coordinator-session"
      ? { portfolioBinding: { portfolioTaskId: "something-else", bindingRevision: 1 } }
      : null;
  });
  var mismatch = repair.migrateProduction(attachCoopSessionLedger({ file: drifted }),
    { knownProjectIds: REAL_PROJECT_IDS });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "stranded_task_mismatch");
  assert.equal(repair.isTerminal(mismatch.code), true);
  // Nothing may be deleted on a failed run.
  assert.equal(JSON.parse(fs.readFileSync(drifted, "utf8")).entries.length,
    repair.STRANDED_ROWS.length + 1);

  // A pinned row that now has a live session is real work, not a fixture.
  var live = seedLedger(function (row) {
    return row.sessionStorageId === "recovered-direct-leaf" ? { sessionPresent: true } : null;
  });
  var present = repair.migrateProduction(attachCoopSessionLedger({ file: live }),
    { knownProjectIds: REAL_PROJECT_IDS });
  assert.equal(present.ok, false);
  assert.equal(present.code, "stranded_session_present");
  assert.equal(repair.isTerminal(present.code), true);

  // A row created outside the known contamination window is not ours to delete.
  var outside = seedLedger(function (row) {
    return row.sessionStorageId === "restored-project-coordinator"
      ? { createdAt: Date.parse("2026-08-17T00:00:00.000Z") }
      : null;
  });
  var window = repair.migrateProduction(attachCoopSessionLedger({ file: outside }),
    { knownProjectIds: REAL_PROJECT_IDS });
  assert.equal(window.ok, false);
  assert.equal(window.code, "stranded_created_outside_window");
  assert.equal(repair.isTerminal(window.code), true);
});

test("the stranded-row repair refuses to touch a project that is real", function () {
  var file = seedLedger();
  var guarded = repair.migrateProduction(attachCoopSessionLedger({ file: file }),
    { knownProjectIds: REAL_PROJECT_IDS.concat([repair.PHANTOM_PROJECT_IDS[0]]) });
  assert.equal(guarded.ok, false);
  assert.equal(guarded.code, "stranded_project_is_real");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.length,
    repair.STRANDED_ROWS.length + 1);
});

test("the stranded-row repair refuses a phantom project that holds other work", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-stranded-occupied-"));
  var file = path.join(dir, "coop-session-ledger.json");
  var entries = repair.STRANDED_ROWS.map(function (row) { return strandedEntry(row); });
  // An unpinned session under a pinned project id: the id is in use after all.
  entries.push(Object.assign(strandedEntry({
    projectId: repair.PHANTOM_PROJECT_IDS[0],
    sessionStorageId: "someone-elses-session",
    portfolioTaskId: "real-work",
  }), { sessionPresent: false }));
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.coop_session_ledger", version: 1, entries: entries,
  }));
  var occupied = repair.migrateProduction(attachCoopSessionLedger({ file: file }),
    { knownProjectIds: REAL_PROJECT_IDS });
  assert.equal(occupied.ok, false);
  assert.equal(occupied.code, "stranded_unexpected_project_row");
  assert.equal(repair.isTerminal(occupied.code), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.length, entries.length);
});

test("the stranded-row repair refuses a half-known set rather than finishing it", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-stranded-partial-"));
  var file = path.join(dir, "coop-session-ledger.json");
  // Only some of the pinned rows are present: something else already edited
  // this state, so the cleanup is no longer the one that was proven.
  var entries = repair.STRANDED_ROWS.slice(0, 3).map(function (row) {
    return strandedEntry(row);
  });
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.coop_session_ledger", version: 1, entries: entries,
  }));
  var partial = repair.migrateProduction(attachCoopSessionLedger({ file: file }),
    { knownProjectIds: REAL_PROJECT_IDS });
  assert.equal(partial.ok, false);
  assert.equal(partial.code, "stranded_partial_state");
  assert.equal(repair.isTerminal(partial.code), true);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.length, 3);
});

test("the ledger removal surface never deletes a row with a live session", function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-ledger-remove-"));
  var file = path.join(dir, "coop-session-ledger.json");
  fs.writeFileSync(file, JSON.stringify({
    schema: "clay.coop_session_ledger", version: 1,
    entries: [realEntry("live-session")],
  }));
  var ledger = attachCoopSessionLedger({ file: file });
  var refused = ledger.removeEntries([
    { projectId: CLAY_ID, sessionStorageId: "live-session" },
  ]);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "session_present");
  assert.equal(refused.removed, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).entries.length, 1);

  // An unknown ref is simply not found, not an error.
  var absent = ledger.removeEntries([
    { projectId: CLAY_ID, sessionStorageId: "never-existed" },
  ]);
  assert.equal(absent.ok, true);
  assert.equal(absent.removed, 0);
});
