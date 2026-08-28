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

export function renderGeneratedImage(msg) {
  var image = msg.images && msg.images[0];
  if (!image || !image.url) return;

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

  addToMessages(card);
  refreshIcons(card);
  scrollToBottom();
}
