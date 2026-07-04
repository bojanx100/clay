import { refreshIfOpen } from './filebrowser.js';
import { setActivity, startUrgentBlink, stopUrgentBlink } from './app-favicon.js';
import { stopThinking, createToolItem, updateToolExecuting, updateToolResult, appendToolOutput, markAllToolsDone, removeToolFromGroup, getTools, getPlanContent, setPlanContent, renderPlanBanner, renderPlanCard, getTodoTools, handleTodoWrite, handleTaskCreate, handleTaskUpdate, isPlanFilePath, updateSubagentActivity, addSubagentToolEntry, markSubagentDone, initSubagentStop, updateSubagentProgress, updateSubagentTaskStatus, renderAskUserQuestion, markAskUserAnswered, renderPermissionRequest, markPermissionCancelled, markPermissionResolved, renderElicitationRequest, markElicitationResolved, renderUserDialogRequest, markUserDialogResolved } from './tools.js';
import { scrollToBottom, addToMessages, finalizeAssistantBlock, removeMatePreThinking } from './app-rendering.js';
import { renderMcpDebateProposal } from './debate.js';

export function handleToolMessage(msg) {
  switch (msg.type) {
    case "tool_start":
      handleToolStart(msg);
      return true;
    case "tool_executing":
      handleToolExecuting(msg);
      return true;
    case "tool_result":
      handleToolResult(msg);
      return true;
    case "tool_output":
      appendToolOutput(msg.id, msg.text);
      return true;
    case "ask_user_answered":
      markAskUserAnswered(msg.toolId, msg.answers);
      stopUrgentBlink();
      return true;
    case "permission_request":
      renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason, msg.mateId, msg.vendor);
      startUrgentBlink();
      return true;
    case "permission_cancel":
      markPermissionCancelled(msg.requestId);
      stopUrgentBlink();
      return true;
    case "permission_resolved":
      markPermissionResolved(msg.requestId, msg.decision);
      stopUrgentBlink();
      return true;
    case "permission_request_pending":
      renderPermissionRequest(msg.requestId, msg.toolName, msg.toolInput, msg.decisionReason, msg.mateId, msg.vendor);
      startUrgentBlink();
      return true;
    case "elicitation_request":
      renderElicitationRequest(msg);
      startUrgentBlink();
      return true;
    case "elicitation_resolved":
      markElicitationResolved(msg.requestId, msg.action);
      stopUrgentBlink();
      return true;
    case "user_dialog_request":
      renderUserDialogRequest(msg);
      startUrgentBlink();
      return true;
    case "user_dialog_resolved":
      markUserDialogResolved(msg.requestId, msg.behavior);
      stopUrgentBlink();
      return true;
    case "slash_command_result":
      renderSlashCommandResult(msg);
      return true;
    case "subagent_activity":
      updateSubagentActivity(msg.parentToolId, msg.text);
      return true;
    case "subagent_tool":
      addSubagentToolEntry(msg.parentToolId, msg.toolName, msg.toolId, msg.text);
      return true;
    case "subagent_done":
      markSubagentDone(msg.parentToolId, msg.status, msg.summary, msg.usage);
      return true;
    case "task_started":
      initSubagentStop(msg.parentToolId, msg.taskId);
      return true;
    case "task_progress":
      updateSubagentProgress(msg.parentToolId, msg.usage, msg.lastToolName, msg.summary);
      return true;
    case "task_updated":
      updateSubagentTaskStatus(msg.parentToolId, msg.patch);
      return true;
    default:
      return false;
  }
}

function handleToolStart(msg) {
  removeMatePreThinking();
  setActivity(null);
  stopThinking();
  markAllToolsDone();
  if (msg.name === "EnterPlanMode") {
    renderPlanBanner("enter");
    getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
  } else if (msg.name === "ExitPlanMode") {
    if (getPlanContent()) {
      renderPlanCard(getPlanContent());
    }
    renderPlanBanner("exit");
    getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
  } else if (msg.name === "propose_debate" || (msg.name && msg.name.indexOf("propose_debate") !== -1)) {
    getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
  } else if (msg.name === "ask_user_questions") {
    getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
  } else if (getTodoTools()[msg.name]) {
    getTools()[msg.id] = { el: null, name: msg.name, input: null, done: true, hidden: true };
  } else {
    createToolItem(msg.id, msg.name);
  }
}

function handleToolExecuting(msg) {
  if ((msg.name === "propose_debate" || (msg.name && msg.name.indexOf("propose_debate") !== -1)) && msg.input) {
    var debateTool = getTools()[msg.id];
    if (debateTool) {
      if (debateTool.el) debateTool.el.style.display = "none";
      debateTool.done = true;
      debateTool.hidden = true;
      removeToolFromGroup(msg.id);
    }
    finalizeAssistantBlock();
    renderMcpDebateProposal(msg.id, msg.input);
    startUrgentBlink();
  } else if (msg.name === "AskUserQuestion" && msg.input && msg.input.questions) {
    var askTool = getTools()[msg.id];
    if (askTool) {
      if (askTool.el) askTool.el.style.display = "none";
      askTool.done = true;
      removeToolFromGroup(msg.id);
    }
    renderAskUserQuestion(msg.id, msg.input);
    startUrgentBlink();
  } else if (msg.name === "Write" && msg.input && isPlanFilePath(msg.input.file_path)) {
    setPlanContent(msg.input.content || "");
    updateToolExecuting(msg.id, msg.name, msg.input);
  } else if (msg.name === "Edit" && msg.input && isPlanFilePath(msg.input.file_path)) {
    var planContent = getPlanContent() || "";
    if (msg.input.old_string && planContent.indexOf(msg.input.old_string) !== -1) {
      if (msg.input.replace_all) {
        setPlanContent(planContent.split(msg.input.old_string).join(msg.input.new_string || ""));
      } else {
        setPlanContent(planContent.replace(msg.input.old_string, msg.input.new_string || ""));
      }
    }
    updateToolExecuting(msg.id, msg.name, msg.input);
  } else if (msg.name === "TodoWrite") {
    handleTodoWrite(msg.input);
  } else if (msg.name === "TaskCreate") {
    handleTaskCreate(msg.input);
  } else if (msg.name === "TaskUpdate") {
    handleTaskUpdate(msg.input);
  } else if (getTodoTools()[msg.name]) {
    return;
  } else {
    var tool = getTools()[msg.id];
    if (tool && tool.hidden) return;
    updateToolExecuting(msg.id, msg.name, msg.input);
  }
}

function handleToolResult(msg) {
  var toolResult = getTools()[msg.id];
  if (toolResult && toolResult.hidden) return;
  if (msg.content != null || msg.images || (toolResult && toolResult.name === "Edit" && toolResult.input && toolResult.input.old_string)) {
    updateToolResult(msg.id, msg.content || "", msg.is_error || false, msg.images);
  }
  if (!msg.is_error && toolResult && (toolResult.name === "Edit" || toolResult.name === "Write") && toolResult.input && toolResult.input.file_path) {
    refreshIfOpen(toolResult.input.file_path);
  }
}

function renderSlashCommandResult(msg) {
  finalizeAssistantBlock();
  var cmdBlock = document.createElement("div");
  cmdBlock.className = "assistant-block";
  cmdBlock.style.maxWidth = "var(--content-width)";
  cmdBlock.style.margin = "12px auto";
  cmdBlock.style.padding = "0 20px";
  var pre = document.createElement("pre");
  pre.style.cssText = "background:var(--code-bg);border:1px solid var(--border-subtle);border-radius:10px;padding:12px 14px;font-family:'SF Mono',Menlo,Monaco,monospace;font-size:12px;line-height:1.55;color:var(--text-secondary);white-space:pre-wrap;word-break:break-word;max-height:400px;overflow-y:auto;margin:0";
  pre.textContent = msg.text;
  cmdBlock.appendChild(pre);
  addToMessages(cmdBlock);
  scrollToBottom();
}
