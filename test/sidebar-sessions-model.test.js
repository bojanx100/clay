var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var pathToFileURL = require("node:url").pathToFileURL;

function loadModel() {
  var modulePath = path.join(__dirname, "..", "lib", "public", "modules", "sidebar-sessions-model.js");
  return import(pathToFileURL(modulePath).href);
}

test("compareSessionListItems: bookmarked sessions sort before unbookmarked, then by favoriteOrder, then recency", async function () {
  var m = await loadModel();
  var bookmarkedLater = { type: "session", data: { bookmarked: true, favoriteOrder: 1 }, lastActivity: 5 };
  var bookmarkedEarlier = { type: "session", data: { bookmarked: true, favoriteOrder: 0 }, lastActivity: 1 };
  var plainRecent = { type: "session", data: { bookmarked: false }, lastActivity: 100 };
  var plainOld = { type: "session", data: { bookmarked: false }, lastActivity: 1 };

  var sorted = [plainRecent, bookmarkedLater, plainOld, bookmarkedEarlier].sort(m.compareSessionListItems);

  // Both bookmarked items outrank both plain items regardless of recency.
  assert.equal(sorted[0], bookmarkedEarlier);
  assert.equal(sorted[1], bookmarkedLater);
  // Among plain items, more recent activity wins.
  assert.equal(sorted[2], plainRecent);
  assert.equal(sorted[3], plainOld);
});

test("compareSessionListItems: falls back to lastActivity recency when neither item is bookmarked", async function () {
  var m = await loadModel();
  var older = { type: "session", data: { bookmarked: false }, lastActivity: 10 };
  var newer = { type: "session", data: { bookmarked: false }, lastActivity: 20 };
  assert.ok(m.compareSessionListItems(newer, older) < 0);
  assert.ok(m.compareSessionListItems(older, newer) > 0);
});

test("collectItemSessionIds: session item returns its id only when visible under the search filter", async function () {
  var m = await loadModel();
  var item = { type: "session", data: { id: 7 } };
  assert.deepEqual(m.collectItemSessionIds(item, null), [7]);
  assert.deepEqual(m.collectItemSessionIds(item, new Set([7])), [7]);
  assert.deepEqual(m.collectItemSessionIds(item, new Set([9])), []);
});

test("collectItemSessionIds: coordinator item includes itself and only visible children", async function () {
  var m = await loadModel();
  var item = {
    type: "coordinator",
    data: { id: 1 },
    children: [{ id: 2 }, { id: 3 }],
  };
  assert.deepEqual(m.collectItemSessionIds(item, null), [1, 2, 3]);
  assert.deepEqual(m.collectItemSessionIds(item, new Set([1, 3])), [1, 3]);
  assert.deepEqual(m.collectItemSessionIds(item, new Set([2])), [2]);
});

test("collectItemSessionIds: loop item collects only numeric-id visible children", async function () {
  var m = await loadModel();
  var item = {
    type: "loop",
    children: [{ id: 4 }, { id: "non-numeric" }, { id: 5 }],
  };
  assert.deepEqual(m.collectItemSessionIds(item, null), [4, 5]);
  assert.deepEqual(m.collectItemSessionIds(item, new Set([5])), [5]);
});

test("collectItemSessionIds: unknown item type contributes no ids", async function () {
  var m = await loadModel();
  assert.deepEqual(m.collectItemSessionIds({ type: "unknown" }, null), []);
  assert.deepEqual(m.collectItemSessionIds(null, null), []);
});

test("buildSessionListItems: coordinator children are sorted by recency, most recent first", async function () {
  var m = await loadModel();
  var coordinator = { id: 1, coordinationMode: true, lastActivity: 1 };
  var olderWorker = { id: 2, orchestrationParent: { sessionId: 1 }, lastActivity: 5 };
  var newerWorker = { id: 3, orchestrationParent: { sessionId: 1 }, lastActivity: 50 };
  var partition = m.partitionSessionList([coordinator, olderWorker, newerWorker]);
  var items = m.buildSessionListItems(partition.normalSessions, partition.loopGroups);
  var coordinatorItem = items.find(function (i) { return i.type === "coordinator"; });
  assert.deepEqual(coordinatorItem.children.map(function (c) { return c.id; }), [3, 2]);
});

test("buildSessionListModel: a coordinator whose parent row is filtered by search still surfaces via a visible child", async function () {
  var m = await loadModel();
  var coordinator = { id: 1, coordinationMode: true, lastActivity: 1 };
  var worker = { id: 2, orchestrationParent: { sessionId: 1 }, lastActivity: 10 };
  var getDateGroup = function () { return "Today"; };

  var model = m.buildSessionListModel([coordinator, worker], {
    frozenOrder: null,
    frozenOrderSlug: null,
    currentSlug: "slug-1",
    // Coordinator id 1 itself is not a search match, but its child (2) is.
    searchMatchIds: new Set([2]),
    getDateGroup: getDateGroup,
  });

  var coordinatorItem = model.regularItems.find(function (i) { return i.type === "coordinator"; });
  assert.ok(coordinatorItem, "coordinator item should remain visible via its matching child");
  assert.equal(coordinatorItem.data.id, 1);
});

test("sessionListSignature: differs when active loop/coordinator state changes", async function () {
  var m = await loadModel();
  var base = [{ id: 1, lastActivity: 1, active: true, loop: { loopId: "loop-a" } }];
  var otherLoop = [{ id: 1, lastActivity: 1, active: true, loop: { loopId: "loop-b" } }];
  assert.notEqual(
    m.sessionListSignature(base, "", null, {}),
    m.sessionListSignature(otherLoop, "", null, {})
  );

  var withCoordinatorParent = [{ id: 2, lastActivity: 1, active: true, orchestrationParent: { sessionId: 9 } }];
  var withDifferentCoordinator = [{ id: 2, lastActivity: 1, active: true, orchestrationParent: { sessionId: 10 } }];
  assert.notEqual(
    m.sessionListSignature(withCoordinatorParent, "", null, {}),
    m.sessionListSignature(withDifferentCoordinator, "", null, {})
  );
});

test("sessionListSignature: differs on search and expanded-group state", async function () {
  var m = await loadModel();
  var sessions = [{ id: 1, lastActivity: 1 }];
  assert.notEqual(
    m.sessionListSignature(sessions, "abc", null, {}),
    m.sessionListSignature(sessions, "xyz", null, {})
  );
  assert.notEqual(
    m.sessionListSignature(sessions, "", new Set([1]), {}),
    m.sessionListSignature(sessions, "", new Set([1, 2]), {})
  );
  assert.notEqual(
    m.sessionListSignature(sessions, "", null, { "worker-1": true }),
    m.sessionListSignature(sessions, "", null, { "worker-1": false })
  );
  assert.notEqual(
    m.sessionListSignature(sessions, "", null, {}, new Set(["loop-1"]), new Set()),
    m.sessionListSignature(sessions, "", null, {}, new Set(), new Set())
  );
  assert.notEqual(
    m.sessionListSignature(sessions, "", null, {}, new Set(), new Set(["run-1"])),
    m.sessionListSignature(sessions, "", null, {}, new Set(), new Set())
  );
});

test("sessionListSignature: stable for equivalent input, changes when a tracked field changes", async function () {
  var m = await loadModel();
  var sessionA = { id: 1, title: "A", unread: 0, lastActivity: 1 };
  var sessionB = { id: 1, title: "A", unread: 0, lastActivity: 1 };
  assert.equal(
    m.sessionListSignature([sessionA], "", null, {}),
    m.sessionListSignature([sessionB], "", null, {})
  );
  var changed = { id: 1, title: "A", unread: 1, lastActivity: 1 };
  assert.notEqual(
    m.sessionListSignature([sessionA], "", null, {}),
    m.sessionListSignature([changed], "", null, {})
  );
});

test("partitionSessionList: separates loop sessions from normal sessions and drops hidden crafting sessions", async function () {
  var m = await loadModel();
  var normal = { id: 1 };
  var looped = { id: 2, loop: { loopId: "loop-1", startedAt: 0 } };
  var hiddenCrafting = { id: 3, loop: { loopId: "loop-2", role: "crafting", source: "other" } };
  var partition = m.partitionSessionList([normal, looped, hiddenCrafting]);
  assert.deepEqual(partition.normalSessions, [normal]);
  var keys = Object.keys(partition.loopGroups);
  assert.equal(keys.length, 1);
  assert.deepEqual(partition.loopGroups[keys[0]], [looped]);
});

test("buildSessionListItems: nests workers beneath their coordinator and builds loop groups", async function () {
  var m = await loadModel();
  var coordinator = { id: 1, coordinationMode: true, lastActivity: 5 };
  var worker = { id: 2, orchestrationParent: { sessionId: 1 }, lastActivity: 10 };
  var loopA = { id: 3, loop: { loopId: "loop-x", startedAt: 0 }, lastActivity: 3 };
  var partition = m.partitionSessionList([coordinator, worker, loopA]);
  var items = m.buildSessionListItems(partition.normalSessions, partition.loopGroups);

  var coordinatorItem = items.find(function (i) { return i.type === "coordinator"; });
  assert.ok(coordinatorItem);
  assert.equal(coordinatorItem.children.length, 1);
  assert.equal(coordinatorItem.children[0].id, 2);

  var loopItem = items.find(function (i) { return i.type === "loop"; });
  assert.ok(loopItem);
  assert.equal(loopItem.children.length, 1);
  assert.equal(loopItem.children[0].id, 3);
});

test("orderSessionListItems: freezes order across a matching slug and reorders fresh items to the front", async function () {
  var m = await loadModel();
  var itemA = { type: "session", data: { id: 1, bookmarked: false }, lastActivity: 1 };
  var itemB = { type: "session", data: { id: 2, bookmarked: false }, lastActivity: 2 };
  var first = m.orderSessionListItems([itemA, itemB], null, null, "slug-1");
  assert.deepEqual(first.items.map(function (i) { return i.data.id; }), [2, 1]);

  var itemC = { type: "session", data: { id: 3, bookmarked: false }, lastActivity: 50 };
  var second = m.orderSessionListItems(
    [itemA, itemB, itemC],
    first.frozenOrder,
    "slug-1",
    "slug-1"
  );
  // Fresh item (not in frozen order) sorts to the front; known items keep frozen order.
  assert.deepEqual(second.items.map(function (i) { return i.data.id; }), [3, 2, 1]);

  var afterSlugChange = m.orderSessionListItems([itemA, itemB], first.frozenOrder, "slug-1", "slug-2");
  assert.deepEqual(afterSlugChange.items.map(function (i) { return i.data.id; }), [2, 1]);
  assert.equal(afterSlugChange.frozenOrderSlug, "slug-2");
});

test("buildSessionListModel: partitions bookmarked vs regular, buckets by date group, and reports frozen order", async function () {
  var m = await loadModel();
  var bookmarked = { id: 1, bookmarked: true, lastActivity: 1 };
  var todaySession = { id: 2, lastActivity: 100 };
  var olderSession = { id: 3, lastActivity: 1 };
  var getDateGroup = function (ts) { return ts >= 100 ? "Today" : "Older"; };

  var model = m.buildSessionListModel([bookmarked, todaySession, olderSession], {
    frozenOrder: null,
    frozenOrderSlug: null,
    currentSlug: "slug-1",
    searchMatchIds: null,
    getDateGroup: getDateGroup,
  });

  assert.equal(model.bookmarkedItems.length, 1);
  assert.equal(model.bookmarkedItems[0].data.id, 1);
  assert.deepEqual(model.regularItems.map(function (i) { return i.data.id; }), [2, 3]);
  assert.deepEqual(model.dateGroups.map(function (g) { return g.name; }), ["Today", "Older"]);
  assert.deepEqual(model.dateGroups[0].sessionIds, [2]);
  assert.deepEqual(model.dateGroups[1].sessionIds, [3]);
  assert.ok(Array.isArray(model.frozenOrder));
  assert.equal(model.frozenOrderSlug, "slug-1");
});

test("buildSessionListModel: respects search visibility when splitting and grouping items", async function () {
  var m = await loadModel();
  var visible = { id: 1, lastActivity: 10 };
  var hidden = { id: 2, lastActivity: 5 };
  var getDateGroup = function () { return "Today"; };

  var model = m.buildSessionListModel([visible, hidden], {
    frozenOrder: null,
    frozenOrderSlug: null,
    currentSlug: "slug-1",
    searchMatchIds: new Set([1]),
    getDateGroup: getDateGroup,
  });

  assert.deepEqual(model.regularItems.map(function (i) { return i.data.id; }), [1]);
  assert.deepEqual(model.dateGroups[0].sessionIds, [1]);
});
