import { handleFsList, handleFsRead, handleFileChanged, handleDirChanged, handleFileHistory, handleGitDiff, handleFileAt, handleFsSearch } from './filebrowser.js';
import { isProjectSettingsOpen, handleInstructionsRead, handleInstructionsWrite, handleProjectEnv, handleProjectEnvSaved, handleProjectSharedEnv, handleProjectSharedEnvSaved, handleDashboardConfig, handleDashboardCommandResult, handleDashboardCommandUpdateResult } from './project-settings.js';
import { handleCookbookRead, handleCookbookWrite, isCookbookPath } from './project-task-wizard.js';
import { handleSharedEnv, handleSharedEnvSaved, handleGlobalClaudeMdRead, handleGlobalClaudeMdWrite } from './server-settings.js';

export function handleFileMessage(msg) {
  switch (msg.type) {
    case "fs_list_result":
      handleFsList(msg);
      return true;

    case "fs_search_result":
      handleFsSearch(msg);
      return true;

    case "fs_read_result":
      if (msg.path === "CLAUDE.md" && isProjectSettingsOpen()) {
        handleInstructionsRead(msg);
      } else if (isCookbookPath(msg.path) && isProjectSettingsOpen()) {
        handleCookbookRead(msg);
      } else {
        handleFsRead(msg);
      }
      return true;

    case "fs_write_result":
      if (isCookbookPath(msg.path) && isProjectSettingsOpen()) {
        handleCookbookWrite(msg);
      } else {
        handleInstructionsWrite(msg);
      }
      return true;

    case "project_env_result":
      handleProjectEnv(msg);
      return true;

    case "set_project_env_result":
      handleProjectEnvSaved(msg);
      return true;

    case "dashboard_config":
      handleDashboardConfig(msg);
      return true;

    case "dashboard_command_result":
      handleDashboardCommandResult(msg);
      return true;

    case "dashboard_command_update_result":
      handleDashboardCommandUpdateResult(msg);
      return true;

    case "global_claude_md_result":
      handleGlobalClaudeMdRead(msg);
      return true;

    case "write_global_claude_md_result":
      handleGlobalClaudeMdWrite(msg);
      return true;

    case "shared_env_result":
      handleSharedEnv(msg);
      handleProjectSharedEnv(msg);
      return true;

    case "set_shared_env_result":
      handleSharedEnvSaved(msg);
      handleProjectSharedEnvSaved(msg);
      return true;

    case "fs_file_changed":
      handleFileChanged(msg);
      return true;

    case "fs_dir_changed":
      handleDirChanged(msg);
      return true;

    case "fs_file_history_result":
      handleFileHistory(msg);
      return true;

    case "fs_git_diff_result":
      handleGitDiff(msg);
      return true;

    case "fs_file_at_result":
      handleFileAt(msg);
      return true;

    default:
      return false;
  }
}
