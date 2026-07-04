var matesModule = require("./mates");
var sessionSearch = require("./session-search");
var usersModule = require("./users");
var { attachDebate } = require("./project-debate");
var { attachMemory } = require("./project-memory");
var { attachMateInteraction } = require("./project-mate-interaction");
var { attachUserMention } = require("./project-user-mention");

function attachProjectInteractions(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var sm = ctx.sm;
  var sdk = ctx.sdk;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToSession = ctx.sendToSession;
  var sendToSessionOthers = ctx.sendToSessionOthers;
  var isMate = !!ctx.isMate;
  var projectOwnerId = ctx.projectOwnerId || null;
  var getProjectOwnerId = ctx.getProjectOwnerId || function () { return projectOwnerId; };
  var getSessionForWs = ctx.getSessionForWs;
  var getLinuxUserForSession = ctx.getLinuxUserForSession;
  var saveImageFile = ctx.saveImageFile;
  var hydrateImageRefs = ctx.hydrateImageRefs;
  var onProcessingChanged = ctx.onProcessingChanged || function () {};
  var getAllProjectSessions = ctx.getAllProjectSessions || function () { return []; };
  var handleMessage = ctx.handleMessage;
  var getNotificationsModule = ctx.getNotificationsModule || function () { return null; };
  var getProjectTitle = ctx.getProjectTitle || function () { return slug; };
  var isUserOnline = ctx.isUserOnline || function () { return false; };
  var pushModule = ctx.pushModule || null;
  var checkForDmDebateBrief = null;

  var memory = attachMemory({
    cwd: cwd,
    sm: sm,
    sdk: sdk,
    sendTo: sendTo,
    matesModule: matesModule,
    sessionSearch: sessionSearch,
    getAllProjectSessions: getAllProjectSessions,
    projectOwnerId: projectOwnerId,
    handleMessage: handleMessage,
  });

  var mateInteraction = attachMateInteraction({
    cwd: cwd,
    slug: slug,
    sm: sm,
    sdk: sdk,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    matesModule: matesModule,
    isMate: isMate,
    projectOwnerId: projectOwnerId,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    saveImageFile: saveImageFile,
    hydrateImageRefs: hydrateImageRefs,
    onProcessingChanged: onProcessingChanged,
    loadMateDigests: memory.loadMateDigests,
    updateMemorySummary: memory.updateMemorySummary,
    initMemorySummary: memory.initMemorySummary,
    getNotificationsModule: getNotificationsModule,
    get checkForDmDebateBrief() { return checkForDmDebateBrief; },
  });

  var userMention = attachUserMention({
    slug: slug,
    sm: sm,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sendToSessionOthers: sendToSessionOthers,
    getSessionForWs: getSessionForWs,
    getLinuxUserForSession: getLinuxUserForSession,
    saveImageFile: saveImageFile,
    hydrateImageRefs: hydrateImageRefs,
    usersModule: usersModule,
    pushModule: pushModule,
    isUserOnline: isUserOnline,
    getNotificationsModule: getNotificationsModule,
    getProjectTitle: getProjectTitle,
  });

  var debate = attachDebate({
    cwd: cwd,
    slug: slug,
    isMate: isMate,
    projectOwnerId: projectOwnerId,
    send: send,
    sendTo: sendTo,
    sendToSession: sendToSession,
    sm: sm,
    sdk: sdk,
    getMateProfile: mateInteraction.getMateProfile,
    loadMateClaudeMd: mateInteraction.loadMateClaudeMd,
    loadMateDigests: memory.loadMateDigests,
    hydrateImageRefs: hydrateImageRefs,
    onProcessingChanged: onProcessingChanged,
    getLinuxUserForSession: getLinuxUserForSession,
    getSessionForWs: getSessionForWs,
    updateMemorySummary: memory.updateMemorySummary,
    initMemorySummary: memory.initMemorySummary,
  });
  checkForDmDebateBrief = debate.checkForDmDebateBrief;

  return {
    memory: memory,
    loadMateDigests: memory.loadMateDigests,
    gateMemory: memory.gateMemory,
    updateMemorySummary: memory.updateMemorySummary,
    initMemorySummary: memory.initMemorySummary,
    handleMention: mateInteraction.handleMention,
    getMateProfile: mateInteraction.getMateProfile,
    loadMateClaudeMd: mateInteraction.loadMateClaudeMd,
    digestDmTurn: mateInteraction.digestDmTurn,
    enqueueDigest: mateInteraction.enqueueDigest,
    handleUserMention: userMention.handleUserMention,
    debate: debate,
    handleDebateStart: debate.handleDebateStart,
    handleDebateHandRaise: debate.handleDebateHandRaise,
    handleDebateComment: debate.handleDebateComment,
    handleDebateStop: debate.handleDebateStop,
    handleDebateConcludeResponse: debate.handleDebateConcludeResponse,
    handleDebateConfirmBrief: debate.handleDebateConfirmBrief,
    handleDebateUserFloorResponse: debate.handleDebateUserFloorResponse,
    restoreDebateState: debate.restoreDebateState,
    checkForDmDebateBrief: debate.checkForDmDebateBrief,
    handleMcpDebateApproval: debate.handleMcpDebateApproval,
  };
}

module.exports = {
  attachProjectInteractions: attachProjectInteractions,
};
