function isFiniteTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function canonicalSessionStorageId(session) {
  if (!session) return null;
  return session.storageId || session.cliSessionId || null;
}

function isCanonicalCoopSession(session) {
  return !!(session && (session.coopHome === true || session.coopChannel));
}

function isCoopControlled(session) {
  return !!(session && session.coopControlledBy &&
    session.coopControlledBy.coopSessionStorageId);
}

function deriveControlledBy(coordinatorSession, since) {
  var canonicalId = null;
  if (isCanonicalCoopSession(coordinatorSession)) {
    canonicalId = canonicalSessionStorageId(coordinatorSession);
  } else if (isCoopControlled(coordinatorSession)) {
    canonicalId = coordinatorSession.coopControlledBy.coopSessionStorageId;
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

function shouldSuppressOwnerNotification(session, usersModule) {
  if (!session || !session.ownerId || !isCoopControlled(session)) return false;
  if (isCanonicalCoopSession(session)) return false;
  if (!usersModule || typeof usersModule.getLeadMode !== "function") return false;
  return usersModule.getLeadMode(session.ownerId) === true;
}

module.exports = {
  canonicalSessionStorageId: canonicalSessionStorageId,
  deriveControlledBy: deriveControlledBy,
  isCanonicalCoopSession: isCanonicalCoopSession,
  isCoopControlled: isCoopControlled,
  shouldSuppressOwnerNotification: shouldSuppressOwnerNotification,
};
