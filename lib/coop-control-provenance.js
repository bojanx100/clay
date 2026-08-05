var defaultUsersModule = require("./users");

function isFiniteTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function canonicalSessionStorageId(session) {
  if (!session) return null;
  return session.storageId || session.cliSessionId || null;
}

function isCanonicalCoopSession(session) {
  return !!(session && (session.coopHome === true || session.coopChannel));
}

// Explicit, validated shape only: {coopSessionStorageId: non-empty string,
// since: finite timestamp}. Anything else (missing fields, wrong types,
// legacy/corrupt persisted data) normalizes to null so a malformed value on
// disk can never be silently trusted as provenance. Used at every read/write
// boundary (persistence, loader, buildNewSession, direct assignment sites)
// so provenance is always either well-formed or absent — never inferred.
function normalizeControlledBy(value) {
  if (!value || typeof value !== "object") return null;
  if (!isNonEmptyString(value.coopSessionStorageId)) return null;
  if (!isFiniteTimestamp(value.since)) return null;
  return {
    coopSessionStorageId: value.coopSessionStorageId,
    since: value.since,
  };
}

function isCoopControlled(session) {
  return !!normalizeControlledBy(session && session.coopControlledBy);
}

function deriveControlledBy(coordinatorSession, since) {
  var canonicalId = null;
  if (isCanonicalCoopSession(coordinatorSession)) {
    canonicalId = canonicalSessionStorageId(coordinatorSession);
  } else {
    var inherited = normalizeControlledBy(coordinatorSession && coordinatorSession.coopControlledBy);
    if (inherited) canonicalId = inherited.coopSessionStorageId;
  }
  if (!canonicalId) return null;
  if (!isFiniteTimestamp(since)) {
    throw new TypeError("Coop control provenance requires a finite since timestamp");
  }
  return {
    coopSessionStorageId: canonicalId,
    since: since,
  };
}

// Resolves "which owner does this session belong to" for Lead-mode purposes.
// session.ownerId is authoritative when present. But Clay is *always*
// internally multi-user (see migrate-single-user.js's ensureMultiUser: a solo
// deploy is provisioned as a one-user multi-user deploy) while many session
// creation paths never stamp ownerId at all — most importantly the Lead's own
// coopHome session (sessions.js ensureCoopHomeSession -> createSession with no
// ownerId) and any worker/coordinator spawned directly under it. Falling back
// to "the sole registered user" when ownerId is absent mirrors the same
// fallback server-lead.js's resolveLeadOwnerId already uses to resolve who
// owns the Lead pseudo-project, so single-admin installs get correct
// suppression instead of it being silently dead code. With 2+ users and no
// explicit ownerId, this deliberately returns null (ambiguous) rather than
// guessing — an incorrect guess could suppress the wrong owner's notification.
function resolveSessionOwnerId(session, usersModule) {
  if (session && isNonEmptyString(session.ownerId)) return session.ownerId;
  if (!usersModule || typeof usersModule.getAllUsers !== "function") return null;
  var allUsers;
  try {
    allUsers = usersModule.getAllUsers();
  } catch (e) {
    return null;
  }
  if (Array.isArray(allUsers) && allUsers.length === 1 && allUsers[0] && allUsers[0].id) {
    return allUsers[0].id;
  }
  return null;
}

function shouldSuppressOwnerNotification(session, usersModule, leadModeModule) {
  if (!session || !isCoopControlled(session)) return false;
  if (isCanonicalCoopSession(session)) return false;
  if (leadModeModule) return leadModeModule.getLeadMode() === true;
  // Injectable user doubles are kept for the isolated watchdog tests. The
  // runtime's real users module exposes a compatibility getter backed by the
  // global lead-mode config, so no production caller can recover per-user
  // semantics through this seam.
  if (usersModule && usersModule !== defaultUsersModule && typeof usersModule.getLeadMode === "function") {
    return usersModule.getLeadMode() === true;
  }
  return require("./lead-mode").getLeadMode() === true;
}

module.exports = {
  canonicalSessionStorageId: canonicalSessionStorageId,
  deriveControlledBy: deriveControlledBy,
  isCanonicalCoopSession: isCanonicalCoopSession,
  isCoopControlled: isCoopControlled,
  normalizeControlledBy: normalizeControlledBy,
  resolveSessionOwnerId: resolveSessionOwnerId,
  shouldSuppressOwnerNotification: shouldSuppressOwnerNotification,
};
