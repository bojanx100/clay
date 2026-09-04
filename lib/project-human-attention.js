function attachProjectHumanAttention(ctx) {
  var service = ctx.service || null;
  var slug = ctx.slug;
  var sendTo = ctx.sendTo;

  function userIdFor(ws) {
    return ws && ws._clayUser && ws._clayUser.id || "_default";
  }

  function signalInput(ws, msg) {
    return {
      userId: userIdFor(ws),
      projectSlug: slug,
      sessionId: ws && ws._clayActiveSession || null,
      visible: msg.visible === true,
      focused: msg.focused === true,
      engaged: msg.engaged === true,
      interaction: msg.interaction === true,
      timezoneOffsetMinutes: msg.timezoneOffsetMinutes,
    };
  }

  function handleMessage(ws, msg) {
    if (!service || !msg) return false;
    if (msg.type === "human_attention_signal") {
      sendTo(ws, service.signal(ws, signalInput(ws, msg)));
      return true;
    }
    if (msg.type === "human_attention_query") {
      sendTo(ws, service.summary(userIdFor(ws), msg.timezoneOffsetMinutes, slug));
      return true;
    }
    if (msg.type === "human_attention_cap_set") {
      var result = service.setCapMinutes(userIdFor(ws), msg.capMinutes);
      if (!result.ok) {
        sendTo(ws, { type: "human_attention_error", error: result.error });
      } else {
        sendTo(ws, service.summary(userIdFor(ws), msg.timezoneOffsetMinutes, slug));
      }
      return true;
    }
    return false;
  }

  return { handleMessage: handleMessage };
}

module.exports = { attachProjectHumanAttention: attachProjectHumanAttention };
