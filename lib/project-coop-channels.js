var crypto = require("crypto");
var handoffTraces = require("./coop-handoff-traces");
var projectIdentity = require("./project-identity");

var MAX_SLUG = 160;
var MAX_TITLE = 240;
var MAX_PATH = 1200;

function cleanLine(value, maxLength) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeChannelMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  var projectSlug = cleanLine(value.projectSlug, MAX_SLUG);
  if (!projectSlug) return null;
  var candidateProjectId = cleanLine(value.projectId, 128);
  var projectId = projectIdentity.isProjectId(candidateProjectId) ? candidateProjectId : null;
  var channel = {
    projectSlug: projectSlug,
    projectTitle: cleanLine(value.projectTitle, MAX_TITLE) || projectSlug,
    projectPath: cleanLine(value.projectPath, MAX_PATH) || null,
  };
  if (projectId) channel.projectId = projectId;
  return channel;
}

function channelForClient(value) {
  var channel = normalizeChannelMetadata(value);
  if (!channel) return null;
  var client = {
    projectSlug: channel.projectSlug,
    projectTitle: channel.projectTitle,
  };
  if (channel.projectId) client.projectId = channel.projectId;
  return client;
}

function promptText(value) {
  return cleanLine(value, MAX_PATH)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function applyChannelScope(session, userText) {
  var channel = normalizeChannelMetadata(session && session.coopChannel);
  if (!channel) return userText;
  var pathLine = channel.projectPath ?
    "Canonical project checkout: " + promptText(channel.projectPath) + "\n" : "";
  return "<coop_project_channel>\n" +
    "You are still Coop, the owner's single global CTO/coordinator. This conversation is the project-scoped channel for " +
    promptText(channel.projectTitle) + " (" + promptText(channel.projectSlug) + ").\n" +
    pathLine +
    "Keep working context, answers, planning, and delegated execution focused on this project. " +
    "Retain portfolio policy and owner preferences, but take unrelated cross-project discussion to the All Projects channel. " +
    "Do not adopt or reroute a session the owner opened directly unless the owner explicitly hands it to Coop.\n" +
    "</coop_project_channel>\n\n" + String(userText || "");
}

function eligibleProject(project) {
  return !!project && !project.isLead && !project.isMate && !project.isWorktree;
}

function findProject(projects, projectSlug) {
  for (var i = 0; i < projects.length; i++) {
    if (projects[i].slug === projectSlug && eligibleProject(projects[i])) return projects[i];
  }
  return null;
}

function findChannel(sessions, project, ownerId, multiUser) {
  var projectSlug = typeof project === "string" ? project : project && project.slug;
  var projectId = typeof project === "object" && project ? project.projectId : null;
  var found = null;
  sessions.forEach(function (session) {
    var channel = normalizeChannelMetadata(session.coopChannel);
    var ownerMatches = multiUser ? session.ownerId === ownerId : !session.ownerId;
    var projectMatches = channel && ((projectId && channel.projectId === projectId) ||
      (!projectId && channel.projectSlug === projectSlug) ||
      (!channel.projectId && channel.projectSlug === projectSlug));
    if (!found && ownerMatches && projectMatches) {
      found = session;
    }
  });
  return found;
}

function channelMetadata(project) {
  return normalizeChannelMetadata({
    projectId: project.projectId,
    projectSlug: project.slug,
    projectTitle: project.title || project.project || project.slug,
    projectPath: project.path || null,
  });
}

function updateChannel(session, project, sessionManager) {
  var metadata = channelMetadata(project);
  var changed = JSON.stringify(session.coopChannel || null) !== JSON.stringify(metadata) ||
    session.title !== metadata.projectTitle || session.sessionVisibility !== "private" ||
    !!session.hidden;
  session.coopChannel = metadata;
  session.title = metadata.projectTitle;
  session.titleManuallySet = true;
  session.sessionVisibility = "private";
  if (session.hidden) delete session.hidden;
  if (changed && sessionManager && typeof sessionManager.saveSessionFile === "function") sessionManager.saveSessionFile(session);
}

function ensureProjectChannel(sm, project, ownerId, multiUser) {
  if (!sm || !sm.sessions || !project) return null;
  var session = findChannel(sm.sessions, project, ownerId, multiUser);
  if (!session) {
    if (typeof sm.createSessionRaw !== "function") return null;
    var sessionOptions = Object.assign({}, copyRoutingPolicy(sm, ownerId, multiUser), {
      storageId: crypto.randomUUID(),
      ownerId: ownerId,
      sessionVisibility: "private",
      coopChannel: channelMetadata(project),
    });
    session = sm.createSessionRaw(sessionOptions);
  }
  updateChannel(session, project, sm);
  return session;
}

function copyRoutingPolicy(sm, ownerId, multiUser) {
  var home = null;
  sm.sessions.forEach(function (session) {
    if (home || !session.coopHome) return;
    if (multiUser && session.ownerId && session.ownerId !== ownerId) return;
    home = session;
  });
  if (!home) return {};
  return {
    vendor: home.vendor || null,
    providerRouteId: home.providerRouteId || null,
    model: home.requestedModel || home.model || null,
    automationMode: home.automationMode || null,
    permissionMode: home.permissionMode || null,
    codexApproval: home.codexApproval || null,
    codexSandbox: home.codexSandbox || null,
    codexWebSearch: home.codexWebSearch || null,
    dangerouslySkipPermissions: !!home.dangerouslySkipPermissions,
  };
}

function handoffTraceOwnerId(ws, usersModule) {
  var userId = ws && ws._clayUser && ws._clayUser.id;
  if (typeof userId === "string" && userId.trim()) return userId.trim();
  if (usersModule && usersModule.isMultiUser && usersModule.isMultiUser()) return null;
  return "_single_user";
}

function hasHandoffTraceId(msg) {
  return !!(msg && typeof msg.handoffTraceId === "string" && msg.handoffTraceId.trim());
}

function attachCoopChannels(ctx) {
  var slug = ctx.slug;
  var sm = ctx.sm;
  var getProjectList = ctx.getProjectList;
  var sendTo = ctx.sendTo;
  var usersModule = ctx.usersModule;
  var coopHandoffTraceStore = ctx.coopHandoffTraceStore || handoffTraces.createStore();

  function recordRejectedHandoff(ws, msg) {
    if (!hasHandoffTraceId(msg)) return;
    var ownerId = handoffTraceOwnerId(ws, usersModule);
    if (!ownerId) return;
    coopHandoffTraceStore.recordRejectedAccess({ intentId: msg.handoffTraceId, ownerId: ownerId });
  }

  function userContext(ws) {
    var multiUser = !!(usersModule && usersModule.isMultiUser());
    var userId = ws && ws._clayUser ? ws._clayUser.id : null;
    if (multiUser && !userId) return null;
    return { multiUser: multiUser, ownerId: multiUser ? userId : null, userId: userId };
  }

  function projectFor(context, projectSlug) {
    if (!context || typeof getProjectList !== "function") return null;
    return findProject(getProjectList(context.multiUser ? context.userId : null) || [], projectSlug);
  }

  function targetFromMessage(msg) {
    var target = typeof msg.id === "number" ? sm.sessions.get(msg.id) : null;
    if (target || !msg.storageId) return target;
    sm.sessions.forEach(function (session) {
      if (!target && (session.storageId === msg.storageId ||
          session.cliSessionId === msg.storageId)) target = session;
    });
    return target;
  }

  function handleChannelSwitch(ws, msg) {
    var target = targetFromMessage(msg);
    if (!target || !target.coopChannel) return false;
    var switchContext = userContext(ws);
    var channel = normalizeChannelMetadata(target.coopChannel);
    var switchProject = channel ? projectFor(switchContext, channel.projectSlug) : null;
    var ownerMatches = switchContext &&
      (switchContext.multiUser ? target.ownerId === switchContext.ownerId : !target.ownerId);
    if (slug !== "lead" || !switchProject || !ownerMatches) {
      recordRejectedHandoff(ws, msg);
      sendTo(ws, { type: "error", text: "That Coop channel is unavailable or inaccessible" });
      return true;
    }
    updateChannel(target, switchProject, sm);
    return false;
  }

  function ensureChannel(ws, msg) {
    if (slug !== "lead") {
      sendTo(ws, { type: "error", text: "Project channels are available only inside Coop" });
      return true;
    }
    var context = userContext(ws);
    var project = projectFor(context, msg.projectSlug);
    if (!project) {
      sendTo(ws, { type: "error", text: "That project is unavailable or inaccessible" });
      return true;
    }

    var session = ensureProjectChannel(sm, project, context.ownerId, context.multiUser);
    if (!session) return true;
    sm.switchSession(session.localId, ws);
    return true;
  }

  function handleCoopChannelMessage(ws, msg) {
    if (msg.type === "switch_session") return handleChannelSwitch(ws, msg);
    if (msg.type === "refresh_coop_channels") {
      if (slug === "lead") sm.broadcastSessionList();
      return true;
    }
    if (msg.type === "ensure_coop_channel") return ensureChannel(ws, msg);
    return false;
  }

  return {
    handleCoopChannelMessage: handleCoopChannelMessage,
  };
}

module.exports = {
  attachCoopChannels: attachCoopChannels,
  eligibleProject: eligibleProject,
  findProject: findProject,
  findChannel: findChannel,
  ensureProjectChannel: ensureProjectChannel,
  channelMetadata: channelMetadata,
  normalizeChannelMetadata: normalizeChannelMetadata,
  channelForClient: channelForClient,
  applyChannelScope: applyChannelScope,
  copyRoutingPolicy: copyRoutingPolicy,
};
