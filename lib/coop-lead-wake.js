var fs = require("fs");
var path = require("path");
var config = require("./config");
var leadBacklog = require("./lead-backlog");
var leadLedger = require("./lead-ledger");
var leadLoop = require("./lead-loop");
var ownerRequests = require("./coop-owner-requests");
var portfolioBindings = require("./portfolio-execution-bindings");
var proactive = require("./coop-proactive-review");
var LEAD_WAKE_INTERVAL_MS = 5 * 60 * 1000;

function openLeadItems() {
  var file = path.join(config.CONFIG_DIR, "lead", "items.json");
  var items;
  try { items = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e && e.code === "ENOENT") return [];
    throw e;
  }
  if (Array.isArray(items)) return items;
  if (items && Array.isArray(items.items)) return items.items;
  return [];
}

function hasAnswerableOwnerRequest() {
  var requests = ownerRequests.getDefaultOwnerRequests().unanswered();
  for (var i = 0; i < requests.length; i++) {
    var state = requests[i] && requests[i].state;
    if (state !== "needs_input" && state !== "attention") return true;
  }
  return false;
}

function hasOpenLeadItem() {
  var items = openLeadItems();
  for (var i = 0; i < items.length; i++) {
    var normalized = leadBacklog.normalizeLooseItem(items[i], items[i] && items[i].project);
    var legacyState = String(items[i] && (items[i].state || items[i].status) || "")
      .trim().toLowerCase();
    if (normalized && normalized.state === "open") return true;
    if (legacyState === "pending" || legacyState === "ready") return true;
  }
  return false;
}

function hasTypedWork() {
  var loaded = portfolioBindings.readPortfolioExecutionBindings();
  if (!loaded.ok) return true;
  var records = loaded.bindings;
  for (var i = 0; i < records.length; i++) {
    if (leadLoop.bindingConsumesCapacity(records[i])) return true;
  }
  return false;
}

function hasUnreconciledHistory() {
  var file = path.join(config.CONFIG_DIR, "lead", "coop-session-ledger.json");
  var parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
  if (!parsed || !Array.isArray(parsed.entries)) return true;
  var classified = leadLedger.classifyHistoricalLedger(parsed.entries);
  var loaded = portfolioBindings.readPortfolioExecutionBindings();
  if (!loaded.ok) return true;
  var plan = leadLoop.historicalReconciliationPlan(classified.unresolved, loaded.bindings);
  return plan.actionable.length > 0;
}

function standupIsDue(nowValue) {
  var events = leadLedger.readEvents();
  var lastStandupAt = 0;
  for (var i = 0; i < events.length; i++) {
    if ((events[i].type === "standup_composed" || events[i].type === "lead_tick_wake") &&
        events[i].at > lastStandupAt) {
      lastStandupAt = events[i].at;
    }
  }
  return nowValue - lastStandupAt >= leadLoop.STANDUP_INTERVAL_MS;
}

// This is the lightweight wake predicate, not the full Lead tick gatherer.
// It deliberately avoids provider-health and budget scans while consulting
// every durable source that can require a managerial action. Any unreadable
// source wakes Lead so the foreground tick reports the error instead of
// silently converting corrupted state into "nothing to do".
function defaultHasPendingWork(nowValue) {
  try {
    if (hasAnswerableOwnerRequest()) return true;
    if (hasOpenLeadItem()) return true;
    if (leadLedger.inFlight().length > 0) return true;
    if (hasTypedWork()) return true;
    if (hasUnreconciledHistory()) return true;
    return standupIsDue(nowValue);
  } catch (e) {
    return true;
  }
}

function coopHomeSession(sm) {
  var home = null;
  if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return home;
  sm.sessions.forEach(function (session) {
    if (!home && session && session.coopHome) home = session;
  });
  return home;
}

function homeIsIdle(home) {
  // Codex keeps a resident query alive between turns. It is deliberately
  // reusable: project-user-message-queue dispatches the next turn through
  // pushMessage when isProcessing is false. Treating that transport as busy
  // leaves a completed foreground owner turn with no path to wake Lead.
  return !!home && !home.destroying && !home.isProcessing && !home.scheduledMessage;
}

function homeHasOwnerIngress(home) {
  if (!home) return false;
  if (Array.isArray(home.pendingCoopIngress) && home.pendingCoopIngress.length > 0) return true;
  return !!(home.coopConversationIngress && home.coopConversationIngress.activeIngressId);
}

function createLeadWakeHandler(ctx) {
  var hasPendingWork = ctx.hasPendingWork || defaultHasPendingWork;
  var scheduleMessage = ctx.scheduleMessage;
  var now = ctx.now || Date.now;
  return function (tick, options) {
    if (ctx.projectSlug !== "lead" || !tick || tick.leadMode !== true) return false;
    if (typeof scheduleMessage !== "function") return false;
    var nowValue = now();
    var home = coopHomeSession(ctx.sm);
    if (homeHasOwnerIngress(home)) return false;
    if (!homeIsIdle(home)) return false;
    var agenda = null;
    var inventoryError = "";
    try { if (ctx.proactive !== false) agenda = proactive.select({ sm: ctx.sm, now: nowValue }); }
    catch (error) { inventoryError = String(error.message || error).slice(0, 240); }
    if ((!options || options.force !== true) && !agenda && !inventoryError && !hasPendingWork(nowValue)) return false;
    var prompt = proactive.promptFor(agenda);
    if (inventoryError) prompt += "\nProactive inventory is unavailable; inspect this source failure: " + inventoryError;
    if (scheduleMessage(home, "lead tick", nowValue, prompt, "↻ Lead tick", {
      autoAction: true, coopLeadWake: true, coopProactiveReview: agenda,
    }) === false) return false;
    leadLedger.appendEvent({ type: "lead_tick_wake", proactiveReview: agenda,
      inventoryError: inventoryError || null }, { now: nowValue });
    return true;
  };
}

module.exports = { createLeadWakeHandler: createLeadWakeHandler, LEAD_WAKE_INTERVAL_MS: LEAD_WAKE_INTERVAL_MS };
