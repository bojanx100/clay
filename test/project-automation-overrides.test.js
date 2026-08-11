// Tests for the owner's explicit include/exclude list — the one thing that
// outranks the automatic eligibility rules, and the reason a one-off exception
// never has to become a permanent hole in them.
//
// The shape of the danger these lock down: an override store is the most
// privileged input in the pipeline, so every way of failing to read it, and
// every ambiguous record in it, has to resolve toward NOT running work.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var overridesModule = require("../lib/project-automation-overrides");

var ITEM = "trialview/v2#2539";
var OWNER = "bojan";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-overrides-"));
}

function store(dir) {
  return overridesModule.createOverrideStore({ cwd: dir });
}

// --- Recording an owner decision ---------------------------------------------

test("an owner include is recorded durably and survives a fresh reader", function () {
  var dir = tempDir();
  try {
    var written = store(dir).set(ITEM, "include", { by: OWNER, reason: "one-off continuation" });
    assert.strictEqual(written.ok, true);
    assert.strictEqual(written.override.decision, "include");
    assert.strictEqual(written.override.by, OWNER);
    // A different store instance over the same project — i.e. after a restart.
    var reread = store(dir).decisionFor(ITEM);
    assert.strictEqual(reread.ok, true);
    assert.strictEqual(reread.decision, "include");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// An exception nobody can be traced to is not reviewable, so it is refused.
test("an override without an owner identity is refused", function () {
  var dir = tempDir();
  try {
    var out = store(dir).set(ITEM, "include", {});
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, "owner_identity_required");
    assert.strictEqual(store(dir).decisionFor(ITEM).decision, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("only include and exclude are decisions", function () {
  var dir = tempDir();
  try {
    var probes = ["approve", "", null, "INCLUDE", true, 1];
    for (var i = 0; i < probes.length; i++) {
      var out = store(dir).set(ITEM, probes[i], { by: OWNER });
      assert.strictEqual(out.ok, false, "probe " + JSON.stringify(probes[i]));
      assert.strictEqual(out.reason, "invalid_decision");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("re-deciding an item replaces the decision rather than accumulating one", function () {
  var dir = tempDir();
  try {
    var s = store(dir);
    s.set(ITEM, "include", { by: OWNER });
    s.set(ITEM, "exclude", { by: OWNER });
    var listed = s.list();
    assert.strictEqual(listed.overrides.length, 1);
    assert.strictEqual(listed.overrides[0].decision, "exclude");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("clearing an override returns the item to the automatic rules", function () {
  var dir = tempDir();
  try {
    var s = store(dir);
    s.set(ITEM, "include", { by: OWNER });
    assert.strictEqual(s.clear(ITEM).cleared, true);
    assert.strictEqual(s.decisionFor(ITEM).decision, null);
    // An unassigned item is refused again once the exception is withdrawn.
    assert.strictEqual(s.eligibility(ITEM, false).eligible, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Eligibility ------------------------------------------------------------

test("the ordinary case needs no override at all", function () {
  var dir = tempDir();
  try {
    var out = store(dir).eligibility("trialview/v2#2565", true);
    assert.strictEqual(out.eligible, true);
    assert.strictEqual(out.reason, "assigned_to_owner");
    assert.strictEqual(out.decision, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unassigned work is refused when the owner has said nothing about it", function () {
  var dir = tempDir();
  try {
    var out = store(dir).eligibility(ITEM, false);
    assert.strictEqual(out.eligible, false);
    assert.strictEqual(out.reason, "not_assigned_to_owner");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The #2539 shape: an unassigned item the owner personally authorized. The
// exception lives in owner data, so the general rule stays untouched.
test("an owner include makes one unassigned item eligible without changing the rule", function () {
  var dir = tempDir();
  try {
    var s = store(dir);
    s.set(ITEM, "include", { by: OWNER, reason: "one-off continuation" });
    var included = s.eligibility(ITEM, false);
    assert.strictEqual(included.eligible, true);
    assert.strictEqual(included.reason, "owner_included");
    // The rule itself is unchanged: any OTHER unassigned item is still refused.
    var other = s.eligibility("trialview/v2#9999", false);
    assert.strictEqual(other.eligible, false);
    assert.strictEqual(other.reason, "not_assigned_to_owner");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an owner exclude stops work the automatic rules would have allowed", function () {
  var dir = tempDir();
  try {
    var s = store(dir);
    s.set(ITEM, "exclude", { by: OWNER, reason: "handling this myself" });
    var out = s.eligibility(ITEM, true);
    assert.strictEqual(out.eligible, false, "assignment must not beat an explicit exclusion");
    assert.strictEqual(out.reason, "owner_excluded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Fail-closed ------------------------------------------------------------

// The most dangerous failure in this module: a corrupt file reading as "no
// overrides" would silently drop an owner's EXCLUDE and start forbidden work.
test("an unreadable override file stops work rather than reading as empty", function () {
  var dir = tempDir();
  try {
    var s = store(dir);
    s.set(ITEM, "exclude", { by: OWNER });
    fs.writeFileSync(s.file, "{ not json");
    var reread = store(dir);
    assert.strictEqual(reread.decisionFor(ITEM).ok, false);
    var out = reread.eligibility(ITEM, true);
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.eligible, false,
      "an override file we cannot read must not let assigned work through either");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a record with an uninterpretable decision is treated as a refusal", function () {
  var dir = tempDir();
  try {
    var s = store(dir);
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({
      schema: overridesModule.SCHEMA, version: 1,
      overrides: [{ itemKey: ITEM, decision: "maybe", by: OWNER, at: 1 }],
    }));
    var found = store(dir).decisionFor(ITEM);
    assert.strictEqual(found.decision, "exclude");
    assert.strictEqual(store(dir).eligibility(ITEM, true).eligible, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Both recorded is ambiguous, and ambiguity resolves toward not running work.
test("exclude beats include whichever order they appear in", function () {
  var dir = tempDir();
  try {
    var s = store(dir);
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, JSON.stringify({
      schema: overridesModule.SCHEMA, version: 1,
      overrides: [
        { itemKey: ITEM, decision: "exclude", by: OWNER, at: 1 },
        { itemKey: ITEM, decision: "include", by: OWNER, at: 2 },
      ],
    }));
    assert.strictEqual(store(dir).eligibility(ITEM, false).reason, "owner_excluded");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed write is reported, never silently dropped", function () {
  var dir = tempDir();
  try {
    var failing = Object.create(fs);
    failing.writeFileSync = function () { throw new Error("disk full"); };
    var s = overridesModule.createOverrideStore({ fs: failing, cwd: dir });
    var out = s.set(ITEM, "exclude", { by: OWNER });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reason, "persistence_failed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing override file is simply no overrides, not an error", function () {
  var dir = tempDir();
  try {
    var listed = store(dir).list();
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(listed.overrides, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
