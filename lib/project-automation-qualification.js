// Typed, stale-detectable project qualification receipts for issue automation.
//
// A scan nonce can associate a candidate with one scheduler pass, but it cannot
// prove that the issue was open, assigned, correctly classified, and in every
// allowed board column. This module makes those facts an exact receipt that the
// gate, admission, and execution boundary can independently reject when stale.

var crypto = require("crypto");
var projectIdentity = require("./project-identity");

var SCHEMA = "clay.project_automation_qualification_receipt";
var VERSION = 1;
var MAX_RECEIPT_AGE_MS = 5 * 60 * 1000;
var MAX_TEXT = 240;
var ISSUE_CLASSES = ["bug", "feature", "ambiguous"];

function plainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, keys) {
  if (!plainObject(value)) return false;
  var actual = Object.keys(value).sort();
  var expected = keys.slice().sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function text(value, max) {
  var result = typeof value === "string" ? value.trim() : "";
  var limit = Number.isInteger(max) ? max : MAX_TEXT;
  return result && result.length <= limit ? result : "";
}

function canonical(value) {
  if (Array.isArray(value)) {
    var array = [];
    for (var i = 0; i < value.length; i++) array.push(canonical(value[i]));
    return array;
  }
  if (plainObject(value)) {
    var result = {};
    var keys = Object.keys(value).sort();
    for (var j = 0; j < keys.length; j++) result[keys[j]] = canonical(value[keys[j]]);
    return result;
  }
  return value;
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function normalizedTextList(value, allowed) {
  if (!Array.isArray(value) || !value.length) return null;
  var seen = {};
  var result = [];
  for (var i = 0; i < value.length; i++) {
    var item = text(value[i]);
    if (!item) return null;
    item = item.toLowerCase();
    if (allowed && allowed.indexOf(item) === -1) return null;
    if (seen[item]) return null;
    seen[item] = true;
    result.push(item);
  }
  return result.sort();
}

function normalizeClassificationPolicy(value) {
  if (!exactKeys(value, ["autonomous", "ownerApproval"])) return null;
  var autonomous = normalizedTextList(value.autonomous, ISSUE_CLASSES);
  var ownerApproval = normalizedTextList(value.ownerApproval, ISSUE_CLASSES);
  if (!autonomous || !ownerApproval) return null;
  var included = {};
  var i;
  for (i = 0; i < autonomous.length; i++) included[autonomous[i]] = "autonomous";
  for (i = 0; i < ownerApproval.length; i++) {
    if (included[ownerApproval[i]]) return null;
    included[ownerApproval[i]] = "owner_approval";
  }
  for (i = 0; i < ISSUE_CLASSES.length; i++) {
    if (!included[ISSUE_CLASSES[i]]) return null;
  }
  return { autonomous: autonomous, ownerApproval: ownerApproval };
}

// This is the machine-enforced mirror of a project's normal issue intake
// policy. There is intentionally no parser for TRIAGE.local.md or any other
// prose instruction; the config is the complete authority.
function normalizePolicy(value) {
  if (!exactKeys(value, ["version", "normalIssueIntake"]) || value.version !== VERSION) return null;
  var intake = value.normalIssueIntake;
  if (!exactKeys(intake, ["issueStates", "boardStatuses", "requireAllBoardItems", "assignment", "classification"])) {
    return null;
  }
  var issueStates = normalizedTextList(intake.issueStates);
  var boardStatuses = normalizedTextList(intake.boardStatuses);
  var classification = normalizeClassificationPolicy(intake.classification);
  if (!issueStates || !boardStatuses || !classification || intake.requireAllBoardItems !== true ||
      intake.assignment !== "owner") return null;
  return {
    version: VERSION,
    normalIssueIntake: {
      issueStates: issueStates,
      boardStatuses: boardStatuses,
      requireAllBoardItems: true,
      assignment: "owner",
      classification: classification,
    },
  };
}

function policyProfile(policy) {
  return policy && normalizePolicy(policy.qualification);
}

function normalizedProjectRef(value) {
  var ref = projectIdentity.normalizeProjectRef(value);
  return ref ? { projectId: ref.projectId } : null;
}

function parseItemKey(value) {
  var key = text(value);
  var match = key.match(/^([^\s/#]+\/[^\s/#]+)#([1-9][0-9]*)$/);
  if (!match) return null;
  return { key: key, repo: match[1].toLowerCase(), number: Number(match[2]) };
}

function normalizeBoardItems(value) {
  if (!Array.isArray(value) || !value.length) return null;
  var seen = {};
  var result = [];
  for (var i = 0; i < value.length; i++) {
    var item = value[i];
    if (!exactKeys(item, ["id", "status"])) return null;
    var id = text(item.id);
    var status = text(item.status);
    if (!id || !status || seen[id]) return null;
    seen[id] = true;
    result.push({ id: id, status: status.toLowerCase() });
  }
  result.sort(function (left, right) {
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return result;
}

function boardItemsFromIssue(issue) {
  var raw = issue && issue.projectItems;
  if (!Array.isArray(raw) || !raw.length) return null;
  var result = [];
  for (var i = 0; i < raw.length; i++) {
    var entry = raw[i] || {};
    result.push({
      id: entry.id,
      status: entry.status && entry.status.name,
    });
  }
  return normalizeBoardItems(result);
}

function currentIssueFacts(input, profile) {
  var value = input || {};
  var item = value.item || {};
  var parsedKey = parseItemKey(value.itemKey);
  if (!parsedKey || Number(item.number) !== parsedKey.number) {
    return { ok: false, reason: "qualification_item_identity_missing" };
  }
  var state = text(item.state).toLowerCase();
  if (profile.normalIssueIntake.issueStates.indexOf(state) === -1) {
    return { ok: false, reason: "qualification_issue_state_ineligible" };
  }
  var boardItems = boardItemsFromIssue(item);
  if (!boardItems) return { ok: false, reason: "qualification_board_evidence_missing" };
  for (var i = 0; i < boardItems.length; i++) {
    if (profile.normalIssueIntake.boardStatuses.indexOf(boardItems[i].status) === -1) {
      return { ok: false, reason: "qualification_board_status_ineligible" };
    }
  }
  if (value.assignedToOwner !== true || value.recipeAllowsUnassigned === true) {
    return { ok: false, reason: "qualification_assignment_required" };
  }
  return { ok: true, state: state, boardItems: boardItems };
}

function receiptSubject(value) {
  return {
    schema: value.schema,
    version: value.version,
    projectRef: value.projectRef,
    policy: value.policy,
    recipe: value.recipe,
    item: value.item,
    evidenceAt: value.evidenceAt,
    assignment: value.assignment,
    classification: value.classification,
    approval: value.approval,
    coordinator: value.coordinator,
  };
}

function stableReceiptIdentity(value) {
  var receipt = normalizeReceipt(value);
  if (!receipt) return null;
  return {
    schema: receipt.schema,
    version: receipt.version,
    projectRef: receipt.projectRef,
    policy: receipt.policy,
    recipe: receipt.recipe,
    item: receipt.item,
    assignment: receipt.assignment,
    classification: receipt.classification,
    approval: receipt.approval,
    coordinator: receipt.coordinator,
  };
}

function normalizeReceipt(value) {
  if (!exactKeys(value, ["schema", "version", "projectRef", "policy", "recipe", "item", "evidenceAt",
    "assignment", "classification", "approval", "coordinator", "digest"]) ||
      value.schema !== SCHEMA || value.version !== VERSION) return null;
  var projectRef = normalizedProjectRef(value.projectRef);
  if (!projectRef || !exactKeys(value.policy, ["digest", "version"]) ||
      !/^[a-f0-9]{64}$/.test(value.policy.digest) || value.policy.version !== VERSION ||
      !exactKeys(value.recipe, ["id", "digest", "kind"]) ||
      !text(value.recipe.id) || !/^[a-f0-9]{64}$/.test(value.recipe.digest) ||
      value.recipe.kind !== "issue") return null;
  if (!exactKeys(value.item, ["key", "repo", "number", "state", "boardItems"])) return null;
  var parsedKey = parseItemKey(value.item.key);
  var repo = text(value.item.repo);
  var state = text(value.item.state);
  var boardItems = normalizeBoardItems(value.item.boardItems);
  if (!parsedKey || !repo || parsedKey.repo !== repo.toLowerCase() ||
      !Number.isSafeInteger(value.item.number) || value.item.number !== parsedKey.number ||
      !state || !boardItems || !Number.isSafeInteger(value.evidenceAt) || value.evidenceAt < 0) return null;
  if (!exactKeys(value.assignment, ["required", "assignedToOwner", "recipeAllowsUnassigned"]) ||
      value.assignment.required !== "owner" || typeof value.assignment.assignedToOwner !== "boolean" ||
      typeof value.assignment.recipeAllowsUnassigned !== "boolean") return null;
  if (!exactKeys(value.classification, ["itemClass", "admission", "rule"]) ||
      ISSUE_CLASSES.indexOf(value.classification.itemClass) === -1 ||
      ["auto", "owner_approval"].indexOf(value.classification.admission) === -1 ||
      ["autonomous", "owner_approval"].indexOf(value.classification.rule) === -1) return null;
  if ((value.classification.rule === "autonomous") !== (value.classification.admission === "auto")) return null;
  if (!exactKeys(value.approval, ["required", "ownerApproved"]) ||
      typeof value.approval.required !== "boolean" || typeof value.approval.ownerApproved !== "boolean" ||
      value.approval.required !== (value.classification.rule === "owner_approval")) return null;
  if (!exactKeys(value.coordinator, ["verdict", "reasons"]) || value.coordinator.verdict !== "qualified" ||
      !Array.isArray(value.coordinator.reasons) || !value.coordinator.reasons.length) return null;
  var reasons = [];
  for (var i = 0; i < value.coordinator.reasons.length; i++) {
    var reason = text(value.coordinator.reasons[i]);
    if (!reason) return null;
    reasons.push(reason);
  }
  var normalized = {
    schema: SCHEMA,
    version: VERSION,
    projectRef: projectRef,
    policy: { digest: value.policy.digest, version: VERSION },
    recipe: { id: text(value.recipe.id), digest: value.recipe.digest, kind: "issue" },
    item: {
      key: parsedKey.key,
      repo: parsedKey.repo,
      number: parsedKey.number,
      state: state.toLowerCase(),
      boardItems: boardItems,
    },
    evidenceAt: value.evidenceAt,
    assignment: {
      required: "owner",
      assignedToOwner: value.assignment.assignedToOwner,
      recipeAllowsUnassigned: value.assignment.recipeAllowsUnassigned,
    },
    classification: {
      itemClass: value.classification.itemClass,
      admission: value.classification.admission,
      rule: value.classification.rule,
    },
    approval: { required: value.approval.required, ownerApproved: value.approval.ownerApproved },
    coordinator: { verdict: "qualified", reasons: reasons },
  };
  normalized.digest = digest(receiptSubject(normalized));
  return normalized.digest === value.digest ? normalized : null;
}

function policyRecipe(policy, recipe) {
  if (!policy || !Array.isArray(policy.recipes) || !recipe) return null;
  for (var i = 0; i < policy.recipes.length; i++) {
    var current = policy.recipes[i];
    if (current && current.id === recipe.id && current.digest === recipe.digest && current.kind === "issue") {
      return current;
    }
  }
  return null;
}

function ruleFor(profile, itemClass) {
  var classification = profile.normalIssueIntake.classification;
  if (classification.autonomous.indexOf(itemClass) !== -1) return "autonomous";
  if (classification.ownerApproval.indexOf(itemClass) !== -1) return "owner_approval";
  return "";
}

function receiptFor(input) {
  var value = input || {};
  var policy = value.policy;
  var profile = policyProfile(policy);
  var projectRef = normalizedProjectRef(value.projectRef);
  var recipe = value.recipe;
  if (!profile) return { ok: false, reason: "qualification_policy_missing" };
  if (!projectRef || !policy || policy.projectRef &&
      (!normalizedProjectRef(policy.projectRef) || normalizedProjectRef(policy.projectRef).projectId !== projectRef.projectId)) {
    return { ok: false, reason: "qualification_project_mismatch" };
  }
  if (typeof policy.digest !== "string" || !/^[a-f0-9]{64}$/.test(policy.digest)) {
    return { ok: false, reason: "qualification_policy_unverifiable" };
  }
  if (!recipe || !text(recipe.id) || !/^[a-f0-9]{64}$/.test(recipe.digest) || recipe.kind !== "issue" ||
      !policyRecipe(policy, recipe)) return { ok: false, reason: "qualification_recipe_mismatch" };
  var facts = currentIssueFacts(value, profile);
  if (!facts.ok) return facts;
  var parsedKey = parseItemKey(value.itemKey);
  var state = facts.state;
  var boardItems = facts.boardItems;
  var itemClass = text(value.itemClass);
  var rule = ruleFor(profile, itemClass);
  if (!rule) return { ok: false, reason: "qualification_classification_unapproved" };
  var evidenceAt = Number(value.now);
  if (!Number.isSafeInteger(evidenceAt) || evidenceAt < 0) return { ok: false, reason: "qualification_clock_invalid" };
  var reasons = [
    "issue_state_" + state,
    "all_board_items_allowed",
    "assigned_to_owner",
    "classification_" + itemClass + "_" + rule,
  ];
  var receipt = {
    schema: SCHEMA,
    version: VERSION,
    projectRef: projectRef,
    policy: { digest: policy.digest, version: VERSION },
    recipe: { id: recipe.id, digest: recipe.digest, kind: "issue" },
    item: {
      key: parsedKey.key,
      repo: parsedKey.repo,
      number: parsedKey.number,
      state: state,
      boardItems: boardItems,
    },
    evidenceAt: evidenceAt,
    assignment: { required: "owner", assignedToOwner: true, recipeAllowsUnassigned: false },
    classification: {
      itemClass: itemClass,
      admission: rule === "autonomous" ? "auto" : "owner_approval",
      rule: rule,
    },
    approval: { required: rule === "owner_approval", ownerApproved: value.ownerApproved === true },
    coordinator: { verdict: "qualified", reasons: reasons },
  };
  receipt.digest = digest(receiptSubject(receipt));
  return { ok: true, receipt: receipt };
}

function requalifyAtLaunch(input) {
  var value = input || {};
  var policy = value.policy;
  var profile = policyProfile(policy);
  var projectRef = normalizedProjectRef(value.projectRef);
  if (!profile) return { ok: false, reason: "qualification_policy_missing" };
  if (!projectRef || !policy || policy.projectRef &&
      (!normalizedProjectRef(policy.projectRef) || normalizedProjectRef(policy.projectRef).projectId !== projectRef.projectId)) {
    return { ok: false, reason: "qualification_project_mismatch" };
  }
  if (typeof policy.digest !== "string" || !/^[a-f0-9]{64}$/.test(policy.digest)) {
    return { ok: false, reason: "qualification_policy_unverifiable" };
  }
  return currentIssueFacts(value, profile);
}

function receiptMatchesPolicy(receipt, profile) {
  if (profile.normalIssueIntake.issueStates.indexOf(receipt.item.state) === -1 ||
      receipt.assignment.required !== profile.normalIssueIntake.assignment ||
      receipt.assignment.assignedToOwner !== true || receipt.assignment.recipeAllowsUnassigned !== false) {
    return false;
  }
  for (var i = 0; i < receipt.item.boardItems.length; i++) {
    if (profile.normalIssueIntake.boardStatuses.indexOf(receipt.item.boardItems[i].status) === -1) return false;
  }
  return ruleFor(profile, receipt.classification.itemClass) === receipt.classification.rule;
}

function verifyReceipt(value, input) {
  var receipt = normalizeReceipt(value);
  var opts = input || {};
  var policy = opts.policy;
  var profile = policyProfile(policy);
  var now = Number(opts.now);
  if (!receipt) return { ok: false, reason: "qualification_receipt_malformed" };
  if (!profile) return { ok: false, reason: "qualification_policy_missing" };
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: "qualification_clock_invalid" };
  if (now < receipt.evidenceAt || now - receipt.evidenceAt > MAX_RECEIPT_AGE_MS) {
    return { ok: false, reason: "qualification_receipt_stale" };
  }
  var policyRef = normalizedProjectRef(policy && policy.projectRef);
  if (!policyRef || policyRef.projectId !== receipt.projectRef.projectId || policy.digest !== receipt.policy.digest ||
      receipt.policy.version !== profile.version || !receiptMatchesPolicy(receipt, profile)) {
    return { ok: false, reason: "qualification_receipt_policy_stale" };
  }
  var candidate = opts.candidate;
  if (candidate) {
    if (candidate.itemKey !== receipt.item.key || candidate.policyDigest !== receipt.policy.digest ||
        candidate.recipeId !== receipt.recipe.id || candidate.itemClass !== receipt.classification.itemClass ||
        !candidate.projectRef || candidate.projectRef.projectId !== receipt.projectRef.projectId ||
        !candidate.eligibility || candidate.eligibility.assignedToOwner !== receipt.assignment.assignedToOwner ||
        candidate.eligibility.recipeAllowsUnassigned !== receipt.assignment.recipeAllowsUnassigned ||
        candidate.admission !== receipt.classification.admission) {
      return { ok: false, reason: "qualification_receipt_candidate_mismatch" };
    }
  }
  return { ok: true, receipt: receipt };
}

module.exports = {
  ISSUE_CLASSES: ISSUE_CLASSES,
  MAX_RECEIPT_AGE_MS: MAX_RECEIPT_AGE_MS,
  SCHEMA: SCHEMA,
  VERSION: VERSION,
  normalizePolicy: normalizePolicy,
  normalizeReceipt: normalizeReceipt,
  policyProfile: policyProfile,
  receiptFor: receiptFor,
  requalifyAtLaunch: requalifyAtLaunch,
  stableReceiptIdentity: stableReceiptIdentity,
  verifyReceipt: verifyReceipt,
};
