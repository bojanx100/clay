var crypto = require("crypto");
var plane = require("./coop-control-plane");
var identity = require("./project-identity");
var mates = require("./mates");
var topics = require("./coop-topic-index");
var planning = require("./coop-planning-debate");

function attachCoopPlanning(ctx) {
  var sm = ctx.sm;
  var index = ctx.topicIndex || topics.getDefaultTopicIndex();

  function assertCaller(source) {
    if (ctx.slug !== "lead" || sm.getProjectId() !== identity.LEAD_PROJECT_ID ||
        plane.canonicalCoop(sm) !== source || source._deleted) throw new Error("canonical_coop_required");
  }

  function participants(source) {
    assertCaller(source);
    return mates.getAllMates(mates.buildMateCtx(source.ownerId || null)).filter(function (mate) {
      return mate.status === "ready" && ["claude", "codex"].indexOf(mate.vendor || "claude") !== -1;
    }).map(function (mate) { return { mateId: mate.id, name: mate.name,
      vendor: mate.vendor || "claude", model: mate.model || null }; });
  }

  function find(source, requestId) {
    var found = null;
    sm.sessions.forEach(function (session) {
      var plan = planning.record(session);
      if (plan && plan.sourceSessionStorageId === source.storageId && plan.requestId === requestId &&
          !session._deleted) found = session;
    });
    return found;
  }

  function view(session) {
    var plan = planning.record(session);
    return { ok: true, planningRef: identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, session),
      requestId: plan.requestId, kind: plan.kind, topicRef: plan.topicRef,
      status: plan.status === "running" && !session._debate ? "attention" : plan.status,
      reason: plan.status === "running" && !session._debate ? "interrupted" : plan.reason || "",
      plan: plan.plan || null, planDigest: plan.planDigest || null,
      url: "/p/lead/?sessionRef=" + encodeURIComponent("system-lead~" + session.storageId),
      transcript: (session.history || []).filter(function (entry) {
        return ["debate_turn_done", "debate_conclusion", "debate_user_floor_done",
          "debate_comment_injected"].indexOf(entry.type) !== -1;
      }).map(function (entry) { return { type: entry.type, speaker: entry.mateName || entry.moderatorName || "Owner", text: entry.text }; }) };
  }

  function inspect(source, input) {
    assertCaller(source);
    var session = find(source, input.requestId);
    if (!session) throw new Error("planning_not_found");
    return view(session);
  }

  function start(source, input) {
    assertCaller(source);
    if (!input || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.requestId || "")) throw new Error("invalid_request_id");
    if (["council", "triage"].indexOf(input.kind) === -1) throw new Error("invalid_planning_kind");
    var topicRef = topics.topicRef(input.topicRef);
    var topic = topicRef && index.resolve(topicRef, false);
    if (!topic || !topic.ok) throw new Error("open_thread_required");
    if (!String(input.question || "").trim() || input.question.length > 12000 ||
        String(input.context || "").length > 30000) throw new Error("invalid_planning_brief");
    var team = participants(source);
    var ids = [input.moderatorId].concat((input.panelists || []).map(function (p) { return p.mateId; }));
    if (!Array.isArray(input.panelists) || input.panelists.length < 2 || input.panelists.length > 4 ||
        new Set(ids).size !== ids.length || ids.some(function (id) {
          return !team.some(function (mate) { return mate.mateId === id; });
        })) throw new Error("planning_requires_moderator_and_two_to_four_distinct_ready_panelists");
    var brief = { requestId: input.requestId, kind: input.kind, topicRef: topicRef,
      question: input.question.trim(), context: input.context || "", moderatorId: input.moderatorId,
      panelists: input.panelists.map(function (p) {
        return { mateId: p.mateId, role: String(p.role || "Independent reviewer").slice(0, 200),
          brief: String(p.brief || "Challenge assumptions and propose the best approach.").slice(0, 2000) };
      }) };
    var digest = crypto.createHash("sha256").update(JSON.stringify(brief)).digest("hex");
    var existing = find(source, input.requestId);
    if (existing) {
      if (planning.record(existing).briefDigest !== digest) throw new Error("planning_request_conflict");
      if (existing._debate || existing.history.some(function (entry) { return entry.type === "debate_started"; })) return view(existing);
    }
    if (ctx.canStart && !ctx.canStart(source)) throw new Error("coop_planning_dispatch_unavailable");
    var session = existing || sm.createSessionRaw({ ownerId: source.ownerId || null });
    var label = input.kind === "council" ? "Council" : "Triage";
    session.title = label + ": " + brief.question.slice(0, 100);
    if (!existing) session.orchestrationPolicy = Object.assign({}, session.orchestrationPolicy || {}, {
      readOnlyExecution: true, coopPlanning: Object.assign({}, brief, {
        sourceSessionStorageId: source.storageId, briefDigest: digest,
        status: "starting", runVersion: 1, revisionStartIndex: 0, createdAt: Date.now(),
      }),
    });
    if (sm.saveSessionFile(session, { durable: true }) !== true) throw new Error("planning_persistence_failed");
    var linked = index.linkPlanning(topicRef, { projectRef: { projectId: identity.LEAD_PROJECT_ID },
      sessionRef: identity.sessionRef({ projectId: identity.LEAD_PROJECT_ID }, session) });
    if (!linked.ok) throw new Error("planning_thread_link_failed");
    planning.record(session).status = "running";
    if (sm.saveSessionFile(session, { durable: true }) !== true) throw new Error("planning_persistence_failed");
    var result = ctx.debate.handleMcpDebateApproval(session, {
      topic: brief.question, context: brief.context,
      specialRequests: label + " planning in Coop. Debate approaches and disagreements. " +
        "Provide a reviewable plan, acceptance criteria and unresolved decisions. Planning grants no execution authority. " +
        "The owner may join; do not require their presence to reason together. Hear every panelist before concluding.",
      panelists: brief.panelists,
    }, brief.moderatorId, null);
    if (!result.ok) {
      planning.record(session).status = "attention";
      planning.record(session).reason = result.reason;
      sm.saveSessionFile(session, { durable: true });
    }
    sm.broadcastSessionList();
    return view(session);
  }

  function finished(session) {
    var plan = planning.record(session);
    var source = plane.canonicalCoop(sm);
    if (!plan || !source || source.storageId !== plan.sourceSessionStorageId) return;
    if (!plan.reportPending || session._coopPlanningFinishReason) return;
    var report = view(session);
    delete report.transcript;
    var queued = ctx.queueUpdate && ctx.queueUpdate(source, "[Coop " + plan.kind + " planning result]\n" +
      JSON.stringify(report) + "\nReview the synthesis and unresolved choices. " +
      "Commission a project task only within existing authorization, retaining this Thread and planning reference.",
      { updateId: "planning:" + session.storageId + ":" + (plan.runVersion || 1) });
    if (queued) {
      plan.reportPending = false;
      if (sm.saveSessionFile(session, { durable: true }) !== true) plan.reportPending = true;
    }
  }

  function flushReports() {
    sm.sessions.forEach(function (session) {
      if (!planning.record(session)) return;
      if (session._coopPlanningFinishReason) planning.finish({ sm: sm }, session, session._coopPlanningFinishReason);
      if (!session._debate) planning.interrupted({ sm: sm }, session);
      finished(session);
    });
  }

  function commission(source, input) {
    assertCaller(source);
    var session = find(source, input.requestId);
    var plan = planning.record(session);
    if (!plan || plan.status !== "ready" || plan.planDigest !== input.planDigest ||
        session._debate && session._debate.phase !== "ended") {
      throw new Error("completed_planning_revision_required");
    }
    var topic = index.resolve(plan.topicRef, false);
    var target = identity.normalizeProjectRef(input.targetProject);
    if (!topic.ok || !target || target.projectId === "system-lead" ||
        topic.topic.group.kind === "project" && topic.topic.group.projectRef.projectId !== target.projectId) {
      throw new Error("planning_project_mismatch");
    }
    if (!String(input.acceptanceCriteria || "").trim() || !String(input.ownedPaths || "").trim() ||
        !String(input.portfolioTaskId || "").trim() || !Number.isInteger(input.bindingRevision) ||
        input.bindingRevision < 1 || !String(input.idempotencyKey || "").trim()) throw new Error("invalid_commission_scope");
    var request = { coordinatorSessionId: source.storageId, title: plan.question.slice(0, 160),
      objective: plan.question, context: plan.context + "\n\n[Coop planning synthesis]\n" + plan.plan +
        "\nPlanning session: " + session.storageId + "\nPlan digest: " + plan.planDigest,
      acceptanceCriteria: String(input.acceptanceCriteria || ""), ownedPaths: String(input.ownedPaths || ""),
      targetProject: target, portfolioTaskId: input.portfolioTaskId, bindingRevision: input.bindingRevision,
      idempotencyKey: input.idempotencyKey, implementationGrantRef: input.implementationGrantRef,
      mode: "project_coordinator", coopTopicRef: plan.topicRef };
    var fingerprint = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
    if (plan.commissionDigest && plan.commissionDigest !== fingerprint) throw new Error("planning_commission_conflict");
    var firstAttempt = !plan.commissionDigest;
    plan.commissionDigest = fingerprint;
    plan.commissionRequest = request;
    if (sm.saveSessionFile(session, { durable: true }) !== true) throw new Error("planning_persistence_failed");
    // This is the ordinary admitted assignment path. A completed debate adds
    // evidence, never authority, and retries retain the exact execution key.
    return Promise.resolve(ctx.delegate(request)).then(function (result) {
      if (firstAttempt && result && result.isError && result.structuredContent &&
          result.structuredContent.executionNotStarted === true) {
        delete plan.commissionDigest;
        delete plan.commissionRequest;
        if (sm.saveSessionFile(session, { durable: true }) !== true) {
          plan.commissionDigest = fingerprint;
          plan.commissionRequest = request;
        }
      }
      return result;
    });
  }

  return { start: start, inspect: inspect, participants: participants, finished: finished,
    commission: commission, flushReports: flushReports };
}

module.exports = { attachCoopPlanning: attachCoopPlanning };
