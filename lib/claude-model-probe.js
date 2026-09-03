// Exact-route capability probes for Claude models that the SDK backend serves
// before its normal init catalog advertises them. A candidate is exposed only
// after the requested ID resolves exactly and returns the expected reply. Probe
// evidence shares the durable last-known-good catalog and is scoped by account,
// provider route, SDK/backend version, and model. Normal advertisement always
// supersedes this special path.

var crypto = require("crypto");
var fs = require("fs");
var os = require("os");
var path = require("path");
var modelCatalogCache = require("./model-catalog-cache");
var providerHealth = require("./provider-health");

var CANDIDATES = [
  { value: "claude-opus-5", displayName: "Opus 5", description: "For complex tasks." },
];
var TRANSIENT_TTL_MS = 10 * 60 * 1000;
// How long a definitive "unavailable" verdict is honored before one re-probe is
// allowed. Long enough that a genuinely unentitled model costs at most one
// probe a day, short enough that a bad verdict cannot outlive the outage that
// caused it.
var DEFINITIVE_NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000;
var DEFAULT_TIMEOUT_MS = 20000;
var _inFlight = {};
var _sdkPackage = null;

function digest(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function readSdkPackage() {
  if (_sdkPackage) return _sdkPackage;
  var candidates = [];
  try { candidates.push(require.resolve("@anthropic-ai/claude-agent-sdk/package.json")); } catch (e) {}
  try {
    var resolved = require.resolve("@anthropic-ai/claude-agent-sdk");
    candidates.push(path.join(path.dirname(resolved), "package.json"));
    candidates.push(path.join(path.dirname(resolved), "..", "package.json"));
  } catch (e) {}
  for (var i = 0; i < candidates.length; i++) {
    try {
      var parsed = JSON.parse(fs.readFileSync(candidates[i], "utf8"));
      if (parsed && parsed.version) {
        _sdkPackage = parsed;
        return parsed;
      }
    } catch (e) {}
  }
  _sdkPackage = { version: "unknown-sdk", claudeCodeVersion: "unknown-backend" };
  return _sdkPackage;
}

function credentialFingerprint(deps) {
  deps = deps || {};
  if (deps.accountKey) return String(deps.accountKey);
  var env = deps.env || process.env;
  var accountHome = deps.accountHome || os.homedir();
  var configDir = env.CLAUDE_CONFIG_DIR || path.join(accountHome, ".claude");
  var parts = ["home=" + accountHome, "config=" + configDir];
  var credentialFiles = [
    path.join(configDir, ".credentials.json"),
    path.join(configDir, "credentials.json"),
  ];
  for (var i = 0; i < credentialFiles.length; i++) {
    try { parts.push("credentials=" + fs.readFileSync(credentialFiles[i])); } catch (e) {}
  }
  var names = [
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY", "AWS_PROFILE", "GOOGLE_CLOUD_PROJECT",
  ];
  for (var j = 0; j < names.length; j++) {
    if (env[names[j]]) parts.push(names[j] + "=" + env[names[j]]);
  }
  return "sha256:" + digest(parts.join("\n"));
}

function binaryFingerprint(binaryPath) {
  if (!binaryPath) return "no-binary";
  try {
    var stat = fs.statSync(binaryPath);
    return digest(path.resolve(binaryPath) + ":" + stat.size + ":" + Math.floor(stat.mtimeMs));
  } catch (e) {
    return digest(binaryPath);
  }
}

function contextFor(model, deps) {
  deps = deps || {};
  var pkg = readSdkPackage();
  var binPath = deps.binaryPath || "";
  if (!binPath) {
    try {
      var resolver = deps.resolveClaudeBinaryPath || require("./yoke/adapters/claude").resolveClaudeBinaryPath;
      binPath = resolver();
    } catch (e) {}
  }
  var sdkVersion = deps.sdkVersion || pkg.version || "unknown-sdk";
  var backendBase = deps.backendVersion || pkg.claudeCodeVersion || "unknown-backend";
  var backendVersion = deps.backendVersion ? backendBase : backendBase + ":" + binaryFingerprint(binPath);
  return {
    accountKey: credentialFingerprint(deps),
    routeId: deps.routeId || "claude-anthropic",
    sdkVersion: sdkVersion,
    backendVersion: backendVersion,
    model: model,
  };
}

// Freshness is deliberately asymmetric between definitive positives and
// definitive negatives, because the two failure modes are not comparable.
//
// A definitive POSITIVE stays fresh indefinitely: the model has been proven to
// work on this exact account/route/SDK/backend, re-probing costs a real billed
// query, and a later-revoked entitlement surfaces visibly the next time the
// model is used.
//
// A definitive NEGATIVE must expire. `classifyError` treats "no access",
// "forbidden", "unauthorized" and "unknown model" as definitive, so a provider
// outage that answers like an entitlement error -- or a model that really was
// unavailable until the account was upgraded -- records "unavailable" once, and
// then the model disappears from the picker permanently: `extraClaudeModels`
// re-probes only entries that are NOT fresh and offers only entries that ARE
// available, and no caller anywhere passes `force: true`. A wrong negative is
// silent and self-perpetuating; a wrong positive is loud and self-correcting.
// So only the negative gets a TTL.
function ageOf(timestamp) {
  var at = Date.parse(timestamp || "");
  if (!isFinite(at)) return NaN;
  var age = Date.now() - at;
  return age < 0 ? NaN : age;
}

function freshCapability(entry) {
  if (!entry) return false;
  if (entry.definitive && entry.available) return true;
  var age = ageOf(entry.attemptedAt);
  if (!isFinite(age)) return false;
  if (!entry.definitive) return age < TRANSIENT_TTL_MS;
  if (age < DEFINITIVE_NEGATIVE_TTL_MS) return true;
  // The negative has expired and is due a re-probe. `rememberCapability` keeps
  // the original `attemptedAt` when a transient attempt follows a definitive
  // verdict, so this entry stays permanently expired -- which would re-probe on
  // every single catalog resolution while the route is down. Back off on the
  // last attempt instead, so a persistently failing route costs one probe per
  // transient window rather than one per lookup.
  var retryAge = ageOf(entry.lastAttempt && entry.lastAttempt.attemptedAt);
  return isFinite(retryAge) && retryAge < TRANSIENT_TTL_MS;
}

function cachedEntry(model, deps) {
  var entry = modelCatalogCache.cachedCapability(contextFor(model, deps));
  if (!entry) return null;
  entry.fresh = freshCapability(entry);
  return entry;
}

function recordVerdict(model, verdict, deps) {
  return modelCatalogCache.rememberCapability(contextFor(model, deps), verdict);
}

function classifyError(text) {
  var value = typeof text === "string" ? text : JSON.stringify(text || "");
  var lower = value.toLowerCase();
  if (/rate.?limit|too many requests|quota|overloaded|capacity/.test(lower)) {
    return { available: false, definitive: false, reason: "rate-or-quota" };
  }
  if (/timed? ?out|abort|network|socket|stream|disconnect|connection|econn|fetch failed|temporar/.test(lower)) {
    return { available: false, definitive: false, reason: "transport" };
  }
  if (/no access|access denied|permission denied|forbidden|unauthorized|not entitled|not available (?:to|for) (?:this|your) account/.test(lower) ||
      /(?:invalid|unknown|unsupported) model|model[^\n]*(?:does not exist|doesn't exist|not found)/.test(lower)) {
    return { available: false, definitive: true, reason: "access-denied" };
  }
  return { available: false, definitive: false, reason: "probe-failed" };
}

async function defaultQueryRunner(model, binPath, cwd, ac) {
  var sdk = await import("@anthropic-ai/claude-agent-sdk");
  var options = {
    model: model,
    cwd: cwd,
    abortController: ac,
    settingSources: ["user"],
    permissionMode: "bypassPermissions",
    maxTurns: 1,
    allowedTools: [],
  };
  if (binPath) options.pathToClaudeCodeExecutable = binPath;
  return sdk.query({
    prompt: "Reply with exactly: PONG",
    options: options,
  });
}

function messageText(message) {
  var content = message && message.message && message.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  var parts = [];
  for (var i = 0; i < content.length; i++) {
    if (content[i] && content[i].type === "text" && typeof content[i].text === "string") parts.push(content[i].text);
  }
  return parts.join("");
}

function resolveProbeBinary(deps) {
  if (deps.binaryPath) return deps.binaryPath;
  var resolver = deps.resolveClaudeBinaryPath || require("./yoke/adapters/claude").resolveClaudeBinaryPath;
  return resolver();
}

function newObservation() {
  return { resolvedModel: null, replied: false, succeeded: false, failure: null };
}

function applyProbeMessage(observation, message) {
  if (message.type === "system" && message.subtype === "init") {
    observation.resolvedModel = message.model || null;
  }
  if (message.type === "assistant" && messageText(message).trim() === "PONG") {
    observation.replied = true;
  }
  if (message.type === "result") {
    observation.succeeded = message.subtype === "success";
    if (!observation.succeeded) {
      observation.failure = classifyError(message.result || message.error || message.subtype);
    }
    return true;
  }
  if (message.type === "error" || (message.type === "system" && message.subtype === "error")) {
    observation.failure = classifyError(message.error || message.message);
    return true;
  }
  return false;
}

async function observeQuery(query) {
  var observation = newObservation();
  for await (var message of query) {
    if (applyProbeMessage(observation, message)) break;
  }
  return observation;
}

function exceptionObservation(error, timedOut) {
  var observation = newObservation();
  var detail = error;
  if (timedOut) detail = "timeout";
  else if (error && error.message) detail = error.message;
  observation.failure = classifyError(detail);
  return observation;
}

async function cleanupProbe(query, timer, cwd) {
  clearTimeout(timer);
  try { if (query && query.interrupt) await query.interrupt(); } catch (e) {}
  try { fs.rmSync(cwd, { recursive: true, force: true }); } catch (e) {}
}

function incompleteReason(observation) {
  if (!observation.resolvedModel) return "missing-resolved-model";
  if (!observation.replied) return "probe-reply-mismatch";
  return "probe-incomplete";
}

function verdictFromObservation(model, observation) {
  if (observation.failure) {
    return Object.assign({}, observation.failure, { resolvedModel: observation.resolvedModel });
  }
  if (observation.resolvedModel && observation.resolvedModel !== model) {
    return {
      available: false,
      definitive: true,
      reason: "wrong-resolved-model",
      resolvedModel: observation.resolvedModel,
    };
  }
  if (!observation.succeeded || !observation.resolvedModel || !observation.replied) {
    return {
      available: false,
      definitive: false,
      reason: incompleteReason(observation),
      resolvedModel: observation.resolvedModel,
    };
  }
  return {
    available: true,
    definitive: true,
    reason: "exact-probe-success",
    resolvedModel: observation.resolvedModel,
  };
}

function recordProbeHealth(context, verdict) {
  var options = { providerRouteId: context.routeId, model: context.model };
  if (verdict.available) {
    providerHealth.recordSuccess("claude", options);
  } else if (!verdict.definitive) {
    providerHealth.recordFailure("claude", "capability probe: " + verdict.reason,
      Object.assign({}, options, { scope: "route-model" }));
  }
}

async function probeModel(model, deps) {
  deps = deps || {};
  var runner = deps.queryRunner || defaultQueryRunner;
  var binPath = resolveProbeBinary(deps);
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-model-probe-"));
  var ac = new AbortController();
  var timedOut = false;
  var timer = setTimeout(function () { timedOut = true; ac.abort(); }, deps.timeoutMs || DEFAULT_TIMEOUT_MS);
  var observation;
  var q;
  try {
    q = await runner(model, binPath, cwd, ac);
    observation = await observeQuery(q);
  } catch (e) {
    observation = exceptionObservation(e, timedOut);
  } finally {
    await cleanupProbe(q, timer, cwd);
  }
  return verdictFromObservation(model, observation);
}

function ensureProbe(model, deps) {
  deps = deps || {};
  var context = contextFor(model, deps);
  var existing = modelCatalogCache.cachedCapability(context);
  if (!deps.force && freshCapability(existing)) return Promise.resolve(existing.available);
  var key = modelCatalogCache.capabilityKey(context);
  if (_inFlight[key]) return _inFlight[key];
  var probeDeps = Object.assign({}, deps);
  probeDeps.binaryPath = deps.binaryPath || (deps.resolveClaudeBinaryPath || require("./yoke/adapters/claude").resolveClaudeBinaryPath)();
  _inFlight[key] = probeModel(model, probeDeps).then(function (verdict) {
    modelCatalogCache.rememberCapability(context, verdict);
    recordProbeHealth(context, verdict);
    var stored = modelCatalogCache.cachedCapability(context);
    return !!(stored && stored.available);
  }).catch(function () {
    return false;
  }).then(function (available) {
    delete _inFlight[key];
    return available;
  });
  return _inFlight[key];
}

function valueOf(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.model || model.id || model.name || "";
}

function extraClaudeModels(authoritativeModels, deps) {
  deps = deps || {};
  var present = {};
  (Array.isArray(authoritativeModels) ? authoritativeModels : []).forEach(function (model) {
    var value = valueOf(model);
    if (value) present[value] = 1;
  });
  var out = [];
  CANDIDATES.forEach(function (candidate) {
    if (present[candidate.value]) return;
    var cached = cachedEntry(candidate.value, deps);
    if ((!cached || !cached.fresh) && deps.background !== false) ensureProbe(candidate.value, deps);
    if (cached && cached.available) {
      out.push({ value: candidate.value, displayName: candidate.displayName, description: candidate.description });
    }
  });
  return out;
}

function isFableEntry(model) { return valueOf(model).toLowerCase().indexOf("fable") !== -1; }
function isMetaEntry(model) { var value = valueOf(model); return value === "default" || value === "best"; }

function mergeExtras(list, extras) {
  var base = Array.isArray(list) ? list.slice() : [];
  if (!extras || !extras.length) return base;
  var present = {};
  base.forEach(function (model) { var value = valueOf(model); if (value) present[value] = 1; });
  var toAdd = extras.filter(function (extra) { return !present[valueOf(extra)]; });
  if (!toAdd.length) return base;
  var index = -1;
  for (var i = 0; i < base.length; i++) {
    if (isFableEntry(base[i])) { index = i + 1; break; }
  }
  if (index === -1) {
    index = 0;
    for (var j = 0; j < base.length; j++) {
      if (isMetaEntry(base[j])) index = j + 1;
      else break;
    }
  }
  Array.prototype.splice.apply(base, [index, 0].concat(toAdd));
  return base;
}

function resetInFlight() { _inFlight = {}; }

module.exports = {
  CANDIDATES: CANDIDATES,
  mergeExtras: mergeExtras,
  cachePath: modelCatalogCache.catalogPath,
  contextFor: contextFor,
  cachedEntry: cachedEntry,
  recordVerdict: recordVerdict,
  classifyError: classifyError,
  probeModel: probeModel,
  ensureProbe: ensureProbe,
  extraClaudeModels: extraClaudeModels,
  resetInFlight: resetInFlight,
};
