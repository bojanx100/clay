// Tests for the project automation audit. The cutover's claim — that legacy
// automation can no longer act unilaterally — is only checkable if every
// decision is recorded, so these cover both the happy path and the ways an
// audit could quietly stop recording.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var automationAudit = require("../lib/project-automation-audit");

function tempFile() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), "clay-automation-audit-"));
  return path.join(dir, "audit.jsonl");
}

function store(options) {
  var opts = options || {};
  return automationAudit.createAutomationAudit({
    file: opts.file || tempFile(),
    slug: opts.slug === undefined ? "webapp" : opts.slug,
    now: opts.now || function () { return 1785700000000; },
  });
}

test("appended decisions round-trip with transport fields added", function () {
  var audit = store();
  var written = audit.append({ type: "project_automation_decision", decision: "propose", reason: "policy_requires_proposal" });
  assert.strictEqual(written.ok, true);
  var entries = audit.read();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].decision, "propose");
  assert.strictEqual(entries[0].projectSlug, "webapp");
  assert.strictEqual(entries[0].at, 1785700000000);
  assert.strictEqual(entries[0].recordedAt, 1785700000000);
});

test("a caller-supplied timestamp is preserved, a missing one is stamped", function () {
  var audit = store();
  audit.append({ decision: "execute", at: 42 });
  audit.append({ decision: "execute" });
  var entries = audit.read();
  assert.strictEqual(entries[0].at, 42);
  assert.strictEqual(entries[1].at, 1785700000000);
});

test("entries accumulate in order across appends", function () {
  var file = tempFile();
  var audit = store({ file: file });
  audit.append({ decision: "execute", reason: "a" });
  audit.append({ decision: "deny", reason: "b" });
  // A second store over the same file must see the same history.
  var reopened = store({ file: file });
  var entries = reopened.read();
  assert.deepStrictEqual([entries[0].reason, entries[1].reason], ["a", "b"]);
});

test("read(limit) returns the most recent entries", function () {
  var audit = store();
  for (var i = 0; i < 5; i++) audit.append({ decision: "execute", reason: "r" + i });
  var entries = audit.read(2);
  assert.deepStrictEqual([entries[0].reason, entries[1].reason], ["r3", "r4"]);
});

test("a slug that is not a plain name is refused rather than sanitized", function () {
  var traversals = ["../escape", "a/b", "", "  ", "x".repeat(65)];
  for (var i = 0; i < traversals.length; i++) {
    assert.strictEqual(automationAudit.safeSlug(traversals[i]), "",
      JSON.stringify(traversals[i]) + " must not resolve to a filename");
  }
  assert.strictEqual(automationAudit.auditFileForProject("../escape"), "");

  var audit = automationAudit.createAutomationAudit({ slug: "../escape" });
  var result = audit.append({ decision: "execute" });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "invalid_slug");
  assert.strictEqual(audit.lastError(), "invalid_slug");
});

test("a non-object record is refused", function () {
  var audit = store();
  assert.strictEqual(audit.append(null).reason, "invalid_record");
  assert.strictEqual(audit.append("nope").reason, "invalid_record");
  assert.strictEqual(audit.append([1, 2]).reason, "invalid_record");
  assert.deepStrictEqual(audit.read(), []);
});

test("an oversized record is refused so it cannot corrupt the stream", function () {
  var audit = store();
  var result = audit.append({ decision: "execute", blob: "x".repeat(9000) });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, "record_too_large");
  assert.deepStrictEqual(audit.read(), []);
});

test("an unserializable record is refused", function () {
  var audit = store();
  var cyclic = { decision: "execute" };
  cyclic.self = cyclic;
  assert.strictEqual(audit.append(cyclic).reason, "unserializable_record");
});

test("a corrupt line is skipped so the rest of the history stays legible", function () {
  var file = tempFile();
  var audit = store({ file: file });
  audit.append({ decision: "execute", reason: "first" });
  fs.appendFileSync(file, "{not json\n");
  audit.append({ decision: "deny", reason: "third" });
  var entries = audit.read();
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual([entries[0].reason, entries[1].reason], ["first", "third"]);
});

test("reading a file that does not exist yields no entries rather than throwing", function () {
  assert.deepStrictEqual(store().read(), []);
});

test("lastError clears after a successful append", function () {
  var audit = store();
  audit.append(null);
  assert.strictEqual(audit.lastError(), "invalid_record");
  audit.append({ decision: "execute" });
  assert.strictEqual(audit.lastError(), null);
});
