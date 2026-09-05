var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var os = require('os');
var requestsModule = require('../lib/coop-owner-requests');
var loop = require('../lib/lead-loop');
var mcp = require('../lib/coop-control-ledger-reconciliation-mcp-server');
var conversation = require('../lib/coop-conversation-control');
var COOP = '871a194b-8879-40f7-a1fe-656e48e722af';

[1, 16, 17, 20, 32, 65].forEach(function (count) {
  test('all ' + count + ' owner requests can be linked and answered in one scheduled Lead turn', async function (t) {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clay-owner-batch-case-'));
    t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
    var ledger = requestsModule.attachCoopOwnerRequests({file: path.join(dir, 'requests.json')});
    var session = {coopHome: true, storageId: COOP, localId: 7, isProcessing: true, history: [],
      coopConversationIngress: {nextSequence: count+1, recent: [], activeIngressId: null}};
    for (var i=0;i<count;i++) {
      var ingressId = 'coop:' + COOP + ':' + (i+1);
      var eventIndex = session.history.length;
      session.history.push({type:'user_message',text:'Owner request ' + (i+1),coopIngressId:ingressId,_ts:100+i});
      ledger.record({ingressId:ingressId,ingressSequence:i+1,
        sessionRef:{projectId:'system-lead',sessionStorageId:COOP},
        requestRef:{projectId:'system-lead',sessionStorageId:COOP,eventIndex:eventIndex}});
    }
    session.history.push({type:'user_message',text:'Run one Lead tick',autoAction:true,synthetic:true,_ts:200});
    var sm = {sessions:new Map([[7,session]]),getProjectId:function(){return 'system-lead';},
      saveSessionFile:function(value){fs.writeFileSync(path.join(dir,'session.json'),JSON.stringify(value));return true;}};
    var definitions = mcp.getToolDefs({sm:sm,ownerRequests:ledger,topicIndex:{}});
    var tool = definitions.find(function(def){return def.name==='link_owner_response';});
    var decision = loop.leadTick({unansweredRequests:ledger.unanswered()}).find(function(d){return d.action==='answer_owner';});
    assert.equal(decision.responseLink.totalRequests,count);
    for (var b=0;b<decision.responseLink.batches.length;b++) {
      var output = await tool.handler({sessionId:COOP,requests:decision.responseLink.batches[b]});
      var parsed = JSON.parse(output.content[0].text);
      assert.equal(parsed.ok,true,'batch ' + (b+1) + ' rejected: ' + parsed.code);
      session = JSON.parse(fs.readFileSync(path.join(dir,'session.json'),'utf8'));
      sm.sessions.set(7,session);
      var replay = JSON.parse((await tool.handler({sessionId:COOP,
        requests:decision.responseLink.batches[b]})).content[0].text);
      assert.equal(replay.ok,true);
      assert.equal(replay.duplicate,true,'replaying any accepted batch is idempotent');
    }
    session.history.push({type:'delta_replace',text:'Answers to every request.',_ts:250});
    session.history.push({type:'done',code:0,_ts:300});
    var controller = conversation.attachCoopConversationControl({coopOwnerRequests:ledger,sm:sm,sendToSession:function(){}});
    assert.equal(controller.markAnswered(session),true);
    assert.equal(ledger.unanswered().length,0,'No requests should remain unanswered');
  });
});
