var test = require("node:test");
var assert = require("node:assert/strict");
var queue = require("../lib/coop-action-queue");

// The owner's screenshot showed an internal "Reconcile open Webapp..."
// coordinator with two unrelated decisions nested underneath it. That is
// implementation machinery presented as owner work, and it buried the actual
// questions inside a row that means nothing to them.
//
// The real mapping, which an earlier handoff got backwards:
//
//   Webapp #2503  Mail attachment (parent/child) icons  PR #2504  has a session
//   Webapp #2517  Excel Viewer - view only              PR #2526  independent
//
// Every join here is keyed on canonical project + issue identity. Nothing may
// depend on list order or on a neighbouring task's PR metadata -- that is
// exactly how the two got cross-wired in the first place.

var WEBAPP = "webapp-project-id";
var CLAY = "clay-project-id";

function coordinator() {
  return {
    taskId: "coord-reconcile", title: "Reconcile open Webapp issues",
    status: "needs_input", updatedAt: 500,
  };
}

// #2503 -- Mail attachment (parent/child) icons, PR #2504.
function task2503(extra) {
  return Object.assign({
    taskId: "task-2503", parentTaskId: "coord-reconcile",
    title: "Mail attachment (parent/child) icons",
    status: "needs_input",
    userQuestion: "Ship parent-only icons, or wait for child rollup?",
    clientRef: "webapp#2503",
    issueUrl: "https://github.com/acme/webapp/issues/2503",
    prNumber: "2504", prUrl: "https://github.com/acme/webapp/pull/2504",
    updatedAt: 100,
  }, extra || {});
}

// #2517 -- Excel Viewer - view only, PR #2526.
function task2517(extra) {
  return Object.assign({
    taskId: "task-2517", parentTaskId: "coord-reconcile",
    title: "Excel Viewer - view only",
    status: "waiting_user",
    userQuestion: "Approve PR #2526?",
    clientRef: "webapp#2517",
    issueUrl: "https://github.com/acme/webapp/issues/2517",
    prNumber: "2526", prUrl: "https://github.com/acme/webapp/pull/2526",
    updatedAt: 200,
  }, extra || {});
}

// The session that already exists for #2503 and must be reused.
function session2503() {
  return {
    localId: 41, storageId: "sess-2503",
    orchestrationParent: { taskId: "task-2503" },
    orchestrationTasks: [],
  };
}

function webappProject(tasks, extraSessions) {
  return {
    projectRef: { projectId: WEBAPP }, slug: "webapp", title: "Webapp",
    sessions: [{ localId: 1, storageId: "coord-home", orchestrationTasks: tasks }]
      .concat(extraSessions || []),
  };
}

function screenshotState() {
  return webappProject([coordinator(), task2503(), task2517()], [session2503()]);
}

function byIssue(items, issue) {
  return items.filter(function (item) { return item.itemId.indexOf("#" + issue) !== -1; })[0] || null;
}

// --- the screenshot path ----------------------------------------------------

test("the screenshot state yields two independent items and no coordinator", function () {
  var items = queue.buildActionQueue([screenshotState()], {});
  assert.equal(items.length, 2, "one item per real decision, never one for the reconciler");
  var titles = items.map(function (i) { return i.title; });
  assert.ok(titles.indexOf("Reconcile open Webapp issues") === -1,
    "an internal reconciliation coordinator must never surface as owner work");
  assert.deepEqual(titles.slice().sort(),
    ["Excel Viewer - view only", "Mail attachment (parent/child) icons"]);
});

test("#2503 is Mail attachment icons with PR #2504 and its existing session", function () {
  var item = byIssue(queue.buildActionQueue([screenshotState()], {}), "2503");
  assert.ok(item, "#2503 must be present");
  assert.equal(item.title, "Mail attachment (parent/child) icons");
  assert.equal(item.decision, "Ship parent-only icons, or wait for child rollup?");
  assert.equal(item.projectTitle, "Webapp");
  // Deduped against the session that already exists: the item opens it rather
  // than inviting a second one.
  assert.equal(item.hasExistingSession, true);
  assert.equal(item.destination.ref.sessionStorageId, "sess-2503");
  var labels = item.links.map(function (l) { return l.label; });
  assert.ok(labels.indexOf("Issue #2503") !== -1);
  assert.ok(labels.indexOf("PR #2504") !== -1);
  // And never its neighbour's PR.
  assert.ok(labels.indexOf("PR #2526") === -1, "#2503 must not carry #2517's PR");
  assert.ok(JSON.stringify(item).indexOf("2526") === -1);
});

test("#2517 is Excel Viewer with PR #2526 and stays independent", function () {
  var item = byIssue(queue.buildActionQueue([screenshotState()], {}), "2517");
  assert.ok(item, "#2517 must be present");
  assert.equal(item.title, "Excel Viewer - view only");
  assert.equal(item.decision, "Approve PR #2526?");
  // No session of its own yet, so it routes to the project rather than
  // borrowing #2503's session.
  assert.equal(item.hasExistingSession, false);
  assert.equal(item.destination, null);
  var labels = item.links.map(function (l) { return l.label; });
  assert.ok(labels.indexOf("Issue #2517") !== -1);
  assert.ok(labels.indexOf("PR #2526") !== -1);
  assert.ok(labels.indexOf("PR #2504") === -1, "#2517 must not carry #2503's PR");
  assert.ok(JSON.stringify(item).indexOf("2504") === -1);
});

test("the join survives reordering, which is what cross-wired them before", function () {
  // Same facts, opposite declaration order. Identity is project+issue, so
  // nothing may move.
  var reversed = webappProject([coordinator(), task2517(), task2503()], [session2503()]);
  var items = queue.buildActionQueue([reversed], {});
  var a = byIssue(items, "2503");
  var b = byIssue(items, "2517");
  assert.equal(a.title, "Mail attachment (parent/child) icons");
  assert.equal(a.destination.ref.sessionStorageId, "sess-2503");
  assert.ok(a.links.map(function (l) { return l.label; }).indexOf("PR #2504") !== -1);
  assert.equal(b.title, "Excel Viewer - view only");
  assert.equal(b.destination, null);
  assert.ok(b.links.map(function (l) { return l.label; }).indexOf("PR #2526") !== -1);
});

test("a session belonging to one issue never attaches to the other", function () {
  // The session is keyed to task-2503. Even with #2517 listed first and both
  // present, it must not drift onto #2517.
  var items = queue.buildActionQueue([
    webappProject([coordinator(), task2517(), task2503()], [session2503()]),
  ], {});
  assert.equal(byIssue(items, "2517").destination, null);
  assert.equal(byIssue(items, "2503").destination.ref.sessionStorageId, "sess-2503");
});

// --- identity, dedupe, independence -----------------------------------------

test("identity is canonical project plus issue, not title or order", function () {
  var a = queue.canonicalIdentity(task2503(), WEBAPP);
  var b = queue.canonicalIdentity(task2517(), WEBAPP);
  assert.notEqual(a.key, b.key);
  // The same issue number in a different project is different work.
  assert.notEqual(queue.canonicalIdentity(task2503(), CLAY).key, a.key);
  // Retitling the work does not change its identity.
  assert.equal(queue.canonicalIdentity(task2503({ title: "renamed" }), WEBAPP).key, a.key);
  assert.equal(queue.issueNumberOf(task2503()), "2503");
  assert.equal(queue.issueNumberOf(task2517()), "2517");
});

test("the same issue seen twice is one item, preferring the one with a session", function () {
  var duplicate = task2503({ taskId: "task-2503-dup", updatedAt: 900, prUrl: "", prNumber: "" });
  var items = queue.buildActionQueue([
    webappProject([coordinator(), task2503(), duplicate], [session2503()]),
  ], {});
  assert.equal(items.length, 1, "one item per canonical issue");
  assert.equal(items[0].destination.ref.sessionStorageId, "sess-2503");
  // The PR the other copy knew about is not lost.
  assert.ok(items[0].links.map(function (l) { return l.label; }).indexOf("PR #2504") !== -1);
});

test("finished work stays as an acceptance item, it does not silently vanish", function () {
  // The owner's rule: a terminal implementation state is NOT Done. Finishing
  // must produce a durable owner-facing item, otherwise the work disappears
  // from view and ownerAcceptance is never written, which is exactly why the
  // Done state was unreachable.
  var finished = task2503({ status: "completed" });
  var items = queue.buildActionQueue([
    webappProject([coordinator(), finished, task2517()], [session2503()]),
  ], {});
  assert.equal(items.length, 2);
  var item = byIssue(items, "2503");
  assert.ok(item, "finished-but-unaccepted work stays in the queue");
  assert.equal(item.kind, "acceptance");
  assert.match(item.decision, /accept it, or send it back/);
});

test("accepted work leaves the queue, and only that item", function () {
  var accepted = task2503({
    status: "completed",
    ownerAcceptance: { status: "accepted", at: 10, withdrawnAt: null },
  });
  var items = queue.buildActionQueue([
    webappProject([coordinator(), accepted, task2517()], [session2503()]),
  ], {});
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Excel Viewer - view only");
  assert.equal(byIssue(items, "2503"), null);
});

test("a revoked acceptance puts the work back in front of the owner", function () {
  // Acceptance is revocable, so withdrawing it must reopen the item rather
  // than leaving the work accepted-but-hidden.
  var revoked = task2503({
    status: "completed",
    ownerAcceptance: { status: "accepted", at: 10, withdrawnAt: 20 },
  });
  var items = queue.buildActionQueue([
    webappProject([coordinator(), revoked], []),
  ], {});
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "acceptance");
});

test("dismissed and cancelled work is not asked about", function () {
  ["dismissed", "cancelled"].forEach(function (status) {
    var items = queue.buildActionQueue([
      webappProject([coordinator(), task2503({ status: status })], []),
    ], {});
    assert.deepEqual(items, [], status + " must not become an acceptance item");
  });
});

// --- coordinators, cross-project, ordering, ACL -----------------------------

test("a coordinator is hidden even when it is itself waiting", function () {
  assert.ok(queue.isInternalCoordinator(coordinator(), { "coord-reconcile": [task2503()] }));
  // A leaf with no children is real owner work.
  assert.ok(!queue.isInternalCoordinator(task2503(), { "coord-reconcile": [task2503()] }));
});

test("the queue spans projects and is visible without entering one", function () {
  var clay = {
    projectRef: { projectId: CLAY }, slug: "clay", title: "Clay",
    sessions: [{ localId: 3, storageId: "clay-home", orchestrationTasks: [{
      taskId: "task-clay", title: "Restore mobile switcher", status: "blocked",
      clientRef: "clay#77", updatedAt: 50,
    }] }],
  };
  var items = queue.buildActionQueue([screenshotState(), clay], {});
  var projects = items.map(function (i) { return i.projectTitle; });
  assert.ok(projects.indexOf("Webapp") !== -1);
  assert.ok(projects.indexOf("Clay") !== -1);
  assert.equal(items.length, 3);
  // Every item names its project, so the queue reads without entering any.
  items.forEach(function (i) { assert.ok(i.projectTitle); });
});

test("ordering is stable and oldest-waiting-first", function () {
  var items = queue.buildActionQueue([screenshotState()], {});
  assert.deepEqual(items.map(function (i) { return i.title; }),
    ["Mail attachment (parent/child) icons", "Excel Viewer - view only"]);
  // Re-deriving the same state must not reshuffle the queue under the owner.
  var again = queue.buildActionQueue([screenshotState()], {});
  assert.deepEqual(again.map(function (i) { return i.itemId; }),
    items.map(function (i) { return i.itemId; }));
});

test("a project the owner cannot see contributes nothing", function () {
  var items = queue.buildActionQueue([screenshotState()], {
    canAccessProject: function (project) { return project.slug !== "webapp"; },
  });
  assert.deepEqual(items, []);
});

test("only work that needs the owner is queued", function () {
  var running = task2503({ status: "running", taskId: "task-running" });
  var items = queue.buildActionQueue([webappProject([coordinator(), running], [])], {});
  assert.deepEqual(items, [], "work in progress is not a decision to make");
});

test("each item states the exact decision requested", function () {
  var items = queue.buildActionQueue([screenshotState()], {});
  items.forEach(function (item) {
    assert.ok(item.decision && item.decision.length > 0);
  });
  // Without a question, the durable status is stated plainly rather than guessed.
  var bare = queue.buildActionQueue([
    webappProject([coordinator(), task2503({ userQuestion: "", waitingReason: "" })], []),
  ], {});
  assert.equal(bare[0].decision, "Needs your decision");
});

// --- the destination must satisfy its real consumer ---------------------------

test("a destination is exactly what openResolvedGlobalSession accepts", function () {
  // Live QA caught this: the queue emitted { projectId, sessionStorageId,
  // localId }, which passed the queue's own tests but failed the consumer's
  // guard, so tapping a row closed the sheet and went nowhere. That guard is
  // `!resolution.ref || !resolution.slug || typeof resolution.localId !== "number"`.
  var item = byIssue(queue.buildActionQueue([screenshotState()], {}), "2503");
  var to = item.destination;
  assert.ok(to.ref, "openResolvedGlobalSession requires .ref");
  assert.equal(typeof to.slug, "string");
  assert.ok(to.slug.length > 0, "it requires a non-empty .slug");
  assert.equal(typeof to.localId, "number", "it requires a numeric .localId");
  // Re-run the consumer's exact rejection test against what we emit.
  assert.ok(!(!to.ref || !to.slug || typeof to.localId !== "number"),
    "the emitted destination must not be rejected by the real guard");
  assert.deepEqual(to.ref, { projectId: WEBAPP, sessionStorageId: "sess-2503" });
  assert.equal(to.slug, "webapp");
  assert.equal(to.localId, 41);
});

test("an unopenable session yields no destination rather than a broken one", function () {
  // A session with no localId cannot be opened, so claiming it would strand the
  // owner on a dead row instead of routing them to the project.
  var noLocalId = {
    storageId: "sess-2503", orchestrationParent: { taskId: "task-2503" }, orchestrationTasks: [],
  };
  var items = queue.buildActionQueue([
    webappProject([coordinator(), task2503()], [noLocalId]),
  ], {});
  assert.equal(items[0].destination, null);
  assert.equal(items[0].hasExistingSession, false,
    "hasExistingSession must mean openable, not merely linked");
  assert.equal(items[0].projectSlug, "webapp", "so the row still routes to the project");
});

// --- decision readability ----------------------------------------------------
//
// Live QA against the owner's real Coop showed the WEBAPP row rendering a whole
// status paragraph: it overflowed the sidebar horizontally on a raw PR URL and
// ended mid-word on "Registry questio". The queue is only useful if the owner
// can scan what is being asked.

// Verbatim from the rendered row.
var REAL_BLOB = "Waiting for the boss: Webapp #2517 / draft PR #2526 " +
  "(https://github.com/trialview/v2/pull/2526) -- required CI is green; the only " +
  "failing check, AI PR QA, failed solely on the QA bot's own credit balance, not " +
  "a code finding. Registry question: should the owner preview deployment be " +
  "promoted before or after the registry migration lands?";

test("a long decision is cut at a word boundary, never mid-word", function () {
  var items = queue.buildActionQueue([
    webappProject([coordinator(), task2503({ userQuestion: REAL_BLOB })], []),
  ], {});
  var decision = items[0].decision;
  assert.ok(decision.length <= 161, "must fit a sidebar row, got " + decision.length);
  assert.ok(/…$/.test(decision), "an elision must be marked, not silent");
  // The exact defect: the old fixed slice ended on a half word.
  assert.ok(decision.indexOf("Registry questio…") === -1);
  var body = decision.replace(/…$/, "");
  assert.ok(!/\s$/.test(body), "no trailing whitespace before the ellipsis");
  // Whatever survives is whole words from the original.
  assert.ok(REAL_BLOB.replace(/\(https?:[^)]*\)/, " ").replace(/\s+/g, " ")
    .indexOf(body.slice(0, 40)) !== -1);
});

test("a raw URL never reaches the decision text", function () {
  var items = queue.buildActionQueue([
    webappProject([coordinator(), task2503({ userQuestion: REAL_BLOB })], []),
  ], {});
  // It overflowed the row and could not be clicked; the links row carries it
  // properly instead.
  assert.ok(items[0].decision.indexOf("http") === -1);
  assert.ok(items[0].links.map(function (l) { return l.url; })
    .some(function (u) { return u.indexOf("2504") !== -1; }));
});

test("a short question is left exactly as the worker asked it", function () {
  var items = queue.buildActionQueue([screenshotState()], {});
  assert.equal(byIssue(items, "2503").decision,
    "Ship parent-only icons, or wait for child rollup?");
  assert.ok(byIssue(items, "2503").decision.indexOf("…") === -1,
    "nothing short enough to fit may be elided");
});

test("a single unbroken token still yields readable text", function () {
  // No word boundary to back up to, so it must still bound and mark the cut
  // rather than returning the whole token or an empty string.
  var items = queue.buildActionQueue([
    webappProject([coordinator(), task2503({ userQuestion: "x".repeat(400) })], []),
  ], {});
  assert.ok(items[0].decision.length <= 161);
  assert.ok(/…$/.test(items[0].decision));
});

// --- the server projection actually carries the queue ------------------------
//
// The builder above is pure. These pin the wiring: that buildGlobalCoopProjection
// emits `actionQueue` at the top level (so the owner sees it without entering a
// project) and that it obeys the same ACLs as the rest of the projection.

var buildGlobalCoopProjection = require("../lib/global-coop-projection").buildGlobalCoopProjection;

function sess(id, value) {
  return Object.assign({ localId: id, storageId: "session-" + id, title: "Session " + id, lastActivity: 10 }, value || {});
}

function proj(projectId, slug, sessions, extra) {
  return Object.assign({
    projectId: projectId, slug: slug, title: slug,
    sm: {
      sessions: new Map(sessions.map(function (s) { return [s.localId, s]; })),
      saveSessionFile: function () {},
      createSessionRaw: function (o) {
        var c = sess(this.sessions.size + 100, o);
        this.sessions.set(c.localId, c);
        return c;
      },
    },
  }, extra || {});
}

// A real UUID-shaped id: projectIdFor rejects anything else, so a project with
// a made-up id never becomes "configured" and the queue would be empty for a
// reason that has nothing to do with the queue.
var WEBAPP_UUID = "44444444-4444-5444-8444-444444444444";

function leadAnd(webapp) {
  return [proj("system-lead", "lead", [sess(1, { storageId: "coop-home", coopHome: true })], { isLead: true }), webapp];
}

function webappWithDecisions() {
  return proj(WEBAPP_UUID, "webapp", [
    sess(10, { coordinationMode: true, orchestrationTasks: [coordinator(), task2503(), task2517()] }),
    sess(41, { storageId: "sess-2503", orchestrationParent: { taskId: "task-2503" } }),
  ]);
}

test("the projection carries the queue at the top level, outside any project", function () {
  var projection = buildGlobalCoopProjection({ projects: leadAnd(webappWithDecisions()) });
  assert.ok(Array.isArray(projection.actionQueue), "actionQueue must be a top-level field");
  assert.equal(projection.actionQueue.length, 2);
  var titles = projection.actionQueue.map(function (i) { return i.title; }).sort();
  assert.deepEqual(titles, ["Excel Viewer - view only", "Mail attachment (parent/child) icons"]);
  assert.ok(JSON.stringify(projection.actionQueue).indexOf("Reconcile open Webapp issues") === -1);
});

test("the projected items keep the corrected issue-to-PR mapping", function () {
  var projection = buildGlobalCoopProjection({ projects: leadAnd(webappWithDecisions()) });
  var a = byIssue(projection.actionQueue, "2503");
  var b = byIssue(projection.actionQueue, "2517");
  assert.equal(a.title, "Mail attachment (parent/child) icons");
  assert.equal(a.destination.ref.sessionStorageId, "sess-2503");
  assert.ok(JSON.stringify(a).indexOf("2526") === -1, "#2503 must never carry #2517's PR");
  assert.equal(b.title, "Excel Viewer - view only");
  assert.equal(b.destination, null);
  assert.ok(JSON.stringify(b).indexOf("2504") === -1, "#2517 must never carry #2503's PR");
});

test("the queue obeys the projection's project ACL", function () {
  // Non-vacuous: the same fixture must produce a populated queue without the
  // ACL, or "empty" proves nothing.
  var open = buildGlobalCoopProjection({ projects: leadAnd(webappWithDecisions()) });
  assert.equal(open.actionQueue.length, 2);

  var projection = buildGlobalCoopProjection({
    projects: leadAnd(webappWithDecisions()),
    actor: { id: "guest" },
    canAccessProject: function (actor, project) { return project.slug !== "webapp"; },
  });
  assert.deepEqual(projection.actionQueue, [],
    "work in a project the actor cannot see must not leak through the queue");
});

test("the queue obeys the projection's session ACL for destinations", function () {
  var projection = buildGlobalCoopProjection({
    projects: leadAnd(webappWithDecisions()),
    actor: { id: "guest" },
    canAccessSession: function (actor, project, session) { return session.storageId !== "sess-2503"; },
  });
  var a = byIssue(projection.actionQueue, "2503");
  assert.ok(a, "the decision itself is still visible");
  assert.equal(a.destination, null, "but it must not route to a session the actor cannot open");
});


test("the projection emits finished work as an acceptance item end to end", function () {
  // Coordinator QA could not exercise this live because the real queue was
  // empty (no attention-state and no completed-unaccepted tasks existed), so
  // the server->client shape for acceptance items is pinned here instead of
  // being taken on trust.
  var accepted = Object.assign(task2503(), {
    status: "completed",
    ownerAcceptance: { status: "accepted", at: 5, withdrawnAt: null },
  });
  var awaiting = Object.assign(task2517(), { status: "completed", resolutionSummary: "" });

  var projection = buildGlobalCoopProjection({
    projects: leadAnd(proj(WEBAPP_UUID, "webapp", [
      sess(10, { coordinationMode: true, orchestrationTasks: [coordinator(), accepted, awaiting] }),
    ])),
  });

  assert.equal(projection.actionQueue.length, 1, "accepted work leaves; unaccepted work stays");
  var item = projection.actionQueue[0];
  assert.equal(item.kind, "acceptance");
  assert.equal(item.title, "Excel Viewer - view only");
  assert.equal(item.status, "completed");
  assert.match(item.decision, /accept it, or send it back/);
  // The client normalizer must preserve the kind, or the panel would offer
  // Advance instead of Accept.
  assert.equal(item.taskId, "task-2517");
});

// --- canonical topic linkage --------------------------------------------------
//
// The sidebar index is link-only: it opens the topic a decision lives in. That
// only works if the SERVER states the durable topic link on the item; the
// client must never guess it from titles.

test("a task's coopTopicRef is stamped onto its action item", function () {
  var linked = task2503({ coopTopicRef: { topicId: "topic-mail-icons" } });
  var item = byIssue(queue.buildActionQueue([webappProject([coordinator(), linked])], {}), "2503");
  assert.deepEqual(item.topicRef, { topicId: "topic-mail-icons" });
});

test("a task without a topic link yields a null topicRef, never a guess", function () {
  var item = byIssue(queue.buildActionQueue([screenshotState()], {}), "2503");
  assert.equal(item.topicRef, null);
});

test("dedup prefers the copy that carries the topic link", function () {
  // The same canonical issue surfaces twice: an older copy with the durable
  // topic link, and a newer one with a session but no link. Navigation beats
  // recency -- the owner must land in the topic.
  var older = task2503({ coopTopicRef: { topicId: "topic-mail-icons" }, updatedAt: 100 });
  var newer = task2503({ taskId: "task-2503-dup", updatedAt: 900 });
  var items = queue.buildActionQueue([
    webappProject([coordinator(), older, newer], [session2503()]),
  ], {});
  var item = byIssue(items, "2503");
  assert.equal(items.filter(function (i) { return i.itemId === item.itemId; }).length, 1);
  assert.deepEqual(item.topicRef, { topicId: "topic-mail-icons" });
});
