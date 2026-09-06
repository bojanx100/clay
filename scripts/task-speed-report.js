#!/usr/bin/env node
var fs = require("fs");
var path = require("path");
var os = require("os");
var readline = require("readline");
var reportModule = require("../lib/task-speed-report");

async function recentLines(file, since, json) {
  if (!fs.existsSync(file)) return [];
  var rows = [];
  var reader = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (var line of reader) {
    if (json) {
      try { var row = JSON.parse(line); if (row.at >= since) rows.push(row); } catch (error) {}
    } else {
      var match = line.match(/\]\s+(\S+)/);
      if (match && Date.parse(match[1]) >= since) rows.push(line);
    }
  }
  return rows;
}

async function main(argv) {
  var args = argv || process.argv.slice(2);
  var home = process.env.CLAY_HOME || path.join(os.homedir(), ".clay");
  var mode = args.indexOf("--prod") >= 0 ? "" : "-dev";
  var hoursIndex = args.indexOf("--hours");
  var hours = hoursIndex >= 0 ? Number(args[hoursIndex+1]) : 24;
  if (!(hours > 0 && hours <= 720)) throw new Error("--hours must be between 0 and 720");
  var now = Date.now();
  var since = now-hours*2*3600000;
  var data = await Promise.all([
    recentLines(path.join(home, "turn-performance" + mode + ".jsonl"), since, true),
    recentLines(path.join(home, "diag" + mode + ".log"), since, false),
  ]);
  var report = reportModule.buildReport(data[0],data[1],{ now:now,hours:hours });
  var output = args.indexOf("--json") >= 0 ? JSON.stringify(report,null,2)+"\n" : reportModule.markdown(report);
  var outputIndex = args.indexOf("--output");
  if (outputIndex >= 0) {
    if (!args[outputIndex+1]) throw new Error("--output requires a path");
    fs.writeFileSync(args[outputIndex+1], output);
  } else process.stdout.write(output);
  return report;
}

if (require.main === module) main().catch(function(error) { console.error(error.message);process.exitCode=1; });
module.exports = { main: main, recentLines: recentLines };
