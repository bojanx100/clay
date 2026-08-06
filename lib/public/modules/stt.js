// Speech-to-Text module using Web Speech API
// Uses browser's built-in speech recognition (Chrome/Edge/Safari → Google servers)

import { iconHtml, refreshIcons } from './icons.js';
import { store } from './store.js';
import { addSystemMessage, scrollToBottom, VENDOR_NAMES } from './app-rendering.js';
import { captureSTTCoopRouting, clearSTTCoopRouting, takeSTTCoopRouting } from './stt-coop-routing.js';

// Recognition errors that no restart can recover from. 'no-speech' is
// deliberately absent: silence is normal and recording continues.
var FATAL_STT_ERRORS = {
  'audio-capture': true,
  'service-not-allowed': true,
  'language-not-supported': true,
  'bad-grammar': true,
};

// --- State ---
var recording = false;
var recognition = null;
var selectedLang = null;
var textBeforeSTT = '';
var interimText = '';
var voiceIngressPending = false;

// DOM refs
var sttBtn = null;
var langPopover = null;

// --- Language options ---
// Web Speech API uses BCP-47 language tags
var LANGUAGES = [
  { code: 'en-US', name: 'English' },
  { code: 'ko-KR', name: 'Korean' },
  { code: 'ja-JP', name: 'Japanese' },
  { code: 'zh-CN', name: 'Chinese' },
  { code: 'es-ES', name: 'Spanish' },
  { code: 'fr-FR', name: 'French' },
  { code: 'de-DE', name: 'German' },
];

// --- Check browser support ---
function getSpeechRecognition() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

// --- Init ---
export function initSTT() {
  sttBtn = document.getElementById('stt-btn');
  if (!sttBtn) return;

  if (!getSpeechRecognition()) {
    sttBtn.style.display = 'none';
    console.warn('[STT] Web Speech API not supported in this browser');
    return;
  }

  sttBtn.addEventListener('click', function(e) {
    e.stopPropagation();

    if (recording) {
      stopRecording();
      return;
    }

    if (!selectedLang) {
      showLangPopover();
    } else {
      startRecording();
    }
  });

  // Right-click to change language
  sttBtn.addEventListener('contextmenu', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (recording) stopRecording();
    showLangPopover();
  });
}

// --- Language popover ---
function showLangPopover() {
  if (langPopover) {
    hideLangPopover();
    return;
  }

  langPopover = document.createElement('div');
  langPopover.className = 'stt-lang-popover';

  var html = '<div class="stt-lang-title">Voice Input Language</div>';
  for (var i = 0; i < LANGUAGES.length; i++) {
    var l = LANGUAGES[i];
    var activeClass = (selectedLang === l.code) ? ' stt-lang-active' : '';
    html += '<button class="stt-lang-option' + activeClass + '" data-lang="' + l.code + '">' +
      '<span class="stt-lang-name">' + l.name + '</span>' +
      '</button>';
  }
  langPopover.innerHTML = html;

  langPopover.querySelectorAll('.stt-lang-option').forEach(function(btn) {
    btn.addEventListener('click', function() {
      onLangSelected(btn.dataset.lang);
    });
  });

  var wrapper = document.getElementById('input-wrapper');
  wrapper.appendChild(langPopover);

  setTimeout(function() {
    document.addEventListener('click', closeLangOnOutside);
  }, 0);
}

function closeLangOnOutside(e) {
  if (langPopover && !langPopover.contains(e.target) && e.target !== sttBtn && !sttBtn.contains(e.target)) {
    hideLangPopover();
  }
}

function hideLangPopover() {
  if (langPopover) {
    langPopover.remove();
    langPopover = null;
  }
  document.removeEventListener('click', closeLangOnOutside);
}

function onLangSelected(code) {
  selectedLang = code;
  hideLangPopover();
  startRecording();
}

// --- Recording ---
function startRecording() {
  if (recording) return;

  var SpeechRecognition = getSpeechRecognition();
  if (!SpeechRecognition) return;

  recognition = new SpeechRecognition();
  recognition.lang = selectedLang || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;

  var inputEl = document.getElementById('input');
  if (!inputEl) return;
  textBeforeSTT = inputEl.value;
  interimText = '';

  recognition.onresult = function(e) {
    var final = '';
    var interim = '';

    for (var i = 0; i < e.results.length; i++) {
      var result = e.results[i];
      if (result.isFinal) {
        final += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }

    var text = textBeforeSTT;
    if (final) {
      if (text && text.length > 0 && text[text.length - 1] !== ' ' && text[text.length - 1] !== '\n') {
        text += ' ';
      }
      text += final;
      voiceIngressPending = true;
    }
    if (interim) {
      if (text && text.length > 0 && text[text.length - 1] !== ' ' && text[text.length - 1] !== '\n') {
        text += ' ';
      }
      text += interim;
    }

    inputEl.value = text;
    resizeComposer(inputEl);
    scrollToBottom();
  };

  recognition.onerror = function(e) {
    console.error('[STT] Recognition error:', e.error);
    if (e.error === 'not-allowed') {
      addSystemMessage('Microphone access denied.\n\nTo fix: click the lock icon in the address bar → Site settings → Microphone → Allow, then reload.', true);
      stopRecording();
    } else if (e.error === 'no-speech') {
      // Silence — just keep listening
    } else if (e.error === 'network') {
      addSystemMessage('Speech recognition unavailable.\n\nWeb Speech API sends audio to Google servers for recognition. Some Chromium forks (Arc, Brave) block this connection.\n\nSupported: Chrome, Edge, Safari 14.1+, Samsung Internet\nNot supported: Arc, Brave, Firefox', true);
      stopRecording();
    } else if (FATAL_STT_ERRORS[e.error]) {
      // These cannot recover by restarting. Falling through instead left
      // `recording` true, so onend restarted in a loop while the composer kept
      // claiming "Listening" with no usable input.
      addSystemMessage('Voice input stopped: ' + e.error + '.', true);
      stopRecording();
    }
  };

  recognition.onend = function() {
    // Auto-restart if still recording (browser may stop after silence)
    if (recording) {
      // Save confirmed text so far
      var currentInput = document.getElementById('input');
      textBeforeSTT = currentInput ? currentInput.value : textBeforeSTT;
      try {
        recognition.start();
      } catch (e) {
        // Already started or other error
        stopRecording();
      }
    }
  };

  try {
    captureSTTCoopRouting();
    recognition.start();
    recording = true;
    // Voice input state only. Coop renders "Listening" from this flag and keeps
    // it separate from its persistent work activity, so the two can coexist.
    store.set({ voiceListening: true });
    sttBtn.classList.add('stt-active');
    sttBtn.innerHTML =
      '<span class="stt-wave">' +
        '<span class="stt-wave-bar"></span>' +
        '<span class="stt-wave-bar"></span>' +
        '<span class="stt-wave-bar"></span>' +
        '<span class="stt-wave-bar"></span>' +
        '<span class="stt-wave-bar"></span>' +
      '</span>' +
      '<span class="stt-stop-label">Stop</span>';
    inputEl.setAttribute('placeholder', 'Listening...');
  } catch (err) {
    clearSTTCoopRouting();
    store.set({ voiceListening: false });
    console.error('[STT] Failed to start:', err);
    addSystemMessage('Failed to start voice input: ' + err.message, true);
  }
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  store.set({ voiceListening: false });

  if (recognition) {
    try { recognition.stop(); } catch (e) { /* ignore */ }
    recognition = null;
  }

  sttBtn.classList.remove('stt-active');
  sttBtn.innerHTML = iconHtml('mic');
  refreshIcons();
  var inputEl = document.getElementById('input');
  if (!inputEl) return;
  if (document.body.classList.contains("mate-dm-active") && document.body.dataset.mateName) {
    inputEl.setAttribute('placeholder', 'Message ' + document.body.dataset.mateName + '...');
  } else {
    var _v = store.get('currentVendor') || "claude";
    inputEl.setAttribute('placeholder', 'Message ' + (VENDOR_NAMES[_v] || VENDOR_NAMES.claude) + '...');
  }
}

function resizeComposer(inputEl) {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}

export function takeVoiceIngress() {
  if (!voiceIngressPending) return null;
  voiceIngressPending = false;
  return "voice";
}

// Voice input is ultimately routed by input.js, but expose the same exact
// server-backed refs so callers and tests can fail closed if a topic vanished
// or access was revoked while the microphone was open.
export function getSTTCoopRouting() {
  return takeSTTCoopRouting();
}

// --- External lang setter (used by profile module) ---
export function setSTTLang(code) {
  selectedLang = code;
}

export function getSTTLang() {
  return selectedLang;
}

// --- Exports ---
export function isSTTRecording() {
  return recording;
}

export function isSTTInitializing() {
  return false;
}
