var fs = require("fs");
var path = require("path");
var hasOwn = Object.prototype.hasOwnProperty;
var coopTopicIngress = require("./coop-topic-ingress");
var disconnectBrowserExtension =
  require("./project-browser-extension").disconnectBrowserExtension;

function syncNotesKnowledge(ctx) {
  if (!ctx.isMate) return;
  try {
    var knowledgeDir = path.join(ctx.cwd, "knowledge");
    var knowledgeFile = path.join(knowledgeDir, "sticky-notes.md");
    var text = ctx.nm.getActiveNotesText();
    if (text) {
      fs.mkdirSync(knowledgeDir, { recursive: true });
      fs.writeFileSync(knowledgeFile, text);
    } else {
      try { fs.unlinkSync(knowledgeFile); } catch (e) {}
    }
  } catch (e) {
    console.error("[project] Failed to sync sticky-notes.md:", e.message);
  }
}

function clearBrowserTabs(browserState) {
  var tabs = browserState._browserTabList || (browserState._browserTabList = {});
  Object.keys(tabs).forEach(function (tabId) { delete tabs[tabId]; });
}

function handlePromote(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  if (!session || session.orchestrationParent) return true;
  session.coordinationMode = true;
  ctx.sm.saveSessionFile(session);
  ctx.sm.broadcastSessionList();
  ctx.sendToSession(session.localId, { type: "coordinator_status", coordinationMode: true });
  return true;
}

function handleNoteCreate(ctx, ws, msg) {
  var note = ctx.nm.create(msg);
  if (note) {
    ctx.send({ type: "note_created", note: note });
    ctx.syncNotesKnowledge();
  }
  return true;
}

function handleNoteUpdate(ctx, ws, msg) {
  if (!msg.id) return true;
  var note = ctx.nm.update(msg.id, msg);
  if (note) {
    ctx.send({ type: "note_updated", note: note });
    if (msg.text !== undefined || msg.hidden !== undefined) ctx.syncNotesKnowledge();
  }
  return true;
}

function handleNoteDelete(ctx, ws, msg) {
  if (!msg.id) return true;
  if (ctx.nm.remove(msg.id)) {
    ctx.send({ type: "note_deleted", id: msg.id });
    ctx.syncNotesKnowledge();
  }
  return true;
}

function handleNoteList(ctx, ws) {
  ctx.sendTo(ws, { type: "notes_list", notes: ctx.nm.list() });
  return true;
}

function handleNoteBringFront(ctx, ws, msg) {
  if (!msg.id) return true;
  var note = ctx.nm.bringToFront(msg.id);
  if (note) ctx.send({ type: "note_updated", note: note });
  return true;
}

function hasTerminalPermission(ctx, ws) {
  if (!ws._clayUser) return true;
  var permissions = ctx.usersModule.getEffectivePermissions(ws._clayUser, ctx.osUsers);
  return !!permissions.terminal;
}

function handleTermCreate(ctx, ws, msg) {
  if (!hasTerminalPermission(ctx, ws)) {
    ctx.sendTo(ws, { type: "term_error", error: "Terminal access is not permitted" });
    return true;
  }
  var terminalOpts = { sessionId: ws._clayActiveSession || null };
  if (msg.initialCommand) terminalOpts.initialInput = String(msg.initialCommand);
  var terminal = ctx.tm.create(
    msg.cols || 80, msg.rows || 24, ctx.getOsUserInfoForWs(ws), ws, terminalOpts);
  if (!terminal) {
    ctx.sendTo(ws, { type: "term_error", error: "Cannot create terminal (node-pty not available or limit reached)" });
    return true;
  }
  ctx.tm.attach(terminal.id, ws);
  ctx.send({ type: "term_list", terminals: ctx.tm.list() });
  ctx.sendTo(ws, { type: "term_created", id: terminal.id });
  return true;
}

function handleTermClose(ctx, ws, msg) {
  if (!msg.id) return true;
  ctx.tm.close(msg.id);
  ctx.send({ type: "term_list", terminals: ctx.tm.list() });
  var sessionId = ws._clayActiveSession || null;
  var active = ctx.loadContextSources(ctx.slug, sessionId);
  var termKey = "term:" + msg.id;
  var filtered = active.filter(function (id) { return id !== termKey; });
  if (filtered.length !== active.length) {
    ctx.saveContextSources(ctx.slug, sessionId, filtered);
    ctx.sendToSession(sessionId, { type: "context_sources_state", active: filtered });
  }
  return true;
}

function handleTermRename(ctx, ws, msg) {
  if (msg.id && msg.title) {
    ctx.tm.rename(msg.id, msg.title);
    ctx.send({ type: "term_list", terminals: ctx.tm.list() });
  }
  return true;
}

function handleContextSourcesSave(ctx, ws, msg) {
  var sessionId = ws._clayActiveSession || null;
  ctx.saveContextSources(ctx.slug, sessionId, msg.active || []);
  return true;
}

function handleBrowserTabList(ctx, ws, msg) {
  var browserState = ctx.browserState;
  if (msg.connected === false) {
    disconnectBrowserExtension(browserState, ws, "content_bridge", msg.disconnectReason);
    return true;
  }
  var wasConnected = browserState._extensionWs &&
    browserState._extensionWs.readyState === 1;
  browserState._extensionWs = ws;
  if (msg.extensionId) browserState._extensionId = msg.extensionId;
  clearBrowserTabs(browserState);
  var tabs = msg.tabs || [];
  for (var i = 0; i < tabs.length; i++) browserState._browserTabList[tabs[i].id] = tabs[i];
  if (!wasConnected) {
    console.log("[browser-extension] state=connected tabs=" + tabs.length +
      " extensionId=" + String(msg.extensionId || "unknown").slice(0, 80));
  }
  return true;
}

function handleExtensionResult(ctx, ws, msg) {
  var pendingRequests = ctx.browserState.pendingExtensionRequests || {};
  ctx.browserState.pendingExtensionRequests = pendingRequests;
  var pending = pendingRequests[msg.requestId];
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve(msg.result);
    delete pendingRequests[msg.requestId];
  }
  return true;
}

function handleScheduleMessage(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  if (!session || (!msg.text && (!msg.images || msg.images.length === 0)) || !msg.resetsAt) return true;
  var scope = coopTopicIngress.normalizeComposerScope(msg, session);
  if (!scope.ok) {
    ctx.sendTo(ws, { type: "error", text: "The Coop composer scope is unavailable. Reload the conversation before scheduling." });
    return true;
  }
  var imageRefs = [];
  var images = msg.images || [];
  for (var i = 0; i < images.length; i++) {
    var image = images[i];
    var savedName = ctx.saveImageFile(
      image.mediaType, image.data, ctx.getLinuxUserForSession(session));
    if (savedName) imageRefs.push({ mediaType: image.mediaType, file: savedName });
  }
  var options = { imageRefs: imageRefs };
  if (session.coopHome && scope.scope) {
    options.coopRouting = {
      scope: scope.scope,
      topicRef: msg.coopTopicRef || null,
      projectRef: msg.coopProjectRef || null,
    };
  }
  ctx.scheduleMessage(session, msg.text || "", msg.resetsAt, null, null, options);
  return true;
}

function handleCancelScheduledMessage(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  if (session) ctx.cancelScheduledMessage(session);
  return true;
}

function findQueueIndex(session, queueId) {
  if (!session || !Array.isArray(session.pendingUserMessageQueue)) return -1;
  for (var i = 0; i < session.pendingUserMessageQueue.length; i++) {
    if (session.pendingUserMessageQueue[i].queueId === queueId) return i;
  }
  return -1;
}

function handleSteerQueued(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  var queueId = msg.queueId || "";
  var index = findQueueIndex(session, queueId);
  if (index === -1) return true;
  var item = session.pendingUserMessageQueue.splice(index, 1)[0];
  var historyItem = ctx.queue.markQueuedHistoryAsSteered(session, queueId);
  ctx.sendToSession(session.localId, { type: "queued_user_message_removed", queueId: queueId });
  ctx.queue.sendQueuedUserMessagesState(session);
  if (historyItem) ctx.sendToSession(session.localId, ctx.hydrateImageRefs(historyItem));
  ctx.queue.queuePreparedMessage(session, item.text, item.images, item.queueId,
    item.displayText, item.imageCount, item.clientMessageId, item.pastes,
    // Carry the original sender across the requeue. The item being spliced out
    // already knows who sent it; rebuilding it without that would make a
    // steered "mark as done" arrive unattributed and be refused.
    { front: true, silent: true, hidden: true, actorUserId: item.actorUserId || null });
  ctx.sm.saveSessionFile(session);
  if (session.isProcessing) {
    session.steerInterruptRequested = true;
    session.taskStopRequested = true;
    if (session.abortController) session.abortController.abort();
  } else {
    ctx.queue.flushQueuedUserMessage(session);
  }
  return true;
}

function handleCoordinateQueued(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  var queueId = msg.queueId || "";
  var index = findQueueIndex(session, queueId);
  if (index === -1 || !ctx.coordinateQueuedMessage) return true;
  var item = session.pendingUserMessageQueue.splice(index, 1)[0];
  var coordinated = ctx.coordinateQueuedMessage(session, item);
  if (!coordinated) {
    session.pendingUserMessageQueue.splice(index, 0, item);
    ctx.queue.sendQueuedUserMessagesState(session);
    return true;
  }
  var historyItem = ctx.queue.markQueuedHistoryAsCoordinated(session, queueId);
  ctx.sendToSession(session.localId, { type: "queued_user_message_removed", queueId: queueId });
  ctx.queue.sendQueuedUserMessagesState(session);
  if (historyItem) ctx.sendToSession(session.localId, ctx.hydrateImageRefs(historyItem));
  ctx.sm.saveSessionFile(session);
  return true;
}

function handleListCoordinators(ctx, ws, msg) {
  var source = ctx.getSessionForMessageWithoutSwitch(ws, msg.sourceSessionId);
  var candidates = source && ctx.listAdoptionCoordinators
    ? ctx.listAdoptionCoordinators(source) : [];
  candidates = candidates.filter(function (candidate) {
    return !!ctx.getSessionForMessageWithoutSwitch(ws, candidate.id);
  });
  ctx.sendTo(ws, {
    type: "orchestration_coordinator_candidates",
    sourceSessionId: source ? source.localId : null,
    candidates: candidates,
  });
  return true;
}

function handleProposeAdoption(ctx, ws, msg) {
  var source = ctx.getSessionForMessageWithoutSwitch(ws, msg.sourceSessionId);
  var coordinator = ctx.getSessionForMessageWithoutSwitch(ws, msg.coordinatorSessionId);
  var proposed = !!(source && coordinator && ctx.proposeSessionAdoption &&
    ctx.proposeSessionAdoption(source, coordinator, { intent: msg.adoptionIntent }));
  ctx.sendTo(ws, {
    type: "session_adoption_proposed",
    ok: proposed,
    adoptionIntent: msg.adoptionIntent || null,
    sourceSessionId: source ? source.localId : null,
    coordinatorSessionId: coordinator ? coordinator.localId : null,
  });
  return true;
}

function hasSessionDeletePermission(ctx, ws) {
  if (!ws._clayUser) return true;
  var permissions = ctx.usersModule.getEffectivePermissions(ws._clayUser, ctx.osUsers);
  return !!permissions.sessionDelete;
}

function handleCloseTask(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  var taskId = String(msg.taskId || "");
  if (!session || !taskId || !ctx.closeOrchestrationTask) return true;
  if (!hasSessionDeletePermission(ctx, ws)) {
    ctx.sendTo(ws, { type: "error", text: "You do not have permission to close worker conversations" });
    return true;
  }
  ctx.closeOrchestrationTask(session, taskId, ws);
  return true;
}

function handleRetryReconciliation(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  if (session && ctx.retryOrchestrationReconciliation) {
    ctx.retryOrchestrationReconciliation(session);
  }
  return true;
}

function handleSetQueueing(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  if (!session) return true;
  session.queueingDisabled = !!msg.disabled;
  ctx.queue.sendQueuedUserMessagesState(session);
  return true;
}

function handleClearQueued(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  var queueId = msg.queueId || "";
  if (!session || !queueId) return true;
  if (session.pendingUserMessageQueue) {
    session.pendingUserMessageQueue = session.pendingUserMessageQueue.filter(function (item) {
      return item.queueId !== queueId;
    });
  }
  ctx.queue.removeQueuedHistoryMessage(session, queueId);
  ctx.sendToSession(session.localId, { type: "queued_user_message_removed", queueId: queueId });
  ctx.queue.sendQueuedUserMessagesState(session);
  return true;
}

function handleSendScheduledNow(ctx, ws, msg) {
  var session = ctx.getSessionForMessage(ws, msg);
  if (session && typeof ctx.sendScheduledMessageNow === "function") {
    ctx.sendScheduledMessageNow(session, { manual: true });
  }
  return true;
}

function attachProjectUserMessageHandlers(ctx) {
  ctx.syncNotesKnowledge = function () { syncNotesKnowledge(ctx); };
  var handlers = Object.create(null);
  handlers.promote_session_to_coordinator = function (ws, msg) { return handlePromote(ctx, ws, msg); };
  handlers.note_create = function (ws, msg) { return handleNoteCreate(ctx, ws, msg); };
  handlers.note_update = function (ws, msg) { return handleNoteUpdate(ctx, ws, msg); };
  handlers.note_delete = function (ws, msg) { return handleNoteDelete(ctx, ws, msg); };
  handlers.note_list_request = function (ws, msg) { return handleNoteList(ctx, ws, msg); };
  handlers.note_bring_front = function (ws, msg) { return handleNoteBringFront(ctx, ws, msg); };
  handlers.term_create = function (ws, msg) { return handleTermCreate(ctx, ws, msg); };
  handlers.term_attach = function (ws, msg) { if (msg.id) ctx.tm.attach(msg.id, ws); return true; };
  handlers.term_detach = function (ws, msg) { if (msg.id) ctx.tm.detach(msg.id, ws); return true; };
  handlers.term_input = function (ws, msg) { if (msg.id) ctx.tm.write(msg.id, msg.data); return true; };
  handlers.term_resize = function (ws, msg) {
    if (msg.id && msg.cols > 0 && msg.rows > 0) ctx.tm.resize(msg.id, msg.cols, msg.rows, ws);
    return true;
  };
  handlers.term_close = function (ws, msg) { return handleTermClose(ctx, ws, msg); };
  handlers.term_rename = function (ws, msg) { return handleTermRename(ctx, ws, msg); };
  handlers.context_sources_save = function (ws, msg) { return handleContextSourcesSave(ctx, ws, msg); };
  handlers.browser_tab_list = function (ws, msg) { return handleBrowserTabList(ctx, ws, msg); };
  handlers.extension_result = function (ws, msg) { return handleExtensionResult(ctx, ws, msg); };
  handlers.schedule_message = function (ws, msg) { return handleScheduleMessage(ctx, ws, msg); };
  handlers.cancel_scheduled_message = function (ws, msg) { return handleCancelScheduledMessage(ctx, ws, msg); };
  handlers.steer_queued_message = function (ws, msg) { return handleSteerQueued(ctx, ws, msg); };
  handlers.coordinate_queued_message = function (ws, msg) { return handleCoordinateQueued(ctx, ws, msg); };
  handlers.list_orchestration_coordinators = function (ws, msg) { return handleListCoordinators(ctx, ws, msg); };
  handlers.propose_session_adoption = function (ws, msg) { return handleProposeAdoption(ctx, ws, msg); };
  handlers.close_orchestration_task = function (ws, msg) { return handleCloseTask(ctx, ws, msg); };
  handlers.retry_orchestration_reconciliation = function (ws, msg) { return handleRetryReconciliation(ctx, ws, msg); };
  handlers.set_session_queueing = function (ws, msg) { return handleSetQueueing(ctx, ws, msg); };
  handlers.clear_queued_message = function (ws, msg) { return handleClearQueued(ctx, ws, msg); };
  handlers.send_scheduled_now = function (ws, msg) { return handleSendScheduledNow(ctx, ws, msg); };

  var scheduledTaskTypes = Object.create(null);
  ["loop_start", "loop_stop", "loop_registry_files", "loop_registry_save_files",
    "loop_registry_list", "loop_registry_update", "loop_registry_rename",
    "loop_registry_remove", "loop_registry_convert", "loop_registry_toggle",
    "loop_registry_rerun", "schedule_create", "schedule_move"].forEach(function (type) {
    scheduledTaskTypes[type] = true;
  });

  function handleAuxiliaryMessage(ws, msg) {
    var type = msg && msg.type;
    if (hasOwn.call(scheduledTaskTypes, type) && ws._clayUser) {
      var permissions = ctx.usersModule.getEffectivePermissions(ws._clayUser, ctx.osUsers);
      if (!permissions.scheduledTasks) {
        ctx.sendTo(ws, { type: "error", text: "Scheduled tasks access is not permitted" });
        return true;
      }
    }
    if (ctx._loop && typeof ctx._loop.handleLoopMessage === "function" &&
        ctx._loop.handleLoopMessage(ws, msg)) return true;
    if (!hasOwn.call(handlers, type)) return false;
    return handlers[type](ws, msg);
  }

  return {
    handleAuxiliaryMessage: handleAuxiliaryMessage,
    syncNotesKnowledge: function () { return syncNotesKnowledge(ctx); },
  };
}

module.exports = {
  attachProjectUserMessageHandlers: attachProjectUserMessageHandlers,
  hasOwn: hasOwn,
};
