var sessionSearch = require("./session-search");

var LIVE_UI_MAX_PROJECTS = 100;
var LIVE_UI_MAX_SESSIONS = 500;

function canAccessPaletteProject(users, user, onGetProjectAccess, projectSlug) {
  if (!user || !onGetProjectAccess) return true;
  var access = onGetProjectAccess(projectSlug);
  return !access || (!access.error && users.canAccessProject(user.id, access));
}

function canAccessPaletteSession(users, user, onGetProjectAccess, projectSlug, session) {
  if (session.hidden || session.orchestrationParent ||
      session.orchestrationGroupParent ||
      (session.loop && session.loop.loopId) ||
      session.coopHome || session.coopChannel) return false;
  if (!user) return !session.ownerId;
  var access = onGetProjectAccess ? onGetProjectAccess(projectSlug) : null;
  if (access && access.error) return false;
  return users.canAccessSession(user.id, session, access);
}

function liveUiProjectMetadata(project, projectSlug) {
  var status = project.getStatus();
  if (status.isWorktree || status.isMate || status.isLead) return null;
  return {
    projectSlug: projectSlug,
    projectTitle: status.title || status.project || projectSlug,
    projectIcon: status.icon || null,
  };
}

function buildLiveUiProjects(projects, users, user, onGetProjectAccess) {
  var result = [];
  projects.forEach(function (project, projectSlug) {
    if (result.length >= LIVE_UI_MAX_PROJECTS) return;
    if (!canAccessPaletteProject(users, user, onGetProjectAccess, projectSlug)) return;
    var metadata = liveUiProjectMetadata(project, projectSlug);
    if (metadata) result.push(metadata);
  });
  result.sort(function (a, b) {
    return a.projectTitle.localeCompare(b.projectTitle);
  });
  return result;
}

function compareLiveUiSessions(a, b) {
  if (a.bookmarked !== b.bookmarked) return a.bookmarked ? -1 : 1;
  if (a.bookmarked && b.bookmarked && a.favoriteOrder !== b.favoriteOrder) {
    return a.favoriteOrder - b.favoriteOrder;
  }
  return b.lastActivity - a.lastActivity;
}

function buildLiveUiProject(projects, users, user, onGetProjectAccess, projectSlug) {
  var project = projects.get(projectSlug);
  if (!project || !canAccessPaletteProject(
      users, user, onGetProjectAccess, projectSlug)) return null;
  var metadata = liveUiProjectMetadata(project, projectSlug);
  if (!metadata) return null;
  var sessions = [];
  project.sm.sessions.forEach(function (session) {
    if (sessions.length >= LIVE_UI_MAX_SESSIONS) return;
    if (!canAccessPaletteSession(
        users, user, onGetProjectAccess, projectSlug, session)) return;
    sessions.push({
      id: session.localId,
      title: session.title || "New Session",
      isProcessing: !!session.isProcessing,
      coordinationMode: !!session.coordinationMode,
      bookmarked: !!session.bookmarked,
      favoriteOrder: typeof session.favoriteOrder === "number" ?
        session.favoriteOrder : Number.MAX_SAFE_INTEGER,
      lastActivity: session.lastActivity || session.createdAt || 0,
    });
  });
  sessions.sort(compareLiveUiSessions);
  return Object.assign({}, metadata, { sessions: sessions });
}

function buildLiveUiCatalog(projects, users, user, onGetProjectAccess) {
  var projectList = buildLiveUiProjects(
    projects, users, user, onGetProjectAccess);
  var catalog = [];
  for (var i = 0; i < projectList.length; i++) {
    var project = buildLiveUiProject(
      projects, users, user, onGetProjectAccess, projectList[i].projectSlug);
    if (project && project.sessions.length) catalog.push(project);
  }
  return catalog;
}

function handleLiveUiRequest(
  pParams,
  res,
  projects,
  users,
  paletteUser,
  onGetProjectAccess
) {
  if (pParams.get("scope") !== "live-ui") return false;
  var requestedProject = pParams.get("project") || "";
  if (requestedProject && !/^[a-z0-9_-]+$/.test(requestedProject)) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not_found"}');
    return true;
  }
  var liveUiProject = requestedProject ? buildLiveUiProject(
    projects, users, paletteUser, onGetProjectAccess, requestedProject) : null;
  if (requestedProject && !liveUiProject) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end('{"error":"not_found"}');
    return true;
  }
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(requestedProject ? { project: liveUiProject } : {
    projects: buildLiveUiProjects(
      projects, users, paletteUser, onGetProjectAccess),
  }));
  return true;
}

function attachPalette(ctx) {
  var users = ctx.users;
  var projects = ctx.projects;
  var getMultiUserFromReq = ctx.getMultiUserFromReq;
  var onGetProjectAccess = ctx.onGetProjectAccess;

  function handleRequest(req, res, fullUrl) {
    if (req.method !== "GET" || fullUrl !== "/api/palette/search") return false;

    var paletteUser = null;
    if (users.isMultiUser()) {
      paletteUser = getMultiUserFromReq(req);
      if (!paletteUser) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return true;
      }
    }
    var pqs = req.url.indexOf("?") >= 0 ? req.url.substring(req.url.indexOf("?")) : "";
    var pParams = new URLSearchParams(pqs);
    var pQuery = pParams.get("q") || "";
    var pResults = [];

    if (handleLiveUiRequest(
        pParams, res, projects, users, paletteUser, onGetProjectAccess)) return true;

    if (!pQuery) {
      // Recent mode: return all sessions sorted by lastActivity
      projects.forEach(function (pCtx, pSlug) {
        var status = pCtx.getStatus();
        if (status.isWorktree) return;
        if (paletteUser && onGetProjectAccess) {
          var pAccess = onGetProjectAccess(pSlug);
          if (pAccess && !pAccess.error && !users.canAccessProject(paletteUser.id, pAccess)) return;
        }
        pCtx.sm.sessions.forEach(function (session) {
          if (session.hidden) return;
          if (paletteUser) {
            if (users.isMultiUser()) {
              var sAccess = onGetProjectAccess ? onGetProjectAccess(pSlug) : null;
              if (!users.canAccessSession(paletteUser.id, session, sAccess)) return;
            }
          } else {
            if (session.ownerId) return;
          }
          var pItem = {
            projectSlug: pSlug,
            projectTitle: status.title || status.project,
            projectIcon: status.icon || null,
            sessionId: session.localId,
            sessionTitle: session.title || "New Session",
            lastActivity: session.lastActivity || session.createdAt || 0,
            matchType: null,
            snippet: null
          };
          if (status.isMate) {
            pItem.isMate = true;
            pItem.mateId = status.mateId || null;
          }
          pResults.push(pItem);
        });
      });
      pResults.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
      if (pResults.length > 30) pResults = pResults.slice(0, 30);
    } else {
      // Search mode: BM25 ranked search across all sessions
      var projectSessions = [];
      projects.forEach(function (pCtx, pSlug) {
        var status = pCtx.getStatus();
        if (status.isWorktree) return;
        if (paletteUser && onGetProjectAccess) {
          var pAccess = onGetProjectAccess(pSlug);
          if (pAccess && !pAccess.error && !users.canAccessProject(paletteUser.id, pAccess)) return;
        }
        var accessibleSessions = [];
        pCtx.sm.sessions.forEach(function (session) {
          if (session.hidden) return;
          if (paletteUser) {
            if (users.isMultiUser()) {
              var sAccess = onGetProjectAccess ? onGetProjectAccess(pSlug) : null;
              if (!users.canAccessSession(paletteUser.id, session, sAccess)) return;
            }
          } else {
            if (session.ownerId) return;
          }
          accessibleSessions.push(session);
        });
        if (accessibleSessions.length > 0) {
          projectSessions.push({
            projectSlug: pSlug,
            projectTitle: status.title || status.project,
            projectIcon: status.icon || null,
            isMate: status.isMate || false,
            mateId: status.mateId || null,
            sessions: accessibleSessions
          });
        }
      });
      pResults = sessionSearch.searchPalette(projectSessions, pQuery, { maxResults: 30 });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ results: pResults }));
    return true;
  }

  return {
    handleRequest: handleRequest,
  };
}

module.exports = {
  attachPalette: attachPalette,
  buildLiveUiCatalog: buildLiveUiCatalog,
  buildLiveUiProject: buildLiveUiProject,
  buildLiveUiProjects: buildLiveUiProjects,
};
