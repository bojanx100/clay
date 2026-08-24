#!/usr/bin/env node
// Scripted contract coverage for Coop's staffing and spend authority disclosure.
var test = require("node:test");
var assert = require("node:assert");
var fs = require("fs");
var path = require("path");

var repoRoot = path.join(__dirname, "..");
var contractFiles = [
  path.join(repoRoot, ".claude/skills/lead-tick/SKILL.md"),
];
var startMarker = "<!-- coop-authority-contract:start -->";
var endMarker = "<!-- coop-authority-contract:end -->";
var onDisclosure = "Lead mode is on: I can autonomously staff admitted, non-self-modification work within budget; self-modification, unadmitted approval-class work, and spend or budget exceptions require owner approval.";
var offDisclosure = "Lead mode is off: I cannot staff work or authorize spend. I can still find, triage, or switch to sessions.";

function readContract(file) {
  var source = fs.readFileSync(file, "utf8");
  var start = source.indexOf(startMarker);
  var end = source.indexOf(endMarker);
  assert.notStrictEqual(start, -1, path.relative(repoRoot, file) + " has a contract start marker");
  assert.ok(end > start, path.relative(repoRoot, file) + " has a contract end marker");
  return source.slice(start + startMarker.length, end).trim();
}

function includesAll(source, phrases) {
  return phrases.every(function (phrase) {
    return source.indexOf(phrase) !== -1;
  });
}

function parseContract(source) {
  return {
    staffingSpendScope: includesAll(source, [
      "acts on, declines, or discusses",
      "proposals, approvals, declines, staffing reports, and budget discussions",
    ]),
    routineExcluded: includesAll(source, [
      "routine technical answers",
      "ordinary conversation",
      "status reports unrelated to staffing or spend",
    ]),
    onDisclosure: source.indexOf(onDisclosure) !== -1,
    autonomousAdmittedWithinBudget: source.indexOf("autonomously staff admitted, non-self-modification work within budget") !== -1,
    gatesSelfModification: source.indexOf("self-modification, unadmitted approval-class work, and spend or budget exceptions require owner approval") !== -1,
    offDisclosure: source.indexOf(offDisclosure) !== -1,
    offNamesReason: source.indexOf("Lead mode is off") !== -1,
    offDeclinesAuthority: source.indexOf("cannot staff work or authorize spend") !== -1,
    offCoordinationAllowed: source.indexOf("may find, triage, or switch") !== -1,
    directOwnerSessionsPreserved: includesAll(source, [
      "direct owner sessions",
      "Never adopt, reroute, or place them under Coop unless the owner explicitly hands them to Coop",
    ]),
  };
}

function evaluateLeadOff(contract) {
  return {
    decision: contract.offDeclinesAuthority ? "decline" : "undefined",
    reason: contract.offNamesReason ? "lead_mode_off" : "missing",
    discloseAuthority: contract.offDisclosure,
    response: contract.offDisclosure ? offDisclosure : "",
  };
}

function evaluateLeadOn(contract, exchange) {
  var gated = exchange.selfModification || exchange.unadmittedApproval || exchange.spendException;
  var autonomous = exchange.admitted && exchange.withinBudget && !gated;
  return {
    decision: gated && contract.gatesSelfModification ? "require_owner_approval" :
      (autonomous && contract.autonomousAdmittedWithinBudget ? "staff_autonomously" : "undefined"),
    discloseAuthority: contract.onDisclosure,
    response: contract.onDisclosure ? onDisclosure : "",
  };
}

function evaluateExchange(contract, exchange) {
  if (exchange.kind === "routine") {
    return { decision: "answer", discloseAuthority: !contract.routineExcluded };
  }
  if (exchange.kind === "coordination") {
    return {
      decision: contract.offCoordinationAllowed ? "coordinate" : "undefined",
      discloseAuthority: false,
    };
  }
  if (!contract.staffingSpendScope) {
    return { decision: "undefined", discloseAuthority: false };
  }
  return exchange.leadMode ? evaluateLeadOn(contract, exchange) : evaluateLeadOff(contract);
}

var scriptedExchanges = [
  {
    name: "OFF-mode staffing request",
    exchange: { kind: "staffing", leadMode: false },
    expected: {
      decision: "decline",
      reason: "lead_mode_off",
      discloseAuthority: true,
      response: offDisclosure,
    },
  },
  {
    name: "ON-mode admitted within-budget staffing",
    exchange: { kind: "staffing", leadMode: true, admitted: true, withinBudget: true },
    expected: {
      decision: "staff_autonomously",
      discloseAuthority: true,
      response: onDisclosure,
    },
  },
  {
    name: "ON-mode self-modification",
    exchange: {
      kind: "staffing", leadMode: true, admitted: true, withinBudget: true,
      selfModification: true,
    },
    expected: {
      decision: "require_owner_approval",
      discloseAuthority: true,
      response: onDisclosure,
    },
  },
  {
    name: "ON-mode unadmitted approval-class work",
    exchange: {
      kind: "staffing", leadMode: true, admitted: false, withinBudget: true,
      unadmittedApproval: true,
    },
    expected: {
      decision: "require_owner_approval",
      discloseAuthority: true,
      response: onDisclosure,
    },
  },
  {
    name: "ON-mode spend exception",
    exchange: {
      kind: "spend", leadMode: true, admitted: true, withinBudget: false,
      spendException: true,
    },
    expected: {
      decision: "require_owner_approval",
      discloseAuthority: true,
      response: onDisclosure,
    },
  },
  {
    name: "OFF-mode session switch",
    exchange: { kind: "coordination", leadMode: false, action: "switch" },
    expected: { decision: "coordinate", discloseAuthority: false },
  },
  {
    name: "ordinary technical answer",
    exchange: { kind: "routine", leadMode: false },
    expected: { decision: "answer", discloseAuthority: false },
  },
];

test("Lead procedure publishes its Coop authority contract", function () {
  var contracts = contractFiles.map(readContract);
  assert.strictEqual(parseContract(contracts[0]).directOwnerSessionsPreserved, true);
});

test("scripted ON/OFF exchanges evaluate authority, gates, and quiet scope", function () {
  contractFiles.forEach(function (file) {
    var contract = parseContract(readContract(file));
    scriptedExchanges.forEach(function (script) {
      assert.deepStrictEqual(
        evaluateExchange(contract, script.exchange),
        script.expected,
        path.relative(repoRoot, file) + ": " + script.name,
      );
    });
  });
});

test("authority contract test remains directly executable", function () {
  if (process.platform === "win32") return;
  assert.notStrictEqual(fs.statSync(__filename).mode & 0o111, 0);
});
