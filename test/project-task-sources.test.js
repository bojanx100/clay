var test = require("node:test");
var assert = require("node:assert");
var childProcess = require("node:child_process");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");

function recipe() {
  return {
    id: "assigned-to-me",
    source: {
      provider: "github",
      kind: "issue",
      repo: "owner/repo",
      ghAccount: "owner",
      includeProjectItems: true,
    },
    filter: { state: "open", assigned: "me", type: "bug" },
  };
}

function rawIssue() {
  return {
    number: 2819,
    title: "Exact board evidence regression",
    url: "https://github.com/owner/repo/issues/2819",
    state: "OPEN",
    labels: [{ name: "bug" }],
    assignees: [{ login: "owner" }],
    // gh issue list returns a Status but not the ProjectV2 item node id.
    projectItems: [{ status: { name: "Backlog" } }],
  };
}

function graphQlPage() {
  return JSON.stringify({ data: { repository: { issue: { projectItems: {
    nodes: [{
      id: "PVT_item_2819",
      project: { id: "PVT_project_1" },
      fieldValueByName: {
        name: "Backlog",
        optionId: "PVTSSO_backlog",
        field: { id: "PVTSSF_status", name: "Status" },
      },
    }],
    pageInfo: { hasNextPage: false, endCursor: null },
  } } } } });
}

function withStubbedGh(handler, run) {
  var original = childProcess.execFileSync;
  delete require.cache[require.resolve("../lib/project-task-sources")];
  childProcess.execFileSync = handler;
  try {
    return run(require("../lib/project-task-sources"));
  } finally {
    childProcess.execFileSync = original;
    delete require.cache[require.resolve("../lib/project-task-sources")];
  }
}

test("GitHub task sources replace CLI projectItems with exact GraphQL board evidence", function () {
  var graphCalls = 0;
  withStubbedGh(function (command, args) {
    assert.strictEqual(command, "gh");
    if (args[0] === "auth") return "";
    if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "owner" });
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([rawIssue()]);
    if (args[0] === "api" && args[1] === "graphql") {
      graphCalls++;
      return graphQlPage();
    }
    throw new Error("unexpected gh invocation: " + args.join(" "));
  }, function (taskSources) {
    var items = taskSources.fetchItems("/unused", recipe(), {});
    assert.strictEqual(graphCalls, 1, "source must use the authoritative GraphQL query once");
    assert.deepStrictEqual(items[0].projectItems, [{
      id: "PVT_item_2819", status: { name: "Backlog" },
    }]);
  });
});

test("GitHub task sources fail closed with a typed evidence-unavailable reason", function () {
  var originalError = console.error;
  var errors = [];
  withStubbedGh(function (command, args) {
    if (args[0] === "auth") return "";
    if (args[0] === "api" && args[1] === "user") return JSON.stringify({ login: "owner" });
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify([rawIssue()]);
    if (args[0] === "api" && args[1] === "graphql") throw new Error("network unavailable");
    throw new Error("unexpected gh invocation: " + args.join(" "));
  }, function (taskSources) {
    console.error = function (message) { errors.push(String(message)); };
    try {
      assert.deepStrictEqual(taskSources.fetchItems("/unused", recipe(), {}), []);
    } finally {
      console.error = originalError;
    }
  });
  assert.match(errors.join("\n"), /owner\/repo#2819.*qualification_board_evidence_unavailable/);
});

function fakeGhScript() {
  return [
    "#!/usr/bin/env node",
    "var fs = require('fs');",
    "var args = process.argv.slice(2);",
    "if (process.env.CLAY_GH_EVIDENCE_LOG && args[0] === 'api' && args[1] === 'graphql') fs.appendFileSync(process.env.CLAY_GH_EVIDENCE_LOG, 'graphql\\n');",
    "if (args[0] === 'auth') process.exit(0);",
    "if (args[0] === 'api' && args[1] === 'user') { console.log(JSON.stringify({ login: 'owner' })); process.exit(0); }",
    "if (args[0] === 'issue' && args[1] === 'list') { console.log(JSON.stringify([" + JSON.stringify(rawIssue()) + "])); process.exit(0); }",
    "if (args[0] === 'api' && args[1] === 'graphql') { console.log(" + JSON.stringify(graphQlPage()) + "); process.exit(0); }",
    "process.stderr.write('unexpected gh invocation: ' + args.join(' ')); process.exit(1);",
  ].join("\n");
}

test("forked task-source worker returns exact board evidence to the scheduler", async function () {
  var taskSources = require("../lib/project-task-sources");
  var cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clay-task-source-worker-"));
  var bin = path.join(cwd, "bin");
  var log = path.join(cwd, "gh.log");
  var oldPath = process.env.PATH;
  var oldLog = process.env.CLAY_GH_EVIDENCE_LOG;
  try {
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "gh"), fakeGhScript(), { mode: 0o755 });
    process.env.PATH = bin + path.delimiter + oldPath;
    process.env.CLAY_GH_EVIDENCE_LOG = log;
    var items = await taskSources.fetchItemsAsync(cwd, recipe(), {});
    assert.deepStrictEqual(items[0].projectItems, [{
      id: "PVT_item_2819", status: { name: "Backlog" },
    }]);
    assert.strictEqual(fs.readFileSync(log, "utf8").trim(), "graphql");
  } finally {
    process.env.PATH = oldPath;
    if (oldLog === undefined) delete process.env.CLAY_GH_EVIDENCE_LOG;
    else process.env.CLAY_GH_EVIDENCE_LOG = oldLog;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
