var usersModule = require("./users");
var { resolveOsUserInfo, grantProjectAccess } = require("./os-users");

function attachProjectOsUsers(ctx) {
  var cwd = ctx.cwd;
  var osUsers = !!ctx.osUsers;
  var osUserInfoCache = {};

  function getLinuxUserForSession(session) {
    if (!osUsers) return null;
    if (!session.ownerId) return null;
    var user = usersModule.findUserById(session.ownerId);
    if (!user || !user.linuxUser) return null;
    return user.linuxUser;
  }

  function ensureProjectAccessForSession(session) {
    var linuxUser = getLinuxUserForSession(session);
    if (linuxUser) {
      grantProjectAccess(cwd, linuxUser);
    }
    return linuxUser;
  }

  function getLinuxUserForWs(ws) {
    if (!osUsers) return null;
    if (!ws._clayUser || !ws._clayUser.linuxUser) return null;
    return ws._clayUser.linuxUser;
  }

  function getOsUserInfoForLinuxUser(linuxUser) {
    if (!linuxUser) return null;
    if (osUserInfoCache[linuxUser]) return osUserInfoCache[linuxUser];
    try {
      var info = resolveOsUserInfo(linuxUser);
      osUserInfoCache[linuxUser] = info;
      return info;
    } catch (e) {
      console.error("[project] Failed to resolve OS user info for " + linuxUser + ":", e.message);
      return null;
    }
  }

  function getOsUserInfoForWs(ws) {
    var linuxUser = getLinuxUserForWs(ws);
    if (!linuxUser) return null;
    return getOsUserInfoForLinuxUser(linuxUser);
  }

  function getOsUserInfoForReq(req) {
    if (!osUsers) return null;
    if (!req._clayUser || !req._clayUser.linuxUser) return null;
    return getOsUserInfoForLinuxUser(req._clayUser.linuxUser);
  }

  return {
    getLinuxUserForSession: getLinuxUserForSession,
    ensureProjectAccessForSession: ensureProjectAccessForSession,
    getOsUserInfoForLinuxUser: getOsUserInfoForLinuxUser,
    getOsUserInfoForWs: getOsUserInfoForWs,
    getOsUserInfoForReq: getOsUserInfoForReq,
  };
}

module.exports = {
  attachProjectOsUsers: attachProjectOsUsers,
};
