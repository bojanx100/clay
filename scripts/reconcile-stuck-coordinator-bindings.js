#!/usr/bin/env node
// Idempotent repair for project-coordinator execution bindings left projecting
// active/running after their work stopped.
//
// The code defect that produced them is fixed in lib (see
// lib/project-completion-envelope.js and lib/coop-session-ledger.js). This
// script only corrects records already written to disk before that fix. It
// never fabricates completion: a binding is only ever moved to a state that
// existing evidence already proves.
//
//   node scripts/reconcile-stuck-coordinator-bindings.js           # dry run
//   node scripts/reconcile-stuck-coordinator-bindings.js --apply
//
// It writes ONLY the two Lead-owned JSON files. Session transcripts are read,
// never written: they belong to live sessions the daemon appends to, and
// rewriting one would race away real conversation.
//
// Rules, applied only to mode=project_coordinator bindings with status
// "active" whose coordinator session is Coop-controlled:
//   1. Coordinator session hidden (owner dismissed it) -> binding "deleted".
//      Nothing hidden is executing, so it can never complete.
//   2. Coordinator session visible, every task in its graph terminal, and the
//      project never reported closed -> binding marked for attention (the same
//      attentionAt + statusReason the store's markAttention writes). The
//      binding stays active because the work is genuinely not terminal; it
//      simply stops claiming to be in flight.
// Anything else - a live task, an already-terminal binding, failed evidence,
// an existing attention mark, an owner-direct session - is left untouched.
var fs = require("fs");
var os = require("os");
var path = require("path");
var envelope = require("../lib/project-completion-envelope");
var taskState = require("../lib/orchestration-task-state");

var LEAD_DIR = path.join(os.homedir(), ".clay", "lead");
var SESSIONS_DIR = path.join(os.homedir(), ".clay", "sessions");
var BINDINGS_FILE = path.join(LEAD_DIR, "portfolio-execution-bindings.json");
var LEDGER_FILE = path.join(LEAD_DIR, "coop-session-ledger.json");
var TERMINAL_TASKS = { completed: true, dismissed: true, cancelled: true };
var ACTIVE_STATES = { pending: true, active: true, queued: true, ready: true,
  running: true, reviewing: true };
var APPLY = process.argv.indexOf("--apply") !== -1;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  var temp = file + ".tmp.reconcile." + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

function sessionFiles() {
  var found = {};
  var roots = fs.readdirSync(SESSIONS_DIR);
  for (var i = 0; i < roots.length; i++) {
    var entries;
    try { entries = fs.readdirSync(path.join(SESSIONS_DIR, roots[i])); } catch (e) { continue; }
    for (var j = 0; j < entries.length; j++) {
      if (!/\.jsonl$/.test(entries[j])) continue;
      found[entries[j].replace(/\.jsonl$/, "")] =
        path.join(SESSIONS_DIR, roots[i], entries[j]);
    }
  }
  return found;
}

// Reads the persisted session meta and the coordinator's last written turn,
// reconstructed the same way the live completion gate reconstructs it.
function readSession(file) {
  var lines = fs.readFileSync(file, "utf8").split("\n");
  var meta = null;
  try { meta = JSON.parse(lines[0]); } catch (e) { return null; }
  if (!meta || meta.type !== "meta") return null;
  var turn = [];
  for (var i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    var item;
    try { item = JSON.parse(lines[i]); } catch (e) { continue; }
    if (item.type === "user_message") turn = [];
    else if (item.type === "delta" && item.text) turn.push(item.text);
  }
  return { meta: meta, lastTurn: turn.join("") };
}

function graphFullyTerminal(meta) {
  var tasks = Array.isArray(meta.orchestrationTasks) ? meta.orchestrationTasks : [];
  if (!tasks.length) return false;
  for (var i = 0; i < tasks.length; i++) {
    if (!TERMINAL_TASKS[tasks[i] && tasks[i].status]) return false;
  }
  return true;
}

// Names why the project never closed, using the same reader the fixed gate
// uses, so the recorded reason matches what the live code would now say.
// Returns null when a conforming envelope is present: that one must be
// completed by the gate through the durable transport, never faked here.
function unreportedReason(session) {
  if (!envelope.envelopeRequested(session.lastTurn)) {
    return { reason: "graph_resolved_completion_unreported", missing: [] };
  }
  var report = taskState.projectCompletionFromResult(
    envelope.normalizeEnvelopeText(session.lastTurn));
  var missing = envelope.missingEnvelopeFields(report);
  if (!missing.length) return null;
  return { reason: "project_completion_envelope_unverified", missing: missing };
}

function ledgerEntry(ledger, projectId, sessionStorageId) {
  for (var i = 0; i < ledger.entries.length; i++) {
    var entry = ledger.entries[i];
    if (entry.sessionStorageId === sessionStorageId && entry.projectRef &&
        entry.projectRef.projectId === projectId) return entry;
  }
  return null;
}

function projectLedger(entry, lifecycleState, workState, bindingPatch) {
  var changed = false;
  if (ACTIVE_STATES[entry.lifecycleState] && entry.lifecycleState !== lifecycleState) {
    entry.lifecycleState = lifecycleState;
    entry.workState = workState;
    changed = true;
  }
  var bindings = [entry.portfolioBinding].concat(entry.portfolioBindings || []);
  for (var i = 0; i < bindings.length; i++) {
    if (!bindings[i] || bindings[i].status !== "active") continue;
    var keys = Object.keys(bindingPatch);
    for (var k = 0; k < keys.length; k++) {
      if (bindings[i][keys[k]] === bindingPatch[keys[k]]) continue;
      bindings[i][keys[k]] = bindingPatch[keys[k]];
      changed = true;
    }
  }
  return changed;
}

function run() {
  var bindingState = readJson(BINDINGS_FILE);
  var ledger = readJson(LEDGER_FILE);
  var files = sessionFiles();
  var now = Date.now();
  var changes = [];
  var bindingsChanged = false;
  var ledgerChanged = false;

  for (var i = 0; i < bindingState.bindings.length; i++) {
    var record = bindingState.bindings[i];
    if (record.mode !== "project_coordinator") continue;
    // Active bindings, plus ones this script already terminalized: their
    // ledger projection still has to be re-assertable while a pre-fix daemon
    // keeps rebuilding it. Genuinely terminal bindings written by the gate
    // (completed, failed, superseded, cancelled) are never touched.
    if (record.status !== "active" && !(record.status === "deleted" &&
        record.statusReason === "coordinator_session_dismissed_by_owner")) continue;
    var ref = record.coordinator;
    if (!ref || !ref.sessionStorageId || !files[ref.sessionStorageId]) continue;
    var session = readSession(files[ref.sessionStorageId]);
    if (!session) continue;
    var meta = session.meta;
    // Owner-direct sessions carry no Coop control provenance and are never
    // reconciled here, whatever a stale binding claims.
    if (!meta.coopControlledBy) continue;
    var execution = meta.orchestrationPolicy && meta.orchestrationPolicy.portfolioExecution;
    if (!execution || execution.portfolioTaskId !== record.portfolioTaskId) continue;
    var entry = ledgerEntry(ledger, ref.projectId, ref.sessionStorageId);
    var change = {
      portfolioTaskId: record.portfolioTaskId,
      sessionStorageId: ref.sessionStorageId,
      title: meta.title || "",
      before: record.status + " / " + (entry ? entry.lifecycleState + " / " + entry.workState :
        "no ledger entry"),
    };

    var touched = false;
    if (meta.hidden) {
      if (record.status !== "deleted") {
        record.status = "deleted";
        record.statusReason = "coordinator_session_dismissed_by_owner";
        record.updatedAt = now;
        bindingsChanged = true;
        touched = true;
      }
      // Re-asserted every run, not only when the binding itself moved: a
      // daemon still holding pre-fix code rebuilds the ledger from its own
      // stale projection, so the correction has to be reappliable on its own.
      if (entry && projectLedger(entry, "dismissed", "idle", {
        status: "deleted", statusReason: record.statusReason,
      })) { ledgerChanged = true; touched = true; }
      if (!touched) continue;
      change.after = "deleted / dismissed / idle";
      change.reason = record.statusReason;
      changes.push(change);
      continue;
    }

    if (record.status !== "active") continue;
    if (!record.attentionAt) {
      if (!graphFullyTerminal(meta)) continue;
      var unreported = unreportedReason(session);
      if (!unreported) continue;
      record.attentionAt = now;
      record.statusReason = (unreported.reason + (unreported.missing.length ?
        ":" + unreported.missing.join(",") : "")).slice(0, 240);
      record.updatedAt = now;
      bindingsChanged = true;
      touched = true;
    }
    if (entry && projectLedger(entry, "needs_input", "needs_input", {
      statusReason: record.statusReason,
    })) { ledgerChanged = true; touched = true; }
    if (!touched) continue;
    change.after = "active (attention) / needs_input / needs_input";
    change.reason = record.statusReason;
    changes.push(change);
  }

  if (APPLY && bindingsChanged) writeJson(BINDINGS_FILE, bindingState);
  if (APPLY && ledgerChanged) writeJson(LEDGER_FILE, ledger);

  console.log((APPLY ? "applied " : "would change ") + changes.length + " record(s)");
  for (var c = 0; c < changes.length; c++) {
    console.log("- " + changes[c].portfolioTaskId + " / " + changes[c].sessionStorageId);
    console.log("    title:  " + changes[c].title);
    console.log("    before: " + changes[c].before);
    console.log("    after:  " + changes[c].after);
    console.log("    reason: " + changes[c].reason);
  }
  return changes.length;
}

run();
