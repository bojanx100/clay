// settings-defaults.js — Shared rendering for model/mode/effort/thinking controls
// Used by both server-settings.js and project-settings.js

export var MODE_OPTIONS = [
  { value: "default", label: "Default", desc: "Claude asks for permission before running tools and editing files." },
  { value: "plan", label: "Plan", desc: "Claude creates a plan first and asks for approval before making changes." },
  { value: "acceptEdits", label: "Auto-accept edits", desc: "File edits are applied automatically. Claude still asks before running commands." },
  { value: "bypassPermissions", label: "Full auto", desc: "Claude can edit files and run commands without asking first." },
];

export var EFFORT_LEVELS = [
  { value: "low", desc: "Quick, concise responses. Best for simple questions." },
  { value: "medium", desc: "Balanced responses with moderate reasoning. Good for most tasks." },
  { value: "high", desc: "Thorough responses with deeper analysis. Good for complex tasks." },
  { value: "xhigh", label: "X-High", desc: "Extra-deep reasoning. For very complex tasks." },
  { value: "max", desc: "Maximum reasoning depth. Best for the most difficult problems." },
  { value: "ultracode", label: "Ultra", desc: "Ultracode: xhigh reasoning plus standing multi-agent workflow orchestration. Requires an xhigh-capable model." },
];

var EFFORT_DETAILS = {
  minimal: { value: "minimal", label: "Minimal", desc: "Fastest reasoning. Best for very small changes and direct answers." },
  low: EFFORT_LEVELS[0],
  medium: EFFORT_LEVELS[1],
  high: EFFORT_LEVELS[2],
  xhigh: EFFORT_LEVELS[3],
  max: EFFORT_LEVELS[4],
  ultracode: EFFORT_LEVELS[5],
  ultra: { value: "ultra", label: "Ultra", desc: "Model-advertised parallel deep-work mode when available." },
  sol: { value: "sol", label: "Sol", desc: "Model-advertised deep reasoning mode when available." },
};

export var THINKING_OPTIONS = [
  { value: "disabled", label: "Off", desc: "Disable extended thinking." },
  { value: "adaptive", label: "Adaptive", desc: "Claude decides when to use extended thinking." },
  { value: "budget", label: "Budget", desc: "Set a token budget for extended thinking." },
];

export var CODEX_APPROVAL_OPTIONS = [
  { value: "never", label: "Auto", desc: "Run approved operations without asking." },
  { value: "on-failure", label: "On fail", desc: "Ask only when an operation fails and needs escalation." },
  { value: "on-request", label: "Ask", desc: "Ask before operations that need approval." },
];

export var CODEX_SANDBOX_OPTIONS = [
  { value: "read-only", label: "Read only", desc: "Do not allow file writes." },
  { value: "workspace-write", label: "Workspace", desc: "Allow writes inside the project workspace." },
  { value: "danger-full-access", label: "Full access", desc: "Allow unrestricted filesystem access." },
];

export var CODEX_WEBSEARCH_OPTIONS = [
  { value: "disabled", label: "Off", desc: "Do not use web search." },
  { value: "cached", label: "Cached", desc: "Use cached web results when available." },
  { value: "live", label: "Live", desc: "Allow live web search." },
];

export var MODEL_DESCRIPTIONS = {
  "default": "Automatically selects the best model for the task.",
  "fable": "Use for the hardest ambiguous product, design, and engineering decisions.",
  "opus": "Use for complex reasoning, architecture, debugging, and careful review.",
  "sonnet": "Use for everyday coding with a strong balance of speed and quality.",
  "haiku": "Use for quick answers, small edits, and low-risk mechanical work.",
  "gpt-6-astra": "Use for the hardest end-to-end coding, research, computer-use, and professional work.",
  "gpt-5.6-sol": "Use for complex, open-ended, high-value coding and research work.",
  "gpt-5.6-terra": "Use as the everyday GPT-5.6 workhorse when Sol's depth is not needed.",
  "gpt-5.6-luna": "Use for clear, repeatable tasks where speed and cost matter.",
  "gpt-5.5": "Use for complex coding, research, and real-world implementation work.",
  "gpt-5.4-mini": "Use for simpler coding tasks when speed and cost matter most.",
  "gpt-5.4": "Use for everyday Codex work that does not need the frontier model.",
  "gpt-5.3-codex-spark": "Use for ultra-fast coding passes and low-risk edits.",
};

export function getModelDesc(model) {
  if (!model) return "";
  if (typeof model === "object" && (model.description || model.desc)) return model.description || model.desc;
  var lower = (model.value || model).toLowerCase();
  for (var key in MODEL_DESCRIPTIONS) {
    if (lower.indexOf(key) !== -1) return MODEL_DESCRIPTIONS[key];
  }
  return "";
}

export function isSonnetModel(model) {
  if (!model) return false;
  return model.toLowerCase().indexOf("sonnet") !== -1;
}

function modelEntryValue(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.value || model.model || model.id || model.name || "";
}

function modelEntryLabel(model) {
  if (!model) return "";
  if (typeof model === "string") return model;
  return model.displayName || model.display_name || model.label || model.name || model.id || model.model || model.value || "";
}

function modelEntryEfforts(model) {
  if (!model || typeof model !== "object") return [];
  var levels = model.supportedEffortLevels || model.supportedReasoningEfforts || [];
  var out = [];
  for (var i = 0; i < levels.length; i++) {
    var level = levels[i];
    if (level && typeof level === "object") level = level.reasoningEffort || level.value || level.id || level.name;
    if (typeof level === "string" && level && out.indexOf(level) === -1) out.push(level);
  }
  return out;
}

function effortOption(level) {
  if (level && typeof level === "object") return level;
  if (EFFORT_DETAILS[level]) return EFFORT_DETAILS[level];
  return { value: level, label: level ? (level.charAt(0).toUpperCase() + level.slice(1)) : "", desc: "Model-supported reasoning effort." };
}

function effortLevelsForModel(models, currentModel) {
  if (!Array.isArray(models) || !currentModel) return [];
  for (var i = 0; i < models.length; i++) {
    if (modelEntryValue(models[i]) === currentModel) return modelEntryEfforts(models[i]);
  }
  return [];
}

// --- Render functions ---
// Each takes an element ID prefix (e.g. "ss" or "ps"), a send function, and state getters.

/**
 * Render model list into `${prefix}-model-list`
 * @param {string} prefix - Element ID prefix
 * @param {object} opts - { models, currentModel, sendMsg, onModelSelect }
 */
export function renderModelList(prefix, opts) {
  var listEl = document.getElementById(prefix + "-model-list");
  if (!listEl) return;

  var models = opts.models || [];
  var currentModel = opts.currentModel || "";

  listEl.innerHTML = "";
  if (models.length === 0) {
    listEl.innerHTML = '<div style="font-size:13px;color:var(--text-dimmer);">No models available</div>';
    return;
  }

  for (var i = 0; i < models.length; i++) {
    (function (m) {
      var value = modelEntryValue(m);
      var label = modelEntryLabel(m) || value;
      var item = document.createElement("div");
      item.className = "settings-model-item" + (value === currentModel ? " active" : "");
      item.dataset.model = value;

      var nameSpan = document.createElement("span");
      nameSpan.className = "settings-model-name";
      nameSpan.textContent = label;
      item.appendChild(nameSpan);

      var desc = getModelDesc(m);
      if (desc) {
        var descSpan = document.createElement("span");
        descSpan.className = "settings-model-desc";
        descSpan.textContent = desc;
        item.appendChild(descSpan);
      }

      item.addEventListener("click", function () {
        var msg = { model: value };
        if (opts.vendor) msg.vendor = opts.vendor;
        opts.sendMsg(opts.modelMsgType, msg);
        var items = listEl.querySelectorAll(".settings-model-item");
        for (var j = 0; j < items.length; j++) items[j].classList.remove("active");
        item.classList.add("active");
        if (opts.onModelSelect) opts.onModelSelect(value);
      });

      listEl.appendChild(item);
    })(models[i]);
  }
}

/**
 * Render mode list into `${prefix}-mode-list`
 */
export function renderModeList(prefix, opts) {
  var listEl = document.getElementById(prefix + "-mode-list");
  if (!listEl) return;

  var currentMode = opts.currentMode || "default";
  var readOnly = !!opts.readOnlyMode;
  listEl.innerHTML = "";

  for (var i = 0; i < MODE_OPTIONS.length; i++) {
    (function (opt) {
      var item = document.createElement("div");
      item.className = "settings-model-item" + (opt.value === currentMode ? " active" : "") + (readOnly ? " disabled" : "");

      var nameSpan = document.createElement("span");
      nameSpan.className = "settings-model-name";
      nameSpan.textContent = opt.label;
      item.appendChild(nameSpan);

      var descSpan = document.createElement("span");
      descSpan.className = "settings-model-desc";
      descSpan.textContent = opt.desc;
      item.appendChild(descSpan);

      item.addEventListener("click", function () {
        if (readOnly) return;
        opts.sendMsg(opts.modeMsgType, { mode: opt.value });
        var items = listEl.querySelectorAll(".settings-model-item");
        for (var j = 0; j < items.length; j++) items[j].classList.remove("active");
        item.classList.add("active");
      });

      listEl.appendChild(item);
    })(MODE_OPTIONS[i]);
  }
}

/**
 * Render effort bar into `${prefix}-effort-bar`
 */
export function renderEffortBar(prefix, opts) {
  var bar = document.getElementById(prefix + "-effort-bar");
  if (!bar) return;

  var currentEffort = opts.currentEffort || "medium";
  var modelEfforts = effortLevelsForModel(opts.models, opts.currentModel);
  var levels = opts.effortLevels || (modelEfforts.length > 0 ? modelEfforts : EFFORT_LEVELS);
  bar.innerHTML = "";

  for (var i = 0; i < levels.length; i++) {
    (function (rawLevel) {
      var lvl = effortOption(rawLevel);
      var btn = document.createElement("button");
      btn.className = "settings-btn-option" + (lvl.value === currentEffort ? " active" : "");
      btn.textContent = lvl.label || (lvl.value.charAt(0).toUpperCase() + lvl.value.slice(1));
      btn.title = lvl.desc;
      btn.addEventListener("click", function () {
        opts.sendMsg(opts.effortMsgType, { effort: lvl.value });
        var btns = bar.querySelectorAll(".settings-btn-option");
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove("active");
        btn.classList.add("active");
      });
      bar.appendChild(btn);
    })(levels[i]);
  }
}

export function renderOptionList(elementId, options, currentValue, onSelect, readOnly) {
  var listEl = document.getElementById(elementId);
  if (!listEl) return;
  listEl.innerHTML = "";
  for (var i = 0; i < options.length; i++) {
    (function (opt) {
      var item = document.createElement("div");
      item.className = "settings-model-item" + (opt.value === currentValue ? " active" : "") + (readOnly ? " disabled" : "");
      item.dataset.value = opt.value;

      var nameSpan = document.createElement("span");
      nameSpan.className = "settings-model-name";
      nameSpan.textContent = opt.label;
      item.appendChild(nameSpan);

      if (opt.desc) {
        var descSpan = document.createElement("span");
        descSpan.className = "settings-model-desc";
        descSpan.textContent = opt.desc;
        item.appendChild(descSpan);
      }

      item.addEventListener("click", function () {
        if (readOnly) return;
        var items = listEl.querySelectorAll(".settings-model-item");
        for (var j = 0; j < items.length; j++) items[j].classList.remove("active");
        item.classList.add("active");
        if (onSelect) onSelect(opt.value);
      });
      listEl.appendChild(item);
    })(options[i]);
  }
}

/**
 * Render thinking bar into `${prefix}-thinking-bar`
 */
export function renderThinkingBar(prefix, opts) {
  var bar = document.getElementById(prefix + "-thinking-bar");
  if (!bar) return;

  var currentThinking = opts.currentThinking || "adaptive";
  var currentBudget = opts.currentThinkingBudget || 10000;
  var budgetRow = document.getElementById(prefix + "-thinking-budget-row");
  var budgetInput = document.getElementById(prefix + "-thinking-budget");
  bar.innerHTML = "";

  for (var i = 0; i < THINKING_OPTIONS.length; i++) {
    (function (opt) {
      var btn = document.createElement("button");
      btn.className = "settings-btn-option" + (opt.value === currentThinking ? " active" : "");
      btn.textContent = opt.label;
      btn.title = opt.desc;
      btn.addEventListener("click", function () {
        var msg = { thinking: opt.value };
        if (opt.value === "budget") {
          msg.budgetTokens = budgetInput ? parseInt(budgetInput.value, 10) || 10000 : 10000;
        }
        opts.sendMsg("set_thinking", msg);
        var btns = bar.querySelectorAll(".settings-btn-option");
        for (var j = 0; j < btns.length; j++) btns[j].classList.remove("active");
        btn.classList.add("active");
        if (budgetRow) budgetRow.style.display = opt.value === "budget" ? "" : "none";
      });
      bar.appendChild(btn);
    })(THINKING_OPTIONS[i]);
  }

  if (budgetRow) budgetRow.style.display = currentThinking === "budget" ? "" : "none";
  if (budgetInput) {
    budgetInput.value = currentBudget;
    budgetInput.addEventListener("change", function () {
      var val = Math.max(1024, Math.min(128000, parseInt(this.value, 10) || 10000));
      this.value = val;
      opts.sendMsg("set_thinking", { thinking: "budget", budgetTokens: val });
    });
  }
}

/**
 * Update beta card visibility and bind toggle
 */
export function renderBetaCard(prefix, opts) {
  var model = opts.overrideModel || opts.currentModel || "";
  var card = document.getElementById(prefix + "-beta-card");
  if (card) {
    card.style.display = isSonnetModel(model) ? "" : "none";
  }

  var toggle = document.getElementById(prefix + "-beta-1m");
  if (toggle) {
    var betas = opts.currentBetas || [];
    var hasBeta = false;
    for (var i = 0; i < betas.length; i++) {
      if (betas[i].indexOf("context-1m") !== -1) { hasBeta = true; break; }
    }
    toggle.checked = hasBeta;
    toggle.onchange = function () {
      var currentBetas = opts.currentBetas || [];
      var newBetas;
      if (this.checked) {
        newBetas = currentBetas.slice();
        newBetas.push("context-1m-2025-08-07");
      } else {
        newBetas = [];
        for (var j = 0; j < currentBetas.length; j++) {
          if (currentBetas[j].indexOf("context-1m") === -1) {
            newBetas.push(currentBetas[j]);
          }
        }
      }
      opts.sendMsg("set_betas", { betas: newBetas });
    };
  }
}
