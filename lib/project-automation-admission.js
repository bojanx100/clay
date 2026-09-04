// Turns pending candidates into canonical Coop-owned execution bindings.

var projectIdentity = require("./project-identity");
var automationIdentity = require("./project-automation-identity");
var executionAuthorization = require("./project-automation-execution-authorization");
var qualification = require("./project-automation-qualification");
var approvalStaging = require("./coop-approval-question-staging");
var admissionBinding = require("./project-automation-admission-binding");
var identityDigest = automationIdentity.identityDigest;
var portfolioTaskIdFor = automationIdentity.portfolioTaskIdFor;
var idempotencyKeyFor = automationIdentity.idempotencyKeyFor;
var replayRejection = admissionBinding.replayRejection;
var selectBindingRevision = admissionBinding.selectBindingRevision;
function createCandidateAdmission(options) {
  var opts = options || {};
  var candidates = opts.candidates;
  var crossProject = opts.crossProject || null;
  var now = opts.now || Date.now;
  var audit = opts.audit || null;
  var readLeadMode = opts.getLeadMode || function () { return false; };
  var scopedAutonomyPolicy = opts.scopedAutonomyPolicy || null;
  var autoApprovalPolicy = opts.autoApprovalPolicy || null;
  var loadPolicy = opts.loadPolicy || null;
  // The injected canonical live Coop SessionRef has no fabricated fallback.
  var resolveCoopSource = opts.resolveCoopSource || null;
  // Verify a claimed replay against the committed binding.
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

  // Only complete history distinguishes terminal revision 1 from a safe retry.
  function routerBindingsReader() {
    if (!crossProject || typeof crossProject.getExecutionBindings !== "function") return null;
    return function () { return crossProject.getExecutionBindings(); };
  }
  var getBindings = opts.getBindings || routerBindingsReader();

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

  // Build the structured brief required by the receiving project intake.
  function briefFor(candidate, scopedApproved) {
    var intent = candidate.intent || {};
    var itemKey = candidate.itemKey || "unknown";
    var title = intent.title ? String(intent.title) : "";
    var number = intent.number != null ? intent.number : null;
    var context = [
      "Admitted automatically from the '" + (intent.recipeId || "automation") +
        "' recipe as " + (candidate.itemClass || "unknown") + " work.",
      "Item: " + itemKey,
    ];
    if (intent.url) context.push("URL: " + intent.url);
    context.push(scopedApproved ?
      "Coop admitted this internal work through a current, bounded authority receipt. " +
        "External actions keep their configured approval, claim, or deny gates." :
      "This project's own automation policy classified the internal work as autonomous. " +
        "External actions keep their configured approval, claim, or deny gates.");
    return {
      title: number != null ? ("#" + number + " " + title).trim() : (title || itemKey),
      // Never empty: the target refuses the command without it, so it is built
      // from the item key even when the recipe carried no title at all.
      objective: "Resolve " + itemKey + (title ? (": " + title) : "") +
        ", following this project's triage and contribution rules.",
      context: context.join("\n"),
      acceptanceCriteria: "The item is resolved end to end and verified: the change " +
        "is implemented, the relevant focused tests pass, and the work is committed " +
        "locally. Stop for any external-action approval required by project policy. " +
        "You own decomposition, workers, retries and verification.",
      ownedPaths: "",
    };
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

  // A candidate this pass refused to even attempt. It is not a failure of the
  // candidate and not an owner decision, so it must not be recorded as either —
  // but it cannot be silent, because a queue that is skipped on every pass is
  // how work goes missing with nobody noticing.
  //
  // The durable attention carries the count, so repeated passes stay quiet in
  // the audit: the note is emitted only on the tick that first raises this
  // reason for this candidate.
  function noteStranded(candidate, reason) {
    var projectRef = projectIdentity.normalizeProjectRef(candidate && candidate.projectRef);
    if (!projectRef || !candidate || !candidate.candidateKey) return;
    var previous = candidate.attention || null;
    var alreadyRaised = !!previous && previous.reason === reason;
    var flagged = candidates.recordAttention(projectRef, candidate.candidateKey, reason, false);
    // A stranded candidate whose attention cannot even be persisted is strictly
    // worse than one that can, so that failure is always reported.
    if (!flagged || flagged.ok !== true) {
      note({
        outcome: "failed", reason: "stranded_attention_unpersisted",
        strandedReason: reason,
        itemKey: candidate.itemKey, projectId: projectRef.projectId,
      });
      return;
    }
    if (alreadyRaised) return;
    note({
      outcome: "deferred", reason: reason, stranded: true,
      itemKey: candidate.itemKey, projectId: projectRef.projectId,
    });
  }

  function currentQualification(candidate, projectRef) {
    // PR recipes are revalidated by their current head/check/review state in
    // project-auto-launch immediately before the primitive starts. The typed
    // issue-and-board receipt does not apply to that recipe kind.
    if (candidate && candidate.intent && candidate.intent.autoKind === "pr-review") {
      return { ok: true, receipt: { digest: "pr-review-state", coordinator: { reasons: [] } } };
    }
    if (typeof loadPolicy !== "function") {
      return { ok: false, reason: "qualification_policy_unavailable" };
    }
    var loaded;
    try { loaded = loadPolicy(projectRef); } catch (error) { loaded = null; }
    if (!loaded || loaded.ok !== true || !loaded.policy) {
      return { ok: false, reason: loaded && loaded.reason || "qualification_policy_unavailable" };
    }
    return qualification.verifyReceipt(candidate.qualificationReceipt, {
      candidate: candidate,
      policy: loaded.policy,
      now: now(),
    });
  }

  // admitOne -> { ok, state, reason, binding }
  //   state: "admitted" | "deferred" | "failed"
  function admitOne(candidate, options) {
    var projectRef = projectIdentity.normalizeProjectRef(candidate && candidate.projectRef);
    if (!projectRef) {
      // No usable ref means we cannot even record attention against it.
      note({ outcome: "failed", reason: "invalid_project_ref", itemKey: candidate && candidate.itemKey });
      return { ok: false, state: "failed", reason: "invalid_project_ref" };
    }
    if (!candidate.itemKey) return fail(projectRef, candidate, "invalid_candidate");
    var pass = options && typeof options.eligibilityPass === "string" ?
      options.eligibilityPass.trim() : "";
    if (!pass || candidate.eligibilityPass !== pass) {
      note({
        outcome: "deferred", reason: "current_eligibility_required",
        itemKey: candidate.itemKey, projectId: projectRef.projectId,
      });
      return { ok: true, state: "deferred", reason: "current_eligibility_required" };
    }
    var qualified = currentQualification(candidate, projectRef);
    if (!qualified.ok) return fail(projectRef, candidate, qualified.reason);
    var primitiveSession = options && options.primitiveSession || null;
    var primitiveRef = primitiveSession ? projectIdentity.sessionRef(projectRef, primitiveSession) : null;
    var primitiveLaunch = !!(primitiveRef && candidate.intent &&
      candidate.intent.primitiveLaunch === true);
    if (primitiveSession && !primitiveLaunch) {
      return fail(projectRef, candidate, "invalid_primitive_session");
    }
    // Once the exact-pass check above succeeds, an explicit owner YES satisfies
    // the policy decision. Approval alone is never current eligibility.
    var ownerApproved = candidate.status === "owner_approved";
    if (candidate.status === "owner_declined") {
      note({
        outcome: "declined", reason: "owner_declined",
        itemKey: candidate.itemKey, projectId: projectRef.projectId,
      });
      return { ok: true, state: "declined", reason: "owner_declined" };
    }
    // An explicit new control supersedes any legacy scoped receipt.
    var scopedDecision = null;
    var controlSupersedesScopedPolicy = autoApprovalPolicy &&
      typeof autoApprovalPolicy.hasExplicitControl === "function" &&
      autoApprovalPolicy.hasExplicitControl(projectRef);
    if (!primitiveLaunch && candidate.admission === "owner_approval" && !ownerApproved &&
        !controlSupersedesScopedPolicy &&
        scopedAutonomyPolicy && typeof scopedAutonomyPolicy.decide === "function") {
      try { scopedDecision = scopedAutonomyPolicy.decide(candidate); }
      catch (error) { scopedDecision = null; }
    }
    var scopedApproved = !!(scopedDecision && scopedDecision.ok === true);
    // Reserve before dispatch so the limit bounds concurrent scan passes.
    var autoApprovalDecision = null;
    if (!primitiveLaunch && candidate.admission === "owner_approval" && !ownerApproved && !scopedApproved &&
        autoApprovalPolicy && typeof autoApprovalPolicy.reserveCandidate === "function") {
      try { autoApprovalDecision = autoApprovalPolicy.reserveCandidate(candidate); }
      catch (error) { autoApprovalDecision = null; }
    }
    var autoApproved = !!(autoApprovalDecision && autoApprovalDecision.ok === true);
    function releaseAutoApproval() {
      if (!autoApproved || !autoApprovalPolicy ||
          typeof autoApprovalPolicy.releaseReservation !== "function") return;
      try { autoApprovalPolicy.releaseReservation(autoApprovalDecision.grant); } catch (error) {}
    }
    var portfolioTaskId = portfolioTaskIdFor(candidate);
    var bindingRevision = 1;
    if (getBindings) {
      var bindingHistory;
      try { bindingHistory = getBindings(); } catch (e) { bindingHistory = null; }
      var selection = selectBindingRevision(portfolioTaskId, bindingHistory);
      if (!selection.ok) {
        releaseAutoApproval();
        return fail(projectRef, candidate, selection.reason);
      }
      bindingRevision = selection.bindingRevision;
    } else if (!primitiveLaunch && candidate.admission !== "auto" && !ownerApproved &&
        !scopedApproved && !autoApproved) {
      return fail(projectRef, candidate, "binding_history_unavailable");
    }
    if (!primitiveLaunch && candidate.admission !== "auto" && !ownerApproved &&
        !scopedApproved && !autoApproved) {
      var approvalScope = {
        portfolioTaskId: portfolioTaskId,
        bindingRevision: bindingRevision,
        targetProject: { projectId: projectRef.projectId },
      };
      var approvalStage = Object.assign({}, approvalScope, {
        question: approvalStaging.questionFor([approvalScope]),
        stagedAt: now(),
      });
      var flagged = candidates.recordAttention(projectRef, candidate.candidateKey,
        "owner_approval_required", true, approvalStage);
      if (!flagged || flagged.ok !== true) {
        return fail(projectRef, candidate, "owner_attention_unpersisted");
      }
      note({
        outcome: "deferred", reason: "owner_approval_required", needsOwner: true,
        itemKey: candidate.itemKey, projectId: projectRef.projectId,
      });
      return { ok: true, state: "deferred", reason: "owner_approval_required",
        needsOwner: true, approvalStage: approvalStage };
    }
    if (!crossProject || typeof crossProject.createProjectExecution !== "function") {
      releaseAutoApproval();
      return fail(projectRef, candidate, "cross_project_unavailable");
    }
    // Coop's identity is a precondition, not a detail.
    var coopSource = coopSessionRef();
    if (!coopSource) {
      releaseAutoApproval();
      return fail(projectRef, candidate, "coop_session_unavailable");
    }

    var idempotencyKey = idempotencyKeyFor(portfolioTaskId, bindingRevision);
    var brief = briefFor(candidate, scopedApproved || autoApproved);
    var executionRequest = {
      source: coopSource,
      targetProject: { projectId: projectRef.projectId },
      mode: "project_coordinator",
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
      idempotencyKey: idempotencyKey,
      title: brief.title,
      objective: brief.objective,
      context: brief.context,
      acceptanceCriteria: brief.acceptanceCriteria,
      ownedPaths: brief.ownedPaths,
      text: brief.objective + "\n\n" + brief.context,
      createdAt: now(),
    };
    var candidateTopicRef = candidate.coopTopicRef || candidate.topicRef;
    if (primitiveLaunch) {
      var primitiveAuthorization = executionAuthorization.createAuthorization(candidate,
        executionRequest, { kind: executionAuthorization.PRIMITIVE_KIND });
      if (!primitiveAuthorization) {
        return fail(projectRef, candidate, "primitive_authorization_unavailable");
      }
      executionRequest.automationAuthorization = primitiveAuthorization;
      executionRequest.coopTopicRef = { topicId: primitiveAuthorization.threadRef.threadId };
      executionRequest.adoptSessionRef = primitiveRef;
    } else if (candidate.admission === "auto" && !ownerApproved) {
      var authorization = executionAuthorization.createAuthorization(candidate, executionRequest);
      if (!authorization) {
        return fail(projectRef, candidate, "automation_authorization_unavailable");
      }
      executionRequest.automationAuthorization = authorization;
      executionRequest.coopTopicRef = { topicId: authorization.threadRef.threadId };
    } else if (scopedApproved) {
      var scopedAuthorization = executionAuthorization.createAuthorization(candidate, executionRequest, {
        kind: executionAuthorization.SCOPED_KIND,
        scopedPolicyGrant: scopedDecision.grant,
      });
      if (!scopedAuthorization) {
        return fail(projectRef, candidate, "scoped_policy_authorization_unavailable");
      }
      executionRequest.automationAuthorization = scopedAuthorization;
      executionRequest.coopTopicRef = { topicId: scopedAuthorization.threadRef.threadId };
    } else if (autoApproved) {
      var autoApprovalAuthorization = executionAuthorization.createAuthorization(candidate, executionRequest, {
        kind: executionAuthorization.AUTO_APPROVAL_KIND,
        autoApprovalGrant: autoApprovalDecision.grant,
      });
      if (!autoApprovalAuthorization) {
        releaseAutoApproval();
        return fail(projectRef, candidate, "auto_approval_authorization_unavailable");
      }
      executionRequest.automationAuthorization = autoApprovalAuthorization;
      executionRequest.coopTopicRef = { topicId: autoApprovalAuthorization.threadRef.threadId };
    } else if (candidateTopicRef) {
      executionRequest.coopTopicRef = candidateTopicRef;
    }
    var result = crossProject.createProjectExecution(executionRequest);

    var expected = {
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
      mode: "project_coordinator",
      idempotencyKey: idempotencyKey,
      targetProject: { projectId: projectRef.projectId },
      coopTopicRef: executionRequest.coopTopicRef || null,
      automationAuthorization: executionRequest.automationAuthorization || null,
    };
    var bound = !!(result && result.ok === true);
    if (!bound && result && result.reason === "active_binding_exists") {
      // Only a replay if it is provably OUR binding. An unrelated binding
      // occupying this task id must never count as admission for this item.
      if (!getBinding) {
        releaseAutoApproval();
        return fail(projectRef, candidate, "binding_unverifiable");
      }
      var existing;
      try {
        existing = getBinding(portfolioTaskId, bindingRevision);
      } catch (e) {
        existing = null;
      }
      // Identity alone proves nothing about liveness: a binding we filed can
      // sit at a status meaning no coordinator was ever created.
      var rejection = replayRejection(existing, expected);
      if (rejection) {
        releaseAutoApproval();
        return fail(projectRef, candidate, rejection);
      }
      bound = true;
    }
    if (!bound) {
      releaseAutoApproval();
      return fail(projectRef, candidate, (result && result.reason) || "execution_failed");
    }

    // ONLY NOW. Marking before the commit would turn a reservation failure into
    // a silently dropped item.
    var marked = candidates.markAdmitted(projectRef, candidate.candidateKey, {
      portfolioTaskId: portfolioTaskId,
      bindingRevision: bindingRevision,
      coopThreadRef: executionRequest.automationAuthorization ?
        executionRequest.automationAuthorization.threadRef : null,
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
      qualificationReceipt: qualified.receipt.digest,
      qualificationReasons: qualified.receipt.coordinator.reasons,
      authorization: primitiveLaunch ? "primitive_launch" :
        (autoApproved ? "project_auto_approval" :
          (scopedApproved ? "scoped_autonomy" : "project_policy")),
      autoApprovalReservationId: autoApproved ? autoApprovalDecision.grant.reservationId : null,
    });
    return {
      ok: true, state: "admitted",
      binding: { portfolioTaskId: portfolioTaskId, bindingRevision: bindingRevision },
    };
  }

  // admitPending(options) -> { ok, admitted, deferred, failed, attention }
  // Never throws: one bad candidate must not stop the rest of the queue.
  // `options.eligibilityPass` is mandatory and must exactly match evidence
  // written by the scan that is invoking this admission pass.
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
    var opts2 = options || {};
    var eligibilityPass = typeof opts2.eligibilityPass === "string" ?
      opts2.eligibilityPass.trim() : "";
    if (!eligibilityPass) {
      note({ outcome: "failed", reason: "admission_pass_required" });
      return { ok: false, reason: "admission_pass_required",
        admitted: 0, deferred: 0, failed: 0, revalidationDeferred: 0,
        queuedForCapacity: 0, attention: [], ownerDecisions: [] };
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
    var rawCap = opts2.maxAdmissions;
    var capped = rawCap !== undefined && rawCap !== null;
    // A cap of zero is a real answer — "no capacity right now" — and must stop
    // admission rather than be treated as "no cap given".
    var remaining = capped ?
      (Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : 0) : Infinity;
    var admitted = 0;
    var deferred = 0;
    var failed = 0;
    var revalidationDeferred = 0;
    var queuedForCapacity = 0;
    var attention = [];
    var ownerDecisions = [];
    for (var i = 0; i < pending.length; i++) {
      var outcome;
      // These are admitted synchronously with the concrete session created by
      // the proven project launcher. The queue has no SessionRef to adopt and
      // must not turn the same item into a second generic execution.
      if (pending[i] && pending[i].intent && pending[i].intent.primitiveLaunch === true) continue;
      // A durable candidate is a queue entry, not continuing authority. Only a
      // candidate re-seen through every gate in THIS scan may reach binding.
      //
      // Refusing stale evidence is correct, but doing it with a bare `continue`
      // made the refusal invisible: a candidate whose item the scan no longer
      // re-proposes is skipped on every pass forever, and because nothing was
      // ever written, a permanently stranded queue was indistinguishable from
      // an empty one. Real webapp admission emitted ZERO audit records for over
      // 32 hours while 34 candidates sat pending on every tick.
      //
      // recordAttention keeps one durable record per candidate per reason and
      // bumps its count, so this is loud without being a storm; the audit note
      // is written only when the attention is newly raised.
      if (pending[i].eligibilityPass !== eligibilityPass) {
        deferred++;
        revalidationDeferred++;
        noteStranded(pending[i], "current_eligibility_required");
        continue;
      }
      // Out of capacity. An owner-gated item still needs its decision recorded,
      // so only work that would actually START is held back here.
      if (remaining <= 0 && pending[i].admission === "auto") {
        queuedForCapacity++;
        continue;
      }
      try {
        outcome = admitOne(pending[i], { eligibilityPass: eligibilityPass });
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
      // EVERY ATTEMPT SPENDS CAPACITY, not just every success.
      //
      // Decrementing only on success made the cap meaningless the moment
      // routing broke: 22 candidates under a limit of 5 each reached the
      // binding layer, each reserved and then released a durable `unrouted`
      // record, and the "bound" was never once consulted. A limit that only
      // counts what worked does not bound a failure — and a failing fan-out is
      // exactly when a bound matters most.
      //
      // A failed attempt therefore costs a slot too, so one scan makes at most
      // `maxAdmissions` routing attempts whatever their outcome. The rest stay
      // pending and are retried on the next scan.
      if (outcome.state === "admitted") { admitted++; remaining--; }
      else if (outcome.state === "deferred") {
        deferred++;
        if (outcome.needsOwner) ownerDecisions.push({
          itemKey: pending[i].itemKey,
          candidateKey: pending[i].candidateKey,
          projectRef: pending[i].projectRef,
          itemClass: pending[i].itemClass,
          reason: outcome.reason,
          portfolioTaskId: outcome.approvalStage.portfolioTaskId,
          bindingRevision: outcome.approvalStage.bindingRevision,
          question: outcome.approvalStage.question,
        });
      }
      else {
        failed++;
        remaining--;
        attention.push({ itemKey: pending[i].itemKey, reason: outcome.reason });
        console.error("[automation-admission] could not admit " + pending[i].itemKey +
          " (" + outcome.reason + "); it stays pending and will be retried");
      }
    }
    return {
      ok: failed === 0,
      reason: failed ? "admission_failed" : undefined,
      admitted: admitted, deferred: deferred, failed: failed,
      revalidationDeferred: revalidationDeferred,
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
  sameBinding: admissionBinding.sameBinding,
  selectBindingRevision: selectBindingRevision,
  idempotencyKeyFor: idempotencyKeyFor,
  portfolioTaskIdFor: portfolioTaskIdFor,
};
