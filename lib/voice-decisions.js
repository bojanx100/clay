// Voice decisions expose the same one-request choices as the existing cards.
// Read current plan bytes again at submission so an edited plan invalidates the
// reviewed revision. No persistent allow-list or permission mode is changed.
var fs = require("fs");
function isPlanPath(value) { return typeof value === "string" && /[\\/]\.(?:claude|codex)[\\/]plans[\\/].+\.md$/.test(value); }
function planFor(session, pending) {
  var input = pending.toolInput || {};
  var file = input.planFilePath;
  if (!file) {
    var history = session.history || [];
    for (var i = history.length - 1; i >= 0; i--) {
      var event = history[i];
      if ((event.type === "tool_start" || event.type === "tool_executing") && event.name === "EnterPlanMode") break;
      if (event.type === "tool_executing" && (event.name === "Write" || event.name === "Edit") &&
          event.input && isPlanPath(event.input.file_path)) { file = event.input.file_path; break; }
    }
  }
  if (file) {
    if (!isPlanPath(file)) return null;
    try {
      var stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > 64000) return null;
      var content = fs.readFileSync(file, "utf8");
      return content.trim() ? { file: file, content: content } : null;
    } catch (error) { return null; }
  }
  return typeof input.plan === "string" && input.plan.trim() && input.plan.length <= 64000 ?
    { content: input.plan } : null;
}
function permission(session, pending) {
  if (!pending || typeof pending.resolve !== "function" || !pending.toolName) return null;
  var plan = pending.toolName === "ExitPlanMode";
  var details = plan ? planFor(session, pending) : pending.toolInput || {};
  if (!details) return null;
  var serialized = JSON.stringify(details);
  if (!plan && serialized.length > 12000) return null;
  var raw = { toolName: pending.toolName, input: pending.toolInput, details: details, reason: pending.decisionReason || "" };
  return { kind: plan ? "plan" : "permission", evidence: raw,
    questions: [{ id: "decision", question: plan ? "Plan for review: " + details.content :
      "Permission to run " + pending.toolName + ". Requested input: " + serialized +
        (pending.decisionReason ? ". Reason: " + pending.decisionReason : ""),
      options: [{ label: plan ? "Approve this plan" : "Allow this request once",
        description: plan ? "Continue with the current permission settings." : "This request only." },
        { label: plan ? "Reject this plan" : "Deny this request", description: "Do not proceed with this request." }],
      allowOther: true, multiSelect: false }], confirmation: "submit decision" };
}
function response(request, answers) {
  var choice = answers.decision[0];
  var approved = choice === request.questions[0].options[0].label;
  var denied = choice === request.questions[0].options[1].label;
  return { type: "permission_response", requestId: request.requestId, ingressType: "voice",
    decision: approved ? "allow" : denied ? "deny" : "deny_with_feedback",
    feedback: !approved && !denied ? choice : undefined };
}
module.exports = { permission: permission, response: response };
