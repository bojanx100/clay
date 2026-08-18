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
var replyAnchorModule = require("./coop-topic-reply-anchor");
var threadIntent = require("./coop-thread-intent");
var threadLifecycle = require("./coop-thread-lifecycle");
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

function normalizedProjectName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function projectRefForImplementationThreadStart(projects, projectName) {
  var wanted = normalizedProjectName(projectName);
  var matches = [];
  var list = Array.isArray(projects) ? projects : [];
  if (!wanted) return null;
  for (var i = 0; i < list.length; i++) {
    var item = list[i];
    var status = item && typeof item.getStatus === "function" ? item.getStatus() : item || {};
    var ref = projectIdentity.projectRef(item && item.projectId || status.projectId);
    if (!ref) continue;
    var slug = normalizedProjectName(status.slug || item && item.slug);
    var title = normalizedProjectName(status.title || item && item.title);
    if (wanted !== slug && wanted !== title) continue;
    if (!matches.some(function (candidate) { return candidate.projectId === ref.projectId; })) {
      matches.push(ref);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function validateCoopTopicIngress(ctx, session, msg, ws) {
  var hasTopic = !!(msg && (msg.coopTopicRef || msg.topicRef));
  var hasProject = !!(msg && (msg.coopProjectRef || msg.projectRef));
  var canonicalCoop = !!(session && session.coopHome);
  var mainScope = canonicalCoop && msg &&
    (msg.coopComposerScope === "main" || msg.coopComposerScope === "canonical");
  var contextualThreadTarget = mainScope && msg && msg.coopContextualThreadTarget === true;
  var userId = ws && ws._clayUser && ws._clayUser.id || undefined;
  var projects = typeof ctx.getProjectList === "function" ? ctx.getProjectList(userId) : [];
  // Main stays route-free except for either a server-proven contextual target
  // or a narrow owner command that explicitly creates a project implementation
  // Thread. The contextual marker was minted after canonical evidence resolved
  // one open Thread; normalizeComposerScope deletes any client-supplied copy.
  // The creation command names its project, so neither path revives stale refs.
  if (mainScope && !contextualThreadTarget) {
    var start = threadLifecycle.implementationThreadStartDecision(msg.text);
    if (!start) return { ok: true, topicRef: null, projectRef: null, classification: "conversational" };
    var projectRef = projectRefForImplementationThreadStart(projects, start.projectName);
    if (!projectRef) return { ok: false, code: "project_target_unavailable" };
    msg.coopProjectRef = projectRef;
    hasProject = true;
  }
  if (!hasTopic && !hasProject && !canonicalCoop) return { ok: true };
  var index = ctx.topicIndexFor(session);
  if (!index) return { ok: false, code: "topic_index_unavailable" };
  if (hasTopic || canonicalCoop) {
    var retro = index.ensureRetro(session, {
      projects: projects,
      expectedCanonicalStorageId: ctx.expectedCoopTopicStorageId || ctx.opts && ctx.opts.expectedCoopTopicStorageId || null,
    });
    if (!retro.ok) return retro;
    // Reconcile anchor proof on genuine owner traffic only -- not on every
    // connection/select, which would surprise-mutate topics minted between
    // reconciliation passes as a side effect of an otherwise read path.
    if (canonicalCoop && typeof index.reconcileTopicAnchors === "function") {
      index.reconcileTopicAnchors(session);
      // Same trigger, same session, and deliberately after anchors are
      // proven: retitle pre-classifier-fix automatic topics from their own
      // proven owner turns and fold genuinely low-information fragments into
      // the catch-all. Idempotent and sticky per topic (titleRetrofitAudit),
      // so after the first pass this is a cheap no-op.
      if (typeof index.retrofitTopicTitles === "function") {
        index.retrofitTopicTitles(session);
      }
    }
  }
  if (canonicalCoop && !hasTopic) {
    // Use the explicit subject as the Thread title/classification input. The
    // original owner message remains byte-for-byte canonical; this avoids a
    // preceding conversational paragraph weakening a precise final command.
    var classificationMessage = mainScope && start && start.topicText ?
      Object.assign({}, msg, { text: start.topicText }) : msg;
    return index.classifyCanonicalIngress(session, classificationMessage, {
      projects: projects,
      recordExplicitRoute: mainScope && !!start,
      isProjectAvailable: function (ref) { return projectRefAvailable(ctx.getProjectList, ref, userId); },
    });
  }
  return replyAnchorModule.replyAnchorForRoute(index, session, index.validateIngress(session, msg, {
    includeClosedTopics: !!(msg && msg.coopIncludeClosedThread),
    isProjectAvailable: function (ref) { return projectRefAvailable(ctx.getProjectList, ref, userId); },
  }));
}

function attachUserMessage(ctx) {
  var sm = ctx.sm;
  // The durable owner-request ledger, resolved once for every seam that writes
  // to it. Injected by the daemon; absent in unit tests that drive the ingress
  // pipeline directly, which is exactly the point -- no injection, no write.
  var coopOwnerRequests = ctx.coopOwnerRequests || ctx.opts && ctx.opts.coopOwnerRequests || null;
  var coopControl = coopConversationControlModule.attachCoopConversationControl({
    coopOwnerRequests: coopOwnerRequests,
    sm: sm,
    clients: ctx.clients,
    sendTo: ctx.sendTo,
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

  // Claims the canonical event just appended for the topic it was sent from.
  // The rule itself lives in coop-topic-reply-anchor so the ingress seam and
  // its tests exercise one implementation rather than two that can drift.
  function bindCoopTopicMessage(session, msg, eventIndex) {
    return replyAnchorModule.bindTopicMembership(topicIndexFor(session), session, msg, eventIndex);
  }

  function applyCoopThreadIntent(session, ws, msg) {
    var intent = msg && msg.coopThreadIntent;
    if (!threadIntent.isActionable(intent) || !msg.coopThreadRef) return null;
    if (typeof ctx.isCoopTopicOwner === "function" && !ctx.isCoopTopicOwner(ws)) {
      return { ok: false, code: "access_denied" };
    }
    var result = threadIntent.apply(topicIndexFor(session), msg.coopThreadRef, intent, {
      requestId: msg.clientMessageId ? "thread-control:" + String(msg.clientMessageId) : "",
      text: msg.text,
    });
    if (result && result.ok && result.decision) msg.coopImplementationDecision = result.decision;
    msg.coopThreadControlResult = result;
    return result;
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
    coopOwnerRequests: coopOwnerRequests,
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
    validateCoopTopicIngress: function (session, msg, ws) {
      return validateCoopTopicIngress(Object.assign({}, ctx, {
        topicIndexFor: topicIndexFor,
      }), session, msg, ws);
    },
    resolveCoopThreadIntentTarget: function (session, evidence) {
      return threadIntent.resolveDominantTarget(topicIndexFor(session), session, evidence);
    },
    bindCoopTopicMessage: bindCoopTopicMessage,
    applyCoopThreadIntent: applyCoopThreadIntent,
  });

  function handleUserMessage(ws, msg) {
    if (handlers.handleAuxiliaryMessage(ws, msg)) return true;
    return messageContext.handleUserMessage(ws, msg);
  }

  // The owner-facing turn finished. Record the answer BEFORE the ingress lane
  // drains: markIdle clears activeIngressId, so after the drain there is no
  // longer anything to attribute the answer to.
  function handleCoopTurnDone(session) {
    return coopControl.markAnswered(session);
  }

  function resumeCoopIngress(session, ingressId) {
    return coopControl.resumeIngress(session, ingressId);
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
    handleCoopTurnDone: handleCoopTurnDone,
    resumeCoopIngress: resumeCoopIngress,
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
  projectRefForImplementationThreadStart: projectRefForImplementationThreadStart,
  validateCoopTopicIngress: validateCoopTopicIngress,
};
