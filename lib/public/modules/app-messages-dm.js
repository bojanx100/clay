import { store } from './store.js';
import { getWs } from './ws-ref.js';
import { scrollToBottom } from './app-rendering.js';
import { refreshMobileChatSheet } from './sidebar-mobile.js';
import { updateDmBadge } from './sidebar-mates.js';
import { renderMateSessionList, handleMateSearchResults, updateMateSidebarProfile } from './mate-sidebar.js';
import { handleMateDatastoreTablesResult, handleMateDatastoreDescribeResult, handleMateDatastoreQueryResult, handleMateDatastoreError, handleMateDatastoreChange } from './mate-datastore-ui.js';
import { renderKnowledgeList, handleKnowledgeContent } from './mate-knowledge.js';
import { renderMemoryList } from './mate-memory.js';
import { mateAvatarUrl } from './avatar.js';
import { openDm, enterDmMode, exitDmMode, handleMateCreatedInApp, updateMateIconStatus, appendDmMessage, showDmTypingIndicator, buildMateInterviewPrompt } from './app-dm.js';
import { showToast } from './utils.js';

var messagesEl = document.getElementById("messages");
var headerTitleEl = document.getElementById("header-title");

function applyMateTitleBar(targetUser) {
  var mateName = targetUser.displayName || "New Mate";
  if (headerTitleEl) headerTitleEl.textContent = mateName;
  var titleBarProjectName = document.getElementById("title-bar-project-name");
  if (titleBarProjectName) titleBarProjectName.textContent = mateName;
  var mateColor = (targetUser.profile && targetUser.profile.avatarColor) || targetUser.avatarColor || "#7c3aed";
  var titleBarContent = document.querySelector(".title-bar-content");
  if (titleBarContent) {
    titleBarContent.style.background = mateColor;
    titleBarContent.classList.add("mate-dm-active");
  }
  document.body.classList.add("mate-dm-active");
}

function handleMateReadyMarker() {
  setTimeout(function () { scrollToBottom(); }, 100);
  setTimeout(function () { scrollToBottom(); }, 400);
  setTimeout(function () {
    var fullText = messagesEl ? messagesEl.textContent : "";
    var readyMatch = fullText.match(/\[\[MATE_READY:\s*(.+?)\]\]/);
    if (readyMatch) {
      var newName = readyMatch[1].trim();
      store.get('dmTargetUser').displayName = newName;
      updateMateSidebarProfile({ profile: { displayName: newName, avatarColor: store.get('dmTargetUser').avatarColor, avatarStyle: store.get('dmTargetUser').avatarStyle, avatarSeed: store.get('dmTargetUser').avatarSeed } });
      if (getWs() && getWs().readyState === 1) {
        getWs().send(JSON.stringify({
          type: "mate_update",
          mateId: store.get('dmTargetUser').id,
          updates: { name: newName, status: "ready", profile: { displayName: newName } },
        }));
      }
    }
    var walker = document.createTreeWalker(messagesEl, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while (node = walker.nextNode()) {
      if (node.nodeValue.indexOf("[[MATE_READY:") !== -1) {
        node.nodeValue = node.nodeValue.replace(/\[\[MATE_READY:\s*.+?\]\]/g, "").trim();
      }
    }
  }, 100);
}

function handleDmHistory(msg) {
  if (msg.projectSlug && msg.targetUser) {
    msg.targetUser.projectSlug = msg.projectSlug;
  }
  enterDmMode(msg.dmKey, msg.targetUser, msg.messages);
  if (store.get('pendingMateInterview') && msg.targetUser && msg.targetUser.isMate && msg.projectSlug) {
    var interviewMate = store.get('pendingMateInterview');
    store.set({ pendingMateInterview: null });
    var checkMateReady = setInterval(function () {
      if (getWs() && getWs().readyState === 1 && store.get('mateProjectSlug')) {
        clearInterval(checkMateReady);
        var interviewText = buildMateInterviewPrompt(interviewMate);
        getWs().send(JSON.stringify({ type: "message", text: interviewText }));
      }
    }, 100);
    setTimeout(function () { clearInterval(checkMateReady); }, 5000);
  }
}

function handleDmMessageReceived(msg) {
  if (store.get('dmMode') && msg.dmKey === store.get('dmKey')) {
    showDmTypingIndicator(false);
    appendDmMessage(msg.message);
    scrollToBottom();
    return;
  }
  if (msg.message) {
    var fromId = msg.message.from;
    if (fromId && fromId !== store.get('myUserId')) {
      var dmUnread = Object.assign({}, store.get('dmUnread'));
      dmUnread[fromId] = (dmUnread[fromId] || 0) + 1;
      store.set({ dmUnread: dmUnread });
      updateDmBadge(fromId, dmUnread[fromId]);
    }
  }
}

function handleDmFavoritesUpdated(msg) {
  var cachedFavorites = store.get('cachedDmFavorites');
  if (cachedFavorites && msg.dmFavorites) {
    for (var ri = 0; ri < cachedFavorites.length; ri++) {
      if (msg.dmFavorites.indexOf(cachedFavorites[ri]) === -1) {
        store.get('dmRemovedUsers')[cachedFavorites[ri]] = true;
      }
    }
  }
  if (msg.dmFavorites) {
    for (var ai = 0; ai < msg.dmFavorites.length; ai++) {
      delete store.get('dmRemovedUsers')[msg.dmFavorites[ai]];
    }
  }
  store.set({ cachedDmFavorites: msg.dmFavorites || [] });
}

function handleMateDeleted(msg) {
  store.set({ cachedMatesList: store.get('cachedMatesList').filter(function (mate) { return mate.id !== msg.mateId; }) });
  if (msg.availableBuiltins) store.set({ cachedAvailableBuiltins: msg.availableBuiltins });
  if (store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').id === msg.mateId) {
    exitDmMode();
  }
}

function handleMateUpdated(msg) {
  if (!msg.mate) return;
  var cachedMatesList = store.get('cachedMatesList').slice();
  for (var mi = 0; mi < cachedMatesList.length; mi++) {
    if (cachedMatesList[mi].id === msg.mate.id) {
      cachedMatesList[mi] = msg.mate;
      break;
    }
  }
  store.set({ cachedMatesList: cachedMatesList });
  if (store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').isMate && store.get('dmTargetUser').id === msg.mate.id) {
    updateMateSidebarProfile(msg.mate);
    var mateProfile = msg.mate.profile || {};
    store.get('dmTargetUser').displayName = mateProfile.displayName || msg.mate.name || store.get('dmTargetUser').displayName;
    store.get('dmTargetUser').avatarStyle = mateProfile.avatarStyle || store.get('dmTargetUser').avatarStyle;
    store.get('dmTargetUser').avatarSeed = mateProfile.avatarSeed || store.get('dmTargetUser').avatarSeed;
    store.get('dmTargetUser').avatarColor = mateProfile.avatarColor || store.get('dmTargetUser').avatarColor;
    store.get('dmTargetUser').avatarCustom = mateProfile.avatarCustom || "";
    store.get('dmTargetUser').profile = mateProfile;
    document.body.dataset.mateAvatarUrl = mateAvatarUrl(store.get('dmTargetUser'), 36);
    document.body.dataset.mateName = mateProfile.displayName || msg.mate.name || "";
    var mateAvatars = document.querySelectorAll(".dm-bubble-avatar-mate");
    for (var mbi = 0; mbi < mateAvatars.length; mbi++) {
      mateAvatars[mbi].src = document.body.dataset.mateAvatarUrl;
    }
  }
  if (store.get('dmMode') && store.get('dmTargetUser') && store.get('dmTargetUser').id === msg.mate.id) {
    var updatedName = (msg.mate.profile && msg.mate.profile.displayName) || msg.mate.name;
    if (updatedName) {
      var dmHeaderName = document.getElementById("dm-header-name");
      if (dmHeaderName) dmHeaderName.textContent = updatedName;
      var dmInput = document.getElementById("dm-input");
      if (dmInput) dmInput.placeholder = "Message " + updatedName;
    }
  }
}

export function handleMateDmPreMessage(msg) {
  var targetUser = store.get('dmTargetUser');
  var isMateDm = store.get('dmMode') && targetUser && targetUser.isMate;
  if (!isMateDm) return false;
  updateMateIconStatus(msg);
  if (msg.type === "session_list") {
    renderMateSessionList(msg.sessions || []);
    refreshMobileChatSheet();
    applyMateTitleBar(targetUser);
    return false;
  }
  if (msg.type === "search_results") {
    handleMateSearchResults(msg);
    return true;
  }
  if (msg.type === "knowledge_list") {
    renderKnowledgeList(msg.files);
    return true;
  }
  if (msg.type === "knowledge_content") {
    handleKnowledgeContent(msg);
    return true;
  }
  if (msg.type === "knowledge_saved" || msg.type === "knowledge_deleted" || msg.type === "knowledge_promoted" || msg.type === "knowledge_depromoted") {
    return true;
  }
  if (msg.type === "memory_list") {
    renderMemoryList(msg.entries, msg.summary);
    return true;
  }
  if (msg.type === "memory_deleted") {
    return true;
  }
  if (msg.type === "done") {
    handleMateReadyMarker();
  }
  return false;
}

export function handleDmMessage(msg) {
  switch (msg.type) {
    case "restore_mate_dm":
      if (msg.mateId && !store.get('returningFromMateDm')) {
        if (store.get('dmMode')) {
          store.set({ dmMode: false });
        }
        messagesEl.innerHTML = "";
        openDm(msg.mateId);
      }
      if (store.get('returningFromMateDm')) {
        store.set({ returningFromMateDm: false });
        if (getWs() && getWs().readyState === 1) {
          try { getWs().send(JSON.stringify({ type: "set_mate_dm", mateId: null })); } catch(e) {}
        }
      }
      return true;
    case "mate_db_tables_result":
      handleMateDatastoreTablesResult(msg);
      return true;
    case "mate_db_describe_result":
      handleMateDatastoreDescribeResult(msg);
      return true;
    case "mate_db_query_result":
      handleMateDatastoreQueryResult(msg);
      return true;
    case "mate_db_error":
      handleMateDatastoreError(msg);
      return true;
    case "mate_db_change":
      handleMateDatastoreChange(msg);
      return true;
    case "dm_history":
      handleDmHistory(msg);
      return true;
    case "dm_message":
      handleDmMessageReceived(msg);
      return true;
    case "dm_typing":
      if (store.get('dmMode') && msg.dmKey === store.get('dmKey')) {
        showDmTypingIndicator(msg.typing);
      }
      return true;
    case "dm_list":
      return true;
    case "dm_favorites_updated":
      handleDmFavoritesUpdated(msg);
      return true;
    case "mate_created":
      handleMateCreatedInApp(msg.mate, msg);
      return true;
    case "mate_deleted":
      handleMateDeleted(msg);
      return true;
    case "mate_updated":
      handleMateUpdated(msg);
      return true;
    case "mate_list":
      store.set({ cachedMatesList: msg.mates || [], cachedAvailableBuiltins: msg.availableBuiltins || [] });
      return true;
    case "mate_available_builtins":
      return true;
    case "mate_error":
      showToast(msg.error || "Mate operation failed", "error");
      return true;
    default:
      return false;
  }
}
