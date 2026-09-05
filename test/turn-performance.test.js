var test = require("node:test");
var assert = require("node:assert/strict");
var performance = require("../lib/turn-performance");
var report = require("../lib/task-speed-report");

test("turn accounting measures queue, model, overlapping tools, verification and completion exactly once", function () {
  var session = { storageId:"trial",vendor:"codex",_turnQueuedAt:80,effort:"high" };
  performance.begin(session,100);
  performance.configure(session,{model:"gpt-5.6-terra",effort:"medium"});
  performance.observe(session,{yokeType:"thinking_delta",text:"never persist private content"},120);
  performance.observe(session,{yokeType:"tool_start",toolId:"a",toolName:"Bash",input:{command:"rg value lib"}},140);
  performance.observe(session,{yokeType:"tool_start",toolId:"b",toolName:"Bash",input:{command:"node --test test/example.test.js"}},150);
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
