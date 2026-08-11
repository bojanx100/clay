// message-reply.js - Shared quoted-reply composition for transcript messages

import { getInputEl } from './dom-refs.js';

var MAX_REPLY_LENGTH = 600;

export function userMessageReplyText(text, images, pastes) {
  var parts = [];
  var imageCount = Array.isArray(images) ? images.length : 0;
  var pasteCount = Array.isArray(pastes) ? pastes.length : 0;
  if (imageCount) parts.push("[" + imageCount + (imageCount === 1 ? " image" : " images") + "]");
  if (pasteCount) parts.push("[" + pasteCount + (pasteCount === 1 ? " pasted item" : " pasted items") + "]");
  if (String(text || "").trim()) parts.push(String(text).trim());
  return parts.join("\n");
}

export function buildReplyQuote(text) {
  var replyText = String(text || "").trim();
  if (!replyText) return "";
  if (replyText.length > MAX_REPLY_LENGTH) {
    replyText = replyText.slice(0, MAX_REPLY_LENGTH).trimEnd() + "\u2026";
  }
  return replyText.split(/\r?\n/).map(function (line) {
    return "> " + line;
  }).join("\n");
}

export function writeReplyDraft(inputEl, text) {
  var quote = buildReplyQuote(text);
  if (!inputEl || !quote) return false;
  var existingDraft = inputEl.value;
  inputEl.value = quote + (existingDraft ? "\n\n" + existingDraft : "\n\n");
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  inputEl.focus();
  inputEl.selectionStart = inputEl.selectionEnd = inputEl.value.length;
  return true;
}

export function replyToMessage(messageEl, rawText) {
  var inputEl = getInputEl();
  if (!inputEl) return false;
  var selectedText = "";
  var selection = window.getSelection();
  if (selection && selection.toString() && messageEl.contains(selection.anchorNode) && messageEl.contains(selection.focusNode)) {
    selectedText = selection.toString().trim();
  }
  return writeReplyDraft(inputEl, selectedText || rawText);
}
