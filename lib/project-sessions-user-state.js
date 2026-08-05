function attachProjectSessionsUserState(ctx) {
  var slug = ctx.slug;
  var isMate = ctx.isMate;
  var sendTo = ctx.sendTo;
  var usersModule = ctx.usersModule;
  var userPresence = ctx.userPresence;
  var leadMode = ctx.leadMode || require("./lead-mode");

  function resolveLeadOwnerId() {
    if (ctx.leadOwnerId) return ctx.leadOwnerId;
    if (typeof leadMode.resolveOwnerId !== "function") return null;
    return leadMode.resolveOwnerId({ usersModule: usersModule });
  }

  function handleUserStateMessage(ws, msg) {
    if (msg.type === "set_mate_dm") {
      // Only store mateDm on non-mate projects (main project presence).
      // Mate projects should never hold mateDm to avoid circular restore loops.
      if (!isMate) {
        var dmPresKey = ws._clayUser ? ws._clayUser.id : "_default";
        userPresence.setMateDm(slug, dmPresKey, msg.mateId || null);
      }
      return true;
    }

    if (msg.type === "whats_new_seen") {
      // Persist that the current user dismissed a What's New entry so it
      // is not shown again on future connects.
      var wnUserId = ws._clayUser ? ws._clayUser.id : null;
      if (!wnUserId) {
        sendTo(ws, { type: "whats_new_seen_result", ok: false, error: "no_user" });
        return true;
      }
      var wnSvc = require("./whats-new");
      var wnResult = wnSvc.markSeen(wnUserId, msg.id);
      if (wnResult && wnResult.ok) {
        sendTo(ws, { type: "whats_new_seen_result", ok: true, id: msg.id });
      } else {
        sendTo(ws, { type: "whats_new_seen_result", ok: false, error: (wnResult && wnResult.error) || "unknown" });
      }
      return true;
    }

    if (msg.type === "set_lead_mode") {
      // This is one server-wide setting. Members can read it but only the
      // Clay owner/admin path may write it; every result includes the stored
      // value so a changed checkbox cannot drift from authority.
      var lmOwnerId = resolveLeadOwnerId();
      var lmResult = leadMode.setLeadMode({
        enabled: msg.enabled,
        user: ws._clayUser || null,
        multiUser: !!(usersModule && usersModule.isMultiUser && usersModule.isMultiUser()),
        usersModule: usersModule,
        ownerId: lmOwnerId,
      });
      var lmState = lmResult && lmResult.state ? lmResult.state : leadMode.publicState(leadMode.getLeadModeState({ usersModule: usersModule, ownerId: lmOwnerId }));
      var lmCanChange = leadMode.isAuthority(ws._clayUser || null,
        !!(usersModule && usersModule.isMultiUser && usersModule.isMultiUser()), lmOwnerId);
      sendTo(ws, Object.assign({
        type: "set_lead_mode_result",
        ok: !!(lmResult && lmResult.ok),
        error: lmResult && lmResult.error,
        canChange: lmCanChange,
      }, lmState));
      if (lmResult && lmResult.ok) {
        leadMode.broadcast(Object.assign({ type: "lead_mode_changed" }, lmState));
      }
      return true;
    }

    if (msg.type === "set_claude_open_mode") {
      // Per-user preference: when Clay opens a Claude session, render it as
      // the SDK-driven custom chat ("gui") or as an embedded `claude` TUI
      // ("tui"). Applies to the next session open; currently displayed
      // sessions are not re-rendered retroactively.
      var comUserId = ws._clayUser ? ws._clayUser.id : "default";
      if (!comUserId) {
        sendTo(ws, { type: "set_claude_open_mode_result", ok: false, error: "no_user" });
        return true;
      }
      var comResult = usersModule.setClaudeOpenMode(comUserId, msg.value);
      if (comResult && comResult.ok) {
        sendTo(ws, { type: "set_claude_open_mode_result", ok: true, claudeOpenMode: comResult.claudeOpenMode });
        // Echo as a "changed" broadcast for this user's other tabs/devices.
        sendTo(ws, { type: "claude_open_mode_changed", claudeOpenMode: comResult.claudeOpenMode });
      } else {
        sendTo(ws, { type: "set_claude_open_mode_result", ok: false, error: (comResult && comResult.error) || "unknown" });
      }
      return true;
    }

    return false;
  }

  return {
    handleUserStateMessage: handleUserStateMessage,
  };
}

module.exports = { attachProjectSessionsUserState: attachProjectSessionsUserState };
