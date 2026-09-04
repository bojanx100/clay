var path = require("path");
var liveUiTarget = require("./project-live-ui-target");

function editableRoot(cwd, activeWorktree) {
  var worktreeDir = activeWorktree &&
    (activeWorktree.devCwd || activeWorktree.root);
  return path.resolve(worktreeDir || cwd);
}

function targetFromStatus(writableRoot, status) {
  var value = status || {};
  return {
    writableRoot: path.resolve(writableRoot),
    localUrl: value.localUrl || null,
    tailscaleUrl: value.tailscaleUrl || null,
    previewUrl: value.previewUrl || null,
    running: !!value.running,
    portLive: !!value.portLive,
  };
}

function reconnectTarget(writableRoot, tabUrl, status) {
  var target = targetFromStatus(writableRoot, status);
  if (!target.running || !target.portLive || !target.localUrl) {
    return {
      ok: false,
      code: "LIVE_UI_DEV_SERVER_REQUIRED",
      error: "No running development server belongs to this chat's current project root",
    };
  }
  if (!liveUiTarget.resolveTargetOrigin(target, tabUrl)) {
    return {
      ok: false,
      code: "LIVE_UI_SERVER_ROOT_MISMATCH",
      error: "The inspected page is served from a different project root or worktree",
    };
  }
  return { ok: true, target: target };
}

module.exports = {
  editableRoot: editableRoot,
  reconnectTarget: reconnectTarget,
  targetFromStatus: targetFromStatus,
};
