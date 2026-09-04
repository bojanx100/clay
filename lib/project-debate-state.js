// Pure debate-state constructors shared by the live and recovery paths.
// Keeping these defaults in one place makes state restoration explicit without
// changing the public attachDebate API.

function createDebateState(options) {
  var debate = {
    phase: options.phase,
    topic: options.topic,
    format: options.format || "free_discussion",
    context: options.context || "",
    specialRequests: options.specialRequests || null,
    moderatorId: options.moderatorId,
    panelists: options.panelists || [],
    mateCtx: options.mateCtx,
    moderatorSession: null,
    panelistSessions: {},
    nameMap: options.nameMap || null,
    turnInProgress: false,
    pendingComment: null,
    round: options.round || 1,
    history: options.history || [],
    setupSessionId: options.setupSessionId || null,
    debateId: options.debateId || null,
    briefPath: options.briefPath || null,
    ownerId: options.ownerId || null,
  };

  if (options.setupStartedAt) debate.setupStartedAt = options.setupStartedAt;
  if (options.awaitingConcludeConfirm) debate.awaitingConcludeConfirm = true;
  if (options.awaitingUserFloor) debate.awaitingUserFloor = true;
  return debate;
}

function panelistsFromBrief(panelists) {
  return (panelists || []).map(function (panelist) {
    return {
      mateId: panelist.mateId,
      role: panelist.role || "",
      brief: panelist.brief || "",
    };
  });
}

function panelistsFromStart(panelists) {
  return panelists.map(function (panelist) {
    return {
      mateId: panelist.mateId,
      role: panelist.role || "",
      brief: panelist.brief || "",
    };
  });
}

module.exports = {
  createDebateState: createDebateState,
  panelistsFromBrief: panelistsFromBrief,
  panelistsFromStart: panelistsFromStart,
};
