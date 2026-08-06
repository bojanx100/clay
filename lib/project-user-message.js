var { hasStaleProcessingState } = require("./sessions-queued-messages");
var handoffTraces = require("./coop-handoff-traces");
var gatekeeping = require("./lead-gatekeeping-eval");
var coopProvenance = require("./coop-control-provenance");
var coopChannels = require("./project-coop-channels");
var accessModule = require("./project-user-message-access");
var queueModule = require("./project-user-message-queue");
var handlersModule = require("./project-user-message-handlers");
var contextModule = require("./project-user-message-context");
var coopConversationControlModule = require("./coop-conversation-control");
var coopTopicIndexModule = require("./coop-topic-index");
var projectIdentity = require("./project-identity");

function shouldQueueMessage(session) {
  return !!(session && (session.isProcessing ||
    (Array.isArray(session.pendingUserMessageQueue) && session.pendingUserMessageQueue.length > 0)));
}

function applyCoopChannelScope(session, userText) {
  return coopChannels.applyChannelScope(session, userText);
}

function handoffTraceOwnerId(ws, usersModule) {
  var userId = ws && ws._clayUser && ws._clayUser.id;
  if (typeof userId === "string" && userId.trim()) return userId.trim();
  if (usersModule && usersModule.isMultiUser && usersModule.isMultiUser()) return null;
  return "_single_user";
}

function canCaptureCoopHandoff(session, ws, usersModule, slug, text) {
  return slug === "lead" && coopProvenance.isCanonicalCoopSession(session) &&
    !!handoffTraceOwnerId(ws, usersModule) && gatekeeping.isDirectHandoffAsk(text);
}

function assistantTurnsSince(session, startIndex) {
  var history = session && Array.isArray(session.history) ? session.history : [];
  var assistantActive = false;
  var turns = 0;
  for (var i = startIndex; i < history.length; i++) {
    var item = history[i] || {};
    if (item.type === "user_message") assistantActive = false;
    else if (item.type === "delta" && !assistantActive) {
      assistantActive = true;
      turns++;
    }
  }
  return turns;
}

function observeAssistantTurns(session) {
  var startIndex = Array.isArray(session && session.history) ? session.history.length : 0;
  return function () { return assistantTurnsSince(session, startIndex); };
}

function projectRefAvailable(getProjectList, ref, userId) {
  var normalized = projectIdentity.normalizeProjectRef(ref);
  if (!normalized || typeof getProjectList !== "function") return false;
  var projects = getProjectList(userId) || [];
  for (var i = 0; i < projects.length; i++) {
    if (projects[i] && projects[i].projectId === normalized.projectId) return true;
  }
  return false;
}

function attachUserMessage(ctx) {
  var sm = ctx.sm;
  var coopControl = coopConversationControlModule.attachCoopConversationControl({
    sm: sm,
    sendToSession: ctx.sendToSession,
    onIngressDrained: ctx.onCoopIngressDrained,
    // The work-target resolvers need these. Without them a live publish would
    // report a bare "Working" while a reconnect reported "Working on <topic>".
    coopTopicIndex: ctx.coopTopicIndex || ctx.opts && ctx.opts.coopTopicIndex || null,
    getProjectList: ctx.getProjectList,
    // Admitted portfolio work is a Waiting source too. Reconnect reads it from
    // the full project ctx, so the live path must be given the same store or a
    // reconnect would show Waiting where a live publish showed Idle.
    crossProject: ctx.crossProject || ctx.opts && ctx.opts.crossProject || null,
  });
  var access = accessModule.attachProjectUserMessageAccess(ctx);
  var queue = queueModule.attachProjectUserMessageQueue(Object.assign({}, ctx, {
    coopControl: coopControl,
  }));
  var coopTopicIndex = ctx.coopTopicIndex || ctx.opts && ctx.opts.coopTopicIndex || null;

  function topicIndexFor(session) {
    if (coopTopicIndex) return coopTopicIndex;
    return coopTopicIndexModule.getDefaultTopicIndex();
  }

  function validateCoopTopicIngress(session, msg, ws) {
    var hasTopic = !!(msg && (msg.coopTopicRef || msg.topicRef));
    var hasProject = !!(msg && (msg.coopProjectRef || msg.projectRef));
    var canonicalCoop = !!(session && session.coopHome);
    if (!hasTopic && !hasProject && !canonicalCoop) return { ok: true };
    var index = topicIndexFor(session);
    if (!index) return { ok: false, code: "topic_index_unavailable" };
    var userId = ws && ws._clayUser && ws._clayUser.id || undefined;
    var projects = typeof ctx.getProjectList === "function" ? ctx.getProjectList(userId) : [];
    if (hasTopic || canonicalCoop) {
      var retro = index.ensureRetro(session, {
        projects: projects,
        expectedCanonicalStorageId: ctx.expectedCoopTopicStorageId || ctx.opts && ctx.opts.expectedCoopTopicStorageId || null,
      });
      if (!retro.ok) return retro;
    }
    if (canonicalCoop && !hasTopic) {
      return index.classifyCanonicalIngress(session, msg, {
        projects: projects,
        isProjectAvailable: function (ref) { return projectRefAvailable(ctx.getProjectList, ref, userId); },
      });
    }
    return index.validateIngress(session, msg, {
      isProjectAvailable: function (ref) { return projectRefAvailable(ctx.getProjectList, ref, userId); },
    });
  }
  var handlers = handlersModule.attachProjectUserMessageHandlers({
    cwd: ctx.cwd,
    slug: ctx.slug,
    isMate: ctx.isMate,
    osUsers: ctx.osUsers,
    sm: ctx.sm,
    nm: ctx.nm,
    tm: ctx.tm,
    send: ctx.send,
    sendTo: ctx.sendTo,
    sendToSession: ctx.sendToSession,
    usersModule: ctx.usersModule,
    getOsUserInfoForWs: ctx.getOsUserInfoForWs,
    getLinuxUserForSession: ctx.getLinuxUserForSession,
    saveImageFile: ctx.saveImageFile,
    loadContextSources: ctx.loadContextSources,
    saveContextSources: ctx.saveContextSources,
    browserState: ctx.browserState,
    scheduleMessage: ctx.scheduleMessage,
    cancelScheduledMessage: ctx.cancelScheduledMessage,
    sendScheduledMessageNow: ctx.sendScheduledMessageNow,
    getSessionForMessage: access.getSessionForMessage,
    getSessionForMessageWithoutSwitch: access.getSessionForMessageWithoutSwitch,
    queue: queue,
    hydrateImageRefs: ctx.hydrateImageRefs || function (item) { return item; },
    _loop: ctx._loop,
    coordinateQueuedMessage: ctx.coordinateQueuedMessage,
    closeOrchestrationTask: ctx.closeOrchestrationTask,
    retryOrchestrationReconciliation: ctx.retryOrchestrationReconciliation,
    listAdoptionCoordinators: ctx.listAdoptionCoordinators,
    proposeSessionAdoption: ctx.proposeSessionAdoption,
  });
  var messageContext = contextModule.attachProjectUserMessageContext({
    cwd: ctx.cwd,
    slug: ctx.slug,
    isMate: ctx.isMate,
    osUsers: ctx.osUsers,
    sm: ctx.sm,
    sdk: ctx.sdk,
    adapter: ctx.adapter,
    email: ctx._email,
    tm: ctx.tm,
    browserState: ctx.browserState,
    requestTabContext: ctx.requestTabContext,
    sendTo: ctx.sendTo,
    sendToSession: ctx.sendToSession,
    sendToSessionOthers: ctx.sendToSessionOthers,
    hydrateImageRefs: ctx.hydrateImageRefs || function (item) { return item; },
    saveImageFile: ctx.saveImageFile,
    imagesDir: ctx.imagesDir,
    getLinuxUserForSession: ctx.getLinuxUserForSession,
    ensureProjectAccessForSession: ctx.ensureProjectAccessForSession,
    onProcessingChanged: ctx.onProcessingChanged,
    handleSwitchCommand: ctx.handleSwitchCommand,
    loadContextSources: ctx.loadContextSources,
    getSessionForMessage: access.getSessionForMessage,
    recoverHandoffContextForSend: access.recoverHandoffContextForSend,
    shouldQueueMessage: shouldQueueMessage,
    queue: queue,
    coopControl: coopControl,
    hasStaleProcessingState: hasStaleProcessingState,
    coopHandoffTraceStore: ctx.coopHandoffTraceStore || handoffTraces.createStore(),
    canCaptureCoopHandoff: function (session, ws, text) {
      return canCaptureCoopHandoff(session, ws, ctx.usersModule, ctx.slug, text);
    },
    handoffTraceOwnerId: function (ws) { return handoffTraceOwnerId(ws, ctx.usersModule); },
    observeAssistantTurns: observeAssistantTurns,
    onUserMessageDispatched: ctx.onUserMessageDispatched,
    usersModule: ctx.usersModule,
    isCoopProjectRefAvailable: function (ref, ws) {
      var userId = ws && ws._clayUser && ws._clayUser.id || undefined;
      return projectRefAvailable(ctx.getProjectList, ref, userId);
    },
    validateCoopTopicIngress: validateCoopTopicIngress,
  });

  function handleUserMessage(ws, msg) {
    if (handlers.handleAuxiliaryMessage(ws, msg)) return true;
    return messageContext.handleUserMessage(ws, msg);
  }

  function reconcileQueuedUserMessages(session) {
    if (queue.rebuildCoopIngressFromHistory(session)) sm.saveSessionFile(session);
    if (queue.flushCoopIngress(session)) return true;
    if (!session || !Array.isArray(session.pendingUserMessageQueue) ||
        session.pendingUserMessageQueue.length === 0) return false;
    return queue.scheduleQueuedUserMessageFlush(session);
  }

  setImmediate(function () {
    if (!sm || !sm.sessions || typeof sm.sessions.forEach !== "function") return;
    sm.sessions.forEach(function (session) {
      reconcileQueuedUserMessages(session);
    });
  });

  return {
    handleUserMessage: handleUserMessage,
    flushQueuedUserMessage: queue.flushQueuedUserMessage,
    scheduleQueuedUserMessageFlush: queue.scheduleQueuedUserMessageFlush,
    reconcileQueuedUserMessages: reconcileQueuedUserMessages,
    coopConversationState: function (session) { return coopControl.clientState(session); },
    syncNotesKnowledge: handlers.syncNotesKnowledge,
  };
}

module.exports = {
  attachUserMessage: attachUserMessage,
  shouldQueueMessage: shouldQueueMessage,
  applyCoopChannelScope: applyCoopChannelScope,
  canAccessCoopChannel: accessModule.canAccessCoopChannel,
  handoffTraceOwnerId: handoffTraceOwnerId,
  canCaptureCoopHandoff: canCaptureCoopHandoff,
  assistantTurnsSince: assistantTurnsSince,
  observeAssistantTurns: observeAssistantTurns,
  projectRefAvailable: projectRefAvailable,
};
