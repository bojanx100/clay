function attachProjectSessionsConfig(ctx) {
  var currentVersion = ctx.currentVersion;
  var sm = ctx.sm;
  var tm = ctx.tm;
  var clients = ctx.clients;
  var send = ctx.send;
  var sendTo = ctx.sendTo;
  var sendToAdmins = ctx.sendToAdmins;
  var opts = ctx.opts;
  var usersModule = ctx.usersModule;
  var fetchVersion = ctx.fetchVersion;
  var isNewer = ctx.isNewer;
  var getUpdateChannel = ctx.getUpdateChannel;
  var setUpdateChannel = ctx.setUpdateChannel;
  var getLatestVersion = ctx.getLatestVersion;
  var setLatestVersion = ctx.setLatestVersion;

  function isAdminOnlyDaemonMessage(msg) {
    return msg.type === "get_daemon_config"
      || msg.type === "set_pin"
      || msg.type === "set_keep_awake"
      || msg.type === "set_auto_continue"
      || msg.type === "set_inherit_groups"
      || msg.type === "set_image_retention"
      || msg.type === "shutdown_server"
      || msg.type === "restart_server";
  }

  function requireDaemonAdmin(ws, msg) {
    if (!isAdminOnlyDaemonMessage(msg)) return false;
    if (usersModule.isMultiUser()) {
      var wsUser = ws._clayUser;
      if (!wsUser || wsUser.role !== "admin") {
        sendTo(ws, { type: "error", message: "Admin access required" });
        return true;
      }
    }
    return false;
  }

  function handleConfigMessage(ws, msg) {
    if (msg.type === "set_update_channel") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return true;
      var newChannel = msg.channel === "beta" ? "beta" : "stable";
      setUpdateChannel(newChannel);
      setLatestVersion(null);
      if (typeof opts.onSetUpdateChannel === "function") {
        opts.onSetUpdateChannel(newChannel);
      }
      // Re-fetch with new channel and broadcast to admin clients
      fetchVersion(newChannel).then(function (v) {
        if (v && isNewer(v, currentVersion)) {
          setLatestVersion(v);
          sendToAdmins({ type: "update_available", version: v });
        }
      }).catch(function () {});
      return true;
    }

    if (msg.type === "check_update") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return true;
      var updateChannel = getUpdateChannel();
      fetchVersion(updateChannel).then(function (v) {
        if (v && isNewer(v, currentVersion)) {
          setLatestVersion(v);
          sendTo(ws, { type: "update_available", version: v });
        } else {
          sendTo(ws, { type: "up_to_date", version: currentVersion });
        }
      }).catch(function () {});
      return true;
    }

    if (msg.type === "update_now") {
      if (usersModule.isMultiUser() && (!ws._clayUser || ws._clayUser.role !== "admin")) return true;
      send({ type: "update_started", version: getLatestVersion() || "" });
      var ipc = require("./ipc");
      var config = require("./config");
      ipc.sendIPCCommand(config.socketPath(), { cmd: "update" });
      return true;
    }

    if (msg.type === "process_stats") {
      var sessionCount = sm.sessions.size;
      var processingCount = 0;
      sm.sessions.forEach(function (s) {
        if (s.isProcessing) processingCount++;
      });
      var mem = process.memoryUsage();
      sendTo(ws, {
        type: "process_stats",
        pid: process.pid,
        uptime: process.uptime(),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
        },
        sessions: sessionCount,
        processing: processingCount,
        clients: clients.size,
        terminals: tm.list().length,
      });
      return true;
    }

    if (requireDaemonAdmin(ws, msg)) return true;

    if (msg.type === "get_daemon_config") {
      if (typeof opts.onGetDaemonConfig === "function") {
        var daemonConfig = opts.onGetDaemonConfig();
        sendTo(ws, { type: "daemon_config", config: daemonConfig });
      }
      return true;
    }

    if (msg.type === "set_pin") {
      if (typeof opts.onSetPin === "function") {
        var pinResult = opts.onSetPin(msg.pin || null);
        sendTo(ws, { type: "set_pin_result", ok: pinResult.ok, pinEnabled: pinResult.pinEnabled });
      }
      return true;
    }

    if (msg.type === "set_keep_awake") {
      if (typeof opts.onSetKeepAwake === "function") {
        var kaResult = opts.onSetKeepAwake(msg.value);
        sendTo(ws, { type: "set_keep_awake_result", ok: kaResult.ok, keepAwake: kaResult.keepAwake });
        send({ type: "keep_awake_changed", keepAwake: kaResult.keepAwake });
      }
      return true;
    }

    if (msg.type === "set_auto_continue") {
      if (typeof opts.onSetAutoContinue === "function") {
        var acResult = opts.onSetAutoContinue(msg.value);
        sendTo(ws, { type: "set_auto_continue_result", ok: acResult.ok, autoContinueOnRateLimit: acResult.autoContinueOnRateLimit });
        send({ type: "auto_continue_changed", autoContinueOnRateLimit: acResult.autoContinueOnRateLimit });
      }
      return true;
    }

    if (msg.type === "set_inherit_groups") {
      if (typeof opts.onSetInheritGroups === "function") {
        var igResult = opts.onSetInheritGroups(msg.value);
        sendTo(ws, { type: "set_inherit_groups_result", ok: igResult.ok, inheritGroups: igResult.inheritGroups });
        send({ type: "inherit_groups_changed", inheritGroups: igResult.inheritGroups });
      }
      return true;
    }

    if (msg.type === "set_image_retention") {
      if (typeof opts.onSetImageRetention === "function") {
        var irResult = opts.onSetImageRetention(msg.days);
        sendTo(ws, { type: "set_image_retention_result", ok: irResult.ok, days: irResult.days });
      }
      return true;
    }

    if (msg.type === "shutdown_server") {
      if (typeof opts.onShutdown === "function") {
        sendTo(ws, { type: "shutdown_server_result", ok: true });
        send({ type: "toast", level: "warn", message: "Server is shutting down..." });
        // Small delay so the response has time to reach clients
        setTimeout(function () {
          opts.onShutdown();
        }, 500);
      } else {
        sendTo(ws, { type: "shutdown_server_result", ok: false, error: "Shutdown not supported" });
      }
      return true;
    }

    if (msg.type === "restart_server") {
      if (typeof opts.onRestart === "function") {
        sendTo(ws, { type: "restart_server_result", ok: true });
        send({ type: "toast", level: "info", message: "Server is restarting..." });
        // Small delay so the response has time to reach clients
        setTimeout(function () {
          opts.onRestart();
        }, 500);
      } else {
        sendTo(ws, { type: "restart_server_result", ok: false, error: "Restart not supported" });
      }
      return true;
    }

    return false;
  }

  return {
    handleConfigMessage: handleConfigMessage,
  };
}

module.exports = { attachProjectSessionsConfig: attachProjectSessionsConfig };
