var config = require("./config");
var path = require("path");

var AUDIT_LIMIT = 100;
var broadcasterByProject = {};

function now(options) {
  return typeof options.now === "function" ? options.now() : Date.now();
}

function load(options) {
  return (options.loadConfig || config.loadConfig)() || {};
}

function save(options, value) {
  (options.saveConfig || config.saveConfig)(value);
}

function stateFromConfig(value) {
  var coop = value && value.coop;
  var state = coop && coop.leadMode;
  if (!state || typeof state !== "object" || Array.isArray(state)) return null;
  return {
    enabled: state.enabled === true,
    migratedAt: typeof state.migratedAt === "number" ? state.migratedAt : null,
    migratedFromUserId: typeof state.migratedFromUserId === "string" ? state.migratedFromUserId : null,
    changedAt: typeof state.changedAt === "number" ? state.changedAt : null,
    changedBy: typeof state.changedBy === "string" ? state.changedBy : null,
  };
}

function legacyModeForOwner(options) {
  var usersModule = options.usersModule;
  var ownerId = options.ownerId;
  if (!usersModule || !ownerId || typeof usersModule.getLegacyLeadMode !== "function") return false;
  return usersModule.getLegacyLeadMode(ownerId) === true;
}

function auditEntry(actorId, at, from, to, action) {
  return {
    action: action,
    actorId: actorId,
    at: at,
    from: from,
    to: to,
  };
}

function ensureLeadModeState(options) {
  options = options || {};
  var value = load(options);
  var existing = stateFromConfig(value);
  if (existing) return existing;

  var at = now(options);
  var enabled = legacyModeForOwner(options);
  var actorId = "system:migration";
  if (!value.coop || typeof value.coop !== "object" || Array.isArray(value.coop)) value.coop = {};
  value.coop.leadMode = {
    enabled: enabled,
    migratedAt: at,
    migratedFromUserId: options.ownerId || null,
    changedAt: null,
    changedBy: null,
  };
  value.coop.leadModeAudit = [auditEntry(actorId, at, false, enabled, "migration")];
  save(options, value);
  return stateFromConfig(value);
}

function defaultState() {
  return {
    enabled: false,
    migratedAt: null,
    migratedFromUserId: null,
    changedAt: null,
    changedBy: null,
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function normalizePath(value) {
  return value ? path.resolve(value) : "";
}

function configuredOwnerId(configValue, clayCwd) {
  var projects = configValue && Array.isArray(configValue.projects) ? configValue.projects : [];
  var target = normalizePath(clayCwd || path.resolve(__dirname, ".."));
  for (var i = 0; i < projects.length; i++) {
    if (normalizePath(projects[i] && projects[i].path) === target && nonEmptyString(projects[i].ownerId)) {
      return projects[i].ownerId;
    }
  }
  return null;
}

function resolveOwnerId(options) {
  options = options || {};
  if (nonEmptyString(options.ownerId)) return options.ownerId;
  var ownerId = configuredOwnerId(options.config || load(options), options.clayCwd);
  if (ownerId) return ownerId;
  var usersModule = options.usersModule;
  if (!usersModule || typeof usersModule.getAllUsers !== "function") return null;
  var users = usersModule.getAllUsers();
  return users.length === 1 && users[0] && nonEmptyString(users[0].id) ? users[0].id : null;
}

function getLeadMode(options) {
  return getLeadModeState(options).enabled;
}

function getLeadModeState(options) {
  options = options || {};
  var existing = stateFromConfig(load(options));
  if (existing) return existing;
  // Project runtimes read this gate while daemon boot is still registering
  // projects. Do not materialize an OFF default there, or an owner's legacy
  // opt-in would be lost before server-lead has a chance to migrate it.
  if (options.usersModule && options.ownerId) return ensureLeadModeState(options);
  return defaultState();
}

function isAuthority(user, multiUser, ownerId) {
  if (!multiUser) return true;
  return !!(user && nonEmptyString(ownerId) && user.id === ownerId);
}

function publicState(state) {
  return {
    leadMode: state.enabled,
    changedAt: state.changedAt,
    changedBy: state.changedBy,
  };
}

function stateForRejectedMutation(options) {
  return publicState(stateFromConfig(load(options)) || defaultState());
}

function migrationOptions(options) {
  var ownerId = resolveOwnerId(options);
  return Object.assign({}, options, { ownerId: ownerId });
}

function savedState(value, options) {
  return stateFromConfig(value) || ensureLeadModeState(options);
}

function writeLeadMode(value, current, enabled, actorId, at) {
  if (!value.coop || typeof value.coop !== "object" || Array.isArray(value.coop)) value.coop = {};
  value.coop.leadMode = {
    enabled: enabled,
    migratedAt: current.migratedAt,
    migratedFromUserId: current.migratedFromUserId,
    changedAt: at,
    changedBy: actorId,
  };
}

function appendAudit(value, entry) {
  var audit = Array.isArray(value.coop.leadModeAudit) ? value.coop.leadModeAudit.slice(-AUDIT_LIMIT + 1) : [];
  audit.push(entry);
  value.coop.leadModeAudit = audit;
}

function setLeadMode(options) {
  options = options || {};
  // A member cannot establish the migration source: doing that before the
  // server has resolved the actual owner could incorrectly preserve a
  // member's old flag instead. Return any already-persisted state only.
  if (!isAuthority(options.user || null, options.multiUser === true, options.ownerId || resolveOwnerId(options))) {
    return {
      ok: false,
      error: "forbidden",
      state: stateForRejectedMutation(options),
    };
  }
  var stateOptions = migrationOptions(options);
  var state = ensureLeadModeState(stateOptions);
  if (typeof options.enabled !== "boolean") {
    return { ok: false, error: "invalid_lead_mode", state: publicState(state) };
  }
  if (state.enabled === options.enabled) {
    return { ok: true, unchanged: true, state: publicState(state) };
  }

  var value = load(options);
  var current = savedState(value, stateOptions);
  var at = now(options);
  var actorId = options.user && options.user.id ? options.user.id : "local-owner";
  writeLeadMode(value, current, options.enabled, actorId, at);
  var entry = auditEntry(actorId, at, current.enabled, options.enabled, "set_lead_mode");
  appendAudit(value, entry);
  save(options, value);
  return { ok: true, state: publicState(stateFromConfig(value)), audit: entry };
}

function registerBroadcaster(projectSlug, send) {
  if (!projectSlug || typeof send !== "function") return;
  broadcasterByProject[projectSlug] = send;
}

function broadcast(message) {
  var names = Object.keys(broadcasterByProject);
  for (var i = 0; i < names.length; i++) {
    try { broadcasterByProject[names[i]](message); } catch (e) {}
  }
}

function clearBroadcasters() {
  broadcasterByProject = {};
}

module.exports = {
  AUDIT_LIMIT: AUDIT_LIMIT,
  ensureLeadModeState: ensureLeadModeState,
  getLeadMode: getLeadMode,
  getLeadModeState: getLeadModeState,
  resolveOwnerId: resolveOwnerId,
  isAuthority: isAuthority,
  publicState: publicState,
  setLeadMode: setLeadMode,
  registerBroadcaster: registerBroadcaster,
  broadcast: broadcast,
  clearBroadcasters: clearBroadcasters,
};
