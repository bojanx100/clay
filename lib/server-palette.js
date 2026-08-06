var sessionSearch = require("./session-search");

var LIVE_UI_MAX_PROJECTS = 100;
var LIVE_UI_MAX_SESSIONS = 500;

function canAccessPaletteProject(users, user, onGetProjectAccess, projectSlug) {
  if (!user || !onGetProjectAccess) return true;
  var access = onGetProjectAccess(projectSlug);
  return !access || (!access.error && users.canAccessProject(user.id, access));
}

function canAccessPaletteSession(users, user, onGetProjectAccess, projectSlug, session) {
  if (session.hidden || session.orchestrationParent) return false;
  if (!user) return !session.ownerId;
  var access = onGetProjectAccess ? onGetProjectAccess(projectSlug) : null;
  if (access && access.error) return false;
  return users.canAccessSession(user.id, session, access);
}

function buildLiveUiCatalog(projects, users, user, onGetProjectAccess) {
  var catalog = [];
  var totalSessions = 0;
  projects.forEach(function (project, projectSlug) {
    if (catalog.length >= LIVE_UI_MAX_PROJECTS || totalSessions >= LIVE_UI_MAX_SESSIONS) return;
    var status = project.getStatus();
    if (status.isWorktree || status.isMate || status.isLead) return;
    if (!canAccessPaletteProject(users, user, onGetProjectAccess, projectSlug)) return;
    var sessions = [];
    project.sm.sessions.forEach(function (session) {
      if (totalSessions + sessions.length >= LIVE_UI_MAX_SESSIONS) return;
      if (!canAccessPaletteSession(users, user, onGetProjectAccess, projectSlug, session)) return;
      sessions.push({
        id: session.localId,
        title: session.title || "New Session",
        isProcessing: !!session.isProcessing,
        coordinationMode: !!session.coordinationMode,
        lastActivity: session.lastActivity || session.createdAt || 0,
      });
    });
    sessions.sort(function (a, b) { return b.lastActivity - a.lastActivity; });
    if (!sessions.length) return;
    totalSessions += sessions.length;
    catalog.push({
      projectSlug: projectSlug,
      projectTitle: status.title || status.project || projectSlug,
      projectIcon: status.icon || null,
      sessions: sessions,
    });
  });
  catalog.sort(function (a, b) {
    return a.projectTitle.localeCompare(b.projectTitle);
  });
  return catalog;
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

    if (pParams.get("scope") === "live-ui") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify({
        projects: buildLiveUiCatalog(
          projects, users, paletteUser, onGetProjectAccess),
      }));
      return true;
    }

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
};
