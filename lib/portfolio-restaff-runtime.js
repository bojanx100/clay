var crypto = require("crypto");
var projectIdentity = require("./project-identity");
var attachInfrastructureRecovery = require("./recovery-portfolio-execution-runtime").attachInfrastructureRecovery;
var attachPortfolioRestaffLive = require("./portfolio-restaff-live").attachPortfolioRestaffLive;
var disqualificationEvent = require("./portfolio-restaff-revalidation").disqualificationEvent;

function createPortfolioRestaffRuntime(ctx) {
  var sm = ctx.sm;
  var crossProject = ctx.crossProject || null;
  var projectIdForManager = ctx.projectIdForManager;
  var restaffLive = ctx.restaffRevalidation || (ctx.cwd ? attachPortfolioRestaffLive({
    cwd: ctx.cwd,
    fs: ctx.fs,
    now: ctx.now,
    fetchItems: ctx.fetchItems,
    ownerLogin: ctx.ownerLogin,
    boardExclusions: ctx.boardExclusions,
  }) : null);

  function shouldCheck(binding) {
    return !!(restaffLive && typeof restaffLive.shouldCheck === "function" &&
      restaffLive.shouldCheck(binding));
  }

  function emitDisqualificationEvent(metadata, verdict, event, session) {
    if (!event || !metadata || !metadata.source || !crossProject ||
        typeof crossProject.createEnvelope !== "function" ||
        typeof crossProject.deliverEnvelope !== "function") {
      return { ok: false, reason: "owner_event_emission_unavailable" };
    }
    var projectId = projectIdForManager(sm);
    var source = session ? projectIdentity.sessionRef({ projectId: projectId }, session) : null;
    if (!source) {
      source = { projectId: projectId, sessionStorageId: "portfolio-restaff-" +
        metadata.portfolioTaskId + "-r" + metadata.bindingRevision };
    }
    var eventId = "portfolio-binding-auto-retired-" + crypto.createHash("sha256")
      .update(JSON.stringify({ task: metadata.portfolioTaskId,
        revision: metadata.bindingRevision, reason: verdict && verdict.reason || "" }), "utf8")
      .digest("hex").slice(0, 48);
    var text = [
      "[Clay portfolio binding auto-retired]",
      "The live issue no longer qualifies for restaff/re-arm.",
      "<clay_binding_auto_retired>",
      JSON.stringify(event),
      "</clay_binding_auto_retired>",
    ].join("\n");
    try {
      var envelope = crossProject.createEnvelope({
        eventId: eventId,
        source: source,
        destination: metadata.source,
        bindingRevision: metadata.bindingRevision,
        createdAt: event.at,
        payload: { type: "coordinator_update", text: text },
      });
      return crossProject.deliverEnvelope(envelope);
    } catch (error) {
      return { ok: false, reason: "owner_event_emission_failed" };
    }
  }

  function retireAtLaunch(request, verdict) {
    if (!crossProject || typeof crossProject.retireExecutionBinding !== "function") {
      return { ok: false, reason: "binding_retirement_unavailable" };
    }
    var retired = crossProject.retireExecutionBinding(request.portfolioTaskId,
      request.bindingRevision, verdict);
    if (!retired || retired.ok !== true) return retired || {
      ok: false, reason: "binding_retirement_failed",
    };
    var event = disqualificationEvent({
      verdict: verdict,
      itemKey: request.automationAuthorization && request.automationAuthorization.itemKey ||
        request.workIdentity || "portfolio:" + request.portfolioTaskId,
      portfolioTaskId: request.portfolioTaskId,
      bindingRevision: request.bindingRevision,
      now: Date.now(),
    });
    var delivery = emitDisqualificationEvent(request, verdict, event, null);
    return { ok: true, retired: retired, event: event, eventDelivery: delivery };
  }

  function launchRevalidation(payload, request) {
    var rearm = !!(payload && payload._restaffRearm);
    if (!rearm && !shouldCheck(request)) return { ok: true };
    if (!restaffLive) {
      var unavailable = { ok: false, eligible: false,
        reason: "launch_revalidation_unavailable" };
      var unavailableRetirement = retireAtLaunch(request, unavailable);
      return unavailableRetirement.ok ? {
        ok: false, reason: unavailable.reason, disqualified: true,
        retirement: unavailableRetirement.retired,
        event: unavailableRetirement.event,
        eventDelivery: unavailableRetirement.eventDelivery,
      } : { ok: false, reason: "binding_retirement_failed", disqualified: true,
        retirement: unavailableRetirement };
    }
    var verdict;
    try { verdict = restaffLive.revalidate({ binding: request, payload: payload }); }
    catch (error) { verdict = { ok: false, eligible: false, reason: "launch_revalidation_unresolvable" }; }
    if (verdict && verdict.eligible === true) return verdict;
    var reason = verdict && verdict.reason || "launch_revalidation_unresolvable";
    var failed = Object.assign({ ok: false, eligible: false, reason: reason }, verdict || {});
    var retired = retireAtLaunch(request, failed);
    if (!retired.ok) return { ok: false, reason: "binding_retirement_failed", disqualified: true,
      retirement: retired };
    return { ok: false, reason: reason, disqualified: true, retirement: retired.retired,
      event: retired.event, eventDelivery: retired.eventDelivery };
  }

  var infrastructureRecovery = attachInfrastructureRecovery({
    crossProject: crossProject,
    sm: sm,
    discardSession: ctx.discardSession,
    setExecutionStatus: ctx.setExecutionStatus,
    revalidateRestaff: restaffLive ? function (metadata) {
      if (!shouldCheck(metadata)) return { ok: true, eligible: true, reason: "not_applicable" };
      return restaffLive.revalidate({ binding: metadata });
    } : null,
    retireBinding: function (metadata, verdict) {
      if (!crossProject || typeof crossProject.retireExecutionBinding !== "function") {
        return { ok: false, reason: "binding_retirement_unavailable" };
      }
      return crossProject.retireExecutionBinding(metadata.portfolioTaskId,
        metadata.bindingRevision, verdict);
    },
    onDisqualified: emitDisqualificationEvent,
  });
  return { infrastructureRecovery: infrastructureRecovery,
    launchRevalidation: launchRevalidation,
    emitDisqualificationEvent: emitDisqualificationEvent };
}

module.exports = { createPortfolioRestaffRuntime: createPortfolioRestaffRuntime };
