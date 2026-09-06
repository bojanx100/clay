// Durable report delivery state. Submission receipts describe the local
// provider handle accepting input, never completed reasoning or task success.
function coordinatorUpdateState(session) {
  var pending = session && session.pendingCoordinatorUpdates || [];
  var attention = pending.filter(function (entry) {
    return entry.state === "uncertain" || entry.state === "attention" || (entry.state === "submitting" && !session.isProcessing && !session._queryStarting);
  });
  return { pending: pending.length, attention: attention.map(function (entry) {
    return { updateId: entry.updateId, batchId: entry.batchId || null,
      uncertain: entry.state !== "attention", text: entry.text };
  }) };
}

function hasPendingCoordinatorReports(session) {
  return !!(session && (session.pendingCoordinatorUpdates || []).some(function (entry) {
    return entry.state !== "submitted";
  }));
}

module.exports = { coordinatorUpdateState: coordinatorUpdateState, hasPendingCoordinatorReports: hasPendingCoordinatorReports };
