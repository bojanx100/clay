import { escapeHtml } from './utils.js';
import { store } from './store.js';
import { VENDOR_NAMES } from './vendor-ui.js';

var ctx;
var deps = {};

function maybeScrollToBottom() {
  if (store.get('replayingHistory')) return;
  if (ctx && ctx.scrollToBottom) ctx.scrollToBottom();
}

export function initAskUserTools(_ctx, _deps) {
  ctx = _ctx;
  deps = _deps || {};
}

export function renderAskUserQuestion(toolId, input) {
  ctx.finalizeAssistantBlock();
  if (deps.stopThinking) deps.stopThinking();
  if (deps.closeToolGroup) deps.closeToolGroup();

  var questions = input.questions || [];
  if (questions.length === 0) return;

  var container = document.createElement("div");
  container.className = "ask-user-container";
  container.dataset.toolId = toolId;

  // Mate DM: wrap in avatar + content layout (same as msg-assistant)
  var mateContentWrap = null;
  if (ctx.isMateDm && ctx.isMateDm()) {
    container.classList.add("mate-ask-user");
    var mateName = ctx.getMateName();
    var mateAvatar = ctx.getMateAvatarUrl();

    var avi = document.createElement("img");
    avi.className = "dm-bubble-avatar";
    avi.src = mateAvatar;
    container.appendChild(avi);

    mateContentWrap = document.createElement("div");
    mateContentWrap.className = "dm-bubble-content";

    var headerEl = document.createElement("div");
    headerEl.className = "dm-bubble-header";
    headerEl.innerHTML =
      '<span class="dm-bubble-name">' + escapeHtml(mateName) + '</span>' +
      '<span class="dm-bubble-time">' + String(new Date().getHours()).padStart(2, "0") + ":" + String(new Date().getMinutes()).padStart(2, "0") + '</span>';
    mateContentWrap.appendChild(headerEl);
  }

  var answers = {};
  var multiSelections = {};

  questions.forEach(function (q, qIdx) {
    var qDiv = document.createElement("div");
    qDiv.className = "ask-user-question";

    if (q.header) {
      var qHeader = document.createElement("div");
      qHeader.className = "ask-user-question-header";
      qHeader.textContent = q.header;
      qDiv.appendChild(qHeader);
    }

    var qText = document.createElement("div");
    qText.className = "ask-user-question-text";
    qText.textContent = q.question || "";
    qDiv.appendChild(qText);

    var optionsDiv = document.createElement("div");
    optionsDiv.className = "ask-user-options";

    var isMulti = q.multiSelect || false;
    if (isMulti) multiSelections[qIdx] = new Set();

    (q.options || []).forEach(function (opt) {
      var btn = document.createElement("button");
      btn.className = "ask-user-option";
      btn.innerHTML =
        '<div class="option-label"></div>' +
        (opt.description ? '<div class="option-desc"></div>' : '');
      btn.querySelector(".option-label").textContent = opt.label;
      if (opt.description) btn.querySelector(".option-desc").textContent = opt.description;
      if (opt.markdown) {
        var pre = document.createElement("pre");
        pre.className = "option-markdown";
        pre.textContent = opt.markdown;
        btn.appendChild(pre);
      }

      btn.addEventListener("click", function () {
        if (container.classList.contains("answered")) return;

        if (isMulti) {
          var set = multiSelections[qIdx];
          if (set.has(opt.label)) {
            set.delete(opt.label);
            btn.classList.remove("selected");
          } else {
            set.add(opt.label);
            btn.classList.add("selected");
          }
        } else {
          optionsDiv.querySelectorAll(".ask-user-option").forEach(function (b) {
            b.classList.remove("selected");
          });
          btn.classList.add("selected");
          answers[qIdx] = opt.label;
          var otherInput = qDiv.querySelector(".ask-user-other input");
          if (otherInput) otherInput.value = "";
        }
      });

      optionsDiv.appendChild(btn);
    });

    qDiv.appendChild(optionsDiv);

    // "Other" text input
    var otherDiv = document.createElement("div");
    otherDiv.className = "ask-user-other";
    var otherInput = document.createElement("input");
    otherInput.type = "text";
    otherInput.placeholder = "Other...";
    otherInput.addEventListener("input", function () {
      if (container.classList.contains("answered")) return;
      if (otherInput.value.trim()) {
        optionsDiv.querySelectorAll(".ask-user-option").forEach(function (b) {
          b.classList.remove("selected");
        });
        if (isMulti) multiSelections[qIdx] = new Set();
        answers[qIdx] = otherInput.value.trim();
      }
    });
    otherInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitAskUserAnswer(container, toolId, questions, answers, multiSelections);
      }
    });
    otherDiv.appendChild(otherInput);
    qDiv.appendChild(otherDiv);
    container.appendChild(qDiv);
  });

  // Submit button: always show
  var submitBtn = document.createElement("button");
  submitBtn.className = "ask-user-submit";
  submitBtn.textContent = "Submit";
  submitBtn.addEventListener("click", function () {
    submitAskUserAnswer(container, toolId, questions, answers, multiSelections);
  });
  container.appendChild(submitBtn);

  // Skip button
  var skipBtn = document.createElement("button");
  skipBtn.className = "ask-user-skip";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", function () {
    if (container.classList.contains("answered")) return;
    container.classList.add("answered");
    enableMainInput();
    if (ctx.ws && ctx.connected) {
      ctx.ws.send(JSON.stringify({ type: "stop" }));
    }
  });
  container.appendChild(skipBtn);

  // Mate DM: move all content into the bubble content wrapper
  if (mateContentWrap) {
    var children = [];
    for (var ci = 0; ci < container.childNodes.length; ci++) {
      if (container.childNodes[ci] !== container.querySelector(".dm-bubble-avatar")) {
        children.push(container.childNodes[ci]);
      }
    }
    for (var cj = 0; cj < children.length; cj++) {
      mateContentWrap.appendChild(children[cj]);
    }
    container.appendChild(mateContentWrap);
  }

  ctx.addToMessages(container);
  disableMainInput();
  ctx.setActivity(null);
  maybeScrollToBottom();
}

export function disableMainInput() {
  ctx.inputEl.disabled = true;
  ctx.inputEl.placeholder = "Answer the question above to continue...";
}

export function enableMainInput() {
  ctx.inputEl.disabled = false;
  if (document.body.classList.contains("mate-dm-active") && document.body.dataset.mateName) {
    ctx.inputEl.placeholder = "Message " + document.body.dataset.mateName + "...";
  } else {
    var _v = store.get('currentVendor') || "claude";
    ctx.inputEl.placeholder = "Message " + (VENDOR_NAMES[_v] || VENDOR_NAMES.claude) + "...";
  }
}

function submitAskUserAnswer(container, toolId, questions, answers, multiSelections) {
  if (container.classList.contains("answered")) return;

  var result = {};
  for (var i = 0; i < questions.length; i++) {
    var q = questions[i];
    if (q.multiSelect && multiSelections[i] && multiSelections[i].size > 0) {
      result[i] = Array.from(multiSelections[i]).join(", ");
    } else if (answers[i]) {
      result[i] = answers[i];
    }
  }

  if (Object.keys(result).length === 0) return;

  container.classList.add("answered");
  enableMainInput();
  if (ctx.stopUrgentBlink) ctx.stopUrgentBlink();

  // Show user's answers inline
  showAnswerSummary(container, questions, result);

  if (ctx.ws && ctx.connected) {
    ctx.ws.send(JSON.stringify({
      type: "ask_user_response",
      toolId: toolId,
      questions: questions,
      answers: result,
    }));
  }
}

function showAnswerSummary(container, questions, answers) {
  if (!answers || Object.keys(answers).length === 0) return;
  var existing = container.querySelector(".ask-user-answer-summary");
  if (existing) return;
  var summary = document.createElement("div");
  summary.className = "ask-user-answer-summary";
  for (var key in answers) {
    if (!answers.hasOwnProperty(key)) continue;
    var row = document.createElement("div");
    row.className = "ask-user-answer-row";
    var qi = parseInt(key, 10);
    var label = (questions && questions[qi] && questions[qi].question) ? questions[qi].question : "Answer";
    row.innerHTML = '<span class="ask-user-answer-label">' + escapeHtml(label) + '</span>' +
      '<span class="ask-user-answer-value">' + escapeHtml(String(answers[key])) + '</span>';
    summary.appendChild(row);
  }
  // Insert before submit button
  var submitBtn = container.querySelector(".ask-user-submit");
  if (submitBtn) {
    submitBtn.parentNode.insertBefore(summary, submitBtn);
  } else {
    container.appendChild(summary);
  }
}

export function markAskUserAnswered(toolId, answers) {
  var container = document.querySelector('.ask-user-container[data-tool-id="' + toolId + '"]');
  if (container && !container.classList.contains("answered")) {
    container.classList.add("answered");
    enableMainInput();
    // Restore answers from history replay
    if (answers && Object.keys(answers).length > 0) {
      // Find matching questions from the tool_executing input
      var questions = null;
      var askQuestions = container.querySelectorAll(".ask-user-question");
      if (askQuestions.length > 0) {
        questions = [];
        for (var qi = 0; qi < askQuestions.length; qi++) {
          var qTextEl = askQuestions[qi].querySelector(".ask-user-question-text");
          questions.push({ question: qTextEl ? qTextEl.textContent : "" });
        }
      }
      showAnswerSummary(container, questions, answers);
      // Also mark selected options to match the answers
      for (var key in answers) {
        if (!answers.hasOwnProperty(key)) continue;
        var idx = parseInt(key, 10);
        if (askQuestions[idx]) {
          var answerVal = String(answers[key]);
          var options = askQuestions[idx].querySelectorAll(".ask-user-option");
          var matched = false;
          for (var oi = 0; oi < options.length; oi++) {
            var labelEl = options[oi].querySelector(".option-label");
            if (labelEl && labelEl.textContent === answerVal) {
              options[oi].classList.add("selected");
              matched = true;
            }
          }
          // If not matched to an option, fill the "Other" input
          if (!matched) {
            var otherInput = askQuestions[idx].querySelector(".ask-user-other input");
            if (otherInput) otherInput.value = answerVal;
          }
        }
      }
    }
  }
}
