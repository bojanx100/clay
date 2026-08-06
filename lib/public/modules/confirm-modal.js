// The shared confirmation modal.
//
// Extracted from app-misc.js so any module can ask for confirmation by direct
// import without pulling in the rest of the app graph. It owns nothing but the
// #confirm-modal element and the pending callback, and it never uses the
// browser-native confirm().

var confirmCallback = null;

export function showConfirm(text, onConfirm, okLabel, destructive, cancelLabel) {
  var confirmText = document.getElementById("confirm-text");
  var confirmOk = document.getElementById("confirm-ok");
  var confirmModal = document.getElementById("confirm-modal");
  var confirmCancel = document.getElementById("confirm-cancel");
  if (!confirmModal || !confirmText || !confirmOk || !confirmCancel) return;
  confirmText.textContent = text;
  confirmCallback = onConfirm;
  confirmOk.textContent = okLabel || "Delete";
  confirmOk.className = "confirm-btn " + (destructive === false ? "confirm-ok" : "confirm-delete");
  confirmCancel.textContent = cancelLabel || "Cancel";
  confirmModal.classList.remove("hidden");
}

// Cancelling is a no-op by construction: the pending callback is dropped
// without being invoked.
export function hideConfirm() {
  var confirmModal = document.getElementById("confirm-modal");
  if (confirmModal) confirmModal.classList.add("hidden");
  confirmCallback = null;
}

export function initConfirmModal() {
  var confirmModal = document.getElementById("confirm-modal");
  var confirmOk = document.getElementById("confirm-ok");
  var confirmCancel = document.getElementById("confirm-cancel");
  if (!confirmModal || !confirmOk || !confirmCancel) return;

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
}
