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

// A configured board is an explicit policy boundary, not a best-effort hint.
// It is intentionally normalized here as well as in the policy module because
// this adapter is also used by isolated task-source workers.
function configuredBoard(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return null;
  var keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["projectId", "statusFieldId"])) return null;
  var projectId = text(value.projectId);
  var statusFieldId = text(value.statusFieldId);
  return projectId && statusFieldId ? { projectId: projectId, statusFieldId: statusFieldId } : null;
}

function graphQlArgs(repo, number, cursor) {
  var parts = repoParts(repo);
  if (!parts || !Number.isSafeInteger(number) || number < 1) return null;
  var args = ["api", "graphql", "-f", "query=" + PROJECT_ITEM_QUERY,
    "-F", "owner=" + parts.owner, "-F", "name=" + parts.name, "-F", "number=" + number];
  if (cursor) args.push("-F", "after=" + cursor);
  return args;
}

function projectItemsConnection(payload) {
  var data = payload && payload.data;
  var repository = data && data.repository;
  var issue = repository && repository.issue;
  return issue && issue.projectItems;
}

function pageFromStdout(stdout) {
  var payload;
  try { payload = JSON.parse(stdout || "{}"); } catch (e) { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (Array.isArray(payload.errors) && payload.errors.length) return null;
  var connection = projectItemsConnection(payload);
  if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) return null;
  if (typeof connection.pageInfo.hasNextPage !== "boolean") return null;
  if (connection.pageInfo.hasNextPage && !text(connection.pageInfo.endCursor)) return null;
  return connection;
}

function nodeStatusEvidence(node) {
  var status = node && node.fieldValueByName;
  return {
    id: text(node && node.id),
    projectId: text(node && node.project && node.project.id),
    statusName: text(status && status.name),
    optionId: text(status && status.optionId),
    fieldId: text(status && status.field && status.field.id),
    fieldName: text(status && status.field && status.field.name),
  };
}

function hasConfiguredStatus(evidence, seen, board) {
  return !!(evidence.id && evidence.statusName && evidence.optionId &&
    evidence.fieldId === board.statusFieldId && evidence.fieldName === "Status" && !seen[evidence.id]);
}

function configuredItemFromNode(node, seen, board) {
  var evidence = nodeStatusEvidence(node);
  if (evidence.projectId !== board.projectId) {
    return evidence.projectId ? { ok: true, projectItem: null } :
      { ok: false, reason: "qualification_board_evidence_ambiguous" };
  }
  if (!hasConfiguredStatus(evidence, seen, board)) {
    return { ok: false, reason: "qualification_board_evidence_configured_field_invalid" };
  }
  seen[evidence.id] = true;
  return {
    ok: true,
    projectItem: {
      id: evidence.id,
      projectId: evidence.projectId,
      status: { name: evidence.statusName, fieldId: evidence.fieldId },
    },
  };
}

function hasLegacyStatus(evidence, seen) {
  return !!(evidence.id && evidence.projectId && evidence.statusName && evidence.optionId &&
    evidence.fieldId && evidence.fieldName === "Status" && !seen[evidence.id]);
}

function legacyItemFromNode(node, seen) {
  var evidence = nodeStatusEvidence(node);
  if (!hasLegacyStatus(evidence, seen)) {
    return { ok: false, reason: "qualification_board_evidence_ambiguous" };
  }
  seen[evidence.id] = true;
  return { ok: true, projectItem: { id: evidence.id, status: { name: evidence.statusName } } };
}

function projectItemsFromPage(page, seen, board) {
  var result = [];
  for (var i = 0; i < page.nodes.length; i++) {
    var parsed = board ? configuredItemFromNode(page.nodes[i], seen, board) :
      legacyItemFromNode(page.nodes[i], seen);
    if (!parsed.ok) return parsed;
    if (parsed.projectItem) result.push(parsed.projectItem);
  }
  return { ok: true, projectItems: result };
}

// Calls cb({ ok, projectItems?, reason? }). Every non-exact response is a
// fail-closed result; callers never receive a partial page as board evidence.
function collectBoardItemEvidence(execFn, repo, number, config, cb) {
  if (typeof config === "function") {
    cb = config;
    config = null;
  }
  var board = config === null || config === undefined ? null : configuredBoard(config);
  if (typeof execFn !== "function" || !repoParts(repo) || !Number.isSafeInteger(number) || number < 1) {
    return cb({ ok: false, reason: "qualification_board_evidence_invalid_request" });
  }
  if (config !== null && config !== undefined && !board) {
    return cb({ ok: false, reason: "qualification_board_evidence_configured_board_invalid" });
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
      var items = projectItemsFromPage(page, seen, board);
      if (!items.ok) return cb({ ok: false, reason: items.reason });
      if (!board) for (var i = 0; i < page.nodes.length; i++) projectIds[page.nodes[i].project.id] = true;
      if (!board && Object.keys(projectIds).length > 1) {
        return cb({ ok: false, reason: "qualification_board_evidence_multi_board" });
      }
      for (i = 0; i < items.projectItems.length; i++) allItems.push(items.projectItems[i]);
      if (!page.pageInfo.hasNextPage) {
        if (board && !allItems.length) {
          return cb({ ok: false, reason: "qualification_board_evidence_configured_board_missing" });
        }
        return cb({ ok: true, projectItems: allItems });
      }
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
function collectBoardItemEvidenceSync(execFn, repo, number, config) {
  var result = null;
  collectBoardItemEvidence(function (command, args, cb) {
    try {
      cb(null, execFn(command, args));
    } catch (err) {
      cb(err, "");
    }
  }, repo, number, config, function (value) {
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
