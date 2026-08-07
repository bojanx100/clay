// The shared confirmation modal.
//
// Extracted from app-misc.js so any module can ask for confirmation by direct
// import without pulling in the rest of the app graph. It owns nothing but the
// #confirm-modal element and the pending callback, and it never uses the
// browser-native confirm().

var confirmCallback = null;
var confirmRestoreFocus = null;
var confirmInitialized = false;

function focusableControls(confirmModal) {
  if (!confirmModal || typeof confirmModal.querySelectorAll !== "function") return [];
  return Array.from(confirmModal.querySelectorAll(
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), " +
    "textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
  )).filter(function (control) {
    return !control.disabled && typeof control.focus === "function";
  });
}

function restoreFocus() {
  var target = confirmRestoreFocus;
  confirmRestoreFocus = null;
  if (!target || typeof target.focus !== "function") return;
  if (typeof document.contains === "function" && !document.contains(target)) return;
  target.focus();
}

export function showConfirm(text, onConfirm, okLabel, destructive, cancelLabel) {
  var confirmText = document.getElementById("confirm-text");
  var confirmOk = document.getElementById("confirm-ok");
  var confirmModal = document.getElementById("confirm-modal");
  var confirmCancel = document.getElementById("confirm-cancel");
  if (!confirmModal || !confirmText || !confirmOk || !confirmCancel) return;
  if (confirmModal.classList.contains("hidden")) confirmRestoreFocus = document.activeElement || null;
  confirmText.textContent = text;
  confirmCallback = onConfirm;
  confirmOk.textContent = okLabel || "Delete";
  confirmOk.className = "confirm-btn " + (destructive === false ? "confirm-ok" : "confirm-delete");
  confirmCancel.textContent = cancelLabel || "Cancel";
  confirmModal.classList.remove("hidden");
  confirmCancel.focus();
}

// Cancelling is a no-op by construction: the pending callback is dropped
// without being invoked.
export function hideConfirm() {
  var confirmModal = document.getElementById("confirm-modal");
  if (confirmModal) confirmModal.classList.add("hidden");
  confirmCallback = null;
  restoreFocus();
}

export function initConfirmModal() {
  var confirmModal = document.getElementById("confirm-modal");
  var confirmOk = document.getElementById("confirm-ok");
  var confirmCancel = document.getElementById("confirm-cancel");
  if (!confirmModal || !confirmOk || !confirmCancel) return;
  if (confirmInitialized) return;
  confirmInitialized = true;

  confirmOk.addEventListener("click", function () {
    // Take the callback before running it, so a second activation of OK cannot
    // run the same confirmation twice.
    var pending = confirmCallback;
    confirmCallback = null;
    hideConfirm();
    if (pending) pending();
  });

  confirmCancel.addEventListener("click", hideConfirm);
  var backdrop = confirmModal.querySelector(".confirm-backdrop");
  if (backdrop) backdrop.addEventListener("click", hideConfirm);

  confirmModal.addEventListener("keydown", function (event) {
    if (confirmModal.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      hideConfirm();
      return;
    }
    if (event.key !== "Tab") return;
    var controls = focusableControls(confirmModal);
    if (controls.length === 0) {
      event.preventDefault();
      return;
    }
    var first = controls[0];
    var last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (controls.indexOf(document.activeElement) === -1) {
      event.preventDefault();
      first.focus();
    }
  });
}
