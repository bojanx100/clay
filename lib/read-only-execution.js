// Execution authority comes from admitted, server-owned policy. A brief,
// model preference or permission switch cannot expand that authority.
function ownRestriction(session) {
  var policy = session && session.orchestrationPolicy;
  return !!(policy && (policy.readOnlyExecution === true ||
    policy.portfolioExecution && policy.portfolioExecution.reviewOnly === true));
}

function isReadOnly(session, sm) {
  var visited = new Set();
  while (session && !visited.has(session)) {
    visited.add(session);
    if (ownRestriction(session)) return true;
    var parent = session.orchestrationParent;
    var found = null;
    if (!parent || !sm || !sm.sessions) return false;
    sm.sessions.forEach(function (candidate) {
      if (parent.sessionStorageId ? candidate.storageId === parent.sessionStorageId :
          candidate.localId === parent.sessionId) found = candidate;
    });
    session = found;
  }
  return false;
}

function inherit(parent, worker, sm) {
  if (!isReadOnly(parent, sm)) return;
  worker.orchestrationPolicy = Object.assign({}, worker.orchestrationPolicy || {},
    { readOnlyExecution: true });
}

function retain(session, sm) {
  if (ownRestriction(session) || !isReadOnly(session, sm)) return;
  var previous = session.orchestrationPolicy;
  inherit(session, session, sm);
  try {
    if (sm.saveSessionFile(session, { durable: true }) === false) {
      throw new Error("Read-only inherited authority could not be saved.");
    }
  } catch (error) {
    session.orchestrationPolicy = previous;
    throw error;
  }
}

function denial() {
  return { behavior: "deny", message: "This execution is authorized for read-only evidence work. " +
    "Return findings in the conversation; implementation needs a separately admitted task." };
}

function toolDecision(session, sm, name, input) {
  if (!isReadOnly(session, sm)) return null;
  if (["Read", "Glob", "Grep"].indexOf(name) !== -1) {
    return { behavior: "allow", updatedInput: input };
  }
  return denial();
}

module.exports = { isReadOnly: isReadOnly, inherit: inherit, retain: retain,
  denial: denial, toolDecision: toolDecision };
