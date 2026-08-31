// Pure state reconciliation for the Session Context panel. No DOM, no store,
// so the rule below is testable on its own.

// Session Context loads in two phases: a cheap local skeleton (partial: true,
// with board/pr/items deliberately emptied) renders instantly, and the GitHub
// half follows a round-trip later. The panel refetches whenever session
// activity advanced, so that skeleton also arrives on a panel that is ALREADY
// showing a fully loaded state.
//
// Storing it as-is threw the loaded half away: the panel visibly dropped its
// issues, PR and board seconds after opening, and kept them dropped if the
// enrichment failed or returned nothing. Merge the skeleton over what is
// already loaded instead -- the same discipline handleWorkspaceContext uses
// when it patches branch/worktree/dev and keeps the GitHub items.
//
// The merged state stays partial: the GitHub half really is still in flight, so
// showForActive must still finish loading it, and the full message that follows
// replaces this wholesale.
export function mergeWorkspaceState(cachedState, msg) {
  if (!msg || !msg.partial) return msg;
  if (!cachedState || cachedState.partial) return msg;
  return Object.assign({}, cachedState, msg, {
    board: cachedState.board,
    pr: cachedState.pr,
    items: cachedState.items,
    truncatedItems: cachedState.truncatedItems,
  });
}

// A manual refresh starts a newer two-phase request for the same session.
// GitHub enrichment for the older request can finish later, so accept only the
// response carrying the request id currently owned by that session. Messages
// from an older server omit the id and remain compatible.
export function acceptsWorkspaceResponse(latestRequestId, msg) {
  if (!msg || msg.requestId == null) return true;
  return String(msg.requestId) === String(latestRequestId);
}
