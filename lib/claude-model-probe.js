// Probe-gated discovery of Claude models the coding backend SERVES but does not
// ADVERTISE. The Agent SDK's init handshake only lists curated aliases
// (opus -> 4.8, sonnet, haiku, fable), so a freshly-shipped model like
// claude-opus-5 is usable (a forced `model: "claude-opus-5"` query succeeds) yet
// never appears in the picker. This module runs a cheap one-shot probe for such
// candidates, caches the verdict, and lets the picker offer only the ones this
// account can actually run — safe for any account (no access => never shown),
// self-updating, and it disappears as a special case the moment the SDK starts
// advertising the model normally (then it's already in the authoritative list).
//
// Cache: ~/.clay/model-probe.json (dev: model-probe-dev.json), atomic write.
// Asymmetric TTL: an "available" verdict is trusted for a day; a "no access"
// verdict (definitive) for a day too; a transient failure (timeout, rate limit)
// is retried within minutes so a blip doesn't hide a model you actually have.
// Override the path with CLAY_MODEL_PROBE_PATH (tests).

var fs = require("fs");
var os = require("os");
var path = require("path");
var config = require("./config");

// Unadvertised-but-maybe-serveable models to probe, with picker metadata.
var CANDIDATES = [
  { value: "claude-opus-5", displayName: "Opus 5", description: "For complex tasks." },
];

var AVAILABLE_TTL_MS = 24 * 60 * 60 * 1000; // trust an available verdict for a day
var DEFINITIVE_UNAVAIL_TTL_MS = 24 * 60 * 60 * 1000; // "no access" is stable
var TRANSIENT_TTL_MS = 10 * 60 * 1000; // retry a blip soon
var _inFlight = {};

function cachePath() {
  if (process.env.CLAY_MODEL_PROBE_PATH) return process.env.CLAY_MODEL_PROBE_PATH;
  return path.join(config.CONFIG_DIR, process.env.CLAY_DEV ? "model-probe-dev.json" : "model-probe.json");
}

function readCache() {
  try {
    var p = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (p && p.models && typeof p.models === "object") return p;
  } catch (e) {}
  return { version: 1, models: {} };
}

function writeCache(all) {
  try {
    var p = cachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    var tmp = p + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, p);
    config.chmodSafe(p, 0o600);
  } catch (e) {}
}

function ttlFor(entry) {
  if (entry.available) return AVAILABLE_TTL_MS;
  return entry.definitive ? DEFINITIVE_UNAVAIL_TTL_MS : TRANSIENT_TTL_MS;
}

// Returns { available, definitive, fresh } or null when never probed.
function cachedEntry(model) {
  var e = readCache().models[model];
  if (!e || typeof e.available !== "boolean" || !e.at) return null;
  var age = Date.now() - Date.parse(e.at);
  return { available: e.available, definitive: !!e.definitive, fresh: age >= 0 && age < ttlFor(e) };
}

function recordVerdict(model, verdict) {
  var all = readCache();
  all.models[model] = { available: !!verdict.available, definitive: !!verdict.definitive, at: new Date().toISOString() };
  writeCache(all);
}

// Classify a probe outcome into { available, definitive }. A model-related
// rejection is a definitive "no access"; a timeout/rate-limit/transport error is
// non-definitive (retry soon) so it never masks a model the account really has.
function classifyError(text) {
  var t = String(text || "").toLowerCase();
  if (/model|not found|no access|does not exist|doesn't exist|unavailable|invalid.*model|permission/.test(t)) {
    return { available: false, definitive: true };
  }
  return { available: false, definitive: false };
}

function defaultQueryRunner(model, binPath, cwd, ac) {
  var sdk = require("@anthropic-ai/claude-agent-sdk");
  return sdk.query({
    prompt: "Reply with exactly one word: OK",
    options: {
      model: model,
      pathToClaudeCodeExecutable: binPath,
      cwd: cwd,
      abortController: ac,
      settingSources: ["user"],
      permissionMode: "bypassPermissions",
    },
  });
}

// Run one isolated query forcing `model`; resolve to { available, definitive }.
async function probeModel(model, deps) {
  deps = deps || {};
  var runner = deps.queryRunner || defaultQueryRunner;
  var binPath = deps.binaryPath || (deps.resolveClaudeBinaryPath || require("./yoke/adapters/claude").resolveClaudeBinaryPath)();
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-model-probe-"));
  var ac = new AbortController();
  var timer = setTimeout(function () { ac.abort(); }, 60000);
  var verdict = { available: false, definitive: false };
  var q;
  try {
    q = runner(model, binPath, cwd, ac);
    for await (var msg of q) {
      if (msg.type === "result") {
        if (msg.subtype === "success") verdict = { available: true, definitive: true };
        else verdict = classifyError(msg.result || msg.error || msg.subtype);
        break;
      }
      if (msg.type === "error" || (msg.type === "system" && msg.subtype === "error")) {
        verdict = classifyError(msg.error || msg.message);
        break;
      }
    }
  } catch (e) {
    verdict = classifyError(e && e.message ? e.message : e);
  } finally {
    clearTimeout(timer);
    try { if (q && q.interrupt) await q.interrupt(); } catch (e) {}
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (e) {}
  }
  return verdict;
}

// Kick off a probe if the cache is missing or stale; idempotent (one probe per
// model in flight). Returns a promise resolving to availability.
function ensureProbe(model, deps) {
  var c = cachedEntry(model);
  if (c && c.fresh) return Promise.resolve(c.available);
  if (_inFlight[model]) return _inFlight[model];
  _inFlight[model] = probeModel(model, deps).then(function (v) {
    recordVerdict(model, v);
    return v.available;
  }).catch(function () {
    return false;
  }).then(function (avail) {
    delete _inFlight[model];
    return avail;
  });
  return _inFlight[model];
}

function valueOf(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.model || model.id || model.name || "";
}

// Given the authoritative claude model entries, return picker entries for any
// candidate that is (a) not already advertised and (b) last-probed available.
// Triggers a background probe for candidates whose verdict is unknown or stale.
function extraClaudeModels(authoritativeModels, deps) {
  var present = {};
  (Array.isArray(authoritativeModels) ? authoritativeModels : []).forEach(function (m) {
    var v = valueOf(m); if (v) present[v] = 1;
  });
  var out = [];
  CANDIDATES.forEach(function (cand) {
    if (present[cand.value]) return; // already advertised — nothing to add
    var c = cachedEntry(cand.value);
    if (!c || !c.fresh) ensureProbe(cand.value, deps); // refresh unknown/stale in background
    if (c && c.available) out.push({ value: cand.value, displayName: cand.displayName, description: cand.description });
  });
  return out;
}

module.exports = {
  CANDIDATES: CANDIDATES,
  cachePath: cachePath,
  cachedEntry: cachedEntry,
  recordVerdict: recordVerdict,
  classifyError: classifyError,
  probeModel: probeModel,
  ensureProbe: ensureProbe,
  extraClaudeModels: extraClaudeModels,
};
