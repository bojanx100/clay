// Explicit owner wording that authorizes implementation work.
//
// This stays separate from Thread lifecycle storage so ingress can recognize
// a narrow request to create a project-bound implementation Thread without
// widening general conversational classification.

function cleanProjectName(value) {
  var result = String(value || "").replace(/[.!?,;:]+$/g, "").trim();
  result = result.replace(/^the\s+/i, "").replace(/\s+project$/i, "").trim();
  return result.slice(0, 120);
}

function cleanTopicText(value) {
  var result = String(value || "").replace(/[.!?,;:]+$/g, "").trim();
  return result.replace(/^the\s+/i, "").slice(0, 160);
}

function finalParagraph(value) {
  var paragraphs = String(value || "").split(/\n\s*\n/);
  return String(paragraphs[paragraphs.length - 1] || "").replace(/\s+/g, " ").trim();
}

function implementationThreadStartDecision(value) {
  var command = finalParagraph(value);
  command = command.replace(/^ok(?:ay)?[,.!…]*\s+/i, "");
  var requestPrefix = /^(?:(?:please|kindly)\s+|(?:can|con|could|would|will)\s+you\s+(?:please\s+)?|i\s+want\s+you\s+to\s+|we\s+need\s+to\s+|go\s+ahead\s+and\s+|let['’]s\s+)?/i;
  command = command.replace(requestPrefix, "");
  var start = command.match(/^(?:start|create)\s+(?:a|an|the)\s+(.+?)\s+implementation\s+thread(?:\s+for\s+(.+?))?\s*[.!?…]*$/i);
  if (!start) return null;
  var projectName = cleanProjectName(start[1]);
  var topicText = cleanTopicText(start[2]) || (projectName + " implementation Thread");
  return projectName ? {
    intent: "implement",
    projectName: projectName,
    topicText: topicText,
  } : null;
}

function compoundImplementationDecision(imperative) {
  var compound = imperative.match(/^(.+?)(?:,\s*)?\band\s+(build|fix|implement|ship|deploy|code)\s+(?:this|it|that)(?:\s+(?:in|for)\s+(.+?))?\s*[.!?…]*$/i);
  if (!compound) return null;
  var prelude = compound[1].trim();
  if (!prelude || /^(?:discuss|consider|explore|explain|review|tell|show|describe|ask|wonder|question|debate|think)\b/i.test(prelude)) {
    return null;
  }
  if (/^(?:if|when|unless|should|could|would|can|will|may|might|is|are|do|does|did|don['’]t|never|what|why|how|whether|i\b)/i.test(prelude) ||
      /\b(?:whether|maybe|perhaps|might|should|could|would)\b/i.test(prelude)) {
    return null;
  }
  return { intent: compound[2].toLowerCase(),
    projectName: cleanProjectName(compound[3]) };
}

function explicitImplementationDecision(text) {
  var threadStart = implementationThreadStartDecision(text);
  if (threadStart) {
    return { intent: threadStart.intent, projectName: threadStart.projectName };
  }
  var value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  value = value.replace(/^ok(?:ay)?[,.!…]*\s+/i, "");
  if (/^(?:yes[, ]+)?(?:do it|go ahead|ship it)(?:\s+now)?[.!]?$/i.test(value)) {
    return { intent: "implement", projectName: "" };
  }
  // "con you" is the exact voice-transcription shape from owner ingress 509.
  // Treat only that request prefix as "can you"; no other fuzzy spelling is
  // admitted, and the remaining imperative still has to open with a known
  // implementation verb below.
  var requestPrefix = /^(?:(?:please|kindly)\s+|(?:can|con|could|would|will)\s+you\s+(?:please\s+)?|i\s+want\s+you\s+to\s+|we\s+need\s+to\s+|go\s+ahead\s+and\s+|let['’]s\s+)?/i;
  var imperative = value.replace(requestPrefix, "");
  var compound = compoundImplementationDecision(imperative);
  if (compound) return compound;
  if (/^hand\s+(?:this|it|that)\s+off\s*[.!]?$/i.test(imperative)) {
    return { intent: "hand_off", projectName: "" };
  }
  var handoff = imperative.match(/^hand\s+(?:this|it|that)\s+to\s+(.+?)\s*[.!]?$/i);
  if (handoff) {
    var handoffProject = cleanProjectName(handoff[1]);
    return handoffProject ? { intent: "hand_off", projectName: handoffProject } : null;
  }
  var setDecision = imperative.match(/^set\s+(?:this|it|that)\s+to\s+(build|fix|implement|ship|deploy|code)(?:\s+(?:in|for)\s+(.+?))?\s*[.!…]*$/i);
  if (setDecision) {
    return { intent: setDecision[1].toLowerCase(), projectName: cleanProjectName(setDecision[2]) };
  }
  var action = imperative.match(/^(build|fix|implement|ship|deploy|code)\b/i);
  if (!action) return null;
  var remainder = imperative.slice(action.index + action[0].length).trim();
  if (/^(?:is|was|will|has|had|looks|seems)\b/i.test(remainder)) return null;
  var project = remainder.match(/\b(?:in|for|to)\s+(.+?)\s*$/i);
  return { intent: action[1].toLowerCase(), projectName: cleanProjectName(project && project[1]) };
}

module.exports = {
  cleanProjectName: cleanProjectName,
  cleanTopicText: cleanTopicText,
  explicitImplementationDecision: explicitImplementationDecision,
  implementationThreadStartDecision: implementationThreadStartDecision,
};
