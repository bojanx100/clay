function attachBridgeAuth(ctx) {
  var getNotificationsModule = ctx.getNotificationsModule;
  var slug = ctx.slug;
  var adapter = ctx.adapter;
  var cachedFreshAuthState = null;
  var cachedFreshAuthAt = 0;

  function getFreshAuthState(force) {
    var yoke = require("./yoke");
    var now = Date.now();
    if (!force && cachedFreshAuthState && now - cachedFreshAuthAt < 15000) {
      return cachedFreshAuthState;
    }
    if (force) yoke.invalidateAuthCache();
    cachedFreshAuthState = yoke.checkAuth();
    cachedFreshAuthAt = now;
    return cachedFreshAuthState;
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
    if (vendor === "codex") return "codex login --device-auth";
    if (vendor === "github-copilot") return "copilot login";
    if (vendor === "claude") return "claude login";
    return (vendor || "claude") + " login";
  }

  function getVendorDisplayName(vendor) {
    if (vendor === "codex") return "Codex";
    if (vendor === "github-copilot") return "GitHub Copilot";
    return "Claude Code";
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
