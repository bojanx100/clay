var test = require("node:test");
var assert = require("node:assert/strict");

var attachCoopSessionQuery =
  require("../lib/coop-session-query").attachCoopSessionQuery;

var CLAY_ID = "5332aafc-31e7-5cb1-ba96-c8d90e78260e";
var WEBAPP_ID = "b0c9b7a0-371e-5cd8-9e29-7c3971aff3f9";

function error(text) {
  return { content: [{ type: "text", text: "Error: " + text }], isError: true };
}

function success(text) {
  return { content: [{ type: "text", text: text }] };
}

test("the Coop session query is canonical-owner-only and always excludes hidden or nested rows", function () {
  var calls = [];
  var sessions = {
    coop: { storageId: "coop", coopHome: true },
    coordinator: { storageId: "coordinator", coordinationMode: true },
  };
  var query = attachCoopSessionQuery({
    crossProject: {
      queryCoopSessions: function (input) {
        calls.push(input);
        return {
          ok: true,
          sessions: [{
            projectRef: { projectId: CLAY_ID },
            sessionStorageId: "visible-coordinator",
            lifecycleState: "completed",
          }],
        };
      },
    },
    sessionForInput: function (input) { return sessions[input.coordinatorSessionId] || null; },
    error: error,
    success: success,
  });

  assert.equal(query.listFromTool({
    coordinatorSessionId: "coordinator",
    projectRefs: [{ projectId: CLAY_ID }],
  }).isError, true);
  assert.equal(calls.length, 0);

  assert.equal(query.listFromTool({
    coordinatorSessionId: "coop",
    projectRefs: [{ projectId: "not-a-project" }],
  }).isError, true);
  assert.equal(calls.length, 0);

  var result = query.listFromTool({
    coordinatorSessionId: "coop",
    projectRefs: [{ projectId: WEBAPP_ID }, { projectId: CLAY_ID }],
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    projectRefs: [{ projectId: CLAY_ID }, { projectId: WEBAPP_ID }],
    topLevelOnly: true,
    includeHidden: false,
    includeMissing: false,
  });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    sessions: [{
      projectRef: { projectId: CLAY_ID },
      sessionStorageId: "visible-coordinator",
      lifecycleState: "completed",
    }],
  });
});
