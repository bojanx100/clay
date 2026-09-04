// Handoff State — extra situational context captured at a vendor switch.
//
// The inline brief (handoff-context.js) and the on-disk package
// (handoff-package.js) both carry this: the original user goal, current git
// state (branch + uncommitted files), the latest task/todo snapshot, the
// paths of any plan/handoff/roadmap docs in the project, and the working
// agreements (standing instructions mined from the user's own messages). It exists so the
// vendor taking over the session starts with the same ground truth a human
// would glance at — what am I building, on which branch, with what left to do.
//
// Every collector degrades to an empty result on any failure (non-git cwd, git
// missing, unreadable dirs). Nothing here may throw or block the handoff.

var { execFileSync, execFile } = require("child_process");
var fs = require("fs");
var path = require("path");

var GIT_DIRTY_CAP = 30;       // uncommitted paths listed before a "+N more" line
var PLAN_DOC_CAP = 10;        // plan/handoff doc paths listed
var GOAL_MAX_CHARS = 500;     // original-goal truncation
var GIT_TIMEOUT_MS = 2000;    // short git timeout so a wedged repo can't block
var GIT_MAX_BUFFER = 8 * 1024 * 1024; // porcelain of a large tree
var GIT_STATE_CACHE_TTL_MS = 15000; // warmed git state is reused within this window
var AGREEMENT_CAP = 8;        // working agreements listed in the brief
var AGREEMENT_MAX_CHARS = 200; // per-agreement truncation

// Per-cwd cache of git state warmed asynchronously (warmGitStateCache) so the
// synchronous switch/failover path can read it WITHOUT shelling out and
// blocking the daemon event loop. Populated off the hot path; the sync
// collectGitState falls back to a blocking shell-out only on a cache miss
// (rare manual switches, tests).
var gitStateCache = {};

// Directories scanned (non-recursively) for plan/handoff/roadmap docs. Relative
// to cwd; missing dirs are skipped.
var PLAN_DOC_DIRS = [".", "docs", "localAIConfig"];

// Run a git command synchronously, returning trimmed stdout or "" on any
// failure. Mirrors project-workspace-git's helper but with a shorter timeout
// and an injectable exec fn so tests can run without a real repo.
function runGit(cwd, args, execFn) {
  var exec = execFn || execFileSync;
  try {
    // stdio: ignore stdin, pipe stdout (captured), ignore stderr — otherwise
    // execFileSync inherits the child's stderr and a non-git cwd spams the
    // daemon log with git's "not a git repository" messages.
    return String(exec("git", args, {
      cwd: cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
  } catch (e) {
    return "";
  }
}

// Parse `git status --porcelain` into a capped dirty-file list; the array may
// end with a "+N more" marker when the tree has more than GIT_DIRTY_CAP changes.
function dirtyFilesFromPorcelain(porcelain) {
  if (!porcelain) return [];
  var lines = porcelain.split("\n");
  var files = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    // Porcelain v1: two status chars + space, then the path.
    var p = line.length > 3 ? line.substring(3) : line.trim();
    if (p) files.push(p);
  }
  if (files.length > GIT_DIRTY_CAP) {
    var extra = files.length - GIT_DIRTY_CAP;
    var capped = files.slice(0, GIT_DIRTY_CAP);
    capped.push("+" + extra + " more");
    return capped;
  }
  return files;
}

function buildGitState(branch, porcelain) {
  if (!branch) return { branch: null, dirtyFiles: [] };
  return { branch: branch, dirtyFiles: dirtyFilesFromPorcelain(porcelain) };
}

// A fresh copy of the warmed cache entry for cwd, or null on miss/expiry.
function freshCachedGitState(cwd) {
  var entry = gitStateCache[cwd];
  if (!entry) return null;
  if ((Date.now() - entry.at) > GIT_STATE_CACHE_TTL_MS) return null;
  return { branch: entry.state.branch, dirtyFiles: entry.state.dirtyFiles.slice() };
}

// Current branch + capped list of uncommitted/modified paths (porcelain).
// Returns { branch: string|null, dirtyFiles: string[] }. Prefers a warmed
// async snapshot (freshCachedGitState) to avoid blocking; falls back to a
// synchronous shell-out only on a cache miss.
function collectGitState(cwd, execFn) {
  if (!cwd) return { branch: null, dirtyFiles: [] };
  if (!execFn) {
    var cached = freshCachedGitState(cwd);
    if (cached) return cached;
  }
  var branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], execFn);
  // rev-parse fails on an unborn branch (fresh repo, no commits); symbolic-ref
  // still yields the checked-out branch name there. Detached HEAD stays null.
  if (!branch || branch === "HEAD") branch = runGit(cwd, ["symbolic-ref", "--short", "HEAD"], execFn);
  if (!branch) return { branch: null, dirtyFiles: [] };
  return buildGitState(branch, runGit(cwd, ["status", "--porcelain"], execFn));
}

// Run a git command asynchronously, resolving trimmed stdout or "" on any
// failure — never rejects, never blocks the event loop.
function runGitAsync(cwd, args) {
  return new Promise(function (resolve) {
    try {
      execFile("git", args, {
        cwd: cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER, windowsHide: true,
      }, function (err, stdout) {
        resolve(err ? "" : String(stdout || "").trim());
      });
    } catch (e) {
      resolve("");
    }
  });
}

// Async twin of collectGitState — used to warm the cache off the hot path.
function collectGitStateAsync(cwd) {
  if (!cwd) return Promise.resolve({ branch: null, dirtyFiles: [] });
  return runGitAsync(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).then(function (branch) {
    if (!branch || branch === "HEAD") return runGitAsync(cwd, ["symbolic-ref", "--short", "HEAD"]);
    return branch;
  }).then(function (branch) {
    if (!branch) return { branch: null, dirtyFiles: [] };
    return runGitAsync(cwd, ["status", "--porcelain"]).then(function (porcelain) {
      return buildGitState(branch, porcelain);
    });
  });
}

// Populate the per-cwd git-state cache asynchronously. Call this on the switch
// path BEFORE the synchronous collectHandoffState runs, so the sync path reads
// the cached snapshot instead of blocking. Fire-and-forget; never rejects.
function warmGitStateCache(cwd) {
  if (!cwd) return Promise.resolve(null);
  return collectGitStateAsync(cwd).then(function (state) {
    gitStateCache[cwd] = { state: state, at: Date.now() };
    return state;
  }).catch(function () {
    return null;
  });
}

// Test-only: drop cached git state so a suite starts from a clean slate.
function __clearGitStateCache() {
  gitStateCache = {};
}

// The most recent task/todo snapshot from session history. Todos are recorded
// as `tool_executing` entries named "TodoWrite" carrying input.todos (items
// with a content + status; see sdk-message-processor.js). Returns an array of
// { content, status } for the newest snapshot, or null when none exists.
function collectTasks(history) {
  var h = Array.isArray(history) ? history : [];
  for (var i = h.length - 1; i >= 0; i--) {
    var entry = h[i];
    if (!entry || entry._internal) continue;
    if (entry.type === "tool_executing" && entry.name === "TodoWrite" &&
        entry.input && Array.isArray(entry.input.todos)) {
      var todos = entry.input.todos;
      var out = [];
      for (var j = 0; j < todos.length; j++) {
        var t = todos[j] || {};
        out.push({ content: String(t.content || t.subject || ""), status: t.status || "pending" });
      }
      return out.length > 0 ? out : null;
    }
  }
  return null;
}

// True for a markdown filename that looks like a plan/handoff/roadmap/TODO doc.
function isPlanDocName(name) {
  if (!/\.md$/i.test(name)) return false;
  var upper = name.toUpperCase();
  if (upper === "TODO.MD") return true;
  if (upper.indexOf("PLAN") !== -1) return true;
  if (upper.indexOf("HANDOFF") !== -1) return true;
  if (upper.indexOf("ROADMAP") !== -1) return true;
  return false;
}

// List non-recursively the files in cwd/relDir whose name passes matchFn,
// returning cwd-relative paths. Missing/unreadable dirs contribute nothing.
function scanDir(cwd, relDir, matchFn, seen, out, cap) {
  if (out.length >= cap) return;
  var absDir = relDir === "." ? cwd : path.join(cwd, relDir);
  var names;
  try { names = fs.readdirSync(absDir); } catch (e) { return; }
  for (var i = 0; i < names.length && out.length < cap; i++) {
    if (!matchFn(names[i])) continue;
    var rel = relDir === "." ? names[i] : path.join(relDir, names[i]);
    if (seen[rel]) continue;
    // Skip directories that happen to match the name pattern.
    try { if (fs.statSync(path.join(absDir, names[i])).isDirectory()) continue; } catch (e) { continue; }
    seen[rel] = true;
    out.push(rel);
  }
}

// Plan/handoff/roadmap/TODO doc paths (cwd-relative), capped at PLAN_DOC_CAP.
function collectPlanDocPaths(cwd) {
  var out = [];
  if (!cwd) return out;
  var seen = {};
  for (var i = 0; i < PLAN_DOC_DIRS.length; i++) {
    scanDir(cwd, PLAN_DOC_DIRS[i], isPlanDocName, seen, out, PLAN_DOC_CAP);
  }
  // .claude/ holds the autonomous-loop PROMPT.md (plus any plan-named docs).
  scanDir(cwd, ".claude", function (name) {
    return /^PROMPT\.md$/i.test(name) || isPlanDocName(name);
  }, seen, out, PLAN_DOC_CAP);
  return out;
}

// The FIRST user_message text, truncated — the original goal for the session.
function collectOriginalGoal(history) {
  var h = Array.isArray(history) ? history : [];
  for (var i = 0; i < h.length; i++) {
    var entry = h[i];
    if (!entry || entry._internal) continue;
    if (entry.type === "user_message" && entry.text) {
      var text = String(entry.text).trim();
      if (!text) continue;
      if (text.length > GOAL_MAX_CHARS) {
        text = text.substring(0, GOAL_MAX_CHARS) + " [...]";
      }
      return text;
    }
  }
  return null;
}

// A sentence that reads like a standing instruction or correction from the
// user — the behavioral layer a facts-only brief loses: conventions agreed
// mid-conversation, approaches the user rejected, style corrections.
var AGREEMENT_PATTERN = /(^|[\s,;:])(don'?t|do not|never|always|stop|avoid|prefer|instead|from now on|going forward|remember|make sure|no need to|use only|not like|rather than|stick (to|with)|keep (it|them|things)|i want you to|i'?d like you to|we agreed)\b/i;

// Trigger words used as filler or description, not instruction: first-person
// idioms ("don't worry", "don't know") and descriptive always/never ("it
// always fails"). A sentence matching this is skipped even if it also matched
// AGREEMENT_PATTERN — a lost agreement is cheaper than a nonsense one.
var FILLER_PATTERN = /\b((don'?t|do not) (worry|know|think|remember|care|understand|mind)|no worries|never mind|(it|that|this|which|he|she|they) (never|always)|always (happens|happened|fails|failed|works|worked)|never (happens|happened|works|worked))\b/i;

function agreementSentences(text) {
  // Split on newlines and sentence ends; keep fragments that look like
  // instructions and are short enough to be one.
  return String(text).split(/\n+|(?<=[.!?])\s+/);
}

// Standing instructions mined from the user's own messages, most recent
// last, deduped, capped. The first user message is skipped — that is the
// original goal, captured separately.
function collectWorkingAgreements(history) {
  var h = Array.isArray(history) ? history : [];
  var out = [];
  var seen = {};
  var sawGoal = false;
  for (var i = 0; i < h.length; i++) {
    var entry = h[i];
    if (!entry || entry._internal || entry.type !== "user_message" || !entry.text) continue;
    var text = String(entry.text).trim();
    if (!text) continue;
    if (!sawGoal) { sawGoal = true; continue; }
    // Synthetic sends (auto-continue prompts etc.) are not user preferences.
    if (entry.autoAction || /^\[/.test(text)) continue;
    var sentences = agreementSentences(text);
    for (var j = 0; j < sentences.length; j++) {
      var sentence = String(sentences[j]).trim();
      if (!sentence || sentence.length < 8 || sentence.length > AGREEMENT_MAX_CHARS) continue;
      if (!AGREEMENT_PATTERN.test(sentence)) continue;
      if (FILLER_PATTERN.test(sentence)) continue;
      // Questions are usually not instructions.
      if (/\?\s*$/.test(sentence)) continue;
      var key = sentence.toLowerCase().replace(/\W+/g, " ").trim();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(sentence);
    }
  }
  // Keep the MOST RECENT agreements when over the cap — later corrections
  // supersede earlier ones.
  if (out.length > AGREEMENT_CAP) out = out.slice(out.length - AGREEMENT_CAP);
  return out.length > 0 ? out : null;
}

// Collect the full handoff state bundle. opts: { cwd, history, execFileSync }.
// The execFileSync override lets tests exercise git parsing without a repo.
function collectHandoffState(opts) {
  var o = opts || {};
  var git = collectGitState(o.cwd, o.execFileSync);
  return {
    originalGoal: collectOriginalGoal(o.history),
    gitBranch: git.branch,
    gitDirtyFiles: git.dirtyFiles,
    tasks: collectTasks(o.history),
    planDocPaths: collectPlanDocPaths(o.cwd),
    workingAgreements: collectWorkingAgreements(o.history),
  };
}

// Checklist marker for a task status.
function taskMarker(status) {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[~]";
  return "[ ]";
}

// Render the state bundle as brief header lines (leading "\n" per section, so
// it appends cleanly after the Project/Target/Model lines). Returns "" when the
// bundle is entirely empty. Bounded by the collection caps above.
function renderHandoffStateBrief(state) {
  if (!state) return "";
  var out = "";
  if (state.originalGoal) {
    out += "\nOriginal user goal: " + state.originalGoal;
  }
  if (state.gitBranch) {
    out += "\nGit branch: " + state.gitBranch;
    if (state.gitDirtyFiles && state.gitDirtyFiles.length > 0) {
      out += "\nUncommitted files (" + state.gitDirtyFiles.length + "):";
      for (var i = 0; i < state.gitDirtyFiles.length; i++) {
        out += "\n- " + state.gitDirtyFiles[i];
      }
    }
  }
  if (state.tasks && state.tasks.length > 0) {
    out += "\nCurrent tasks:";
    for (var j = 0; j < state.tasks.length; j++) {
      out += "\n" + taskMarker(state.tasks[j].status) + " " + state.tasks[j].content;
    }
  }
  if (state.planDocPaths && state.planDocPaths.length > 0) {
    out += "\nPlan/handoff docs:";
    for (var k = 0; k < state.planDocPaths.length; k++) {
      out += "\n- " + state.planDocPaths[k];
    }
  }
  if (state.workingAgreements && state.workingAgreements.length > 0) {
    out += "\nWorking agreements (standing instructions the user gave during this conversation — keep following them without being reminded):";
    for (var m = 0; m < state.workingAgreements.length; m++) {
      out += "\n- " + state.workingAgreements[m];
    }
  }
  return out;
}

module.exports = {
  collectHandoffState: collectHandoffState,
  collectGitState: collectGitState,
  collectGitStateAsync: collectGitStateAsync,
  warmGitStateCache: warmGitStateCache,
  __clearGitStateCache: __clearGitStateCache,
  collectTasks: collectTasks,
  collectPlanDocPaths: collectPlanDocPaths,
  collectOriginalGoal: collectOriginalGoal,
  collectWorkingAgreements: collectWorkingAgreements,
  renderHandoffStateBrief: renderHandoffStateBrief,
};
