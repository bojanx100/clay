// Regression tests for the Handoff Package: the on-disk half of a vendor
// switch (full transcript + image copies + state), the inline pointer, and
// real-image re-attachment on handoff-carrying sends.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");
var { execFileSync } = require("child_process");

var handoffPackage = require("../lib/handoff-package");
var handoffContext = require("../lib/handoff-context");

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clay-handoff-pkg-"));
}

function makeSession(imagesDir) {
  var history = [];
  // Enough sizable turns that a small inline cap must drop some, while the
  // package transcript keeps everything.
  for (var i = 0; i < 30; i++) {
    history.push({ type: "user_message", text: "user turn " + i + " " + new Array(200).join("x"), _ts: 1700000000000 + i });
    history.push({ type: "delta", text: "assistant turn " + i + " " + new Array(200).join("y"), _ts: 1700000000001 + i });
  }
  history.push({
    type: "user_message",
    text: "look at this screenshot",
    imageRefs: [{ mediaType: "image/png", file: "shot-1.png" }],
    _ts: 1700000100000,
  });
  if (imagesDir) {
    fs.mkdirSync(imagesDir, { recursive: true });
    fs.writeFileSync(path.join(imagesDir, "shot-1.png"), Buffer.from("fakepng"));
  }
  return {
    storageId: "sess-123",
    title: "Test session",
    history: history,
    activeWorktree: { branch: "feature-x" },
  };
}

test("writeHandoffPackage keeps the FULL transcript, copies images, writes state", function () {
  var cwd = tmpProject();
  var imagesDir = path.join(cwd, "_img-store");
  try {
    var session = makeSession(imagesDir);
    var info = handoffPackage.writeHandoffPackage({
      cwd: cwd, imagesDir: imagesDir, session: session,
      fromVendor: "claude", toVendor: "codex", targetModel: "gpt-5.5",
    });
    assert.ok(info, "package written");
    var transcript = fs.readFileSync(path.join(cwd, info.transcriptPath), "utf8");
    assert.ok(transcript.indexOf("user turn 0") !== -1, "OLDEST turn preserved in package");
    assert.ok(transcript.indexOf("user turn 29") !== -1, "newest turn preserved");
    assert.ok(fs.existsSync(path.join(cwd, info.imagesDir, "shot-1.png")), "image copied into sandbox-reachable dir");
    assert.strictEqual(info.imageCount, 1);
    var state = JSON.parse(fs.readFileSync(path.join(cwd, info.statePath), "utf8"));
    assert.strictEqual(state.toVendor, "codex");
    assert.strictEqual(state.activeWorktree.branch, "feature-x");
    // Existing fields preserved (not removed by the S3 enrichment).
    assert.strictEqual(state.title, "Test session");
    // Relative paths, so sandboxed agents resolve them from cwd.
    assert.ok(!path.isAbsolute(info.transcriptPath));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("state.json carries the enriched fields: git, tasks, docs, original goal", function () {
  var cwd = tmpProject();
  try {
    // Real git repo so gitBranch/gitDirtyFiles are populated for real.
    execFileSync("git", ["init", "-q"], { cwd: cwd });
    execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: cwd });
    execFileSync("git", ["config", "user.name", "T"], { cwd: cwd });
    execFileSync("git", ["checkout", "-q", "-b", "handoff-branch"], { cwd: cwd });
    fs.writeFileSync(path.join(cwd, "dirty.txt"), "x");
    fs.mkdirSync(path.join(cwd, "docs"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "docs", "MY-ROADMAP.md"), "# r");

    var session = {
      storageId: "sess-state",
      title: "State test",
      history: [
        { type: "user_message", text: "Ship the payments feature", _ts: 1 },
        { type: "tool_executing", name: "TodoWrite", id: "t1", input: { todos: [
          { id: "1", content: "Wire API", status: "in_progress" },
        ] }, _ts: 2 },
      ],
    };
    var info = handoffPackage.writeHandoffPackage({
      cwd: cwd, imagesDir: null, session: session,
      fromVendor: "claude", toVendor: "codex",
    });
    assert.ok(info);
    var state = JSON.parse(fs.readFileSync(path.join(cwd, info.statePath), "utf8"));
    assert.strictEqual(state.gitBranch, "handoff-branch");
    assert.ok(state.gitDirtyFiles.indexOf("dirty.txt") !== -1, "dirty file captured");
    assert.strictEqual(state.tasks.length, 1);
    assert.strictEqual(state.tasks[0].status, "in_progress");
    assert.ok(state.planDocPaths.indexOf(path.join("docs", "MY-ROADMAP.md")) !== -1, "roadmap doc captured");
    assert.strictEqual(state.originalGoal, "Ship the payments feature");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("inline context with a package carries the pointer and drops old turns", function () {
  var cwd = tmpProject();
  try {
    var session = makeSession(null);
    var info = handoffPackage.writeHandoffPackage({
      cwd: cwd, imagesDir: null, session: session,
      fromVendor: "claude", toVendor: "codex",
    });
    var inline = handoffContext.buildHandoffContextFromHistory(session.history, {
      fromVendor: "claude", toVendor: "codex", cwd: cwd,
      packageInfo: info, maxChars: 8000,
    });
    assert.ok(inline.indexOf(info.transcriptPath) !== -1, "pointer to full transcript present");
    assert.ok(inline.indexOf("user turn 29") !== -1, "recent tail inlined");
    // The transcript BLOCK for turn 0 (body starts on its own line) is dropped.
    // The original-goal header line legitimately still echoes turn-0 text, so
    // match the block form ("\nuser turn 0 ") rather than the bare substring.
    assert.ok(inline.indexOf("\nuser turn 0 ") === -1, "old turns deferred to the package file");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("packageInfoIfExists finds a written package and reports images", function () {
  var cwd = tmpProject();
  var imagesDir = path.join(cwd, "_img-store");
  try {
    var session = makeSession(imagesDir);
    handoffPackage.writeHandoffPackage({ cwd: cwd, imagesDir: imagesDir, session: session, fromVendor: "claude", toVendor: "codex" });
    var found = handoffPackage.packageInfoIfExists(cwd, "sess-123");
    assert.ok(found);
    assert.strictEqual(found.imageCount, 1);
    assert.strictEqual(handoffPackage.packageInfoIfExists(cwd, "nope"), null);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("loadHandoffImages re-attaches recent pre-switch pixels, skips copilot", function () {
  var cwd = tmpProject();
  var imagesDir = path.join(cwd, "_img-store");
  try {
    var session = makeSession(imagesDir);
    session.history.push({ type: "vendor_switched", fromVendor: "claude", toVendor: "codex" });
    session.vendor = "codex";
    session.handoffContext = "<clay_handoff_context>x</clay_handoff_context>";
    var images = handoffPackage.loadHandoffImages(session, imagesDir, 5);
    assert.strictEqual(images.length, 1);
    assert.strictEqual(images[0].mediaType, "image/png");
    assert.strictEqual(Buffer.from(images[0].data, "base64").toString(), "fakepng");
    // Text-only vendor: paths only, no blocks.
    session.vendor = "github-copilot";
    assert.strictEqual(handoffPackage.loadHandoffImages(session, imagesDir, 5).length, 0);
    // No pending handoff: nothing to attach.
    session.vendor = "codex";
    session.handoffContext = null;
    assert.strictEqual(handoffPackage.loadHandoffImages(session, imagesDir, 5).length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("packages are removed with the session and swept when stale", function () {
  var cwd = tmpProject();
  try {
    var session = makeSession(null);
    handoffPackage.writeHandoffPackage({ cwd: cwd, imagesDir: null, session: session, fromVendor: "claude", toVendor: "codex" });
    var dir = handoffPackage.packageDir(cwd, "sess-123");
    assert.ok(fs.existsSync(dir));
    handoffPackage.removeHandoffPackage(cwd, "sess-123");
    assert.ok(!fs.existsSync(dir), "removed with session");

    // Stale sweep: age a package via utimes, then sweep.
    handoffPackage.writeHandoffPackage({ cwd: cwd, imagesDir: null, session: session, fromVendor: "claude", toVendor: "codex" });
    var old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    fs.utimesSync(dir, old, old);
    handoffPackage.sweepOldPackages(cwd);
    assert.ok(!fs.existsSync(dir), "stale package swept");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
