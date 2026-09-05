#!/usr/bin/env node
// Small matched coding fixtures. The oracle runs separately from worker claims.
var fs=require("fs");
var path=require("path");
var os=require("os");
var vm=require("vm");
var specs={
  dedupe:"Export function dedupeById(records) using CommonJS module.exports. Return the first object for each distinct valid id, preserving order and original object references. A valid id is a finite number (including 0) or a nonempty string (do not trim it). Number 1 and string '1' are distinct. Ignore null, arrays, nonobjects and objects with invalid/missing ids. Nonarray input returns []. Do not mutate input or objects.",
  delay:"Export function retryDelay(attempt, baseMs, capMs) using CommonJS module.exports. Attempt must be a positive safe integer, baseMs a finite nonnegative number, and capMs a finite number >= baseMs. Throw RangeError for every invalid argument, including nonnumbers. Return min(capMs, baseMs * 2**(attempt-1)). Zero base always returns zero, even when the exponent would overflow. No randomness or IO.",
  duration:"Export function parseDuration(value) using CommonJS module.exports. Accept strings consisting of a nonnegative decimal number (digits required before an optional decimal point and digits required after it) followed immediately by ms, s, or m, case-insensitive. Allow surrounding whitespace but no internal spaces. Return milliseconds rounded to the nearest integer. Reject invalid types/formats, negative numbers, nonfinite values or nonfinite converted results with null. No IO.",
};
var cases={
  dedupe:[
    "fn(null).length===0",
    "JSON.stringify(fn([{id:0},{id:0},{id:1},{id:'1'},{id:''},null,[],{id:NaN},{id:Infinity},{id:' '},{}]))===JSON.stringify([{id:0},{id:1},{id:'1'},{id:' '}])",
    "(function(){var a={id:'x',n:1};var b={id:'x',n:2};var rows=[a,b];return fn(rows)[0]===a&&rows.length===2&&b.n===2;})()",
    "fn([{id:'__proto__'},{id:'constructor'},{id:'__proto__'}]).length===2",
    "fn([{id:false},{id:true},{id:null},{id:undefined},{id:-1}]).length===1"
  ],
  delay:[
    "fn(1,100,1000)===100", "fn(4,100,1000)===800", "fn(5,100,1000)===1000",
    "fn(2000,1,1000)===1000", "fn(2000,0,1000)===0",
    "[[0,1,2],[-1,1,2],[1.5,1,2],['1',1,2],[1,NaN,2],[1,Infinity,2],[1,-1,2],[1,2,1],[1,1,Infinity],[Number.MAX_SAFE_INTEGER+1,1,2],[1,1,'2']].every(function(args){try{fn.apply(null,args);return false;}catch(e){return e.name==='RangeError';}})"
  ],
  duration:[
    "fn('250ms')===250", "fn('1.5s')===1500", "fn(' 2M ')===120000",
    "fn('0.0005s')===1", "fn('0ms')===0", "fn('001.50s')===1500",
    "[null,1,{},[],true,'-1s','1 s','.5s','1.s','1e2s','Infinitys','1h','s',''].every(function(x){return fn(x)===null;})",
    "fn('9'.repeat(400)+'m')===null"
  ],
};

function prepare(directory) {
  if(fs.existsSync(path.join(directory,"manifest.json")))throw new Error("Trial already exists; reuse its manifest instead of duplicating workers.");
  fs.mkdirSync(directory,{recursive:true});
  var jobs=[];
  Object.keys(specs).forEach(function(fixture,index){
    var order=index%2?["high","medium"]:["medium","high"];
    order.forEach(function(effort){
      var id=fixture+"-"+effort;
      var folder=path.join(directory,id);
      fs.mkdirSync(folder,{recursive:true});
      var candidate=path.join(folder,"candidate.js");
      fs.writeFileSync(path.join(folder,"SPEC.md"),specs[fixture]+"\n");
      jobs.push({ref:id,fixture:fixture,effort:effort,candidate:candidate,
        objective:"Implement this isolated routine coding fixture in "+candidate+". "+specs[fixture]+" Run a short smoke check and finish. This is a temporary benchmark artifact, not a repository change: do not use skills, inspect unrelated files, create worktrees, commit, push, delegate, or modify live Clay state. Do not read sibling trial directories or the independent scoring script. Keep the final response under 60 words."});
    });
  });
  var manifest={schema:"clay.task_speed_trial.v1",createdAt:Date.now(),model:"gpt-5.6-terra",jobs:jobs};
  fs.writeFileSync(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
  return manifest;
}

function score(directory,records) {
  var manifest=JSON.parse(fs.readFileSync(path.join(directory,"manifest.json"),"utf8"));
  var results=manifest.jobs.map(function(job){
    var checks=cases[job.fixture];
    var errors=[];
    var passed=0;
    try{
      var source=fs.readFileSync(job.candidate,"utf8");
      if(source.length>65536)throw new Error("Candidate exceeds fixture limit");
      checks.forEach(function(check,index){
        try{
          var context=vm.createContext({module:{exports:{}}});
          vm.runInContext(source+"\n;var fn=module.exports;",context,{timeout:1000});
          if(vm.runInContext(check,context,{timeout:1000})!==true)throw new Error("assertion returned false");
          passed++;
        }catch(error){errors.push("check "+(index+1)+": "+error.message);}
      });
    }catch(error){errors.push(error.message);}
    var timing=(records||[]).filter(function(row){return row.sessionId===job.workerStorageId&&row.startedAt>=manifest.createdAt;});
    var valid=timing.length===1&&timing[0].outcome==="completed"&&timing[0].effort===job.effort&&timing[0].model===manifest.model;
    return {ref:job.ref,fixture:job.fixture,effort:job.effort,workerStorageId:job.workerStorageId||null,
      passed:passed,total:checks.length,correct:passed===checks.length,errors:errors,
      timingVerified:valid,totalMs:valid?timing[0].totalMs:null};
  });
  var groups={};
  ["medium","high"].forEach(function(effort){
    var rows=results.filter(function(row){return row.effort===effort;});
    var durations=rows.filter(function(row){return row.timingVerified;}).map(function(row){return row.totalMs;}).sort(function(a,b){return a-b;});
    groups[effort]={correct:rows.filter(function(row){return row.correct;}).length,total:rows.length,verifiedTimings:durations.length,medianMs:durations.length===3?durations[1]:null};
  });
  return {schema:"clay.task_speed_trial_result.v1",at:Date.now(),model:manifest.model,results:results,groups:groups,
    recommendation:"Pilot only: retain current defaults. Collect at least 30 matched pairs with independent correctness checks before a permanent change."};
}

function main(args){
  var directory=args[1];
  if(!directory||["--prepare","--score"].indexOf(args[0])<0)throw new Error("Use --prepare DIRECTORY or --score DIRECTORY");
  if(args[0]==="--prepare")return prepare(directory);
  var home=process.env.CLAY_HOME||path.join(os.homedir(),".clay");
  var file=path.join(home,"turn-performance-dev.jsonl");
  var rows=fs.existsSync(file)?fs.readFileSync(file,"utf8").trim().split("\n").map(function(line){try{return JSON.parse(line);}catch(e){return {};}}):[];
  var result=score(directory,rows);
  fs.writeFileSync(path.join(directory,"results.json"),JSON.stringify(result,null,2)+"\n");
  return result;
}
if(require.main===module){try{console.log(JSON.stringify(main(process.argv.slice(2)),null,2));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={prepare:prepare,score:score};
