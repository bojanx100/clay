"use strict";

var test = require("node:test");
var assert = require("node:assert");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var execFileSync = require("node:child_process").execFileSync;

var rules = require("../scripts/commit-message-rules");
var checker = require("../scripts/check-commit-message");

var REPO_ROOT = path.join(__dirname, "..");
var CHECKER = path.join(REPO_ROOT, "scripts", "check-commit-message.js");

function runChecker(args) {
  var result;
  try {
    result = {
      status: 0,
      stdout: execFileSync(process.execPath, [CHECKER].concat(args), {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    result = {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: error.stdout ? String(error.stdout) : "",
      stderr: error.stderr ? String(error.stderr) : "",
    };
  }
  return result;
}

function checkMessage(text) {
  return rules.validateCommitMessage(text, { stripComments: true });
}

function ruleNames(result) {
  return result.errors.map(function (error) { return error.rule; });
}

test("commit-message rules: Co-Authored-By", function (t) {
  t.test("rejects a Co-Authored-By trailer", function () {
    var result = checkMessage([
      "fix: stop the retry loop double-counting failures",
      "",
      "Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n"));
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(ruleNames(result), [rules.COAUTHOR_RULE]);
    assert.strictEqual(result.errors[0].line, 3);
    assert.match(result.errors[0].text, /noreply@anthropic\.com/);
  });

  t.test("rejects it case-insensitively and with trailing whitespace", function () {
    var result = checkMessage("fix: a thing\n\n  co-authored-by: Copilot <x@y> \n");
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(ruleNames(result), [rules.COAUTHOR_RULE]);
  });

  // Deliberate: the rule's intent is that the attribution never reaches the
  // log, and GitHub parses co-author lines more loosely than git's trailer
  // grammar, so a line in the body still produces a co-authored commit.
  t.test("rejects it in the body, not only in the trailer block", function () {
    var result = checkMessage([
      "fix: a thing",
      "",
      "Co-authored-by: Someone <s@example.com>",
      "",
      "This paragraph comes after, so the line above is not a git trailer.",
    ].join("\n"));
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(ruleNames(result), [rules.COAUTHOR_RULE]);
    assert.strictEqual(result.errors[0].line, 3);
  });

  t.test("reports every offending line", function () {
    var result = checkMessage([
      "fix: a thing",
      "",
      "Co-authored-by: A <a@example.com>",
      "Co-authored-by: B <b@example.com>",
    ].join("\n"));
    assert.strictEqual(result.errors.length, 2);
    assert.deepStrictEqual(
      result.errors.map(function (e) { return e.line; }), [3, 4]);
  });

  // Prose about the rule must stay legal, or a commit that documents the rule
  // could not be committed. The pattern is anchored at the start of a trimmed
  // line, so neither of these matches.
  t.test("allows prose that merely mentions the trailer", function () {
    var result = checkMessage([
      "docs: explain the commit-message guard",
      "",
      "- Never add `Co-Authored-By` lines to git commit messages.",
      "The hook rejects any line starting with Co-Authored-By: as shown above.",
      "> Co-authored-by: Claude <noreply@anthropic.com>",
    ].join("\n"));
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  });

  // `git commit --verbose` appends the staged diff. Editing this guard puts the
  // literal trailer text into that diff, so the scissors block must be ignored.
  t.test("ignores the --verbose scissors diff and comment lines", function () {
    var result = checkMessage([
      "test: cover the commit-message guard",
      "",
      "# Please enter the commit message for your changes.",
      "# Co-authored-by: this is a comment git will strip",
      "# ------------------------ >8 ------------------------",
      "diff --git a/x b/x",
      "+Co-Authored-By: Claude <noreply@anthropic.com>",
    ].join("\n"));
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  });

  t.test("still rejects a trailer on an exempt merge subject", function () {
    var result = checkMessage(
      "Merge branch 'bojan'\n\nCo-authored-by: A <a@example.com>\n");
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(ruleNames(result), [rules.COAUTHOR_RULE]);
  });
});

test("commit-message rules: Conventional Commits", function (t) {
  var accepted = [
    "feat: add the thing",
    "fix: stop the retry loop",
    "docs: record the failure mode",
    "chore: bump a pin",
    "refactor: split the module",
    "perf: coalesce streaming deltas",
    "test: cover the guard",
    "style: reindent the block",
    "ci: pin the runner",
    "build: drop a dependency",
    "feat(scripts): add a WAL-safe control-store snapshot",
    "fix(lib/public): resolve the import",
    "feat!: drop the legacy relay route",
    "feat(api)!: change the payload shape",
    "revert: unpublish two failing-first tests",
  ];
  accepted.forEach(function (subject) {
    t.test("accepts " + JSON.stringify(subject), function () {
      var result = checkMessage(subject);
      assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
      assert.strictEqual(result.exempt, false);
    });
  });

  var rejected = [
    "add a commit-msg hook",
    "Add a commit-msg hook",
    "wip: debugging the typing indicator",
    "update README.md",
    "feat:missing the space",
    "feat: ",
    "feat(): empty scope",
    "feature: not a listed type",
    "FIX: wrong case",
    "fix - wrong separator",
    "v2.5.0: version as a type",
  ];
  rejected.forEach(function (subject) {
    t.test("rejects " + JSON.stringify(subject), function () {
      var result = checkMessage(subject);
      assert.strictEqual(result.ok, false, "expected rejection: " + subject);
      assert.ok(ruleNames(result).indexOf(rules.CONVENTIONAL_RULE) !== -1);
    });
  });

  // These are subjects git or release automation generates. Blocking them would
  // break merge, revert and autosquash workflows.
  var exempt = [
    "Merge branch 'bojan' into feature",
    "Merge remote-tracking branch 'origin/bojan'",
    "Merge pull request #394 from chadbyte/feat/worktree-switcher",
    "Revert \"feat: add the thing\"",
    "Reapply \"feat: add the thing\"",
    "fixup! feat: add the thing",
    "squash! feat: add the thing",
    "amend! feat: add the thing",
    "Release 2.47.0-beta.6",
  ];
  exempt.forEach(function (subject) {
    t.test("does not block " + JSON.stringify(subject), function () {
      var result = checkMessage(subject);
      assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
      assert.strictEqual(result.exempt, true);
    });
  });

  t.test("a BREAKING CHANGE footer is accepted", function () {
    var result = checkMessage([
      "feat!: drop the legacy relay route",
      "",
      "BREAKING CHANGE: /relay is gone; use /bridge instead.",
    ].join("\n"));
    assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  });

  t.test("an empty message is rejected", function () {
    var result = checkMessage("\n\n# a comment only\n");
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(ruleNames(result), [rules.EMPTY_RULE]);
  });

  t.test("a message with both problems reports both, in line order", function () {
    var result = checkMessage(
      "add a hook\n\nCo-authored-by: A <a@example.com>\n");
    assert.deepStrictEqual(ruleNames(result),
      [rules.CONVENTIONAL_RULE, rules.COAUTHOR_RULE]);
  });
});

test("commit-message rules: history mode keeps comment lines", function () {
  // git already cleaned a stored commit message, so a body line starting with
  // `#` is content, not a comment.
  var body = "docs: reference an issue\n\n#394 is the upstream report.\n";
  assert.strictEqual(
    rules.validateCommitMessage(body, { stripComments: false }).ok, true);
});

test("check-commit-message CLI", function (t) {
  t.test("--message exits 0 on a valid message", function () {
    var run = runChecker(["--message", "feat(scripts): add the guard"]);
    assert.strictEqual(run.status, 0, run.stderr);
  });

  t.test("--message exits 1 and names the rule on a trailer", function () {
    var run = runChecker([
      "--message",
      "fix: a thing\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
    ]);
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /REJECTED/);
    assert.match(run.stderr, /no-co-authored-by/);
    assert.match(run.stderr, /line 3/);
    assert.match(run.stderr, /Never add `Co-Authored-By` lines/);
  });

  t.test("a message file is read from disk", function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-commit-msg-"));
    try {
      var file = path.join(dir, "COMMIT_EDITMSG");
      fs.writeFileSync(file, "nope, not conventional\n");
      var run = runChecker([file]);
      assert.strictEqual(run.status, 1);
      assert.match(run.stderr, /conventional-commits/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  t.test("a missing message file fails loudly rather than silently", function () {
    var run = runChecker([path.join(os.tmpdir(), "clay-no-such-commit-msg")]);
    assert.strictEqual(run.status, 1);
    assert.match(run.stderr, /cannot read message file/);
  });
});

// The zero-setup backstop. It fails only on commits that are not on any remote,
// because those are the only ones whose message can still be fixed. Pushed
// history in this repo already contains Co-Authored-By trailers and
// non-conventional subjects; CLAUDE.md forbids rewriting it, so scanning it
// could only produce a permanently red suite. Every commit passes through the
// unpushed state exactly once, so coverage is complete going forward.
test("no unpushed commit violates the commit-message rules", function (t) {
  var scan = checker.localCommits();
  if (!scan.available) {
    t.diagnostic("skipped: " + scan.reason);
    return;
  }
  if (scan.truncated) {
    t.diagnostic("more than " + checker.MAX_LOCAL_COMMITS +
      " unpushed commits; only the newest " + checker.MAX_LOCAL_COMMITS +
      " were checked");
  }
  t.diagnostic("checked " + scan.commits.length + " unpushed commit(s)");
  var failures = [];
  for (var i = 0; i < scan.commits.length; i++) {
    var result = checker.validateCommit(scan.commits[i]);
    if (!result.ok) {
      failures.push(rules.formatErrors(result,
        "commit " + scan.commits[i].short));
    }
  }
  assert.strictEqual(failures.length, 0, "\n" + failures.join("\n\n") +
    "\n\nThese commits are not pushed yet. Fix them with `git commit --amend` " +
    "or `git rebase -i` before pushing.\n");
});
