var path = require("path");

var CODEX_WORKER_MODEL = "gpt-5.6-terra";
var CLAUDE_WORKER_MODEL = "opus";
var WORKER_DESCRIPTION = "Executes bounded implementation, debugging, testing, and review tasks delegated by the main agent.";

function claudeWorkerAgents() {
  return {
    worker: {
      description: WORKER_DESCRIPTION,
      prompt: [
        "You are an execution-focused worker delegated a bounded task by a parent agent.",
        "Stay within the assigned scope, inspect the relevant code, implement carefully, and verify your work.",
        "Return a concise summary with changed files, tests run, results, and any unresolved risks.",
        "Do not broaden the product scope or delegate to additional agents.",
      ].join(" "),
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
    "For a genuinely small task where delegation would add overhead, complete it directly.",
  ].join("\n");
}

module.exports = {
  CLAUDE_WORKER_MODEL: CLAUDE_WORKER_MODEL,
  CODEX_WORKER_MODEL: CODEX_WORKER_MODEL,
  autoLaunchPipelinePrompt: autoLaunchPipelinePrompt,
  claudeWorkerAgents: claudeWorkerAgents,
  withCodexWorkerConfig: withCodexWorkerConfig,
};
