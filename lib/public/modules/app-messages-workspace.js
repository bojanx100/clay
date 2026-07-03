import { handleWorkspaceState, handleWorkspaceDevStatus, handleWorkspaceContext } from './workspace-panel.js';
import { updateEmailAccountList, updateEmailUnreadCounts, handleContextSourcesState, handleEmailTestResult, handleEmailAddResult, handleEmailRemoveResult, handleEmailDefaults } from './context-sources.js';
import { refreshEmailSettings } from './user-settings.js';
import { sendExtensionCommand, handleMcpToolCallMessage } from './app-misc.js';
import { handleMcpServersState } from './mcp-ui.js';

export function handleWorkspaceMessage(msg) {
  switch (msg.type) {
    case "workspace_state":
      handleWorkspaceState(msg);
      return true;

    case "workspace_dev_status":
      handleWorkspaceDevStatus(msg);
      return true;

    case "workspace_context":
      handleWorkspaceContext(msg);
      return true;

    case "context_sources_state":
      handleContextSourcesState(msg);
      return true;

    case "email_accounts_list":
      updateEmailAccountList(msg);
      refreshEmailSettings();
      return true;

    case "email_unread_update":
      updateEmailUnreadCounts(msg);
      return true;

    case "email_account_test_result":
      handleEmailTestResult(msg);
      return true;

    case "email_account_add_result":
      handleEmailAddResult(msg);
      return true;

    case "email_account_remove_result":
      handleEmailRemoveResult(msg);
      return true;

    case "email_defaults":
      handleEmailDefaults(msg);
      return true;

    case "extension_command":
      sendExtensionCommand(msg.command, msg.args, msg.requestId);
      return true;

    case "mcp_tool_call":
      handleMcpToolCallMessage(msg);
      return true;

    case "mcp_servers_state":
      handleMcpServersState(msg);
      return true;

    default:
      return false;
  }
}
