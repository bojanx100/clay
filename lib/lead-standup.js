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

var metrics = require("./lead-metrics");

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

// Fold the event window into buckets the sections render from.
function digestEvents(events) {
  var d = { shipped: [], blocked: [], failed: [], staffedBy: {}, terminal: {}, lastMetrics: null };
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev && ev.type === "metrics_report") { d.lastMetrics = ev; continue; }
    if (!ev || !ev.item) continue;
    if (ev.type === "staffed") d.staffedBy[ev.item.id] = ev;
    else if (ev.type === "completed") { d.shipped.push(ev); d.terminal[ev.item.id] = true; }
    else if (ev.type === "blocked") { d.blocked.push(ev); d.terminal[ev.item.id] = true; }
    else if (ev.type === "failed") { d.failed.push(ev); d.terminal[ev.item.id] = true; }
  }
  d.inFlight = [];
  for (var id in d.staffedBy) {
    if (!d.terminal[id]) d.inFlight.push(d.staffedBy[id]);
  }
  return d;
}

// Shipped — with gate depth and evidence, never bare claims.
function shippedSection(shipped) {
  var lines = ["## Shipped (" + shipped.length + ")"];
  if (!shipped.length) lines.push("- nothing since last standup");
  for (var i = 0; i < shipped.length; i++) {
    var s = shipped[i];
    lines.push("- " + itemLabel(s.item) + " · " + s.route.vendor + "/" + s.route.model +
      " · gate: " + (s.verificationDepth || "standard") +
      (s.evidence ? " · evidence: " + s.evidence : " · evidence: MISSING (do not trust)"));
  }
  lines.push("");
  return lines;
}

// In flight — who is on what, where, for how long.
function inFlightSection(inFlight, now) {
  var lines = ["## In flight (" + inFlight.length + ")"];
  if (!inFlight.length) lines.push("- idle");
  for (var i = 0; i < inFlight.length; i++) {
    var f = inFlight[i];
    lines.push("- " + itemLabel(f.item) + " · " + f.route.vendor + "/" + f.route.model +
      " · running " + fmtDuration(now - f.at));
  }
  lines.push("");
  return lines;
}

// Needs you — the only section that demands the boss's attention.
function needsYouSection(blocked, failed) {
  var needsYou = blocked.length + failed.length;
  var lines = ["## Needs you (" + needsYou + ")"];
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
  return lines;
}

// Up next — from the live portfolio, with the deterministic why.
function upNextSection(portfolio, digest, upNextCount) {
  if (!portfolio || !portfolio.items || !portfolio.items.length) return [];
  var lines = ["## Up next"];
  var shown = 0;
  for (var pi = 0; pi < portfolio.items.length && shown < upNextCount; pi++) {
    var p = portfolio.items[pi];
    if (digest.staffedBy[p.id] && !digest.terminal[p.id]) continue; // already running
    lines.push("- [" + p.score + "] " + itemLabel(p) +
      (p.route ? " -> " + p.route.vendor + "/" + p.route.model : " -> UNROUTABLE"));
    shown++;
  }
  if (portfolio.summary && portfolio.summary.unroutable) {
    lines.push("- WARNING: " + portfolio.summary.unroutable + " item(s) unroutable (provider health)");
  }
  lines.push("");
  return lines;
}

// Health — canaries are the trust signal; absence of data is said aloud.
// Structural metrics come from the nightly job's typed verdict, never
// re-derived from prose. Absence is stated: an unmeasured gate is not green.
function healthSection(canaries, lastMetrics) {
  var lines = ["## Health"];
  if (canaries) {
    var quiet = !canaries.recoveryEvents && !canaries.wsHandlerErrors;
    lines.push(quiet
      ? "- canaries quiet"
      : "- canaries NOT quiet: " + (canaries.recoveryEvents || 0) + " recovery event(s), " +
        (canaries.wsHandlerErrors || 0) + " handler error(s) — investigate before trusting green gates");
  } else {
    lines.push("- canary data unavailable (treat gate results with suspicion)");
  }
  if (lastMetrics) {
    lines.push("- " + metrics.formatReportLine(lastMetrics));
    if (lastMetrics.suiteFailed) lines.push("- SUITE RED at metrics time — fix the suite before trusting anything above");
  } else {
    lines.push("- no structural metrics report in this window (nightly job missing or not yet run)");
  }
  return lines;
}

function composeStandup(input) {
  var events = (input && input.events) || [];
  var portfolio = (input && input.portfolio) || null;
  var canaries = (input && input.canaries) || null;
  var now = (input && input.now) || 0;
  var upNextCount = (input && input.upNextCount) || 3;

  var digest = digestEvents(events);

  var lines = ["# Standup", ""]
    .concat(shippedSection(digest.shipped))
    .concat(inFlightSection(digest.inFlight, now))
    .concat(needsYouSection(digest.blocked, digest.failed))
    .concat(upNextSection(portfolio, digest, upNextCount))
    .concat(healthSection(canaries, digest.lastMetrics));

  return {
    text: lines.join("\n"),
    counts: {
      shipped: digest.shipped.length,
      inFlight: digest.inFlight.length,
      needsYou: digest.blocked.length + digest.failed.length,
      queued: portfolio && portfolio.summary ? portfolio.summary.total : 0,
    },
  };
}

module.exports = {
  composeStandup: composeStandup,
};
