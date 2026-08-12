// Canonical Coop-only query surface for the reconciled cross-project session
// ledger. The public tool intentionally has no switches for hidden, missing,
// or nested rows: those records remain available to internal lifecycle code,
// while owner-facing inventory has one deterministic visibility contract.
var projectIdentity = require("./project-identity");

function attachCoopSessionQuery(ctx) {
  var crossProject = ctx.crossProject || null;
  var sessionForInput = ctx.sessionForInput;
  var error = ctx.error;
  var success = ctx.success;

  function normalizedProjectRefs(values) {
    var list = Array.isArray(values) ? values : [];
    var refs = [];
    var seen = {};
    if (!list.length) return null;
    for (var i = 0; i < list.length; i++) {
      var ref = projectIdentity.normalizeProjectRef(list[i]);
      if (!ref) return null;
      if (!seen[ref.projectId]) refs.push(ref);
      seen[ref.projectId] = true;
    }
    refs.sort(function (left, right) {
      return left.projectId.localeCompare(right.projectId);
    });
    return refs;
  }

  function listFromTool(input) {
    var request = input || {};
    var coordinator = typeof sessionForInput === "function" ? sessionForInput(request) : null;
    if (!coordinator || coordinator.coopHome !== true) {
      return error("the canonical Coop session is required");
    }
    var projectRefs = normalizedProjectRefs(request.projectRefs);
    if (!projectRefs) return error("projectRefs must contain exact ProjectRefs");
    if (!crossProject || typeof crossProject.queryCoopSessions !== "function") {
      return error("the Coop session ledger is unavailable");
    }
    var result = crossProject.queryCoopSessions({
      projectRefs: projectRefs,
      topLevelOnly: true,
      includeHidden: false,
      includeMissing: false,
    });
    if (!result || result.ok !== true) {
      return error("the Coop session ledger query failed: " +
        String(result && result.reason || "unknown_error"));
    }
    return success(JSON.stringify({ sessions: result.sessions || [] }));
  }

  return { listFromTool: listFromTool };
}

module.exports = { attachCoopSessionQuery: attachCoopSessionQuery };
