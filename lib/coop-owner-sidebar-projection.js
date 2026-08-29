// Durable owner work ledger for canonical Coop. A row is one recorded owner
// ingress, never a Thread or a session title guessed to be current. Threads
// remain navigation destinations; typed request, binding and session records
// decide the row's state.

var workIdentity = require("./coop-owner-work-identity");
var workRows = require("./coop-owner-work-rows");
var workLinks = require("./coop-owner-sidebar-links");
var projectIdentity = require("./project-identity");

function text(value, fallback) {
  var result = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function copy(value) {
  return value ? JSON.parse(JSON.stringify(value)) : null;
}

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function sessionKey(ref) {
  return ref && ref.projectId && ref.sessionStorageId
    ? ref.projectId + ":" + ref.sessionStorageId : "";
}

function taskKey(ref) {
  return ref && ref.projectId && ref.taskId ? ref.projectId + ":" + ref.taskId : "";
}

function projectTitleIndex(projects) {
  var result = {};
  var list = Array.isArray(projects) ? projects : [];
  for (var i = 0; i < list.length; i++) {
    var item = list[i] || {};
    var ref = item.projectRef || item;
    if (!ref.projectId || result[ref.projectId]) continue;
    result[ref.projectId] = text(item.title, "Project");
  }
  return result;
}

function meaningfulTitle(value) {
  var result = text(value, "");
  if (!result || /^owner request\s*#/i.test(result) || /^(council|triage)$/i.test(result)) return "";
  return result;
}

function unavailableTitle(record) {
  var sequence = Number(record && record.ingressSequence);
  return "Owner work context unavailable" + (sequence > 0 ? " · ingress " + sequence : "");
}

function sortBySequence(entries) {
  return entries.slice().sort(function (left, right) {
    var sequence = (Number(left.ingressSequence) || 0) - (Number(right.ingressSequence) || 0);
    if (sequence) return sequence;
    return String(left.entryId).localeCompare(String(right.entryId));
  });
}

function topicIndex(topics) {
  var result = {};
  var list = Array.isArray(topics) ? topics : [];
  for (var i = 0; i < list.length; i++) {
    var topic = list[i] || {};
    var id = topicId(topic.topicRef);
    if (id && !result[id]) result[id] = topic;
  }
  return result;
}

function sessionIndex(sessions) {
  var result = {};
  var list = Array.isArray(sessions) ? sessions : [];
  for (var i = 0; i < list.length; i++) {
    var session = list[i] || {};
    var key = sessionKey(session.sessionRef);
    if (key) result[key] = session;
  }
  return result;
}

function sessionLink(entry) {
  return {
    sessionRef: copy(entry.sessionRef),
    title: text(entry.title, "Project session"),
    role: text(entry.controlRole || entry.role, "session"),
    lifecycleState: text(entry.lifecycleState, "idle"),
    hidden: !!entry.hidden,
    present: entry.sessionPresent !== false,
  };
}

function addLink(list, entry) {
  var key = sessionKey(entry && entry.sessionRef);
  if (!key) return;
  for (var i = 0; i < list.length; i++) {
    if (sessionKey(list[i].sessionRef) === key) return;
  }
  list.push(sessionLink(entry));
}

function contextFor(record, input) {
  var contexts = input && input.requestContexts || {};
  return contexts[record && record.ingressId] || null;
}

function sourceSessionRef(record, context) {
  var exact = projectIdentity.normalizeSessionRef(context && context.sourceSessionRef);
  if (exact) return copy(exact);
  return copy(projectIdentity.normalizeSessionRef(record && record.requestRef));
}

function projectLinks(record, bindings, titles) {
  var result = [];
  var seen = {};
  function add(ref) {
    if (!ref || !ref.projectId || seen[ref.projectId]) return;
    seen[ref.projectId] = true;
    result.push({ projectRef: copy(ref), title: text(titles[ref.projectId], "Project") });
  }
  var refs = Array.isArray(record && record.projectRefs) ? record.projectRefs : [];
  for (var i = 0; i < refs.length; i++) add(refs[i]);
  for (var bi = 0; bi < bindings.length; bi++) add(bindings[bi] && bindings[bi].targetProject);
  return result;
}

function entryLinks(record, input, related) {
  var links = [];
  for (var i = 0; i < related.length; i++) addLink(links, related[i]);
  var source = record.links || {};
  var direct = [].concat(source.coordinators || [], source.sessions || []);
  var byRef = sessionIndex(input.sessions);
  for (var d = 0; d < direct.length; d++) {
    var ref = direct[d];
    var found = byRef[sessionKey(ref)];
    addLink(links, found || { sessionRef: ref, title: "Archived project session", sessionPresent: false });
  }
  return links;
}

function entryTitle(record, topic, context) {
  var topicTitle = meaningfulTitle(topic.title);
  var requestTitle = meaningfulTitle(context && context.title);
  return {
    title: topicTitle || requestTitle || unavailableTitle(record),
    source: topicTitle ? "topic" : (requestTitle ? "request" : "unavailable"),
  };
}

function entryUpdatedAt(record, related, bindings) {
  var updatedAt = Math.max(finite(record.updatedAt), finite(record.receivedAt),
    finite(record.outcome && record.outcome.at));
  for (var i = 0; i < related.length; i++) updatedAt = Math.max(updatedAt, finite(related[i].updatedAt));
  for (var bi = 0; bi < bindings.length; bi++) updatedAt = Math.max(updatedAt, finite(bindings[bi].updatedAt));
  return updatedAt;
}

function activityFor(record, related, bindings) {
  var latest = { at: finite(record && record.updatedAt), text: text(record && record.outcome && record.outcome.summary, "") };
  function consider(at, value) {
    var message = text(value, "");
    if (message && finite(at) >= latest.at) latest = { at: finite(at), text: message };
  }
  for (var i = 0; i < related.length; i++) {
    var action = related[i] && related[i].lastCoopAction || {};
    consider(action.at, action.report);
  }
  for (var bi = 0; bi < bindings.length; bi++) {
    consider(bindings[bi] && bindings[bi].updatedAt, bindings[bi] && bindings[bi].statusReason);
  }
  return latest.text;
}

function entryProjectRefs(record) {
  return copy(record.projectRefs) || [];
}

function entryTaskRefs(record) {
  return copy(record.links && record.links.tasks) || [];
}

function entrySourceSessionRefs(context) {
  return context && context.sourceSessionRef ? [copy(context.sourceSessionRef)] : [];
}

function entryCanonicalKey(record, bindings) {
  return workIdentity.canonicalKey({ ingressId: record.ingressId,
    topicRef: record.topicRef, taskRefs: record.links && record.links.tasks, bindings: bindings });
}

function buildEntry(record, input, topics) {
  var related = workLinks.topicSessions(record, input.sessions);
  var bindings = workLinks.latestBindings(record, related, input.executionBindings);
  var state = workRows.statusFor(record, related, bindings);
  var topic = topics[topicId(record.topicRef)] || {};
  var context = contextFor(record, input);
  var title = entryTitle(record, topic, context);
  return {
    entryId: record.ingressId,
    ingressId: record.ingressId,
    ingressSequence: Number(record.ingressSequence) || 0,
    title: title.title,
    titleSource: title.source,
    status: state.status,
    reason: workRows.reasonFor(record, state, bindings),
    activity: activityFor(record, related, bindings), evidence: state.evidence || "",
    updatedAt: entryUpdatedAt(record, related, bindings),
    receivedAt: finite(record.receivedAt),
    topicRef: copy(record.topicRef),
    threadRef: record.topicRef ? { threadId: record.topicRef.topicId } : null,
    requestRef: copy(record.requestRef),
    sourceSessionRef: sourceSessionRef(record, context),
    responseState: text(record.response && record.response.state, "unanswered"),
    projectRefs: entryProjectRefs(record),
    projects: projectLinks(record, bindings, projectTitleIndex(input.projectTitles)),
    sessions: entryLinks(record, input, related),
    taskRefs: entryTaskRefs(record),
    bindings: copy(bindings) || [],
    ingressIds: [record.ingressId],
    requestRefs: record.requestRef ? [copy(record.requestRef)] : [],
    sourceSessionRefs: entrySourceSessionRefs(context),
    canonicalKey: entryCanonicalKey(record, bindings),
    clearable: state.status === "completed" || state.status === "dismissed",
  };
}

// Some durable owner decisions are task-graph records rather than a new owner
// ingress (for example accepting a staged plan). Keep those visible without
// inventing a request row or allowing the task title to classify unrelated
// execution. A matching request owns the row and is upgraded through its own
// typed records instead, so this fallback cannot duplicate an owner ask.
function actionStatus(source) {
  return text(source && source.status, "needs_input").toLowerCase();
}

function actionProjectedStatus(status) {
  if (status === "failed") return "failed";
  if (status === "blocked" || status === "unrouted") return "blocked";
  return "needs_owner";
}

function actionSessions(source, status) {
  var detail = actionWorkerDetail(source);
  var destination = detail && detail.sessionRef || source && source.destination && source.destination.ref;
  if (!destination) return [];
  return [{ sessionRef: copy(destination),
    title: text(source && source.title, "Related worker session"), role: "worker",
    lifecycleState: status, hidden: false, present: true }];
}

function actionTaskRefs(source) {
  if (!source.taskId || !source.projectRef) return [];
  return [{ projectId: source.projectRef.projectId, taskId: source.taskId }];
}

function actionBindings(source) {
  if (!source.portfolioTaskId) return [];
  return [{ targetProject: source.projectRef, portfolioTaskId: source.portfolioTaskId }];
}

function actionProjects(source) {
  if (!source.projectRef) return [];
  return [{ projectRef: copy(source.projectRef), title: text(source.projectTitle, "Project") }];
}

function validSessionRef(value, projectRef) {
  if (!value || !projectRef || value.projectId !== projectRef.projectId ||
      !text(value.sessionStorageId, "")) return null;
  return { projectId: value.projectId, sessionStorageId: value.sessionStorageId };
}

function actionWorkerDetail(source) {
  var action = source || {};
  var projectRef = action.projectRef && action.projectRef.projectId
    ? { projectId: action.projectRef.projectId } : null;
  var raw = action.workerDetail || {};
  var type = raw.type === "worker_result" ? "worker_result" :
    (raw.type === "worker_question" ? "worker_question" : "");
  if (!projectRef || !type) return null;
  var detail = {
    type: type,
    projectRef: projectRef,
    sessionRef: validSessionRef(raw.sessionRef, projectRef),
  };
  if (type === "worker_result") {
    detail.resolution = text(raw.resolution, "Worker reported completion");
    detail.verification = text(raw.verification, "");
  } else {
    detail.question = text(raw.question, "Needs your decision");
    detail.reason = text(raw.reason, "");
  }
  return detail;
}

function actionControl(source) {
  if (!source || !text(source.itemId, "") || !source.projectRef || !source.projectRef.projectId ||
      !text(source.taskId, "")) return null;
  var workerDetail = actionWorkerDetail(source);
  return {
    itemId: text(source.itemId, ""), projectRef: copy(source.projectRef), taskId: text(source.taskId, ""),
    kind: source.kind === "acceptance" ? "acceptance" : "decision",
    status: actionStatus(source), decision: text(source.decision, "Needs your decision"),
    evidence: text(source.evidence, ""), projectTitle: text(source.projectTitle, "Project"),
    workerDetail: workerDetail,
  };
}

function actionEntry(action, topics) {
  var source = action || {};
  var status = actionStatus(source);
  var projected = actionProjectedStatus(status);
  var topic = topics[topicId(source.topicRef)] || {};
  var workerDetail = actionWorkerDetail(source);
  return {
    entryId: text(source.itemId, "owner-decision:" + topicId(source.topicRef)),
    ingressId: "",
    ingressSequence: Number(source.ingressSequence) || 0,
    title: text(source.title, text(topic.title, "Owner decision")),
    titleSource: "action",
    status: projected,
    reason: text(source.decision, projected === "failed" ? "Execution failed" : "Needs your decision"),
    updatedAt: finite(source.updatedAt), receivedAt: finite(source.updatedAt),
    topicRef: copy(source.topicRef), threadRef: source.topicRef ? { threadId: source.topicRef.topicId } : null,
    requestRef: null, responseState: "unanswered", projectRefs: source.projectRef ? [copy(source.projectRef)] : [],
    sourceSessionRef: workerDetail && copy(workerDetail.sessionRef),
    sessions: actionSessions(source, status), taskRefs: actionTaskRefs(source),
    bindings: actionBindings(source), ingressIds: [], requestRefs: [],
    sourceSessionRefs: workerDetail && workerDetail.sessionRef ? [copy(workerDetail.sessionRef)] : [],
    projects: actionProjects(source),
    activity: text(source.evidence, "") || text(source.decision, ""),
    evidence: text(source.evidence, ""), action: actionControl(source),
    canonicalKey: workIdentity.canonicalKey({ topicRef: source.topicRef, projectRef: source.projectRef,
      portfolioTaskId: source.portfolioTaskId || source.taskId }), clearable: false,
  };
}

function sidebarSections(entries) {
  var open = entries.filter(function (entry) { return !entry.hidden; });
  var hidden = entries.filter(function (entry) { return entry.hidden; });
  var working = open.filter(function (entry) { return entry.status === "working"; });
  var landed = open.filter(function (entry) { return entry.status === "completed"; });
  var dismissed = open.filter(function (entry) { return entry.status === "dismissed"; });
  var attention = open.filter(function (entry) {
    return entry.status !== "working" && entry.status !== "completed" && entry.status !== "dismissed";
  });
  return { open: open, hidden: hidden, working: working, attention: attention,
    landed: landed, dismissed: dismissed };
}

function addProjectRef(refs, ref) {
  if (!ref || !ref.projectId) return;
  for (var i = 0; i < refs.length; i++) if (refs[i].projectId === ref.projectId) return;
  refs.push({ projectId: ref.projectId });
}

// A dynamic action has an exact task ProjectRef, so it wins. Durable entries
// only join a project group when their references establish one unambiguous
// project; multi-project historical ingress remains visibly Unassigned rather
// than guessing from a title or a nearby row.
function canonicalProject(entry) {
  var action = entry && entry.action || {};
  if (action.projectRef && action.projectRef.projectId) return { projectId: action.projectRef.projectId };
  var refs = [];
  var projectRefs = Array.isArray(entry && entry.projectRefs) ? entry.projectRefs : [];
  for (var i = 0; i < projectRefs.length; i++) addProjectRef(refs, projectRefs[i]);
  var projects = Array.isArray(entry && entry.projects) ? entry.projects : [];
  for (var pi = 0; pi < projects.length; pi++) addProjectRef(refs, projects[pi] && projects[pi].projectRef);
  return refs.length === 1 ? refs[0] : null;
}

function projectTitleFor(entry, ref) {
  var action = entry && entry.action || {};
  if (action.projectRef && action.projectRef.projectId === ref.projectId) {
    return text(action.projectTitle, "Project");
  }
  var projects = Array.isArray(entry && entry.projects) ? entry.projects : [];
  for (var i = 0; i < projects.length; i++) {
    var project = projects[i] || {};
    if (project.projectRef && project.projectRef.projectId === ref.projectId) return text(project.title, "Project");
  }
  return "Project";
}

function attentionGroups(entries) {
  var byKey = {};
  var order = [];
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var ref = canonicalProject(entry);
    var key = ref ? ref.projectId : "__unassigned__";
    if (!byKey[key]) {
      byKey[key] = { key: key, projectRef: ref, title: ref ? projectTitleFor(entry, ref) : "Unassigned", entries: [] };
      order.push(key);
    }
    byKey[key].entries.push(entry);
  }
  var result = order.map(function (key) {
    var group = byKey[key];
    group.count = group.entries.length;
    return group;
  });
  return result.sort(function (left, right) {
    if (!left.projectRef) return right.projectRef ? 1 : 0;
    if (!right.projectRef) return -1;
    var titleOrder = left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
    if (titleOrder) return titleOrder;
    return left.projectRef.projectId.localeCompare(right.projectRef.projectId);
  });
}

function requestCandidates(records, value, topics, hidden) {
  var candidates = [];
  for (var r = 0; r < records.length; r++) {
    var record = records[r];
    if (!record || !record.ingressId) continue;
    var entry = buildEntry(record, value, topics);
    entry.hidden = !!hidden[entry.entryId];
    candidates.push({ entry: entry, identity: { ingressId: record.ingressId,
      topicRef: record.topicRef, taskRefs: entry.taskRefs, bindings: entry.bindings } });
  }
  return candidates;
}

function actionCandidates(actions, topics, hidden) {
  var candidates = [];
  for (var a = 0; a < actions.length; a++) {
    var action = actions[a] || {};
    var actionRow = actionEntry(action, topics);
    if (!actionRow.entryId) continue;
    actionRow.hidden = !!hidden[actionRow.entryId];
    candidates.push({ entry: actionRow, identity: { topicRef: action.topicRef,
      projectRef: action.projectRef, portfolioTaskId: action.portfolioTaskId || action.taskId } });
  }
  return candidates;
}

function buildOwnerSidebar(input) {
  var value = input || {};
  var records = Array.isArray(value.requests) ? value.requests : [];
  var topics = topicIndex(value.topics);
  var visibility = value.visibility || value.priority || {};
  var hiddenIds = Array.isArray(visibility.hidden) ? visibility.hidden : [];
  var hidden = {};
  for (var i = 0; i < hiddenIds.length; i++) hidden[String(hiddenIds[i])] = true;
  var actions = Array.isArray(value.actionQueue) ? value.actionQueue : [];
  var candidates = requestCandidates(records, value, topics, hidden)
    .concat(actionCandidates(actions, topics, hidden));
  var groups = workIdentity.group(candidates);
  var entries = groups.map(workRows.mergeEntries);
  entries = sortBySequence(entries);
  var sections = sidebarSections(entries);
  var groups = attentionGroups(sections.attention);
  return {
    defaultOpen: true,
    revision: Number(visibility.revision) || 0,
    entries: entries,
    open: sections.open,
    working: sections.working,
    attention: sections.attention,
    attentionGroups: groups,
    landed: sections.landed,
    dismissed: sections.dismissed,
    hidden: sections.hidden,
    counts: { working: sections.working.length, attention: sections.attention.length,
      landed: sections.landed.length, dismissed: sections.dismissed.length,
      hidden: sections.hidden.length },
  };
}

module.exports = { buildOwnerSidebar: buildOwnerSidebar };
