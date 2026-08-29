import { VENDOR_NAMES, VENDOR_ORDER } from './vendor-ui.js';

var DEFAULT_EFFORT_LEVELS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

function optionValue(entry) {
  if (typeof entry === "string") return entry;
  return entry && (entry.value || entry.id) || "";
}

function optionLabel(entry) {
  if (typeof entry === "string") return entry;
  return entry && (entry.displayName || entry.name || entry.value || entry.id) || "";
}

function effortDisplayName(value) {
  if (value === "xhigh") return "X-High";
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

function effortLevelsFor(vendor, models, modelValue) {
  for (var i = 0; i < models.length; i++) {
    if (optionValue(models[i]) !== modelValue) continue;
    if (Array.isArray(models[i].supportedEffortLevels) && models[i].supportedEffortLevels.length > 0) {
      return models[i].supportedEffortLevels;
    }
  }
  return DEFAULT_EFFORT_LEVELS[vendor] || [];
}

export function buildAgentVendorSelect(installed, preferred) {
  var select = document.createElement("select");
  select.className = "wt-modal-input";
  for (var i = 0; i < VENDOR_ORDER.length; i++) {
    var vendor = VENDOR_ORDER[i];
    if (installed.indexOf(vendor) === -1) continue;
    var option = document.createElement("option");
    option.value = vendor;
    option.textContent = VENDOR_NAMES[vendor] || vendor;
    select.appendChild(option);
  }
  if (preferred && installed.indexOf(preferred) !== -1) select.value = preferred;
  return select;
}

export function fillAgentModels(select, vendor, options, preferred) {
  var models = (options.modelsByVendor && options.modelsByVendor[vendor]) || [];
  select.innerHTML = "";
  var automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Automatic";
  select.appendChild(automatic);
  for (var i = 0; i < models.length; i++) {
    var option = document.createElement("option");
    option.value = optionValue(models[i]);
    option.textContent = optionLabel(models[i]);
    select.appendChild(option);
  }
  select.value = preferred || "";
  if (select.selectedIndex === -1) select.value = "";
}

export function buildAgentEffortSelect() {
  var select = document.createElement("select");
  select.className = "wt-modal-input";
  return select;
}

export function fillAgentEffort(select, vendor, options, modelValue, preferred) {
  var previous = preferred === undefined ? select.value : preferred;
  var models = (options.modelsByVendor && options.modelsByVendor[vendor]) || [];
  var levels = effortLevelsFor(vendor, models, modelValue);
  select.innerHTML = "";
  var automatic = document.createElement("option");
  automatic.value = "";
  automatic.textContent = "Default";
  select.appendChild(automatic);
  for (var i = 0; i < levels.length; i++) {
    var option = document.createElement("option");
    option.value = levels[i];
    option.textContent = effortDisplayName(levels[i]);
    select.appendChild(option);
  }
  select.value = levels.indexOf(previous) !== -1 ? previous : "";
}
