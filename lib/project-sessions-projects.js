var fs = require("fs");
var path = require("path");
var { resolveCreateProjectRequest, isPathInside } = require("./project-path-utils");

function attachProjectSessionsProjects(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var osUsers = ctx.osUsers;
  var sm = ctx.sm;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var opts = ctx.opts;
  var usersModule = ctx.usersModule;
  var moveScheduleToProject = ctx.moveScheduleToProject;
  var moveAllSchedulesToProject = ctx.moveAllSchedulesToProject;
  var getHubSchedules = ctx.getHubSchedules;
  var getScheduleCount = ctx.getScheduleCount;
  var onCreateWorktree = ctx.onCreateWorktree;
  var IGNORED_DIRS = ctx.IGNORED_DIRS;
  var getProjectOwnerId = ctx.getProjectOwnerId;
  var setProjectOwnerId = ctx.setProjectOwnerId;

  function handleMoveSessionToProject(ws, msg) {
    if (ws._clayUser) {
      var mvPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
      if (!mvPerms.sessionDelete) {
        sendTo(ws, { type: "error", text: "You do not have permission to move sessions" });
        return true;
      }
    }
    var mvSession = sm.sessions.get(msg.id);
    if (!mvSession) return true;
    if (mvSession.isProcessing) {
      sendTo(ws, { type: "error", text: "Cannot move a session that is currently running" });
      return true;
    }
    var mvTargetCtx = opts && opts.getProject && opts.getProject(msg.toSlug);
    if (!mvTargetCtx) {
      sendTo(ws, { type: "error", text: "Target project not found" });
      return true;
    }
    var mvTargetSm = typeof mvTargetCtx.getSessionManager === "function" && mvTargetCtx.getSessionManager();
    if (!mvTargetSm) return true;
    var mvStorageId = mvSession.storageId || mvSession.cliSessionId || null;
    if (mvStorageId) {
      var mvSrcFile = path.join(sm.sessionsDir, mvStorageId + ".jsonl");
      var mvDstFile = path.join(mvTargetSm.sessionsDir, mvStorageId + ".jsonl");
      try {
        fs.mkdirSync(mvTargetSm.sessionsDir, { recursive: true });
        fs.copyFileSync(mvSrcFile, mvDstFile);
      } catch (e) {
        sendTo(ws, { type: "error", text: "Could not move session file: " + (e.message || e) });
        return true;
      }
      mvTargetSm.adoptSessionFile(mvStorageId);
      // Source file is now copied; remove from source memory without tombstoning.
      sm.sessions.delete(mvSession.localId);
      try { fs.unlinkSync(mvSrcFile); } catch (e) {}
    } else {
      sm.sessions.delete(mvSession.localId);
    }
    sm.broadcastSessionList();
    mvTargetSm.broadcastSessionList();
    return true;
  }

  function handleBrowseDir(ws, msg) {
    var rawPath = (msg.path || "").replace(/^~/, require("./config").REAL_HOME);
    var absTarget = path.resolve(rawPath);
    // Multi-user mode: non-admins can only browse their home directory
    if (osUsers && osUsers.length > 0 && ws._clayUser && ws._clayUser.role !== "admin") {
      var browseHome = ws._clayUser.linuxUser ? "/home/" + ws._clayUser.linuxUser : null;
      if (!browseHome || (absTarget !== browseHome && (absTarget + "/").indexOf(browseHome + "/") !== 0)) {
        sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: [], error: "Access restricted to your home directory" });
        return true;
      }
    }
    var parentDir, prefix;
    try {
      var stat = fs.statSync(absTarget);
      if (stat.isDirectory()) {
        // Input is an existing directory; list its children.
        parentDir = absTarget;
        prefix = "";
      } else {
        parentDir = path.dirname(absTarget);
        prefix = path.basename(absTarget).toLowerCase();
      }
    } catch (e) {
      // Path does not exist; list parent and filter by typed prefix.
      parentDir = path.dirname(absTarget);
      prefix = path.basename(absTarget).toLowerCase();
    }
    try {
      var dirItems = fs.readdirSync(parentDir, { withFileTypes: true });
      var dirEntries = [];
      for (var di = 0; di < dirItems.length; di++) {
        var d = dirItems[di];
        if (!d.isDirectory()) continue;
        if (d.name.charAt(0) === ".") continue;
        if (IGNORED_DIRS.has(d.name)) continue;
        if (prefix && !d.name.toLowerCase().startsWith(prefix)) continue;
        dirEntries.push({ name: d.name, path: path.join(parentDir, d.name) });
      }
      dirEntries.sort(function (a, b) { return a.name.localeCompare(b.name); });
      sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: dirEntries });
    } catch (e) {
      sendTo(ws, { type: "browse_dir_result", path: msg.path, entries: [], error: e.message });
    }
    return true;
  }

  function handleProjectMessage(ws, msg) {
    if (msg.type === "move_session_to_project") return handleMoveSessionToProject(ws, msg);
    if (msg.type === "browse_dir") return handleBrowseDir(ws, msg);

    if (msg.type === "transfer_project_owner") {
      // Home directory projects: ownership is permanently locked
      if (osUsers && osUsers.length > 0 && /^\/home\/[^/]+\//.test(cwd)) {
        sendTo(ws, { type: "error", text: "Cannot transfer ownership of home directory projects." });
        return true;
      }
      var projectOwnerId = getProjectOwnerId();
      var isAdmin = ws._clayUser && ws._clayUser.role === "admin";
      var isProjectOwner = ws._clayUser && projectOwnerId && ws._clayUser.id === projectOwnerId;
      if (!ws._clayUser || (!isAdmin && !isProjectOwner)) {
        sendTo(ws, { type: "error", text: "Only project owners or admins can transfer ownership." });
        return true;
      }
      var targetUser = msg.userId ? usersModule.findUserById(msg.userId) : null;
      if (!targetUser) {
        sendTo(ws, { type: "error", text: "User not found." });
        return true;
      }
      setProjectOwnerId(targetUser.id);
      if (opts.onProjectOwnerChanged) {
        opts.onProjectOwnerChanged(slug, targetUser.id);
      }
      send({ type: "project_owner_changed", ownerId: targetUser.id, ownerName: targetUser.displayName || targetUser.username });
      return true;
    }

    if (msg.type === "add_project") {
      var addPath = (msg.path || "").replace(/^~/, require("./config").REAL_HOME);
      var addAbs = path.resolve(addPath);
      // Multi-user mode: normal users restricted to their home directory
      if (osUsers && osUsers.length > 0 && ws._clayUser && ws._clayUser.role !== "admin") {
        if (!ws._clayUser.linuxUser) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "No Linux user assigned" });
          return true;
        }
        var userHome = "/home/" + ws._clayUser.linuxUser;
        if (addAbs !== userHome && (addAbs + "/").indexOf(userHome + "/") !== 0) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "Path not allowed. You can only add directories under " + userHome });
          return true;
        }
      }
      try {
        var addStat = fs.statSync(addAbs);
        if (!addStat.isDirectory()) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "Not a directory" });
          return true;
        }
      } catch (e) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Directory not found" });
        return true;
      }
      if (typeof opts.onAddProject === "function") {
        var result = opts.onAddProject(addAbs, ws._clayUser);
        sendTo(ws, { type: "add_project_result", ok: result.ok, slug: result.slug, error: result.error, existing: result.existing });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    if (msg.type === "create_project" || msg.type === "clone_project") {
      if (ws._clayUser) {
        var cpPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
        if (!cpPerms.createProject) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "You do not have permission to create projects" });
          return true;
        }
      }
    }

    if (msg.type === "create_project") {
      var createRequest = resolveCreateProjectRequest(msg, require("./config").REAL_HOME);
      if (createRequest.error) {
        sendTo(ws, { type: "add_project_result", ok: false, error: createRequest.error });
        return true;
      }
      if (createRequest.targetPath && osUsers && ws._clayUser && ws._clayUser.role !== "admin") {
        var createHome = ws._clayUser.linuxUser ? "/home/" + ws._clayUser.linuxUser : null;
        if (!createHome || !isPathInside(createHome, createRequest.targetPath)) {
          sendTo(ws, { type: "add_project_result", ok: false, error: "Path not allowed. You can only create directories under " + (createHome || "your home directory") });
          return true;
        }
      }
      if (typeof opts.onCreateProject === "function") {
        var createResult = opts.onCreateProject(createRequest.name, ws._clayUser, createRequest.parentPath);
        sendTo(ws, { type: "add_project_result", ok: createResult.ok, slug: createResult.slug, error: createResult.error });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    if (msg.type === "clone_project") {
      var cloneUrl = (msg.url || "").trim();
      if (!cloneUrl || (!/^https?:\/\//.test(cloneUrl) && !/^git@/.test(cloneUrl))) {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Invalid URL. Use https:// or git@ format." });
        return true;
      }
      sendTo(ws, { type: "clone_project_progress", status: "cloning" });
      if (typeof opts.onCloneProject === "function") {
        opts.onCloneProject(cloneUrl, ws._clayUser, function (cloneResult) {
          sendTo(ws, { type: "add_project_result", ok: cloneResult.ok, slug: cloneResult.slug, error: cloneResult.error });
        });
      } else {
        sendTo(ws, { type: "add_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    if (msg.type === "create_worktree") {
      var wtBranch = (msg.branch || "").trim();
      var wtDirName = (msg.dirName || "").trim() || wtBranch.replace(/\//g, "-");
      var wtBase = (msg.baseBranch || "").trim() || null;
      if (!wtBranch || !/^[a-zA-Z0-9_\/.@-]+$/.test(wtBranch)) {
        sendTo(ws, { type: "create_worktree_result", ok: false, error: "Invalid branch name" });
        return true;
      }
      if (typeof onCreateWorktree === "function") {
        var wtResult = onCreateWorktree(slug, wtBranch, wtDirName, wtBase);
        sendTo(ws, { type: "create_worktree_result", ok: wtResult.ok, slug: wtResult.slug, error: wtResult.error });
      } else {
        sendTo(ws, { type: "create_worktree_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    if (msg.type === "remove_project_check") {
      var checkSlug = msg.slug;
      if (!checkSlug) {
        sendTo(ws, { type: "remove_project_check_result", slug: checkSlug, name: msg.name || checkSlug, count: 0 });
        return true;
      }
      var schedCount = getScheduleCount(checkSlug);
      sendTo(ws, { type: "remove_project_check_result", slug: checkSlug, name: msg.name || checkSlug, count: schedCount });
      return true;
    }

    if (msg.type === "remove_project") {
      if (ws._clayUser) {
        var dpPerms = usersModule.getEffectivePermissions(ws._clayUser, osUsers);
        if (!dpPerms.deleteProject) {
          sendTo(ws, { type: "remove_project_result", ok: false, error: "You do not have permission to delete projects" });
          return true;
        }
      }
      var removeSlug = msg.slug;
      if (!removeSlug) {
        sendTo(ws, { type: "remove_project_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (msg.moveTasksTo) {
        moveAllSchedulesToProject(removeSlug, msg.moveTasksTo);
      }
      if (typeof opts.onRemoveProject === "function") {
        sendTo(ws, { type: "remove_project_result", ok: true, slug: removeSlug });
        var removeUserId = ws._clayUser ? ws._clayUser.id : null;
        opts.onRemoveProject(removeSlug, removeUserId);
      } else {
        sendTo(ws, { type: "remove_project_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    if (msg.type === "schedule_move") {
      var moveResult = moveScheduleToProject(msg.recordId, msg.fromSlug, msg.toSlug);
      if (moveResult.ok) {
        send({ type: "loop_registry_updated", records: getHubSchedules() });
      }
      sendTo(ws, { type: "schedule_move_result", ok: moveResult.ok, error: moveResult.error });
      return true;
    }

    if (msg.type === "reorder_projects") {
      var slugs = msg.slugs;
      if (!Array.isArray(slugs) || slugs.length === 0) {
        sendTo(ws, { type: "reorder_projects_result", ok: false, error: "Missing slugs" });
        return true;
      }
      if (typeof opts.onReorderProjects === "function") {
        var reorderResult = opts.onReorderProjects(slugs);
        sendTo(ws, { type: "reorder_projects_result", ok: reorderResult.ok, error: reorderResult.error });
      } else {
        sendTo(ws, { type: "reorder_projects_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    if (msg.type === "set_project_title") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_title_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectTitle === "function") {
        var titleResult = opts.onSetProjectTitle(msg.slug, msg.title || null);
        sendTo(ws, { type: "set_project_title_result", ok: titleResult.ok, slug: msg.slug, error: titleResult.error });
      } else {
        sendTo(ws, { type: "set_project_title_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    if (msg.type === "set_project_icon") {
      if (!msg.slug) {
        sendTo(ws, { type: "set_project_icon_result", ok: false, error: "Missing slug" });
        return true;
      }
      if (typeof opts.onSetProjectIcon === "function") {
        var iconResult = opts.onSetProjectIcon(msg.slug, msg.icon || null);
        sendTo(ws, { type: "set_project_icon_result", ok: iconResult.ok, slug: msg.slug, error: iconResult.error });
      } else {
        sendTo(ws, { type: "set_project_icon_result", ok: false, error: "Not supported" });
      }
      return true;
    }

    return false;
  }

  return {
    handleProjectMessage: handleProjectMessage,
  };
}

module.exports = { attachProjectSessionsProjects: attachProjectSessionsProjects };
