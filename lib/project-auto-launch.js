// project-auto-launch.js - Polls a task-launcher recipe on a schedule and
// auto-starts a Clay session for each newly matching item (e.g. GitHub issues
// assigned to the user). Dedup is handled by the task launcher.
//
// Configuration lives server-side in .clay/tasks/config.json:
//   { "autoLaunch": { "enabled": true, "recipeId": "assigned-to-me", "cron": "*/5 * * * *" } }
//
// The schedule itself is stored as a record in the shared loop registry
// (mode: "autolaunch"), so it survives restarts and reuses the 30s tick timer.
// Follows the attachXxx(ctx) pattern per MODULE_MAP.md.

var fs = require("fs");
var path = require("path");
var taskSources = require("./project-task-sources");
var rateLimitUsageCache = require("./rate-limit-usage-cache");
var { createPrReviewState } = require("./project-pr-review-state");
var { createIssueLaunchState } = require("./project-issue-launch-state");
var { createActivityStore } = require("./project-auto-launch-activity");
var autoLaunchMaintenance = require("./project-auto-launch-maintenance");
var usersModule = require("./users");
var shouldSuppressOwnerNotification =
  require("./coop-control-provenance").shouldSuppressOwnerNotification;

var REGISTRY_ID = "autolaunch_assigned";
var DEFAULT_CRON = "*/5 * * * *";
var DEFAULT_MAX_PASSES = 2;
var DEFAULT_VENDOR_WEIGHTS = { claude: 60, codex: 40 };

function isPrReviewKind(recipe) {
  var kind = (recipe && recipe.source && recipe.source.kind) || "";
  return kind === "pr-reviews" || kind === "pr-review" || kind === "prs";
}

function autoKindForRecipe(recipe) {
  if (isPrReviewKind(recipe)) return "pr-review";
  if (recipe && recipe.source && recipe.source.provider === "sentry") return "sentry";
  return "issue";
}

// Stable per-issue key shared by the launch loop and completion hook.
function issueKey(recipe, number) {
  var repo = (recipe && recipe.source && recipe.source.repo) || "";
  if (number == null) return "";
  return repo + "#" + number;
}

function launchItemKey(recipe, item) {
  if (item && item.key) return item.key;
  if (recipe && recipe.source && recipe.source.provider === "sentry") {
    var org = recipe.source.organization || "";
    var project = recipe.source.project || "";
    var id = item && (item.sentry_id || item.number);
    return "sentry:" + org + "/" + project + "#" + id;
  }
  return issueKey(recipe, item && item.number);
}

// Case-insensitive membership for project-status names.
function statusInList(status, list) {
  if (!status || !Array.isArray(list)) return false;
  var want = String(status).toLowerCase();
  for (var i = 0; i < list.length; i++) {
    if (String(list[i]).toLowerCase() === want) return true;
  }
  return false;
}

// Keep only positive integer weights keyed by vendor.
function normalizeWeights(w) {
  var out = {};
  if (w && typeof w === "object") {
    var keys = Object.keys(w);
    for (var i = 0; i < keys.length; i++) {
      var v = parseInt(w[keys[i]], 10);
      if (Number.isFinite(v) && v > 0) out[keys[i]] = v;
    }
  }
  return out;
}

function attachAutoLaunch(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug || "";
  var sm = ctx.sm;
  var usersApi = ctx.usersModule || usersModule;
  var loopRegistry = ctx.loopRegistry;
  var getTaskLauncher = ctx.getTaskLauncher;
  var fetchTaskItems = ctx.fetchItems || taskSources.fetchItems;
  // Non-blocking scan for the scheduled (background) path. Tests inject a
  // synchronous ctx.fetchItems; production uses the child-process worker so the
  // daemon event loop never stalls during the ~25s GitHub scan.
  var fetchTaskItemsAsync = ctx.fetchItemsAsync || taskSources.fetchItemsAsync;
  var rateLimitCache = ctx.rateLimitCache || rateLimitUsageCache;
  var notificationsModule = ctx.notificationsModule || null;
  var pushModule = ctx.pushModule || null;
  var send = ctx.send || null;     // broadcast to all clients of this project
  var sendTo = ctx.sendTo || null; // reply to one client
  var tasksDir = path.join(cwd, ".clay", "tasks");
  var configPath = path.join(tasksDir, "config.json");
  var prReviewState = createPrReviewState(cwd);
  var issueLaunchState = createIssueLaunchState(cwd);
  var activity = createActivityStore(cwd);

  function broadcastActivity() {
    if (send) send(Object.assign({ type: "auto_launch_activity" }, activity.payload()));
  }

  function readFullConfig() {
    try {
      var parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return (parsed && typeof parsed === "object") ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function readConfig() {
    var full = readFullConfig();
    return full.autoLaunch || null;
  }

  // The active recipe list. Prefer the new `recipes` array; fall back to the
  // legacy single `recipeId` so existing configs keep working.
  function recipeListFrom(cfg) {
    cfg = cfg || {};
    var ids = [];
    if (Array.isArray(cfg.recipes)) {
      for (var i = 0; i < cfg.recipes.length; i++) {
        var id = String(cfg.recipes[i] || "").replace(/[^a-zA-Z0-9._-]/g, "");
        if (id && ids.indexOf(id) === -1) ids.push(id);
      }
    }
    if (ids.length === 0 && cfg.recipeId) ids.push(cfg.recipeId);
    return ids;
  }

  function getState() {
    var cfg = readConfig() || {};
    var weights = normalizeWeights(cfg.vendorWeights);
    if (!Object.keys(weights).length) weights = Object.assign({}, DEFAULT_VENDOR_WEIGHTS);
    var recipes = recipeListFrom(cfg);
    var maxPasses = parseInt(cfg.maxPasses, 10);
    if (!Number.isFinite(maxPasses) || maxPasses <= 0) maxPasses = DEFAULT_MAX_PASSES;
    return {
      enabled: !!cfg.enabled,
      recipeId: cfg.recipeId || (recipes.length ? recipes[0] : "assigned-to-me"),
      recipes: recipes.length ? recipes : ["assigned-to-me"],
      maxPasses: maxPasses,
      cron: cfg.cron || DEFAULT_CRON,
      vendorWeights: weights,
    };
  }

  function isValidCron(expr) {
    return typeof expr === "string" && expr.trim().split(/\s+/).length === 5;
  }

  // Persist config (merging, never clobbering other keys like launchApi), then
  // reconcile the schedule so changes apply live without a restart. Only the
  // fields present in `partial` are touched.
  function setConfig(partial) {
    partial = partial || {};
    var full = readFullConfig();
    var cfg = full.autoLaunch || {};
    if (partial.enabled !== undefined) cfg.enabled = !!partial.enabled;
    if (partial.recipeId !== undefined) {
      var safeId = String(partial.recipeId || "").replace(/[^a-zA-Z0-9._-]/g, "");
      if (safeId) cfg.recipeId = safeId;
    }
    if (partial.recipes !== undefined && Array.isArray(partial.recipes)) {
      var clean = [];
      for (var ri = 0; ri < partial.recipes.length; ri++) {
        var rid = String(partial.recipes[ri] || "").replace(/[^a-zA-Z0-9._-]/g, "");
        if (rid && clean.indexOf(rid) === -1) clean.push(rid);
      }
      cfg.recipes = clean;
      if (clean.length && clean.indexOf(cfg.recipeId) === -1) cfg.recipeId = clean[0];
    }
    if (partial.maxPasses !== undefined) {
      var mp = parseInt(partial.maxPasses, 10);
      if (Number.isFinite(mp) && mp >= 1) cfg.maxPasses = mp;
    }
    if (partial.cron !== undefined && isValidCron(partial.cron)) {
      cfg.cron = String(partial.cron).trim();
    }
    if (partial.vendorWeights !== undefined) {
      var nw = normalizeWeights(partial.vendorWeights);
      if (Object.keys(nw).length) cfg.vendorWeights = nw;
    }
    if (!cfg.recipeId) cfg.recipeId = "assigned-to-me";
    if (!cfg.cron) cfg.cron = DEFAULT_CRON;
    full.autoLaunch = cfg;
    try {
      fs.mkdirSync(tasksDir, { recursive: true });
      var tmp = configPath + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(full, null, 2) + "\n");
      fs.renameSync(tmp, configPath);
    } catch (e) {
      console.error("[auto-launch] failed to save config:", e.message);
    }
    ensureSchedule();
    return getState();
  }

  // List recipes available under .clay/tasks so the UI can offer a picker with
  // a human-readable name + description for each.
  function listRecipes() {
    var out = [];
    var files;
    try { files = fs.readdirSync(tasksDir); } catch (e) { return out; }
    for (var i = 0; i < files.length; i++) {
      if (!/\.json$/i.test(files[i]) || files[i] === "config.json") continue;
      var id = files[i].replace(/\.json$/i, "");
      var recipe;
      try {
        recipe = JSON.parse(fs.readFileSync(path.join(tasksDir, files[i]), "utf8"));
      } catch (e) { continue; }
      // Only recipe-shaped files (those with a task source) — skip state files
      // like dashboard-state.json that also live under .clay/tasks.
      if (!recipe || typeof recipe !== "object" || !recipe.source) continue;
      out.push({
        id: id,
        name: recipe.name ? String(recipe.name) : id,
        description: recipe.description ? String(recipe.description) : "",
        kind: (recipe.source && recipe.source.kind) || "issue",
      });
    }
    return out;
  }

  function statePayload() {
    var state = getState();
    // `recipes` is the AVAILABLE recipe list (objects) the dropdown renders;
    // `selectedRecipes` is the list of recipe ids currently auto-launched.
    return Object.assign({}, state, {
      type: "auto_launch_state",
      recipes: listRecipes(),
      selectedRecipes: state.recipes,
    });
  }

  function handleMessage(ws, msg) {
    if (!msg || !msg.type) return false;
    if (msg.type === "get_auto_launch") {
      if (sendTo) sendTo(ws, statePayload());
      return true;
    }
    if (msg.type === "get_auto_launch_activity") {
      if (sendTo) sendTo(ws, Object.assign({ type: "auto_launch_activity" }, activity.payload()));
      return true;
    }
    if (msg.type === "clear_auto_launch_activity") {
      activity.clear();
      broadcastActivity();
      return true;
    }
    if (msg.type === "set_auto_launch") {
      var partial = {};
      if (msg.enabled !== undefined) partial.enabled = msg.enabled;
      if (msg.recipeId !== undefined) partial.recipeId = msg.recipeId;
      if (msg.recipes !== undefined) partial.recipes = msg.recipes;
      if (msg.maxPasses !== undefined) partial.maxPasses = msg.maxPasses;
      if (msg.cron !== undefined) partial.cron = msg.cron;
      if (msg.vendorWeights !== undefined) partial.vendorWeights = msg.vendorWeights;
      setConfig(partial);
      if (send) send(statePayload()); else if (sendTo) sendTo(ws, statePayload());
      return true;
    }
    return false;
  }

  // Create / update / disable the schedule record to match config on disk.
  function ensureSchedule() {
    if (!loopRegistry) return;
    var cfg = readConfig();
    var recipes = recipeListFrom(cfg);
    var existing = loopRegistry.getById(REGISTRY_ID);
    var enabled = !!(cfg && cfg.enabled && recipes.length > 0);
    if (!enabled) {
      if (existing) loopRegistry.updateRecord(REGISTRY_ID, { enabled: false, nextRunAt: null });
      return;
    }
    var cron = cfg.cron || DEFAULT_CRON;
    var label = recipes.join(", ");
    if (existing) {
      loopRegistry.updateRecord(REGISTRY_ID, {
        enabled: true,
        cron: cron,
        task: recipes.join(","),
        mode: "autolaunch",
        name: "Auto-launch: " + label,
        nextRunAt: loopRegistry.nextRunTime(cron),
      });
    } else {
      loopRegistry.register({
        id: REGISTRY_ID,
        name: "Auto-launch: " + label,
        cron: cron,
        task: recipes.join(","),
        mode: "autolaunch",
        enabled: true,
      });
    }
    console.log("[auto-launch] Scheduled recipe(s) '" + label + "' with cron '" + cron + "'");
  }

  // Smooth weighted round-robin (nginx-style) so a 60/40 split interleaves as
  // claude, codex, claude, codex, claude, ... rather than bursting. State is
  // kept in-memory and reset whenever the weights change.
  var swrr = { sig: "", current: {} };
  function makeVendorPicker(weights) {
    var vendors = Object.keys(weights);
    if (vendors.length === 0) return null;
    if (vendors.length === 1) { var only = vendors[0]; return function () { return only; }; }
    var total = 0;
    for (var i = 0; i < vendors.length; i++) total += weights[vendors[i]];
    var sig = JSON.stringify(weights);
    if (swrr.sig !== sig) {
      swrr.sig = sig;
      swrr.current = {};
      for (var j = 0; j < vendors.length; j++) swrr.current[vendors[j]] = 0;
    }
    return function () {
      var best = null;
      for (var k = 0; k < vendors.length; k++) {
        var v = vendors[k];
        swrr.current[v] += weights[v];
        if (best === null || swrr.current[v] > swrr.current[best]) best = v;
      }
      swrr.current[best] -= total;
      return best;
    };
  }

  // Vendors that currently can't take work because their account hit a rate
  // limit (the SDK rejected a request until resetsAt). Rate limits are
  // account-wide, so a rejection seen in any project/session applies here too.
  // Returns a map { vendor: resetsAt } of unavailable vendors.
  function rateLimitedVendors() {
    var out = {};
    var entries;
    try { entries = rateLimitCache.liveEntries(); } catch (e) { entries = []; }
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e && e.vendor && e.status === "rejected") {
        out[e.vendor] = e.resetsAt || true;
      }
    }
    return out;
  }

  // Resolve which vendor to launch this session as, given the vendor the picker
  // wants and the set currently rate-limited. Falls back to any configured
  // vendor that is still available (claude<->codex etc.). Returns null when
  // every configured vendor is rate-limited, so the caller can defer the item to
  // a later tick instead of starting a session that would be rejected instantly.
  function pickAvailableVendor(desired, configuredVendors, blocked) {
    if (desired && !blocked[desired]) return desired;
    for (var i = 0; i < configuredVendors.length; i++) {
      var v = configuredVendors[i];
      if (!blocked[v]) return v;
    }
    return null;
  }

  function resolveMaxPasses(recipe) {
    var cfg = readConfig() || {};
    var cmp = parseInt(cfg.maxPasses, 10);
    if (Number.isFinite(cmp) && cmp > 0) return cmp;
    if (recipe && recipe.launch && recipe.launch.maxPasses) {
      var rmp = parseInt(recipe.launch.maxPasses, 10);
      if (Number.isFinite(rmp) && rmp > 0) return rmp;
    }
    return DEFAULT_MAX_PASSES;
  }

  async function launchScheduled(recipeId, extraArgs) {
    var tl = getTaskLauncher && getTaskLauncher();
    if (!tl) return { ok: false, error: "Task launcher unavailable", started: [], skipped: [] };
    var recipe = tl.loadRecipe(recipeId);
    if (!recipe) return { ok: false, error: "Recipe not found: " + recipeId, started: [], skipped: [] };
    var prKind = isPrReviewKind(recipe);
    var autoKind = autoKindForRecipe(recipe);
    var maintenanceDeferral = autoLaunchMaintenance.deferralFor(sm, autoKind);
    if (maintenanceDeferral) return maintenanceDeferral;
    var args = Object.assign({}, extraArgs || {});
    // Await either the injected sync fetch (tests) or the child-process worker
    // (production). `await` on a sync return value is harmless, so both work.
    var items = ctx.fetchItems
      ? await fetchTaskItems(cwd, recipe, args)
      : await fetchTaskItemsAsync(cwd, recipe, args);
    maintenanceDeferral = autoLaunchMaintenance.deferralFor(sm, autoKind);
    if (maintenanceDeferral) return maintenanceDeferral;
    // Alternate the coding agent per started session per the configured split,
    // unless the caller already pinned a vendor via extraArgs.
    var picker = args.vendor ? null : makeVendorPicker(getState().vendorWeights || {});
    // Cap new sessions per tick to avoid a thundering herd on the first poll.
    // Dedup means later ticks pick up the remainder once these finish/are seen.
    var perTick = parseInt((recipe.launch && recipe.launch.defaultLimit) || 5, 10);
    if (!Number.isFinite(perTick) || perTick <= 0) perTick = 5;
    var maxPasses = resolveMaxPasses(recipe);
    // Vendor availability: if the picker wants a vendor whose account is rate-
    // limited, fall back to another configured vendor that is still available
    // (claude<->codex). If every configured vendor is rate-limited, defer.
    var blockedVendors = rateLimitedVendors();
    var configuredVendors = Object.keys(getState().vendorWeights || {});
    var started = [];
    var skipped = [];
    var deferred = 0;
    var vendorDeferred = 0;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      // Dedup: never start a second LIVE session for the same item. For issues we
      // dedup across ALL recipes (via findAnyLiveSessionForItem) so two issue
      // recipes — e.g. a misconfigured one cloning the issue source — cannot both
      // launch the same issue. PR-review items stay per-recipe.
      var liveDup = isPrReviewKind(recipe)
        ? tl.findExistingSessionForItem(recipe, item, true)
        : (tl.findAnyLiveSessionForItem
            ? tl.findAnyLiveSessionForItem(item)
            : tl.findExistingSessionForItem(recipe, item, true));
      if (liveDup) {
        skipped.push(item);
        continue;
      }
      // Issue recipes also dedup against COMPLETED sessions, with two controlled
      // exceptions: an armed bounce relaunch, or a legacy completed session from
      // before issue-launch-state existed. The legacy path relaunches once, then
      // recordLaunch creates state so later ticks return to normal deduping.
      var itemIssueKey = launchItemKey(recipe, item);
      var visibleIssueSession = !prKind && tl.findAnyVisibleSessionForItem
        ? tl.findAnyVisibleSessionForItem(item)
        : null;
      var existingIssueSession = !prKind
        ? (visibleIssueSession || tl.findExistingSessionForItem(recipe, item, false))
        : null;
      if (!prKind && existingIssueSession) {
        var hasIssueState = issueLaunchState.hasEntry(itemIssueKey);
        var legacyCompleted = !hasIssueState && existingIssueSession.taskLauncher && existingIssueSession.taskLauncher.workflowCompleted;
        if (hasIssueState && visibleIssueSession) {
          skipped.push(item);
          continue;
        }
        if (!legacyCompleted && !issueLaunchState.shouldRelaunch(itemIssueKey)) {
          skipped.push(item);
          continue;
        }
      }
      // PR-review gating: only launch when there's a failing check or new review
      // feedback and the pass budget allows it (read-only; may persist a reset).
      if (prKind) {
        var decision = prReviewState.shouldLaunch(item, maxPasses);
        if (!decision.launch) { skipped.push(item); continue; }
        item.pass_number = decision.passNumber;
        item.max_passes = decision.maxPasses;
      }
      if (started.length >= perTick) { deferred++; continue; }
      // Resolve the vendor with a rate-limit-aware fallback. Peek the picker (only
      // consume its rotation when we actually start), then swap to an available
      // vendor if the desired one is rate-limited. If none are available, defer
      // this item — starting now would just be rejected until the limit resets.
      var itemArgs;
      if (picker) {
        var desiredVendor = picker();
        var useVendor = pickAvailableVendor(desiredVendor, configuredVendors, blockedVendors);
        if (!useVendor) { vendorDeferred++; continue; }
        if (useVendor !== desiredVendor) {
          console.log("[auto-launch] vendor '" + desiredVendor + "' is rate-limited; falling back to '" + useVendor + "' for #" + item.number);
        }
        itemArgs = Object.assign({}, args, { vendor: useVendor });
      } else {
        // Caller pinned a vendor (e.g. manual launch): still defer if it's out.
        if (args.vendor && blockedVendors[args.vendor]) { vendorDeferred++; continue; }
        itemArgs = args;
      }
      // Count the pass only when we actually start (deferred items try next tick).
      if (prKind) prReviewState.recordLaunch(item, maxPasses);
      // Disarm any pending bounce so a single bounce only relaunches once.
      else issueLaunchState.recordLaunch(itemIssueKey);
      var sess = tl.startSessionForItem(null, recipe, item, itemArgs, null, { auto: true });
      started.push(sess);
      activity.record({
        type: "started",
        recipeId: recipe.id,
        autoKind: autoKind,
        number: item.number,
        url: item.url,
        title: sess && sess.title,
        sessionId: sess && sess.localId,
        storageId: sess && (sess.storageId || sess.cliSessionId),
      });
    }
    if (started.length > 0) {
      if (sm && typeof sm.broadcastSessionList === "function") sm.broadcastSessionList();
      broadcastActivity();
    }
    if (deferred > 0) console.log("[auto-launch] '" + recipeId + "': capped at " + perTick + " new session(s) this tick; " + deferred + " deferred to next tick");
    if (vendorDeferred > 0) console.log("[auto-launch] '" + recipeId + "': " + vendorDeferred + " item(s) deferred — all configured vendors are rate-limited (" + Object.keys(blockedVendors).join(", ") + ")");
    return { ok: true, started: started, skipped: skipped, deferred: deferred, vendorDeferred: vendorDeferred, maintenanceDeferred: false };
  }

  // Invoked by the loop registry tick when the autolaunch record fires. Runs
  // every configured recipe (e.g. issues to start + PRs to fix) in one tick.
  async function runScheduled(record) {
    var cfg = readConfig();
    if (!cfg || !cfg.enabled) {
      ensureSchedule();
      return;
    }
    var recipes = recipeListFrom(cfg);
    // Reconcile the schedule record with config when it has drifted. The UI path
    // (set_auto_launch) calls ensureSchedule, but a direct edit of config.json
    // does not — so the record's cron/task/name would otherwise stay stale until
    // the next project attach, and a changed cron would keep firing at the old
    // frequency. Only touch the record when config actually defines recipes and a
    // field differs, to avoid a needless write + broadcast every tick.
    if (record && loopRegistry && recipes.length > 0) {
      var wantCron = cfg.cron || DEFAULT_CRON;
      var wantTask = recipes.join(",");
      var wantName = "Auto-launch: " + recipes.join(", ");
      if (record.cron !== wantCron || record.task !== wantTask || record.name !== wantName) {
        ensureSchedule();
      }
    }
    if (recipes.length === 0 && record && record.task) {
      recipes = String(record.task).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    }
    for (var i = 0; i < recipes.length; i++) {
      var recipeId = recipes[i];
      try {
        var res = await launchScheduled(recipeId);
        if (res && res.maintenanceDeferred) {
          console.log("[auto-launch] recipe '" + recipeId + "' deferred while " + res.maintenanceCommand + " is active");
          continue;
        }
        var startedCount = (res && res.started) ? res.started.length : 0;
        var skippedCount = (res && res.skipped) ? res.skipped.length : 0;
        if (startedCount > 0 || skippedCount > 0) {
          console.log("[auto-launch] recipe '" + recipeId + "': started " + startedCount + ", skipped " + skippedCount);
        }
      } catch (e) {
        console.error("[auto-launch] failed for recipe '" + recipeId + "':", e.message || e);
      }
    }
  }

  // Called by the task launcher when an auto-launched session pauses for input
  // (confidence below threshold). Pings the user in-session + via mobile push,
  // latched so a single pause only notifies once.
  function notifyNeedsInput(session, text) {
    if (!session || !session.taskLauncher) return;
    if (session.taskLauncher.awaitingInputNotified) return;
    session.taskLauncher.awaitingInputNotified = true;
    if (sm && typeof sm.saveSessionFile === "function") sm.saveSessionFile(session);
    var preview = String(text || "").replace(/\s+/g, " ").trim();
    if (preview.length > 140) preview = preview.substring(0, 140) + "...";
    var title = (session.title || "Task") + " needs your input";
    var suppressed = shouldSuppressOwnerNotification(session, usersApi);
    if (!suppressed && notificationsModule && typeof notificationsModule.notify === "function") {
      notificationsModule.notify("needs_input", {
        title: title,
        preview: preview,
        slug: slug,
        sessionId: session.localId,
        ownerId: session.ownerId || null,
      });
    }
    if (!suppressed && pushModule && typeof pushModule.sendPush === "function") {
      pushModule.sendPush({
        type: "needs_input",
        slug: slug,
        title: title,
        body: preview || "Needs your input",
        tag: "clay-needs-input",
      });
    }
  }

  // Called when an auto-launched session finishes its workflow. Fires a single
  // completion notification (in-app + mobile push) with the agent's one-line
  // summary, and — for PR-review sessions — snapshots the resulting head SHA so
  // the agent's own fix commit never resets the pass budget.
  function notifyCompleted(session, summary) {
    if (!session || !session.taskLauncher) return;
    var tl = session.taskLauncher;
    var preview = String(summary || "").replace(/\s+/g, " ").trim();
    if (preview.length > 160) preview = preview.substring(0, 160) + "...";
    if (!preview) preview = tl.autoKind === "pr-review" ? "PR review handled" : "Task complete";
    var title = (session.title || "Task") + " — done";
    var suppressed = shouldSuppressOwnerNotification(session, usersApi);
    if (!suppressed && notificationsModule && typeof notificationsModule.notify === "function") {
      notificationsModule.notify("task_completed", {
        title: title,
        preview: preview,
        slug: slug,
        sessionId: session.localId,
        ownerId: session.ownerId || null,
        autoKind: tl.autoKind || "issue",
      });
    }
    if (!suppressed && pushModule && typeof pushModule.sendPush === "function") {
      pushModule.sendPush({
        type: "task_completed",
        slug: slug,
        title: title,
        body: preview,
        tag: "clay-task-done",
      });
    }
    if (tl.autoKind === "pr-review" && tl.prKey) {
      try {
        var tlMod = getTaskLauncher && getTaskLauncher();
        var recipe = tlMod ? tlMod.loadRecipe(tl.recipeId) : null;
        var headSha = recipe ? taskSources.getPrHead(cwd, recipe, tl.itemNumber) : "";
        prReviewState.recordCompletion(tl.prKey, headSha);
      } catch (e) {
        console.log("[auto-launch] recordCompletion failed:", e && e.message);
      }
    } else if ((tl.autoKind || "issue") === "issue" && tl.itemNumber != null) {
      // Snapshot the issue's board status on completion. If it progressed off a
      // ready status (e.g. into "Dev Complete"), arm it: a later bounce back to
      // a ready status will be allowed to relaunch exactly once.
      try {
        var tlModI = getTaskLauncher && getTaskLauncher();
        var recipeI = tlModI ? tlModI.loadRecipe(tl.recipeId) : null;
        if (recipeI) {
          var statusNow = taskSources.getIssueStatus(cwd, recipeI, tl.itemNumber);
          var skip = (recipeI.filter && recipeI.filter.skipProjectStatuses) || [];
          var progressed = statusInList(statusNow, skip);
          issueLaunchState.recordCompletion(tl.itemKey || issueKey(recipeI, tl.itemNumber), statusNow, progressed);
        }
      } catch (e) {
        console.log("[auto-launch] issue recordCompletion failed:", e && e.message);
      }
    }
    activity.record({
      type: "completed",
      recipeId: tl.recipeId,
      autoKind: tl.autoKind || "issue",
      number: tl.itemNumber,
      url: tl.itemUrl,
      title: session.title,
      sessionId: session.localId,
      storageId: session.storageId || session.cliSessionId,
      summary: preview,
    });
    broadcastActivity();
  }

  return {
    ensureSchedule: ensureSchedule,
    runScheduled: runScheduled,
    launchScheduled: launchScheduled,
    notifyNeedsInput: notifyNeedsInput,
    notifyCompleted: notifyCompleted,
    handleMessage: handleMessage,
    getState: getState,
  };
}

module.exports = { attachAutoLaunch: attachAutoLaunch };
