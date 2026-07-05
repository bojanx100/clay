// Regression tests for the Handoff Package: the on-disk half of a vendor
// switch (full transcript + image copies + state), the inline pointer, and
// real-image re-attachment on handoff-carrying sends.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

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
    // Relative paths, so sandboxed agents resolve them from cwd.
    assert.ok(!path.isAbsolute(info.transcriptPath));
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
    assert.ok(inline.indexOf("user turn 0 ") === -1, "old turns deferred to the package file");
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
