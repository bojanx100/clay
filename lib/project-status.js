var path = require("path");

function attachProjectStatus(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var project = ctx.project;
  var currentVersion = ctx.currentVersion;
  var debug = !!ctx.debug;
  var osUsers = !!ctx.osUsers;
  var lanHost = ctx.lanHost;
  var isMate = !!ctx.isMate;
  var worktreeMeta = ctx.worktreeMeta;
  var clients = ctx.clients;
  var sm = ctx.sm;
  var send = ctx.send;
  var usersModule = ctx.usersModule;
  var projectClients = ctx.projectClients;
  var getProjectCount = ctx.getProjectCount;
  var getProjectList = ctx.getProjectList;
  var getProjectOwnerId = ctx.getProjectOwnerId;
  var title = ctx.title || null;
  var icon = ctx.icon || null;

  function getTitle() {
    return title;
  }

  function getProjectLabel() {
    return title || project;
  }

  function getIcon() {
    return icon;
  }

  function getStatus() {
    var sessionCount = sm.sessions.size;
    var hasProcessing = false;
    var pendingPermCount = 0;
    sm.sessions.forEach(function (s) {
      if (s.isProcessing) hasProcessing = true;
      if (s.pendingPermissions) {
        pendingPermCount += Object.keys(s.pendingPermissions).length;
      }
    });
    var status = {
      slug: slug,
      path: cwd,
      project: project,
      title: title,
      icon: icon,
      clients: clients.size,
      sessions: sessionCount,
      isProcessing: hasProcessing,
      pendingPermissions: pendingPermCount,
      projectOwnerId: getProjectOwnerId(),
    };
    if (isMate) {
      status.isMate = true;
      status.mateId = path.basename(cwd);
    }
    if (worktreeMeta) {
      status.isWorktree = true;
      status.parentSlug = worktreeMeta.parentSlug;
      status.branch = worktreeMeta.branch;
      status.worktreeAccessible = worktreeMeta.accessible;
    }
    if (usersModule.isMultiUser()) {
      status.onlineUsers = projectClients.getOnlineUsers();
    }
    return status;
  }

  function setTitle(newTitle) {
    title = newTitle || null;
    send({
      type: "info",
      cwd: cwd,
      slug: slug,
      project: title || project,
      version: currentVersion,
      debug: debug,
      osUsers: osUsers,
      lanHost: lanHost,
      projectCount: getProjectCount(),
      projects: getProjectList(),
      projectOwnerId: getProjectOwnerId(),
    });
  }

  function setIcon(newIcon) {
    icon = newIcon || null;
  }

  return {
    getTitle: getTitle,
    getProjectLabel: getProjectLabel,
    getIcon: getIcon,
    getStatus: getStatus,
    setTitle: setTitle,
    setIcon: setIcon,
  };
}

module.exports = {
  attachProjectStatus: attachProjectStatus,
};
