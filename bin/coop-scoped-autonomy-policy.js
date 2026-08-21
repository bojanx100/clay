#!/usr/bin/env node
// Provision the one durable scoped-autonomy grant from an exact owner ingress.
// This command never accepts approval text as evidence: it loads the canonical
// owner-request record and exactly one canonical owner event before writing.

var fs = require("fs");
var os = require("os");
var path = require("path");
var policyModule = require("../lib/coop-scoped-autonomy-policy");

function fail(message) {
  process.stderr.write(message + "\n");
  process.exitCode = 1;
}

function argument(name) {
  var index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return "";
  return String(process.argv[index + 1] || "").trim();
}

function defaultOwnerRequestsFile() {
  return path.join(os.homedir(), ".clay", "lead", "coop-owner-requests.json");
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { return null; }
}

function ownerRequestFor(file, ingressId) {
  var parsed = readJson(file);
  var raw = parsed && parsed.requests;
  var requests = Array.isArray(raw) ? raw : [];
  if (!Array.isArray(raw) && raw && typeof raw === "object") {
    var keys = Object.keys(raw);
    for (var i = 0; i < keys.length; i++) requests.push(raw[keys[i]]);
  }
  var found = null;
  for (var j = 0; j < requests.length; j++) {
    if (!requests[j] || requests[j].ingressId !== ingressId) continue;
    if (found) return null;
    found = requests[j];
  }
  return found;
}

function ownerEventFor(file, ingressId) {
  var raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { return null; }
  var lines = raw.split("\n");
  var found = null;
  for (var i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    var event;
    try { event = JSON.parse(lines[i]); }
    catch (error) { return null; }
    if (!event || event.coopIngressId !== ingressId) continue;
    if (found) return null;
    found = event;
  }
  return found;
}

function main() {
  var ingressId = argument("--owner-ingress");
  var authorizationTaskId = argument("--authorization-task");
  var historyFile = argument("--history");
  if (!ingressId || !authorizationTaskId || !historyFile) {
    fail("Usage: coop-scoped-autonomy-policy --owner-ingress <ingress-id> " +
      "--authorization-task <portfolio-task-id> [--owner-requests <file>] " +
      "--history <canonical-coop.jsonl> [--owner-requests <file>] [--policy-file <file>]");
    return;
  }
  var ownerRequestsFile = argument("--owner-requests") || defaultOwnerRequestsFile();
  var policyFile = argument("--policy-file") || policyModule.defaultFile();
  var ownerRequest = ownerRequestFor(ownerRequestsFile, ingressId);
  var ownerEvent = ownerEventFor(historyFile, ingressId);
  if (!ownerRequest || !ownerEvent) {
    fail("Exact owner provenance is unavailable or ambiguous; no policy was written.");
    return;
  }
  var result = policyModule.createPolicyStore({ file: policyFile }).activate({
    authorizationTaskId: authorizationTaskId,
    ownerRequest: ownerRequest,
    ownerEvent: ownerEvent,
  });
  if (!result.ok) {
    fail("Scoped autonomy policy was not activated: " + result.reason);
    return;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    reused: result.reused === true,
    policyFile: policyFile,
    grant: result.grant,
  }) + "\n");
}

main();
