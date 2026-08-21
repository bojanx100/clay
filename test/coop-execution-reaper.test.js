var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("fs");
var os = require("os");
var path = require("path");
var createBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;
var leadLedger = require("../lib/lead-ledger");
var reaperModule = require("../lib/coop-execution-reaper");

var PROJECT_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var HOUR = 60 * 60 * 1000;
var DAY = 24 * HOUR;

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-reaper-" + label + "-"));
}

function request(taskId, revision) {
  return {
    portfolioTaskId: taskId,
    mode: "project_coordinator",
    targetProject: { projectId: PROJECT_ID },
    bindingRevision: revision || 1,
    idempotencyKey: taskId + "-r" + (revision || 1),
  };
}

// Writes a session log whose LAST event is `type` at `at`. The reaper reads the
// tail of the real durable log, so the fixture is a real durable log.
function writeSessionLog(sessionsDir, storageId, type, at) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  var lines = [
    JSON.stringify({ type: "user", _ts: at - 2000, text: "go" }),
    JSON.stringify({ type: "result", _ts: at - 1000 }),
    JSON.stringify({ type: type, _ts: at, code: 0 }),
  ];
  fs.writeFileSync(path.join(sessionsDir, storageId + ".jsonl"), lines.join("\n") + "\n");
}

// One committed binding, one session log, one reaper. `view` supplies the
// runtime observation the daemon would supply.
function harness(options) {
  var opts = options || {};
  var dir = tempDir(opts.label || "case");
  var sessionsDir = path.join(dir, "sessions");
  var ledgerDir = path.join(dir, "lead");
  var taskId = opts.taskId || "reaper-task";
  var storageId = "session-" + taskId;
  var clock = opts.startAt || 1000000;
  function now() { return clock; }
  var store = createBindings({
    file: path.join(dir, "bindings.json"),
    now: now,
    reconcileOnLoad: false,
  });
  store.reserve(request(taskId));
  if (opts.commit !== false) {
    store.commit(taskId, 1, { projectId: PROJECT_ID, sessionStorageId: storageId });
    if (opts.status === "deleted") store.markDeleted(taskId, 1, "coordinator_session_dismissed_by_owner");
    if (opts.status === "unavailable") store.markUnavailable(taskId, 1, "session_unavailable");
  }
  if (opts.lastEventType) {
    writeSessionLog(sessionsDir, storageId, opts.lastEventType,
      opts.lastEventAt === undefined ? clock : opts.lastEventAt);
  }
  var audits = [];
  var reaper = reaperModule.createExecutionReaper({
    bindings: store,
    now: now,
    quiescenceMs: opts.quiescenceMs,
    readLedgerEvents: function () { return leadLedger.readEvents({ dir: ledgerDir }); },
    appendLedgerEvent: function (event) {
      audits.push(event);
      return leadLedger.appendEvent(event, { dir: ledgerDir });
    },
    resolveExecution: function () {
      return {
        projectRegistered: opts.projectRegistered !== false,
        runtimeObserved: opts.runtimeObserved !== false,
        session: opts.session || null,
        sessionsDir: sessionsDir,
      };
    },
  });
  return {
    audits: audits,
    dir: dir,
    ledgerDir: ledgerDir,
    reaper: reaper,
    sessionsDir: sessionsDir,
    setNow: function (value) { clock = value; },
    storageId: storageId,
    store: store,
    taskId: taskId,
  };
}

function findingFor(report, taskId) {
  var match = report.findings.filter(function (item) {
    return item.portfolioTaskId === taskId;
  });
  return match.length ? match[0] : null;
}

test("a stuck record is reaped, with durable auditable evidence", function () {
  var base = 1000000;
  var h = harness({
    label: "stuck",
    taskId: "stuck-coordinator",
    status: "deleted",
    lastEventType: "done",
    lastEventAt: base,
    startAt: base,
  });
  // Nine days past the last thing the session's own log recorded.
  h.setNow(base + 9 * DAY);

  var report = h.reaper.dryRun();
  assert.equal(report.ok, true);
  assert.equal(report.reapable.length, 1);
  var candidate = report.reapable[0];
  assert.equal(candidate.portfolioTaskId, "stuck-coordinator");
  assert.equal(candidate.kind, "session_log_quiescent");
  // `deleted` was withdrawn, not failed -- differentiated per state.
  assert.equal(candidate.reapTo, "cancelled");

  var applied = h.reaper.run();
  assert.equal(applied.applied.length, 1);
  assert.equal(applied.applied[0].outcome.applied, true);
  assert.equal(applied.applied[0].auditRecorded, true);

  var binding = h.store.get("stuck-coordinator", 1);
  assert.equal(binding.status, "cancelled");
  assert.equal(binding.failureCode, "reaped_session_log_quiescent");
  assert.equal(binding.reapEvidence.kind, "session_log_quiescent");
  assert.equal(binding.reapEvidence.fromStatus, "deleted");
  assert.equal(binding.reapEvidence.lastEventType, "done");
  assert.equal(binding.reapEvidence.quiescentForMs, 9 * DAY);

  // The audit record is durable, not merely in-memory: read it back off disk.
  var persisted = leadLedger.readEvents({ dir: h.ledgerDir }).filter(function (event) {
    return event.type === reaperModule.REAP_EVENT_TYPE;
  });
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].portfolioTaskId, "stuck-coordinator");
  assert.equal(persisted[0].fromStatus, "deleted");
  assert.equal(persisted[0].toStatus, "cancelled");
  assert.equal(persisted[0].evidenceKind, "session_log_quiescent");
  assert.equal(persisted[0].applied, true);
  assert.ok(persisted[0].evidence.reapedAt > 0);

  // And it survives a reload of the binding store.
  var reloaded = createBindings({ file: path.join(h.dir, "bindings.json"),
    now: function () { return base; }, reconcileOnLoad: false });
  assert.equal(reloaded.get("stuck-coordinator", 1).reapEvidence.kind, "session_log_quiescent");
});

// The failure that would cost real work. Proven by CONSTRUCTION: the elapsed
// time is swept across four orders of magnitude and the answer never changes,
// because none of the three vetoes below is a function of age.
test("a live record is never reaped at any elapsed time", function () {
  var base = 1000000;
  var elapsed = [HOUR, 6 * HOUR, DAY, 3 * DAY, 7 * DAY, 30 * DAY, 90 * DAY, 365 * DAY, 3650 * DAY];

  // (a) the live runtime is processing. Its log has been terminal for ages.
  var processing = harness({
    label: "live-processing",
    taskId: "live-processing-task",
    lastEventType: "done",
    lastEventAt: base,
    startAt: base,
    session: { isProcessing: true },
  });
  // (b) nothing in memory, but the session's own log ends MID-TURN. This is the
  // case that proves age alone is never sufficient: the quiescence window is
  // exceeded by 10 years and there is still no terminal marker to rely on.
  var midTurn = harness({
    label: "live-midturn",
    taskId: "live-midturn-task",
    lastEventType: "tool_executing",
    lastEventAt: base,
    startAt: base,
  });
  // (c) the runtime was not observed at all -- a fresh daemon resets
  // isProcessing to false, so idleness here would be an artifact of restart.
  var unobserved = harness({
    label: "live-unobserved",
    taskId: "live-unobserved-task",
    lastEventType: "done",
    lastEventAt: base,
    startAt: base,
    runtimeObserved: false,
  });

  for (var i = 0; i < elapsed.length; i++) {
    var at = base + elapsed[i];
    var label = "at +" + elapsed[i] + "ms";

    processing.setNow(at);
    var a = processing.reaper.dryRun();
    assert.equal(a.reapable.length, 0, "processing session reaped " + label);
    assert.equal(findingFor(a, "live-processing-task").kind, "runtime_active", label);

    midTurn.setNow(at);
    var b = midTurn.reaper.dryRun();
    assert.equal(b.reapable.length, 0, "mid-turn session reaped " + label);
    assert.equal(findingFor(b, "live-midturn-task").kind,
      "session_log_mid_turn:tool_executing", label);

    unobserved.setNow(at);
    var c = unobserved.reaper.dryRun();
    assert.equal(c.reapable.length, 0, "unobserved runtime reaped " + label);
    assert.equal(findingFor(c, "live-unobserved-task").kind, "runtime_unobserved", label);
  }

  // Not just "scan says no" -- run() must also leave the records untouched.
  processing.reaper.run();
  midTurn.reaper.run();
  unobserved.reaper.run();
  assert.equal(processing.store.get("live-processing-task", 1).status, "active");
  assert.equal(midTurn.store.get("live-midturn-task", 1).status, "active");
  assert.equal(unobserved.store.get("live-unobserved-task", 1).status, "active");
  assert.equal(processing.audits.length, 0);
  assert.equal(midTurn.audits.length, 0);
  assert.equal(unobserved.audits.length, 0);
});

test("a record awaiting an owner decision is exempt and is never reaped", function () {
  var base = 1000000;

  // (a) attentionAt on the binding: a human is the thing being waited on.
  var flagged = harness({
    label: "attention",
    taskId: "attention-task",
    lastEventType: "done",
    lastEventAt: base,
    startAt: base,
  });
  flagged.store.markAttention("attention-task", 1, "owner_implementation_decision_required");
  flagged.setNow(base + 30 * DAY);
  var flaggedReport = flagged.reaper.dryRun();
  assert.equal(flaggedReport.reapable.length, 0);
  assert.equal(findingFor(flaggedReport, "attention-task").kind, "owner_decision_pending");
  flagged.reaper.run();
  assert.equal(flagged.store.get("attention-task", 1).status, "active");
  assert.equal(flagged.store.get("attention-task", 1).attentionAt > 0, true);

  // (b) an unresolved Lead attention record naming this binding. Nothing on the
  // binding itself marks it, so this must be read out of the ledger.
  var ledgered = harness({
    label: "ledger-attention",
    taskId: "ledger-attention-task",
    lastEventType: "done",
    lastEventAt: base,
    startAt: base,
  });
  leadLedger.appendAttention({
    type: "staffing_attention",
    portfolioTaskId: "ledger-attention-task",
    bindingRevision: 1,
    reason: "owner_implementation_decision_required",
  }, { dir: ledgered.ledgerDir, now: base });
  ledgered.setNow(base + 30 * DAY);
  var ledgeredReport = ledgered.reaper.dryRun();
  assert.equal(ledgeredReport.reapable.length, 0);
  assert.equal(findingFor(ledgeredReport, "ledger-attention-task").kind, "owner_decision_pending");
  ledgered.reaper.run();
  assert.equal(ledgered.store.get("ledger-attention-task", 1).status, "active");

  // Resolving the owner question is what makes it reapable -- proving the
  // exemption above was doing the work, not some unrelated veto.
  leadLedger.resolveAttention({
    portfolioTaskId: "ledger-attention-task",
    bindingRevision: 1,
  }, { dir: ledgered.ledgerDir, now: base + 1 });
  var afterResolve = ledgered.reaper.dryRun();
  assert.equal(afterResolve.reapable.length, 1);
  assert.equal(afterResolve.reapable[0].portfolioTaskId, "ledger-attention-task");
});

test("the store itself refuses to reap a record awaiting an owner decision", function () {
  var dir = tempDir("store-guard");
  var store = createBindings({ file: path.join(dir, "bindings.json"),
    now: function () { return 500; }, reconcileOnLoad: false });
  function evidence(status) {
    return { kind: "session_absent", reapedAt: 500, fromStatus: status,
      runtimeObserved: true, sessionFilePresent: false };
  }
  store.reserve(request("guard-task"));
  store.commit("guard-task", 1, { projectId: PROJECT_ID, sessionStorageId: "guard-session" });
  store.markAttention("guard-task", 1, "owner_implementation_decision_required");
  assert.equal(store.reapExecution("guard-task", 1, "failed", evidence("active")).reason,
    "binding_awaits_owner");

  // needs_input is terminal in the store and stays that way. Only an admitted
  // read-only review can land there, so the fixture must be one.
  var reviewRequest = Object.assign(request("needs-input-task"), { reviewOnly: true });
  store.reserve(reviewRequest);
  store.commit("needs-input-task", 1, { projectId: PROJECT_ID, sessionStorageId: "ni-session" });
  store.complete("needs-input-task", 1, { eventId: "evt-1", completedAt: 500,
    terminalStatus: "needs_input", resultEventId: "res-1", executionMode: "project_coordinator" });
  assert.equal(store.get("needs-input-task", 1).status, "needs_input");
  assert.equal(store.reapExecution("needs-input-task", 1, "failed", evidence("needs_input")).reason,
    "binding_terminal");

  // No evidence packet, unusable packet, or unobserved runtime: no reap.
  store.reserve(request("bare-task"));
  store.commit("bare-task", 1, { projectId: PROJECT_ID, sessionStorageId: "bare-session" });
  assert.equal(store.reapExecution("bare-task", 1, "failed", null).reason, "reap_evidence_invalid");
  assert.equal(store.reapExecution("bare-task", 1, "failed",
    { kind: "vibes", reapedAt: 500, fromStatus: "active", runtimeObserved: true }).reason,
    "reap_evidence_invalid");
  assert.equal(store.reapExecution("bare-task", 1, "failed",
    { kind: "session_absent", reapedAt: 500, fromStatus: "active", runtimeObserved: false }).reason,
    "reap_evidence_invalid");
  // The reaper can never manufacture success.
  assert.equal(store.reapExecution("bare-task", 1, "completed", evidence("active")).reason,
    "invalid_reap_status");
  assert.equal(store.get("bare-task", 1).status, "active");
});

test("dry run changes nothing on disk", function () {
  var base = 1000000;
  var h = harness({
    label: "dryrun",
    taskId: "dryrun-task",
    status: "deleted",
    lastEventType: "done",
    lastEventAt: base,
    startAt: base,
  });
  h.setNow(base + 9 * DAY);
  var bindingFile = path.join(h.dir, "bindings.json");
  var before = fs.readFileSync(bindingFile, "utf8");

  var report = h.reaper.dryRun();
  assert.equal(report.dryRun, true);
  assert.equal(report.reapable.length, 1);

  assert.equal(fs.readFileSync(bindingFile, "utf8"), before);
  assert.equal(h.store.get("dryrun-task", 1).status, "deleted");
  assert.equal(h.audits.length, 0);
  assert.equal(fs.existsSync(path.join(h.ledgerDir, "ledger.jsonl")), false);
});

test("handling is differentiated per state", function () {
  var base = 1000000;

  // `active` whose session is GONE from memory and disk -> failed, not cancelled.
  var orphan = harness({
    label: "orphan",
    taskId: "orphan-task",
    startAt: base,
  });
  orphan.setNow(base + DAY);
  var orphanReport = orphan.reaper.dryRun();
  assert.equal(orphanReport.reapable.length, 1);
  assert.equal(orphanReport.reapable[0].kind, "session_absent");
  assert.equal(orphanReport.reapable[0].reapTo, "failed");
  orphan.reaper.run();
  assert.equal(orphan.store.get("orphan-task", 1).status, "failed");
  assert.equal(orphan.store.get("orphan-task", 1).failureCode, "reaped_session_absent");

  // ...but only because the project was loaded. Unobservable is not proven.
  var unloaded = harness({
    label: "unloaded",
    taskId: "unloaded-task",
    startAt: base,
    projectRegistered: false,
  });
  unloaded.setNow(base + 400 * DAY);
  var unloadedReport = unloaded.reaper.dryRun();
  assert.equal(unloadedReport.reapable.length, 0);
  assert.equal(findingFor(unloadedReport, "unloaded-task").kind, "project_unregistered");

  // `unrouted` never started and is re-armable by reserve(): reported, never mutated.
  var unrouted = harness({
    label: "unrouted",
    taskId: "unrouted-task",
    commit: false,
    startAt: base,
  });
  unrouted.store.releaseReservation("unrouted-task", 1, "no_healthy_candidate");
  assert.equal(unrouted.store.get("unrouted-task", 1).status, "unrouted");
  unrouted.setNow(base + 400 * DAY);
  var unroutedReport = unrouted.reaper.dryRun();
  assert.equal(unroutedReport.reapable.length, 0);
  var unroutedFinding = findingFor(unroutedReport, "unrouted-task");
  assert.equal(unroutedFinding.decision, "exempt");
  assert.equal(unroutedFinding.kind, "unrouted_never_started");
  unrouted.reaper.run();
  assert.equal(unrouted.store.get("unrouted-task", 1).status, "unrouted");
  // Still re-armable, which is the whole reason it is exempt.
  assert.equal(unrouted.store.reserve(request("unrouted-task")).rearmed, true);

  // `pending` with no committed ref -> released through the store's own path.
  var stranded = harness({
    label: "stranded",
    taskId: "stranded-task",
    commit: false,
    startAt: base,
  });
  assert.equal(stranded.store.get("stranded-task", 1).status, "pending");
  stranded.setNow(base + DAY);
  var strandedReport = stranded.reaper.dryRun();
  assert.equal(strandedReport.releasable.length, 1);
  assert.equal(strandedReport.releasable[0].kind, "stranded_reservation");
  stranded.reaper.run();
  assert.equal(stranded.store.get("stranded-task", 1).status, "unrouted");
  assert.equal(stranded.audits.length, 1);
  assert.equal(stranded.audits[0].action, "release");

  // A pending reservation still inside the grace window may be mid-start.
  var fresh = harness({ label: "fresh", taskId: "fresh-task", commit: false, startAt: base });
  fresh.setNow(base + 1000);
  var freshReport = fresh.reaper.dryRun();
  assert.equal(freshReport.releasable.length, 0);
  assert.equal(findingFor(freshReport, "fresh-task").kind, "reservation_within_grace");
});

test("a completed session outcome is deferred to the completion reconciler, never failed", function () {
  var base = 1000000;
  var h = harness({
    label: "completed-outcome",
    taskId: "completed-outcome-task",
    lastEventType: "done",
    lastEventAt: base,
    startAt: base,
    session: {
      orchestrationPolicy: {
        portfolioExecution: {
          portfolioTaskId: "completed-outcome-task",
          bindingRevision: 1,
          mode: "project_coordinator",
          idempotencyKey: "completed-outcome-task-r1",
          status: "completed",
        },
      },
    },
  });
  h.setNow(base + 30 * DAY);
  var report = h.reaper.dryRun();
  assert.equal(report.reapable.length, 0);
  assert.equal(findingFor(report, "completed-outcome-task").kind, "defer_completion_reconciler");
  h.reaper.run();
  assert.equal(h.store.get("completed-outcome-task", 1).status, "active");
});

test("a session that recorded its own failure is reaped on that evidence alone", function () {
  var base = 1000000;
  var h = harness({
    label: "failed-outcome",
    taskId: "failed-outcome-task",
    lastEventType: "done",
    lastEventAt: base,
    startAt: base,
    session: {
      orchestrationPolicy: {
        portfolioExecution: {
          portfolioTaskId: "failed-outcome-task",
          bindingRevision: 1,
          mode: "project_coordinator",
          idempotencyKey: "failed-outcome-task-r1",
          status: "failed",
        },
      },
    },
  });
  // Inside the quiescence window, so quiescence cannot be what fires here.
  h.setNow(base + HOUR);
  var report = h.reaper.dryRun();
  assert.equal(report.reapable.length, 1);
  assert.equal(report.reapable[0].kind, "session_outcome_recorded");
  h.reaper.run();
  assert.equal(h.store.get("failed-outcome-task", 1).failureCode, "reaped_session_outcome_recorded");
});

test("readLogTail reports the last durable event and ignores a torn tail", function () {
  var dir = tempDir("tail");
  var file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, "{not json\n" +
    JSON.stringify({ type: "result", _ts: 10 }) + "\n" +
    JSON.stringify({ type: "done", _ts: 20 }) + "\n" +
    "{\"type\":\"partial\"", "utf8");
  var tail = reaperModule.readLogTail(fs, file);
  // The torn final line is skipped rather than fatal.
  assert.equal(tail.type, "done");
  assert.equal(tail.at, 20);

  assert.equal(reaperModule.readLogTail(fs, path.join(dir, "missing.jsonl")), null);
});
