// YOKE Codex Adapter
// -------------------
// Implements the YOKE interface using codex app-server protocol.
// Bidirectional JSON-RPC over stdin/stdout enables interactive approval flows.

var path = require("path");
var { CodexAppServer } = require("../codex-app-server");
var { buildUserEnv } = require("../../build-user-env");
var { resolveOsUserInfo } = require("../../os-users");
var codexModels = require("../../codex-models");
var { withCodexWorkerConfig } = require("../../provider-agent-pipeline");
var { withCodexAppServerDefaults } = require("../../codex-defaults");
var { discoverClaudeSkills, parseSkillRefs } = require("./codex-skills");
var codexWorkspaceDependencies = require("./codex-workspace-dependencies");
var codexImageInput = require("./codex-image-input");
var codexResumeHistory = require("./codex-resume-history");
var codexModelsCache = require("../../codex-models-cache");
var codexEvents = require("./codex-events");
var codexRoutingUtils = require("./codex-routing-utils");
var { INSTRUCTIONS_END_MARKER } = require("../instructions");
var waitMs = codexRoutingUtils.waitMs;
var waitForProcessExit = codexRoutingUtils.waitForProcessExit;
var createShutdownError = codexRoutingUtils.createShutdownError;
var isCodexAuthError = codexRoutingUtils.isCodexAuthError;
var eventThreadId = codexRoutingUtils.eventThreadId;
var eventTurnId = codexRoutingUtils.eventTurnId;
var shouldRouteServerEvent = codexRoutingUtils.shouldRouteServerEvent;
var currentContextTokensFromTokenUsage = codexRoutingUtils.currentContextTokensFromTokenUsage;
var INTERRUPT_SETTLE_TIMEOUT_MS = 30000;

var flattenEvent = codexEvents.flattenEvent;

function abortQueriesAndWait(activeQueries, deadlineMs) {
  var drains = [];
  var active = Array.isArray(activeQueries) ? activeQueries : [];
  for (var i = 0; i < active.length; i++) {
    try {
      var drain = active[i] && active[i].abort ? active[i].abort() : null;
      if (drain && typeof drain.then === "function") {
        drains.push(Promise.resolve(drain).catch(function() { return null; }));
      }
    } catch (e) {}
  }
  if (drains.length === 0) return Promise.resolve(true);
  var remaining = typeof deadlineMs === "number"
    ? Math.max(0, deadlineMs - Date.now())
    : 5000;
  return new Promise(function(resolve) {
    var settled = false;
    var timer = setTimeout(function() {
      if (settled) return;
      settled = true;
      resolve(false);
    }, remaining);
    Promise.all(drains).then(function() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function isThreadStillRunningError(error) {
  var message = error && error.message ? error.message : String(error || "");
  return /cannot resume thread\b.*\bwhile it is already running/i.test(message);
}

async function resumeThreadAfterInterrupt(appServer, resumeParams, options) {
  var timeoutMs = options && typeof options.resumeRetryTimeoutMs === "number" &&
    options.resumeRetryTimeoutMs >= 0 ? options.resumeRetryTimeoutMs : INTERRUPT_SETTLE_TIMEOUT_MS;
  var delayMs = options && typeof options.resumeRetryDelayMs === "number" &&
    options.resumeRetryDelayMs >= 0 ? options.resumeRetryDelayMs : 50;
  var deadline = Date.now() + timeoutMs;
  var attempts = 0;
  while (true) {
    try {
      return await appServer.send("thread/resume", resumeParams, 60000);
    } catch (error) {
      if (!isThreadStillRunningError(error) || Date.now() >= deadline) throw error;
      attempts++;
      if (attempts === 1) {
        console.warn("[yoke/codex] Interrupted thread is still stopping; waiting before resume: " +
          resumeParams.threadId);
      }
      await waitMs(Math.min(delayMs, Math.max(0, deadline - Date.now())));
    }
  }
}

function createEventState(model) {
  return {
    blockCounter: 0,
    threadId: null,
    turnStarted: false,
    turnId: null,
    lastUsage: null,
    lastInputTokens: null,
    lastContextUsedTokens: null,
    contextWindowTokens: null,
    done: false,
    aborted: false,
    loopStarted: false,
    model: model || codexModels.DEFAULT_CODEX_MODEL,
    agentBlockId: null,
    agentTextLen: 0,
    agentText: "",
    thinkingBlocks: {},
    thinkingLengths: {},
    toolBlocks: {},
    commandInputs: {},
    commandOutputs: {},
    planTexts: {},
    imageGenerationResults: {},
    richItemResults: {},
  };
}

// --- QueryHandle ---

function createCodexQueryHandle(appServer, queryOpts) {
  var abortController = queryOpts.abortController;
  var workspaceDependencies = queryOpts.workspaceDependencies || null;
  var systemPrompt = workspaceDependencies && workspaceDependencies.enabled
    ? workspaceDependencies.appendInstructions(queryOpts.systemPrompt || "")
    : queryOpts.systemPrompt || "";
  var canUseTool = queryOpts.canUseTool || null;
  var onElicitation = queryOpts.onElicitation || null;
  var onFinished = queryOpts.onFinished || null;

  // Check if the query was cancelled (either via handle.abort() or direct signal abort)
  function isCancelled() {
    return state.aborted || (abortController && abortController.signal && abortController.signal.aborted);
  }

  var state = createEventState(queryOpts.model);

  // Internal event buffer for async iterator
  var eventBuffer = [];
  if (Array.isArray(queryOpts.initialEvents)) {
    eventBuffer = queryOpts.initialEvents.slice();
  }
  var eventWaiting = null;
  var iteratorDone = false;
  var finishedNotified = false;
  var _unsubscribeEvents = null;
  var interruptDrainPromise = null;
  var interruptDrainResolve = null;
  var interruptDrainTimer = null;
  var iteratorEndPending = false;

  function notifyFinished() {
    if (finishedNotified) return;
    finishedNotified = true;
    if (typeof onFinished === "function") {
      try {
        onFinished();
      } catch (e) {
        console.error("[yoke/codex] onFinished error:", e.message || e);
      }
    }
  }

  function pushEvent(evt) {
    if (iteratorDone) return;
    if (eventWaiting) {
      var resolve = eventWaiting;
      eventWaiting = null;
      resolve({ value: evt, done: false });
    } else {
      eventBuffer.push(evt);
    }
  }

  function releaseEventSubscription() {
    if (typeof _unsubscribeEvents === "function") {
      try { _unsubscribeEvents(); } catch (e) {}
      _unsubscribeEvents = null;
    }
  }

  function completeIterator() {
    if (iteratorDone) return;
    iteratorEndPending = false;
    iteratorDone = true;
    if (eventWaiting) {
      var resolve = eventWaiting;
      eventWaiting = null;
      resolve({ value: undefined, done: true });
    }
    releaseEventSubscription();
    notifyFinished();
  }

  function finishInterruptDrain() {
    if (!interruptDrainResolve) return;
    if (interruptDrainTimer) clearTimeout(interruptDrainTimer);
    interruptDrainTimer = null;
    var resolve = interruptDrainResolve;
    interruptDrainResolve = null;
    if (iteratorEndPending) completeIterator();
    resolve();
  }

  function startInterruptDrain() {
    if (interruptDrainPromise) return interruptDrainPromise;
    interruptDrainPromise = new Promise(function(resolve) {
      interruptDrainResolve = resolve;
    });
    var timeoutMs = typeof queryOpts.interruptDrainTimeoutMs === "number" &&
      queryOpts.interruptDrainTimeoutMs >= 0
      ? queryOpts.interruptDrainTimeoutMs
      : INTERRUPT_SETTLE_TIMEOUT_MS;
    interruptDrainTimer = setTimeout(finishInterruptDrain, timeoutMs);
    if (interruptDrainTimer && typeof interruptDrainTimer.unref === "function") {
      interruptDrainTimer.unref();
    }
    return interruptDrainPromise;
  }

  function endIterator(retainEventSubscription) {
    if (retainEventSubscription && interruptDrainResolve) {
      iteratorEndPending = true;
      return;
    }
    completeIterator();
  }

  // Message queue for multi-turn
  var messageQueue = [];
  var messageWaiting = null;
  var messageQueueEnded = false;

  function pushMessageToQueue(msg) {
    if (messageQueueEnded) return;
    if (messageWaiting) {
      var resolve = messageWaiting;
      messageWaiting = null;
      resolve(msg);
    } else {
      messageQueue.push(msg);
    }
  }

  function waitForMessage() {
    if (messageQueue.length > 0) return Promise.resolve(messageQueue.shift());
    if (messageQueueEnded) return Promise.resolve(null);
    return new Promise(function(resolve) { messageWaiting = resolve; });
  }

  // Track whether this turn is still active (waiting for turn/completed or turn/failed)
  var turnResolve = null;

  // --- App-server event handler ---
  function handleServerEvent(msg) {
    var method = msg.method;
    var params = msg.params || {};

    // Ignore events from other threads (app-server is shared across sessions)
    if (!shouldRouteServerEvent(state, queryOpts, method, params)) return;

    // After abort, only allow turn-ending events through
    if (isCancelled() && method !== "turn/completed" && method !== "turn/failed" && method !== "serverRequest/resolved" && method !== "thread/status/changed") return;

    // --- Approval helper ---
    // canUseTool returns { behavior: "allow"|"deny", updatedInput } or truthy/falsy
    function isApproved(decision) {
      if (!decision) return false;
      if (decision === true) return true;
      if (decision.behavior === "allow") return true;
      return false;
    }

    // Dynamic tools are executed by the app-server client, not by Codex or MCP.
    if (method === "item/tool/call" && params.tool === codexWorkspaceDependencies.TOOL_NAME) {
      if (!workspaceDependencies) {
        appServer.respond(msg.id, {
          contentItems: [{ type: "inputText", text: "Workspace dependency runtime unavailable." }],
          success: false,
        });
        return;
      }
      workspaceDependencies.handleCall(params.arguments).then(function(result) {
        appServer.respond(msg.id, result);
      }).catch(function(err) {
        console.error("[yoke/codex] workspace dependency tool failed:", err.message || err);
        appServer.respond(msg.id, {
          contentItems: [{ type: "inputText", text: "Failed to load workspace dependency runtime details." }],
          success: false,
        });
      });
      return;
    }

    // Command approval request
    if (method === "item/commandExecution/requestApproval") {
      var cmdParams = msg.params || {};
      if (cmdParams.itemId && cmdParams.command) {
        state.commandInputs[cmdParams.itemId] = cmdParams.command;
      }
      if (canUseTool) {
        canUseTool("Bash", { command: cmdParams.command }, {}).then(function(decision) {
          var approved = isApproved(decision);
          // Response must be wrapped in { decision: ... } object per app-server protocol
          appServer.respond(msg.id, { decision: approved ? "accept" : "decline" });
        }).catch(function(err) {
          console.error("[yoke/codex] canUseTool error:", err.message);
          appServer.respond(msg.id, { decision: "decline" });
        });
      } else {
        appServer.respond(msg.id, { decision: "accept" });
      }
      return;
    }

    // File change approval request
    if (method === "item/fileChange/requestApproval") {
      var fcParams = msg.params || {};
      if (canUseTool) {
        var changeInfo = (fcParams.changes || []).map(function(c) { return c.kind + " " + c.path; }).join(", ");
        canUseTool("Edit", { changes: changeInfo, path: fcParams.path }, {}).then(function(decision) {
          appServer.respond(msg.id, { decision: isApproved(decision) ? "accept" : "decline" });
        }).catch(function(err) {
          console.error("[yoke/codex] canUseTool error:", err.message);
          appServer.respond(msg.id, { decision: "decline" });
        });
      } else {
        appServer.respond(msg.id, { decision: "accept" });
      }
      return;
    }

    // MCP tool approval / elicitation (app-server uses mcpServer/elicitation/request)
    if (method === "item/tool/requestUserInput" || method === "mcpServer/elicitation/request") {
      var mcpParams = msg.params || {};
      var mcpMeta = mcpParams._meta || {};
      console.log("[yoke/codex] MCP approval request:", (mcpMeta.tool || "?"), "server=" + (mcpParams.serverName || "?"));
      if (onElicitation) {
        var request = {
          serverName: mcpParams.serverName || (mcpMeta.tool || "Tool"),
          message: mcpParams.message || mcpParams.prompt || "",
          mode: mcpParams.url ? "url" : "form",
          url: mcpParams.url || null,
          elicitationId: mcpParams.elicitationId || null,
          requestedSchema: mcpParams.requestedSchema || null,
        };
        if (!request.requestedSchema && Array.isArray(mcpParams.questions) && mcpParams.questions.length > 0) {
          var schema = { type: "object", properties: {}, required: [] };
          for (var qi = 0; qi < mcpParams.questions.length; qi++) {
            var q = mcpParams.questions[qi];
            var qid = q.id || ("question_" + (qi + 1));
            schema.required.push(qid);
            if (Array.isArray(q.options) && q.options.length > 0) {
              schema.properties[qid] = {
                type: "string",
                description: q.question || q.prompt || qid,
                enum: q.options.map(function(opt) { return opt && (opt.value || opt.label) ? (opt.value || opt.label) : ""; }).filter(Boolean),
              };
            } else {
              schema.properties[qid] = {
                type: "string",
                description: q.question || q.prompt || qid,
              };
            }
          }
          request.requestedSchema = schema;
        }
        onElicitation(request, {
          signal: { addEventListener: function() {} },
        }).then(function(result) {
          appServer.respond(msg.id, result || { action: "reject" });
        }).catch(function(err) {
          console.error("[yoke/codex] elicitation_response send failed:", err.message || err);
          appServer.respond(msg.id, { action: "reject" });
        });
      } else if (canUseTool) {
        canUseTool("mcp__" + (mcpParams.serverName || "unknown") + "__" + (mcpMeta.tool || "call"), mcpParams, {}).then(function(decision) {
          appServer.respond(msg.id, { action: isApproved(decision) ? "accept" : "decline" });
        }).catch(function(err) {
          console.error("[yoke/codex] MCP canUseTool error:", err.message);
          appServer.respond(msg.id, { action: "decline" });
        });
      } else {
        appServer.respond(msg.id, { action: "accept" });
      }
      return;
    }

    // Regular events: flatten and push to iterator
    var yokeEvents = flattenEvent(msg, state);
    for (var i = 0; i < yokeEvents.length; i++) {
      pushEvent(yokeEvents[i]);
    }

    // Resolve turn promise when turn ends
    if (method === "turn/completed" || method === "turn/failed") {
      if (turnResolve) {
        var resolve = turnResolve;
        turnResolve = null;
        resolve();
      }
      finishInterruptDrain();
    }
  }

  // --- Main query loop ---
  async function runQueryLoop(initialMessage) {
    // Prepend system prompt (project instructions from YOKE layer) to first message.
    // initialMessage may be a string (text-only) or an array of content items
    // (e.g. [{ type: "text", text: "..." }, ...] when images/attachments are present).
    // Naive string concatenation on an array coerces it via toString(), producing
    // "[object Object]" inside the prompt, so we must branch on the shape.
    // The end marker lets the rollout importer (cli-sessions.js) strip this
    // injected block back out of recorded user messages — without it the
    // "--- Instructions from CLAUDE.md ---" block leaked into visible chat
    // bubbles whenever an imported/synced session was rebuilt from the rollout.
    // A resumed provider thread already contains the instruction block from
    // its first Clay turn. Re-injecting it after every daemon restart or
    // recovery grows the provider context linearly and forces early compaction.
    var systemPromptBlock = systemPrompt && !queryOpts.resumeSessionId
      ? systemPrompt + "\n" + INSTRUCTIONS_END_MARKER
      : "";
    var currentMessage;
    if (!systemPromptBlock) {
      currentMessage = initialMessage;
    } else if (typeof initialMessage === "string") {
      currentMessage = systemPromptBlock + "\n\n" + initialMessage;
    } else if (Array.isArray(initialMessage)) {
      // Prepend systemPrompt to the first text item; if none exists, insert one.
      var cloned = initialMessage.slice();
      var injected = false;
      for (var i = 0; i < cloned.length; i++) {
        if (cloned[i] && cloned[i].type === "text") {
          cloned[i] = {
            type: "text",
            text: systemPromptBlock + "\n\n" + (cloned[i].text || ""),
          };
          injected = true;
          break;
        }
      }
      if (!injected) {
        cloned.unshift({ type: "text", text: systemPromptBlock });
      }
      currentMessage = cloned;
    } else {
      currentMessage = initialMessage;
    }

    try {
      // Subscribe per-query so multiple concurrent Codex sessions don't clobber
      // each other's event delivery. The previous single-slot assignment
      // (appServer.eventHandler = handleServerEvent) meant a second session
      // overwrote the first session's handler - events for the first session
      // were then filtered out by the threadId check and the session went
      // silent after its first message.
      _unsubscribeEvents = appServer.subscribe(handleServerEvent);

      // Start or resume thread
      var threadParams = {
        model: queryOpts.model || codexModels.DEFAULT_CODEX_MODEL,
        sandbox: queryOpts.sandboxMode || "workspace-write",
        approvalPolicy: queryOpts.approvalPolicy || "on-request",
        cwd: queryOpts.cwd,
        skipGitRepoCheck: true,
      };
      if (workspaceDependencies && workspaceDependencies.canConfigureDynamicTools) {
        threadParams.dynamicTools = workspaceDependencies.dynamicTools.slice();
      }
      if (queryOpts.modelReasoningEffort) {
        threadParams.modelReasoningEffort = queryOpts.modelReasoningEffort;
      }
      if (queryOpts.webSearchMode) {
        threadParams.webSearchMode = queryOpts.webSearchMode;
      }

      var threadResult;
      if (queryOpts.resumeSessionId) {
        var resumeParams = {
          threadId: queryOpts.resumeSessionId,
          model: threadParams.model,
          sandbox: threadParams.sandbox,
          approvalPolicy: threadParams.approvalPolicy,
          cwd: threadParams.cwd,
        };
        if (Object.prototype.hasOwnProperty.call(threadParams, "dynamicTools")) {
          resumeParams.dynamicTools = threadParams.dynamicTools;
        }
        var interruptedResume = await codexResumeHistory.prepareInterruptedResume(
          appServer, queryOpts.resumeSessionId);
        if (interruptedResume) {
          resumeParams.history = interruptedResume.history;
          console.warn("[yoke/codex] Rebuilding interrupted thread " + queryOpts.resumeSessionId +
            " without " + interruptedResume.removedCallIds.length + " orphaned custom tool call(s).");
        }
        threadResult = await resumeThreadAfterInterrupt(appServer, resumeParams, queryOpts);
      } else {
        threadResult = await appServer.send("thread/start", threadParams, 60000);
      }

      if (threadResult && threadResult.thread) {
        state.threadId = threadResult.thread.id;
        pushEvent({ yokeType: "session_id", sessionId: state.threadId });
      }

      while (!isCancelled()) {
        // Reset per-turn state
        state.turnStarted = false;
        state.turnId = null;
        state.agentBlockId = null;
        state.agentTextLen = 0;
        state.agentText = "";
        state.thinkingBlocks = {};
        state.thinkingLengths = {};
        state.toolBlocks = {};
        state.commandInputs = {};
        state.commandOutputs = {};
        state.planTexts = {};

        // Start turn
        var turnPromise = new Promise(function(resolve) { turnResolve = resolve; });

        var input;
        if (typeof currentMessage === "string") {
          input = [{ type: "text", text: currentMessage }];
        } else {
          input = currentMessage;
        }

        // Detect $<skill-name> references (Claude skills) and inject skill input items
        var availableSkills = discoverClaudeSkills(queryOpts.cwd);
        var skillItemsToInject = [];
        var injected = {};
        for (var ii = 0; ii < input.length; ii++) {
          if (input[ii].type === "text" && input[ii].text) {
            var parsed = parseSkillRefs(input[ii].text, availableSkills);
            for (var si = 0; si < parsed.skills.length; si++) {
              if (!injected[parsed.skills[si].name]) {
                injected[parsed.skills[si].name] = true;
                skillItemsToInject.push({ type: "skill", name: parsed.skills[si].name, path: parsed.skills[si].path });
              }
            }
          }
        }
        if (skillItemsToInject.length > 0) {
          console.log("[yoke/codex] injecting Claude skills:", skillItemsToInject.map(function(s) { return s.name; }).join(", "));
          input = input.concat(skillItemsToInject);
        }

        await appServer.send("turn/start", {
          threadId: state.threadId,
          input: input,
          model: state.model,
        }, 60000);

        // Wait for turn to complete
        await turnPromise;

        if (isCancelled()) break;

        // Wait for next message (multi-turn)
        var nextMsg = await waitForMessage();
        if (nextMsg === null) break;
        currentMessage = nextMsg;
      }
    } catch (e) {
      // Suppress AbortError when the user stopped the query.
      if (!isCancelled() && e.name !== "AbortError") {
        console.error("[yoke/codex] runQueryLoop error:", e.message || e);
        console.error("[yoke/codex] stack:", e.stack || "(no stack)");
        var loopErrMsg = e.message || String(e);
        pushEvent(isCodexAuthError(loopErrMsg)
          ? { yokeType: "auth_required", vendor: "codex" }
          : { yokeType: "error", text: loopErrMsg });
      }
    }

    state.done = true;
    endIterator(!!interruptDrainResolve);
  }

  var handle = {
    [Symbol.asyncIterator]: function() {
      return {
        next: function() {
          if (eventBuffer.length > 0) {
            return Promise.resolve({ value: eventBuffer.shift(), done: false });
          }
          if (iteratorDone) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise(function(resolve) { eventWaiting = resolve; });
        },
      };
    },

    pushMessage: function(text, images) {
      var input = images && images.length > 0
        ? codexImageInput.buildInput(text, images)
        : text || "";

      if (!state.loopStarted) {
        state.loopStarted = true;
        runQueryLoop(input);
      } else {
        pushMessageToQueue(input);
      }
    },

    setModel: function(model) {
      state.model = model || "gpt-5.6-terra";
      return Promise.resolve();
    },

    setEffort: function(effort) {
      // Stored for next thread
      return Promise.resolve();
    },

    setToolPolicy: function(policy) {
      // Codex uses approvalPolicy at thread creation
      return Promise.resolve();
    },

    stopTask: function(taskId) {
      // Codex doesn't expose sub-task stopping
      return Promise.resolve();
    },

    getContextUsage: function() {
      return Promise.resolve(state.lastUsage);
    },

    abort: function() {
      console.log("[yoke/codex] handle.abort() called, threadId=" + state.threadId + " already aborted=" + state.aborted);
      if (state.aborted) return interruptDrainPromise || Promise.resolve();
      var shouldDrain = !!turnResolve && !!state.threadId && !!appServer.started;
      var drain = shouldDrain ? startInterruptDrain() : Promise.resolve();
      state.aborted = true;
      // Send turn/interrupt to stop the server-side turn
      if (state.threadId && appServer.started) {
        appServer.send("turn/interrupt", { threadId: state.threadId }, 5000).catch(function() {});
      }
      // Keep the iterator open until Codex confirms that the provider-side turn
      // stopped. sdk-bridge finalizes the session when this iterator closes, so
      // ending it immediately would let a queued replacement resume the thread
      // while the interrupted turn was still running.
      if (turnResolve) {
        var resolve = turnResolve;
        turnResolve = null;
        resolve();
      }
      endIterator(shouldDrain);
      return drain;
    },

    close: function() {
      messageQueueEnded = true;
      if (messageWaiting) {
        var resolve = messageWaiting;
        messageWaiting = null;
        resolve(null);
      }
      endIterator(!!interruptDrainResolve);
    },

    endInput: function() {
      messageQueueEnded = true;
      if (messageWaiting) {
        var resolve = messageWaiting;
        messageWaiting = null;
        resolve(null);
      }
    },
  };

  // Listen for external abort (sdk-bridge's stopTask calls session.abortController.abort())
  if (abortController && abortController.signal) {
    abortController.signal.addEventListener("abort", function() {
      if (!state.aborted) handle.abort();
    }, { once: true });
  }

  return handle;
}

// --- Adapter factory ---

function retainClayConnectionOptions(defaultOpts, initOpts) {
  var retained = Object.assign({}, defaultOpts || {});
  var incoming = initOpts || {};
  var fields = ["clayPort", "clayTls", "clayAuthToken", "slug"];
  for (var i = 0; i < fields.length; i++) {
    var field = fields[i];
    if (Object.prototype.hasOwnProperty.call(incoming, field)) {
      retained[field] = incoming[field];
    }
  }
  return retained;
}

function codexHomeForRuntime(osUserInfo, serverOpts) {
  if (osUserInfo && osUserInfo.home) return osUserInfo.home;
  if (serverOpts && serverOpts.env && serverOpts.env.HOME) return serverOpts.env.HOME;
  try { return require("../../config").REAL_HOME; }
  catch (e) { return require("os").homedir(); }
}

function runtimeEnvironmentForCodex(effectiveInitOpts, osUserInfo) {
  if (effectiveInitOpts && effectiveInitOpts.env) return effectiveInitOpts.env;
  return osUserInfo ? buildUserEnv(osUserInfo) : null;
}

function buildCodexAppServerConfig(config) {
  return withCodexWorkerConfig(withCodexAppServerDefaults(config));
}

function createCodexCoreAdapter(opts) {
  var _cwd = (opts && opts.cwd) || process.cwd();
  var _slug = (opts && opts.slug) || "";
  var _defaultInitOpts = Object.assign({}, opts || {});
  var _cachedModels;
  var _defaultModel;
  // Whether _cachedModels came from a real `model/list` or is the hardcoded
  // seed standing in for one. Callers persist the catalog as last-known-good,
  // so handing them a seed without saying so lets one failed discovery
  // overwrite a real catalog. Stays "fallback-seed" until live discovery
  // actually succeeds.
  var _modelsProvenance;
  applyCatalog(null);
  var _appServer = null;
  var _initPromise = null;
  var _shutdownPromise = null;
  var _workspaceDependencies = null;
  var _refCount = 0;
  var _lastActiveAt = Date.now();
  var _shuttingDown = false;
  var _activeQueries = [];

  function updateLastActiveAt() {
    _lastActiveAt = Date.now();
  }

  function registerActiveQuery(entry) {
    _activeQueries.push(entry);
  }

  function removeActiveQuery(entry) {
    var next = [];
    for (var i = 0; i < _activeQueries.length; i++) {
      if (_activeQueries[i] !== entry) next.push(_activeQueries[i]);
    }
    _activeQueries = next;
  }

  function decrementRefCount() {
    if (_refCount > 0) {
      _refCount--;
    } else {
      console.error("[yoke/codex] refCount negative, bug!");
      _refCount = 0;
    }
    updateLastActiveAt();
  }

  function buildReadyResponse(skillNames) {
    return {
      models: _cachedModels,
      modelsProvenance: _modelsProvenance,
      defaultModel: _defaultModel,
      skills: skillNames || [],
      slashCommands: skillNames || [],
      fastModeState: null,
      capabilities: {
        effort: true,
        midSessionModelSwitch: true,
        fork: true,
        rollback: true,
        sessionListing: false,
        sessionRename: false,
        thinking: true,
        betas: false,
        rewind: true,
        sessionResume: true,
        promptSuggestions: true,
        elicitation: true,
        fileCheckpointing: false,
        contextCompacting: false,
        toolPolicy: ["ask", "allow-all"],
      },
    };
  }

  // Adopt a discovery result (or `null` for "no live discovery") along with the
  // provenance that goes with it, so the models and their label can never
  // disagree.
  function applyCatalog(liveModels) {
    var resolved = codexModels.resolveCodexCatalog(liveModels);
    _cachedModels = resolved.models;
    _defaultModel = resolved.defaultModel;
    _modelsProvenance = resolved.provenance;
    return resolved;
  }

  function clearRuntimeState() {
    _appServer = null;
    _initPromise = null;
    applyCatalog(null);
    _refCount = 0;
    _activeQueries = [];
    _workspaceDependencies = null;
    updateLastActiveAt();
  }

  async function listCodexModels(appServer) {
    var models = [];
    var cursor = null;
    do {
      var params = { includeHidden: false, limit: 100 };
      if (cursor) params.cursor = cursor;
      var result = await appServer.send("model/list", params, 10000);
      if (result && Array.isArray(result.data)) {
        for (var i = 0; i < result.data.length; i++) {
          models.push(result.data[i]);
        }
      }
      cursor = result && result.nextCursor ? result.nextCursor : null;
    } while (cursor);
    return codexModels.normalizeCodexModels(models);
  }

  function waitForRefCount(targetCount, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 5000);
    return new Promise(function(resolve) {
      function tick() {
        if (_refCount <= targetCount) {
          resolve(true);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(tick, 50);
      }
      tick();
    });
  }

  function stopAppServer(deadlineMs) {
    var proc = _appServer && _appServer.proc ? _appServer.proc : null;
    if (!_appServer) return Promise.resolve(true);
    try {
      _appServer.stop();
    } catch (e) {
      console.error("[yoke/codex] App-server stop error:", e.message || e);
    }
    if (!proc) return Promise.resolve(true);
    var remaining = (typeof deadlineMs === "number") ? Math.max(0, deadlineMs - Date.now()) : 5000;
    return waitForProcessExit(proc, remaining).then(function(exited) {
      if (!exited) {
        try {
          proc.kill("SIGKILL");
        } catch (e) {}
      }
      return exited;
    });
  }

  function beginShutdown(force, idleMs) {
    if (_shutdownPromise) return _shutdownPromise;
    if (_shuttingDown) return null;

    _shuttingDown = true;

    _shutdownPromise = (async function() {
      var deadline = Date.now() + 5000;
      var shouldAbort = !!force;

      if (_initPromise) {
        try {
          await Promise.race([
            _initPromise.catch(function() { return null; }),
            waitMs(Math.max(0, deadline - Date.now())),
          ]);
        } catch (e) {}
      }

      if (shouldAbort && _activeQueries.length > 0) {
        var active = _activeQueries.slice();
        await abortQueriesAndWait(active, deadline);
        await waitForRefCount(0, Math.max(0, deadline - Date.now()));
      }

      if (_appServer) {
        await stopAppServer(deadline);
      }

      clearRuntimeState();
      _shuttingDown = false;
      _shutdownPromise = null;
      return true;
    })().catch(function(err) {
      clearRuntimeState();
      _shuttingDown = false;
      _shutdownPromise = null;
      throw err;
    });

    return _shutdownPromise;
  }

  var adapter = {
    vendor: "codex",

    init: function(initOpts) {
      if (_shuttingDown) {
        return Promise.reject(createShutdownError());
      }

      _defaultInitOpts = retainClayConnectionOptions(_defaultInitOpts, initOpts);
      var effectiveInitOpts = Object.assign({}, _defaultInitOpts, initOpts || {});

      // Already initialized - return cached result
      if (_appServer && _appServer.started && _cachedModels.length > 0) {
        return Promise.resolve(buildReadyResponse([]));
      }

      // Deduplicate concurrent init calls
      if (_initPromise) return _initPromise;

      _initPromise = (async function() {
        var osUserInfo = null;
        if (effectiveInitOpts.linuxUser) {
          try {
            osUserInfo = resolveOsUserInfo(effectiveInitOpts.linuxUser);
          } catch (e) {
            throw new Error("Cannot resolve the Codex credential home for the session owner.");
          }
        }
        var serverOpts = { cwd: _cwd, env: runtimeEnvironmentForCodex(effectiveInitOpts, osUserInfo) };
        if (osUserInfo) {
          serverOpts.osUserInfo = osUserInfo;
        }

        // Extract adapter options
        if (effectiveInitOpts && effectiveInitOpts.adapterOptions && effectiveInitOpts.adapterOptions.CODEX) {
          var co = effectiveInitOpts.adapterOptions.CODEX;
          if (co.apiKey) serverOpts.env = Object.assign({}, serverOpts.env || process.env, { OPENAI_API_KEY: co.apiKey });
          if (co.baseUrl) serverOpts.env = Object.assign({}, serverOpts.env || process.env, { OPENAI_BASE_URL: co.baseUrl });
          if (co.config) serverOpts.config = co.config;
        }
        serverOpts.config = buildCodexAppServerConfig(serverOpts.config);

        // Track 1: Read local MCP server definitions from ~/.clay/mcp.json
        // and inject into Codex config so Codex manages them natively.
        var mcpServerConfig = {};
        try {
          var mcpLocal = require("../../mcp-local");
          var localMcpServers = mcpLocal.readMergedServers();
          var mcpNames = Object.keys(localMcpServers);
          for (var mi = 0; mi < mcpNames.length; mi++) {
            var ms = localMcpServers[mcpNames[mi]];
            if (ms.command) {
              mcpServerConfig[mcpNames[mi]] = { command: ms.command, args: ms.args || [] };
              if (ms.env && Object.keys(ms.env).length > 0) {
                mcpServerConfig[mcpNames[mi]].env = ms.env;
              }
            }
          }
        } catch (e) {
          console.error("[codex] Failed to read local MCP config:", e.message);
        }

        // Track 2: Add clay-tools bridge server for in-app + remote MCP tools.
        var bridgePath = require("path").join(__dirname, "..", "mcp-bridge-server.js");
        var clayPort = effectiveInitOpts.clayPort || process.env.CLAY_PORT || 2633;
        var clayTls = effectiveInitOpts.clayTls || false;
        var clayAuthToken = effectiveInitOpts.clayAuthToken || "";
        var claySlug = effectiveInitOpts.slug || _slug || "";
        try {
          if (require("fs").existsSync(bridgePath)) {
            var bridgeArgs = [bridgePath, "--port", String(clayPort), "--slug", claySlug];
            if (clayTls) bridgeArgs.push("--tls");
            var bridgeEnv = {};
            if (clayAuthToken) bridgeEnv.CLAY_AUTH_TOKEN = clayAuthToken;
            mcpServerConfig["clay-tools"] = {
              command: process.execPath,
              args: bridgeArgs,
              env: Object.keys(bridgeEnv).length > 0 ? bridgeEnv : undefined,
            };
          }
        } catch (e) {
          console.error("[codex] Failed to configure clay-tools bridge:", e.message);
        }

        if (Object.keys(mcpServerConfig).length > 0) {
          serverOpts.config = Object.assign({}, serverOpts.config || {}, {
            mcp_servers: mcpServerConfig,
          });
          console.log("[codex] MCP servers configured:", Object.keys(mcpServerConfig).join(", "));
          try {
            var names = Object.keys(mcpServerConfig);
            for (var di = 0; di < names.length; di++) {
              var sc = mcpServerConfig[names[di]];
              console.log("[codex] MCP server '" + names[di] + "': command=" + sc.command + " args=" + JSON.stringify(sc.args));
            }
          } catch (e) {}
        }

        // The observed Codex cache schema requires this field but older valid
        // cache files omit it.
        // Repair only that known optional capability before Codex reads the
        // cache, then let Codex renew the TTL and fetch its authoritative data.
        var runtimeHome = codexHomeForRuntime(osUserInfo, serverOpts);
        var cacheMigration = codexModelsCache.migrateModelsCache(
          codexModelsCache.modelsCachePath(runtimeHome, serverOpts.env || process.env));
        if (cacheMigration.migrated) {
          console.info("[codex] Migrated " + cacheMigration.defaulted +
            " legacy model cache entr" + (cacheMigration.defaulted === 1 ? "y" : "ies") + ".");
        } else if (cacheMigration.reason === "read_failed" || cacheMigration.reason === "write_failed") {
          console.warn("[codex] Failed to migrate Codex models cache:",
            cacheMigration.error && (cacheMigration.error.message || cacheMigration.error));
        }

        // Spawn and initialize app-server
        _appServer = new CodexAppServer(null, serverOpts);
        await _appServer.start();

        await _appServer.send("initialize", {
          clientInfo: { name: "clay", title: "Clay", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        });
        _appServer.notify("initialized", {});

        _workspaceDependencies = await codexWorkspaceDependencies.createWorkspaceDependenciesSupport({
          appServer: _appServer,
          homeDir: runtimeHome,
          runtimeRoot: effectiveInitOpts.workspaceDependenciesRoot || process.env.CLAY_CODEX_RUNTIME_ROOT || undefined,
        });
        if (_workspaceDependencies.enabled) {
          console.log("[codex] Workspace dependencies enabled, bundle=" + _workspaceDependencies.details.bundleVersion);
        } else {
          console.log("[codex] Workspace dependencies unavailable: " + _workspaceDependencies.reason);
        }

        if (_shuttingDown) {
          await stopAppServer(Date.now() + 1000);
          throw createShutdownError();
        }

        var liveModels = [];
        try {
          liveModels = await listCodexModels(_appServer);
        } catch (e) {
          console.error("[codex] model/list failed, using fallback models:", e.message || e);
        }
        applyCatalog(liveModels);
        console.log("[codex] App-server initialized, models: " + _cachedModels.map(function(model) { return model.value || model.id || model; }).join(", "));

        // Discover skills: built-in Codex skills + Claude skills
        var skillNames = [];
        try {
          var REAL_HOME = osUserInfo && osUserInfo.home;
          if (!REAL_HOME) {
            try { REAL_HOME = require("../../config").REAL_HOME; } catch (e) { REAL_HOME = require("os").homedir(); }
          }
          var claudeSkillsDir = require("path").join(REAL_HOME, ".claude", "skills");
          var extraRoots = _cwd ? [{ cwd: _cwd, extraUserRoots: [claudeSkillsDir] }] : [];
          var skillsResult = await _appServer.send("skills/list", {
            cwds: _cwd ? [_cwd] : [],
            forceReload: true,
            perCwdExtraUserRoots: extraRoots,
          }, 10000).catch(function(e) {
            console.error("[codex] skills/list failed:", e.message);
            return null;
          });
          // Response shape: { data: [{ cwd, skills: [{ name, ... }] }] }
          if (skillsResult && skillsResult.data) {
            for (var di = 0; di < skillsResult.data.length; di++) {
              var entry = skillsResult.data[di];
              if (!entry.skills) continue;
              for (var sk = 0; sk < entry.skills.length; sk++) {
                if (entry.skills[sk].name && skillNames.indexOf(entry.skills[sk].name) === -1) {
                  skillNames.push(entry.skills[sk].name);
                }
              }
            }
          }
          // Also discover Claude skills directly as fallback
          var claudeSkills = discoverClaudeSkills(_cwd);
          var claudeSkillNames = Object.keys(claudeSkills);
          for (var csn = 0; csn < claudeSkillNames.length; csn++) {
            if (skillNames.indexOf(claudeSkillNames[csn]) === -1) skillNames.push(claudeSkillNames[csn]);
          }
          console.log("[codex] Discovered skills:", skillNames.length, "(" + skillNames.slice(0, 5).join(", ") + (skillNames.length > 5 ? "..." : "") + ")");
        } catch (e) {
          console.error("[codex] Failed to discover skills:", e.message);
        }

        if (_shuttingDown) {
          await stopAppServer(Date.now() + 1000);
          throw createShutdownError();
        }

        _initPromise = null;
        updateLastActiveAt();

        return buildReadyResponse(skillNames);
      })();

      return _initPromise;
    },

    supportedModels: function() {
      // Return the last discovered catalog, with fallback models available
      // before app-server initialization completes.
      return Promise.resolve(_cachedModels.length > 0 ? _cachedModels.slice() : codexModels.fallbackCodexModels());
    },

    // supportedModels() returns a bare array, so provenance has to be asked
    // for separately. Callers that persist the catalog must consult this
    // rather than assume a returned list was live-discovered.
    modelsProvenance: function() {
      return _cachedModels.length > 0 ? _modelsProvenance : "fallback-seed";
    },

    createToolServer: function(def) {
      // Codex handles tools internally (file ops, bash, etc.)
      // MCP tools are configured via Codex config, not SDK.
      console.log("[yoke/codex] createToolServer skipped: Codex handles tools internally");
      return null;
    },

    createQuery: async function(queryOpts) {
      if (_shuttingDown) {
        throw createShutdownError();
      }

      if (!_appServer || !_appServer.started) {
        await adapter.init(queryOpts || {});
      }

      if (_shuttingDown) {
        throw createShutdownError();
      }

      if (!_appServer || !_appServer.started) {
        throw new Error("[yoke/codex] Adapter not initialized. Call init() first.");
      }

      var model = queryOpts.model || _defaultModel || codexModels.DEFAULT_CODEX_MODEL;
      var ac = queryOpts.abortController || new AbortController();
      var activeEntry = {
        abort: function() {
          try {
            ac.abort();
          } catch (e) {}
        },
      };

      // Map YOKE options to Codex thread options
      var codexOpts = (queryOpts.adapterOptions && queryOpts.adapterOptions.CODEX) || {};

      var handleOpts = {
        model: model,
        cwd: queryOpts.cwd || _cwd,
        systemPrompt: queryOpts.systemPrompt || "",
        abortController: ac,
        canUseTool: queryOpts.canUseTool || null,
        onElicitation: queryOpts.onElicitation || null,
        resumeSessionId: queryOpts.resumeSessionId || null,
        workspaceDependencies: _workspaceDependencies,
      };

      // Reasoning effort
      if (queryOpts.effort || codexOpts.modelReasoningEffort) {
        handleOpts.modelReasoningEffort = codexOpts.modelReasoningEffort || queryOpts.effort || "medium";
      }

      // Tool policy -> approval mode
      if (queryOpts.toolPolicy === "allow-all") {
        handleOpts.approvalPolicy = "never";
      } else {
        handleOpts.approvalPolicy = codexOpts.approvalPolicy || "on-request";
      }

      // Sandbox mode
      handleOpts.sandboxMode = codexOpts.sandboxMode || "workspace-write";

      // Web search
      if (codexOpts.webSearchMode && codexOpts.webSearchMode !== "disabled") {
        handleOpts.webSearchMode = codexOpts.webSearchMode;
      }

      console.log("[yoke/codex] createQuery: model=" + model + " approval=" + handleOpts.approvalPolicy + " sandbox=" + handleOpts.sandboxMode);

      try {
        var currentLimits = await _appServer.send("account/rateLimits/read", {}, 10000);
        handleOpts.initialEvents = codexRoutingUtils.flattenCodexRateLimitEvents(currentLimits || {});
      } catch (e) {
        console.error("[yoke/codex] account/rateLimits/read failed (non-fatal):", e.message || e);
      }

      _refCount++;
      registerActiveQuery(activeEntry);

      var handle;
      try {
        handleOpts.onFinished = function() {
          removeActiveQuery(activeEntry);
          decrementRefCount();
        };
        handle = createCodexQueryHandle(_appServer, handleOpts);
      } catch (e) {
        removeActiveQuery(activeEntry);
        decrementRefCount();
        throw e;
      }

      activeEntry.handle = handle;
      activeEntry.abort = function() {
        try {
          if (handle && typeof handle.abort === "function") {
            return handle.abort();
          } else {
            ac.abort();
          }
        } catch (e) {}
        return Promise.resolve();
      };

      return handle;
    },

    // --- Title generation ---
    generateTitle: async function(messages, opts) {
      var systemPrompt = "You are a title generator. Output only a short title (3-8 words). No quotes, no punctuation at the end, no explanation.";
      var prompt = "Below is a conversation between a user and an AI assistant. Generate a short, descriptive title (3-8 words) that captures the main topic. Reply with ONLY the title, nothing else.\n\n";
      for (var i = 0; i < messages.length; i++) {
        prompt += "User message " + (i + 1) + ": " + messages[i] + "\n";
      }
      var ac = new AbortController();
      var handle = await adapter.createQuery({
        cwd: (opts && opts.cwd) || _cwd,
        env: opts && opts.env,
        systemPrompt: systemPrompt,
        model: "gpt-5.4-mini",
        abortController: ac,
        canUseTool: function() { return Promise.resolve({ behavior: "deny", message: "No tools." }); },
      });
      handle.pushMessage(prompt);
      var title = "";
      var streamed = false;
      try {
        for await (var msg of handle) {
          if (msg.yokeType === "text_delta" && msg.text) {
            streamed = true;
            title += msg.text;
          } else if (msg.yokeType === "message" && msg.messageRole === "assistant" && !streamed && msg.content) {
            var content = msg.content;
            if (Array.isArray(content)) {
              for (var ci = 0; ci < content.length; ci++) {
                if (content[ci].type === "text" && content[ci].text) {
                  title += content[ci].text;
                }
              }
            }
          } else if (msg.yokeType === "result") {
            break;
          }
        }
      } finally {
        handle.close();
      }
      return title.replace(/[\r\n]+/g, " ").replace(/^["'\s]+|["'\s.]+$/g, "").trim();
    },

    // Codex has session persistence via thread IDs
    getSessionInfo: function(sessionId) {
      return Promise.resolve(null);
    },
    listSessions: function() { return Promise.resolve([]); },
    renameSession: function() { return Promise.resolve(); },
    forkSession: function(threadId, opts) {
      if (!_appServer || !_appServer.started) return Promise.resolve(null);
      return _appServer.send("thread/fork", { threadId: threadId }, 30000).then(function(result) {
        var newThreadId = (result && result.thread) ? result.thread.id : null;
        if (!newThreadId) throw new Error("thread/fork did not return a new thread id");
        return { sessionId: newThreadId };
      });
    },
    rollbackThread: function(threadId, numTurns) {
      if (!_appServer || !_appServer.started) return Promise.resolve(null);
      return _appServer.send("thread/rollback", { threadId: threadId, numTurns: numTurns }, 30000);
    },

    // Shutdown the app-server process
    shutdown: function() {
      return beginShutdown(true);
    },

    shutdownIfIdle: function(idleMs) {
      if (_shuttingDown || _shutdownPromise) return Promise.resolve(false);
      if (_initPromise) return Promise.resolve(false);
      if (!_appServer) return Promise.resolve(false);
      if (_refCount > 0) return Promise.resolve(false);
      if (Date.now() - _lastActiveAt < (idleMs || 0)) return Promise.resolve(false);
      return beginShutdown(false).then(function() {
        console.log("[yoke/codex] Reclaimed idle adapter for project " + (_slug || _cwd));
        return true;
      });
    },
  };

  return adapter;
}

module.exports = {
  createCodexAdapter: function(opts) {
    return require("./codex-pool").createCodexAdapterPool(opts);
  },
  createCodexCoreAdapter: createCodexCoreAdapter,
  _test: {
    eventThreadId: eventThreadId,
    eventTurnId: eventTurnId,
    flattenEvent: flattenEvent,
    currentContextTokensFromTokenUsage: currentContextTokensFromTokenUsage,
    shouldRouteServerEvent: shouldRouteServerEvent,
    abortQueriesAndWait: abortQueriesAndWait,
    isThreadStillRunningError: isThreadStillRunningError,
    resumeThreadAfterInterrupt: resumeThreadAfterInterrupt,
    retainClayConnectionOptions: retainClayConnectionOptions,
    runtimeEnvironmentForCodex: runtimeEnvironmentForCodex,
    buildCodexAppServerConfig: buildCodexAppServerConfig,
  },
  contractTestKit: {
    createEventState: createEventState,
    createQueryHandle: createCodexQueryHandle,
    normalizeEvent: flattenEvent,
  },
};
