function attachBridgeAuth(ctx) {
  var yoke = require("./yoke");
  var getNotificationsModule = ctx.getNotificationsModule;
  var slug = ctx.slug;
  var adapter = ctx.adapter;
  var cachedFreshAuthStates = {};

  function getFreshAuthState(force, linuxUser) {
    var now = Date.now();
    var cacheKey = linuxUser ? "linux:" + linuxUser : "daemon";
    var cached = cachedFreshAuthStates[cacheKey];
    if (!force && cached && now - cached.at < 15000) {
      return cached.state;
    }
    if (force) yoke.invalidateAuthCache();
    var state = yoke.checkAuth({ linuxUser: linuxUser || null });
    cachedFreshAuthStates[cacheKey] = { state: state, at: now };
    return state;
  }

  function isAuthErrorMessage(errDetail) {
    if (!errDetail) return false;
    var errLower = String(errDetail).toLowerCase();
    return errLower.indexOf("not logged in") !== -1
      || errLower.indexOf("unauthenticated") !== -1
      || errLower.indexOf("authentication") !== -1
      || errLower.indexOf("sign in") !== -1
      || errLower.indexOf("log in") !== -1
      || errLower.indexOf("please login") !== -1;
  }

  function getLoginCommand(vendor) {
    var info = yoke.getVendorInfo(vendor);
    return (info && info.loginCommand) || "claude login";
  }

  function getVendorDisplayName(vendor) {
    var info = yoke.getVendorInfo(vendor);
    return (info && info.displayName) || "Claude Code";
  }

  function notifyAuthRequired(session, title, body, authLinuxUser, canAutoLogin, loginCommand) {
    var nm = getNotificationsModule();
    if (!nm) return false;
    nm.notify("auth_required", {
      title: title,
      body: body,
      slug: slug,
      sessionId: session.localId,
      ownerId: session.ownerId || null,
      vendor: session.vendor || (adapter && adapter.vendor) || "claude",
      loginCommand: loginCommand,
      linuxUser: authLinuxUser,
      canAutoLogin: canAutoLogin,
    });
    return true;
  }

  function logAuthDecision(stage, session, errDetail, authState) {
    var vendor = session && session.vendor ? session.vendor : "(none)";
    var errSnippet = errDetail ? String(errDetail).replace(/\s+/g, " ").slice(0, 180) : "";
    var authSummary = authState ? JSON.stringify(authState) : "(none)";
    console.warn("[sdk-bridge] auth decision [" + stage + "] vendor=" + vendor + " auth=" + authSummary + (errSnippet ? " err=" + errSnippet : ""));
  }

  return {
    getFreshAuthState: getFreshAuthState,
    isAuthErrorMessage: isAuthErrorMessage,
    getLoginCommand: getLoginCommand,
    getVendorDisplayName: getVendorDisplayName,
    notifyAuthRequired: notifyAuthRequired,
    logAuthDecision: logAuthDecision,
  };
}

module.exports = { attachBridgeAuth: attachBridgeAuth };
