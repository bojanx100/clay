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

module.exports = {
  remember: remember,
  liveEntries: liveEntries,
};
