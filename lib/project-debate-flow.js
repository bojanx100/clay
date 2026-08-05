// Pure decisions used by the Debate Workflow v2 lifecycle.

function isActiveDebatePhase(phase) {
  return phase === "preparing" || phase === "reviewing" || phase === "live";
}

function normalizePanelists(panelists, resolveMateId, onUnknown) {
  var resolved = [];
  for (var i = 0; i < (panelists || []).length; i++) {
    var panelist = panelists[i];
    var mateId = resolveMateId(panelist && panelist.mateId);
    if (!mateId) {
      if (onUnknown) onUnknown(panelist && panelist.mateId);
      continue;
    }
    resolved.push({
      mateId: mateId,
      role: (panelist && panelist.role) || "",
      brief: (panelist && panelist.brief) || "",
    });
  }
  return resolved;
}

function resolveParticipants(moderatorId, panelists, resolveMateId, onUnknown) {
  var resolvedModerator = resolveMateId(moderatorId);
  if (!resolvedModerator) {
    return { ok: false, reason: "moderator" };
  }
  var resolvedPanelists = normalizePanelists(panelists, resolveMateId, onUnknown);
  if (!resolvedPanelists.length) {
    return { ok: false, reason: "panelists" };
  }
  return {
    ok: true,
    moderatorId: resolvedModerator,
    panelists: resolvedPanelists,
  };
}

function scanDebateHistory(history) {
  var startEntry = null;
  var endEntry = null;
  var concludeEntry = null;
  var lastRound = 1;
  var turns = [];
  for (var i = 0; i < history.length; i++) {
    var entry = history[i];
    if (entry.type === "debate_started") startEntry = entry;
    if (entry.type === "debate_ended") endEntry = entry;
    if (entry.type === "debate_conclude_confirm") concludeEntry = entry;
    if (entry.type === "debate_turn_done" && entry.round) lastRound = entry.round;
    if (entry.type === "debate_turn_done") turns.push(entry);
  }
  return {
    startEntry: startEntry,
    endEntry: endEntry,
    concludeEntry: concludeEntry,
    lastRound: lastRound,
    turns: turns,
  };
}

function toDebateHistory(turns) {
  return turns.map(function (entry) {
    return {
      speaker: entry.role === "moderator" ? "moderator" : "panelist",
      mateId: entry.mateId,
      mateName: entry.mateName,
      role: entry.role || "",
      text: entry.text || "",
    };
  });
}

function inferAwaitingConcludeConfirm(debate, history, detectMentions) {
  if (debate.awaitingConcludeConfirm || debate.phase !== "live") return false;
  var hasEnded = false;
  var hasConclude = false;
  var lastModeratorText = null;
  for (var i = 0; i < history.length; i++) {
    var entry = history[i];
    if (entry.type === "debate_ended") hasEnded = true;
    if (entry.type === "debate_conclude_confirm") hasConclude = true;
    if (entry.type === "debate_turn_done" && entry.role === "moderator") {
      lastModeratorText = entry.text || "";
    }
  }
  if (hasConclude && !hasEnded) return true;
  if (!hasEnded && !hasConclude && lastModeratorText !== null) {
    return detectMentions(lastModeratorText, debate.nameMap).length === 0;
  }
  return false;
}

function inferRebuiltConcludeConfirm(debate, history, detectMentions) {
  if (debate.awaitingConcludeConfirm || debate.history.length === 0) return false;
  var lastTurn = debate.history[debate.history.length - 1];
  if (lastTurn.speaker !== "moderator" || !lastTurn.text) return false;
  return detectMentions(lastTurn.text, debate.nameMap).length === 0;
}

function getPauseTransition(paused, pendingAdvance) {
  if (!paused && pendingAdvance) {
    return { action: "resume", paused: false, holding: false };
  }
  return { action: "ack", paused: paused, holding: !!(paused && pendingAdvance) };
}

function getConcludeResponse(debate, msg) {
  if (!msg || (msg.action !== "end" && msg.action !== "continue")) return { ok: false };
  var isLiveConfirm = debate.phase === "live" && debate.awaitingConcludeConfirm;
  var isResume = debate.phase === "ended" && msg.action === "continue";
  if (!isLiveConfirm && !isResume) return { ok: false };
  return { ok: true, action: msg.action, wasEnded: debate.phase === "ended" };
}

function buildResumePrompt(instruction, panelistList) {
  if (instruction) {
    return "[SYSTEM: The audience has requested the debate continue with new direction. You MUST call on a panelist to continue. Available panelists: " + panelistList + "]\n\nUser direction: " + instruction + "\n\n[Acknowledge this input briefly, then call on a panelist by writing their @Name to continue the discussion on this new direction. You must @mention exactly one panelist.]";
  }
  return "[SYSTEM: The audience has requested the debate continue. You MUST call on the next panelist. Available panelists: " + panelistList + "]\n\n[Call on a panelist by writing their @Name to explore additional perspectives. You must @mention exactly one panelist.]";
}

function buildPanelistContinuation(history, mateId, moderatorText) {
  var recentHistory = "";
  var lastPanelistIdx = -1;
  for (var i = history.length - 1; i >= 0; i--) {
    if (history[i].mateId === mateId) {
      lastPanelistIdx = i;
      break;
    }
  }
  if (lastPanelistIdx >= 0 && lastPanelistIdx < history.length - 1) {
    recentHistory = "\n\n[Debate turns since your last response:]\n---\n";
    for (var j = lastPanelistIdx + 1; j < history.length; j++) {
      var entry = history[j];
      recentHistory += entry.mateName + " (" + (entry.speaker === "moderator" ? "moderator" : entry.role || entry.speaker) + "): " + entry.text.substring(0, 500) + "\n\n";
    }
    recentHistory += "---";
  }
  return recentHistory + "\n\n[The moderator is now addressing you. Please respond.]\n\nModerator said:\n" + moderatorText;
}

function buildDebateHistoryContext(history) {
  if (!history.length) return "";
  var context = "\n\n[Debate so far:]\n---\n";
  for (var i = 0; i < history.length; i++) {
    var entry = history[i];
    context += entry.mateName + " (" + (entry.speaker === "moderator" ? "moderator" : entry.role || entry.speaker) + "): " + entry.text.substring(0, 500) + "\n\n";
  }
  return context + "---";
}

function buildResumeHistoryContext(history) {
  var context = "\n\nIMPORTANT: This debate was previously paused and is now being RESUMED. You must continue the debate by calling on a panelist with @TheirName. Do NOT conclude or summarize.\n";
  context += "\nDebate history so far:\n---\n";
  for (var i = 0; i < history.length; i++) {
    var entry = history[i];
    context += (entry.mateName || entry.speaker || "Unknown") + " (" + (entry.role || "") + "): " + (entry.text || "").slice(0, 500) + "\n\n";
  }
  return context + "---\n";
}

module.exports = {
  isActiveDebatePhase: isActiveDebatePhase,
  normalizePanelists: normalizePanelists,
  resolveParticipants: resolveParticipants,
  scanDebateHistory: scanDebateHistory,
  toDebateHistory: toDebateHistory,
  inferAwaitingConcludeConfirm: inferAwaitingConcludeConfirm,
  inferRebuiltConcludeConfirm: inferRebuiltConcludeConfirm,
  getPauseTransition: getPauseTransition,
  getConcludeResponse: getConcludeResponse,
  buildResumePrompt: buildResumePrompt,
  buildPanelistContinuation: buildPanelistContinuation,
  buildDebateHistoryContext: buildDebateHistoryContext,
  buildResumeHistoryContext: buildResumeHistoryContext,
};
