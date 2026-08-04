var crypto = require("crypto");

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
  return {
    projectSlug: projectSlug,
    projectTitle: cleanLine(value.projectTitle, MAX_TITLE) || projectSlug,
    projectPath: cleanLine(value.projectPath, MAX_PATH) || null,
  };
}

function channelForClient(value) {
  var channel = normalizeChannelMetadata(value);
  return channel ? {
    projectSlug: channel.projectSlug,
    projectTitle: channel.projectTitle,
  } : null;
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

function findChannel(sessions, projectSlug, ownerId, multiUser) {
  var found = null;
  sessions.forEach(function (session) {
    var channel = normalizeChannelMetadata(session.coopChannel);
    var ownerMatches = multiUser ? session.ownerId === ownerId : !session.ownerId;
    if (!found && ownerMatches && channel && channel.projectSlug === projectSlug) {
      found = session;
    }
  });
  return found;
}

function channelMetadata(project) {
  return normalizeChannelMetadata({
    projectSlug: project.slug,
    projectTitle: project.title || project.project || project.slug,
    projectPath: project.path || null,
  });
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

function attachCoopChannels(ctx) {
  var slug = ctx.slug;
  var sm = ctx.sm;
  var getProjectList = ctx.getProjectList;
  var sendTo = ctx.sendTo;
  var usersModule = ctx.usersModule;

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

  function updateChannel(session, project) {
    var metadata = channelMetadata(project);
    var changed = JSON.stringify(session.coopChannel || null) !== JSON.stringify(metadata) ||
      session.title !== metadata.projectTitle || session.sessionVisibility !== "private" ||
      !!session.hidden;
    session.coopChannel = metadata;
    session.title = metadata.projectTitle;
    session.titleManuallySet = true;
    session.sessionVisibility = "private";
    if (session.hidden) delete session.hidden;
    if (changed) sm.saveSessionFile(session);
  }

  function handleCoopChannelMessage(ws, msg) {
    if (msg.type === "switch_session") {
      var target = targetFromMessage(msg);
      if (!target || !target.coopChannel) return false;
      var switchContext = userContext(ws);
      var channel = normalizeChannelMetadata(target.coopChannel);
      var switchProject = channel ? projectFor(switchContext, channel.projectSlug) : null;
      var ownerMatches = switchContext &&
        (switchContext.multiUser ? target.ownerId === switchContext.ownerId : !target.ownerId);
      if (slug !== "lead" || !switchProject || !ownerMatches) {
        sendTo(ws, { type: "error", text: "That Coop channel is unavailable or inaccessible" });
        return true;
      }
      updateChannel(target, switchProject);
      return false;
    }
    if (msg.type !== "ensure_coop_channel") return false;
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

    var session = findChannel(sm.sessions, project.slug,
      context.ownerId, context.multiUser);
    if (!session) {
      var sessionOptions = Object.assign({},
        copyRoutingPolicy(sm, context.ownerId, context.multiUser), {
        storageId: crypto.randomUUID(),
        ownerId: context.ownerId,
        sessionVisibility: "private",
        coopChannel: channelMetadata(project),
      });
      session = sm.createSessionRaw(sessionOptions);
    }
    updateChannel(session, project);
    sm.switchSession(session.localId, ws);
    return true;
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
  channelMetadata: channelMetadata,
  normalizeChannelMetadata: normalizeChannelMetadata,
  channelForClient: channelForClient,
  applyChannelScope: applyChannelScope,
  copyRoutingPolicy: copyRoutingPolicy,
};
