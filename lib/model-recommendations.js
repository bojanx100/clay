var { MODEL_GUIDANCE_MARKER } = require("./yoke/instructions");
var { mainAgentEscalationPolicy } = require("./provider-agent-pipeline");

function labelForVendor(vendor) {
  if (vendor === "claude") return "Claude";
  if (vendor === "codex") return "Codex";
  if (vendor === "github-copilot") return "GitHub Copilot";
  return vendor || "current provider";
}

function normalizeModel(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.model || model.id || model.name || "";
}

function buildModelRecommendationPrompt(vendor, model) {
  var providerLabel = labelForVendor(vendor);
  var modelId = normalizeModel(model);
  var current = modelId ? (providerLabel + " model: " + modelId) : (providerLabel + " model");
  return [
    MODEL_GUIDANCE_MARKER,
    "Current runtime: " + current + ".",
    "If the user's task would materially benefit from a different model, say so briefly before or after your normal answer. Do not stop working unless the user asks to switch.",
    "Suggest Fable for the hardest ambiguous product, design, or architecture decisions where broader judgment matters more than speed.",
    "Suggest Opus for difficult implementation, debugging, refactoring, security review, or careful codebase reasoning.",
    "Suggest Sonnet for everyday implementation when speed and quality both matter.",
    "Suggest Haiku for quick answers, small edits, and low-risk mechanical tasks.",
    "Suggest GPT-6 Astra for the hardest end-to-end Codex work, complex reasoning, coding, research, computer-use, or document creation.",
    "Suggest GPT-5.6 Sol for complex Codex work when Astra's additional depth and cost are unnecessary.",
    "Suggest GPT-5.6 Terra or GPT-5.5 for strong everyday Codex work when Sol's depth is unnecessary.",
    "Suggest GPT-5.6 Luna, GPT-5.4 Mini, or Spark for fast, clear, repeatable, low-risk changes.",
    "If you are the main agent and delegation is explicitly requested or applicable instructions call for it, use the configured provider-matched worker first and keep product judgment, integration, and final verification in the main thread. Skip delegation for small tasks.",
    mainAgentEscalationPolicy(),
    "Phrase suggestions plainly, for example: \"I can do this, but Opus would be a better fit for the implementation/debugging depth here\" or \"This is more of a Fable-style strategy problem.\"",
    "--- End model selection guidance ---",
  ].join("\n");
}

module.exports = {
  buildModelRecommendationPrompt: buildModelRecommendationPrompt,
};
