var crypto = require("crypto");
var { claudePermissionForAutomation } = require("./automation-modes");
var { splitShellSegments } = require("./sdk-skill-discovery");
var { isSafeBashSegment } = require("./safe-bash-commands");

function attachBridgePermissions(ctx) {
  var sm = ctx.sm;
  var sendAndRecord = ctx.sendAndRecord;
  var onProcessingChanged = ctx.onProcessingChanged;
  var pushModule = ctx.pushModule;
  var getNotificationsModule = ctx.getNotificationsModule;
  var getRemoteMcpServers = ctx.getRemoteMcpServers;
  var slug = ctx.slug;
  var adapter = ctx.adapter;

  function checkToolWhitelist(toolName, input) {
    var readOnlyTools = { Read: true, Glob: true, Grep: true, WebFetch: true, WebSearch: true };
    if (readOnlyTools[toolName]) {
      return { behavior: "allow", updatedInput: input };
    }

    var safeBrowserTools = { browser_watch_tab: true, browser_unwatch_tab: true };
    if (toolName.indexOf("mcp__") === 0 && toolName.indexOf("__browser_") !== -1) {
      var mcpToolName = toolName.substring(toolName.lastIndexOf("__") + 2);
      if (safeBrowserTools[mcpToolName]) {
        return { behavior: "allow", updatedInput: input };
      }
    }

    if (toolName.indexOf("mcp__clay-debate__") === 0) {
      return { behavior: "allow", updatedInput: input };
    }

    var safeEmailTools = {
      clay_read_email: true,
      clay_read_email_body: true,
      clay_search_email: true,
      clay_list_labels: true,
    };
    if (toolName.indexOf("mcp__clay-email__") === 0) {
      var emailToolName = toolName.substring(toolName.lastIndexOf("__") + 2);
      if (safeEmailTools[emailToolName]) {
        return { behavior: "allow", updatedInput: input };
      }
    }

    if (toolName.indexOf("mcp__clay-datastore__") === 0) {
      return { behavior: "allow", updatedInput: input };
    }

    if (toolName.indexOf("mcp__clay-history__") === 0) {
      return { behavior: "allow", updatedInput: input };
    }

    var safeSchedulerTools = {
      scheduler_list: true,
      scheduler_get: true,
      scheduler_history: true,
    };
    if (toolName.indexOf("mcp__clay-scheduler__") === 0) {
      var schedulerToolName = toolName.substring(toolName.lastIndexOf("__") + 2);
      if (safeSchedulerTools[schedulerToolName]) {
        return { behavior: "allow", updatedInput: input };
      }
    }

    if (toolName.indexOf("mcp__") === 0 && getRemoteMcpServers) {
      var remoteMcpServers = getRemoteMcpServers();
      if (remoteMcpServers) {
        var mcpParts = toolName.split("__");
        var mcpServerName = mcpParts.length >= 2 ? mcpParts[1] : "";
        if (remoteMcpServers[mcpServerName]) {
          return { behavior: "allow", updatedInput: input };
        }
      }
    }

    if (toolName === "Bash" && input && input.command) {
      var cmd = input.command.trim();
      var segments = splitShellSegments(cmd);
      var allSafe = true;
      for (var si = 0; si < segments.length; si++) {
        if (!isSafeBashSegment(segments[si])) { allSafe = false; break; }
      }
      if (allSafe) {
        return { behavior: "allow", updatedInput: input };
      }
    }

    return null;
  }

  function handleCanUseTool(session, toolName, input, opts) {
    var sessionAutomationPermission = session && session.automationMode ? claudePermissionForAutomation(session.automationMode) : null;
    var effectivePermissionMode = (session && session.permissionMode) || sessionAutomationPermission || sm.currentPermissionMode || "default";
    if (effectivePermissionMode === "bypassPermissions" && toolName !== "AskUserQuestion") {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    if (session.loop && session.loop.active && session.loop.role !== "crafting") {
      if (toolName === "AskUserQuestion") {
        return Promise.resolve({ behavior: "deny", message: "Autonomous mode. Make your own decision." });
      }
      if (toolName === "EnterPlanMode") {
        return Promise.resolve({ behavior: "deny", message: "Do not enter plan mode. Execute directly." });
      }
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    var whitelisted = checkToolWhitelist(toolName, input);
    if (whitelisted) {
      return Promise.resolve(whitelisted);
    }

    if (toolName === "AskUserQuestion") {
      session.pendingAskUser[opts.toolUseID] = {
        input: input,
        mode: "mcp",
        sessionId: session.localId,
        postedAt: Date.now(),
      };
      return Promise.resolve({
        behavior: "deny",
        message: "The question card has been posted to the user. End this turn now without further commentary; the user's answer will arrive as the next user message, prefixed with \"[Answer to your AskUserQuestion]\" so you can recognize it.",
      });
    }

    if (session.allowedTools && session.allowedTools[toolName]) {
      return Promise.resolve({ behavior: "allow", updatedInput: input });
    }

    return new Promise(function(resolve) {
      var requestId = crypto.randomUUID();
      sm.permissionRequestIndex[requestId] = session.localId;
      session.pendingPermissions[requestId] = {
        resolve: resolve,
        requestId: requestId,
        toolName: toolName,
        toolInput: input,
        toolUseId: opts.toolUseID,
        decisionReason: opts.decisionReason || "",
      };

      var permMsg = {
        type: "permission_request",
        requestId: requestId,
        toolName: toolName,
        toolInput: input,
        toolUseId: opts.toolUseID,
        decisionReason: opts.decisionReason || "",
        vendor: session.vendor || (adapter && adapter.vendor) || "claude",
      };
      sendAndRecord(session, permMsg);
      onProcessingChanged();

      if (pushModule) {
        pushModule.sendPush({
          type: "permission_request",
          slug: slug,
          requestId: requestId,
          title: permissionPushTitle(toolName, input),
          body: permissionPushBody(toolName, input),
        });
      }

      var notificationsModule = getNotificationsModule();
      if (notificationsModule) {
        notificationsModule.notify("permission_request", {
          title: permissionPushTitle(toolName, input),
          body: permissionPushBody(toolName, input),
          slug: slug,
          sessionId: session.localId,
          ownerId: session.ownerId || null,
          requestId: requestId,
          toolName: toolName,
          toolInput: input,
        });
      }

      if (opts.signal) {
        opts.signal.addEventListener("abort", function() {
          delete session.pendingPermissions[requestId];
          delete sm.permissionRequestIndex[requestId];
          sendAndRecord(session, { type: "permission_cancel", requestId: requestId });
          onProcessingChanged();
          resolve({ behavior: "deny", message: "Request cancelled" });
        });
      }
    });
  }

  return {
    checkToolWhitelist: checkToolWhitelist,
    handleCanUseTool: handleCanUseTool,
    permissionPushTitle: permissionPushTitle,
    permissionPushBody: permissionPushBody,
  };
}

function permissionPushTitle(toolName, input) {
  if (!input) return "Claude wants to use " + toolName;
  var file = input.file_path ? input.file_path.split(/[/\\]/).pop() : "";
  switch (toolName) {
    case "Bash": return "Claude wants to run a command";
    case "Edit": return "Claude wants to edit " + (file || "a file");
    case "Write": return "Claude wants to write " + (file || "a file");
    case "Read": return "Claude wants to read " + (file || "a file");
    case "Grep": return "Claude wants to search files";
    case "Glob": return "Claude wants to find files";
    case "WebFetch": return "Claude wants to fetch a URL";
    case "WebSearch": return "Claude wants to search the web";
    case "Task": return "Claude wants to launch an agent";
    default: return "Claude wants to use " + toolName;
  }
}

function permissionPushBody(toolName, input) {
  if (!input) return "";
  var text = "";
  if (toolName === "Bash" && input.command) {
    text = input.command;
  } else if (toolName === "Edit" && input.file_path) {
    text = input.file_path.split(/[/\\]/).pop() + ": " + (input.old_string || "").substring(0, 40) + " \u2192 " + (input.new_string || "").substring(0, 40);
  } else if (toolName === "Write" && input.file_path) {
    text = input.file_path;
  } else if (input.file_path) {
    text = input.file_path;
  } else if (input.command) {
    text = input.command;
  } else if (input.url) {
    text = input.url;
  } else if (input.query) {
    text = input.query;
  } else if (input.pattern) {
    text = input.pattern;
  } else if (input.description) {
    text = input.description;
  }
  if (text.length > 120) text = text.substring(0, 120) + "...";
  return text;
}

module.exports = { attachBridgePermissions: attachBridgePermissions };
