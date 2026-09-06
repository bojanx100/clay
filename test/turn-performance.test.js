var test = require("node:test");
var assert = require("node:assert/strict");
var performance = require("../lib/turn-performance");
var report = require("../lib/task-speed-report");

test("turn accounting measures queue, model, overlapping tools, verification and completion exactly once", function () {
  var session = { storageId:"trial",vendor:"codex",_turnQueuedAt:80,effort:"high" };
  performance.begin(session,100);
  performance.configure(session,{model:"gpt-5.6-terra",effort:"medium"});
  performance.observe(session,{yokeType:"thinking_delta",text:"never persist private content"},120);
  performance.observe(session,{yokeType:"tool_executing",toolId:"a",toolName:"Bash",input:{command:"rg value lib"}},140);
  performance.observe(session,{yokeType:"tool_executing",toolId:"b",toolName:"Bash",input:{command:"node --test test/example.test.js"}},150);
  performance.observe(session,{yokeType:"tool_result",toolId:"a"},160);
  performance.observe(session,{yokeType:"tool_result",toolId:"b"},190);
  performance.observe(session,{yokeType:"text_delta"},200);
  performance.observe(session,{yokeType:"result"},210);
  var rows = [];
  var result = performance.finish(session,null,210,function(row){rows.push(row);});
  assert.equal(result.queueMs,20);
  assert.equal(result.providerWaitMs,20);
  assert.equal(result.modelAndTransportMs,40);
  assert.equal(result.toolMs,10);
  assert.equal(result.verificationMs,40);
  assert.equal(result.totalMs,110);
  assert.equal(result.toolCalls,2);
  assert.equal(result.verificationCalls,1);
  assert.equal(result.effort,"medium");
  assert.equal(result.correctness,"unverified");
  assert.equal(result.outcome,"completed");
  assert.equal(JSON.stringify(result).includes("private"),false);
  assert.equal(performance.finish(session,null,215,function(row){rows.push(row);}),null);
  assert.equal(rows.length,1);
  performance.begin(session,300);
  assert.equal(session._performanceTurn.queueMs,null,"warm turn must not reuse the prior queue timestamp");
  performance.finish(session,"interrupted",305,function(){});
});

test("failed, incomplete and interrupted turns do not become successful timing samples", function () {
  ["failed","incomplete","interrupted"].forEach(function(outcome){
    var session = {storageId:outcome,taskStopRequested:outcome==="interrupted"};
    performance.begin(session,100);
    if(outcome==="failed")performance.observe(session,{yokeType:"error"},110);
    var row=performance.finish(session,null,120,function(){});
    assert.equal(row.outcome,outcome);
    var summary=report.buildReport([row],[],{now:130,hours:1});
    assert.equal(summary.current.completed,0);
    assert.equal(summary.current.timing.totalMs.median,null);
  });
});

test("report deduplicates turns, separates model/effort groups, and excludes sleep intervals", function () {
  var now=Date.parse("2026-09-06T12:00:00Z");
  var rows=[];
  function add(id,at,duration,effort){rows.push({schema:"clay.turn_performance.v1",turnId:id,at:at,startedAt:at-duration,totalMs:duration,outcome:"completed",vendor:"codex",model:"terra",effort:effort});}
  for(var i=0;i<5;i++){
    add("before-"+i,now-25*3600000-i*10000,1000,"medium");
    add("after-"+i,now-i*10000,3000,"medium");
  }
  add("high",now,1000,"high");
  add("sleep",now-3600000,60000,"medium");
  rows.push(rows[0]);
  var result=report.buildReport(rows,["[SLEEP-WAKE] 2026-09-06T11:00:00.000Z clock jumped ~50000ms (system sleep/suspend)",
    "[LOOP-LAG] 2026-09-06T11:30:00.000Z event loop blocked ~800ms",
    "[LOOP-LAG] 2026-09-06T11:31:00.000Z max lag last 60s: 800ms"],{now:now,hours:24});
  assert.equal(result.current.samples,6);
  assert.equal(result.sleepExcluded,1);
  assert.equal(result.diagnostics.stallsOver500ms,1);
  assert.equal(result.comparisons.length,2);
  assert.equal(result.comparisons.find(function(g){return g.route.endsWith("medium");}).medianDeltaMs,2000);
  assert.equal(result.warnings.length,2);
  assert.match(report.markdown(result),/Completion is not correctness/);
  assert.match(report.markdown(report.buildReport([],[],{now:now})),/No measured turns/);
});

test("the real watchdog, provider stream and persisted done path feed the timing collector", async function () {
  var fs=require("fs");
  var watchdog=require("../lib/sdk-bridge-stream-watchdog");
  var original=fs.appendFile;
  var captured=[];
  fs.appendFile=function(file,data,callback){captured.push(JSON.parse(data));callback(null);};
  try {
    var session={localId:7,storageId:"wired",history:[],_turnQueuedAt:90,isProcessing:true};
    watchdog.beginTurn(session,100);
    assert.equal(session._performanceTurn.queueMs,10);
    var io=require("../lib/sessions-io").attachSessionIo({
      send:function(){},sendEach:function(){},appendToSessionFile:function(){return true;},
      isMeaninglessUnknownError:function(){return false;},onSessionDone:function(){}
    });
    session.queryInstance=(async function*(){yield {yokeType:"text_delta",text:"hello"};yield {yokeType:"result"};})();
    await require("../lib/sdk-bridge-stream-events").consumeStream({
      processSDKMessage:function(current,event){if(event.yokeType==="result")io.sendAndRecord(current,{type:"done",code:0});}
    },watchdog.createState(session));
    assert.equal(captured.length,1);
    assert.equal(captured[0].outcome,"completed");
    assert.notEqual(captured[0].firstTextMs,null);
  }finally{fs.appendFile=original;}
});

test("Claude argument streaming and message-wrapped results use real recorded execution boundaries", function () {
  var flatten = require("../lib/yoke/adapters/claude-events").flattenEvent;
  var clock = Date.now;
  var now = 100;
  Date.now = function () { return now; };
  try {
    var session = { localId: 8, storageId: "claude-phases", history: [], blocks: {},
      sentToolResults: {}, pendingPermissions: {}, responsePreview: "", messageUUIDs: [] };
    performance.begin(session, now);
    performance.configure(session, { model: "claude-opus-5", effort: "medium" }, "claude");
    var io = require("../lib/sessions-io").attachSessionIo({
      send: function () {}, sendEach: function () {}, appendToSessionFile: function () { return true; },
      isMeaninglessUnknownError: function () { return false; }, onSessionDone: function () {}
    });
    var processor = require("../lib/sdk-message-processor").attachMessageProcessor({
      sm: { sendAndRecord: io.sendAndRecord, sendToSession: function () {} },
      send: function () {}, adapter: { vendor: "claude" }, cwd: process.cwd(), opts: {}
    });
    function emit(at, raw) {
      now = at;
      var event = flatten(raw);
      performance.observe(session, event, at);
      processor.processSDKMessage(session, event);
    }
    emit(120, { type: "stream_event", event: { type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: "check", name: "Bash" } } });
    emit(180, { type: "stream_event", event: { type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"command":"node --test test/example.test.js"}' } } });
    emit(200, { type: "stream_event", event: { type: "content_block_stop", index: 0 } });
    emit(220, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "check", content: "passed" }] } });
    now = 250;
    processor.processSDKMessage(session, { yokeType: "plan_updated", turnId: "plan", plan: [] });
    var row = performance.finish(session, "completed", 300, function () {});
    assert.equal(row.providerWaitMs, 20);
    assert.equal(row.verificationMs, 20);
    assert.equal(row.modelAndTransportMs, 160);
    assert.equal(row.toolMs, 0);
    assert.equal(row.toolCalls, 1);
    assert.equal(row.vendor, "claude");
    assert.equal(row.phaseVersion, 2);
    assert.equal(row.totalMs, 200);
  } finally { Date.now = clock; }
});

test("reports keep old total durations but reject inaccurate legacy phase accounting", function () {
  var common = { schema: "clay.turn_performance.v1", at: 2000, startedAt: 1000,
    totalMs: 1000, outcome: "completed", vendor: "claude", model: "opus", effort: "medium" };
  var legacy = Object.assign({}, common, { turnId: "legacy", toolMs: 900, modelAndTransportMs: 100 });
  var corrected = Object.assign({}, common, { turnId: "corrected", phaseVersion: 2, toolMs: 10, modelAndTransportMs: 990 });
  var before = report.buildReport([legacy], [], { now: 3000, hours: 1 });
  assert.equal(before.current.timing.totalMs.median, 1000);
  assert.equal(before.current.timing.toolMs.median, null);
  var after = report.buildReport([legacy, corrected], [], { now: 3000, hours: 1 });
  assert.equal(after.current.timing.toolMs.median, 10);
  assert.equal(after.current.timing.modelAndTransportMs.median, 990);
});
