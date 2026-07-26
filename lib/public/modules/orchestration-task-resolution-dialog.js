var overlay = null;

function closeDialog() {
  if (!overlay) return;
  overlay.remove();
  overlay = null;
}

function field(labelText, placeholder) {
  var wrap = document.createElement("label");
  wrap.className = "orchestration-resolution-field";
  var label = document.createElement("span");
  label.textContent = labelText;
  var input = document.createElement("textarea");
  input.rows = 3;
  input.placeholder = placeholder;
  wrap.appendChild(label);
  wrap.appendChild(input);
  return { wrap: wrap, input: input };
}

export function showTaskResolutionDialog(task, onResolve) {
  closeDialog();
  overlay = document.createElement("div");
  overlay.className = "orchestration-resolution-overlay";
  overlay.setAttribute("role", "presentation");

  var dialog = document.createElement("div");
  dialog.className = "orchestration-resolution-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "orchestration-resolution-title");

  var title = document.createElement("h3");
  title.id = "orchestration-resolution-title";
  title.textContent = "Resolve task";
  var description = document.createElement("p");
  description.textContent = 'Mark "' + (task.title || "Parallel task") +
    '" complete only if you finished and verified the requested outcome.';
  var summary = field("Completed outcome", "What is now finished?");
  var verification = field("Verification evidence", "Tests, commands, or observable evidence");
  var error = document.createElement("div");
  error.className = "orchestration-resolution-error";

  var actions = document.createElement("div");
  actions.className = "orchestration-resolution-actions";
  var cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Keep needs input";
  cancel.addEventListener("click", closeDialog);
  var resolve = document.createElement("button");
  resolve.type = "button";
  resolve.className = "orchestration-resolution-submit";
  resolve.textContent = "Mark complete";
  resolve.addEventListener("click", function () {
    var summaryText = summary.input.value.trim();
    var verificationText = verification.input.value.trim();
    if (!summaryText || !verificationText) {
      error.textContent = "A concrete outcome and verification evidence are required.";
      return;
    }
    onResolve(summaryText, verificationText);
    closeDialog();
  });
  actions.appendChild(cancel);
  actions.appendChild(resolve);

  dialog.appendChild(title);
  dialog.appendChild(description);
  dialog.appendChild(summary.wrap);
  dialog.appendChild(verification.wrap);
  dialog.appendChild(error);
  dialog.appendChild(actions);
  overlay.appendChild(dialog);
  overlay.addEventListener("click", function (event) {
    if (event.target === overlay) closeDialog();
  });
  document.body.appendChild(overlay);
  summary.input.focus();
}

