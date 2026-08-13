// Target-local recovery adapters. External delivery content stays in the
// target session file; ControlStore retains only its stable reference.

var recoveryTarget = require("./coop-control-runtime-target");

function createTargetRecoveryAdapter(options) {
  var opts = options || {};

  function deliveryEnvelope(referenceId, value) {
    if (!opts.replayStore || typeof opts.replayStore.resolve !== "function") return null;
    return opts.replayStore.resolve(referenceId, value);
  }

  function resolveDelivery(referenceId, effect) {
    var delivery = deliveryEnvelope(referenceId, effect);
    if (!delivery) return null;
    return { payloadDigest: delivery.payloadDigest, apply: function (session, currentEffect) {
      return opts.applyExecutionMessage(session, delivery.payload, delivery.envelope, delivery.text,
        currentEffect.effectId, true);
    } };
  }

  function createHandlers() {
    return recoveryTarget.createTargetRecoveryHandlers({ control: opts.control,
      executionMetadata: opts.executionMetadata, projectId: opts.projectId,
      resolveDelivery: resolveDelivery,
      send: function (stable) {
        var effectId = opts.delivery.effectIdentity(stable,
          { kind: "execution_update", target: stable.recipient });
        var delivery = deliveryEnvelope(stable.payloadReference || stable.referenceId, {
          effectId: effectId, messageId: stable.messageId, payloadDigest: stable.payloadDigest,
          recipient: stable.recipient,
        });
        if (!delivery) return { accepted: false };
        opts.delivery.receive(stable, { kind: "execution_update", target: stable.recipient });
        return { accepted: true };
      }, sm: opts.sm, startQuery: opts.startQuery });
  }

  function handlers() {
    var result = createHandlers();
    result.cleanupReceived = function () { return opts.replayStore.cleanupReceived(opts.delivery); };
    return result;
  }

  return { createHandlers: handlers };
}

module.exports = { createTargetRecoveryAdapter: createTargetRecoveryAdapter };
