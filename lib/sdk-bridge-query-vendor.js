// Vendor readiness and auth reporting for query startup.

var usersModule = require("./users");
var executionFence = require("./coop-control-fence");

async function ensureInitialAdapter(ctx, session, linuxUser) {
  if (!session.vendor) return;
  var missing = !ctx.adapters[session.vendor];
  var ready = await ctx.ensureVendorReady(session.vendor, linuxUser);
  if (missing && ready) console.log("[sdk-bridge] Lazy adapter created for " + session.vendor);
}

async function recoverAuthenticatedAdapter(ctx, session, linuxUser) {
  if (!session.vendor || ctx.adapters[session.vendor]) return;
  var freshAuth = ctx.getFreshAuthState(true, linuxUser);
  ctx.logAuthDecision("pre-auth-required", session, null, freshAuth);
  if (!freshAuth[session.vendor]) return;
  var recovered = await ctx.ensureVendorReady(session.vendor, linuxUser);
  if (recovered) console.log("[sdk-bridge] Auth recheck recovered adapter for " + session.vendor);
}

function authUserState(session) {
  var user = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
  var linuxUser = user && user.linuxUser ? user.linuxUser : null;
  return {
    linuxUser: linuxUser,
    canAutoLogin: !usersModule.isMultiUser() || !!linuxUser || !!(user && user.role === "admin"),
  };
}

function abandonUnavailable(fence) {
  if (fence) fence.abandon("provider_unavailable");
  return fence ? { ok: false, reason: "provider_unavailable" } : undefined;
}

function reportUnavailable(ctx, session, linuxUser, fence) {
  var vendor = session.vendor;
  var vendorName = ctx.getVendorDisplayName(vendor);
  var auth = authUserState(session);
  var authState = ctx.getFreshAuthState(false, linuxUser);
  ctx.logAuthDecision("emit-auth-required", session, "missing adapter", authState);
  if (authState[vendor]) {
    ctx.sendAndRecord(session, { type: "error",
      text: vendorName + " auth is available, but the adapter could not be initialized." });
    ctx.sendAndRecord(session, { type: "done", code: 1 });
    return abandonUnavailable(fence);
  }
  var title = vendorName + " is not logged in.";
  var command = ctx.getLoginCommand(vendor);
  ctx.sendAndRecord(session, { type: "auth_required", text: title, vendor: vendor,
    loginCommand: command, linuxUser: auth.linuxUser, canAutoLogin: auth.canAutoLogin });
  ctx.notifyAuthRequired(session, title,
    "Open a terminal, then click the URL and follow the instructions.",
    auth.linuxUser, auth.canAutoLogin, command);
  ctx.sendAndRecord(session, { type: "done", code: 1 });
  return abandonUnavailable(fence);
}

async function prepareSessionAdapter(ctx, session, linuxUser, fence) {
  await ensureInitialAdapter(ctx, session, linuxUser);
  executionFence.assertAction(session, "provider_start", fence);
  await recoverAuthenticatedAdapter(ctx, session, linuxUser);
  executionFence.assertAction(session, "provider_start", fence);
  if (session.vendor && !ctx.adapters[session.vendor]) {
    return { result: reportUnavailable(ctx, session, linuxUser, fence) };
  }
  return { adapter: session.vendor && ctx.adapters[session.vendor] || ctx.adapter };
}

module.exports = { prepareSessionAdapter: prepareSessionAdapter };
