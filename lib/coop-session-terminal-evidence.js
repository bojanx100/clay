// Adds verification to a session-ledger terminal outcome without changing the
// lifecycle state machine. Owner Work can therefore require proof for Done
// while lifecycle remains the single source for terminal status.

function text(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, 1000);
}

function withVerification(outcome, completion, task) {
  if (!outcome) return null;
  var verification = text(completion && completion.verification || task && task.verification);
  if (!verification) return outcome;
  return Object.assign({}, outcome, { verification: verification });
}

module.exports = { withVerification: withVerification };
