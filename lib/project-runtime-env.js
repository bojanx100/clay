var runtimeEnv = require("./runtime-env");
var buildUserEnv = require("./build-user-env").buildUserEnv;

function readEnvrc(getter, arg) {
  if (typeof getter !== "function") return "";
  var result = arg === undefined ? getter() : getter(arg);
  return result && result.envrc || "";
}

function createProjectRuntimeEnvResolver(opts) {
  var slug = opts.slug;
  var getLinuxUserForSession = opts.getLinuxUserForSession || function () { return null; };
  var getOsUserInfoForLinuxUser = opts.getOsUserInfoForLinuxUser || function () { return null; };

  return function getRuntimeEnv(session) {
    session = session || {};
    var linuxUser = session.linuxUser || getLinuxUserForSession(session);
    var osUserInfo = linuxUser ? getOsUserInfoForLinuxUser(linuxUser) : null;
    return runtimeEnv.resolveRuntimeEnv({
      baseEnv: osUserInfo ? buildUserEnv(osUserInfo) : process.env,
      sharedEnvrc: readEnvrc(opts.onGetSharedEnv),
      projectEnvrc: readEnvrc(opts.onGetProjectEnv, slug),
    });
  };
}

module.exports = { createProjectRuntimeEnvResolver: createProjectRuntimeEnvResolver };
