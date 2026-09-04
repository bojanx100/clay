var os = require("os");
var defaultOsUsers = require("./os-users");

function shouldSuppressDetachedAdoptedSession(session) {
  return !!(session && session.adopted &&
    typeof session.terminalId !== "number" &&
    typeof session.runtimeTerminalId !== "number");
}

function installTuiHooks(opts) {
  opts = opts || {};
  var tlsOptions = opts.tlsOptions || null;
  var portNum = opts.portNum || 2633;
  var osUsers = opts.osUsers || false;
  var users = opts.users;
  var debug = opts.debug || false;
  var claudeHookInstaller = opts.claudeHookInstaller || require("./claude-hook-installer");
  var osModule = opts.osModule || os;
  var osUsersModule = opts.osUsersModule || defaultOsUsers;

  try {
    var notifyScheme = tlsOptions ? "https" : "http";
    var notifyUrl = notifyScheme + "://127.0.0.1:" + portNum + "/api/tui-notify";
    var homes = [];
    if (osUsers) {
      var clayUsers = users && users.getAllUsers ? users.getAllUsers() : [];
      for (var ui = 0; ui < clayUsers.length; ui++) {
        var lu = clayUsers[ui] && clayUsers[ui].linuxUser;
        if (!lu) continue;
        try {
          var info = osUsersModule.resolveOsUserInfo(lu);
          if (info && info.home) homes.push(info.home);
        } catch (e) {}
      }
    }
    if (homes.length === 0) {
      homes = [osModule.homedir()];
    }
    var hookResult = claudeHookInstaller.installNotificationHook({
      notifyUrl: notifyUrl,
      homeDirs: homes,
    });
    if (hookResult.installed.length > 0) {
      console.log("[clay] installed Claude TUI notification hook in " + hookResult.installed.length + " settings.json file(s)");
    }
    if (hookResult.errors.length > 0 && debug) {
      console.warn("[clay] TUI hook install errors:", hookResult.errors);
    }

    var allowInstalledCount = 0;
    if (osUsers) {
      var clayUsersForAllow = users && users.getAllUsers ? users.getAllUsers() : [];
      for (var aui = 0; aui < clayUsersForAllow.length; aui++) {
        var cu = clayUsersForAllow[aui];
        if (!cu || !cu.linuxUser) continue;
        try {
          var auInfo = osUsersModule.resolveOsUserInfo(cu.linuxUser);
          if (!auInfo || !auInfo.home) continue;
          var extra = (typeof users.getClaudeUserAllowList === "function")
            ? (users.getClaudeUserAllowList(cu.id) || [])
            : [];
          var merged = (claudeHookInstaller.CLAY_MANAGED_ALLOW || []).concat(extra);
          var perUserRes = claudeHookInstaller.installAllowList({
            homeDirs: [auInfo.home],
            patterns: merged,
          });
          allowInstalledCount += perUserRes.installed.length;
        } catch (e) {}
      }
    } else {
      var soleExtra = [];
      try {
        var soleUsers = users && users.getAllUsers ? users.getAllUsers() : [];
        if (soleUsers.length > 0 && typeof users.getClaudeUserAllowList === "function") {
          soleExtra = users.getClaudeUserAllowList(soleUsers[0].id) || [];
        }
      } catch (e) {}
      var soleMerged = (claudeHookInstaller.CLAY_MANAGED_ALLOW || []).concat(soleExtra);
      var soleRes = claudeHookInstaller.installAllowList({
        homeDirs: [osModule.homedir()],
        patterns: soleMerged,
      });
      allowInstalledCount += soleRes.installed.length;
    }
    if (allowInstalledCount > 0) {
      console.log("[clay] installed Claude auto-approve allow-list in " + allowInstalledCount + " settings.json file(s)");
    }
  } catch (e) {
    if (debug) console.warn("[clay] TUI hook install failed:", e && e.message);
  }
}

module.exports = {
  installTuiHooks: installTuiHooks,
  shouldSuppressDetachedAdoptedSession: shouldSuppressDetachedAdoptedSession,
};
