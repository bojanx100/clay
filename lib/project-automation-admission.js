// project-automation-admission.js - Turns pending candidates into typed
// cross-project execution bindings. This is the consumer half of the handoff.
//
// Without it the cutover stops one step short of working: a project controller
// proposes, the candidate is durably queued, and nothing ever admits it. That
// was the state trialview/v2#2517 was left in — queued, visible, and never
// executed.
//
// THE SINGLE WRITER IS portfolio-execution-bindings. Admission does not invent
// idempotency; it derives a DETERMINISTIC portfolioTaskId and idempotencyKey
// from the candidate, so calling it twice for the same item reaches the same
// binding and the binding store replays rather than creating a second one.
// That is what makes restart, retry and concurrent ticks safe without any
// lock here.
//
// ORDER MATTERS. A candidate is marked admitted only AFTER the binding is
// committed. Marking first would let a reservation failure look like success
// and silently drop the work — the same class of defect as the original lost
// handoff. Every failure leaves the candidate pending and records visible
// attention, so it is retried rather than forgotten.
//
// Owner-gated candidates are never auto-admitted. `admission: "owner_approval"`
// means the project's own policy says a human decides, so admission records
// durable attention and waits instead of quietly widening authority.
//
// AND IT NEVER IMPERSONATES COOP. A binding's source must be the canonical live
// Coop SessionRef, because that is what ties the resulting execution into
// Coop's task graph and gives it normal visible fan-in and closure. A synthetic
// {system-lead, "coop-automation-admission"} ref would satisfy the type checks
// and produce bindings detached from any coordinator — work that runs with
// nobody owning it. So the ref is INJECTED and resolved live; if it cannot be
// resolved, admission fails closed and says so. Project-local discovery is not
// permitted to speak for Coop.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");

// portfolio-execution-bindings accepts [A-Za-z0-9][A-Za-z0-9._:-]* only, but an
// item key looks like "trialview/v2#2517". Sanitizing is therefore required —
// and it must be injective enough that two different items cannot collapse to
// one task id, or admission would bind them together.
var UNSAFE = /[^A-Za-z0-9._:-]+/g;

function sanitizeSegment(value) {
  return String(value || "").replace(UNSAFE, "-").replace(/^-+/, "");
}

// Deterministic, collision-resistant, and still readable in a binding listing.
//
// Sanitizing and truncating alone are NOT injective: "v2#25" and "v2/25" both
// sanitize to "v2-25", and a long repo prefix can push the distinguishing part
// past the length limit. Two different issues sharing a task id would be bound
// together — one execution for two pieces of work. So the identity comes from a
// digest of the UNSANITIZED {projectId, itemKey}, and the readable part is
// decoration that may safely be lossy.
function identityDigest(projectId, itemKey) {
  return crypto.createHash("sha256")
    .update(JSON.stringify([String(projectId || ""), String(itemKey || "")]))
    .digest("hex").slice(0, 24);
}

function portfolioTaskIdFor(candidate) {
  var projectId = candidate.projectRef ? candidate.projectRef.projectId : "";
  var digest = identityDigest(projectId, candidate.itemKey);
  // Readable tail, hard identity head. Trimmed so the digest can never be the
  // part that gets truncated away.
  var label = sanitizeSegment(candidate.itemKey).slice(0, 120);
  return ("auto:" + digest + ":" + label).slice(0, 200);
}

function idempotencyKeyFor(portfolioTaskId, bindingRevision) {
  return sanitizeSegment("admit-" + portfolioTaskId + "-r" + bindingRevision).slice(0, 200);
}

// "A binding already exists" is only the idempotent path if it is OUR binding.
// Accepting it blindly would let an unrelated binding that happens to occupy
// the same task id count as admission for this item — which is precisely the
// damage a task-id collision would do. So the existing binding is fetched and
// checked field by field before it is treated as a replay.
function sameBinding(existing, expected) {
  if (!existing) return false;
  if (existing.portfolioTaskId !== expected.portfolioTaskId) return false;
  if (existing.bindingRevision !== expected.bindingRevision) return false;
  if (existing.mode !== expected.mode) return false;
  if (existing.idempotencyKey !== expected.idempotencyKey) return false;
  var target = existing.targetProject || {};
  return target.projectId === expected.targetProject.projectId;
}

function createCandidateAdmission(options) {
  var opts = options || {};
  var candidates = opts.candidates;
  var crossProject = opts.crossProject || null;
  var now = opts.now || Date.now;
  var audit = opts.audit || null;
  var readLeadMode = opts.getLeadMode || function () { return false; };
  // Resolves the CANONICAL LIVE Coop SessionRef. There is deliberately no
  // fallback: a fabricated ref type-checks but produces bindings detached from
  // Coop's task graph, so work would execute with no coordinator owning its
  // closure or fan-in. No resolver, or a resolver that cannot find the session,
  // means admission does not happen.
  var resolveCoopSource = opts.resolveCoopSource || null;
  // Reads a committed binding so an "already exists" answer can be verified
  // rather than trusted.
  // `getExecutionBinding` is the router's canonical name for this; `getBinding`
  // is an alias. Preferring the canonical one means the production path does not
  // depend on the alias continuing to exist.
  function routerBindingReader() {
    if (!crossProject) return null;
    if (typeof crossProject.getExecutionBinding === "function") {
      return function (taskId, revision) { return crossProject.getExecutionBinding(taskId, revision); };
    }
    if (typeof crossProject.getBinding === "function") {
      return function (taskId, revision) { return crossProject.getBinding(taskId, revision); };
    }
    return null;
  }
  var getBinding = opts.getBinding || routerBindingReader();

  function coopSessionRef() {
    if (typeof resolveCoopSource !== "function") return null;
    var resolved;
    try {
      resolved = resolveCoopSource();
    } catch (e) {
      return null;
    }
    var ref = projectIdentity.normalizeSessionRef(resolved);
    // It must be a Lead-project session: that is what makes it Coop's.
    if (!ref || ref.projectId !== projectIdentity.LEAD_PROJECT_ID) return null;
    return ref;
  }

  function note(record) {
    if (!audit || typeof audit.append !== "function") return;
    audit.append(Object.assign({ type: "project_automation_admission", at: now() }, record));
  }

  function briefFor(candidate) {
    var intent = candidate.intent || {};
    var lines = [
      "Coop admitted this work from " + (intent.recipeId || "an automation recipe") + ".",
      "Item: " + (candidate.itemKey || "unknown"),
    ];
    if (intent.title) lines.push("Title: " + intent.title);
    if (intent.url) lines.push("URL: " + intent.url);
    lines.push("Class: " + (candidate.itemClass || "unknown") +
      " (admission: " + candidate.admission + ")");
    lines.push("You own decomposition, workers, retries and verification for this item.");
    return lines.join("\n");
  }

  // Every failure records durable attention on the candidate itself, so a stuck
  // item is visibly stuck rather than only a console line that scrolls away.
  function fail(projectRef, candidate, reason) {
    candidates.recordAttention(projectRef, candidate.candidateKey, reason, false);
    note({
      outcome: "failed", reason: reason,
      itemKey: candidate.itemKey,
      projectId: projectRef ? projectRef.projectId : null,
    });
    return { ok: false, state: "failed", reason: reason };
  }

  // admitOne -> { ok, state, reason, binding }
  //   state: "admitted" | "deferred" | "failed"
  function admitOne(candidate) {
    var projectRef = projectIdentity.normalizeProjectRef(candidate && candidate.projectRef);
    if (!projectRef) {
      // No usable ref means we cannot even record attention against it.
      note({ outcome: "failed", reason: "invalid_project_ref", itemKey: candidate && candidate.itemKey });
      return { ok: false, state: "failed", reason: "invalid_project_ref" };
    }
    if (!candidate.itemKey) return fail(projectRef, candidate, "invalid_candidate");
    // An explicit owner YES makes this admissible regardless of what the policy
    // stance says, because a human has now decided. Without this the approval
    // would be recorded and then ignored.
    var ownerApproved = candidate.status === "owner_approved" ||
      !!(candidate.ownerDecision && candidate.ownerDecision.approved === true);
    if (candidate.status === "owner_declined") {
      note({
        outcome: "declined", reason: "owner_declined",
        itemKey: candidate.itemKey, projectId: projectRef.projectId,
      });
      return { ok: true, state: "declined", reason: "owner_declined" };
    }
    // The project's own policy said a human decides. Admission must not — and
    // "deferred" has to be DURABLE, or the item is silently re-deferred every
    // tick and no owner is ever actually asked.
    if (candidate.admission !== "auto" && !ownerApproved) {
      // The deferral is only real if it PERSISTED. If the attention write
      // fails, the candidate stays plain pending, so the next tick defers it
      // again and prompts the owner again — the per-tick storm, rebuilt in the
      // owner's face. An unpersisted deferral is therefore a failed admission.
      var flagged = candidates.recordAttention(projectRef, candidate.candidateKey,
        "owner_approval_required", true);
      if (!flagged || flagged.ok !== true) {
        return fail(projectRef, candidate, "owner_attention_unpersisted");
      }
      note({
        outcome: "deferred", reason: "owner_approval_required", needsOwner: true,
        itemKey: candidate.itemKey, projectId: projectRef.projectId,
      });
      return { ok: true, state: "deferred", reason: "owner_approval_required", needsOwner: true };
    }
    if (!crossProject || typeof crossProject.createProjectExecution !== "function") {
      return fail(projectRef, candidate, "cross_project_unavailable");
    }
    // Coop's identity is a precondition, not a detail.
    var coopSource = coopSessionRef();
    if (!coopSource) {
      return fail(projectRef, candidate, "coop_session_unavailable");
    }

    var portfolioTaskId = portfolioTaskIdFor(candidate);
    var bindingRevision = 1;
    var idempotencyKey = idempotencyKeyFor(portfolioTaskId, bindingRevision);
    var executionRequest = {
      source: coopSource,
      targetProject: { projectId: projectRef.projectId },
      mode: "project_coordinator",
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
      idempotencyKey: idempotencyKey,
      text: briefFor(candidate),
      createdAt: now(),
    };
    // FORWARD-ONLY. Passed through only when the candidate already carries a
    // ref; nothing here infers, guesses, or backfills one, so historical
    // candidates admitted before topic refs existed stay unattributed rather
    // than being credited to a lens nobody chose.
    var candidateTopicRef = candidate.coopTopicRef || candidate.topicRef;
    if (candidateTopicRef) executionRequest.coopTopicRef = candidateTopicRef;
    var result = crossProject.createProjectExecution(executionRequest);

    var expected = {
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
      mode: "project_coordinator",
      idempotencyKey: idempotencyKey,
      targetProject: { projectId: projectRef.projectId },
    };
    var bound = !!(result && result.ok === true);
    if (!bound && result && result.reason === "active_binding_exists") {
      // Only a replay if it is provably OUR binding. An unrelated binding
      // occupying this task id must never count as admission for this item.
      if (!getBinding) return fail(projectRef, candidate, "binding_unverifiable");
      var existing;
      try {
        existing = getBinding(portfolioTaskId, bindingRevision);
      } catch (e) {
        existing = null;
      }
      if (!sameBinding(existing, expected)) {
        return fail(projectRef, candidate, "binding_mismatch");
      }
      bound = true;
    }
    if (!bound) {
      return fail(projectRef, candidate, (result && result.reason) || "execution_failed");
    }

    // ONLY NOW. Marking before the commit would turn a reservation failure into
    // a silently dropped item.
    var marked = candidates.markAdmitted(projectRef, candidate.candidateKey, {
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
    });
    if (!marked.ok) {
      // The binding exists but our bookkeeping did not land. Left pending on
      // purpose: the next pass replays the same deterministic ids, the store
      // reports the binding already exists, and the mark is retried. Nothing
      // is executed twice.
      note({
        outcome: "admitted_unmarked", reason: marked.reason,
        itemKey: candidate.itemKey, projectId: projectRef.projectId,
        portfolioTaskId: portfolioTaskId,
      });
      return fail(projectRef, candidate, "mark_admitted_failed");
    }
    candidates.clearAttention(projectRef, candidate.candidateKey);
    note({
      outcome: "admitted", itemKey: candidate.itemKey, projectId: projectRef.projectId,
      portfolioTaskId: portfolioTaskId, bindingRevision: bindingRevision,
    });
    return {
      ok: true, state: "admitted",
      binding: { portfolioTaskId: portfolioTaskId, bindingRevision: bindingRevision },
    };
  }

  // admitPending(options) -> { ok, admitted, deferred, failed, attention }
  // Never throws: one bad candidate must not stop the rest of the queue.
  //
  // `options.maxAdmissions` bounds how much work may be put in flight by THIS
  // pass. Admission is where concurrency has to be enforced under Coop, because
  // proposing is not what starts work — binding is. Capping the scan instead
  // would suppress discovery, which is the one thing the cutover promises to
  // keep. Items over the cap stay pending, untouched and un-attentioned: they
  // are not stuck, they are queued, and the next pass takes them as workers
  // finish and slots free up.
  function admitPending(options) {
    if (readLeadMode() !== true) {
      return { ok: true, admitted: 0, deferred: 0, failed: 0, attention: [], skipped: "lead_mode_off" };
    }
    // Fail closed on a corrupt queue. `list()` returns a bare array and would
    // make corruption indistinguishable from "nothing to admit", which is how
    // work goes missing without anyone noticing.
    var queue;
    try {
      // Both plain pending work and work an owner has explicitly approved.
      queue = candidates.pending({ statuses: ["pending", "owner_approved"] });
    } catch (e) {
      queue = { ok: false, reason: "candidate_store_unreadable" };
    }
    if (!queue.ok) {
      note({ outcome: "failed", reason: queue.reason || "candidate_store_unreadable" });
      console.error("[automation-admission] candidate queue unreadable (" +
        (queue.reason || "unknown") + "); refusing to treat it as empty");
      return {
        ok: false, reason: queue.reason || "candidate_store_unreadable",
        admitted: 0, deferred: 0, failed: 0,
        attention: [{ itemKey: null, reason: queue.reason || "candidate_store_unreadable" }],
      };
    }
    var pending = queue.candidates;
    var opts2 = options || {};
    var rawCap = opts2.maxAdmissions;
    var capped = rawCap !== undefined && rawCap !== null;
    // A cap of zero is a real answer — "no capacity right now" — and must stop
    // admission rather than be treated as "no cap given".
    var remaining = capped ?
      (Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : 0) : Infinity;
    var admitted = 0;
    var deferred = 0;
    var failed = 0;
    var queuedForCapacity = 0;
    var attention = [];
    var ownerDecisions = [];
    for (var i = 0; i < pending.length; i++) {
      var outcome;
      // Out of capacity. An owner-gated item still needs its decision recorded,
      // so only work that would actually START is held back here.
      if (remaining <= 0 && pending[i].admission === "auto") {
        queuedForCapacity++;
        continue;
      }
      try {
        outcome = admitOne(pending[i]);
      } catch (e) {
        outcome = { ok: false, state: "failed", reason: "admission_threw" };
        // The throw bypassed admitOne's own attention write, so record it here.
        try {
          candidates.recordAttention(pending[i].projectRef, pending[i].candidateKey,
            "admission_threw", false);
        } catch (attentionError) {
          console.error("[automation-admission] could not record attention for " +
            pending[i].itemKey + ":", attentionError && attentionError.message);
        }
        note({ outcome: "failed", reason: "admission_threw", itemKey: pending[i].itemKey });
      }
      if (outcome.state === "admitted") { admitted++; remaining--; }
      else if (outcome.state === "deferred") {
        deferred++;
        if (outcome.needsOwner) ownerDecisions.push({
          itemKey: pending[i].itemKey,
          candidateKey: pending[i].candidateKey,
          projectRef: pending[i].projectRef,
          itemClass: pending[i].itemClass,
          reason: outcome.reason,
        });
      }
      else {
        failed++;
        attention.push({ itemKey: pending[i].itemKey, reason: outcome.reason });
        console.error("[automation-admission] could not admit " + pending[i].itemKey +
          " (" + outcome.reason + "); it stays pending and will be retried");
      }
    }
    return {
      ok: failed === 0,
      reason: failed ? "admission_failed" : undefined,
      admitted: admitted, deferred: deferred, failed: failed,
      // Not a failure and not attention: work that is simply waiting for a slot.
      queuedForCapacity: queuedForCapacity,
      attention: attention, ownerDecisions: ownerDecisions,
    };
  }

  return {
    admitOne: admitOne,
    admitPending: admitPending,
    idempotencyKeyFor: idempotencyKeyFor,
    portfolioTaskIdFor: portfolioTaskIdFor,
  };
}

module.exports = {
  createCandidateAdmission: createCandidateAdmission,
  identityDigest: identityDigest,
  sameBinding: sameBinding,
  idempotencyKeyFor: idempotencyKeyFor,
  portfolioTaskIdFor: portfolioTaskIdFor,
};
