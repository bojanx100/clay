var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var os = require("node:os");
var path = require("node:path");
var createCrossProjectRouter = require("../lib/server-cross-project").createCrossProjectRouter;
var createPortfolioExecutionBindings =
  require("../lib/portfolio-execution-bindings").createPortfolioExecutionBindings;

test("one Coop projection shares one execution-binding snapshot across status reads", function () {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), "clay-coop-startup-"));
  var realStore = createPortfolioExecutionBindings({
    file: path.join(directory, "bindings.json"),
  });
  var bindingStore = Object.create(realStore);
  var listCalls = 0;
  bindingStore.list = function () {
    listCalls += 1;
    return realStore.list();
  };
  var router = createCrossProjectRouter({
    bindingStore: bindingStore,
    sessionLedgerFile: path.join(directory, "session-ledger.json"),
  });
  var snapshots = [];
  router.withExecutionBindingSnapshot(function () {
    snapshots.push(router.getExecutionBindings());
    router.reconcileSessionLedger();
    snapshots.push(router.getExecutionBindings());
  });

  assert.equal(listCalls, 1,
    "startup projection must deep-clone the binding store only once");
  assert.strictEqual(snapshots[0], snapshots[1],
    "all synchronous projection readers share the isolated snapshot");
  assert.notStrictEqual(router.getExecutionBindings(), snapshots[0],
    "the shared snapshot cannot leak beyond the projection build");
  assert.equal(listCalls, 2);

  var source = fs.readFileSync(path.join(__dirname, "../lib/server.js"), "utf8");
  var wrapperStart = source.indexOf("function globalCoopProjectionFor(ws)");
  var projection = source.slice(wrapperStart,
    source.indexOf("\n  }\n\n  function refreshCanonicalCoopTopics", wrapperStart));
  assert.match(projection,
    /!crossProject\.hasExecutionBindingSnapshot\(\)[\s\S]*?withExecutionBindingSnapshot\(function \(\) \{[\s\S]*?globalCoopProjectionFor\(ws\)/,
    "every initial and live global Coop projection must enter the shared snapshot scope");
});

test("the first session switch preserves text and attachment-only drafts typed during load", async function () {
  var handlers = await import("../lib/public/modules/app-messages-sessions-handlers.js");
  var textDraft = { text: "typed while Coop loads", images: [], pastes: [], files: [] };
  var imageDraft = { text: "", images: ["data:image/png;base64,abc"], pastes: [], files: [] };

  assert.strictEqual(handlers.initialDraftForSessionSwitch(null, textDraft), textDraft);
  assert.strictEqual(handlers.initialDraftForSessionSwitch(null, imageDraft), imageDraft);
  assert.equal(handlers.initialDraftForSessionSwitch(null, {
    text: "", images: [], pastes: [], files: [],
  }), null);
  assert.equal(handlers.initialDraftForSessionSwitch(7, textDraft), null,
    "ordinary session switches continue using their keyed per-session draft");

  var source = fs.readFileSync(path.join(__dirname,
    "../lib/public/modules/app-messages-sessions.js"), "utf8");
  var handlerStart = source.indexOf("function handleSessionSwitched(msg)");
  var handlerEnd = source.indexOf("\n}\n\nfunction applySessionVendor", handlerStart);
  var sessionSwitch = source.slice(handlerStart, handlerEnd);
  assert.match(sessionSwitch,
    /initialDraftForSessionSwitch\(prevSid, getInputDraft\(\)\)/);
  assert.match(sessionSwitch,
    /resetClientState\(\);[\s\S]*?if \(initialDraft\) \{[\s\S]*?restoreInputDraft\(initialDraft\);[\s\S]*?saveInputDraftForSession/,
    "the live draft must be restored and keyed after reset clears the composer");
});
