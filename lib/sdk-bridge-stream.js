// Provider stream orchestration. Detailed policy, event, error, and cleanup
// behavior lives in focused modules so lifecycle boundaries remain auditable.

var finalizeStream = require("./sdk-bridge-stream-finalize").finalizeStream;
var policy = require("./sdk-bridge-stream-policy");
var watchdog = require("./sdk-bridge-stream-watchdog");
var events = require("./sdk-bridge-stream-events");
var handleStreamError = require("./sdk-bridge-stream-error").handleStreamError;
var createResumeNotifier = require("./sdk-bridge-stream-notify").createResumeNotifier;

function streamContext(ctx) {
  return Object.assign({}, ctx, {
    getLinuxUserForSession: ctx.getLinuxUserForSession || function () { return null; },
    notifyResumeGaveUp: createResumeNotifier(ctx),
  });
}

function finishStream(ctx, state) {
  clearInterval(state.watchdogTimer);
  watchdog.releaseTools(state);
  finalizeStream({ abortController: state.abortController,
    clearInteractiveToolWaits: policy.clearInteractiveToolWaits,
    controlledFence: state.fence, fencedOut: state.fencedOut, opts: ctx.opts,
    query: state.query, rateLimitResumeLabel: ctx.rateLimitResumeLabel,
    sendAndRecord: ctx.sendAndRecord, session: state.session, sm: ctx.sm });
}

function attachBridgeStream(ctx) {
  var activeContext = streamContext(ctx);

  async function processQueryStream(session, suppliedFence) {
    var state = watchdog.createState(session, suppliedFence);
    console.log("[sdk-bridge] processQueryStream: starting for-await loop, vendor=" +
      watchdog.vendorFor(activeContext, session));
    watchdog.startWatchdog(activeContext, state);
    try {
      await events.consumeStream(activeContext, state);
    } catch (error) {
      handleStreamError(activeContext, state, error);
    } finally {
      finishStream(activeContext, state);
    }
  }

  return { processQueryStream: processQueryStream };
}

module.exports = { attachBridgeStream: attachBridgeStream,
  midstreamTimeoutFor: policy.midstreamTimeoutFor,
  watchdogTimeoutFor: policy.watchdogTimeoutFor,
  clearInteractiveToolWaits: policy.clearInteractiveToolWaits,
  isWatchdogProgressEvent: policy.isWatchdogProgressEvent,
  isContextOverflowError: policy.isContextOverflowError,
  isTransientProviderErrorText: policy.isTransientProviderErrorText };
