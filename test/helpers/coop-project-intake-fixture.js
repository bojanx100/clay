var fs = require("fs");
var path = require("path");
var home = require("./isolated-clay-home");
var sessions = require("../../lib/sessions");
var plane = require("../../lib/coop-control-plane");
var lifecycle = require("../../lib/coop-thread-lifecycle");
var owners = require("../../lib/coop-owner-requests");
var createRouter = require("../../lib/server-cross-project").createCrossProjectRouter;
var createSDKBridge = require("../../lib/sdk-bridge").createSDKBridge;
var attachOrchestrator = require("../../lib/project-task-orchestrator").attachTaskOrchestrator;
var assignmentMcp = require("../../lib/coop-project-assignment-mcp");
var createTopicIndex = require("../../lib/coop-topic-index").createTopicIndex;

var PROJECT = "11111111-1111-5111-8111-111111111111";
var OTHER = "22222222-2222-5222-8222-222222222222";

async function waitFor(predicate) {
  var end = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Intake fixture observation timed out");
    await new Promise(function (resolve) { setTimeout(resolve, 2); });
  }
  return predicate();
}

function fixture(t, opts) {
  opts = opts || {};
  // Faults in one test must not quarantine the fake provider in another test.
  require("../../lib/provider-health")._reset();
  var dir = fs.mkdtempSync(path.join(home, "intake-"));
  var leadDir = path.join(dir, "lead");
  var targetDir = path.join(dir, "target");
  fs.mkdirSync(leadDir); fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(targetDir, "AGENTS.md"), "Preserve ordinary project behavior.");
  var state = { mode: true, now: 1000, notifications: [], providerQueries: [], starts: [], links: [],
    notificationFailure: !!opts.notificationFailure, targetFailure: false, providerFailure: false,
    attentionFailure: false, threadFailure: false, attentionDeliveries: [] };
  var cleanups = [];
  function createManager(cwd, projectId) {
    var sm = sessions.createSessionManager({ cwd: cwd, projectId: projectId, send: function () {} });
    sm.defaultVendor = "codex";
    sm.modelsByVendor = { codex: ["gpt-5.6-terra"] };
    sm.verifiedModelsByRoute = { "codex-openai": ["gpt-5.6-terra"] };
    sm.installedVendors = ["codex"];
    sm.availableVendors = ["codex"];
    return sm;
  }
  function build() {
    state.lead = createManager(leadDir, "system-lead");
    state.target = createManager(targetDir, PROJECT);
    state.coop = plane.canonicalCoop(state.lead) || state.lead.getActiveSession();
    state.coop.coopHome = true;
    state.lead.saveSessionFile(state.coop, { durable: true });
    state.ledger = owners.attachCoopOwnerRequests({ file: path.join(dir, "owner-requests.json"), now: function () { return state.now; } });
    state.threads = createTopicIndex({ file: path.join(dir, "threads.json"), now: function () { return state.now; } });
    state.governance = require("../../lib/coop-governance-lifecycle").createLifecycle({
      file: path.join(dir, "governance.jsonl"), now: function () { return state.now; } });
    state.router = createRouter({ allowLeadSourcedExecution: true, requireOwnerImplementationDecision: true,
      projectCoordinatorIntake: true, isLeadModeEnabled: function () { return state.mode; },
      bindingFile: path.join(dir, "bindings.json"), deliveryFile: path.join(dir, "delivery.json"),
      autonomyPolicyFile: path.join(dir, "absent-autonomy.json"), ownerRequests: state.ledger,
      governanceLifecycle: state.governance,
      now: function () { return state.now; },
      onThreadHandedOff: function (input) {
        if (state.threadFailure) return { ok: false };
        state.links.push(input);
        return state.threads.linkExecution(input.topicRef, {
          projectRef: input.projectRef, taskRef: input.taskRef, sessionRef: input.sessionRef });
      } });
    var gate = {};
    var adapter = { vendor: "codex", createQuery: async function (options) {
      if (state.providerFailure) throw new Error("Fixture provider unavailable");
      var finish;
      var pending = new Promise(function (resolve) { finish = resolve; });
      var query = { options: options, messages: [] };
      var handle = { pushMessage: function (text) { query.messages.push(text); }, close: function () { finish({ done: true }); } };
      handle[Symbol.asyncIterator] = function () { return { next: function () { return pending; } }; };
      query.handle = handle;
      state.providerQueries.push(query);
      cleanups.push(function () { handle.close(); });
      return handle;
    } };
    state.bridge = createSDKBridge({ cwd: leadDir, slug: "lead", sessionManager: state.lead,
      adapter: adapter, adapters: { codex: adapter }, send: function () {},
      getControlSessionContext: state.router.getControlSessionContext,
      mcpServers: function (session) {
        var servers = {};
        servers[assignmentMcp.SERVER_NAME] = assignmentMcp.createAssignmentServer(adapter, state.lead, session, gate);
        return servers;
      } });
    state.leadApi = attachOrchestrator({ cwd: leadDir, slug: "lead", sm: state.lead,
      crossProject: state.router, sdk: state.bridge, sendToSession: function () {},
      ensureProjectAccessForSession: function () {}, autonomyPolicyFile: path.join(dir, "absent-autonomy.json") });
    gate.acceptAssignment = state.leadApi.acceptProjectAssignmentFromTool;
    state.targetApi = attachOrchestrator({ cwd: targetDir, slug: "target", sm: state.target,
      crossProject: state.router, sdk: { startQuery: function (session, text) {
        state.starts.push({ session: session, text: text });
      }, pushMessage: function () { return true; } }, sendToSession: function () {},
      ensureProjectAccessForSession: function () {}, autonomyPolicyFile: path.join(dir, "absent-autonomy.json") });
    function context(sm, projectId, cwd, api) {
      return { getProjectId: function () { return projectId; },
        getStatus: function () { return { projectId: projectId, path: cwd, title: "Same title" }; },
        getSessionManager: function () { return sm; }, getTaskOrchestrator: function () { return api; },
        deliverCoordinatorUpdate: function (id, text) {
          state.notifications.push({ id: id, text: text });
          return state.notificationFailure ? false : api.deliverCoordinatorUpdate(id, text);
        },
        deliverCrossProjectEnvelope: function (envelope) {
          if (projectId === "system-lead" && envelope.eventId.indexOf("assignment-attention-") === 0) {
            state.attentionDeliveries.push(envelope);
            if (state.attentionFailure) return { ok: false, reason: "delivery_error" };
          }
          if (projectId === PROJECT && state.targetFailure) return { ok: false, reason: "fixture_target_unavailable" };
          return api.deliverCrossProjectEnvelope(envelope);
        } };
    }
    state.router.registerProjectResolver(context(state.lead, "system-lead", leadDir, state.leadApi));
    state.router.registerProjectResolver(context(state.target, PROJECT, targetDir, state.targetApi));
    var leadApi = state.leadApi;
    var targetApi = state.targetApi;
    cleanups.push(function () { leadApi.stopCoopWatchdog(); targetApi.stopCoopWatchdog(); });
  }
  build();
  state.dir = dir; state.targetDir = targetDir;
  state.root = function () { return plane.projectCoordinatorFor(state.lead, { projectId: PROJECT }); };
  state.reopen = build;
  state.ownerRequest = function (text, suffix) {
    var index = state.coop.history.length;
    var ingressId = "coop:" + state.coop.storageId + ":" + (index + 1);
    var createdThread = state.threads.ensureOwnerThread({ ingressId: ingressId,
      projectRef: { projectId: PROJECT }, title: "Owner assignment" });
    if (!createdThread.ok) throw new Error(JSON.stringify(createdThread));
    var topic = createdThread.topicRef;
    var event = { type: "user_message", text: text || "Build this in Target", coopIngressId: ingressId,
      coopTopicRef: topic, coopProjectRef: { projectId: PROJECT }, _ts: state.now };
    state.coop.history.push(event);
    state.lead.appendToSessionFile(state.coop, event);
    state.lead.saveSessionFile(state.coop, { durable: true });
    var ref = { projectId: "system-lead", sessionStorageId: state.coop.storageId };
    state.ledger.record({ ingressId: ingressId, ingressSequence: index + 1, ingressKind: "text", sessionRef: ref,
      requestRef: Object.assign({}, ref, { eventIndex: index }), topicRef: topic, projectRefs: [{ projectId: PROJECT }] });
    state.ledger.classify(ingressId, { kind: "existing_topic", topicRef: topic, projectRefs: [{ projectId: PROJECT }],
      implementationDecision: lifecycle.explicitImplementationDecision(event.text) });
    return { source: ref, coopIngressId: ingressId, coopTopicRef: topic,
      portfolioTaskId: "assignment-" + (suffix || index), bindingRevision: 1,
      idempotencyKey: "assignment-" + (suffix || index) + "-r1", mode: "project_coordinator",
      targetProject: { projectId: PROJECT }, title: "Implement the approved change",
      objective: "Implement the approved project change.", context: "Keep ordinary work usable.",
      acceptanceCriteria: "The change passes its focused verification.", ownedPaths: "lib/example.js",
      provider: "codex", model: "gpt-5.6-terra" };
  };
  state.query = async function () {
    return waitFor(function () { return state.providerQueries[state.providerQueries.length - 1]; });
  };
  state.accept = async function (taskRef) {
    var query = await state.query();
    var result = await query.options.callMcpTool(assignmentMcp.SERVER_NAME, "accept_project_assignment", { taskRef: taskRef });
    return JSON.parse(result.content[0].text);
  };
  t.after(async function () {
    cleanups.forEach(function (cleanup) { cleanup(); });
    await new Promise(function (resolve) { setImmediate(resolve); });
  });
  return state;
}

module.exports = { fixture: fixture, waitFor: waitFor, PROJECT: PROJECT, OTHER: OTHER };
