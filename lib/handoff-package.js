// Handoff Package — the on-disk half of a vendor switch.
//
// The inline handoff context is a trimmed prompt prepend: images degrade to
// text lines and old turns fall off the token budget. The package keeps the
// COMPLETE story on disk, inside the project (so sandboxed agents can read
// it), and the inline context carries a pointer instead of the full payload:
//
//   .clay/handoffs/<storageId>/
//     transcript.md   full untruncated transcript
//     images/         copies of every conversation image (imagesDir lives in
//                     ~/.clay — OUTSIDE the Codex sandbox — so copies are the
//                     only way a sandboxed agent can actually view them)
//     state.json      session/workspace meta at switch time
//
// Packages are removed with their session and swept after MAX_AGE_DAYS.

var fs = require("fs");
var path = require("path");
var { buildTranscriptMarkdown, recentImageRefsBeforeSwitch } = require("./handoff-context");
var handoffState = require("./handoff-state");

var HANDOFFS_DIRNAME = path.join(".clay", "handoffs");
var MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
var MAX_IMAGE_COPIES = 200;

function safeId(storageId) {
  return String(storageId || "").replace(/[^A-Za-z0-9._-]/g, "-");
}

function packageDir(cwd, storageId) {
  return path.join(cwd, HANDOFFS_DIRNAME, safeId(storageId));
}

function relPaths(storageId) {
  var base = path.join(HANDOFFS_DIRNAME, safeId(storageId));
  return {
    dir: base,
    transcriptPath: path.join(base, "transcript.md"),
    imagesDir: path.join(base, "images"),
    statePath: path.join(base, "state.json"),
  };
}

function collectAllImageRefs(history) {
  var seen = {};
  var refs = [];
  var h = Array.isArray(history) ? history : [];
  for (var i = 0; i < h.length; i++) {
    var entry = h[i];
    if (!entry || !Array.isArray(entry.imageRefs)) continue;
    for (var j = 0; j < entry.imageRefs.length; j++) {
      var ref = entry.imageRefs[j];
      if (!ref || !ref.file || seen[ref.file]) continue;
      seen[ref.file] = true;
      refs.push(ref);
      if (refs.length >= MAX_IMAGE_COPIES) return refs;
    }
  }
  return refs;
}

// Write the package. Returns pointer info with cwd-RELATIVE paths (agents run
// in cwd; relative paths stay valid inside sandboxes), or null when there was
// nothing to write or the write failed — callers fall back to inline-only.
function writeHandoffPackage(opts) {
  var cwd = opts && opts.cwd;
  var session = opts && opts.session;
  if (!cwd || !session) return null;
  var storageId = session.storageId || session.cliSessionId;
  if (!storageId) return null;
  try {
    var transcript = buildTranscriptMarkdown(session.history, {
      fromVendor: opts.fromVendor,
      toVendor: opts.toVendor,
      cwd: cwd,
      imagesDir: opts.imagesDir || null,
      targetModel: opts.targetModel || null,
    });
    if (!transcript) return null;

    var dir = packageDir(cwd, storageId);
    var imagesOut = path.join(dir, "images");
    fs.mkdirSync(imagesOut, { recursive: true });
    fs.writeFileSync(path.join(dir, "transcript.md"), transcript, "utf8");

    var imageCount = 0;
    if (opts.imagesDir) {
      var refs = collectAllImageRefs(session.history);
      for (var i = 0; i < refs.length; i++) {
        try {
          fs.copyFileSync(path.join(opts.imagesDir, refs[i].file), path.join(imagesOut, refs[i].file));
          imageCount++;
        } catch (e) { /* image file gone (retention cleanup) — skip */ }
      }
    }

    // Situational state (git branch + dirty files, current task snapshot, plan
    // doc paths, original goal). Reuse a caller-provided bundle when present so
    // the brief and the package share one collection; otherwise gather it here.
    var extraState = opts.handoffState ||
      handoffState.collectHandoffState({ cwd: cwd, history: session.history });

    var state = {
      writtenAt: new Date().toISOString(),
      title: session.title || "",
      storageId: storageId,
      fromVendor: opts.fromVendor || null,
      toVendor: opts.toVendor || null,
      targetModel: opts.targetModel || null,
      activeWorktree: session.activeWorktree || null,
      taskLauncher: session.taskLauncher ? {
        recipeId: session.taskLauncher.recipeId || null,
        itemNumber: session.taskLauncher.itemNumber || null,
        itemUrl: session.taskLauncher.itemUrl || null,
      } : null,
      gitBranch: extraState.gitBranch,
      gitDirtyFiles: extraState.gitDirtyFiles,
      tasks: extraState.tasks,
      planDocPaths: extraState.planDocPaths,
      originalGoal: extraState.originalGoal,
    };
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2), "utf8");

    // Opportunistic sweep of stale sibling packages (no timers needed).
    sweepOldPackages(cwd);

    var rel = relPaths(storageId);
    return {
      transcriptPath: rel.transcriptPath,
      imagesDir: rel.imagesDir,
      statePath: rel.statePath,
      imageCount: imageCount,
    };
  } catch (e) {
    console.warn("[handoff-package] write failed for " + storageId + ": " + (e.message || e));
    return null;
  }
}

// Pointer info for an already-written package (recovery paths after restart).
function packageInfoIfExists(cwd, storageId) {
  if (!cwd || !storageId) return null;
  var dir = packageDir(cwd, storageId);
  try {
    if (!fs.existsSync(path.join(dir, "transcript.md"))) return null;
    var imageCount = 0;
    try { imageCount = fs.readdirSync(path.join(dir, "images")).length; } catch (e) {}
    var rel = relPaths(storageId);
    return {
      transcriptPath: rel.transcriptPath,
      imagesDir: rel.imagesDir,
      statePath: rel.statePath,
      imageCount: imageCount,
    };
  } catch (e) {
    return null;
  }
}

function removeHandoffPackage(cwd, storageId) {
  if (!cwd || !storageId) return;
  try { fs.rmSync(packageDir(cwd, storageId), { recursive: true, force: true }); } catch (e) {}
}

function sweepOldPackages(cwd, maxAgeMs) {
  var root = path.join(cwd, HANDOFFS_DIRNAME);
  var cutoff = Date.now() - (maxAgeMs || MAX_AGE_MS);
  var names;
  try { names = fs.readdirSync(root); } catch (e) { return; }
  for (var i = 0; i < names.length; i++) {
    var dir = path.join(root, names[i]);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  }
}

// Load the most recent pre-switch conversation images as SDK-ready content
// blocks ({mediaType, data}) so handoff-carrying sends re-attach the REAL
// pixels — the inline transcript only carries text descriptions. Only while a
// handoff is pending, and never for text-only vendors.
function loadHandoffImages(session, imagesDir, maxImages) {
  if (!session || !imagesDir || !session.handoffContext) return [];
  if (session.vendor === "github-copilot") return [];
  var refs = recentImageRefsBeforeSwitch(session.history, maxImages || 5);
  var out = [];
  for (var i = 0; i < refs.length; i++) {
    try {
      var data = fs.readFileSync(path.join(imagesDir, refs[i].file)).toString("base64");
      out.push({ mediaType: refs[i].mediaType || "image/png", data: data });
    } catch (e) { /* image expired via retention cleanup — skip */ }
  }
  return out;
}

module.exports = {
  writeHandoffPackage: writeHandoffPackage,
  loadHandoffImages: loadHandoffImages,
  packageInfoIfExists: packageInfoIfExists,
  removeHandoffPackage: removeHandoffPackage,
  sweepOldPackages: sweepOldPackages,
  packageDir: packageDir,
};
