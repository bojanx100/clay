// Runtime reaper for executions stuck in a non-terminal state.
//
// The symptom this exists for: bindings and threads that render as in-flight
// long after their work is dead or finished. One binding read as live work for
// 3.5 days while its actual work had completed elsewhere. "Nothing gets
// finished" is substantially this -- work that IS finished does not look
// finished.
//
// THE PREDICATE. The dangerous error is reaping something alive, so this module
// never infers death from elapsed time. Every reap requires positive, DOCUMENTED
// observation that the execution cannot be running, and every observation is
// conjoined with vetoes that fail closed:
//
//   evidence  (at least one, each a positive observation)
//     session_absent          the binding names a session that exists neither in
//                             the registered project's session manager nor as a
//                             file on disk. Nothing runs under a record that is gone.
//     session_log_quiescent   the session's OWN durable log ends on the
//                             authoritative terminal `done` marker, and that
//                             marker is older than the quiescence window.
//                             Age is one conjunct here, never the whole test:
//                             without a terminal last event this never fires,
//                             so a mid-turn session is unreapable at any age.
//     session_outcome_recorded the session recorded a terminal FAILED execution
//                             outcome that never reached the binding.
//
//   vetoes  (any one blocks the reap)
//     runtime_unobserved      isProcessing/queryInstance are reset to false on
//                             every daemon restart, so an unobserved runtime is
//                             NOT an idle runtime. No observation, no reap.
//     runtime_active          the live session is processing, queued, holding a
//                             provider tool, unread, or has unresolved children.
//     owner_decision_pending  needs_input, attentionAt, or an unresolved Lead
//                             attention record. A human is being waited on, so
//                             this is not stuck -- reaping it would silently
//                             discard an owner-facing question.
//     project_unregistered    the project is not loaded, so session absence is
//                             unobservable rather than proven.
//
// File mtime is deliberately NOT evidence. Live state proved why: a session
// dismissed on 2026-08-12, whose log's last event is `done` at 2026-08-12, had
// an mtime of 2026-08-21 from daemon-side bookkeeping writes. mtime tracks the
// daemon, the log tail tracks the agent.

var fsDefault = require("fs");
var path = require("path");
var portfolioBindings = require("./portfolio-execution-bindings");
var leadLedger = require("./lead-ledger");

// Generous on purpose: it exceeds the 3.5-day symptom that motivated this, so a
// coordinator merely idle between owner turns is never mistaken for a dead one.
var DEFAULT_QUIESCENCE_MS = 72 * 60 * 60 * 1000;
// Matches the binding store's own reservation grace. A reservation commits
// inside the same synchronous call, so this is far beyond any legitimate start.
var DEFAULT_RESERVATION_GRACE_MS = 10 * 60 * 1000;
var TAIL_BYTES = 64 * 1024;
var REAP_EVENT_TYPE = "execution_reaped";
// sessions-io.js calls `done` the authoritative terminal event and clears
// isProcessing before broadcasting it. A log ending on anything else means the
// last thing recorded was mid-turn.
var TERMINAL_LOG_EVENTS = { done: true };
var UNSAFE_TASK_STATUSES = { pending: true, running: true, reviewing: true };
var TERMINAL_BINDING_STATUSES = { completed: true, failed: true, needs_input: true };

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function bindingRef(binding) {
  if (!binding) return null;
  return (binding.mode === "project_coordinator" ? binding.coordinator : binding.worker) || null;
}

// Mirrors coop-restart-supersession's unresolvedSessionReason, which is not
// exported. Kept local rather than widening that module's surface: this is a
// veto only, so the two drifting apart can make a reap MORE conservative but
// never less.
function runtimeActivityReason(session) {
  if (!session) return "";
  if (session.isProcessing || session.queryInstance || session.scheduledMessage) return "runtime_active";
  if (session.destroying) return "session_destroying";
  if (session.messageQueue) return "queued_input";
  if (session.pendingPush) return "pending_push";
  if (Number(session._activeProviderToolCount) > 0) return "provider_tool_active";
  if (session.taskStopRequested) return "stop_in_progress";
  if (session.unread === true || Number(session.unread || session.unreadCount || 0) > 0) {
    return "unread_activity";
  }
  if (session.needsAttention || session.attention || Number(session.attentionCount || 0) > 0) {
    return "attention_flag";
  }
  var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i] && UNSAFE_TASK_STATUSES[tasks[i].status]) return "unresolved_child_task";
  }
  return "";
}

// Reads the LAST parseable event out of a session's durable log. Iterating
// backwards over a bounded tail means a torn or partially-read first line is
// skipped rather than fatal, exactly as the ledger readers do.
function readLogTail(fsImpl, file) {
  var descriptor = null;
  try {
    var stat = fsImpl.statSync(file);
    if (!stat || typeof stat.size !== "number") return null;
    var length = Math.min(stat.size, TAIL_BYTES);
    var result = { type: "", at: null, mtimeMs: stat.mtimeMs, size: stat.size };
    if (!length) return result;
    var buffer = Buffer.alloc(length);
    descriptor = fsImpl.openSync(file, "r");
    fsImpl.readSync(descriptor, buffer, 0, length, stat.size - length);
    fsImpl.closeSync(descriptor);
    descriptor = null;
    var lines = buffer.toString("utf8").split("\n");
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim();
      if (!line) continue;
      var parsed = null;
      try { parsed = JSON.parse(line); } catch (parseError) { continue; }
      if (!parsed || typeof parsed.type !== "string") continue;
      result.type = parsed.type;
      result.at = typeof parsed._ts === "number" && Number.isFinite(parsed._ts) ? parsed._ts : null;
      return result;
    }
    return result;
  } catch (error) {
    if (descriptor !== null) {
      try { fsImpl.closeSync(descriptor); } catch (closeError) {}
    }
    return null;
  }
}

function attentionKeysFor(events) {
  var keys = {};
  var open = leadLedger.unresolvedAttention(Array.isArray(events) ? events : []);
  for (var i = 0; i < open.length; i++) {
    var key = open[i] && open[i].attentionKey;
    if (typeof key === "string" && key) keys[key] = true;
  }
  return keys;
}

function finding(binding, decision, kind, detail, extra) {
  var record = {
    portfolioTaskId: binding.portfolioTaskId,
    bindingRevision: binding.bindingRevision,
    status: binding.status,
    mode: binding.mode,
    targetProjectId: binding.targetProject && binding.targetProject.projectId || null,
    updatedAt: binding.updatedAt,
    decision: decision,
    kind: kind,
    detail: detail || "",
  };
  var keys = extra ? Object.keys(extra) : [];
  for (var i = 0; i < keys.length; i++) record[keys[i]] = extra[keys[i]];
  return record;
}

function createExecutionReaper(options) {
  var opts = options || {};
  var bindings = opts.bindings;
  var resolveExecution = typeof opts.resolveExecution === "function" ? opts.resolveExecution : null;
  var fsImpl = opts.fs || fsDefault;
  var now = opts.now || Date.now;
  var quiescenceMs = typeof opts.quiescenceMs === "number" && opts.quiescenceMs > 0 ?
    opts.quiescenceMs : DEFAULT_QUIESCENCE_MS;
  var reservationGraceMs = typeof opts.reservationGraceMs === "number" && opts.reservationGraceMs >= 0 ?
    opts.reservationGraceMs : DEFAULT_RESERVATION_GRACE_MS;
  var readLedgerEvents = typeof opts.readLedgerEvents === "function" ? opts.readLedgerEvents :
    function () { return leadLedger.readEvents(); };
  var appendLedgerEvent = typeof opts.appendLedgerEvent === "function" ? opts.appendLedgerEvent :
    function (event) { return leadLedger.appendEvent(event); };

  // Observation for one binding: where its session is, what its own log last
  // said, and crucially whether the live runtime was observable at all.
  function observe(binding) {
    var resolved = resolveExecution ? resolveExecution(clone(binding)) : null;
    var view = resolved && typeof resolved === "object" ? resolved : {};
    var ref = bindingRef(binding);
    var sessionsDir = typeof view.sessionsDir === "string" ? view.sessionsDir : "";
    var file = typeof view.sessionFile === "string" ? view.sessionFile : "";
    if (!file && sessionsDir && ref && ref.sessionStorageId) {
      file = path.join(sessionsDir, ref.sessionStorageId + ".jsonl");
    }
    var tail = file ? readLogTail(fsImpl, file) : null;
    return {
      projectRegistered: view.projectRegistered === true,
      runtimeObserved: view.runtimeObserved === true,
      session: view.session || null,
      sessionRef: ref,
      // Whether we knew WHERE to look. Absence of a file we never located is
      // ignorance, not evidence, so this gates the session_absent class.
      sessionFileKnown: !!file,
      sessionFile: file,
      sessionFilePresent: !!tail,
      tail: tail,
    };
  }

  // Positive evidence, or "" plus a reason it could not be established.
  function deathEvidence(binding, view, timestamp) {
    var base = {
      reapedAt: timestamp,
      fromStatus: binding.status,
      runtimeObserved: true,
      sessionRef: view.sessionRef,
      sessionFilePresent: view.sessionFilePresent,
    };
    var recorded = recordedTerminalOutcome(view.session, binding);
    if (recorded === "failed") {
      return Object.assign({}, base, {
        kind: "session_outcome_recorded",
        detail: "session recorded terminal failed outcome not imported to binding",
      });
    }
    if (recorded === "completed") return { blocked: "defer_completion_reconciler" };
    if (recorded === "needs_input") return { blocked: "owner_decision_pending" };
    if (!view.sessionFileKnown) return { blocked: "session_path_unknown" };
    if (!view.session && !view.sessionFilePresent) {
      return Object.assign({}, base, {
        kind: "session_absent",
        detail: "no session in registered project and no session file on disk",
      });
    }
    if (!view.tail) return { blocked: "session_log_unreadable" };
    if (!TERMINAL_LOG_EVENTS[view.tail.type]) {
      return { blocked: "session_log_mid_turn:" + (view.tail.type || "unknown") };
    }
    if (view.tail.at === null) return { blocked: "session_log_untimed" };
    var quiescentForMs = timestamp - view.tail.at;
    if (!(quiescentForMs >= quiescenceMs)) {
      return { blocked: "within_quiescence_window", quiescentForMs: quiescentForMs };
    }
    return Object.assign({}, base, {
      kind: "session_log_quiescent",
      lastEventType: view.tail.type,
      lastEventAt: view.tail.at,
      quiescentForMs: quiescentForMs,
      detail: "session log ends on terminal `done` marker older than quiescence window",
    });
  }

  function recordedTerminalOutcome(session, binding) {
    var metadata = portfolioBindings.sessionExecutionBinding(session);
    if (!metadata || metadata.portfolioTaskId !== binding.portfolioTaskId ||
        metadata.bindingRevision !== binding.bindingRevision) return "";
    return TERMINAL_BINDING_STATUSES[metadata.status] ? metadata.status : "";
  }

  // A `deleted` binding was withdrawn -- its session was dismissed, which is not
  // a failure of the work. Everything else that reads as in-flight and is
  // provably not running ends as `failed`: its completion was never verified,
  // and no evidence class here can ever manufacture success.
  function reapStatusFor(binding) {
    return binding.status === "deleted" ? "cancelled" : "failed";
  }

  function classify(binding, attentionKeys, timestamp) {
    if (binding.status === "unrouted") {
      // Deliberately never mutated. `unrouted` is already outside
      // CURRENT_STATUSES so it does not read as in-flight, and reserve()
      // re-arms it at the same revision -- terminalizing it would destroy the
      // retry path that makes a capacity failure recoverable.
      return finding(binding, "exempt", "unrouted_never_started",
        "reported as backlog only; reserve() re-arms this revision");
    }
    if (!portfolioBindings.CURRENT_STATUSES[binding.status]) {
      return finding(binding, "skip", "not_in_flight", "status does not render as in-flight");
    }
    if (binding.attentionAt) {
      return finding(binding, "exempt", "owner_decision_pending", "binding carries attentionAt");
    }
    var key = binding.portfolioTaskId + ":" + binding.bindingRevision;
    if (attentionKeys[key]) {
      return finding(binding, "exempt", "owner_decision_pending",
        "unresolved Lead attention record " + key);
    }
    var ref = bindingRef(binding);
    if (binding.status === "pending" && !ref) {
      // Never started, so releasing cannot orphan a live worker -- the same
      // proof reconcileStrandedReservations relies on. Routed through the
      // store's own releaseReservation rather than reimplemented here.
      if (binding.updatedAt <= timestamp - reservationGraceMs) {
        return finding(binding, "release", "stranded_reservation",
          "pending with no committed ref beyond the reservation grace window");
      }
      return finding(binding, "skip", "reservation_within_grace", "may still be mid-start");
    }
    if (!ref) return finding(binding, "skip", "no_committed_ref", "nothing to observe");
    var view = observe(binding);
    if (!view.projectRegistered) {
      return finding(binding, "exempt", "project_unregistered",
        "session absence is unobservable while the project is not loaded");
    }
    if (!view.runtimeObserved) {
      return finding(binding, "exempt", "runtime_unobserved",
        "idleness is reset by daemon restart; no observation means no reap",
        { sessionFilePresent: view.sessionFilePresent });
    }
    var active = runtimeActivityReason(view.session);
    if (active) {
      return finding(binding, "exempt", "runtime_active", active,
        { sessionFilePresent: view.sessionFilePresent });
    }
    var evidence = deathEvidence(binding, view, timestamp);
    if (evidence.blocked) {
      return finding(binding, "skip", evidence.blocked, "no positive evidence of death",
        { quiescentForMs: evidence.quiescentForMs === undefined ? null : evidence.quiescentForMs });
    }
    return finding(binding, "reap", evidence.kind, evidence.detail, {
      reapTo: reapStatusFor(binding),
      evidence: evidence,
      lastEventType: view.tail && view.tail.type || "",
      lastEventAt: view.tail && view.tail.at || null,
    });
  }

  function scan() {
    if (!bindings || typeof bindings.list !== "function") {
      return { ok: false, reason: "binding_store_required", findings: [] };
    }
    var loadError = typeof bindings.getLoadError === "function" ? bindings.getLoadError() : null;
    if (loadError) return { ok: false, reason: loadError, findings: [] };
    var timestamp = now();
    var attentionKeys = attentionKeysFor(readLedgerEvents());
    var all = bindings.list();
    var findings = [];
    for (var i = 0; i < all.length; i++) findings.push(classify(all[i], attentionKeys, timestamp));
    return {
      ok: true,
      at: timestamp,
      quiescenceMs: quiescenceMs,
      findings: findings,
      reapable: findings.filter(function (item) { return item.decision === "reap"; }),
      releasable: findings.filter(function (item) { return item.decision === "release"; }),
      exempt: findings.filter(function (item) { return item.decision === "exempt"; }),
    };
  }

  // Dry run. Changes nothing -- no binding write, no ledger write.
  function dryRun() {
    var report = scan();
    report.dryRun = true;
    return report;
  }

  function auditEvent(item, outcome, timestamp) {
    return {
      type: REAP_EVENT_TYPE,
      at: timestamp,
      portfolioTaskId: item.portfolioTaskId,
      bindingRevision: item.bindingRevision,
      fromStatus: item.status,
      toStatus: outcome.toStatus || null,
      action: item.decision,
      evidenceKind: item.kind,
      evidence: item.evidence || null,
      detail: item.detail || "",
      applied: outcome.applied === true,
      failureReason: outcome.reason || null,
    };
  }

  // Applies what scan() classified. Every applied change writes its own durable
  // audit record BEFORE returning, naming what was reaped, the evidence that
  // justified it, and when. Silent state mutation is the failure being fixed.
  function run() {
    var report = scan();
    if (!report.ok) return report;
    var applied = [];
    var pending = report.releasable.concat(report.reapable);
    for (var i = 0; i < pending.length; i++) {
      var item = pending[i];
      var outcome = { applied: false };
      if (item.decision === "release") {
        var released = bindings.releaseReservation(item.portfolioTaskId, item.bindingRevision,
          { code: "reaped_stranded_reservation", message: "runtime_reaper:stranded_reservation" });
        outcome = { applied: released && released.ok === true, toStatus: "unrouted",
          reason: released && released.ok ? null : released && released.reason || "release_failed" };
      } else {
        var reaped = bindings.reapExecution(item.portfolioTaskId, item.bindingRevision,
          item.reapTo, item.evidence);
        outcome = { applied: reaped && reaped.ok === true, toStatus: item.reapTo,
          reason: reaped && reaped.ok ? null : reaped && reaped.reason || "reap_failed" };
      }
      var event = auditEvent(item, outcome, report.at);
      var recorded = appendLedgerEvent(event);
      applied.push({ finding: item, outcome: outcome, auditRecorded: !!recorded });
    }
    report.applied = applied;
    report.dryRun = false;
    return report;
  }

  return {
    QUIESCENCE_MS: quiescenceMs,
    dryRun: dryRun,
    run: run,
    scan: scan,
  };
}

module.exports = {
  DEFAULT_QUIESCENCE_MS: DEFAULT_QUIESCENCE_MS,
  DEFAULT_RESERVATION_GRACE_MS: DEFAULT_RESERVATION_GRACE_MS,
  REAP_EVENT_TYPE: REAP_EVENT_TYPE,
  TERMINAL_LOG_EVENTS: TERMINAL_LOG_EVENTS,
  createExecutionReaper: createExecutionReaper,
  readLogTail: readLogTail,
  runtimeActivityReason: runtimeActivityReason,
};
