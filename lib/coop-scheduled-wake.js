var proactive = require("./coop-proactive-review");

function copy(target, source) {
  if (!source || source.coopLeadWake !== true) return target;
  target.coopLeadWake = true;
  var agenda = proactive.normalize(source.coopProactiveReview);
  if (agenda) target.coopProactiveReview = agenda;
  return target;
}

function prompt(entry) {
  return entry && entry.coopLeadWake === true ? proactive.promptFor(entry.coopProactiveReview) : null;
}

function shouldCancel(session, entry, leadEnabled, manager) {
  if (!entry || entry.coopLeadWake !== true) return false;
  try { if (entry.coopProactiveReview && !proactive.isCurrent(entry.coopProactiveReview, manager)) return true; }
  catch (error) { return true; }
  return !session.coopHome || !leadEnabled || session.destroying || session._deleted ||
    (session.pendingCoopIngress || []).length > 0 ||
    !!(session.coopConversationIngress && session.coopConversationIngress.activeIngressId);
}

module.exports = { copy: copy, prompt: prompt, shouldCancel: shouldCancel };
