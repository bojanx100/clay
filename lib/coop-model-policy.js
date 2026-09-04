// Canonical Coop is a control-plane role, not an ordinary project worker.
// Its provider/model set is deliberately smaller than Clay's general routing
// catalog: only explicitly governed top-tier designations are eligible, and
// anything other than live healthy is unavailable.
var providerHealth = require("./provider-health");

var POLICY_VERSION = 1;
var UNAVAILABLE_CODE = "coop_top_tier_unavailable";
var REQUIRED_CODE = "coop_top_tier_required";

// A successor is designated by adding a higher generation in the same track.
// Selection considers only the highest generation in each track, so an
// unhealthy successor can never silently fall back to the superseded model.
var TOP_TIER_POLICY = Object.freeze({
  version: POLICY_VERSION,
  designations: Object.freeze([
    Object.freeze({
      id: "codex-openai/gpt-5.6-sol",
      topTier: true,
      track: "execution",
      generation: 1,
      vendor: "codex",
      providerRouteId: "codex-openai",
      model: "gpt-5.6-sol",
    }),
    Object.freeze({
      id: "claude-anthropic/fable",
      topTier: true,
      track: "judgment",
      generation: 1,
      vendor: "claude",
      providerRouteId: "claude-anthropic",
      model: "fable",
    }),
  ]),
});

function appliesToSession(session) {
  return !!(session && session.coopHome === true);
}

function normalizedPurpose(purpose) {
  var value = String(purpose || "").toLowerCase();
  if (value === "judgment" || value === "product" || value === "design" ||
      value === "architecture" || value === "ambiguous") return "judgment";
  return "execution";
}

function activeDesignations(policy) {
  var source = policy && Array.isArray(policy.designations)
    ? policy.designations : [];
  var highestByTrack = {};
  var result = [];
  for (var i = 0; i < source.length; i++) {
    var designation = source[i];
    if (!designation || designation.topTier !== true || !designation.track ||
        !designation.vendor || !designation.providerRouteId || !designation.model ||
        !Number.isInteger(designation.generation) || designation.generation < 1) continue;
    if (!highestByTrack[designation.track] ||
        designation.generation > highestByTrack[designation.track]) {
      highestByTrack[designation.track] = designation.generation;
    }
  }
  for (var j = 0; j < source.length; j++) {
    var candidate = source[j];
    if (!candidate || candidate.topTier !== true ||
        candidate.generation !== highestByTrack[candidate.track]) continue;
    result.push(candidate);
  }
  return result;
}

function modelKey(model) {
  return providerHealth.modelKey(model);
}

function targetModel(input) {
  if (!input) return "";
  return input.verifiedModel || input.requestedModel || input.model || "";
}

function modelMatches(designation, model) {
  var governed = String(designation && designation.model || "").toLowerCase().trim();
  var candidate = String(model || "").toLowerCase().trim();
  if (governed === "fable") {
    return candidate === "fable" || candidate.indexOf("fable") !== -1;
  }
  return modelKey(designation && designation.model) === modelKey(model);
}

function targetMatches(designation, target, requireModel) {
  if (!designation || !target) return false;
  if (target.vendor && designation.vendor !== target.vendor) return false;
  var routeId = target.providerRouteId || target.routeId;
  if (routeId && designation.providerRouteId !== routeId) return false;
  var model = targetModel(target);
  if (requireModel && !model) return false;
  if (model && !modelMatches(designation, model)) return false;
  return true;
}

function purposeForSession(session, policy) {
  var active = activeDesignations(policy || TOP_TIER_POLICY);
  for (var i = 0; i < active.length; i++) {
    if (active[i].vendor === (session && session.vendor) &&
        active[i].providerRouteId === (session && session.providerRouteId)) {
      return active[i].track === "judgment" ? "judgment" : "execution";
    }
  }
  return "execution";
}

function healthState(designation, opts) {
  var reader = opts && opts.healthForCandidate;
  var health;
  try {
    health = typeof reader === "function"
      ? reader(designation)
      : providerHealth.getRouteHealth(designation.vendor,
        designation.providerRouteId, designation.model);
  } catch (error) {
    return "unknown";
  }
  return typeof health === "string" ? health : health && health.state || "unknown";
}

function routeAvailable(designation, opts) {
  var reader = opts && opts.routeAvailable;
  if (typeof reader !== "function") return true;
  try { return reader(designation) === true; } catch (error) { return false; }
}

function trackOrder(purpose) {
  return normalizedPurpose(purpose) === "judgment"
    ? ["judgment", "execution"] : ["execution", "judgment"];
}

function candidateStatus(designation, opts) {
  return {
    designation: designation,
    state: healthState(designation, opts),
    available: routeAvailable(designation, opts),
  };
}

function unavailable(statuses) {
  return {
    ok: false,
    code: UNAVAILABLE_CODE,
    reason: UNAVAILABLE_CODE,
    message: "Coop is unavailable: no designated top-tier route is healthy. " +
      "Clay will not fall back to a degraded or lower-tier model.",
    candidates: statuses || [],
  };
}

function required(target) {
  var routeId = target && (target.providerRouteId || target.routeId) || "unknown route";
  var model = targetModel(target) || "that route's default model";
  return {
    ok: false,
    code: REQUIRED_CODE,
    reason: REQUIRED_CODE,
    message: "Coop may only use a currently designated top-tier model. " +
      "Clay did not select " + routeId + "/" + model + ".",
  };
}

function withCandidate(status) {
  return {
    ok: true,
    designation: status.designation,
    vendor: status.designation.vendor,
    providerRouteId: status.designation.providerRouteId,
    model: status.designation.model,
    track: status.designation.track,
    generation: status.designation.generation,
    health: status.state,
  };
}

function selectRoute(purpose, opts) {
  var options = opts || {};
  var active = activeDesignations(options.policy || TOP_TIER_POLICY);
  var order = trackOrder(purpose);
  var statuses = [];
  for (var oi = 0; oi < order.length; oi++) {
    for (var i = 0; i < active.length; i++) {
      if (active[i].track !== order[oi]) continue;
      if (options.excludeDesignationId &&
          active[i].id === options.excludeDesignationId) continue;
      var status = candidateStatus(active[i], options);
      statuses.push(status);
      if (status.available && status.state === providerHealth.HEALTHY) {
        return withCandidate(status);
      }
    }
  }
  return unavailable(statuses);
}

function resolveTarget(target, opts) {
  var options = opts || {};
  var active = activeDesignations(options.policy || TOP_TIER_POLICY);
  var requireModel = !!targetModel(target);
  var matched = null;
  for (var i = 0; i < active.length; i++) {
    if (targetMatches(active[i], target, requireModel)) {
      matched = active[i];
      break;
    }
  }
  if (!matched) return required(target);
  var status = candidateStatus(matched, options);
  if (!status.available || status.state !== providerHealth.HEALTHY) {
    return unavailable([status]);
  }
  return withCandidate(status);
}

function designationForTarget(target, opts) {
  var options = opts || {};
  var active = activeDesignations(options.policy || TOP_TIER_POLICY);
  var requireModel = !!targetModel(target);
  for (var i = 0; i < active.length; i++) {
    if (targetMatches(active[i], target, requireModel)) return active[i];
  }
  return null;
}

function currentSessionRoute(session, opts) {
  if (!appliesToSession(session)) return { ok: true, scoped: false };
  if (!session.vendor || !session.providerRouteId || !targetModel(session)) {
    return required({
      vendor: session.vendor || null,
      providerRouteId: session.providerRouteId || null,
      model: targetModel(session),
    });
  }
  return resolveTarget({
    vendor: session.vendor || null,
    providerRouteId: session.providerRouteId || null,
    model: targetModel(session),
  }, opts);
}

function createUnavailableError(decision) {
  var error = new Error(decision && decision.message ||
    "Coop has no healthy designated top-tier route.");
  error.code = "COOP_TOP_TIER_UNAVAILABLE";
  error.reason = decision && decision.reason || UNAVAILABLE_CODE;
  return error;
}

module.exports = {
  POLICY_VERSION: POLICY_VERSION,
  TOP_TIER_POLICY: TOP_TIER_POLICY,
  UNAVAILABLE_CODE: UNAVAILABLE_CODE,
  REQUIRED_CODE: REQUIRED_CODE,
  appliesToSession: appliesToSession,
  activeDesignations: activeDesignations,
  purposeForSession: purposeForSession,
  selectRoute: selectRoute,
  resolveTarget: resolveTarget,
  designationForTarget: designationForTarget,
  currentSessionRoute: currentSessionRoute,
  createUnavailableError: createUnavailableError,
  modelMatches: modelMatches,
};
