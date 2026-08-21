var http = require("http");
var fs = require("fs");
var path = require("path");
var { WebSocketServer } = require("ws");
var pages = require("./pages");
var smtp = require("./smtp");
var { createProjectContext } = require("./project");
var users = require("./users");
var dm = require("./dm");
var mates = require("./mates");
var serverAuth = require("./server-auth");
var serverSkills = require("./server-skills");
var serverDm = require("./server-dm");
var serverMates = require("./server-mates");
var serverClayHome = require("./server-clay-home");
var serverAdmin = require("./server-admin");
var serverSettings = require("./server-settings");
var serverPalette = require("./server-palette");
var serverEmail = require("./server-email");
var serverGlobalWs = require("./server-global-ws");
var serverStatic = require("./server-static");
var serverTuiHooks = require("./server-tui-hooks");
var shouldSuppressDetachedAdoptedSession =
  serverTuiHooks.shouldSuppressDetachedAdoptedSession;
var serverSockets = require("./server-sockets");
var serverCrossProject = require("./server-cross-project");
var { createLiveUiRegistry } = require("./server-live-ui-registry");
var projectIdentity = require("./project-identity");
var globalCoopProjection = require("./global-coop-projection");
var coopControlPlane = require("./coop-control-plane");
var coopActionDecision = require("./coop-action-decision");
var coopActionQueue = require("./coop-action-queue");
var coopTopicLiveIndex = require("./coop-topic-live-index");
var coopTopicIndex = require("./coop-topic-index");
var coopTopicState = require("./coop-topic-state");
var coopWorkActivity = require("./coop-work-activity");
var coopSessionVisibility = require("./coop-session-visibility");
var coopSessionLedger = require("./coop-session-ledger");
var coopOwnerRequests = require("./coop-owner-requests");
var coopOwnerRequestBackfill = require("./coop-owner-request-backfill");
var coopControlRuntime = require("./coop-control-runtime");
var recoveryLog = require("./recovery-log");
var sessionsPersistence = require("./sessions-persistence");
var archiveCompletedCoopSession =
  require("./project-task-orchestrator-completion").archiveCompletedCoopSession;

// A startup recovery migration that fails closed is only reported through
// console.error, and in dev the daemon inherits the supervisor's stdio
// (bin/cli.js spawnDaemon) rather than writing daemon-dev.log. The failure
// therefore lands in ephemeral terminal scrollback and in no file at all,
// which is exactly where nobody looks. DIAGNOSTICS.md sends operators to the
// recovery canary first, so mirror the outcome there as well.
//
// Deduplicated per process on (migration, detail), exactly like
// recordStartupFailure below. A migration that fails closed on an immutable
// precondition reports the identical line on every boot and can never
// self-heal, so repeating it carries no new information while steadily evicting
// real recovery history from a 1MB-capped log that drops its older half when it
// trips. Short restart cycles made this the dominant writer, which is the worst
// possible failure mode for the file DIAGNOSTICS.md says to read first.
var reportedStartupMigrationFailures = {};
function recordStartupMigrationFailure(migration, detail) {
  var key = migration + "\u0000" + JSON.stringify(detail === undefined ? null : detail);
  if (reportedStartupMigrationFailures[key]) return;
  reportedStartupMigrationFailures[key] = true;
  recoveryLog.recordRecoveryEvent({
    kind: "coop_startup_migration",
    migration: migration,
    ok: false,
    detail: detail === undefined ? null : detail,
  });
}

// Boot/startup steps that fail closed but must not block boot. Same rationale
// as recordStartupMigrationFailure: console.error alone reaches no file the
// diagnostics protocol reads. Deduplicated per process because some callers
// (control-plane reconciliation) run on every projection build and a wedged
// step would otherwise flood the 1MB canary cap and evict real history.
var reportedStartupFailures = {};
function recordStartupFailure(stage, detail) {
  var key = stage + "\u0000" + JSON.stringify(detail === undefined ? null : detail);
  if (reportedStartupFailures[key]) return;
  reportedStartupFailures[key] = true;
  recoveryLog.recordRecoveryEvent({
    kind: "startup_failure",
    stage: stage,
    ok: false,
    detail: detail === undefined ? null : detail,
  });
}

function migrateLeadOwnerRequestHistory(extra, ctx) {
  if (!extra.isLead || !ctx.sm) return;
  var ledger = coopOwnerRequests.getDefaultOwnerRequests();
  var result = coopOwnerRequestBackfill.migrateOwnerRequestHistory(
    ledger, ctx.sm);
  if (!result.ok) {
    // Detail assembly lives next to the result shape it reads, in
    // coop-owner-request-backfill, so it stays unit-testable and cannot drift
    // from the two-layer {reason, migrations[].reason} contract again.
    var migrationDetail = coopOwnerRequestBackfill.describeMigrationFailure(result);
    console.error("[coop-owner-requests] startup migration failed closed:",
      JSON.stringify(migrationDetail));
    recordStartupMigrationFailure("coop-owner-requests", migrationDetail);
  }
  // The coop-recovered-thread-admission family that used to run here is retired.
  // Its four repairs (Voice ingresses 360-362, Threads 371, Urban Stay autolaunch
  // 406, Urban Stay policy 409) are durably applied in the owner-request ledger
  // and the Topic index, and their pinned absolute event indices (166989..178408)
  // died when cf7f197ee1 coalesced the canonical transcript to ~38k items. See
  // memory/2026-08-19-recovered-thread-admission-retirement.md.
}

var { CONFIG_DIR } = require("./config");
var { provisionLinuxUser } = require("./os-users");

var pkg = require("../package.json");

var publicDir = path.join(__dirname, "public");
var bundledThemesDir = path.join(__dirname, "themes");
var userThemesDir = path.join(CONFIG_DIR, "themes");
var httpGetBinary = serverStatic.httpGetBinary;
var serveStatic = serverStatic.createStaticHandler(publicDir);

var generateAuthToken = serverAuth.generateAuthToken;
var verifyPin = serverAuth.verifyPin;
var isDashboardOriginAllowed = require("./dashboard-cors").isDashboardOriginAllowed;

/**
 * Extract slug from URL path: /p/{slug}/... → slug
 * Returns null if path doesn't match /p/{slug}
 */
function extractSlug(urlPath) {
  var match = urlPath.match(/^\/p\/([a-z0-9_-]+)(\/|$)/);
  return match ? match[1] : null;
}

/**
 * Strip the /p/{slug} prefix from URL path
 */
function stripPrefix(urlPath, slug) {
  var prefix = "/p/" + slug;
  var rest = urlPath.substring(prefix.length);
  return rest || "/";
}

// The durable execution bindings that count as linked work for ONE topic.
//
// FAIL CLOSED, in this layer, on every ref that cannot name a live lens:
//   - a merged topic is no longer a lens of its own, so it contributes nothing
//     rather than having its work re-attributed to the merge target;
//   - a binding is matched on the EXACT topic id, so a ref naming a topic that
//     does not exist (or no ref at all) is never absorbed into a guessed topic;
//   - forward-only: a binding without a ref stays unattributed. Nothing here
//     infers or backfills one for the historical bindings.
// Pure and module-scoped so the rule is testable without booting a daemon.
function sessionExecutionStatus(binding, session) {
  if (!session) return "";
  var execution = session.orchestrationPolicy && session.orchestrationPolicy.portfolioExecution || {};
  var status = String(execution.status || "");
  if (binding && binding.mode === "project_coordinator") {
    var completion = session.orchestrationProjectCompletion;
    if (completion && completion.status === "completed") return "completed";
    var tasks = Array.isArray(session.orchestrationTasks) ? session.orchestrationTasks : [];
    var attention = false;
    var reviewing = false;
    for (var i = 0; i < tasks.length; i++) {
      var taskStatus = String(tasks[i] && tasks[i].status || "");
      if (taskStatus === "waiting_user" || taskStatus === "needs_input" ||
          taskStatus === "blocked" || taskStatus === "failed") attention = true;
      else if (taskStatus === "reviewing") reviewing = true;
    }
    if (attention) return "needs_input";
    if (reviewing) return "reviewing";
  }
  return status;
}

function coopTopicLinkedBindings(bindings, topicRef, metadata, resolveSession) {
  var wanted = String(topicRef && (topicRef.topicId || topicRef.topicKey ||
    topicRef.id || topicRef.key) || "").trim();
  if (!wanted) return [];
  if (!metadata || metadata.status === "merged") return [];
  var list = Array.isArray(bindings) ? bindings : [];
  var linked = [];
  for (var i = 0; i < list.length; i++) {
    var binding = list[i];
    var ref = binding && binding.coopTopicRef;
    var topicId = ref ? String(ref.topicId || "").trim() : "";
    if (!topicId || topicId !== wanted) continue;
    if (typeof resolveSession !== "function") {
      linked.push(binding);
      continue;
    }
    var session = resolveSession(binding);
    // A binding is durable attribution, not proof of live work. If its project
    // session is hidden, missing, or inaccessible, it cannot keep the topic in
    // a nonterminal state on this viewer's projection.
    if (!session || session.hidden) continue;
    var status = sessionExecutionStatus(binding, session);
    linked.push(status ? Object.assign({}, binding, { status: status }) : binding);
  }
  return linked;
}

/**
 * Create a multi-project server.
 * opts: { tlsOptions, caPath, pinHash, port, debug, dangerouslySkipPermissions, fullAutoMode }
 */
function createServer(opts) {
  var tlsOptions = opts.tlsOptions || null;
  var caPath = opts.caPath || null;
  var pinHash = opts.pinHash || null;
  var portNum = opts.port || 2633;
  var debug = opts.debug || false;
  var dangerouslySkipPermissions = opts.dangerouslySkipPermissions || false;
  var fullAutoMode = opts.fullAutoMode || false;
  var osUsers = opts.osUsers || false;
  var liveUiRegistry = createLiveUiRegistry();
  var lanHost = opts.lanHost || null;
  var onAddProject = opts.onAddProject || null;
  var onCreateProject = opts.onCreateProject || null;
  var onCloneProject = opts.onCloneProject || null;
  var onRemoveProject = opts.onRemoveProject || null;
  var onReorderProjects = opts.onReorderProjects || null;
  var onSetProjectTitle = opts.onSetProjectTitle || null;
  var onSetProjectIcon = opts.onSetProjectIcon || null;
  var onListGitAccounts = opts.onListGitAccounts || null;
  var onGetProjectGitAccount = opts.onGetProjectGitAccount || null;
  var onSetProjectGitAccount = opts.onSetProjectGitAccount || null;
  var onProjectOwnerChanged = opts.onProjectOwnerChanged || null;
  var onGetServerDefaultEffort = opts.onGetServerDefaultEffort || null;
  var onSetServerDefaultEffort = opts.onSetServerDefaultEffort || null;
  var onGetProjectDefaultEffort = opts.onGetProjectDefaultEffort || null;
  var onSetProjectDefaultEffort = opts.onSetProjectDefaultEffort || null;
  var onGetServerDefaultModel = opts.onGetServerDefaultModel || null;
  var onSetServerDefaultModel = opts.onSetServerDefaultModel || null;
  var onGetServerCodexDefaults = opts.onGetServerCodexDefaults || null;
  var onSetServerCodexDefaults = opts.onSetServerCodexDefaults || null;
  var onGetProjectDefaultModel = opts.onGetProjectDefaultModel || null;
  var onSetProjectDefaultModel = opts.onSetProjectDefaultModel || null;
  var onGetProjectAutoContinueComparable = opts.onGetProjectAutoContinueComparable || null;
  var onSetProjectAutoContinueComparable = opts.onSetProjectAutoContinueComparable || null;
  var onGetProjectCodexDefaults = opts.onGetProjectCodexDefaults || null;
  var onSetProjectCodexDefaults = opts.onSetProjectCodexDefaults || null;
  var onGetServerDefaultMode = opts.onGetServerDefaultMode || null;
  var onSetServerDefaultMode = opts.onSetServerDefaultMode || null;
  var onGetProjectDefaultMode = opts.onGetProjectDefaultMode || null;
  var onSetProjectDefaultMode = opts.onSetProjectDefaultMode || null;
  var onGetProjectLastVendor = opts.onGetProjectLastVendor || null;
  var onSetProjectLastVendor = opts.onSetProjectLastVendor || null;
  var onGetProjectMcpServers = opts.onGetProjectMcpServers || null;
  var onSetProjectMcpServers = opts.onSetProjectMcpServers || null;
  var onGetDaemonConfig = opts.onGetDaemonConfig || null;
  var onSetPin = opts.onSetPin || null;
  var onSetKeepAwake = opts.onSetKeepAwake || null;
  var onSetInheritGroups = opts.onSetInheritGroups || null;
  var onSetImageRetention = opts.onSetImageRetention || null;
  var onShutdown = opts.onShutdown || null;
  var onRestart = opts.onRestart || null;
  var onSetUpdateChannel = opts.onSetUpdateChannel || null;
  var onUpgradePin = opts.onUpgradePin || null;
  var onSetProjectVisibility = opts.onSetProjectVisibility || null;
  var onSetProjectAllowedUsers = opts.onSetProjectAllowedUsers || null;
  var onGetProjectAccess = opts.onGetProjectAccess || null;
  var onCreateWorktree = opts.onCreateWorktree || null;
  var onUserProvisioned = opts.onUserProvisioned || null;
  var onUserDeleted = opts.onUserDeleted || null;
  var getRemovedProjects = opts.getRemovedProjects || function () { return []; };

  // --- Auth module ---
  var auth = serverAuth.attachAuth({
    users: users,
    smtp: smtp,
    pages: pages,
    tlsOptions: tlsOptions,
    osUsers: osUsers,
    pinHash: pinHash,
    provisionLinuxUser: provisionLinuxUser,
    onUpgradePin: onUpgradePin,
    onUserProvisioned: onUserProvisioned,
  });
  var getMultiUserFromReq = auth.getMultiUserFromReq;
  var isRequestAuthed = auth.isRequestAuthed;
  var parseCookies = auth.parseCookies;

  var realVersion = require("../package.json").version;
  var currentVersion = debug ? "0.0.9" : realVersion;

  serverTuiHooks.installTuiHooks({
    tlsOptions: tlsOptions,
    portNum: portNum,
    osUsers: osUsers,
    users: users,
    debug: debug,
  });

  var caContent = caPath ? (function () { try { return fs.readFileSync(caPath); } catch (e) { return null; } })() : null;

  // --- Project registry ---
  var projects = new Map(); // slug → projectContext
  var coopExecutionControl = coopControlRuntime.getExecutionControl();
  var coopStartupRecovery = coopControlRuntime.getStartupRecovery();
  var crossProject = serverCrossProject.createCrossProjectRouter({
    coopExecutionControl: coopExecutionControl,
    coopStartupRecovery: coopStartupRecovery,
    // Execution authorization was previously an implicit default-allow when no
    // canCreateExecution policy was supplied. Make the openness explicit: the
    // router now denies without either a policy callback or this flag. The
    // effective production policy is unchanged (Lead-sourced, non-Lead-target
    // executions are permitted) but it is now greppable and deliberate.
    allowLeadSourcedExecution: true,
    getProjectContext: function (slug) { return projects.get(slug) || null; },
    // Enforces one canonical coordinator per (TopicRef, ProjectRef) at the
    // staffing path: the binding store only guarantees one active binding per
    // portfolio TASK, so a follow-up under a new task id could otherwise staff
    // a rival coordinator for a topic already being worked.
    ownerRequests: coopOwnerRequests.getDefaultOwnerRequests(),
    requireOwnerImplementationDecision: true,
    onThreadHandedOff: function (input) {
      return coopTopicIndex.getDefaultTopicIndex().linkExecution(input.topicRef, {
        projectRef: input.projectRef, sessionRef: input.sessionRef,
      });
    },
  });

  // --- Admin module ---
  var admin = serverAdmin.attachAdmin({
    users: users,
    smtp: smtp,
    getMultiUserFromReq: getMultiUserFromReq,
    projects: projects,
    osUsers: osUsers,
    tlsOptions: tlsOptions,
    portNum: portNum,
    provisionLinuxUser: provisionLinuxUser,
    onUserProvisioned: onUserProvisioned,
    onUserDeleted: onUserDeleted,
    revokeUserTokens: auth.revokeUserTokens,
    onSetProjectVisibility: onSetProjectVisibility,
    onSetProjectAllowedUsers: onSetProjectAllowedUsers,
    onGetProjectAccess: onGetProjectAccess,
    onProjectOwnerChanged: onProjectOwnerChanged,
  });

  var skills = serverSkills.attachSkills({
    users: users,
    osUsers: osUsers,
    getMultiUserFromReq: getMultiUserFromReq,
  });

  var settings = serverSettings.attachSettings({
    users: users,
    mates: mates,
    getMultiUserFromReq: getMultiUserFromReq,
    projects: projects,
    opts: opts,
    CONFIG_DIR: CONFIG_DIR,
  });

  var palette = serverPalette.attachPalette({
    users: users,
    projects: projects,
    getMultiUserFromReq: getMultiUserFromReq,
    onGetProjectAccess: onGetProjectAccess,
  });

  // --- Push module (global) ---
  var pushModule = null;
  try {
    var { initPush } = require("./push");
    pushModule = initPush();
  } catch (e) {}

  // --- Notifications module (global singleton, shared by all projects) ---
  var { attachNotifications: _attachNotifications } = require("./project-notifications");
  var _globalNotifications = _attachNotifications({
    broadcastAll: function (msg) { broadcastAll(msg); },
    sendToUser: function (userId, msg) { sendToUser(userId, msg); },
    pushModule: pushModule,
  });

  // --- Security headers ---
  var securityHeaders = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://esm.sh; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; img-src * data: blob:; connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://esm.sh https://api.dicebear.com https://api.open-meteo.com https://ipapi.co; font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net;",
  };
  if (tlsOptions) {
    securityHeaders["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }

  function setSecurityHeaders(res) {
    var keys = Object.keys(securityHeaders);
    for (var i = 0; i < keys.length; i++) {
      res.setHeader(keys[i], securityHeaders[keys[i]]);
    }
  }

  // --- HTTP handler ---
  var appHandler = function (req, res) {
    setSecurityHeaders(res);
    var fullUrl = req.url.split("?")[0];

    // --- Auth routes (delegated to server-auth) ---
    if (auth.handleRequest(req, res, fullUrl)) return;
    // CA certificate download
    if (req.url === "/ca/download" && req.method === "GET" && caContent) {
      res.writeHead(200, {
        "Content-Type": "application/x-pem-file",
        "Content-Disposition": 'attachment; filename="clay-ca.pem"',
      });
      res.end(caContent);
      return;
    }

    // Chrome extension download (proxy from GitHub)
    if (fullUrl === "/api/extension/download" && req.method === "GET") {
      if (!isRequestAuthed(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
      var archiveUrl = "https://github.com/chadbyte/clay-chrome/archive/refs/heads/main.zip";
      httpGetBinary(archiveUrl).then(function (buf) {
        res.writeHead(200, {
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="clay-chrome-extension.zip"',
          "Content-Length": buf.length,
        });
        res.end(buf);
      }).catch(function (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to download extension: " + (err.message || "unknown error") }));
      });
      return;
    }

    // Claude TUI notification webhook. Called by claude's Notification
    // hook (one shared hook lives in ~/.claude/settings.json across all
    // projects), so this route must sit at the top level and search every
    // project's session manager for the cliSessionId. Localhost only.
    if (req.method === "POST" && fullUrl === "/api/tui-notify") {
      var tnRemote = req.socket && req.socket.remoteAddress;
      var tnLocal = tnRemote === "127.0.0.1" || tnRemote === "::1" || tnRemote === "::ffff:127.0.0.1";
      if (!tnLocal) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"localhost only"}');
        return;
      }
      var tnBody = "";
      req.on("data", function (chunk) { tnBody += chunk; });
      req.on("end", function () {
        var data = null;
        try { data = JSON.parse(tnBody); } catch (e) {}
        console.log("[tui-notify] hit, session_id=" + (data && data.session_id) + " message=" + JSON.stringify((data && data.message) || "").slice(0, 100));
        if (!data || !data.session_id) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end('{"error":"missing session_id"}');
          return;
        }
        var cliSid = data.session_id;
        var message = data.message || "";
        var matchedCtx = null;
        var matchedLocalId = null;
        var matchedTerminalId = null;
        var matchedSessionTitle = "";
        var matchedOwnerId = null;
        projects.forEach(function (pctx, pslug) {
          if (matchedCtx) return;
          if (!pctx || !pctx.sm || !pctx.sm.sessions) return;
          pctx.sm.sessions.forEach(function (s) {
            if (matchedCtx) return;
            if (s.cliSessionId !== cliSid) return;
            if (shouldSuppressDetachedAdoptedSession(s)) return;
            if (s.mode === "tui" || s.runtimeMode === "tui") {
              matchedCtx = pctx;
              matchedLocalId = s.localId;
              matchedTerminalId = (typeof s.runtimeTerminalId === "number")
                ? s.runtimeTerminalId
                : (typeof s.terminalId === "number" ? s.terminalId : null);
              matchedSessionTitle = s.title || "";
              matchedOwnerId = s.ownerId || null;
            }
          });
        });
        if (!matchedCtx) {
          // Not a Clay-owned TUI session (e.g. a standalone `claude`
          // invocation in some unrelated terminal). Drop silently.
          console.log("[tui-notify] no matching Clay TUI session for " + (data && data.session_id));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true,"ignored":true}');
          return;
        }
        console.log("[tui-notify] matched localId=" + matchedLocalId + " terminalId=" + matchedTerminalId + " project=" + matchedCtx.slug + " ownerId=" + (matchedOwnerId || "(none)") + " -> notification center");
        // Funnel through the existing notification center so the alert
        // lives in the same place every other Clay notification does
        // (sidebar bell, banner, persistence). The notify() API handles
        // sendToUser vs broadcastAll routing based on ownerId/targetUserId.
        try {
          _globalNotifications.notify("tui_attention", {
            slug: matchedCtx.slug,
            sessionId: matchedLocalId,
            ownerId: matchedOwnerId,
            targetUserId: matchedOwnerId, // multi-user: deliver to session owner only
            title: data.title || "Claude needs your attention",
            body: message,
            terminalId: matchedTerminalId,
            sessionTitle: matchedSessionTitle,
            cliSessionId: cliSid,
          });
        } catch (e) {}
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }

    // CORS preflight for cross-origin requests (HTTP onboarding → HTTPS)
    if (req.method === "OPTIONS") {
      if (/^\/p\/[^/]+\/api\/task-(launch|dashboard-state)$/.test(req.url.split("?")[0])) {
        var taskOrigin = req.headers.origin || "";
        var taskHeaders = {
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        };
        if (isDashboardOriginAllowed(req, taskOrigin)) {
          taskHeaders["Access-Control-Allow-Origin"] = taskOrigin;
          taskHeaders["Access-Control-Allow-Credentials"] = "true";
        }
        res.writeHead(204, taskHeaders);
        res.end();
        return;
      }
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    // Setup page
    if (fullUrl === "/setup" && req.method === "GET") {
      var host = req.headers.host || "localhost";
      var hostname = host.split(":")[0];
      var protocol = tlsOptions ? "https" : "http";
      var setupUrl = protocol + "://" + hostname + ":" + portNum;
      var lanMode = /[?&]mode=lan/.test(req.url);
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(pages.setupPageHtml(setupUrl, setupUrl, !!caContent, lanMode));
      return;
    }

    // PWA install guide (builtin cert mode, no CA step needed)
    if (fullUrl === "/pwa" && req.method === "GET") {
      var host = req.headers.host || "localhost";
      var hostname = host.split(":")[0];
      var protocol = tlsOptions ? "https" : "http";
      var pwaUrl = protocol + "://" + hostname + ":" + portNum;
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
      });
      res.end(pages.setupPageHtml(pwaUrl, pwaUrl, false, true));
      return;
    }

    // Global push endpoints (used by setup page)
    if (req.method === "GET" && fullUrl === "/api/vapid-public-key" && pushModule) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ publicKey: pushModule.publicKey }));
      return;
    }

    if (req.method === "POST" && fullUrl === "/api/push-subscribe" && pushModule) {
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var parsed = JSON.parse(body);
          var sub = parsed.subscription || parsed;
          var _httpPushUser = getMultiUserFromReq(req);
          pushModule.addSubscription(sub, parsed.replaceEndpoint, _httpPushUser ? _httpPushUser.id : null);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (e) {
          res.writeHead(400);
          res.end("Bad request");
        }
      });
      return;
    }

    // Health check endpoint
    // Unauthenticated: minimal liveness info only
    // Authenticated: full system details (memory, pid, version, sessions)
    if (req.method === "GET" && fullUrl === "/api/health") {
      var health = {
        status: "ok",
        timestamp: new Date().toISOString(),
      };
      if (isRequestAuthed(req)) {
        var mem = process.memoryUsage();
        var activeSessions = 0;
        projects.forEach(function (ctx) {
          if (ctx && ctx.clients) {
            activeSessions += ctx.clients.size || 0;
          }
        });
        health.uptime = process.uptime();
        health.version = pkg.version;
        health.node = process.version;
        health.sessions = activeSessions;
        health.projects = projects.size;
        health.memory = {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
        };
        health.pid = process.pid;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(health));
      return;
    }

    // Theme list: bundled (lib/themes/) + user (~/.clay/themes/)
    if (req.method === "GET" && fullUrl === "/api/themes") {
      var bundled = {};
      var custom = {};
      // Read bundled themes
      try {
        var bFiles = fs.readdirSync(bundledThemesDir);
        for (var i = 0; i < bFiles.length; i++) {
          if (!bFiles[i].endsWith(".json")) continue;
          try {
            var raw = fs.readFileSync(path.join(bundledThemesDir, bFiles[i]), "utf8");
            var id = bFiles[i].replace(/\.json$/, "");
            bundled[id] = JSON.parse(raw);
          } catch (e) {}
        }
      } catch (e) {}
      // Read user themes (override bundled if same id)
      try {
        var uFiles = fs.readdirSync(userThemesDir);
        for (var j = 0; j < uFiles.length; j++) {
          if (!uFiles[j].endsWith(".json")) continue;
          try {
            var uRaw = fs.readFileSync(path.join(userThemesDir, uFiles[j]), "utf8");
            var uid = uFiles[j].replace(/\.json$/, "");
            custom[uid] = JSON.parse(uRaw);
          } catch (e) {}
        }
      } catch (e) {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ bundled: bundled, custom: custom }));
      return;
    }

    if (settings.handleRequest(req, res, fullUrl)) return;

    // --- Admin API endpoints (multi-user mode only) ---
    if (admin.handleRequest(req, res, fullUrl)) return;

    // --- Palette search (delegated to server-palette) ---
    if (palette.handleRequest(req, res, fullUrl)) return;

    // Multi-user info endpoint (who am I?)
    if (req.method === "GET" && fullUrl === "/api/me") {
      if (!users.isMultiUser()) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"multiUser":false}');
        return;
      }
      var mu = getMultiUserFromReq(req);
      if (!mu) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end('{"error":"unauthorized"}');
        return;
      }
      var meResp = { multiUser: true, smtpEnabled: smtp.isSmtpConfigured(), emailLoginEnabled: smtp.isEmailLoginEnabled(), user: { id: mu.id, username: mu.username, email: mu.email || null, displayName: mu.displayName, role: mu.role } };
      meResp.permissions = users.getEffectivePermissions(mu, osUsers);
      if (mu.mustChangePin) meResp.mustChangePin = true;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(meResp));
      return;
    }

    // --- Skills routes (delegated to server-skills) ---
    if (skills.handleRequest(req, res, fullUrl)) return;

    // Root path — redirect to first accessible project
    if (fullUrl === "/" && req.method === "GET") {
      if (!isRequestAuthed(req)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(auth.getAuthPage());
        return;
      }
      if (projects.size > 0) {
        var targetSlug = null;
        var reqUser = users.isMultiUser() ? getMultiUserFromReq(req) : null;
        // Check for last-visited project cookie
        var lastProject = parseCookies(req)["clay_last_project"];
        if (lastProject && projects.has(lastProject)) {
          if (reqUser && onGetProjectAccess) {
            var lpAccess = onGetProjectAccess(lastProject);
            if (lpAccess && !lpAccess.error && users.canAccessProject(reqUser.id, lpAccess)) {
              targetSlug = lastProject;
            }
          } else {
            targetSlug = lastProject;
          }
        }
        // Fall back to first accessible project
        if (!targetSlug) {
          projects.forEach(function (ctx, s) {
            if (targetSlug) return;
            if (reqUser && onGetProjectAccess) {
              var access = onGetProjectAccess(s);
              if (access && !access.error && users.canAccessProject(reqUser.id, access)) {
                targetSlug = s;
              }
            } else {
              targetSlug = s;
            }
          });
        }
        if (targetSlug) {
          res.writeHead(302, { "Location": "/p/" + targetSlug + "/" });
          res.end();
          return;
        }
      }
      // No accessible projects. Users who can create one fall through to
      // the regular app shell (index.html) — the slug-less /ws and the
      // sidebar's + button take over from there. The static "ask an admin"
      // page is only for multi-user users who genuinely can't do anything
      // (no createProject permission and no projects shared with them).
      if (users.isMultiUser()) {
        var rootUser = getMultiUserFromReq(req);
        var rootPerms = rootUser ? users.getEffectivePermissions(rootUser, osUsers) : null;
        if (!rootPerms || !rootPerms.createProject) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(pages.noProjectsPageHtml());
          return;
        }
      }
      if (serveStatic("/index.html", res, req)) return;
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("App shell missing.");
      return;
    }

    // Global info endpoint (projects only for authenticated requests)
    if (req.method === "GET" && req.url === "/info") {
      if (!isRequestAuthed(req)) {
        res.writeHead(401, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ version: currentVersion, authenticated: false }));
        return;
      }
      var projectList = [];
      projects.forEach(function (ctx, slug) {
        projectList.push({ slug: slug, project: ctx.project });
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ projects: projectList, version: currentVersion, authenticated: true }));
      return;
    }

    // Static files (favicon, manifest, icons, sw.js, mate avatars, etc.)
    if (!fullUrl.includes("..") && !fullUrl.startsWith("/p/") && !fullUrl.startsWith("/api/")) {
      if (serveStatic(fullUrl, res, req)) return;
    }

    // Project-scoped routes: /p/{slug}/...
    var slug = extractSlug(req.url.split("?")[0]);
    if (!slug) {
      // Not a project route and not handled above
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    var ctx = projects.get(slug);
    if (!ctx) {
      res.writeHead(302, { "Location": "/" });
      res.end();
      return;
    }

    // Redirect /p/{slug} → /p/{slug}/ (trailing slash required for relative paths)
    if (fullUrl === "/p/" + slug) {
      res.writeHead(301, { "Location": "/p/" + slug + "/" });
      res.end();
      return;
    }

    // Auth check for project routes
    // Bypass auth for MCP bridge endpoint (localhost only).
    // The mcp-bridge-server.js runs as a local child process and cannot carry cookies.
    var projectUrlForAuth = stripPrefix(req.url.split("?")[0], slug);
    // req.socket.remoteAddress may differ between HTTP/HTTPS (TLSSocket wraps net.Socket).
    // Also check req.connection.remoteAddress for compatibility.
    var remoteAddr = req.socket.remoteAddress
      || (req.connection && req.connection.remoteAddress)
      || "";
    var isLocalhost = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1";
    var isMcpBridgeLocal = projectUrlForAuth === "/api/mcp-bridge"
      && req.method === "POST"
      && isLocalhost;
    if (projectUrlForAuth === "/api/mcp-bridge") {
      console.log("[server] MCP bridge auth: method=" + req.method + " addr=" + remoteAddr + " bypass=" + isMcpBridgeLocal);
    }
    if (!isMcpBridgeLocal && !isRequestAuthed(req)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(auth.getAuthPage());
      return;
    }

    // Set last-visited project cookie for root redirect
    res.setHeader("Set-Cookie", "clay_last_project=" + slug + "; Path=/; SameSite=Strict; Max-Age=31536000" + (tlsOptions ? "; Secure" : ""));

    // Multi-user: check project access for HTTP requests
    if (users.isMultiUser() && onGetProjectAccess) {
      var httpUser = getMultiUserFromReq(req);
      if (httpUser) {
        var httpAccess = onGetProjectAccess(slug);
        if (httpAccess && !httpAccess.error && !users.canAccessProject(httpUser.id, httpAccess)) {
          res.writeHead(302, { "Location": "/" });
          res.end();
          return;
        }
      }
    }

    // Strip prefix for project-scoped handling
    var projectUrl = stripPrefix(req.url.split("?")[0], slug);
    // Re-attach query string for API routes
    var qsIdx = req.url.indexOf("?");
    var projectUrlWithQS = qsIdx >= 0 ? projectUrl + req.url.substring(qsIdx) : projectUrl;

    // Attach user info for project HTTP handler (OS-level isolation)
    if (users.isMultiUser()) {
      req._clayUser = getMultiUserFromReq(req);
    }

    // Try project HTTP handler first (APIs)
    var origUrl = req.url;
    req.url = projectUrlWithQS;
    var handled = ctx.handleHTTP(req, res, projectUrlWithQS);
    req.url = origUrl;
    if (handled) return;

    // Static files (same assets for all projects)
    if (req.method === "GET") {
      if (serveStatic(projectUrl, res, req)) return;
    }

    res.writeHead(404);
    res.end("Not found");
  };

  // --- Server setup ---
  var server;
  if (tlsOptions) {
    server = require("https").createServer(tlsOptions, appHandler);
  } else {
    server = http.createServer(appHandler);
  }

  // --- HTTP onboarding server (only when TLS is active) ---
  var onboardingServer = null;
  if (tlsOptions) {
    onboardingServer = http.createServer(function (req, res) {
      var url = req.url.split("?")[0];

      // CA certificate download
      if (url === "/ca/download" && req.method === "GET" && caContent) {
        res.writeHead(200, {
          "Content-Type": "application/x-pem-file",
          "Content-Disposition": 'attachment; filename="clay-ca.pem"',
        });
        res.end(caContent);
        return;
      }

      // Setup page
      if (url === "/setup" && req.method === "GET") {
        var host = req.headers.host || "localhost";
        var hostname = host.split(":")[0];
        var httpsSetupUrl = "https://" + hostname + ":" + portNum;
        var httpSetupUrl = "http://" + hostname + ":" + (portNum + 1);
        var lanMode = /[?&]mode=lan/.test(req.url);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pages.setupPageHtml(httpsSetupUrl, httpSetupUrl, !!caContent, lanMode));
        return;
      }

      // /info — CORS-enabled, used by setup page to verify HTTPS
      if (url === "/info" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ version: currentVersion }));
        return;
      }

      // Static files at root (favicon, manifest, icons, etc.)
      if (url.lastIndexOf("/") === 0 && !url.includes("..")) {
        if (serveStatic(url, res, req)) return;
      }

      // Everything else → redirect to HTTPS setup
      var hostname = (req.headers.host || "localhost").split(":")[0];
      res.writeHead(302, { "Location": "https://" + hostname + ":" + portNum + "/setup" });
      res.end();
    });
  }

  var socketTracker = serverSockets.createSocketTracker();
  socketTracker.trackServer(server);
  socketTracker.trackServer(onboardingServer);
  var destroySockets = socketTracker.destroySockets;

  // --- WebSocket ---
  var wss = new WebSocketServer({ noServer: true });

  var setupWsKeepalive = serverSockets.installWsKeepalive(wss, server);

  // Slug-less /ws handler: lets a user with no projects yet load the regular
  // app shell and create/add/clone their first one. Only knows about the
  // small set of bootstrap messages (browse_dir, add_project, create_project,
  // clone_project, ping).
  var globalWs = serverGlobalWs.attachGlobalWs({
    osUsers: osUsers,
    usersModule: users,
    onAddProject: onAddProject,
    onCreateProject: onCreateProject,
    onCloneProject: onCloneProject,
  });

  server.on("upgrade", function (req, socket, head) {
    // Origin validation (CSRF prevention)
    var origin = req.headers.origin;
    if (origin) {
      try {
        var originUrl = new URL(origin);
        var originPort = String(originUrl.port || (originUrl.protocol === "https:" ? "443" : "80"));
        // Extract port from Host header for reverse proxy support.
        // Use URL parser to correctly handle IPv6 addresses (e.g. [::1])
        // and infer default port from origin protocol (not backend tlsOptions)
        // so TLS-terminating proxies on :443 with HTTP backends work.
        var hostPort;
        try {
          var hostUrl = new URL(originUrl.protocol + "//" + (req.headers.host || ""));
          hostPort = String(hostUrl.port || (originUrl.protocol === "https:" ? "443" : "80"));
        } catch (e2) {
          hostPort = String(portNum);
        }
        if (originPort !== String(portNum) && originPort !== hostPort) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
      } catch (e) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    if (!isRequestAuthed(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // Extract slug from WS URL: /p/{slug}/ws
    var wsSlug = extractSlug(req.url);
    if (!wsSlug) {
      // Slug-less /ws: bootstrap channel for a client that hasn't entered
      // any project yet (no projects exist, or none accessible to this user
      // but they can still create one). Anything other than exactly /ws is
      // rejected.
      if (req.url !== "/ws") {
        socket.destroy();
        return;
      }
      var globalUser = users.isMultiUser() ? getMultiUserFromReq(req) : null;
      wss.handleUpgrade(req, socket, head, function (ws) {
        setupWsKeepalive(ws);
        globalWs.handleConnection(ws, globalUser);
      });
      return;
    }

    var ctx = projects.get(wsSlug);
    if (!ctx) {
      if (debug) console.log("[server] WS rejected: project not found for slug", wsSlug);
      socket.destroy();
      return;
    }

    // Attach user info to the WS connection for multi-user filtering
    var wsUser = null;
    if (users.isMultiUser()) {
      wsUser = getMultiUserFromReq(req);
      // Check project access for multi-user mode
      if (wsUser && onGetProjectAccess) {
        // For worktree projects, inherit access from parent
        var accessSlug = (wsSlug.indexOf("--") !== -1) ? wsSlug.split("--")[0] : wsSlug;
        var projectAccess = onGetProjectAccess(accessSlug);
        if (debug) console.log("[server] WS access check:", wsSlug, "user:", wsUser.id, "role:", wsUser.role, "visibility:", projectAccess && projectAccess.visibility, "ownerId:", projectAccess && projectAccess.ownerId, "allowed:", projectAccess && projectAccess.allowedUsers);
        if (projectAccess && !projectAccess.error) {
          if (!users.canAccessProject(wsUser.id, projectAccess)) {
            if (debug) console.log("[server] WS rejected: access denied for", wsUser.id, "on", wsSlug);
            socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
            socket.destroy();
            return;
          }
        }
      }
    }

    wss.handleUpgrade(req, socket, head, function (ws) {
      setupWsKeepalive(ws);
      // Apply rate limiting to WS messages
      var msgCount = 0;
      var msgWindowStart = Date.now();
      var WS_RATE_LIMIT = 60; // messages per second
      var origEmit = ws.emit;
      ws.emit = function (event) {
        if (event === "message") {
          var now = Date.now();
          if (now - msgWindowStart >= 1000) {
            msgCount = 0;
            msgWindowStart = now;
          }
          msgCount++;
          if (msgCount > WS_RATE_LIMIT) {
            try {
              ws.send(JSON.stringify({ type: "error", message: "Rate limit exceeded. Connection will be closed." }));
              ws.close(1008, "Rate limit exceeded");
            } catch (e) {}
            return false;
          }
        }
        return origEmit.apply(ws, arguments);
      };
      ws._clayUser = wsUser; // attach user context
      try {
        var wsUrl = new URL(req.url, "http://localhost");
        ws._clayRequestedSessionId = wsUrl.searchParams.get("sessionId") || null;
        ws._clayRequestedSessionExact = wsUrl.searchParams.get("sessionExact") === "1";
      } catch (e) {
        ws._clayRequestedSessionId = null;
        ws._clayRequestedSessionExact = false;
      }
      var remoteAddr = req.socket.remoteAddress || "";
      ws._clayLocal = (remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "::ffff:127.0.0.1");
      // Clear cross-project unread for this project when client connects
      var unreadMap = getCrossProjectUnread(ws);
      if (unreadMap[wsSlug]) {
        unreadMap[wsSlug] = 0;
      }
      ctx.handleConnection(ws, wsUser);
      // Tear down the home-chat subscription (if any) on socket close so
      // we don't leak callbacks against Clay's session manager.
      ws.on("close", function () {
        try { clayHomeHandler.handleDisconnection(ws); } catch (e) {}
      });
    });
  });

  // --- Cross-project unread tracking ---
  // WeakMap<ws, { slug: count }> tracks how many done events happened in other projects
  var crossProjectUnread = new WeakMap();

  function getCrossProjectUnread(ws) {
    var map = crossProjectUnread.get(ws);
    if (!map) { map = {}; crossProjectUnread.set(ws, map); }
    return map;
  }

  // The one canonical Coop session owns both the orchestration tasks and the
  // foreground processing flag that topic state is derived from.
  function canonicalCoopSessionForState() {
    var lead = projects.get("lead");
    // The project context exposes its session manager, not a session list;
    // the previous getSessions() probe matched nothing, silently returned
    // null, and blanked every computed topic state downstream.
    var manager = lead && typeof lead.getSessionManager === "function"
      ? lead.getSessionManager() : null;
    var sessions = manager && manager.sessions;
    var found = null;
    if (sessions && typeof sessions.forEach === "function") {
      sessions.forEach(function (session) {
        if (!found && session && session.coopHome) found = session;
      });
    }
    return found;
  }

  // Being connected to the Coop project is NOT the same as being its owner.
  // isCoopClient() only checks the slug, so in multi-user mode any admin with
  // project access reached the decision route and could act on the owner's
  // behalf. Owner-facing decisions require the connected identity to match the
  // canonical Coop session's owner; target ACLs are applied on top, not instead.
  function connectedUserIsCoopOwner(ws) {
    // Single-user daemons have no second identity to distinguish, so whoever is
    // connected IS the owner. Checking the canonical session first would fail
    // closed whenever the Lead project has not been warmed yet, which withholds
    // the owner's own queue from them for a reason that has nothing to do with
    // authority.
    if (!users.isMultiUser()) return true;
    var home = canonicalCoopSessionForState();
    // Multi-user and no resolvable canonical session: ownership cannot be
    // established, so fail closed.
    if (!home) return false;
    return coopTopicLiveIndex.isCanonicalOwner(ws, home, true);
  }

  function currentCoopTopicLinks() {
    try {
      return coopSessionLedger.topicLinksFromIndex(
        coopTopicIndex.getDefaultTopicIndex().load());
    } catch (e) {
      return [];
    }
  }

  function queryCoopSessions(input) {
    if (!crossProject || typeof crossProject.queryCoopSessions !== "function") {
      return { ok: false, reason: "session_ledger_unavailable", sessions: [] };
    }
    return crossProject.queryCoopSessions(Object.assign({}, input || {}, {
      topicLinks: currentCoopTopicLinks(),
    }));
  }

  function ledgerTopicBindings(topicRef, metadata, ws) {
    if (!crossProject || typeof crossProject.topicSessionEvidence !== "function") return [];
    var entries = crossProject.topicSessionEvidence(topicRef, metadata, {
      topicLinks: currentCoopTopicLinks(),
    });
    var linked = [];
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      var project = projectReferenceResolver.resolveProjectRef(entry.projectRef, ws);
      if (!project || !project.ok) continue;
      if (entry.sessionPresent && !entry.hidden) {
        var session = projectReferenceResolver.resolveSessionRef(entry.sessionRef, ws);
        if (!session || !session.ok) continue;
      }
      linked.push({
        coopTopicRef: entry.coopTopicRef,
        status: entry.workState === "done" ? "completed" :
          (entry.workState === "working" ? "running" : "needs_input"),
        sessionRef: entry.sessionRef,
      });
    }
    return linked;
  }

  // A topic close is the owner-controlled archival edge: only a completed,
  // Coop-created linked execution is eligible. The shared auto-archive gate
  // rejects owner-created direct sessions and preserves the coordinator's
  // descendant cleanup behavior.
  function archiveCompletedCoopTopicSessions(topicRef, topic, ws) {
    if (!crossProject || typeof crossProject.topicCleanupCandidates !== "function") return;
    var candidates = crossProject.topicCleanupCandidates(topicRef, {
      topicLinks: currentCoopTopicLinks(),
    });
    for (var i = 0; i < candidates.length; i++) {
      var ref = candidates[i].sessionRef;
      var resolved = projectReferenceResolver.resolveSessionRef(ref, ws);
      if (!resolved || !resolved.ok || !resolved.project || !resolved.session) continue;
      var manager = typeof resolved.project.getSessionManager === "function" ?
        resolved.project.getSessionManager() : null;
      archiveCompletedCoopSession(manager, resolved.session, { explicit: true });
    }
    if (typeof crossProject.reconcileSessionLedger === "function") {
      crossProject.reconcileSessionLedger({ topicLinks: currentCoopTopicLinks() });
    }
  }

  function globalCoopProjectionFor(ws) {
    var coopSession = canonicalCoopSessionForState();
    return globalCoopProjection.buildGlobalCoopProjection({
      projects: projects,
      actor: ws,
      ensureControlPlane: function (input) {
        var controlProjects = Array.isArray(input.projects) ? input.projects : [];
        for (var cpi = 0; cpi < controlProjects.length; cpi++) {
          (function (item) {
            item.migrateBinding = function (from, to) {
              if (!crossProject || typeof crossProject.rebindProjectCoordinator !== "function") {
                return { ok: false, reason: "binding_migration_unavailable" };
              }
              var requestLedger = coopOwnerRequests.getDefaultOwnerRequests();
              var claims = requestLedger && typeof requestLedger.listCoordinators === "function" ?
                requestLedger.listCoordinators() : [];
              for (var cli = 0; cli < claims.length; cli++) {
                var claim = claims[cli];
                if (!claim || claim.projectId !== item.projectRef.projectId ||
                    !claim.coordinator || claim.coordinator.projectId !== from.projectId ||
                    claim.coordinator.sessionStorageId !== from.sessionStorageId) continue;
                var transferred = requestLedger.transferCoordinator({
                  topicRef: { topicId: claim.topicId }, projectRef: item.projectRef,
                  from: from, to: to, reason: "coop_control_plane_migration",
                });
                if (!transferred || transferred.ok !== true) return transferred;
                break;
              }
              return crossProject.rebindProjectCoordinator(item.projectRef, from, to);
            };
          })(controlProjects[cpi]);
        }
        var result = coopControlPlane.ensureControlPlane(input.leadManager, controlProjects);
        if (!result.ok) {
          // Previously inspected by nobody: coordinators/Council/Triage were
          // silently never ensured and the UI rendered a plausible empty
          // dashboard. Deduplicated because this runs per projection build.
          recordStartupFailure("coop_control_plane_ensure",
            result.reason || result.code || null);
        }
        if (result.ok && result.changed && input.leadManager &&
            typeof input.leadManager.broadcastSessionList === "function") {
          input.leadManager.broadcastSessionList();
        }
        if (result.ok && result.migrations && result.migrations.length) {
          for (var mpi = 0; mpi < controlProjects.length; mpi++) {
            var manager = controlProjects[mpi] && controlProjects[mpi].manager;
            if (manager && typeof manager.broadcastSessionList === "function") {
              manager.broadcastSessionList();
            }
          }
        }
        return result;
      },
      // The queue is the owner's personal decision list; a non-owner viewer of
      // the Coop project must not be shown work that is blocked on the owner.
      includeActionQueue: connectedUserIsCoopOwner(ws),
      canAccessProject: canAccessProjectRef,
      canAccessSession: canAccessSessionRef,
      canAccessArchivedSession: canAccessArchivedSessionRef,
      reconcileDismissedSession: coopSessionVisibility.hideDismissedSession,
      portfolioBindings: crossProject && typeof crossProject.getExecutionBindings === "function" ?
        crossProject.getExecutionBindings() : [],
      // Real per-topic state from canonical linked work. This seam existed and
      // was never supplied, which is why every topic rendered the same
      // "Active" -- a label equal to "not closed", and therefore true of every
      // topic that reaches the client.
      computeCoopTopicState: function (topicRef, metadata) {
        if (!coopSession) return {};
        return coopTopicState.projectedTopicState(topicRef, {
          tasks: coopSession.orchestrationTasks,
          // Binding-carried refs count as linked work too, so a topic linked
          // only through a cross-project execution is not read as unlinked.
          bindings: ledgerTopicBindings(topicRef, metadata, ws),
          // Durable per-topic evidence: lifecycle status (an explicit close is
          // Done) and the owner-disposition record from the backfill or an
          // explicit owner decision.
          metadata: metadata || null,
          foreground: {
            isProcessing: !!coopSession.isProcessing,
            topicRef: (coopWorkActivity.latestCoopRoute(coopSession) || {}).topicRef || null,
          },
        });
      },
      unreadForSession: function (actor, project, session) {
        var unread = actor && actor._clayUnread;
        return unread && unread[session.localId] || 0;
      },
    });
  }

  function refreshCanonicalCoopTopics(session) {
    if (!session || !session.coopHome) return null;
    var lead = projects.get("lead");
    if (!lead || typeof lead.forEachClient !== "function") return null;
    return coopTopicLiveIndex.refreshCanonicalCoopTopics({
      session: session,
      multiUser: users.isMultiUser(),
      advance: function (canonicalSession) {
        return globalCoopProjection.advanceCanonicalCoopTopics({ projects: projects }, canonicalSession);
      },
      forEachClient: lead.forEachClient,
      projectionFor: globalCoopProjectionFor,
      sendTo: lead.sendTo,
    });
  }

  function refreshGlobalCoopViewers() {
    var session = canonicalCoopSessionForState();
    var lead = projects.get("lead");
    if (!session || !lead || typeof lead.forEachClient !== "function") return;
    coopTopicLiveIndex.refreshGlobalCoopProjection({
      session: session,
      multiUser: users.isMultiUser(),
      forEachClient: lead.forEachClient,
      projectionFor: globalCoopProjectionFor,
      sendTo: lead.sendTo,
    });
  }

  // After an owner decision the deciding client is not the only viewer whose
  // queue is now wrong; push a fresh projection to every Coop client.
  function refreshCoopActionQueues() {
    var refreshed = refreshCanonicalCoopTopics(canonicalCoopSessionForState());
    if (!refreshed || !refreshed.changed) refreshGlobalCoopViewers();
  }

  function onSessionDone(sourceSlug, session) {
    // Increment unread for all clients NOT connected to sourceSlug
    projects.forEach(function (ctx, projSlug) {
      if (projSlug === sourceSlug) return;
      ctx.forEachClient(function (ws) {
        var map = getCrossProjectUnread(ws);
        map[sourceSlug] = (map[sourceSlug] || 0) + 1;
      });
    });
    // Trigger a projects_updated broadcast so clients get updated unread counts
    broadcastProcessingChange();
    if (crossProject && typeof crossProject.reconcileSessionLedger === "function") {
      crossProject.reconcileSessionLedger({ topicLinks: currentCoopTopicLinks() });
    }
    if (sourceSlug === "lead") refreshCanonicalCoopTopics(session);
  }

  // --- Debounced broadcast for processing status changes ---
  var processingUpdateTimer = null;
  function broadcastProcessingChange() {
    if (processingUpdateTimer) clearTimeout(processingUpdateTimer);
    processingUpdateTimer = setTimeout(function () {
      processingUpdateTimer = null;
      var allProjectsList = getProjects();
      // Always send per-client to include cross-project unread counts
      projects.forEach(function (ctx, projSlug) {
        ctx.forEachClient(function (ws) {
          var filtered = allProjectsList;
          if (users.isMultiUser() && onGetProjectAccess) {
            var wsUser = ws._clayUser;
            if (wsUser) {
              filtered = allProjectsList.filter(function (p) {
                var access = onGetProjectAccess(p.slug);
                if (!access || access.error) return true;
                return users.canAccessProject(wsUser.id, access);
              });
            }
          }
          // Attach per-project unread counts for this client
          var unreadMap = getCrossProjectUnread(ws);
          var projectsWithUnread = filtered.map(function (p) {
            var copy = {};
            var keys = Object.keys(p);
            for (var i = 0; i < keys.length; i++) copy[keys[i]] = p[keys[i]];
            // For the current project, use session-level unread total
            if (p.slug === projSlug) {
              copy.unread = ctx.sm.getTotalUnread(ws);
            } else {
              copy.unread = unreadMap[p.slug] || 0;
            }
            return copy;
          });
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({
              type: "projects_updated",
              projects: projectsWithUnread,
              projectCount: projectsWithUnread.length,
              removedProjects: getRemovedProjects(ws._clayUser ? ws._clayUser.id : null),
            }));
          }
        });
      });
      // A project-owned coordinator changes outside the Lead project. Its local
      // session_list cannot update the owner-visible Coop hierarchy, so rebuild
      // and push the global projection on the same debounced processing edge.
      refreshGlobalCoopViewers();
    }, 200);
  }

  // --- Project management ---
  function addProject(cwd, slug, title, icon, projectOwnerId, worktreeMeta, extraOpts) {
    if (projects.has(slug)) return false;
    var extra = extraOpts || {};
    var projectId = projectIdentity.projectIdForRuntime(extra, cwd, slug);
    var ctx = createProjectContext({
      cwd: cwd,
      slug: slug,
      crossProject: crossProject,
      title: title || null,
      icon: icon || null,
      projectOwnerId: projectOwnerId || null,
      isCoopTopicOwner: connectedUserIsCoopOwner,
      worktreeMeta: worktreeMeta || null,
      isMate: extra.isMate || false,
      mateDisplayName: extra.mateDisplayName || "",
      isHostAgent: !!extra.isHostAgent,
      pushModule: pushModule,
      debug: debug,
      dangerouslySkipPermissions: dangerouslySkipPermissions,
      fullAutoMode: fullAutoMode,
      multiUser: users.isMultiUser(),
      osUsers: osUsers,
      currentVersion: currentVersion,
      lanHost: lanHost,
      port: portNum,
      tls: !!tlsOptions,
      authToken: pinHash || null,
      liveUiRegistry: liveUiRegistry,
      getProjectCount: function () { return projects.size; },
      getProjectList: function (userId) {
        var list = [];
        projects.forEach(function (ctx, s) {
          var status = ctx.getStatus();
          if (userId && users.isMultiUser() && onGetProjectAccess) {
            var access = onGetProjectAccess(s);
            if (access && !access.error && !users.canAccessProject(userId, access)) return;
          }
          list.push(status);
        });
        return list;
      },
      // The LIVE canonical Coop session, for attributing admitted automation
      // work to Coop's own task graph. Returns null when Coop is not up, which
      // makes admission fail closed rather than invent an owner.
      getCoopSource: function () {
        var found = null;
        projects.forEach(function (pCtx, pSlug) {
          if (found || pSlug !== "lead") return;
          var pSm = typeof pCtx.getSessionManager === "function" ? pCtx.getSessionManager() : null;
          if (!pSm || !pSm.sessions || typeof pSm.sessions.forEach !== "function") return;
          pSm.sessions.forEach(function (session) {
            if (found || !session || session.coopHome !== true) return;
            var storageId = session.storageId || session.cliSessionId || session.sessionStorageId;
            if (!storageId) return;
            found = { projectId: "system-lead", sessionStorageId: storageId };
          });
        });
        return found;
      },
      getAllProjectSessions: function () {
        var allSessions = [];
        projects.forEach(function (pCtx, pSlug) {
          if (pSlug === slug) return; // skip self
          var status = pCtx.getStatus();
          if (status.isWorktree) return;
          var pSm = pCtx.getSessionManager();
          if (!pSm) return;
          var projectTitle = status.title || status.project || pSlug;
          pSm.sessions.forEach(function (s) {
            if (!s.hidden && s.history && s.history.length > 0) {
              s._projectTitle = projectTitle;
              allSessions.push(s);
            }
          });
        });
        return allSessions;
      },
      // Like getAllProjectSessions but returns the per-project grouped
      // shape that session-search.searchPalette expects. Includes self
      // (so the host agent can search its own past Clay conversations).
      // Used by clay-history-mcp-server.
      getAllProjectsWithSessions: function () {
        var out = [];
        projects.forEach(function (pCtx, pSlug) {
          var status = pCtx.getStatus();
          if (status.isWorktree) return;
          var pSm = pCtx.getSessionManager();
          if (!pSm) return;
          var sessions = [];
          pSm.sessions.forEach(function (s) {
            if (s.hidden) return;
            sessions.push(s);
          });
          if (sessions.length === 0) return;
          out.push({
            projectSlug: pSlug,
            projectTitle: status.title || status.project || pSlug,
            projectIcon: status.icon || null,
            isMate: !!status.isMate,
            mateId: status.mateId || null,
            sessions: sessions,
          });
        });
        return out;
      },
      getHubSchedules: function () {
        var allSchedules = [];
        projects.forEach(function (ctx, s) {
          var status = ctx.getStatus();
          var recs = ctx.getSchedules();
          for (var i = 0; i < recs.length; i++) {
            // Shallow-copy full record and augment with project metadata
            var copy = {};
            var keys = Object.keys(recs[i]);
            for (var k = 0; k < keys.length; k++) copy[keys[k]] = recs[i][keys[k]];
            copy.projectSlug = s;
            copy.projectTitle = status.title || status.project;
            allSchedules.push(copy);
          }
        });
        return allSchedules;
      },
      // Move a schedule record from one project to another
      moveScheduleToProject: function (recordId, fromSlug, toSlug) {
        var fromCtx = projects.get(fromSlug);
        var toCtx = projects.get(toSlug);
        if (!fromCtx || !toCtx) return { ok: false, error: "Project not found" };
        var recs = fromCtx.getSchedules();
        var rec = null;
        for (var i = 0; i < recs.length; i++) {
          if (recs[i].id === recordId) { rec = recs[i]; break; }
        }
        if (!rec) return { ok: false, error: "Record not found" };
        // Copy full record data
        var data = {};
        var keys = Object.keys(rec);
        for (var k = 0; k < keys.length; k++) data[keys[k]] = rec[keys[k]];
        // Import into target, remove from source
        toCtx.importSchedule(data);
        fromCtx.removeSchedule(recordId);
        return { ok: true };
      },
      // Bulk move all schedules from one project to another
      moveAllSchedulesToProject: function (fromSlug, toSlug) {
        var fromCtx = projects.get(fromSlug);
        var toCtx = projects.get(toSlug);
        if (!fromCtx || !toCtx) return { ok: false, error: "Project not found" };
        var recs = fromCtx.getSchedules();
        for (var i = 0; i < recs.length; i++) {
          var data = {};
          var keys = Object.keys(recs[i]);
          for (var k = 0; k < keys.length; k++) data[keys[k]] = recs[i][keys[k]];
          toCtx.importSchedule(data);
        }
        // Remove all from source
        var ids = recs.map(function (r) { return r.id; });
        for (var j = 0; j < ids.length; j++) {
          fromCtx.removeSchedule(ids[j]);
        }
        return { ok: true };
      },
      // Get schedule count for a project slug
      getScheduleCount: function (slug) {
        var ctx = projects.get(slug);
        if (!ctx) return 0;
        return ctx.getSchedules().length;
      },
      onPresenceChange: broadcastPresenceChange,
      onProcessingChanged: broadcastProcessingChange,
      onSessionDone: function (session) { onSessionDone(slug, session); },
      onAddProject: onAddProject,
      onCreateProject: onCreateProject,
      onCloneProject: onCloneProject,
      onRemoveProject: onRemoveProject,
      onCreateWorktree: onCreateWorktree,
      onReorderProjects: onReorderProjects,
      onSetProjectTitle: onSetProjectTitle,
      onSetProjectIcon: onSetProjectIcon,
      onListGitAccounts: onListGitAccounts,
      onGetProjectGitAccount: onGetProjectGitAccount,
      onSetProjectGitAccount: onSetProjectGitAccount,
      onProjectOwnerChanged: onProjectOwnerChanged,
      onGetServerDefaultEffort: onGetServerDefaultEffort,
      onSetServerDefaultEffort: onSetServerDefaultEffort,
      onGetProjectDefaultEffort: onGetProjectDefaultEffort,
      onSetProjectDefaultEffort: onSetProjectDefaultEffort,
      onGetServerDefaultModel: onGetServerDefaultModel,
      onSetServerDefaultModel: onSetServerDefaultModel,
      onGetServerCodexDefaults: onGetServerCodexDefaults,
      onSetServerCodexDefaults: onSetServerCodexDefaults,
      onGetProjectDefaultModel: onGetProjectDefaultModel,
      onSetProjectDefaultModel: onSetProjectDefaultModel,
      onGetProjectAutoContinueComparable: onGetProjectAutoContinueComparable,
      onSetProjectAutoContinueComparable: onSetProjectAutoContinueComparable,
      onGetProjectCodexDefaults: onGetProjectCodexDefaults,
      onSetProjectCodexDefaults: onSetProjectCodexDefaults,
      onGetServerDefaultMode: onGetServerDefaultMode,
      onSetServerDefaultMode: onSetServerDefaultMode,
      onGetProjectDefaultMode: onGetProjectDefaultMode,
      onSetProjectDefaultMode: onSetProjectDefaultMode,
      onGetProjectLastVendor: onGetProjectLastVendor,
      onSetProjectLastVendor: onSetProjectLastVendor,
      onGetProjectMcpServers: onGetProjectMcpServers,
      onSetProjectMcpServers: onSetProjectMcpServers,
      onGetDaemonConfig: onGetDaemonConfig,
      onSetPin: onSetPin,
      onSetKeepAwake: onSetKeepAwake,
      onSetInheritGroups: onSetInheritGroups,
      onSetImageRetention: onSetImageRetention,
      onSetUpdateChannel: onSetUpdateChannel,
      updateChannel: onGetDaemonConfig ? (onGetDaemonConfig().updateChannel || "stable") : "stable",
      onShutdown: onShutdown,
      onRestart: onRestart,
      onDmMessage: handleDmMessage,
      broadcastAll: broadcastAll,
      notificationsModule: _globalNotifications,
      getProject: function (s) { return projects.get(s) || null; },
      isUserOnline: isUserOnline,
      getGlobalCoopProjection: globalCoopProjectionFor,
      // Authority for topic-scoped owner decisions (coop_topic_disposition):
      // same owner test the task-scoped decision path uses below.
      isCoopTopicOwner: function (ws) { return connectedUserIsCoopOwner(ws); },
      // Live task evidence for the stale-state check on a topic decision. The
      // client echoes the state it displayed; the server re-derives before
      // applying so a decision taken against a stale row is rejected.
      computeCoopTopicWorkState: function (topicRef, metadata, ws) {
        var coopSession = canonicalCoopSessionForState();
        if (!coopSession) return "";
        return coopTopicState.projectedTopicState(topicRef, {
          tasks: coopSession.orchestrationTasks,
          // Same inputs as the projection seam above. If this re-derivation saw
          // less evidence than the row the client rendered, an owner decision
          // taken on a binding-linked topic would be rejected as stale.
          bindings: ledgerTopicBindings(topicRef, metadata, ws),
          metadata: metadata || null,
          foreground: {
            isProcessing: !!coopSession.isProcessing,
            topicRef: (coopWorkActivity.latestCoopRoute(coopSession) || {}).topicRef || null,
          },
        }).workState;
      },
      resolveGlobalSessionRef: function (ref, ws) {
        return projectReferenceResolver.resolveSessionRef(ref, ws);
      },
      // After a successful topic mutation (disposition or management), every
      // connected owner viewer's projection is stale, not just the deciding
      // socket's; reuse the same fan-out the action queue uses.
      refreshCoopTopicViewers: refreshCoopActionQueues,
      archiveCompletedCoopTopicSessions: archiveCompletedCoopTopicSessions,
      // The single durable owner-request ledger. Injected rather than resolved
      // by each write path: a default that materialises itself on the hot
      // ingress path let a test drive real owner messages into the owner's
      // live file. No injection now means no durable write, anywhere.
      coopOwnerRequests: coopOwnerRequests.getDefaultOwnerRequests(),
      // Owner decisions from the Action required queue act on another project's
      // task, so resolution and ACLs are enforced here, where the project
      // registry and the per-ws access helpers live.
      applyCoopActionDecision: function (request, ws) {
        return coopActionDecision.applyDecision({
          request: request,
          // Authority first, then the target ACLs below.
          isOwner: function () { return connectedUserIsCoopOwner(ws); },
          getProjectById: getProjectContextById,
          canAccessProject: function (project) { return canAccessProjectRef(ws, project); },
          canAccessSession: function (project, session) {
            return canAccessSessionRef(ws, project, session);
          },
          identityOf: coopActionQueue.canonicalIdentity,
          onDecided: refreshCoopActionQueues,
        });
      },
    });
    var getStatus = ctx.getStatus;
    ctx.projectId = projectId;
    ctx.getStatus = function () {
      var status = getStatus();
      status.projectId = projectId;
      if (extra.parentProjectId) status.parentProjectId = extra.parentProjectId;
      return status;
    };
    if (ctx.sm && typeof ctx.sm.setProjectId === "function") {
      ctx.sm.setProjectId(projectId);
    }
    // Slice 3 recovery needs the exact durable ProjectRef and all target
    // handlers installed first. The barrier remains closed while an async
    // provider activation is still proving its start fence.
    if (ctx.sm && typeof ctx.sm.registerCoopControlRecoveryTarget === "function") {
      ctx.sm.registerCoopControlRecoveryTarget();
      var controlRecovery = coopControlRuntime.scheduleStartupRecovery();
      if (controlRecovery && typeof controlRecovery.then === "function") {
        controlRecovery.then(function () {
          try {
            if (crossProject && typeof crossProject.completeControlledStartup === "function") {
              crossProject.completeControlledStartup();
            } else if (typeof ctx.sm.reconcileCoopControlSessions === "function") {
              ctx.sm.reconcileCoopControlSessions();
            }
          } catch (error) {
            if (crossProject && typeof crossProject.failControlledStartup === "function") {
              crossProject.failControlledStartup(error);
            }
            // Fail-closed here blocks ALL controlled execution for the daemon
            // lifetime, so it must reach the canary, not just stdio.
            console.error("[coop-control] startup reconciliation failed closed:",
              error && error.message || error);
            recordStartupFailure("coop_control_reconciliation",
              String(error && error.message || error));
          }
        }, function (error) {
          if (crossProject && typeof crossProject.failControlledStartup === "function") {
            crossProject.failControlledStartup(error);
          }
          console.error("[coop-control] startup recovery failed closed:", error && error.message || error);
          recordStartupFailure("coop_control_recovery",
            String(error && error.message || error));
        });
      } else if (crossProject && typeof crossProject.completeControlledStartup === "function") {
        crossProject.completeControlledStartup();
      } else if (typeof ctx.sm.reconcileCoopControlSessions === "function") {
        ctx.sm.reconcileCoopControlSessions();
      }
    } else if (ctx.sm && typeof ctx.sm.recoverCoopControlStartup === "function") {
      ctx.sm.recoverCoopControlStartup();
    }
    // createProjectContext registers its cross-project resolver before this
    // manager receives its durable ProjectRef. Re-run the binding store's
    // existing reconciliation now that resolver lookup can find the restored
    // session by the exact project id.
    if (crossProject && typeof crossProject.reconcileStrandedCompletions === "function") {
      crossProject.reconcileStrandedCompletions();
    }
    projects.set(slug, ctx);
    migrateLeadOwnerRequestHistory(extra, ctx);
    if (crossProject && typeof crossProject.reconcileSessionLedger === "function") {
      crossProject.reconcileSessionLedger({ topicLinks: currentCoopTopicLinks() });
    }
    // ctx.warmup() is now deferred to the first websocket connection into
    // this project (see project-connection.js handleConnection). Warming
    // every project at startup spawned a CodexAppServer and an mcp-bridge
    // child for each one, which cost 30+ processes on daemons with many
    // projects/mates even though the user typically only opens one.
    // Schedule project registry refresh for all mates when a non-mate project is added
    if (!extra.isMate) scheduleRegistryRefresh();
    return true;
  }

  function getProjectContextById(projectId) {
    var found = null;
    projects.forEach(function (ctx) {
      if (!found && ctx.projectId === projectId) found = ctx;
    });
    return found;
  }

  function canAccessProjectRef(ws, project) {
    if (!ws || !ws._clayUser || !users.isMultiUser() || !onGetProjectAccess) return true;
    var status = project.getStatus ? project.getStatus() : null;
    var access = onGetProjectAccess(status && status.isWorktree && status.parentSlug || project.slug);
    return !!access && !access.error && users.canAccessProject(ws._clayUser.id, access);
  }

  function canAccessSessionRef(ws, project, session) {
    var manager = project.getSessionManager ? project.getSessionManager() : null;
    if (!manager || typeof manager.canWsAccessSession !== "function") return false;
    return manager.canWsAccessSession(ws, session);
  }

  function canAccessArchivedSessionRef(ws, project, session) {
    var manager = project.getSessionManager ? project.getSessionManager() : null;
    if (!manager || typeof manager.canWsAccessArchivedSession !== "function") return false;
    return manager.canWsAccessArchivedSession(ws, session);
  }

  var projectReferenceResolver = projectIdentity.createReferenceResolver({
    getProjectById: getProjectContextById,
    canAccessProject: canAccessProjectRef,
    canAccessSession: canAccessSessionRef,
  });

  // --- DM message handler (delegated to server-dm + server-mates inline) ---
  var dmHandler = serverDm.attachDm({
    users: users,
    dm: dm,
    mates: mates,
    projects: projects,
    pushModule: pushModule,
    addProject: addProject,
  });

  // --- Email account handler (per-user email account management) ---
  var emailHandler = serverEmail.attachEmail({ users: users });

  // --- Clay home chat handler (host agent chat embedded in home hub) ---
  var clayHomeHandler = serverClayHome.attachClayHome({
    users: users,
    mates: mates,
    projects: projects,
    addProject: addProject,
  });

  // --- Mate handler ---
  // Forward reference: mateHandler is set up after removeProject is defined
  var mateHandler = null;
  function scheduleRegistryRefresh() {
    if (mateHandler) mateHandler.scheduleRegistryRefresh();
  }

  function handleDmMessage(ws, msg) {
    if (dmHandler.handleMessage(ws, msg)) return;
    if (mateHandler && mateHandler.handleMessage(ws, msg)) return;
    if (emailHandler.handleMessage(ws, msg)) return;
    if (clayHomeHandler.handleMessage(ws, msg)) return;
  }

  function removeProject(slug) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    var wasMate = ctx.getStatus().isMate;
    var shutdownResult = ctx.destroy();
    projects.delete(slug);
    if (shutdownResult && typeof shutdownResult.catch === "function") {
      shutdownResult.catch(function(err) {
        console.error("[server] Project destroy failed for " + slug + ":", err && err.message ? err.message : err);
      });
    }
    if (!wasMate) scheduleRegistryRefresh();
    return true;
  }

  // Now that addProject and removeProject are defined, initialize mateHandler
  mateHandler = serverMates.attachMates({
    users: users,
    mates: mates,
    projects: projects,
    addProject: addProject,
    removeProject: removeProject,
    onGetProjectAccess: onGetProjectAccess,
  });

  function getProjects() {
    var list = [];
    projects.forEach(function (ctx) {
      list.push(ctx.getStatus());
    });
    return list;
  }

  function reorderProjects(slugs) {
    var ordered = new Map();
    for (var i = 0; i < slugs.length; i++) {
      var ctx = projects.get(slugs[i]);
      if (ctx) ordered.set(slugs[i], ctx);
    }
    // Append any remaining (safety)
    projects.forEach(function (ctx, slug) {
      if (!ordered.has(slug)) ordered.set(slug, ctx);
    });
    projects.clear();
    ordered.forEach(function (ctx, slug) {
      projects.set(slug, ctx);
    });
  }

  function setProjectTitle(slug, title) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.setTitle(title);
    return true;
  }

  function setProjectIcon(slug, icon) {
    var ctx = projects.get(slug);
    if (!ctx) return false;
    ctx.setIcon(icon);
    return true;
  }

  // Collect all unique users across all projects (for topbar server-wide presence)
  function getServerUsers() {
    var seen = {};
    var list = [];
    projects.forEach(function (ctx) {
      ctx.forEachClient(function (ws) {
        if (!ws._clayUser) return;
        var u = ws._clayUser;
        if (seen[u.id]) return;
        seen[u.id] = true;
        var p = u.profile || {};
        list.push({
          id: u.id,
          displayName: p.name || u.displayName || u.username,
          username: u.username,
          avatarStyle: p.avatarStyle || "thumbs",
          avatarSeed: p.avatarSeed || u.username,
          avatarCustom: p.avatarCustom || "",
        });
      });
    });
    return list;
  }

  // Debounced broadcast of projects_updated when presence changes
  // Sends per-user filtered project lists + server-wide user list
  var presenceTimer = null;
  function broadcastPresenceChange() {
    if (presenceTimer) clearTimeout(presenceTimer);
    presenceTimer = setTimeout(function () {
      presenceTimer = null;
      if (!users.isMultiUser()) {
        broadcastAll({
          type: "projects_updated",
          projects: getProjects(),
          projectCount: projects.size,
          removedProjects: getRemovedProjects(),
        });
        return;
      }
      var serverUsers = getServerUsers();
      var allUsers = users.getAllUsers().map(function (u) {
        var p = u.profile || {};
        return {
          id: u.id,
          displayName: p.name || u.displayName || u.username,
          username: u.username,
          role: u.role,
          avatarStyle: p.avatarStyle || "thumbs",
          avatarSeed: p.avatarSeed || u.username,
          avatarColor: p.avatarColor || "#7c3aed",
          avatarCustom: p.avatarCustom || "",
        };
      });
      // Build per-user filtered lists, send individually
      var sentUsers = {};
      projects.forEach(function (ctx) {
        ctx.forEachClient(function (ws) {
          var userId = ws._clayUser ? ws._clayUser.id : null;
          var key = userId || "__anon__";
          if (sentUsers[key]) {
            // Already computed for this user, just send the cached msg
            ws.send(sentUsers[key]);
            return;
          }
          var filteredProjects = [];
          projects.forEach(function (pCtx, s) {
            var status = pCtx.getStatus();
            if (userId && onGetProjectAccess) {
              var access = onGetProjectAccess(s);
              if (access && !access.error && !users.canAccessProject(userId, access)) return;
            }
            filteredProjects.push(status);
          });
          // Per-user DM data
          var userDmFavorites = userId ? users.getDmFavorites(userId) : [];
          var userDmHidden = userId ? users.getDmHidden(userId) : [];
          var userDmConversations = [];
          if (userId) {
            var dmList = dm.getDmList(userId);
            for (var di = 0; di < dmList.length; di++) {
              if (userDmHidden.indexOf(dmList[di].otherUserId) === -1) {
                userDmConversations.push(dmList[di].otherUserId);
              }
            }
          }
          var msgStr = JSON.stringify({
            type: "projects_updated",
            projects: filteredProjects,
            projectCount: projects.size,
            serverUsers: serverUsers,
            allUsers: allUsers,
            dmFavorites: userDmFavorites,
            dmConversations: userDmConversations,
            removedProjects: getRemovedProjects(userId),
          });
          sentUsers[key] = msgStr;
          ws.send(msgStr);
        });
      });
    }, 300);
  }

  function broadcastAll(msg) {
    projects.forEach(function (ctx) {
      ctx.send(msg);
    });
  }

  // Send a message to every live ws belonging to a specific user across all projects.
  // Used by user-targeted notifications (e.g. user-to-user @mentions).
  function sendToUser(userId, msg) {
    if (!userId) return;
    var data = JSON.stringify(msg);
    projects.forEach(function (ctx) {
      if (typeof ctx.forEachClient !== "function") return;
      ctx.forEachClient(function (ws) {
        if (ws._clayUser && ws._clayUser.id === userId && ws.readyState === 1) {
          ws.send(data);
        }
      });
    });
  }

  // True if the user has any live ws across any project.
  function isUserOnline(userId) {
    if (!userId) return false;
    var found = false;
    projects.forEach(function (ctx) {
      if (found) return;
      if (typeof ctx.forEachClient !== "function") return;
      ctx.forEachClient(function (ws) {
        if (found) return;
        if (ws._clayUser && ws._clayUser.id === userId && ws.readyState === 1) {
          found = true;
        }
      });
    });
    return found;
  }

  function forEachProject(fn) {
    projects.forEach(function (ctx, slug) {
      fn(ctx, slug);
    });
  }

  // Synchronously write out every coalesced session save that is still parked
  // in an unref'd timer. Those timers do NOT keep the process alive, so on
  // SIGTERM (e.g. an update handoff) the pending save is otherwise dropped with
  // no error at all. Called from the daemon's gracefulShutdown before exit.
  function flushPendingSaves() {
    var flushed = 0;
    projects.forEach(function (ctx) {
      if (ctx && ctx.sm && typeof sessionsPersistence.flushPendingCoalescedSaves === "function") {
        try { flushed += sessionsPersistence.flushPendingCoalescedSaves(ctx.sm) || 0; }
        catch (e) { /* best effort: one project must not block the rest */ }
      }
    });
    return flushed;
  }

  function prepareControlledRestart() {
    if (crossProject && typeof crossProject.prepareControlledRestart === "function") {
      return crossProject.prepareControlledRestart();
    }
    return { enabled: false, preparedHandoffs: 0, state: "draining" };
  }

  function destroyAll() {
    try { prepareControlledRestart(); }
    catch (error) { return Promise.reject(error); }
    var shutdowns = [];
    projects.forEach(function (ctx, slug) {
      console.log("[server] Destroying project:", slug);
      var result = ctx.destroy();
      if (result && typeof result.then === "function") {
        shutdowns.push(result.catch(function(err) {
          console.error("[server] Project destroy failed for " + slug + ":", err && err.message ? err.message : err);
          return false;
        }));
      }
    });
    projects.clear();
    return Promise.all(shutdowns);
  }

  // --- Periodic cleanup of old chat images ---
  var imagesBaseDir = path.join(CONFIG_DIR, "images");
  function getImageMaxAgeMs() {
    var days = onGetDaemonConfig ? onGetDaemonConfig().imageRetentionDays : undefined;
    if (days === undefined) days = 7;
    if (days === 0) return 0; // 0 = keep forever
    return days * 24 * 60 * 60 * 1000;
  }
  function cleanupOldImages() {
    var maxAge = getImageMaxAgeMs();
    if (maxAge === 0) return; // keep forever
    try {
      if (!fs.existsSync(imagesBaseDir)) return;
      var dirs = fs.readdirSync(imagesBaseDir);
      var now = Date.now();
      var removed = 0;
      for (var d = 0; d < dirs.length; d++) {
        var dirPath = path.join(imagesBaseDir, dirs[d]);
        try {
          var stat = fs.statSync(dirPath);
          if (!stat.isDirectory()) continue;
        } catch (e) { continue; }
        var files = fs.readdirSync(dirPath);
        for (var f = 0; f < files.length; f++) {
          var filePath = path.join(dirPath, files[f]);
          try {
            var fstat = fs.statSync(filePath);
            if (now - fstat.mtimeMs > maxAge) {
              fs.unlinkSync(filePath);
              removed++;
            }
          } catch (e) {}
        }
        // Remove empty directory
        try {
          var remaining = fs.readdirSync(dirPath);
          if (remaining.length === 0) fs.rmdirSync(dirPath);
        } catch (e) {}
      }
      if (removed > 0) console.log("[images] Cleaned up " + removed + " expired image(s)");
    } catch (e) {
      console.error("[images] Cleanup error:", e.message);
    }
  }
  cleanupOldImages();
  setInterval(cleanupOldImages, 24 * 60 * 60 * 1000);

  return {
    server: server,
    onboardingServer: onboardingServer,
    isTLS: !!tlsOptions,
    addProject: addProject,
    removeProject: removeProject,
    getProjects: getProjects,
    resolveProjectRef: projectReferenceResolver.resolveProjectRef,
    resolveSessionRef: projectReferenceResolver.resolveSessionRef,
    resolveTaskRef: projectReferenceResolver.resolveTaskRef,
    queryCoopSessions: queryCoopSessions,
    reorderProjects: reorderProjects,
    setProjectTitle: setProjectTitle,
    setProjectIcon: setProjectIcon,
    setAuthToken: auth.setAuthToken,
    setRecovery: auth.setRecovery,
    clearRecovery: auth.clearRecovery,
    broadcastAll: broadcastAll,
    forEachProject: forEachProject,
    flushPendingSaves: flushPendingSaves,
    destroyProject: removeProject,
    prepareControlledRestart: prepareControlledRestart,
    destroyAll: destroyAll,
    destroySockets: destroySockets,
  };
}

module.exports = {
  createServer: createServer,
  // Exported for tests: the binding-to-topic attribution rule is a fail-closed
  // safety guarantee, and createServer cannot be booted in a unit test.
  coopTopicLinkedBindings: coopTopicLinkedBindings,
  generateAuthToken: generateAuthToken,
  verifyPin: verifyPin,
};
