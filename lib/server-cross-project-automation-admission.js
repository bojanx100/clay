// Narrow cross-project admission seam for typed autonomous project work.
// Owner-directed Thread admission remains in server-cross-project.js.

function createAutomationImplementationAdmission(options) {
  var opts = options || {};

  function admit(input, request, context) {
    if (!request.coopTopicRef || !request.automationAuthorization) {
      return { ok: false, reason: "automation_authorization_malformed" };
    }
    if (String(input && input.coopIngressId || "")) {
      return { ok: false, reason: "automation_owner_ingress_forbidden" };
    }
    if (request.coopTopicRef.topicId !==
        request.automationAuthorization.threadRef.threadId) {
      return { ok: false, reason: "automation_thread_mismatch" };
    }
    if (!context || typeof context.validateAutomationAuthorization !== "function") {
      return { ok: false, reason: "automation_authorization_unavailable" };
    }
    var validated;
    try {
      validated = context.validateAutomationAuthorization({
        authorization: request.automationAuthorization,
        request: request,
      });
    } catch (error) {
      validated = null;
    }
    if (!validated || validated.ok !== true || !validated.authorization) {
      return { ok: false, reason: validated && validated.reason ||
        "automation_authorization_unavailable" };
    }
    var index = typeof opts.getThreadIndex === "function" ? opts.getThreadIndex() : null;
    if (!index || typeof index.ensureAutomationThread !== "function") {
      return { ok: false, reason: "automation_thread_store_unavailable" };
    }
    var ensured;
    try {
      ensured = index.ensureAutomationThread({
        authorization: validated.authorization,
        title: input && input.title,
      });
    } catch (error) {
      ensured = null;
    }
    if (!ensured || ensured.ok !== true) {
      return { ok: false, reason: ensured && (ensured.code || ensured.reason) ||
        "automation_thread_store_unavailable" };
    }
    if (!ensured.topicRef ||
        ensured.topicRef.topicId !== request.coopTopicRef.topicId) {
      return { ok: false, reason: "automation_thread_mismatch" };
    }
    return { ok: true, automation: true, authorization: validated.authorization,
      threadRef: ensured.threadRef };
  }

  return { admit: admit };
}

module.exports = {
  createAutomationImplementationAdmission: createAutomationImplementationAdmission,
};
