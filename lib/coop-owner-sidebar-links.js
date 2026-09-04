// Exact topic/session/binding lineage used by the owner-work projection.

function text(value, fallback) {
  var result = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ").trim();
  return result || fallback || "";
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function topicId(ref) {
  return ref && typeof ref.topicId === "string" ? ref.topicId : "";
}

function sessionKey(ref) {
  return ref && ref.projectId && ref.sessionStorageId ?
    ref.projectId + ":" + ref.sessionStorageId : "";
}

function taskKey(ref) {
  return ref && ref.projectId && ref.taskId ? ref.projectId + ":" + ref.taskId : "";
}

function linksFor(record) {
  return record && record.links || {};
}

function taskIndex(links) {
  var result = {};
  var refs = Array.isArray(links.tasks) ? links.tasks : [];
  for (var i = 0; i < refs.length; i++) result[taskKey(refs[i])] = true;
  return result;
}

function sessionIndex(links) {
  var result = {};
  var refs = [].concat(links.coordinators || [], links.sessions || []);
  for (var i = 0; i < refs.length; i++) result[sessionKey(refs[i])] = true;
  return result;
}

function sessionTopics(entry) {
  var refs = Array.isArray(entry.coopTopicRefs) ? entry.coopTopicRefs : [];
  if (refs.length || !entry.coopTopicRef) return refs;
  return [entry.coopTopicRef];
}

function sessionMatchesTopic(entry, wantedTopic) {
  return sessionTopics(entry).some(function (ref) { return topicId(ref) === wantedTopic; });
}

function sessionMatchesTask(entry, relatedTasks) {
  return !!relatedTasks[taskKey({ projectId: entry.sessionRef && entry.sessionRef.projectId,
    taskId: entry.parentTaskId })];
}

function sessionCanJoin(entry, wantedTopic, relatedTasks, linkedSessions) {
  return sessionMatchesTopic(entry, wantedTopic) || sessionMatchesTask(entry, relatedTasks) ||
    !!linkedSessions[sessionKey(entry.parentSessionRef)];
}

function expandSessionLinks(sessions, wantedTopic, relatedTasks, linkedSessions) {
  var changed = true;
  while (changed) {
    changed = false;
    for (var i = 0; i < sessions.length; i++) {
      var entry = sessions[i] || {};
      var key = sessionKey(entry.sessionRef);
      if (!key || linkedSessions[key]) continue;
      if (!sessionCanJoin(entry, wantedTopic, relatedTasks, linkedSessions)) continue;
      linkedSessions[key] = true;
      changed = true;
    }
  }
}

function topicSessions(record, sessions) {
  var links = linksFor(record);
  var list = Array.isArray(sessions) ? sessions : [];
  var linkedSessions = sessionIndex(links);
  expandSessionLinks(list, topicId(record && record.topicRef), taskIndex(links), linkedSessions);
  return list.filter(function (entry) { return !!linkedSessions[sessionKey(entry.sessionRef)]; });
}

function bindingMatches(binding, wantedTopic, linkedTasks) {
  var sameTopic = topicId(binding.coopTopicRef) === wantedTopic;
  var sameTask = !!linkedTasks[taskKey({ projectId: binding.targetProject && binding.targetProject.projectId,
    taskId: binding.portfolioTaskId })];
  return sameTopic || sameTask;
}

function directBindingCandidates(bindings, wantedTopic, linkedTasks) {
  var candidates = [];
  var list = Array.isArray(bindings) ? bindings : [];
  for (var i = 0; i < list.length; i++) {
    var binding = list[i] || {};
    if (bindingMatches(binding, wantedTopic, linkedTasks)) candidates.push(binding);
  }
  return candidates;
}

function sessionBindingCandidates(sessions) {
  var candidates = [];
  for (var i = 0; i < sessions.length; i++) {
    var bindings = Array.isArray(sessions[i] && sessions[i].portfolioBindings) ?
      sessions[i].portfolioBindings : [];
    for (var j = 0; j < bindings.length; j++) candidates.push(bindings[j]);
  }
  return candidates;
}

function replacesBinding(candidate, existing) {
  if (!existing) return true;
  if (Number(candidate.bindingRevision) !== Number(existing.bindingRevision)) {
    return Number(candidate.bindingRevision) > Number(existing.bindingRevision);
  }
  return finite(candidate.updatedAt) > finite(existing.updatedAt);
}

function latestByTask(candidates) {
  var latest = {};
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i] || {};
    var key = text(candidate.portfolioTaskId, "");
    if (!key || !replacesBinding(candidate, latest[key])) continue;
    latest[key] = candidate;
  }
  return Object.keys(latest).map(function (key) { return latest[key]; });
}

function latestBindings(record, sessions, bindings) {
  var links = linksFor(record);
  var linkedTasks = taskIndex(links);
  var wantedTopic = topicId(record && record.topicRef);
  var candidates = directBindingCandidates(bindings, wantedTopic, linkedTasks)
    .concat(sessionBindingCandidates(Array.isArray(sessions) ? sessions : []));
  return latestByTask(candidates);
}

module.exports = { topicSessions: topicSessions, latestBindings: latestBindings };
