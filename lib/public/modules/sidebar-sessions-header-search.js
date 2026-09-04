import { store } from './store.js';
import { getWs } from './ws-ref.js';

var searchDebounce = null;
var headerSearchOpen = false;

function getHeaderSearchEls() {
  return {
    searchInline: document.getElementById("session-header-search-inline"),
    searchInput: document.getElementById("session-header-search-input"),
    searchClear: document.getElementById("session-header-search-clear"),
    searchBtn: document.getElementById("session-header-search-btn"),
    filterCount: document.getElementById("session-filter-count"),
  };
}

function runSessionSearch(deps, query) {
  var normalizedQuery = query || "";
  var trimmedQuery = normalizedQuery.trim();
  deps.setSearchQuery(normalizedQuery);
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  if (!trimmedQuery) {
    deps.setSearchMatchIds(null);
    deps.renderSessionList(null);
    return;
  }
  // Global Coop rows have stable SessionRefs rather than current project-local
  // ids, so the Lead view filters its bounded projection client-side. Sending
  // this query to the Lead session manager would search the wrong collection.
  if (store.get("currentSlug") === "lead") {
    deps.setSearchMatchIds(null);
    deps.renderSessionList(null);
    return;
  }
  searchDebounce = setTimeout(function () {
    if (getWs() && store.get('connected')) {
      getWs().send(JSON.stringify({ type: "search_sessions", query: deps.getSearchQuery() }));
    }
  }, 200);
}

export function syncSessionHeaderSearchUi(deps) {
  var els = getHeaderSearchEls();
  var searchQuery = deps.getSearchQuery();
  var searchMatchIds = deps.getSearchMatchIds();
  var isOpen = headerSearchOpen || !!searchQuery;
  if (!els.searchInline || !els.searchInput || !els.searchClear || !els.searchBtn || !els.filterCount) return;
  els.searchInline.classList.toggle("hidden", !isOpen);
  els.searchBtn.classList.toggle("active", isOpen);
  if (els.searchInput.value !== searchQuery) {
    els.searchInput.value = searchQuery;
  }
  els.searchClear.classList.toggle("hidden", !searchQuery);
  if (!searchQuery || searchMatchIds === null) {
    els.filterCount.classList.add("hidden");
    els.filterCount.textContent = "";
  } else {
    els.filterCount.classList.remove("hidden");
    els.filterCount.textContent = String(searchMatchIds.size);
  }
}

function openHeaderSearch(deps) {
  headerSearchOpen = true;
  syncSessionHeaderSearchUi(deps);
  var searchInput = document.getElementById("session-header-search-input");
  if (searchInput) {
    requestAnimationFrame(function () {
      searchInput.focus();
      searchInput.select();
    });
  }
}

function closeHeaderSearch(deps) {
  headerSearchOpen = false;
  syncSessionHeaderSearchUi(deps);
}

function clearSessionSearch(deps, shouldBlur, input, shouldClose) {
  if (searchDebounce) {
    clearTimeout(searchDebounce);
    searchDebounce = null;
  }
  deps.setSearchQuery("");
  deps.setSearchMatchIds(null);
  if (shouldClose) {
    headerSearchOpen = false;
  }
  syncSessionHeaderSearchUi(deps);
  deps.renderSessionList(null);
  if (shouldBlur && input) {
    input.blur();
  }
}

export function initSessionHeaderSearch(deps) {
  var els = getHeaderSearchEls();
  if (!els.searchBtn || !els.searchInput || !els.searchClear || !els.searchInline) return;

  els.searchBtn.addEventListener("click", function () {
    if (!headerSearchOpen && !deps.getSearchQuery()) {
      openHeaderSearch(deps);
      return;
    }
    if (!deps.getSearchQuery()) {
      closeHeaderSearch(deps);
      return;
    }
    els.searchInput.focus();
    els.searchInput.select();
  });

  els.searchInput.addEventListener("input", function () {
    runSessionSearch(deps, els.searchInput.value);
    syncSessionHeaderSearchUi(deps);
  });

  els.searchInput.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (els.searchInput.value.trim()) {
        clearSessionSearch(deps, false, els.searchInput, false);
        return;
      }
      clearSessionSearch(deps, true, els.searchInput, true);
    }
  });

  els.searchInput.addEventListener("blur", function () {
    setTimeout(function () {
      if (!deps.getSearchQuery() && document.activeElement !== els.searchBtn && document.activeElement !== els.searchClear) {
        closeHeaderSearch(deps);
      }
    }, 0);
  });

  els.searchClear.addEventListener("click", function () {
    clearSessionSearch(deps, false, els.searchInput, false);
    els.searchInput.focus();
  });

  syncSessionHeaderSearchUi(deps);
}
