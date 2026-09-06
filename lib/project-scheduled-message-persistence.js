// sendAndRecord retains failed assistant output for repair. A scheduler must
// instead withdraw its own unsaved queue entry, or recovery can execute it.
function recordScheduledMessage(manager, session, entry) {
  try { if (manager.sendAndRecord(session, entry) !== false) return true; }
  catch (error) {}
  var history = session.history;
  var index = Array.isArray(history) ? history.indexOf(entry) : -1;
  if (index !== -1) history.splice(index, 1);
  session._historyNeedsRewrite = true;
  return false;
}

module.exports = { recordScheduledMessage: recordScheduledMessage };
