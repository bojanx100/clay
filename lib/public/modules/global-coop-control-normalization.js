import { cloneReference } from './sidebar-coop-topic-model.js';

function text(value, fallback) {
  var result = typeof value === "string" ? value.trim() : "";
  return result || fallback || "";
}

function rank(item) {
  var status = text(item && item.status, "idle");
  if (status === "running" && item && item.processing === true) return 8;
  if (status === "running") return 7;
  if (status === "reviewing") return 6;
  if (status === "needs_input" || status === "waiting_user") return 5;
  if (status === "queued" || status === "ready") return 4;
  if (status === "blocked") return 3;
  if (status === "failed") return 2;
  if (status === "completed") return 1;
  return 0;
}

function normalized(item) {
  var source = item || {};
  var role = text(source.role, "");
  var sessionRef = cloneReference(source.sessionRef);
  if (role !== "council" && role !== "triage") return null;
  if (!sessionRef || !sessionRef.projectId || !sessionRef.sessionStorageId) return null;
  var status = text(source.status, "idle");
  return {
    role: role,
    title: text(source.title, "Control plane"),
    sessionRef: sessionRef,
    status: status,
    activity: text(source.activity, ""),
    processing: source.processing === true && status === "running",
    topicRef: cloneReference(source.topicRef),
    projectRef: cloneReference(source.projectRef),
    projectTitle: text(source.projectTitle, ""),
    topicTitle: text(source.topicTitle, ""),
    question: text(source.question, ""),
    taskRef: cloneReference(source.taskRef),
    containerSessionRef: cloneReference(source.containerSessionRef),
    canonicalKey: text(source.canonicalKey, ""),
    updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : null,
  };
}

export function normalizeControlPlaneSessions(value) {
  var items = Array.isArray(value) ? value : [];
  var order = [];
  var byKey = {};
  for (var i = 0; i < items.length; i++) {
    var item = normalized(items[i]);
    if (!item) continue;
    var key = item.role + ":" + (item.canonicalKey ||
      item.sessionRef.projectId + ":" + item.sessionRef.sessionStorageId);
    if (!byKey[key]) order.push(key);
    if (!byKey[key] || rank(item) >= rank(byKey[key])) byKey[key] = item;
  }
  return order.map(function (key) { return byKey[key]; });
}
