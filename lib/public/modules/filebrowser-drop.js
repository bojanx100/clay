export function setupFilePathDrop(inputEl) {
  var dropHintEl = null;
  var dropHintTimer = null;

  function hideDropHint() {
    clearTimeout(dropHintTimer);
    if (dropHintEl) dropHintEl.classList.remove("visible");
  }

  function showDropHint() {
    if (!inputEl) return;
    if (!dropHintEl) {
      dropHintEl = document.createElement("div");
      dropHintEl.className = "fb-drop-hint";
      dropHintEl.textContent = "Drop here to insert file path";
      inputEl.parentElement.style.position = "relative";
      inputEl.parentElement.appendChild(dropHintEl);
    }
    dropHintEl.classList.add("visible");
    clearTimeout(dropHintTimer);
    dropHintTimer = setTimeout(function () { hideDropHint(); }, 3000);
  }

  if (inputEl) {
    inputEl.addEventListener("dragover", function (e) {
      if (e.dataTransfer.types.indexOf("text/plain") !== -1) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        inputEl.classList.add("drop-target");
      }
    });
    inputEl.addEventListener("dragleave", function () {
      inputEl.classList.remove("drop-target");
    });
    inputEl.addEventListener("drop", function (e) {
      inputEl.classList.remove("drop-target");
      hideDropHint();
      var filePath = e.dataTransfer.getData("text/plain");
      if (!filePath) return;
      e.preventDefault();
      var cursorPos = inputEl.selectionStart || 0;
      var before = inputEl.value.substring(0, cursorPos);
      var after = inputEl.value.substring(cursorPos);
      var prefix = before.length > 0 && before[before.length - 1] !== " " && before[before.length - 1] !== "\n" ? " " : "";
      var suffix = after.length > 0 && after[0] !== " " && after[0] !== "\n" ? " " : "";
      inputEl.value = before + prefix + filePath + suffix + after;
      var newPos = cursorPos + prefix.length + filePath.length + suffix.length;
      inputEl.setSelectionRange(newPos, newPos);
      inputEl.focus();
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    });
    document.addEventListener("dragend", function () {
      inputEl.classList.remove("drop-target");
      hideDropHint();
    });
  }

  return showDropHint;
}
