// Provider Switch Request — the harness-side gate behind the model's
// `switch_provider` tool.
//
// THE MODEL NEVER SWITCHES PROVIDERS ITSELF. Its tool call lands here, gets
// validated with the exact same route/model resolution `/provider` uses, and
// becomes a confirmation card in the chat (the generic user_dialog flow).
// The model is told to end its turn. Only an explicit user approval runs the
// shared switch executor — with the same comparable-model suggestion a
// manual /provider would pick — and then auto-continues the interrupted work
// on the new provider via the scheduled-messages continuation path (the same
// one outage failover uses).
//
// Prompt-injection posture: injected text can at most make the model ask.
// The card shows the model's own stated reason so the user can spot a
// suspicious request before approving.

var crypto = require("crypto");
var providerHealth = require("./provider-health");
var { candidateHealth } = require("./provider-routes");
var { createSessionIdleDefer } = require("./session-idle-defer");

var APPROVED_CONTINUE_PROMPT = "The provider switch you requested was approved by the user. Continue the interrupted work from the Clay handoff context. Do not restart from scratch and do not re-ask for confirmation.";
var COORDINATOR_CONTINUE_PROMPT = "Coop switched this session to a healthy provider after the previous route became unavailable. Continue the interrupted work from the Clay handoff context. Do not restart from scratch and do not re-ask for confirmation.";

// How long a queued control-plane change waits for the target's turn to end
// before it is dropped. Matches the switch_provider approval wait.
var DEFER_IDLE_WAIT_MS = 10 * 60 * 1000;

function attachProviderSwitchRequest(ctx) {
  var sm = ctx.sm;
  var switcher = ctx.switcher;
  var scheduledMessages = ctx.scheduledMessages;
  var sendConfigForSession = ctx.sendConfigForSession || function () {};

  function textResult(text, isError) {
    var out = { content: [{ type: "text", text: text }] };
    if (isError) out.isError = true;
    return out;
  }

  // Wait for the requesting model's turn to actually end before switching.
  // The tool result tells the model to end its turn, but the user can click
  // Approve while the assistant is still streaming its sign-off.
  var idleDefer = createSessionIdleDefer({
    onReconciled: function () {
      if (typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
    },
  });

  function reconcileTerminalProcessingState(session) {
    return idleDefer.reconcile(session);
  }

  function whenSessionIdle(session, timeoutMs, done) {
    idleDefer.whenIdle(session, timeoutMs, function (outcome) {
      done(outcome === "idle");
    });
  }

  function executeApprovedSwitch(session, route, suggestion, reason) {
    var result = switcher.executeProviderSwitch({
      session: session,
      targetVendor: route.vendor,
      targetRouteId: route.id,
      targetModel: suggestion.model || null,
      trigger: "model-request",
      initiatedBy: { source: "switch-provider-tool", userId: null },
      preserveQueuedMessages: true,
    });
    if (!result.ok) {
      sm.sendAndRecord(session, {
        type: "info",
        variant: "warning",
        text: "The approved provider switch could not run: " + (result.message || result.reason || "unknown error") + ".",
      });
      return;
    }
    sendConfigForSession(null, session);
    var label = result.label || route.label || route.vendor;
    var continued = scheduledMessages.continueAfterProviderSwitch(
      session,
      APPROVED_CONTINUE_PROMPT,
      "↻ Continuing on " + label + " (model-requested switch)",
      label
    );
    if (!continued) {
      sm.sendAndRecord(session, {
        type: "info",
        text: "Switched to " + label + ". Send a message to continue — context will be passed automatically.",
      });
    }
  }

  function postConfirmationCard(session, route, suggestion, reason) {
    var requestId = crypto.randomUUID();
    if (!session.pendingUserDialogs) session.pendingUserDialogs = {};
    session.pendingUserDialogs[requestId] = {
      request: { dialogKind: "switch_provider" },
      resolve: function (response) {
        if (!response || response.behavior !== "completed") {
          sm.sendAndRecord(session, {
            type: "info",
            text: "Provider switch request declined — staying on the current provider.",
          });
          return;
        }
        var IDLE_WAIT_MS = 10 * 60 * 1000;
        if (session.isProcessing) {
          sm.sendAndRecord(session, {
            type: "info",
            text: "Provider switch approved — waiting for the current turn to finish, then switching automatically.",
          });
        }
        whenSessionIdle(session, IDLE_WAIT_MS, function (idle) {
          if (!idle) {
            sm.sendAndRecord(session, {
              type: "info",
              variant: "warning",
              text: "Approved the provider switch, but the current turn did not finish within 10 minutes — the switch was not run. Use /provider " + route.id + " to switch manually.",
            });
            return;
          }
          executeApprovedSwitch(session, route, suggestion, reason);
        });
      },
    };
    var modelLine = suggestion.model
      ? "Model: " + suggestion.model + " (" + suggestion.match + " match for " + (suggestion.sourceModel || "current model") + ")"
      : "";
    sm.sendAndRecord(session, {
      type: "user_dialog_request",
      requestId: requestId,
      dialogKind: "switch_provider",
      payload: {
        title: "The model requests a provider switch",
        message: "Target: " + route.label + " (" + route.id + ")\n" +
          (modelLine ? modelLine + "\n" : "") +
          "Reason given by the model: " + reason,
        options: [{ label: "Approve switch to " + (route.label || route.vendor), value: "approve" }],
        cancelLabel: "Decline",
      },
    });
  }

  // The MCP tool handler. Validates, posts the card, and returns the text
  // the model reads. Never switches inline.
  function requestSwitch(input) {
    var session = sm.getActiveSession && sm.getActiveSession();
    if (!session) {
      return textResult("Error: no active session; cannot request a provider switch.", true);
    }
    if (session.loop && session.loop.active && session.loop.role !== "crafting") {
      return textResult("Error: autonomous mode — provider switches are not available here.", true);
    }
    var target = String((input && input.target) || "").trim();
    var reason = String((input && input.reason) || "").trim();
    if (!target || !reason) {
      return textResult("Error: both `target` and `reason` are required.", true);
    }
    var route = switcher.resolveSwitchTargetRoute(target, session);
    if (!route) {
      return textResult("Unknown switch target \"" + target + "\".\n" + switcher.providerTargetsSummary(session), true);
    }
    if (route.vendor === session.vendor && (!route.id || route.id === session.providerRouteId)) {
      return textResult("The session is already on " + (route.label || route.vendor) + "; no switch needed.", true);
    }
    if (!route.enabled) {
      return textResult((route.label || route.vendor) + " is not available on this machine." + (route.setup ? " Setup: " + route.setup : ""), true);
    }
    var suggestion = switcher.suggestionForRoute(route, session);
    if (!suggestion || !suggestion.model) {
      return textResult("No exact or comparable model is available on " + (route.label || route.vendor) + " for the current model. The user can still switch manually with /switch " + route.id + " if they accept that provider's default model.", true);
    }
    postConfirmationCard(session, route, suggestion, reason.slice(0, 400));
    return textResult(
      "Switch request posted to the user for confirmation (target: " + route.label + ", model: " + suggestion.model + "). " +
      "End your turn now without further commentary. If the user approves, the conversation continues automatically on the new provider with full handoff context. " +
      "If they decline, you will stay on the current provider."
    );
  }

  function notifySession(session, text, variant) {
    if (!sm || typeof sm.sendAndRecord !== "function") return;
    var message = { type: "info", text: text };
    if (variant) message.variant = variant;
    sm.sendAndRecord(session, message);
  }

  // Queue an already-validated coordinator switch for the end of the target's
  // current turn. This used to be a flat refusal, which pushed the retry onto
  // Coop's model: the only signal it got was a tool error reading "the target
  // session is still processing", and nothing anywhere retried. The switch is
  // authorized by the time we get here, so the honest answer is "queued", not
  // "no".
  //
  // Keyed by idempotencyKey so Coop re-issuing the SAME request while it is
  // queued gets the same acknowledgement instead of stacking a second switch,
  // which is what that key already means to executeProviderSwitch.
  function deferControlledSwitch(session, request, route, model, idempotencyKey) {
    var pending = session._coopControlledSwitchDeferred;
    if (pending && pending !== idempotencyKey) {
      return { ok: false, reason: "switch-queued",
        message: "A different provider switch is already queued for this session" };
    }
    var ack = { ok: true, deferred: true, reused: false,
      targetRouteId: route.id, targetModel: model, continued: false };
    if (pending === idempotencyKey) return ack;
    session._coopControlledSwitchDeferred = idempotencyKey;
    idleDefer.whenIdle(session, DEFER_IDLE_WAIT_MS, function (outcome) {
      session._coopControlledSwitchDeferred = null;
      if (outcome !== "idle") {
        notifySession(session, outcome === "destroyed" ?
          "A queued Coop-authorized provider switch was dropped because the session ended." :
          "A queued Coop-authorized provider switch was dropped because the current turn did not " +
            "finish within 10 minutes.", "warning");
        return;
      }
      var result = runControlledSwitch(session, request, route, model, idempotencyKey);
      if (!result.ok) {
        notifySession(session, "The queued Coop-authorized provider switch could not run: " +
          (result.message || result.reason || "unknown error") + ".", "warning");
      }
    });
    return ack;
  }

  function switchControlledSession(input) {
    var request = input || {};
    var session = request.session;
    var target = String(request.target || "").trim();
    var model = String(request.model || "").trim();
    var reason = String(request.reason || "").trim();
    var idempotencyKey = String(request.idempotencyKey || "").trim();
    if (!session || !target || !model || !reason || !idempotencyKey) {
      return { ok: false, reason: "bad-params", message: "session, target, model, reason, and idempotencyKey are required" };
    }
    reconcileTerminalProcessingState(session);
    var route = switcher.resolveSwitchTargetRoute(target, session);
    if (!route) return { ok: false, reason: "route-unavailable", message: "Unknown provider route" };
    // Cross-project control can run before any browser has connected to the
    // target project. In that state installedVendors/providerRoutes have not
    // completed their UI warmup yet, while availableVendors already reflects
    // the adapters that were created from installed binaries at project boot.
    // The shared executor below independently rechecks adapter availability
    // and the exact verified route/model catalog.
    if (route.enabled !== true && (sm.availableVendors || []).indexOf(route.vendor) !== -1) {
      route = Object.assign({}, route, { available: true, enabled: true });
    }
    if (!route.enabled) {
      return {
        ok: false,
        reason: "route-unavailable",
        message: (route.label || route.vendor) + " is not available" +
          " (available adapters: " + (sm.availableVendors || []).join(", ") +
          "; installed providers: " + (sm.installedVendors || []).join(", ") + ")",
      };
    }
    if (candidateHealth(route, model).state === providerHealth.UNHEALTHY) {
      return { ok: false, reason: "target-unhealthy", message: route.label + " / " + model + " is unhealthy" };
    }
    // Validation is complete, so an impossible switch is still refused
    // immediately rather than ten minutes from now. Only the execution waits.
    if (session.isProcessing) {
      return deferControlledSwitch(session, request, route, model, idempotencyKey);
    }
    return runControlledSwitch(session, request, route, model, idempotencyKey);
  }

  function runControlledSwitch(session, request, route, model, idempotencyKey) {
    var reason = String(request.reason || "").trim();
    var portfolioTaskId = String(request.portfolioTaskId || "").trim();
    var bindingRevision = Number(request.bindingRevision);
    var result = switcher.executeProviderSwitch({
      session: session,
      targetVendor: route.vendor,
      targetRouteId: route.id,
      targetModel: model,
      trigger: "coordinator-request",
      initiatedBy: { source: "coop-coordinator", userId: null },
      preserveQueuedMessages: true,
      idempotencyKey: idempotencyKey,
      routingRationale: reason.slice(0, 400) + " (portfolio task " + portfolioTaskId +
        " revision " + bindingRevision + ", authorized by " +
        String(request.sourceSessionStorageId || "canonical Coop") + ")",
    });
    if (!result.ok) return result;
    sendConfigForSession(null, session);
    var continued = false;
    if (!result.reused) {
      var label = result.label || route.label || route.vendor;
      continued = scheduledMessages.continueAfterProviderSwitch(
        session,
        COORDINATOR_CONTINUE_PROMPT,
        "↻ Continuing on " + label + " (Coop-authorized switch)",
        label
      );
    }
    return {
      ok: true,
      reused: !!result.reused,
      targetRouteId: route.id,
      targetModel: model,
      continued: !!continued,
    };
  }

  return {
    requestSwitch: requestSwitch,
    switchControlledSession: switchControlledSession,
  };
}

module.exports = {
  attachProviderSwitchRequest: attachProviderSwitchRequest,
  APPROVED_CONTINUE_PROMPT: APPROVED_CONTINUE_PROMPT,
  COORDINATOR_CONTINUE_PROMPT: COORDINATOR_CONTINUE_PROMPT,
};
