// Normalize restored PWA URLs before app.js derives its initial project route.
(function () {
  var isStandalone = !!(window.navigator && window.navigator.standalone)
    || !!(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  if (!isStandalone) return;

  document.documentElement.classList.add("pwa-standalone");
  if (window.location.pathname !== "/p/lead/" || window.location.search || window.location.hash) {
    window.history.replaceState(null, "", "/p/lead/");
  }
})();
