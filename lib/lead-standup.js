// Lead standup composer (CTO orchestrator brick 5 — roadmap §7.2).
//
// Composes the boss's daily digest from TYPED events only — the audit's
// standing law: agent prose is not evidence, and it is not reporting
// either. Workers' free text never enters the standup; only structured
// fields (status, verification depth, evidence strings explicitly captured
// as evidence) do.
//
// Pure: injected clock, no I/O. The Lead loop maintains the event ledger
// and calls composeStandup once a day (and on demand).
//
// Event shapes (ledger entries the Lead records as it works):
//   { type: "staffed",   at, item: {id,title,project}, route: {vendor,model,tier} }
//   { type: "completed", at, item, route, verificationDepth, evidence }
//   { type: "blocked",   at, item, route, reason }
//   { type: "failed",    at, item, route, reason, willRetryAtTier }
// Unwired (§1.1); nothing requires this module yet.

function fmtDuration(ms) {
  if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + "m";
  if (ms < 86400000) return Math.round(ms / 3600000) + "h";
  return Math.round(ms / 86400000) + "d";
}

function itemLabel(item) {
  return (item.project ? item.project + " " : "") + (item.id || "") +
    (item.title ? " — " + item.title : "");
}

// composeStandup(input) -> { text, counts }
//   input.events: ledger entries since the last standup (typed, see above)
//   input.portfolio: current portfolio (lead-backlog.buildPortfolio output) or null
//   input.canaries: { recoveryEvents, wsHandlerErrors } counts since last standup, or null
//   input.now: injected clock (ms)
//   input.upNextCount: how many queued items to preview (default 3)
function composeStandup(input) {
  var events = (input && input.events) || [];
  var portfolio = (input && input.portfolio) || null;
  var canaries = (input && input.canaries) || null;
  var now = (input && input.now) || 0;
  var upNextCount = (input && input.upNextCount) || 3;

  var shipped = [], blocked = [], failed = [];
  var staffedBy = {}; // itemId -> staffed event (latest)
  var terminal = {};  // itemId -> true once completed/blocked/failed

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (!ev || !ev.item) continue;
    if (ev.type === "staffed") staffedBy[ev.item.id] = ev;
    else if (ev.type === "completed") { shipped.push(ev); terminal[ev.item.id] = true; }
    else if (ev.type === "blocked") { blocked.push(ev); terminal[ev.item.id] = true; }
    else if (ev.type === "failed") { failed.push(ev); terminal[ev.item.id] = true; }
  }

  var inFlight = [];
  for (var id in staffedBy) {
    if (!terminal[id]) inFlight.push(staffedBy[id]);
  }

  var lines = [];
  lines.push("# Standup");
  lines.push("");

  // Shipped — with gate depth and evidence, never bare claims.
  lines.push("## Shipped (" + shipped.length + ")");
  if (!shipped.length) lines.push("- nothing since last standup");
  for (var si = 0; si < shipped.length; si++) {
    var s = shipped[si];
    lines.push("- " + itemLabel(s.item) + " · " + s.route.vendor + "/" + s.route.model +
      " · gate: " + (s.verificationDepth || "standard") +
      (s.evidence ? " · evidence: " + s.evidence : " · evidence: MISSING (do not trust)"));
  }
  lines.push("");

  // In flight — who is on what, where, for how long.
  lines.push("## In flight (" + inFlight.length + ")");
  if (!inFlight.length) lines.push("- idle");
  for (var fi = 0; fi < inFlight.length; fi++) {
    var f = inFlight[fi];
    lines.push("- " + itemLabel(f.item) + " · " + f.route.vendor + "/" + f.route.model +
      " · running " + fmtDuration(now - f.at));
  }
  lines.push("");

  // Needs you — the only section that demands the boss's attention.
  var needsYou = blocked.length + failed.length;
  lines.push("## Needs you (" + needsYou + ")");
  if (!needsYou) lines.push("- nothing");
  for (var bi = 0; bi < blocked.length; bi++) {
    lines.push("- BLOCKED: " + itemLabel(blocked[bi].item) + " — " + (blocked[bi].reason || "no reason recorded"));
  }
  for (var xi = 0; xi < failed.length; xi++) {
    var x = failed[xi];
    lines.push("- FAILED: " + itemLabel(x.item) + " — " + (x.reason || "no reason recorded") +
      (x.willRetryAtTier ? " (auto-retrying at tier " + x.willRetryAtTier + ")" : " (out of retries)"));
  }
  lines.push("");

  // Up next — from the live portfolio, with the deterministic why.
  if (portfolio && portfolio.items && portfolio.items.length) {
    lines.push("## Up next");
    var shown = 0;
    for (var pi = 0; pi < portfolio.items.length && shown < upNextCount; pi++) {
      var p = portfolio.items[pi];
      if (staffedBy[p.id] && !terminal[p.id]) continue; // already running
      lines.push("- [" + p.score + "] " + itemLabel(p) +
        (p.route ? " -> " + p.route.vendor + "/" + p.route.model : " -> UNROUTABLE"));
      shown++;
    }
    if (portfolio.summary && portfolio.summary.unroutable) {
      lines.push("- WARNING: " + portfolio.summary.unroutable + " item(s) unroutable (provider health)");
    }
    lines.push("");
  }

  // Health — canaries are the trust signal; absence of data is said aloud.
  lines.push("## Health");
  if (canaries) {
    var quiet = !canaries.recoveryEvents && !canaries.wsHandlerErrors;
    lines.push(quiet
      ? "- canaries quiet"
      : "- canaries NOT quiet: " + (canaries.recoveryEvents || 0) + " recovery event(s), " +
        (canaries.wsHandlerErrors || 0) + " handler error(s) — investigate before trusting green gates");
  } else {
    lines.push("- canary data unavailable (treat gate results with suspicion)");
  }

  return {
    text: lines.join("\n"),
    counts: {
      shipped: shipped.length,
      inFlight: inFlight.length,
      needsYou: needsYou,
      queued: portfolio && portfolio.summary ? portfolio.summary.total : 0,
    },
  };
}

module.exports = {
  composeStandup: composeStandup,
};
