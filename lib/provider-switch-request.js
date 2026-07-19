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

var APPROVED_CONTINUE_PROMPT = "The provider switch you requested was approved by the user. Continue the interrupted work from the Clay handoff context. Do not restart from scratch and do not re-ask for confirmation.";

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
  function whenSessionIdle(session, timeoutMs, done) {
    var startedAt = Date.now();
    (function poll() {
      if (session.destroying) return done(false);
      if (!session.isProcessing) return done(true);
      if (Date.now() - startedAt > timeoutMs) return done(false);
      setTimeout(poll, 200);
    })();
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

  return { requestSwitch: requestSwitch };
}

module.exports = {
  attachProviderSwitchRequest: attachProviderSwitchRequest,
  APPROVED_CONTINUE_PROMPT: APPROVED_CONTINUE_PROMPT,
};
