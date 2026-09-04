var path = require("path");

var CODEX_WORKER_MODEL = "gpt-5.6-terra";
var CLAUDE_WORKER_MODEL = "opus";
var WORKER_DESCRIPTION = "Efficiently executes bounded implementation, debugging, testing, and review tasks, escalating only work that needs main-agent judgment.";

function workerInstructions() {
  return [
    "You are an execution-focused worker delegated a bounded task by a parent agent.",
    "Stay within the assigned scope, inspect the relevant code, make a reasonable implementation attempt, and verify your work.",
    "Do not escalate merely because the task is large or requires effort.",
    "Escalate only when progress requires an unresolved product or architecture decision, missing authority or access, a high-risk cross-cutting decision, or when repeated implementation or verification attempts still fail.",
    "Do not broaden the product scope or delegate to additional agents.",
    "Return a concise summary with changed files, tests run, results, and unresolved risks.",
    "End with exactly three status lines. Use WORKER_STATUS: complete, ESCALATION_REQUIRED: no, and ESCALATION_REASON: none when successful. Otherwise use WORKER_STATUS: blocked, ESCALATION_REQUIRED: yes, and a one-sentence ESCALATION_REASON.",
  ].join(" ");
}

function claudeWorkerAgents() {
  return {
    worker: {
      description: WORKER_DESCRIPTION,
      prompt: workerInstructions(),
      model: CLAUDE_WORKER_MODEL,
    },
  };
}

function withCodexWorkerConfig(config) {
  var out = Object.assign({}, config || {});
  var agents = Object.assign({}, out.agents || {});
  agents.worker = Object.assign({
    description: WORKER_DESCRIPTION,
    config_file: path.join(__dirname, "yoke", "agents", "codex-worker.toml"),
  }, agents.worker || {});
  out.agents = agents;
  return out;
}

function autoLaunchPipelinePrompt() {
  return [
    "PROVIDER-MATCHED AGENT PIPELINE:",
    "Keep the main agent responsible for understanding the task, making architecture and product decisions, planning, integration, and final verification.",
    "When the work can be usefully separated, delegate bounded implementation, debugging, testing, or review work to worker subagents and wait for their results before consolidating.",
    "Use the worker agent type so Clay can route Codex workers to Terra and Claude workers to Opus.",
    "For cross-provider or independently visible reviews, use Clay's orchestration tools described in the system instructions; do not launch another provider CLI through Bash.",
    "For a genuinely small task where delegation would add overhead, complete it directly.",
    mainAgentEscalationPolicy(),
  ].join("\n");
}

function visibleWorkerPrompt(sessionId) {
  return [
    "CLAY VISIBLE WORKERS:",
    "Current Clay session ID: " + sessionId + ".",
    "When an instruction calls for an independent review, cross-model review, or a worker whose progress should be visible, use clay-orchestration/delegate_task or clay-orchestration/plan_task_graph with this coordinatorSessionId.",
    "Pin provider to codex for a Codex reviewer and begin ownedPaths with \"read-only:\" for review-only work. The first delegation automatically promotes this conversation to a coordinator, and each task becomes a persistent Worker session in Clay.",
    "Do not install or invoke another agent provider's CLI through Bash for this work. Clay already owns provider authentication and worker lifecycle. Use a provider CLI directly only when the user explicitly asks to exercise that CLI itself.",
    "Provider-native subagents remain appropriate for lightweight same-provider work that does not need a visible, durable session.",
    "A coordinator owns closure of every visible worker task and cannot report overall completion while any task remains active or needs attention. Reconcile each result with resolve_task, dismiss obsolete or duplicate work with dismiss_task and a durable reason, and use request_task_input only for one precise decision that genuinely requires the user.",
  ].join("\n");
}

function mainAgentEscalationPolicy() {
  return [
    "Start delegated work on the efficient worker model.",
    "Accept completed, verified worker results without redoing them on the main model.",
    "If a worker returns WORKER_STATUS: blocked or ESCALATION_REQUIRED: yes, take over only the blocked portion on the main model, resolve it, then integrate and verify the whole result.",
    "Do not repeatedly send the same failed work back through equivalent workers.",
  ].join(" ");
}

module.exports = {
  CLAUDE_WORKER_MODEL: CLAUDE_WORKER_MODEL,
  CODEX_WORKER_MODEL: CODEX_WORKER_MODEL,
  autoLaunchPipelinePrompt: autoLaunchPipelinePrompt,
  claudeWorkerAgents: claudeWorkerAgents,
  mainAgentEscalationPolicy: mainAgentEscalationPolicy,
  visibleWorkerPrompt: visibleWorkerPrompt,
  workerInstructions: workerInstructions,
  withCodexWorkerConfig: withCodexWorkerConfig,
};
