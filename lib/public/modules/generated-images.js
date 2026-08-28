// Inline presentation for images produced by Codex ImageGen.

import { refreshIcons, iconHtml } from './icons.js';
import { showImageModal } from './app-misc.js';
import { addToMessages, scrollToBottom } from './app-rendering.js';

function fileNameFromImage(image) {
  if (image.fileName) return image.fileName;
  try {
    var url = new URL(image.url, window.location.href);
    return decodeURIComponent(url.pathname.split('/').pop()) || 'generated-image.png';
  } catch (e) {
    return 'generated-image.png';
  }
}

function actionButton(icon, label) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'generated-image-action';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = iconHtml(icon) + '<span>' + label + '</span>';
  return button;
}

function findProgressRow(toolId) {
  var rows = document.querySelectorAll('.generated-image-row[data-image-tool-id]');
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].dataset.imageToolId === String(toolId || '')) return rows[i];
  }
  return null;
}

export function renderImageGenerationProgress(msg) {
  if (!msg.id || findProgressRow(msg.id)) return;

  var row = document.createElement('div');
  row.className = 'generated-image-row generated-image-row--pending';
  row.dataset.imageToolId = msg.id;

  var status = document.createElement('div');
  status.className = 'generated-image-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.innerHTML = iconHtml('sparkles') + '<span>Creating image</span><span class="generated-image-status-dots" aria-hidden="true"></span>';
  row.appendChild(status);

  var card = document.createElement('div');
  card.className = 'generated-image-card generated-image-card--pending';
  card.setAttribute('aria-hidden', 'true');
  var field = document.createElement('div');
  field.className = 'generated-image-particle-field';
  card.appendChild(field);
  row.appendChild(card);

  addToMessages(row);
  refreshIcons(row);
  scrollToBottom();
}

export function clearImageGenerationProgress(toolId) {
  var row = findProgressRow(toolId);
  if (row && row.classList.contains('generated-image-row--pending')) row.remove();
}

export function clearAllImageGenerationProgress() {
  var rows = document.querySelectorAll('.generated-image-row--pending');
  for (var i = 0; i < rows.length; i++) rows[i].remove();
}

export function renderGeneratedImage(msg) {
  var image = msg.images && msg.images[0];
  if (!image || !image.url) return;

  var row = document.createElement('div');
  row.className = 'generated-image-row';
  row.dataset.imageToolId = msg.id || '';
  var card = document.createElement('figure');
  card.className = 'generated-image-card';
  card.dataset.toolId = msg.id || '';

  var imageWrap = document.createElement('div');
  imageWrap.className = 'generated-image-preview';
  var img = document.createElement('img');
  img.src = image.url;
  img.alt = msg.prompt ? 'Generated image: ' + msg.prompt : 'Generated image';
  img.loading = 'lazy';
  img.addEventListener('click', function () { showImageModal(image.url); });
  imageWrap.appendChild(img);
  card.appendChild(imageWrap);

  var footer = document.createElement('figcaption');
  footer.className = 'generated-image-footer';
  var meta = document.createElement('div');
  meta.className = 'generated-image-meta';
  var label = document.createElement('span');
  label.className = 'generated-image-label';
  label.innerHTML = iconHtml('sparkles') + '<span>Generated image</span>';
  meta.appendChild(label);
  if (msg.prompt) {
    var prompt = document.createElement('span');
    prompt.className = 'generated-image-prompt';
    prompt.textContent = msg.prompt;
    prompt.title = msg.prompt;
    meta.appendChild(prompt);
  }
  footer.appendChild(meta);

  var actions = document.createElement('div');
  actions.className = 'generated-image-actions';
  var openButton = actionButton('maximize-2', 'Open');
  openButton.addEventListener('click', function () { showImageModal(image.url); });
  actions.appendChild(openButton);
  var downloadLink = document.createElement('a');
  downloadLink.className = 'generated-image-action';
  downloadLink.href = image.url;
  downloadLink.download = fileNameFromImage(image);
  downloadLink.title = 'Download';
  downloadLink.setAttribute('aria-label', 'Download');
  downloadLink.innerHTML = iconHtml('download') + '<span>Download</span>';
  actions.appendChild(downloadLink);
  footer.appendChild(actions);
  card.appendChild(footer);
  row.appendChild(card);

  var progressRow = findProgressRow(msg.id);
  if (progressRow) progressRow.replaceWith(row);
  else addToMessages(row);
  refreshIcons(row);
  scrollToBottom();
}
