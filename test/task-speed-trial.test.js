var test=require("node:test");
var assert=require("node:assert/strict");
var fs=require("fs");
var os=require("os");
var path=require("path");
var trial=require("../scripts/task-speed-trial");

test("matched trial refuses duplicates, rejects wrong code and does not invent missing timings",function(){
  var directory=fs.mkdtempSync(path.join(os.tmpdir(),"clay-trial-oracle-"));
  try{
    var manifest=trial.prepare(directory);
    assert.equal(manifest.jobs.length,6);
    assert.throws(function(){trial.prepare(directory);},/already exists/);
    manifest.jobs.forEach(function(job){fs.writeFileSync(job.candidate,"module.exports=function(){return null;};");});
    var result=trial.score(directory,[]);
    assert.equal(result.groups.medium.correct,0);
    assert.equal(result.groups.high.correct,0);
    assert.equal(result.groups.medium.verifiedTimings,0);
    assert.equal(result.groups.medium.medianMs,null);
    assert.ok(result.results.every(function(row){return row.errors.length>0;}));
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
