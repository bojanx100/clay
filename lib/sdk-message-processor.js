var usersModule = require("./users");
var yoke = require("./yoke");
var { listProviderRoutes, routeForId, knownModelsForProvider, knownModelsForRoute } = require("./provider-routes");
var sessionWorktree = require("./session-worktree");
var rateLimitUsageCache = require("./rate-limit-usage-cache");
var handoffContextModule = require("./handoff-context");
var { isContextOverflowError } = require("./sdk-bridge-stream");
var { isModelSwitchInformational } = require("./sdk-informational-events");
var providerHealth = require("./provider-health");
var { queuePendingProviderFailover, recordProviderFailure } = require("./sdk-provider-failover-signals");
var { isCopilotQuotaError } = require("./provider-quota-errors");
var { clearStaleProcessingState } = require("./sessions-queued-messages");
var shouldSuppressOwnerNotification =
  require("./coop-control-provenance").shouldSuppressOwnerNotification;

function attachMessageProcessor(ctx) {
  var sm = ctx.sm;
  var usersApi = ctx.usersModule || usersModule;
  var send = ctx.send;
  var slug = ctx.slug;
  var isMate = ctx.isMate;
  var mateDisplayName = ctx.mateDisplayName;
  var pushModule = ctx.pushModule;
  var getNotificationsModule = ctx.getNotificationsModule || function () { return null; };
  var getSDK = ctx.getSDK;
  var adapter = ctx.adapter;
  var cwd = ctx.cwd;
  var onProcessingChanged = ctx.onProcessingChanged;
  var onTurnDone = ctx.onTurnDone;
  var onAutoTitle = ctx.onAutoTitle;
  var opts = ctx.opts;
  var discoverSkillDirs = ctx.discoverSkillDirs;
  var mergeSkills = ctx.mergeSkills;
  var isTransientStreamError = ctx.isTransientStreamError || function () { return false; };
  var autoResumeAllowed = ctx.autoResumeAllowed || function () { return false; };
  var scheduleInterruptResume = ctx.scheduleInterruptResume || null;
  var onWorktreeChange = ctx.onWorktreeChange || function () {};
  var saveImageFile = ctx.saveImageFile || null;
  var getLinuxUserForSession = ctx.getLinuxUserForSession || function () { return null; };
  var getFreshAuthState = ctx.getFreshAuthState || function () { return {}; };

  // Auto-resume a turn whose only output was a transient "API Error:" delivered
  // in-band (assistant message + normal result, not a thrown error) — e.g. the
  // SDK's "socket connection was closed unexpectedly". Mirrors the thrown-error
  // and truncated-stream retry policy: one shot, budget-capped, never on a user
  // stop. Returns true if a resume was scheduled.
  function maybeAutoResumeTransientApiError(session, text, requireApiPrefix) {
    if (!session || !text || !scheduleInterruptResume) return false;
    var t = String(text).trim();
    if (requireApiPrefix && !/^API Error:/i.test(t)) return false;
    if (!isTransientStreamError(t)) return false;
    if (session.taskStopRequested || session._transientRetryUsed) return false;
    if (!autoResumeAllowed(session)) return false;
    session._transientRetryUsed = true;
    sendAndRecord(session, { type: "info", text: "Connection dropped mid-response. Retrying…", variant: "recovery" });
    scheduleInterruptResume(session);
    return true;
  }

  var AUTO_TITLE_TURN_THRESHOLD = 2;

  function getMateIdForNotification() {
    if (!isMate) return null;
    if (typeof slug === "string" && slug.indexOf("mate-") === 0) {
      return slug.substring(5) || null;
    }
    return null;
  }

  function sendAndRecord(session, obj) {
    sm.sendAndRecord(session, obj);
  }

  function attachToolResultImages(session, entry, images) {
    if (!Array.isArray(images) || images.length === 0) return;
    var liveImages = [];
    var imageRefs = [];
    for (var imageIndex = 0; imageIndex < images.length; imageIndex++) {
      var image = images[imageIndex];
      if (!image) continue;
      var mediaType = image.mediaType || "";
      var base64Data = image.data || "";
      if (!base64Data && typeof image.url === "string") {
        var dataMatch = image.url.match(/^data:([^;,]+);base64,(.+)$/);
        if (dataMatch) {
          mediaType = dataMatch[1];
          base64Data = dataMatch[2];
        }
      }
      if (base64Data && mediaType && saveImageFile) {
        var savedToolImage = saveImageFile(mediaType, base64Data, getLinuxUserForSession(session));
        if (savedToolImage) {
          imageRefs.push({ mediaType: mediaType, file: savedToolImage });
          liveImages.push({
            mediaType: mediaType,
            url: "/p/" + slug + "/images/" + savedToolImage,
          });
          continue;
        }
      }
      if (typeof image.url === "string") {
        liveImages.push({ url: image.url });
      } else if (base64Data && mediaType) {
        // Disk save was unavailable, so this base64 would be persisted into the
        // transcript and re-loaded on every session open. Keep small images
        // inline; drop oversized ones rather than bloating the session file.
        var MAX_INLINE_IMAGE_BASE64 = 512 * 1024; // ~384KB decoded
        if (base64Data.length <= MAX_INLINE_IMAGE_BASE64) {
          liveImages.push({ mediaType: mediaType, data: base64Data });
        } else {
          console.warn("[sdk] Dropping oversized inline image (" + base64Data.length +
            " base64 chars) from transcript; image file save was unavailable.");
        }
      }
    }
    if (liveImages.length > 0) entry.images = liveImages;
    if (imageRefs.length > 0) entry.imageRefs = imageRefs;
  }

  function isMonthlySpendLimitText(text) {
    if (!text) return false;
    var str = String(text);
    // The real provider error is a one-liner. Long content that merely CONTAINS
    // the phrases (e.g. a tool result dumping this very source file, or an
    // assistant message discussing spend limits while working on Clay itself)
    // must not be swallowed and must not cancel scheduled resumes.
    if (str.length > 500) return false;
    var lower = str.toLowerCase();
    return lower.indexOf("monthly spend limit") !== -1
      && (lower.indexOf("usage-credits") !== -1
        || lower.indexOf("admin-settings/usage") !== -1
        || lower.indexOf("/model to switch models") !== -1);
  }

  function handleProviderQuota(session, text) {
    var exhaustedVendor = session.vendor || (adapter && adapter.vendor) || "claude";
    var isClaudeSpendLimit = isMonthlySpendLimitText(text);
    var isCopilotQuota = exhaustedVendor === "github-copilot" && isCopilotQuotaError(text);
    if (!isClaudeSpendLimit && !isCopilotQuota) return false;
    var resetsAt = isCopilotQuota ? null : (session.rateLimitResetsAt || session.rateLimitLastResetsAt ||
      (session.scheduledMessage && session.scheduledMessage.resetsAt) || null);
    var failureReason = isCopilotQuota ? "provider-quota-exhausted" : "usage-credits-exhausted";
    session.rateLimitResetsAt = null;
    session.rateLimitUseCreditsPending = false;
    session.rateLimitAutoContinuePending = false;
    recordProviderFailure(session, exhaustedVendor, failureReason, {
      immediate: true,
      unavailableUntil: typeof resetsAt === "number" ? resetsAt : null,
    });
    if (session.providerFailoverPending) session.providerFailoverPending.resetsAt = resetsAt;
    if (typeof opts.cancelScheduledMessage === "function") {
      opts.cancelScheduledMessage(session);
    }
    var notificationKey = isCopilotQuota ? "copilotQuotaNotified" : "monthlySpendLimitNotified";
    if (!session[notificationKey]) {
      session[notificationKey] = true;
      sendAndRecord(session, {
        type: "info",
        text: isCopilotQuota
          ? "GitHub Copilot quota is exhausted for this account. Clay is switching this session to another healthy provider."
          : "Claude usage credits are exhausted for this organization. Run /usage-credits in Claude or ask an admin to raise the monthly spend limit before continuing with Claude.",
        variant: "warning",
      });
    }
    return true;
  }

  function providerDisplayName(session) {
    if (session && session.providerRouteId) {
      var route = routeForId(session.providerRouteId);
      if (route && route.label) return route.label;
    }
    var vendor = session && session.vendor ? session.vendor : ((adapter && adapter.vendor) || "claude");
    if (vendor === "codex") return "Codex";
    if (vendor === "github-copilot") return "GitHub Copilot";
    return "Claude";
  }

  function recordProductiveTurnSuccess(session) {
    providerHealth.recordSuccess(session.vendor || (adapter && adapter.vendor) || "claude", {
      providerRouteId: session.providerRouteId || null,
      model: session.verifiedModel || session.requestedModel || session.model || null,
    });
  }

  function normalizeExecutionError(session, text) {
    var msg = text || "Unknown SDK error";
    if (session && session.vendor === "github-copilot" &&
        msg.indexOf("You are not authorized to use this Copilot feature") !== -1) {
      return "GitHub Copilot is installed and logged in, but this account or organization is not authorized to use the Copilot CLI agent/ACP feature. Enable the required Copilot policy for your GitHub organization/account, then retry. Original error: " + msg;
    }
    return msg;
  }

  function sendToSession(session, obj) {
    sm.sendToSession(session, obj);
  }

  // Emit the "not logged in" signal (WS message + notification) so the client
  // auto-opens the login modal. Shared by the Claude path (login-prompt text
  // detection) and the Codex path (app-server unauthorized error). Deduped
  // per session to avoid spamming when multiple auth errors arrive in a burst.
  function emitAuthRequired(session) {
    var now = Date.now();
    if (session._lastAuthEmit && (now - session._lastAuthEmit) < 5000) return;
    session._lastAuthEmit = now;

    // Guard against false positives before showing an explicit login action.
    // The codex app-server can surface a transient/stale "unauthorized" while
    // auth.json is actually valid. A device-auth command replaces the prior
    // auth.json at startup, so a false auth_required can lead a user to
    // unnecessarily replace a working credential. Force a fresh
    // `<vendor> login status` check and suppress if the vendor is logged in.
    try {
      var authNow = getFreshAuthState(true, getLinuxUserForSession(session));
      if (session.vendor && authNow[session.vendor]) {
        console.warn("[msg-processor] Suppressing auth_required for " + session.vendor + ": fresh auth check shows logged in");
        return;
      }
    } catch (e) {}

    var authUser = session.ownerId ? usersModule.findUserById(session.ownerId) : null;
    var authLinuxUser = authUser && authUser.linuxUser ? authUser.linuxUser : null;
    var canAutoLogin = !usersModule.isMultiUser()
      || !!authLinuxUser
      || (authUser && authUser.role === "admin");
    var vendorInfo = yoke.getVendorInfo(session.vendor);
    var authTitle = ((vendorInfo && vendorInfo.displayName) || "Claude Code") + " is not logged in.";
    var loginCommand = (vendorInfo && vendorInfo.loginCommand) || "claude login";
    var _nmLogin = getNotificationsModule();
    sendAndRecord(session, {
      type: "auth_required",
      text: authTitle,
      vendor: session.vendor || "claude",
      loginCommand: loginCommand,
      linuxUser: authLinuxUser,
      canAutoLogin: canAutoLogin,
    });
    if (_nmLogin) {
      _nmLogin.notify("auth_required", {
        title: authTitle,
        body: "Open a terminal, then click the URL and follow the instructions.",
        slug: slug,
        sessionId: session.localId,
        ownerId: session.ownerId || null,
        vendor: session.vendor || "claude",
        loginCommand: loginCommand,
        linuxUser: authLinuxUser,
        canAutoLogin: canAutoLogin,
      });
    }
    // Reset CLI session so the next query starts fresh with new auth.
    session.cliSessionId = null;
  }

  // The conversation exceeded the model's context window and cannot continue.
  // Surface it to the alarm center + push once per episode (automation sessions
  // often run AFK), so a human knows to open a fresh conversation. Deduped via a
  // latch that a genuine new turn clears elsewhere, mirroring notifyResumeGaveUp.
  function notifyContextOverflow(session) {
    if (session._contextOverflowNotified) return;
    session._contextOverflowNotified = true;
    var title = (session.title || "Session") + " — conversation too long";
    var body = "The conversation exceeded the model's context window. Start a new conversation to continue.";
    var suppressed = shouldSuppressOwnerNotification(session, usersApi);
    var nm = getNotificationsModule();
    if (!suppressed && nm) {
      try {
        nm.notify("needs_input", {
          title: title,
          preview: body,
          slug: slug,
          sessionId: session.localId,
          ownerId: session.ownerId || null,
        });
      } catch (e) {}
    }
    if (!suppressed && pushModule) {
      try {
        pushModule.sendPush({
          type: "needs_input",
          slug: slug,
          title: title,
          body: body,
          tag: "clay-overflow-" + session.localId,
        });
      } catch (e) {}
    }
  }

  function getModelsForSession(session, vendor) {
    if (vendor === "github-copilot") {
      var copilotModels = knownModelsForProvider("github-copilot");
      if (copilotModels.length > 0) return copilotModels;
    }
    if (session && session.providerRouteId) {
      var route = routeForId(session.providerRouteId);
      var routeModels = knownModelsForRoute(route);
      if (routeModels.length > 0) return routeModels;
    }
    if (vendor && sm.modelsByVendor && sm.modelsByVendor[vendor]) return sm.modelsByVendor[vendor];
    return sm.availableModels || [];
  }

  function copilotRouteIdForModel(model) {
    if (!model) return null;
    if (model.indexOf("claude-") === 0) return "claude-github-copilot";
    if (model.indexOf("gpt-") === 0 || model.indexOf("codex") !== -1) return "codex-github-copilot";
    return null;
  }

  function canonicalModelId(model) {
    return String(model || "").toLowerCase().replace(/[-.]/g, "");
  }

  function modelListContains(list, modelId) {
    if (!list || !modelId) return false;
    var wanted = canonicalModelId(modelId);
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      var value = typeof entry === "string" ? entry : (entry && (entry.value || entry.model || entry.id)) || "";
      if (canonicalModelId(value) === wanted) return true;
    }
    return false;
  }

  function applyModelVerification(session, parsed) {
    if (!session || !parsed || !parsed.model) return;
    // Dedup: if this exact model was already verified, skip the redundant
    // saveSessionFile + broadcastSessionList + model_verified send this turn.
    if (session.verifiedModel === parsed.model) return;
    // Validate the provider-supplied model against the known model list for the
    // session before persisting. An unknown value must not overwrite
    // session.model / providerRouteId. Only enforce when we actually have a
    // non-empty list to check against (unknown vendors have no list).
    var verificationVendor = session.vendor || ((adapter && adapter.vendor) || null);
    var knownModels = getModelsForSession(session, verificationVendor);
    if (knownModels && knownModels.length > 0 && !modelListContains(knownModels, parsed.model)) {
      console.warn("[sdk-message-processor] ignoring unknown verified model for session " + session.localId + ": " + parsed.model);
      return;
    }
    session.verifiedModel = parsed.model;
    session.requestedModel = parsed.requestedModel || session.requestedModel || session.model || null;
    session.modelVerificationSource = parsed.source || parsed.modelVerificationSource || "response";
    if ((session.vendor || ((adapter && adapter.vendor) || null)) === "github-copilot") {
      session.model = session.verifiedModel;
      var verifiedRouteId = copilotRouteIdForModel(session.verifiedModel);
      if (verifiedRouteId) session.providerRouteId = verifiedRouteId;
    }
    try { sm.saveSessionFile(session); } catch (e) {}
    if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    sendToSession(session, {
      type: "model_verified",
      model: session.verifiedModel,
      requestedModel: session.requestedModel,
      source: session.modelVerificationSource,
      vendor: session.vendor || ((adapter && adapter.vendor) || null),
      providerRouteId: session.providerRouteId || null,
    });
  }

  function toolActivityTextForSubagent(name, input) {
    if (name === "Bash" && input && input.description) return input.description;
    if (name === "Read" && input && input.file_path) return "Reading " + input.file_path.split("/").pop();
    if (name === "Edit" && input && input.file_path) return "Editing " + input.file_path.split("/").pop();
    if (name === "Write" && input && input.file_path) return "Writing " + input.file_path.split("/").pop();
    if (name === "Grep" && input && input.pattern) return "Searching for " + input.pattern;
    if (name === "Glob" && input && input.pattern) return "Finding " + input.pattern;
    if (name === "WebSearch" && input && input.query) return "Searching: " + input.query;
    if (name === "WebFetch") return "Fetching URL...";
    if (name === "Task" && input && input.description) return input.description;
    return "Running " + name + "...";
  }

  function processSubagentMessage(session, parsed) {
    var parentId = parsed.parentToolUseId;
    var content = parsed.content;
    if (!Array.isArray(content)) return;

    if (parsed.messageRole === "assistant") {
      // Extract tool_use blocks from sub-agent assistant messages
      for (var i = 0; i < content.length; i++) {
        var block = content[i];
        if (block.type === "tool_use") {
          var activityText = toolActivityTextForSubagent(block.name, block.input);
          sendAndRecord(session, {
            type: "subagent_tool",
            parentToolId: parentId,
            toolName: block.name,
            toolId: block.id,
            text: activityText,
          });
        } else if (block.type === "thinking") {
          sendAndRecord(session, {
            type: "subagent_activity",
            parentToolId: parentId,
            text: "Thinking...",
          });
        } else if (block.type === "text" && block.text) {
          sendAndRecord(session, {
            type: "subagent_activity",
            parentToolId: parentId,
            text: "Writing response...",
          });
        }
      }
    }
    // user messages with parentToolUseId contain tool_results -- skip silently
  }

  function processSDKMessage(session, parsed) {
    if (session) session._lastStreamEventAt = Date.now();
    // Timing: log key SDK milestones relative to query start
    if (session._queryStartTs) {
      var _elapsed = Date.now() - session._queryStartTs;
      if (parsed.yokeType === "init") {
        console.log("[PERF] processSDKMessage: system/init +" + _elapsed + "ms");
      }
      if (parsed.yokeType === "turn_start") {
        console.log("[PERF] processSDKMessage: message_start (API response begun) +" + _elapsed + "ms");
      }
      if ((parsed.yokeType === "text_delta" || parsed.yokeType === "tool_input_delta" || parsed.yokeType === "thinking_delta") && !session._firstTextLogged) {
        session._firstTextLogged = true;
        console.log("[PERF] processSDKMessage: FIRST content_block_delta (visible text) +" + _elapsed + "ms");
      }
      if (parsed.yokeType === "result") {
        console.log("[PERF] processSDKMessage: result +" + _elapsed + "ms");
      }
    }

    // Extract session_id from any message that carries it
    if (parsed.sessionId && !session.cliSessionId) {
      if (!session.storageId) session.storageId = parsed.sessionId;
      session.cliSessionId = parsed.sessionId;
      sm.saveSessionFile(session);
      sendAndRecord(session, { type: "session_id", cliSessionId: session.cliSessionId });
    } else if (parsed.sessionId && parsed.sessionId !== session.cliSessionId) {
      if (!session.storageId) session.storageId = session.cliSessionId;
      session.cliSessionId = parsed.sessionId;
      sm.saveSessionFile(session);
    } else if (parsed.sessionId) {
      session.cliSessionId = parsed.sessionId;
    }

    // Capture message UUIDs for rewind support
    if (parsed.uuid) {
      if (parsed.messageType === "user" && !parsed.parentToolUseId) {
        session.messageUUIDs.push({ uuid: parsed.uuid, type: "user", historyIndex: session.history.length });
        sendAndRecord(session, { type: "message_uuid", uuid: parsed.uuid, messageType: "user" });
      } else if (parsed.messageType === "assistant") {
        session.messageUUIDs.push({ uuid: parsed.uuid, type: "assistant", historyIndex: session.history.length });
        sendAndRecord(session, { type: "message_uuid", uuid: parsed.uuid, messageType: "assistant" });
      }
    }

    // Cache slash_commands and model from CLI init message
    if (parsed.yokeType === "init") {
      var fsSkills = discoverSkillDirs();
      sm.skillNames = mergeSkills(parsed.skills, fsSkills);
      if (parsed.slashCommands) {
        // Union: SDK slash_commands + merged skills (deduplicated)
        var seen = new Set();
        var combined = [];
        var all = parsed.slashCommands.concat(Array.from(sm.skillNames));
        for (var k = 0; k < all.length; k++) {
          if (!seen.has(all[k])) {
            seen.add(all[k]);
            combined.push(all[k]);
          }
        }
        sm.slashCommands = combined;
        send({ type: "slash_commands", commands: sm.slashCommands });
      }
      if (parsed.model) {
        var initVendor = session.vendor || (adapter && adapter.vendor) || "claude";
        var initModels = getModelsForSession(session, initVendor);
        if (initVendor === "github-copilot") {
          if (modelListContains(initModels, parsed.model)) {
            sm.currentModel = parsed.model;
            session.model = parsed.model;
            var parsedRouteId = copilotRouteIdForModel(parsed.model);
            if (parsedRouteId) session.providerRouteId = parsedRouteId;
            try { sm.saveSessionFile(session); } catch (e) {}
            if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
          }
        } else {
          sm.currentModel = sm.currentModel || sm._savedDefaultModel || parsed.model;
        }
        var modelToSend = "";
        if (modelListContains(initModels, session.model)) {
          modelToSend = session.model;
        } else if (modelListContains(initModels, sm.currentModel)) {
          modelToSend = sm.currentModel;
        }
        if (!modelToSend && initModels.length > 0) {
          var firstInitModel = initModels[0];
          modelToSend = typeof firstInitModel === "string" ? firstInitModel : (firstInitModel && (firstInitModel.value || firstInitModel.model || firstInitModel.id)) || "";
        }
        sendToSession(session, {
          type: "model_info",
          model: modelToSend,
          models: initModels,
          vendor: initVendor,
          providerRouteId: session.providerRouteId || null,
          requestedModel: session.requestedModel || session.model || null,
          verifiedModel: session.verifiedModel || null,
          modelVerificationSource: session.modelVerificationSource || null,
          availableVendors: sm.availableVendors || [],
          installedVendors: sm.installedVendors || [],
          providerRoutes: sm.providerRoutes || listProviderRoutes(sm.availableVendors || [], sm.installedVendors || []),
        });
      }
      if (parsed.fastModeState) {
        sendAndRecord(session, { type: "fast_mode_state", state: parsed.fastModeState });
      }
    }

    if (parsed.yokeType === "turn_start") {
      if (!session.isProcessing) {
        session.isProcessing = true;
        onProcessingChanged();
        sendToSession(session, { type: "status", status: "processing" });
        sm.broadcastSessionList();
      }
      session.blocks = {};
      session.sentToolResults = {};
      session.streamedText = false;
      session.responsePreview = "";
      // Reset the task-workflow response accumulator so stale text can't leak
      // into the next turn's completion-marker check or grow unbounded.
      session._taskWorkflowResponseText = "";
      session._firstTextLogged = false;
      if (parsed.inputTokens) {
        session.lastStreamInputTokens = parsed.inputTokens;
      }
      session._copilotTextStartedThisTurn = false;
      // Track whether the turn produced ANY output (text, thinking, or a tool
      // call). A turn that ends with no activity and zero cost is an empty
      // completion - the provider session is wedged or rate-limited and the
      // user would otherwise see a silent blank. See the result handler below.
      session._turnSawActivity = false;
      // Reset the captured stop_reason; set from message_delta below and read in
      // the result handler to flag a max_tokens truncation.
      session._lastStopReason = null;

    } else if (parsed.yokeType === "message_delta") {
      if (parsed.stopReason) session._lastStopReason = parsed.stopReason;

    } else if (parsed.yokeType === "tool_start" || parsed.yokeType === "thinking_start" || parsed.yokeType === "text_start") {
      var idx = parsed.blockId;
      session._turnSawActivity = true;

      if (parsed.yokeType === "tool_start") {
        session.blocks[idx] = { type: "tool_use", id: parsed.toolId, name: parsed.toolName, inputJson: "" };
        sendAndRecord(session, { type: "tool_start", id: parsed.toolId, name: parsed.toolName });
      } else if (parsed.yokeType === "thinking_start") {
        session.blocks[idx] = { type: "thinking", thinkingText: "", startTime: Date.now() };
        sendAndRecord(session, { type: "thinking_start" });
      } else if (parsed.yokeType === "text_start") {
        if (session.vendor === "github-copilot" && session._copilotTextStartedThisTurn) {
          sendAndRecord(session, { type: "delta", text: "\n\n" });
        }
        session._copilotTextStartedThisTurn = true;
        session.blocks[idx] = { type: "text" };
      }

    } else if (parsed.yokeType === "text_delta" || parsed.yokeType === "text_replace" || parsed.yokeType === "tool_input_delta" || parsed.yokeType === "thinking_delta") {
      var idx = parsed.blockId;
      session._turnSawActivity = true;

      if (parsed.yokeType === "text_delta" && typeof parsed.text === "string") {
        if (handleProviderQuota(session, parsed.text)) return;
        session.streamedText = true;
        if (session.responsePreview.length < 200) {
          session.responsePreview += parsed.text;
        }
        if (session.taskLauncher && session.taskLauncher.completion && session.taskLauncher.completion.marker) {
          session._taskWorkflowResponseText = (session._taskWorkflowResponseText || "") + parsed.text;
        }
        // Accumulate text for mate DM response
        if (typeof session._mateDmResponseText === "string") {
          session._mateDmResponseText += parsed.text;
        }
        sendAndRecord(session, { type: "delta", text: parsed.text });
      } else if (parsed.yokeType === "text_replace" && typeof parsed.text === "string") {
        if (handleProviderQuota(session, parsed.text)) return;
        session.streamedText = true;
        session.responsePreview = parsed.text.substring(0, 200);
        if (session.taskLauncher && session.taskLauncher.completion && session.taskLauncher.completion.marker) {
          session._taskWorkflowResponseText = parsed.text;
        }
        if (typeof session._mateDmResponseText === "string") {
          session._mateDmResponseText = parsed.text;
        }
        sendAndRecord(session, { type: "delta_replace", text: parsed.text });
      } else if (parsed.yokeType === "tool_input_delta" && session.blocks[idx]) {
        session.blocks[idx].inputJson += parsed.partialJson;
      } else if (parsed.yokeType === "thinking_delta" && session.blocks[idx]) {
        session.blocks[idx].thinkingText += parsed.text;
        sendAndRecord(session, { type: "thinking_delta", text: parsed.text });
      }

    } else if (parsed.yokeType === "tool_executing") {
      sendAndRecord(session, {
        type: "tool_executing",
        id: parsed.toolId,
        name: parsed.toolName,
        input: parsed.input || {},
      });
      try { if (sessionWorktree.noteTool(cwd, session, parsed.toolName, parsed.input || {})) onWorktreeChange(session); } catch (e) {}

    } else if (parsed.yokeType === "tool_result") {
      if (handleProviderQuota(session, parsed.content || "")) return;
      var toolResultEntry = {
        type: "tool_result",
        id: parsed.toolId,
        content: parsed.content || "",
        is_error: !!parsed.isError,
      };
      attachToolResultImages(session, toolResultEntry, parsed.images);
      sendAndRecord(session, toolResultEntry);

    } else if (parsed.yokeType === "tool_output") {
      // Live, coalesced stdout/stderr for a running command. Send-only (NOT
      // recorded): the final tool_result carries the complete output, so
      // persisting these deltas would bloat session history and slow replay.
      send({
        type: "tool_output",
        id: parsed.toolId,
        text: parsed.text || "",
      });

    } else if (parsed.yokeType === "plan_updated") {
      var todos = Array.isArray(parsed.plan) ? parsed.plan.map(function(step, idx) {
        var todo = {
          id: String(idx + 1),
          content: step.step || "",
          status: step.status || "pending",
        };
        if (todo.status === "in_progress" && parsed.explanation) {
          todo.activeForm = parsed.explanation;
        }
        return todo;
      }) : [];
      sendAndRecord(session, {
        type: "tool_executing",
        id: parsed.turnId || "codex-plan",
        name: "TodoWrite",
        input: {
          todos: todos,
          meta: {
            variant: "plan",
            title: parsed.title || "Plan",
          },
        },
      });

    } else if (parsed.yokeType === "plan_content") {
      sendAndRecord(session, {
        type: "plan_content",
        content: parsed.content || "",
      });

    } else if (parsed.yokeType === "block_stop") {
      var idx = parsed.blockId;
      var block = session.blocks[idx];

      if (block && block.type === "tool_use") {
        var input = {};
        try { input = JSON.parse(block.inputJson); } catch (e) {}
        sendAndRecord(session, { type: "tool_executing", id: block.id, name: block.name, input: input });
        try { if (sessionWorktree.noteTool(cwd, session, block.name, input)) onWorktreeChange(session); } catch (e) {}

        // Track active Task tools for sub-agent done detection
        if (block.name === "Task") {
          if (!session.activeTaskToolIds) session.activeTaskToolIds = {};
          session.activeTaskToolIds[block.id] = true;
        }

        if (pushModule && block.name === "AskUserQuestion" && input.questions) {
          var q = input.questions[0];
          pushModule.sendPush({
            type: "ask_user",
            slug: slug,
            title: (mateDisplayName || "Claude") + " has a question",
            body: q ? q.question : "Waiting for your response",
            tag: "claude-ask",
          });
        }
      } else if (block && block.type === "thinking") {
        var duration = block.startTime ? (Date.now() - block.startTime) / 1000 : 0;
        sendAndRecord(session, { type: "thinking_stop", duration: duration });
      }

      delete session.blocks[idx];

    } else if (parsed.yokeType === "subagent_message") {
      // Sub-agent messages: extract tool_use blocks for activity display
      processSubagentMessage(session, parsed);

    } else if (parsed.yokeType === "message") {
      var content = parsed.content;

      // Fallback: if assistant text wasn't streamed via deltas, send it now
      if (parsed.messageRole === "assistant" && !session.streamedText && Array.isArray(content)) {
        var assistantText = content
          .filter(function(c) { return c.type === "text"; })
          .map(function(c) { return c.text; })
          .join("");
        if (assistantText) {
          if (handleProviderQuota(session, assistantText)) return;
          session._turnSawActivity = true;
          if (session.responsePreview.length < 200) {
            session.responsePreview += assistantText;
          }
          if (session.taskLauncher && session.taskLauncher.completion && session.taskLauncher.completion.marker) {
            session._taskWorkflowResponseText = (session._taskWorkflowResponseText || "") + assistantText;
          }
          sendAndRecord(session, { type: "delta", text: assistantText });
        }
      }

      // Check for local slash command output in user messages
      if (parsed.messageRole === "user") {
        var fullText = "";
        if (typeof content === "string") {
          fullText = content;
        } else if (Array.isArray(content)) {
          fullText = content
            .filter(function(c) { return c.type === "text"; })
            .map(function(c) { return c.text; })
            .join("\n");
        }
        if (fullText.indexOf("local-command-stdout") !== -1) {
          var m = fullText.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
          if (m) {
            sendAndRecord(session, { type: "slash_command_result", text: m[1].trim() });
          }
        }
      }

      if (Array.isArray(content)) {
        for (var i = 0; i < content.length; i++) {
          var block = content[i];
          if (block.type === "tool_result" && !session.sentToolResults[block.tool_use_id]) {
            // Clear active Task tool when its result arrives
            if (session.activeTaskToolIds && session.activeTaskToolIds[block.tool_use_id]) {
              sendAndRecord(session, {
                type: "subagent_done",
                parentToolId: block.tool_use_id,
              });
              delete session.activeTaskToolIds[block.tool_use_id];
            }
            var resultText = "";
            var resultImages = [];
            if (typeof block.content === "string") {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              resultText = block.content
                .filter(function(c) { return c.type === "text"; })
                .map(function(c) { return c.text; })
                .join("\n");
              for (var ri = 0; ri < block.content.length; ri++) {
                var rc = block.content[ri];
                if (rc.type === "image" && rc.source) {
                  resultImages.push({
                    mediaType: rc.source.media_type,
                    data: rc.source.data,
                  });
                }
              }
            }
            session.sentToolResults[block.tool_use_id] = true;
            var toolResultMsg = {
              type: "tool_result",
              id: block.tool_use_id,
              content: resultText,
              is_error: block.is_error || false,
            };
            attachToolResultImages(session, toolResultMsg, resultImages);
            sendAndRecord(session, toolResultMsg);
          }
        }
      }

    } else if (parsed.yokeType === "model_verified") {
      applyModelVerification(session, parsed);
    } else if (parsed.yokeType === "result") {
      if (parsed.verifiedModel) {
        applyModelVerification(session, {
          model: parsed.verifiedModel,
          requestedModel: parsed.requestedModel || null,
          source: parsed.modelVerificationSource || "response",
        });
      }
      session.blocks = {};
      session.sentToolResults = {};
      session.pendingPermissions = {};
      session.pendingElicitations = {};
      // Record ask_user_answered for any leftover pending questions so replay pairs correctly.
      // EXCEPTION: "mcp" mode entries are stateless - the tool returned immediately and the
      // turn is expected to end while the card is still awaiting the user's answer. Those
      // entries must survive across turns so the eventual ask_user_response can inject the
      // answer as the next user message. Only blocking modes (Claude canUseTool) get closed.
      var leftoverAskIds = Object.keys(session.pendingAskUser);
      var keptAskUser = {};
      for (var lai = 0; lai < leftoverAskIds.length; lai++) {
        var lid = leftoverAskIds[lai];
        var lentry = session.pendingAskUser[lid];
        if (lentry && lentry.mode === "mcp") {
          keptAskUser[lid] = lentry;
          continue;
        }
        sendAndRecord(session, { type: "ask_user_answered", toolId: lid });
      }
      session.pendingAskUser = keptAskUser;
      session.activeTaskToolIds = {};
      session.taskIdMap = {};
      // Only clear rateLimitResetsAt on genuine success (non-zero cost).
      // When rate-limited, the SDK sends result with zero cost right after
      // rate_limit_event; clearing here would prevent auto-continue scheduling.
      if (parsed.cost && parsed.cost > 0) {
        session.rateLimitResetsAt = null;
        session.streamEndedAutoRetryQueued = false;
        // Genuine success - re-arm the one-shot transient-stream-error retry
        // guard so a future independent drop can also retry once.
        session._transientRetryUsed = false;
      }
      console.log("[sdk-bridge] result handler: session " + session.localId + " cost=" + parsed.cost + " rateLimitResetsAt=" + session.rateLimitResetsAt);

      if (session.providerFailoverPending) {
        sendAndRecord(session, { type: "done", code: 1 });
        var failoverQueued = queuePendingProviderFailover(session, opts);
        if (!failoverQueued) {
          session.isProcessing = false;
          onProcessingChanged();
        }
        sm.broadcastSessionList();
        return;
      }

      // Handle SDK execution errors: show the error to the user instead of
      // silently swallowing it. These have subtype "error_during_execution".
      if (parsed.subtype === "error_during_execution") {
        var execErrors = parsed.errors || [];
        var execError = execErrors.length > 0
          ? execErrors.join("; ")
          : "Unknown SDK error";
        execError = normalizeExecutionError(session, execError);
        if (parsed.terminalReason) execError += " (reason: " + parsed.terminalReason + ")";
        console.error("[sdk-bridge] Execution error for session " + session.localId + ": " + execError);
        if (handleProviderQuota(session, execError)) {
          sendAndRecord(session, { type: "done", code: 1 });
          var executionFailoverQueued = queuePendingProviderFailover(session, opts);
          if (!executionFailoverQueued) {
            session.isProcessing = false;
            onProcessingChanged();
          }
          sm.broadcastSessionList();
          return;
        }
        session.isProcessing = false;
        onProcessingChanged();
        // Transient network/stream failure surfaced as a result error — recover
        // automatically instead of dead-ending (one shot, budget-capped).
        if (maybeAutoResumeTransientApiError(session, execError, false)) {
          sendAndRecord(session, { type: "done", code: 0 });
          sm.broadcastSessionList();
          return;
        }
        sendAndRecord(session, { type: "error", text: providerDisplayName(session) + " error: " + execError });
        sendAndRecord(session, { type: "done", code: 1 });
        sm.broadcastSessionList();
        return;
      }

      session.isProcessing = false;
      onProcessingChanged();
      // Detect "Not logged in" scenario early for the check below
      var previewTrimmed = (session.responsePreview || "").trim();
      var isZeroCost = !parsed.cost || parsed.cost === 0;
      var isLoginPrompt = isZeroCost && previewTrimmed.length < 100
        && /not logged in/i.test(previewTrimmed) && /\/login/i.test(previewTrimmed);
      // Context-window overflow that leaks as assistant TEXT, not an error. When
      // the conversation exceeds the window, Claude Code attempts an auto-compact
      // ({type:"compacting"}); if even the compaction prompt overflows, the raw
      // API 400 ("Prompt is too long") comes back as a zero-cost, code-0 turn
      // with the message streamed as assistant text — so neither the in-stream
      // error path nor error_during_execution fires. Detect it here (same
      // zero-cost + preview shape as the login-prompt guard) and surface the
      // recoverable context_overflow card instead of a dead-end text bubble.
      if (isZeroCost && isContextOverflowError(previewTrimmed)) {
        console.warn("[sdk-bridge] context overflow surfaced as assistant text for session " + session.localId);
        sendAndRecord(session, { type: "context_overflow", text: "Conversation too long to continue." });
        sendAndRecord(session, { type: "done", code: 1 });
        notifyContextOverflow(session);
        sm.broadcastSessionList();
        return;
      }
      // Fetch rich context usage breakdown (fire-and-forget, non-blocking)
      if (session.queryInstance && typeof session.queryInstance.getContextUsage === "function") {
        session.queryInstance.getContextUsage().then(function(ctxUsage) {
          session.lastContextUsage = ctxUsage;
          sendToSession(session, { type: "context_usage", data: ctxUsage });
        }).catch(function(e) {
          console.error("[sdk-bridge] getContextUsage failed (non-fatal):", e.message || e);
        });
      }
      var lastStreamInput = session.lastStreamInputTokens || parsed.lastStreamInputTokens || null;
      session.lastStreamInputTokens = null;
      sendAndRecord(session, {
        type: "result",
        cost: parsed.cost,
        duration: parsed.duration,
        usage: parsed.usage || null,
        modelUsage: parsed.modelUsage || null,
        sessionId: parsed.sessionId,
        requestedModel: parsed.requestedModel || null,
        verifiedModel: parsed.verifiedModel || null,
        modelVerificationSource: parsed.modelVerificationSource || null,
        lastStreamInputTokens: lastStreamInput,
        truncatedReason: parsed.truncatedReason
          || (session._lastStopReason === "max_tokens" ? "the response hit the output token limit" : null),
      });
      if (parsed.fastModeState) {
        sendAndRecord(session, { type: "fast_mode_state", state: parsed.fastModeState });
      }
      // Detect "Not logged in / Please run /login" from SDK.
      // This is a short canned response with zero cost, not actual AI output.
      if (isLoginPrompt) {
        emitAuthRequired(session);
      }
      // Proactive context-window guard: warn ONCE as the thread approaches the
      // model context window, before it fills and turns start coming back empty
      // (a full window makes codex app-server ack turns but return nothing).
      var _ctxWindow = parsed.contextWindow ||
        (parsed.modelUsage && parsed.verifiedModel && parsed.modelUsage[parsed.verifiedModel] && parsed.modelUsage[parsed.verifiedModel].contextWindow) || null;
      var _ctxUsed = parsed.contextUsedTokens || null;
      if (_ctxWindow && _ctxUsed) {
        var _occ = _ctxUsed / _ctxWindow;
        if (_occ > 1.5) {
          // True context occupancy is bounded by the window. A wildly-over
          // reading means we read a cumulative token field, not live occupancy
          // - skip rather than show a nonsensical "270%" warning.
          console.warn("[sdk-bridge] implausible context occupancy for session " + session.localId +
            " (" + _ctxUsed + "/" + _ctxWindow + "); skipping context warning");
        } else if (_occ >= 0.9 && !session._contextLimitWarned) {
          session._contextLimitWarned = true;
          var _pct = Math.min(100, Math.round(_occ * 100));
          sendAndRecord(session, {
            type: "info",
            text: providerDisplayName(session) + " is near its context window (" +
              _pct + "% - " + _ctxUsed + " of " + _ctxWindow + " tokens). Responses may start coming back empty; consider forking or starting a fresh compacted continuation.",
          });
        } else if (_occ < 0.7 && session._contextLimitWarned) {
          // Re-arm after a compaction/fork drops usage well below the threshold.
          session._contextLimitWarned = false;
        }
      }

      // Empty-turn guard: the turn completed with no text, no thinking, no tool
      // call, and zero cost. This is what a wedged or rate-limited provider
      // session looks like (e.g. a resumed Codex thread that acks the turn but
      // never reaches the model). Surface it instead of showing a silent blank.
      if (!session._turnSawActivity && isZeroCost && !isLoginPrompt) {
        console.warn("[sdk-bridge] empty turn for session " + session.localId +
          " (vendor=" + (session.vendor || "?") + "): no output, zero cost");
        var canCompactEmptyTurn = session.vendor === "codex" &&
          typeof opts.compactAndContinue === "function" &&
          !session._emptyTurnCompactionQueued &&
          !session.compactedFromLocalId &&
          !session.compactedIntoLocalId &&
          (session.compactionDepth || 0) < 1;
        if (canCompactEmptyTurn) {
          session._emptyTurnCompactionQueued = true;
          sendAndRecord(session, {
            type: "info",
            text: providerDisplayName(session) + " returned an empty response with no token usage. Clay is compacting the conversation into a fresh session and retrying the latest message.",
          });
          try {
            opts.compactAndContinue(session, { reason: "empty_turn" });
          } catch (compactErr) {
            console.error("[sdk-bridge] empty-turn compaction failed for session " + session.localId + ": " + (compactErr.message || compactErr));
            sendAndRecord(session, {
              type: "error",
              text: "Clay could not compact this session automatically. Start a fresh session and paste the relevant context.",
            });
          }
        } else {
          sendAndRecord(session, {
            type: "error",
            text: providerDisplayName(session) + " returned an empty response with no output and no token usage. The provider session may be wedged or out of context. Start a fresh or compacted continuation.",
          });
        }
      }
      // A turn that completed with REAL activity resets the consecutive
      // auto-resume budget. The budget exists to stop repeated-FAILURE loops
      // (resume → stall → resume); a successful productive turn proves the
      // session recovered, so the next genuine hiccup deserves a fresh budget.
      // Without this, long unattended runs accumulated one budget hit per
      // transient blip and eventually held silently on the 6th — even though
      // every earlier resume had worked fine.
      if (!session.providerFailoverPending && session._turnSawActivity && !isZeroCost && session._consecutiveAutoResumes) {
        session._consecutiveAutoResumes = 0;
        session._resumeGaveUpNotified = false;
        sm.saveSessionFile(session);
      }
      // Handoff absorbed: the new vendor completed a turn with real output, so
      // its native session now carries the conversation. Drop the wrapper —
      // the remaining turn budget is retry headroom for FAILED turns only.
      // Re-injecting after success wasted up to 3 × full-transcript tokens and
      // re-framed the live chat as "just handed off" (the exact bug
      // sessions-loader already fixes on restart; this closes the live path).
      if (!session.providerFailoverPending && session._turnSawActivity && !isZeroCost && (session.handoffContext || session._handoffContextStash)) {
        if (handoffContextModule.finalizeHandoffAfterSuccessfulTurn(session)) {
          sm.saveSessionFile(session);
        }
      }
      // Per-provider health: a turn that produced real activity with non-zero
      // cost is the canonical clean completion — the one success signal that
      // resets the vendor to healthy. Empty/zero-cost turns fall through here
      // too (they surface a wedged-provider error above) so they must NOT count.
      if (!session.providerFailoverPending && session._turnSawActivity && !isZeroCost) {
        recordProductiveTurnSuccess(session);
      }
      sendAndRecord(session, { type: "done", code: 0 });
      var _donePreviewText = (session.responsePreview || "").replace(/\s+/g, " ").trim();
      if (_donePreviewText.length > 140) _donePreviewText = _donePreviewText.substring(0, 140) + "...";
      var _doneTitle = mateDisplayName ? (mateDisplayName + " responded") : (session.title || "Claude");
      var _suppressOwnerNotification = shouldSuppressOwnerNotification(session, usersApi);

      if (pushModule && !session.suppressDonePush && !_suppressOwnerNotification) {
        pushModule.sendPush({
          type: "done",
          slug: slug,
          title: _doneTitle,
          body: _donePreviewText || "Response ready",
          tag: "claude-done",
        });
      }

      var _nm = getNotificationsModule();
      if (_nm && !session.loop && !session.suppressDonePush && !_suppressOwnerNotification) {
        _nm.notify("response_done", {
          title: _doneTitle,
          preview: _donePreviewText,
          slug: slug,
          sessionId: session.localId,
          mateId: getMateIdForNotification(),
          ownerId: session.ownerId || null,
        });
      }
      // Reset for next turn in the same query
      session.lastActivityAt = Date.now();
      session.turnCount = (session.turnCount || 0) + 1;
      var donePreview = session.responsePreview || "";
      var doneFullText = session._taskWorkflowResponseText || donePreview;
      session.responsePreview = "";
      session._taskWorkflowResponseText = "";
      session.streamedText = false;
      // If the turn's only output was a transient "API Error:" (e.g. the SDK's
      // "socket connection was closed unexpectedly") delivered in-band, auto-
      // resume instead of dead-ending and waiting for the user to type continue.
      maybeAutoResumeTransientApiError(session, donePreview, true);
      sm.broadcastSessionList();

      // Auto-generate title after N turns (skip if loop or already auto-generated)
      if (session.turnCount === AUTO_TITLE_TURN_THRESHOLD
          && !session.titleAutoGenerated
          && !session.titleManuallySet
          && !session.loop
          && onAutoTitle) {
        try { onAutoTitle(session); } catch (e) {
          console.error("[auto-title] onAutoTitle threw:", e.message || e);
        }
      }

      if (onTurnDone && !session.providerFailoverPending) {
        try { onTurnDone(session, donePreview, doneFullText); } catch (e) {}
      }
      // A terminal callback may touch the busy bit after `done` was recorded.
      // Reconcile it against the authoritative history immediately, while the
      // shared predicate preserves callbacks that dispatched a real follow-on.
      if (clearStaleProcessingState(session)) {
        onProcessingChanged();
        sm.broadcastSessionList();
      }

    } else if (parsed.yokeType === "status") {
      if (parsed.status === "compacting") {
        sendAndRecord(session, { type: "compacting", active: true });
      } else if (session.compacting) {
        sendAndRecord(session, { type: "compacting", active: false });
      }
      session.compacting = parsed.status === "compacting";

    } else if (parsed.yokeType === "task_started") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        if (!session.taskIdMap) session.taskIdMap = {};
        session.taskIdMap[parentId] = parsed.taskId;
        sendAndRecord(session, {
          type: "task_started",
          parentToolId: parentId,
          taskId: parsed.taskId,
          description: parsed.description || "",
        });
      }

    } else if (parsed.yokeType === "task_progress") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        sendAndRecord(session, {
          type: "task_progress",
          parentToolId: parentId,
          taskId: parsed.taskId,
          usage: parsed.usage || null,
          lastToolName: parsed.lastToolName || null,
          description: parsed.description || "",
          summary: parsed.summary || null,
        });
      }

    } else if (parsed.yokeType === "task_updated") {
      // Live task state patches (status, description, error, backgrounded)
      var taskId = parsed.task_id;
      var patch = parsed.patch || {};
      var parentId = null;
      if (session.taskIdMap) {
        for (var k in session.taskIdMap) {
          if (session.taskIdMap[k] === taskId) { parentId = k; break; }
        }
      }
      if (parentId) {
        sendAndRecord(session, {
          type: "task_updated",
          parentToolId: parentId,
          taskId: taskId,
          patch: patch,
        });
      }

    } else if (parsed.yokeType === "tool_progress") {
      // Sub-agent tool_progress: forward as activity update
      var parentId = parsed.parentToolId;
      if (parentId) {
        sendAndRecord(session, {
          type: "subagent_activity",
          parentToolId: parentId,
          text: parsed.text || "",
        });
      }

    } else if (parsed.yokeType === "task_notification") {
      var parentId = parsed.parentToolId;
      if (parentId) {
        sendAndRecord(session, {
          type: "subagent_done",
          parentToolId: parentId,
          status: parsed.status || "completed",
          summary: parsed.summary || "",
          usage: parsed.usage || null,
        });
      }
      if (session.taskIdMap) {
        for (var k in session.taskIdMap) {
          if (session.taskIdMap[k] === parsed.taskId) {
            delete session.taskIdMap[k];
            break;
          }
        }
      }

    } else if (parsed.yokeType === "rate_limit") {
      var info = parsed.rateLimitInfo;
      console.log("[sdk-bridge] rate_limit_event for session " + session.localId + ": status=" + info.status + " resetsAt=" + info.resetsAt + " isUsingOverage=" + info.isUsingOverage + " isProcessing=" + session.isProcessing);

      // Broadcast reset time for top-bar usage link. Also remember it in the
      // daemon-wide cache: rate_limit_usage only flows during live queries, so
      // without server-side memory a page reload / reconnect / second device
      // showed NO usage pill (or an hours-old one) while a limit was still
      // active — and other projects never saw an account-wide limit at all.
      // project-connection replays the cache on connect.
      if (info.rateLimitType && info.resetsAt) {
        session.rateLimitLastResetsAt = info.resetsAt * 1000;
        var usageMsg = {
          type: "rate_limit_usage",
          vendor: session.vendor || "claude",
          rateLimitType: info.rateLimitType,
          resetsAt: info.resetsAt * 1000,
          status: info.status,
          utilization: typeof info.utilization === "number" ? info.utilization : null,
        };
        rateLimitUsageCache.remember(usageMsg);
        send(usageMsg);
      }

      // Warning/rejection handling (existing behavior)
      if (info.status === "allowed_warning" || info.status === "rejected") {
        sendAndRecord(session, {
          type: "rate_limit",
          vendor: session.vendor || "claude",
          status: info.status,
          resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
          rateLimitType: info.rateLimitType || null,
          utilization: info.utilization || null,
          isUsingOverage: info.isUsingOverage || false,
        });
        // Track rejection for auto-continue / scheduled message support
        if (info.status === "rejected" && info.resetsAt) {
          session.rateLimitResetsAt = info.resetsAt * 1000;

          // Schedule auto-continue immediately on rejection (don't wait for
          // query completion which has timing issues with worker/non-worker paths).
          if (!session.scheduledMessage && !session.destroying) {
            var acEnabled = session.onQueryComplete ||
              (typeof opts.getAutoContinueSetting === "function" && opts.getAutoContinueSetting(session));
            console.log("[sdk-bridge] rate_limit rejected: acEnabled=" + acEnabled + " overage=" + !!info.isUsingOverage + " session=" + session.localId);
            if (acEnabled) {
              session.rateLimitAutoContinuePending = true;
              if (info.isUsingOverage) {
                // Extra usage available: continue after this rejected turn ends,
                // without creating a scheduled-message bubble.
                console.log("[sdk-bridge] Usage credits available, queueing immediate continue for session " + session.localId);
                session.rateLimitResetsAt = null;
                session.rateLimitUseCreditsPending = true;
                if (!session.isProcessing && typeof opts.continueWithUsageCredits === "function") {
                  opts.continueWithUsageCredits(session, "continue", null, "↻ Continuing with usage credits");
                }
              } else {
                // No overage: the vendor is unavailable until resetsAt, the
                // same situation as usage-credits-exhausted. Mark it
                // immediately unhealthy (skip the failure-streak threshold —
                // a hard rejection is definitive, not a transient blip) so
                // session.providerFailoverPending is set. The "result" event
                // that follows this rate_limit_event (SDK always sends one,
                // with cost 0) picks that flag up and runs the automatic
                // failover. That module falls back to the exact same
                // same-provider scheduled continue we used to do here itself
                // when no fallback candidate exists or failover is disabled,
                // so behavior is unchanged when there's nothing to switch to.
                console.log("[sdk-bridge] Marking " + (session.vendor || "claude") + " unhealthy after rate-limit rejection for session " + session.localId);
                recordProviderFailure(session, session.vendor || "claude", "rate-limit-rejected", {
                  immediate: true,
                  // The window's reset time: in-flight turns finishing cleanly
                  // must not mark the vendor healthy before this (F-2 flapping).
                  unavailableUntil: session.rateLimitResetsAt || null,
                });
              }
            }
          }
        }
      }

    } else if (parsed.yokeType === "prompt_suggestion") {
      sendAndRecord(session, {
        type: "prompt_suggestion",
        suggestion: parsed.suggestion || "",
      });

    } else if (parsed.yokeType === "notification") {
      var notifText = parsed.text || "";
      var notifPriority = parsed.priority || "low";
      if (notifText) {
        sendAndRecord(session, {
          type: "sdk_notification",
          key: parsed.key || "",
          text: notifText,
          priority: notifPriority,
          color: parsed.color || null,
          timeoutMs: parsed.timeout_ms || null,
        });
      }

    } else if (parsed.yokeType === "api_retry") {
      // Transient retry notification, show in UI but don't persist in history
      var retryText = parsed.message || parsed.error || "Retrying API request...";
      sendToSession(session, { type: "system_info", text: retryText });

    } else if (parsed.yokeType === "commands_changed") {
      // Mid-session command list change: rebuild the union with skills (same as
      // init) and push a full replacement to the client.
      var cmdSeen = new Set();
      var cmdCombined = [];
      var cmdAll = (parsed.commandNames || []).concat(Array.from(sm.skillNames || []));
      for (var ci = 0; ci < cmdAll.length; ci++) {
        if (!cmdSeen.has(cmdAll[ci])) {
          cmdSeen.add(cmdAll[ci]);
          cmdCombined.push(cmdAll[ci]);
        }
      }
      sm.slashCommands = cmdCombined;
      send({ type: "slash_commands", commands: sm.slashCommands });

    } else if (parsed.yokeType === "worker_shutting_down") {
      // Surface non-routine teardown reasons; "host_exit" is the normal close.
      if (parsed.reason && parsed.reason !== "host_exit") {
        sendToSession(session, { type: "system_info", text: "Session worker shutting down: " + parsed.reason });
      }

    } else if (parsed.yokeType === "thinking_tokens") {
      // Live thinking-token estimate; ephemeral, do not persist in history.
      sendToSession(session, {
        type: "thinking_tokens",
        estimatedTokens: parsed.estimatedTokens || 0,
        estimatedTokensDelta: parsed.estimatedTokensDelta || 0,
      });

    } else if (parsed.yokeType === "informational") {
      // Leveled informational message from the agent (info/notice/suggestion/warning).
      if (parsed.content && !isModelSwitchInformational(parsed.content)) {
        sendAndRecord(session, {
          type: "informational",
          level: parsed.level || "info",
          content: parsed.content,
          toolUseId: parsed.toolUseId || null,
          preventContinuation: !!parsed.preventContinuation,
        });
      }

    } else if (parsed.yokeType === "permission_denied") {
      // A tool call was blocked; surface why.
      sendAndRecord(session, {
        type: "permission_denied",
        toolName: parsed.toolName || "",
        toolUseId: parsed.toolUseId || null,
        agentId: parsed.agentId || null,
        reasonType: parsed.reasonType || null,
        reason: parsed.reason || null,
        message: parsed.message || "",
      });

    } else if (parsed.yokeType === "auth_required") {
      // Vendor adapter signalled the session isn't authenticated (e.g. Codex
      // app-server returned an unauthorized/token-revoked error). Trigger the
      // same login flow as the Claude login-prompt path.
      session.isProcessing = false;
      onProcessingChanged();
      emitAuthRequired(session);

    } else if (parsed.yokeType === "model_refusal") {
      // Model declined the request. "fallback" => the CLI retried on another
      // model; "no_fallback" => the turn ended with a refusal.
      sendAndRecord(session, {
        type: "model_refusal",
        refusalKind: parsed.refusalKind || "no_fallback",
        originalModel: parsed.originalModel || null,
        fallbackModel: parsed.fallbackModel || null,
        direction: parsed.direction || null,
        category: parsed.category || null,
        explanation: parsed.explanation || null,
        content: parsed.content || null,
      });

    } else if (parsed.yokeType === "system") {
      // Catch-all for unhandled system subtypes (e.g. hook-block errors).
      // Extract any error text and surface it in the UI.
      var sysText = parsed.error || parsed.message || parsed.text || "";
      if (!sysText && Array.isArray(parsed.content)) {
        sysText = parsed.content
          .filter(function(c) { return c.type === "text"; })
          .map(function(c) { return c.text; })
          .join("\n");
      }
      if (sysText) {
        console.log("[sdk-bridge] Unhandled system message (subtype=" + (parsed.subtype || "none") + "): " + sysText.substring(0, 200));
        sendAndRecord(session, { type: "error", text: sysText });
      } else {
        // Content-free unknown subtype. Previously invisible in every log
        // while it silently defeated the stream watchdog (see
        // sdk-bridge-stream). Log the subtype ONCE per subtype per turn so a
        // flood is diagnosable without re-flooding the log.
        var _sub = parsed.subtype || "none";
        if (!session._loggedSystemSubtypes) session._loggedSystemSubtypes = {};
        if (!session._loggedSystemSubtypes[_sub]) {
          session._loggedSystemSubtypes[_sub] = true;
          console.warn("[sdk-bridge] content-free system event (subtype=" + _sub +
            ") for session " + session.localId + " — not counted as watchdog progress");
        }
      }
    }
  }

  return {
    processSDKMessage: processSDKMessage,
    sendAndRecord: sendAndRecord,
    sendToSession: sendToSession,
    processSubagentMessage: processSubagentMessage,
    toolActivityTextForSubagent: toolActivityTextForSubagent,
  };
}

module.exports = { attachMessageProcessor: attachMessageProcessor };
