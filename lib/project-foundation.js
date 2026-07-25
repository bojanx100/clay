var path = require("path");
var { createSessionManager } = require("./sessions");
var usersModule = require("./users");
var matesModule = require("./mates");
var { attachFileWatch } = require("./project-file-watch");
var { attachImage } = require("./project-image");
var { attachKnowledge } = require("./project-knowledge");
var { attachMcp } = require("./project-mcp");
var { attachMateDatastore } = require("./project-mate-datastore");
var { createLocalMcp } = require("./mcp-local");
var { attachEmail: attachEmailModule } = require("./project-email");
var { loadContextSources, saveContextSources } = require("./project-context-sources");
var { createProjectLocalMcpServers } = require("./project-local-mcp-servers");
var { attachProjectOsUsers } = require("./project-os-users");
var { attachProjectClients } = require("./project-clients");
var { attachProjectBrowserExtension } = require("./project-browser-extension");
var { attachProjectStatus } = require("./project-status");
var { applyProjectSessionDefaults } = require("./project-session-defaults");
var {
  IGNORED_DIRS,
  BINARY_EXTS,
  FS_MAX_SIZE,
  safePath,
} = require("./project-path-utils");

function attachProjectFoundation(ctx) {
  var cwd = ctx.cwd;
  var slug = ctx.slug;
  var project = ctx.project;
  var opts = ctx.opts || {};
  var debug = !!ctx.debug;
  var osUsers = !!ctx.osUsers;
  var fullAutoMode = !!ctx.fullAutoMode;
  var currentVersion = ctx.currentVersion;
  var lanHost = ctx.lanHost || null;
  var isMate = !!ctx.isMate;
  var isHostAgent = !!ctx.isHostAgent;
  var worktreeMeta = ctx.worktreeMeta || null;
  var adapters = ctx.adapters || {};
  var adapter = ctx.adapter || null;
  var defaultVendor = ctx.defaultVendor || "claude";
  var onSessionDone = ctx.onSessionDone || function () {};
  var onPresenceChange = ctx.onPresenceChange || function () {};
  var getProjectCount = ctx.getProjectCount || function () { return 1; };
  var getProjectList = ctx.getProjectList || function () { return []; };
  var getAllProjectsWithSessions = ctx.getAllProjectsWithSessions || function () { return []; };
  var getSessionForWs = ctx.getSessionForWs || function () { return null; };
  var getProjectOwnerId = ctx.getProjectOwnerId || function () { return null; };
  var setProjectOwnerId = ctx.setProjectOwnerId || function () {};
  var browserState = null;

  var image = attachImage({ cwd: cwd, slug: slug });
  var osUserApi = attachProjectOsUsers({
    cwd: cwd,
    osUsers: osUsers,
  });

  var clientsApi = attachProjectClients({
    usersModule: usersModule,
    onPresenceChange: onPresenceChange,
  });
  var clients = clientsApi.clients;
  var send = clientsApi.send;
  var sendTo = clientsApi.sendTo;

  var pendingDebateProposals = {};
  var browserExtension = attachProjectBrowserExtension({
    sendTo: sendTo,
  });
  browserState = browserExtension.browserState;

  var knowledge = attachKnowledge({
    cwd: cwd,
    isMate: isMate,
    sendTo: sendTo,
    matesModule: matesModule,
    getProjectOwnerId: getProjectOwnerId,
  });

  var fileWatch = attachFileWatch({
    cwd: cwd,
    send: send,
    safePath: safePath,
    BINARY_EXTS: BINARY_EXTS,
    FS_MAX_SIZE: FS_MAX_SIZE,
    IGNORED_DIRS: IGNORED_DIRS,
  });

  var sm = createSessionManager({
    cwd: cwd,
    send: send,
    sendTo: sendTo,
    sendEach: function (fn) {
      for (var ws of clients) {
        var user = ws._clayUser;
        var filterFn = null;
        if (usersModule.isMultiUser() && user) {
          filterFn = (function (u) {
            return function (s) {
              return usersModule.canAccessSession(u.id, s, { visibility: "public" });
            };
          })(user);
        }
        fn(ws, filterFn);
      }
    },
    onSessionDone: onSessionDone,
  });

  var status = attachProjectStatus({
    cwd: cwd,
    slug: slug,
    project: project,
    title: opts.title || null,
    icon: opts.icon || null,
    currentVersion: currentVersion,
    debug: debug,
    osUsers: osUsers,
    lanHost: lanHost,
    isMate: isMate,
    worktreeMeta: worktreeMeta,
    clients: clients,
    sm: sm,
    send: send,
    usersModule: usersModule,
    projectClients: clientsApi,
    getProjectCount: getProjectCount,
    getProjectList: getProjectList,
    getProjectOwnerId: getProjectOwnerId,
  });

  applyProjectSessionDefaults({
    sm: sm,
    opts: opts,
    adapters: adapters,
    defaultVendor: defaultVendor,
    fullAutoMode: fullAutoMode,
  });

  var localMcp = createLocalMcp();
  var mcp = attachMcp({
    send: send,
    sendTo: sendTo,
    slug: slug,
    isMate: isMate,
    getExtensionWs: function () { return browserState._extensionWs; },
    getExtensionId: function () { return browserState._extensionId || null; },
    getEnabledMcpServers: function () {
      return typeof opts.onGetProjectMcpServers === "function"
        ? opts.onGetProjectMcpServers(slug) : [];
    },
    setEnabledMcpServers: function (servers) {
      if (typeof opts.onSetProjectMcpServers === "function") {
        opts.onSetProjectMcpServers(slug, servers);
      }
    },
    localMcp: localMcp,
  });

  var email = attachEmailModule({
    slug: slug,
    send: send,
    sendTo: sendTo,
    clients: clients,
    loadContextSources: loadContextSources,
    getUserIdForWs: function (ws) {
      return (ws._clayUser && ws._clayUser.id) || "default";
    },
  });

  var mateDatastore = attachMateDatastore({
    cwd: cwd,
    slug: slug,
    isMate: isMate,
    send: send,
    sendTo: sendTo,
    clients: clients,
    getSessionForWs: getSessionForWs,
    usersModule: usersModule,
    getProjectOwnerId: getProjectOwnerId,
  });

  // Late-binding holder for the model's switch_provider tool: the MCP
  // servers are created here (foundation), but the gate that validates and
  // confirms switch requests lives in the runtime, which attaches later.
  // project.js fills `handler` once the runtime exists.
  var providerSwitchGate = { handler: null };
  var taskOrchestrationGate = { delegate: null, message: null };

  var localMcpServers = createProjectLocalMcpServers({
    adapter: adapter,
    isMate: isMate,
    isHostAgent: isHostAgent,
    slug: slug,
    sm: sm,
    clients: clients,
    browserState: browserState,
    sendExtensionCommandAny: browserExtension.sendExtensionCommandAny,
    loadContextSources: loadContextSources,
    saveContextSources: saveContextSources,
    getAllProjectsWithSessions: getAllProjectsWithSessions,
    pendingDebateProposals: pendingDebateProposals,
    email: email,
    mateDatastore: mateDatastore,
    providerSwitchGate: providerSwitchGate,
    taskOrchestrationGate: taskOrchestrationGate,
  });

  return {
    imagesDir: image.imagesDir,
    hydrateImageRefs: image.hydrateImageRefs,
    saveImageFile: image.saveImageFile,
    loadImagesForSdk: image.loadImagesForSdk,
    getLinuxUserForSession: osUserApi.getLinuxUserForSession,
    ensureProjectAccessForSession: osUserApi.ensureProjectAccessForSession,
    getOsUserInfoForWs: osUserApi.getOsUserInfoForWs,
    getOsUserInfoForReq: osUserApi.getOsUserInfoForReq,
    clients: clients,
    send: send,
    sendTo: sendTo,
    sendToAdmins: clientsApi.sendToAdmins,
    broadcastClientCount: clientsApi.broadcastClientCount,
    sendToOthers: clientsApi.sendToOthers,
    sendToSession: clientsApi.sendToSession,
    sendToSessionOthers: clientsApi.sendToSessionOthers,
    broadcastPresence: clientsApi.broadcastPresence,
    forEachClient: clientsApi.forEachClient,
    pendingDebateProposals: pendingDebateProposals,
    extToken: browserExtension.extToken,
    browserState: browserState,
    sendExtensionCommandAny: browserExtension.sendExtensionCommandAny,
    requestTabContext: browserExtension.requestTabContext,
    knowledge: knowledge,
    startFileWatch: fileWatch.startFileWatch,
    stopFileWatch: fileWatch.stopFileWatch,
    startDirWatch: fileWatch.startDirWatch,
    stopDirWatch: fileWatch.stopDirWatch,
    stopAllDirWatches: fileWatch.stopAllDirWatches,
    sm: sm,
    status: status,
    localMcp: localMcp,
    mcp: mcp,
    email: email,
    mateDatastore: mateDatastore,
    getLocalMcpServers: localMcpServers.getLocalMcpServers,
    providerSwitchGate: providerSwitchGate,
    taskOrchestrationGate: taskOrchestrationGate,
    setProjectOwnerId: setProjectOwnerId,
  };
}

module.exports = {
  attachProjectFoundation: attachProjectFoundation,
};
