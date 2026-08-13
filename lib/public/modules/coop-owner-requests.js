import { store } from './store.js';
import { getWs } from './ws-ref.js';

// Owner-facing view of the execution flow, fed by the server's read-only
// coop_owner_requests overview.
//
// The server owns every judgement here -- what is unanswered, what is live,
// what is merely hidden or finished. The client only shapes rows: deriving
// "still working" on the client is exactly how a finished topic used to keep a
// spinner alive after the server had already called it done.

var EMPTY = {
  unanswered: [],
  topics: [],
  counts: { unanswered: 0, topics: 0, working: 0, needsInput: 0, attention: 0 },
};

export function requestOwnerRequestOverview() {
  var ws = getWs();
  if (!ws || ws.readyState !== 1) return false;
  ws.send(JSON.stringify({ type: 'coop_owner_requests_request' }));
  return true;
}

export function handleOwnerRequestOverview(msg) {
  if (!msg || msg.type !== 'coop_owner_requests') return false;
  if (!msg.ok) {
    // A refusal is not an empty flow. Keep whatever was last known good and
    // record the code, so the panel can say it is stale rather than silently
    // claiming the owner has nothing outstanding.
    store.set({ coopOwnerRequestsError: msg.code || 'unavailable' });
    return true;
  }
  store.set({
    coopOwnerRequestsError: null,
    coopOwnerRequests: {
      unanswered: Array.isArray(msg.unanswered) ? msg.unanswered : [],
      topics: Array.isArray(msg.topics) ? msg.topics : [],
      counts: msg.counts || EMPTY.counts,
    },
  });
  return true;
}

export function ownerRequestOverview() {
  return store.get('coopOwnerRequests') || EMPTY;
}

function workerRow(worker, depth) {
  return {
    kind: 'worker',
    depth: depth,
    label: worker.title || 'Worker',
    sessionRef: worker.sessionRef,
    workState: worker.workState,
    live: !!worker.live,
    present: !!worker.present,
    hidden: !!worker.hidden,
  };
}

function taskCoordinatorRow(coordinator, depth) {
  return {
    kind: 'task_coordinator',
    depth: depth,
    label: coordinator.title || 'Task coordinator',
    sessionRef: coordinator.sessionRef,
    workState: coordinator.workState,
    live: !!coordinator.live,
    present: !!coordinator.present,
    hidden: !!coordinator.hidden,
  };
}

function topicRow(topic) {
  return {
    kind: 'topic',
    depth: 0,
    label: topic.title || 'Untitled topic',
    topicRef: topic.topicRef,
    status: topic.status || '',
    unansweredCount: topic.unansweredCount || 0,
    workingCount: topic.workingCount || 0,
    needsInputCount: topic.needsInputCount || 0,
    attentionCount: topic.attentionCount || 0,
  };
}

function projectCoordinatorRow(coordinator) {
  return {
    kind: 'coordinator',
    depth: 2,
    label: coordinator.title || 'Project coordinator',
    sessionRef: coordinator.sessionRef,
    workState: coordinator.workState,
    live: !!coordinator.live,
    present: !!coordinator.present,
    hidden: !!coordinator.hidden,
  };
}

function appendTaskCoordinatorRows(rows, taskCoordinators) {
  var list = Array.isArray(taskCoordinators) ? taskCoordinators : [];
  for (var i = 0; i < list.length; i++) {
    rows.push(taskCoordinatorRow(list[i], 3));
    var workers = Array.isArray(list[i].workers) ? list[i].workers : [];
    for (var w = 0; w < workers.length; w++) rows.push(workerRow(workers[w], 4));
  }
}

function appendProjectRows(rows, project) {
  rows.push({
    kind: 'project',
    depth: 1,
    label: project.projectRef && project.projectRef.projectId || '',
    projectRef: project.projectRef,
  });
  if (project.coordinator) rows.push(projectCoordinatorRow(project.coordinator));
  appendTaskCoordinatorRows(rows, project.taskCoordinators);
  var workers = Array.isArray(project.workers) ? project.workers : [];
  for (var i = 0; i < workers.length; i++) rows.push(workerRow(workers[i], 3));
}

// Flattened rows for rendering: topic -> project -> coordinator -> workers.
// Pure, so the shape is testable without a DOM.
export function ownerRequestRows(overview) {
  var source = overview || ownerRequestOverview();
  var topics = Array.isArray(source.topics) ? source.topics : [];
  var rows = [];
  for (var t = 0; t < topics.length; t++) {
    var topic = topics[t];
    rows.push(topicRow(topic));
    var projects = Array.isArray(topic.projects) ? topic.projects : [];
    for (var p = 0; p < projects.length; p++) appendProjectRows(rows, projects[p]);
  }
  return rows;
}

// The unanswered list is a separate, deliberately un-nested surface: it is the
// one thing that outranks the tree above it, so it must not be something the
// owner has to expand a topic to find.
export function unansweredRows(overview) {
  var source = overview || ownerRequestOverview();
  var list = Array.isArray(source.unanswered) ? source.unanswered : [];
  return list.map(function (request) {
    return {
      ingressId: request.ingressId,
      ingressSequence: request.ingressSequence,
      label: request.topicTitle || 'Uncategorised request',
      topicRef: request.topicRef,
      requestRef: request.requestRef,
      receivedAt: request.receivedAt,
      classification: request.classification || '',
      state: request.state,
      attention: request.attention || null,
      // Waiting on the owner is a different kind of outstanding from waiting on
      // Coop, and the panel styles them differently.
      blockedOnOwner: request.state === 'needs_input' || request.state === 'attention',
    };
  });
}
