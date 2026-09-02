// One canonical spelling for "which piece of work is this".
//
// Shared deliberately. The Lead staffing path derives an identity from a
// backlog item, and the binding store enforces it; if the two disagree by so
// much as a prefix, the duplicate guard silently misses and the same job is
// dispatched again under a new name. Canonicalization therefore lives here
// rather than in either caller, so the store normalizes whatever it is handed
// even when the caller never went through staffing.
var MAX_WORK_IDENTITY = 200;
// Repo-qualified issue coordinates: unambiguous across projects, which the
// project-scoped form ("webapp#2522") is not.
var REPO_ISSUE_RE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#([1-9][0-9]*)$/;
var GITHUB_ISSUE_URL_RE =
  /github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/(?:issues|pull)\/([1-9][0-9]*)/;
// Historical task ids compressed the repository coordinate into an alias.
// Keep this table deliberately closed: an unknown hyphenated spelling is not
// enough evidence to guess an owner/repository split.
var REPOSITORY_ALIASES = {
  "trialview-v2": "trialview/v2",
  "webapp": "trialview/v2",
};

function repoIssueIdentity(repo, number) {
  return "github:" + String(repo).toLowerCase() + "#" + number;
}

function canonicalIssueAlias(value) {
  if (typeof value !== "string") return "";
  var trimmed = value.trim().slice(0, MAX_WORK_IDENTITY);
  var auto = trimmed.match(/^auto:[^:\s]+:([A-Za-z0-9._/-]+)-([1-9][0-9]*)$/);
  var portfolio = trimmed.match(/^portfolio-([A-Za-z0-9._-]+)-([1-9][0-9]*)$/);
  var match = auto || portfolio;
  if (!match) return "";
  var repo = match[1].indexOf("/") !== -1 ? match[1] : REPOSITORY_ALIASES[match[1].toLowerCase()];
  return repo ? repoIssueIdentity(repo, match[2]) : "";
}

// Collapses every spelling of the same issue onto one key. The leading token is
// the action that queued the work ("launch:", "github:"), not the work itself,
// so it is dropped before matching -- "launch:trialview/v2#2522" and
// "github:trialview/v2#2522" are the same job. Anything unrecognized is kept
// verbatim: an opaque key is still a stable one, and inventing structure for it
// would be guessing.
function normalizeWorkIdentity(value) {
  if (typeof value !== "string") return "";
  var trimmed = value.trim().slice(0, MAX_WORK_IDENTITY);
  if (!trimmed) return "";
  var match = trimmed.replace(/^[A-Za-z_-]+:/, "").match(REPO_ISSUE_RE);
  return match ? repoIssueIdentity(match[1], match[2]) : canonicalIssueAlias(trimmed) || trimmed;
}

// Recovers coordinates from a GitHub issue or PR url, which is the only place
// the owning repository survives on a backlog item -- its `project` field holds
// the Clay project name ("webapp"), not the repo ("trialview/v2").
function issueUrlIdentity(url) {
  var match = typeof url === "string" ? url.match(GITHUB_ISSUE_URL_RE) : null;
  return match ? repoIssueIdentity(match[1], match[2]) : "";
}

module.exports = {
  MAX_WORK_IDENTITY: MAX_WORK_IDENTITY,
  canonicalIssueAlias: canonicalIssueAlias,
  issueUrlIdentity: issueUrlIdentity,
  normalizeWorkIdentity: normalizeWorkIdentity,
  repoIssueIdentity: repoIssueIdentity,
};
