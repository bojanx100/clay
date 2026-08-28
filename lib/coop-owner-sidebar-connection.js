// WebSocket boundary for durable owner-sidebar priority changes.

var priority = require("./coop-owner-sidebar-priority");

function ownerCheck(ctx) {
  return ctx.isCoopTopicOwner || ctx.opts && ctx.opts.isCoopTopicOwner;
}

function projectionProvider(ctx) {
  return ctx.getGlobalCoopProjection || ctx.opts && ctx.opts.getGlobalCoopProjection;
}

function priorityCandidates(projection) {
  var next = projection && projection.ownerSidebar && projection.ownerSidebar.next;
  return Array.isArray(next) ? next.map(function (entry) { return entry.topicRef || null; }) : [];
}

function ledgerEntries(projection) {
  var sidebar = projection && projection.ownerSidebar;
  return sidebar && Array.isArray(sidebar.entries) ? sidebar.entries : [];
}

function priorityOptions(ctx) {
  return ctx.coopOwnerSidebarPriorityOptions || ctx.opts && ctx.opts.coopOwnerSidebarPriorityOptions || {};
}

function refresh(ctx, ws) {
  var refreshAll = ctx.refreshCoopTopicViewers || ctx.opts && ctx.opts.refreshCoopTopicViewers;
  if (typeof refreshAll === "function") { refreshAll(); return; }
  var provider = projectionProvider(ctx);
  if (typeof provider === "function") {
    var projection = provider(ws);
    if (projection) ctx.sendTo(ws, projection);
  }
}

function handleOwnerSidebarMessage(ctx, ws, msg) {
  if (!msg || (msg.type !== "coop_owner_sidebar_prioritize" &&
      msg.type !== "coop_owner_ledger_visibility")) return false;
  var visibility = msg.type === "coop_owner_ledger_visibility";
  function reply(payload) {
    ctx.sendTo(ws, Object.assign({ type: visibility
      ? "coop_owner_ledger_visibility_result" : "coop_owner_sidebar_priority_result" }, payload));
  }
  var isOwner = ownerCheck(ctx);
  if (ctx.slug !== "lead" || typeof isOwner !== "function" || !isOwner(ws)) {
    reply({ ok: false, code: "access_denied" });
    return true;
  }
  var provider = projectionProvider(ctx);
  var projection = typeof provider === "function" ? provider(ws) : null;
  var expected = Number(msg.expectedRevision);
  var current = projection && projection.ownerSidebar && Number(projection.ownerSidebar.revision ||
    projection.ownerSidebar.priorityRevision) || 0;
  if (!projection || !projection.ownerSidebar) {
    reply({ ok: false, code: "owner_sidebar_unavailable" });
    return true;
  }
  if (!Number.isInteger(expected) || expected !== current) {
    reply({ ok: false, code: "stale_priority", currentRevision: current });
    return true;
  }
  var result = visibility
    ? priority.applyVisibility(msg.entryId, msg.hidden === true, ledgerEntries(projection), priorityOptions(ctx))
    : priority.applyPriority(msg.topicRef, msg.direction, priorityCandidates(projection), priorityOptions(ctx));
  if (!result.ok) {
    reply({ ok: false, code: result.code });
    return true;
  }
  reply({ ok: true, changed: !!result.changed, revision: result.priority.revision,
    priorityRevision: result.priority.revision });
  if (result.changed) refresh(ctx, ws);
  return true;
}

module.exports = { handleOwnerSidebarMessage: handleOwnerSidebarMessage };
