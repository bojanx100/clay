// Small, independently testable stages for SDK query option construction.

var getCodexConfig = require("./codex-defaults").getCodexConfig;
var claudePermissionForAutomation = require("./automation-modes").claudePermissionForAutomation;
var listProviderRoutes = require("./provider-routes").listProviderRoutes;
var meaningfulTextTitle = require("./text-title").meaningfulTextTitle;
var pipeline = require("./provider-agent-pipeline");
var mcp = require("./sdk-bridge-mcp");
var executionFence = require("./coop-control-fence");

async function waitForWorkerExit(session) {
  if (!session._workerExitPromise) return;
  var exitWait = session._workerExitPromise;
  session._workerExitPromise = null;
  await Promise.race([exitWait, new Promise(function (resolve) { setTimeout(resolve, 3000); })]);
}

function resetTurn(session, linuxUser) {
  session.blocks = {};
  session.sentToolResults = {};
  session.activeTaskToolIds = {};
  session.pendingElicitations = {};
  session.streamedText = false;
  session.responsePreview = "";
  session._turnDoneSent = false;
  if (!linuxUser) session.abortController = new AbortController();
}

function applyThinking(sm, loopSettings, claudeOpts) {
  var mode = loopSettings.thinking || sm.currentThinking;
  if (mode === "disabled") {
    claudeOpts.thinking = { type: "disabled" };
  } else if (mode === "budget") {
    var budget = loopSettings.thinkingBudget || sm.currentThinkingBudget;
    if (budget) claudeOpts.thinking = { type: "enabled", budgetTokens: budget };
  } else {
    claudeOpts.thinking = { type: "adaptive", display: "summarized" };
  }
}

function effectivePermission(sm, session) {
  var automation = session.automationMode ? claudePermissionForAutomation(session.automationMode) : null;
  var globalMode = session.permissionMode || automation || sm.currentPermissionMode || "default";
  if (globalMode === "bypassPermissions") return "bypassPermissions";
  return session.acceptEditsAfterStart ? "acceptEdits" : globalMode;
}

function applyPermissions(ctx, session, loopSettings, claudeOpts) {
  if (loopSettings.permissionMode) session._loopPermissionMode = loopSettings.permissionMode;
  if (loopSettings.disableAllHooks !== undefined) {
    claudeOpts.settings = Object.assign({}, claudeOpts.settings || {},
      { disableAllHooks: loopSettings.disableAllHooks });
  }
  if (ctx.dangerouslySkipPermissions) {
    claudeOpts.allowDangerouslySkipPermissions = true;
    claudeOpts.permissionMode = "bypassPermissions";
  } else {
    var mode = session._loopPermissionMode || effectivePermission(ctx.sm, session);
    if (mode && mode !== "default") claudeOpts.permissionMode = mode;
  }
  if (session.acceptEditsAfterStart) delete session.acceptEditsAfterStart;
}

function applyResume(ctx, session, claudeOpts) {
  if (!session.cliSessionId || !session.lastRewindUuid) return;
  claudeOpts.resumeSessionAt = session.lastRewindUuid;
  delete session.lastRewindUuid;
  ctx.sm.saveSessionFile(session);
}

function applyLinux(session, linuxUser, elapsedStart, claudeOpts) {
  if (!linuxUser) return;
  claudeOpts.linuxUser = linuxUser;
  claudeOpts.singleTurn = !!session.singleTurn;
  claudeOpts.originalHome = require("./config").REAL_HOME || null;
  claudeOpts.projectPath = session.cwd || null;
  claudeOpts._perfT0 = elapsedStart;
  if (session._adapterWorkerState) {
    claudeOpts._workerState = session._adapterWorkerState;
    session._adapterWorkerState = null;
  }
}

function buildClaudeOptions(ctx, session, linuxUser, elapsedStart) {
  var result = { settingSources: ["user", "project", "local"], includePartialMessages: true,
    enableFileCheckpointing: true, extraArgs: { "replay-user-messages": null },
    promptSuggestions: true, agentProgressSummaries: true, agents: pipeline.claudeWorkerAgents() };
  var loopSettings = session.loopSettings || {};
  if (ctx.sm.currentBetas && ctx.sm.currentBetas.length) result.betas = ctx.sm.currentBetas;
  applyThinking(ctx.sm, loopSettings, result);
  applyPermissions(ctx, session, loopSettings, result);
  applyResume(ctx, session, result);
  applyLinux(session, linuxUser, elapsedStart, result);
  return { options: result, loopSettings: loopSettings };
}

function selectedModel(sm, session, loopSettings) {
  var project = sm.currentModel && sm.currentModel !== "default" ? sm.currentModel : null;
  var direct = session.model && session.model !== "default" ? session.model : null;
  var loop = session.loop && loopSettings.model && loopSettings.model !== "default" ?
    loopSettings.model : null;
  return direct || loop || project || undefined;
}

function syncCopilotRoute(ctx, session, model, vendor) {
  if (vendor !== "github-copilot") return;
  var route = ctx.copilotRouteIdForModel(model);
  if (!route || session.providerRouteId === route) return;
  session.providerRouteId = route;
  try { ctx.sm.saveSessionFile(session); } catch (error) {}
  if (typeof ctx.sm.broadcastSessionList === "function") ctx.sm.broadcastSessionList();
}

function catalogModel(ctx, session, model, vendor) {
  if (!vendor) return model;
  var models = ctx.getModelsForSession(session, vendor);
  if (!models.length) return model;
  if (model && !ctx.modelListContains(models, model)) {
    return ctx.resolveModelInList(models, model) || ctx.modelEntryValue(models[0]);
  }
  if (!model && session.providerRouteId) return ctx.modelEntryValue(models[0]);
  return model;
}

function normalizeModel(ctx, model) {
  return model && typeof model !== "string" ? ctx.modelEntryValue(model) || undefined : model;
}

function updateRequestedModel(session, model) {
  var changed = false;
  if (session.model !== model) { session.model = model; changed = true; }
  if (session.requestedModel !== model) { session.requestedModel = model; changed = true; }
  return changed;
}

function clearMismatchedVerification(session, model) {
  if (session.verifiedModel && session.verifiedModel !== model) {
    session.verifiedModel = null;
    session.modelVerificationSource = null;
    return true;
  }
  return false;
}

function updateProviderRoute(session, route) {
  if (!route || session.providerRouteId === route) return false;
  session.providerRouteId = route;
  return true;
}

function sendCopilotModelInfo(ctx, session, model, vendor) {
  var available = ctx.sm.availableVendors || [];
  var installed = ctx.sm.installedVendors || [];
  ctx.sendToSession(session, { type: "model_info", model: model,
    models: ctx.getModelsForSession(session, vendor), vendor: vendor,
    providerRouteId: session.providerRouteId || null,
    requestedModel: session.requestedModel || model, verifiedModel: session.verifiedModel || null,
    modelVerificationSource: session.modelVerificationSource || null,
    availableVendors: available, installedVendors: installed,
    providerRoutes: ctx.sm.providerRoutes || listProviderRoutes(available, installed, ctx.sm) });
}

function updateCopilotState(ctx, session, model, vendor) {
  if (vendor !== "github-copilot" || !model) return;
  var changed = updateRequestedModel(session, model);
  if (clearMismatchedVerification(session, model)) changed = true;
  if (updateProviderRoute(session, ctx.copilotRouteIdForModel(model))) changed = true;
  if (!changed) return;
  try { ctx.sm.saveSessionFile(session); } catch (error) {}
  if (typeof ctx.sm.broadcastSessionList === "function") ctx.sm.broadcastSessionList();
  sendCopilotModelInfo(ctx, session, model, vendor);
}

function resetCopilotHandoff(ctx, session) {
  var shouldReset = session.vendor === "github-copilot" && session.handoffContextConsumed &&
    !session.copilotHandoffNativeReset && session.cliSessionId && session.storageId &&
    session.storageId !== session.cliSessionId;
  if (!shouldReset) return;
  console.warn("[sdk-bridge] Resetting GitHub Copilot native session after handoff transcript was consumed: " +
    session.cliSessionId);
  session.cliSessionId = null;
  session.copilotHandoffNativeReset = true;
  try { ctx.sm.saveSessionFile(session); } catch (error) {}
  if (typeof ctx.sm.broadcastSessionList === "function") ctx.sm.broadcastSessionList();
}

function initialTitle(session, text) {
  if (session.cliSessionId || session.titleManuallySet || session.titleAutoGenerated) return null;
  if (session.title) return session.title;
  return typeof text === "string" ? meaningfulTextTitle(text, 60) : null;
}

function callbackOptions(ctx, session, fence, mergedMcpServers) {
  return {
    canUseTool: function (toolName, input, opts) {
      executionFence.assertAction(session, "tool", fence);
      return ctx.handleCanUseTool(session, toolName, input, opts);
    },
    onElicitation: function (request, opts) {
      executionFence.assertAction(session, "callback", fence);
      return ctx.handleElicitation(session, request, opts);
    },
    onUserDialog: function (request, opts) {
      executionFence.assertAction(session, "callback", fence);
      return ctx.handleUserDialog(session, request, opts);
    },
    callMcpTool: function (server, tool, args) {
      executionFence.assertAction(session, "tool", fence);
      return mcp.callMcpToolHandler(mergedMcpServers, server, tool, args);
    },
  };
}

function buildQueryOptions(ctx, session, text, linuxUser, fence, prepared) {
  var codex = getCodexConfig(ctx.sm, session);
  var merged = ctx.mergeMcpServers(ctx.getMcpServers(session), ctx.getRemoteMcpServers) || undefined;
  var title = initialTitle(session, text);
  var callbacks = callbackOptions(ctx, session, fence, merged);
  var options = Object.assign({ cwd: ctx.cwd, linuxUser: linuxUser || undefined,
    env: typeof ctx.getRuntimeEnv === "function" ? ctx.getRuntimeEnv(session) : process.env,
    model: prepared.model, effort: prepared.loopSettings.effort || session.effort || ctx.sm.currentEffort || undefined,
    title: title || undefined,
    toolPolicy: session.permissionMode === "bypassPermissions" || codex.approval === "never" ?
      "allow-all" : "ask", toolServers: merged,
    toolServerDescriptors: mcp.extractMcpDescriptors(merged) || undefined,
    resumeSessionId: session.cliSessionId || undefined,
    abortController: linuxUser ? undefined : session.abortController,
    adapterOptions: { CLAUDE: prepared.claudeOptions,
      CODEX: { approvalPolicy: codex.approval, sandboxMode: codex.sandbox,
        webSearchMode: codex.webSearch } } }, callbacks);
  if (!ctx.isMate && !session.orchestrationParent) {
    options.systemPrompt = pipeline.visibleWorkerPrompt(session.storageId || session.cliSessionId || session.localId);
  }
  require("./turn-performance").configure(session, options, ctx.adapter && ctx.adapter.vendor);
  return { options: options, initialTitle: title };
}

async function prepareQuery(ctx, session, text, linuxUser, fence) {
  await waitForWorkerExit(session);
  executionFence.assertAction(session, "provider_start", fence);
  if (linuxUser) ctx.ensureLinuxUserProjectDir(linuxUser, session);
  resetTurn(session, linuxUser);
  var claude = buildClaudeOptions(ctx, session, linuxUser, session._queryStartTs || Date.now());
  var vendor = session.vendor || ctx.adapter && ctx.adapter.vendor || null;
  var model = selectedModel(ctx.sm, session, claude.loopSettings);
  syncCopilotRoute(ctx, session, model, vendor);
  model = normalizeModel(ctx, catalogModel(ctx, session, model, vendor));
  updateCopilotState(ctx, session, model, vendor);
  resetCopilotHandoff(ctx, session);
  return { model: model, loopSettings: claude.loopSettings, claudeOptions: claude.options };
}

module.exports = { buildQueryOptions: buildQueryOptions, prepareQuery: prepareQuery };
