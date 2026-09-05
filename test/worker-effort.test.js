var test=require("node:test");
var assert=require("node:assert/strict");
var handlers=require("../lib/orchestration-tool-handlers");
var graph=require("../lib/orchestration-task-graph");
var routing=require("../lib/adaptive-worker-routing");

test("delegation preserves an explicit worker effort without changing the parent or defaults",function(){
  ["medium","high"].forEach(function(effort){
    var parent={localId:1,model:"gpt-5.6-terra",effort:"xhigh",orchestrationTasks:[],orchestrationEvents:[]};
    var api=handlers.createToolHandlers({
      error:function(text){throw new Error(text);},success:function(text){return text;},
      ensureCoordinatorForInput:function(){return parent;},schedule:function(){}
    });
    api.delegate({coordinatorSessionId:1,title:"Measured trial",objective:"Implement a bounded fixture",context:"Independent trial",acceptanceCriteria:"Pass the oracle",ownedPaths:"read-only: fixture",provider:"codex",model:"gpt-5.6-terra",effort:effort});
    var persisted=JSON.parse(JSON.stringify(parent));
    var task=persisted.orchestrationTasks[0];
    var sm={currentEffort:"high"};
    var worker=routing.prepareWorkerSession(sm,persisted,task,"trial-worker");
    assert.equal(task.effort,effort);
    assert.equal(worker.effort,effort);
    assert.equal(parent.effort,"xhigh");
    assert.equal(sm.currentEffort,"high");
  });
});

test("planned worker effort survives dependency scheduling and omitted effort keeps defaults",function(){
  var parent={localId:1,orchestrationTasks:[],orchestrationEvents:[]};
  var task=graph.createTask(parent,{title:"Routine",objective:"Fixture",effort:"medium"});
  assert.equal(task.effort,"medium");
  var defaultTask=graph.createTask(parent,{title:"Default",objective:"Fixture"});
  assert.equal(routing.prepareWorkerSession({},parent,defaultTask,"default-worker").effort,null);
});
