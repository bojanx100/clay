// Exact GitHub Projects-v2 evidence for qualified Lead issue collection.
//
// `gh issue list --json projectItems` does not expose the ProjectV2 item node
// ID. Qualification receipts bind that ID, so this adapter retrieves the exact
// item and Status field through GitHub's GraphQL API before a receipt is minted.

var MAX_PROJECT_ITEM_PAGES = 5;
var PROJECT_ITEMS_PER_PAGE = 100;
var MAX_TEXT = 240;

var PROJECT_ITEM_QUERY = [
  "query($owner: String!, $name: String!, $number: Int!, $after: String) {",
  "  repository(owner: $owner, name: $name) {",
  "    issue(number: $number) {",
  "      projectItems(first: " + PROJECT_ITEMS_PER_PAGE + ", after: $after) {",
  "        nodes {",
  "          id",
  "          project { id }",
  "          fieldValueByName(name: \"Status\") {",
  "            ... on ProjectV2ItemFieldSingleSelectValue {",
  "              name",
  "              optionId",
  "              field { ... on ProjectV2SingleSelectField { id name } }",
  "            }",
  "          }",
  "        }",
  "        pageInfo { hasNextPage endCursor }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

function text(value) {
  var result = typeof value === "string" ? value.trim() : "";
  return result && result.length <= MAX_TEXT ? result : "";
}

function repoParts(repo) {
  var parts = typeof repo === "string" ? repo.split("/") : [];
  var owner = parts.length === 2 ? text(parts[0]) : "";
  var name = parts.length === 2 ? text(parts[1]) : "";
  return owner && name ? { owner: owner, name: name } : null;
}

function graphQlArgs(repo, number, cursor) {
  var parts = repoParts(repo);
  if (!parts || !Number.isSafeInteger(number) || number < 1) return null;
  var args = ["api", "graphql", "-f", "query=" + PROJECT_ITEM_QUERY,
    "-F", "owner=" + parts.owner, "-F", "name=" + parts.name, "-F", "number=" + number];
  if (cursor) args.push("-F", "after=" + cursor);
  return args;
}

function pageFromStdout(stdout) {
  var payload;
  try { payload = JSON.parse(stdout || "{}"); } catch (e) { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Array.isArray(payload.errors) && payload.errors.length) return null;
  var connection = payload.data && payload.data.repository && payload.data.repository.issue &&
    payload.data.repository.issue.projectItems;
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo ||
      typeof connection.pageInfo.hasNextPage !== "boolean") return null;
  if (connection.pageInfo.hasNextPage && !text(connection.pageInfo.endCursor)) return null;
  return connection;
}

function projectItemsFromPage(page, seen) {
  var result = [];
  for (var i = 0; i < page.nodes.length; i++) {
    var node = page.nodes[i];
    var id = text(node && node.id);
    var projectId = text(node && node.project && node.project.id);
    var status = node && node.fieldValueByName;
    var statusName = text(status && status.name);
    var optionId = text(status && status.optionId);
    var fieldId = text(status && status.field && status.field.id);
    var fieldName = text(status && status.field && status.field.name);
    if (!id || !projectId || !statusName || !optionId || !fieldId || fieldName !== "Status" || seen[id]) {
      return null;
    }
    seen[id] = true;
    result.push({ id: id, status: { name: statusName } });
  }
  return result;
}

// Calls cb({ ok, projectItems?, reason? }). Every non-exact response is a
// fail-closed result; callers never receive a partial page as board evidence.
function collectBoardItemEvidence(execFn, repo, number, cb) {
  if (typeof execFn !== "function" || !repoParts(repo) || !Number.isSafeInteger(number) || number < 1) {
    return cb({ ok: false, reason: "qualification_board_evidence_invalid_request" });
  }
  var allItems = [];
  var seen = {};
  var projectIds = {};
  function fetch(cursor, pages) {
    var args = graphQlArgs(repo, number, cursor);
    execFn("gh", args, function (err, stdout) {
      if (err) return cb({ ok: false, reason: "qualification_board_evidence_unavailable" });
      var page = pageFromStdout(stdout);
      if (!page) return cb({ ok: false, reason: "qualification_board_evidence_partial" });
      var items = projectItemsFromPage(page, seen);
      if (!items) return cb({ ok: false, reason: "qualification_board_evidence_ambiguous" });
      for (var i = 0; i < page.nodes.length; i++) projectIds[page.nodes[i].project.id] = true;
      if (Object.keys(projectIds).length > 1) {
        return cb({ ok: false, reason: "qualification_board_evidence_multi_board" });
      }
      for (i = 0; i < items.length; i++) allItems.push(items[i]);
      if (!page.pageInfo.hasNextPage) return cb({ ok: true, projectItems: allItems });
      if (pages >= MAX_PROJECT_ITEM_PAGES) {
        return cb({ ok: false, reason: "qualification_board_evidence_pagination_exhausted" });
      }
      fetch(page.pageInfo.endCursor, pages + 1);
    });
  }
  fetch("", 1);
}

// The production task source is deliberately synchronous inside its isolated
// worker process. Keep its GraphQL evidence identical to the Lead collector
// instead of duplicating a second parser or weakening the exact-id checks.
function collectBoardItemEvidenceSync(execFn, repo, number) {
  var result = null;
  collectBoardItemEvidence(function (command, args, cb) {
    try {
      cb(null, execFn(command, args));
    } catch (err) {
      cb(err, "");
    }
  }, repo, number, function (value) {
    result = value;
  });
  return result || { ok: false, reason: "qualification_board_evidence_unavailable" };
}

module.exports = {
  MAX_PROJECT_ITEM_PAGES: MAX_PROJECT_ITEM_PAGES,
  PROJECT_ITEM_QUERY: PROJECT_ITEM_QUERY,
  collectBoardItemEvidence: collectBoardItemEvidence,
  collectBoardItemEvidenceSync: collectBoardItemEvidenceSync,
  graphQlArgs: graphQlArgs,
};
