// Daemon-wide cache of the latest rate-limit usage per vendor+limit-type.
//
// Rate limits are ACCOUNT-wide, not project-wide: a five-hour limit hit in one
// project applies to every project using that vendor account. Keeping the
// cache at module scope (one per daemon process) means the top-bar usage pill
// is correct in every project and survives page reloads/reconnects — the
// previous client-memory-only state vanished on reload and never appeared in
// projects that hadn't hit the limit themselves.

var _cache = {}; // "vendor|rateLimitType" -> rate_limit_usage message

function remember(usageMsg) {
  if (!usageMsg || !usageMsg.vendor || !usageMsg.rateLimitType) return;
  _cache[usageMsg.vendor + "|" + usageMsg.rateLimitType] = usageMsg;
}

// Live (unexpired) entries; prunes expired ones as a side effect.
function liveEntries() {
  var out = [];
  for (var key in _cache) {
    if (!_cache.hasOwnProperty(key)) continue;
    var entry = _cache[key];
    if (!entry || !entry.resetsAt || entry.resetsAt <= Date.now()) {
      delete _cache[key];
      continue;
    }
    out.push(entry);
  }
  return out;
}

// Rate-limit types tied to the shared Claude quota pool that Fable (the
// current "best" model) draws from. The seven_day_opus/seven_day_sonnet
// windows are model-specific and only apply when those older models are
// explicitly selected, so they don't mean Fable itself is exhausted.
var CLAUDE_SHARED_POOL_TYPES = {
  five_hour: true,
  seven_day: true,
  seven_day_overage_included: true,
};

// True when Claude's shared quota pool is currently rejecting requests,
// meaning Fable (offered as "best") has no usage left. Used to steer the
// "best" selector to fall back to Opus instead of erroring on Fable.
function isClaudeFableExhausted() {
  var entries = liveEntries();
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (entry.vendor === "claude" && entry.status === "rejected" && CLAUDE_SHARED_POOL_TYPES[entry.rateLimitType]) {
      return true;
    }
  }
  return false;
}

module.exports = {
  remember: remember,
  liveEntries: liveEntries,
  isClaudeFableExhausted: isClaudeFableExhausted,
};
