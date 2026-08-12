var test = require("node:test");
var assert = require("node:assert/strict");
var createCoordinatorProviderSwitch =
  require("../lib/coordinator-provider-switch").createCoordinatorProviderSwitch;

function harness(source, crossProjectResult) {
  var calls = [];
  var sessions = new Map([[source.localId, source]]);
  var handler = createCoordinatorProviderSwitch({
    sm: {
      sessions: sessions,
      getProjectId: function () { return "system-lead"; },
    },
    crossProject: {
      switchProjectExecutionProvider: function (input) {
        calls.push(input);
        return crossProjectResult || {
          ok: true,
          targetRouteId: "codex-openai",
          targetModel: "gpt-5.6-sol",
          continued: true,
        };
      },
    },
  });
  return { calls: calls, handler: handler };
}

function validInput() {
  return {
    coordinatorSessionId: "coop-home",
    targetProject: { projectId: "11111111-1111-4111-8111-111111111111" },
    targetSession: { projectId: "11111111-1111-4111-8111-111111111111", sessionStorageId: "worker-1" },
    portfolioTaskId: "portfolio-task",
    bindingRevision: 1,
    idempotencyKey: "portfolio-task-r1-openai",
    target: "codex-openai",
    model: "gpt-5.6-sol",
    reason: "GitHub Copilot quota exhausted",
  };
}

test("canonical Coop can switch an exact bound target session", function () {
  var h = harness({ localId: 1, storageId: "coop-home", coopHome: true });
  var result = h.handler(validInput());

  assert.strictEqual(result.isError, undefined);
  assert.strictEqual(h.calls.length, 1);
  assert.deepStrictEqual(h.calls[0].source, {
    projectId: "system-lead",
    sessionStorageId: "coop-home",
  });
  assert.strictEqual(h.calls[0].targetSession.sessionStorageId, "worker-1");
  assert.match(result.content[0].text, /gpt-5.6-sol/);
});

test("a non-Coop session cannot switch another session", function () {
  var h = harness({ localId: 1, storageId: "coop-home" });
  var result = h.handler(validInput());

  assert.strictEqual(result.isError, true);
  assert.strictEqual(h.calls.length, 0);
});

test("target ProjectRef and SessionRef must match", function () {
  var h = harness({ localId: 1, storageId: "coop-home", coopHome: true });
  var input = validInput();
  input.targetSession = { projectId: "another-project", sessionStorageId: "worker-1" };
  var result = h.handler(input);

  assert.strictEqual(result.isError, true);
  assert.strictEqual(h.calls.length, 0);
});
