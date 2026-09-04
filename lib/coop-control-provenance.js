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

// Coop's own canonical conversation and its control-plane sessions are
// infrastructure: every projection keyed on their provenance loses its root if
// they are released, and coop-control-plane.js reactivate() would re-stamp them
// on the next projection build anyway. Everything else Coop owns -- an
// execution leaf, a coordinator, a former worker -- is ordinary conversation
// history that the owner may legitimately reclaim.
function isReleasableFromCoopControl(session) {
  if (!isCoopControlled(session)) return false;
  if (isCanonicalCoopSession(session)) return false;
  return session.coordinationRole !== "coop_control_plane";
}

// Revoking provenance is what actually hands a Coop-owned session back to the
// owner, and it is the only thing that makes the handover stick. While
// coopControlledBy is set the session is filtered out of the sidebar as a
// terminal Coop projection, and both the completion auto-archive
// (project-task-orchestrator-completion.js) and Coop self-cleanup
// (coop-self-cleanup-runtime.js) are free to re-hide it. Clearing it makes the
// session a plain owner session, which those paths explicitly refuse to touch.
function releaseCoopControl(session, ownerId) {
  if (!isReleasableFromCoopControl(session)) return false;
  session.coopControlledBy = null;
  session.coopReleasedToOwnerAt = Date.now();
  if (isNonEmptyString(ownerId) && !isNonEmptyString(session.ownerId)) {
    session.ownerId = ownerId;
  }
  return true;
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
  isReleasableFromCoopControl: isReleasableFromCoopControl,
  normalizeControlledBy: normalizeControlledBy,
  releaseCoopControl: releaseCoopControl,
  resolveSessionOwnerId: resolveSessionOwnerId,
  shouldSuppressOwnerNotification: shouldSuppressOwnerNotification,
};
