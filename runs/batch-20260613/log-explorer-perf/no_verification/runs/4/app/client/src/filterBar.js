/**
 * Filter bar controller.
 * Manages severity dropdown, debounced search input, and severity badge clicks.
 * Calls onFilterChange with { severity, q } whenever filters change.
 */

export function createFilterBar({
  severitySelect,
  searchInput,
  searchClear,
  badgesContainer,
  debounceMs,
  onFilterChange,
}) {
  let debounceTimer = null;
  let currentSeverity = '';
  let currentQ = '';

  // ---- Severity select ----
  severitySelect.addEventListener('change', () => {
    currentSeverity = severitySelect.value;
    syncBadgeActive();
    emitChange();
  });

  // ---- Search input (debounced) ----
  searchInput.addEventListener('input', () => {
    const val = searchInput.value;
    searchClear.style.display = val ? 'block' : 'none';

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      currentQ = val.trim();
      emitChange();
    }, debounceMs);
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    clearTimeout(debounceTimer);
    currentQ = '';
    emitChange();
    searchInput.focus();
  });

  // ---- Badge clicks (shortcut to set severity filter) ----
  badgesContainer.addEventListener('click', (e) => {
    const badge = e.target.closest('.badge[data-sev]');
    if (!badge) return;

    const sev = badge.dataset.sev;
    if (currentSeverity === sev) {
      // Toggle off
      currentSeverity = '';
      severitySelect.value = '';
    } else {
      currentSeverity = sev;
      severitySelect.value = sev;
    }
    syncBadgeActive();
    emitChange();
  });

  function syncBadgeActive() {
    const badges = badgesContainer.querySelectorAll('.badge[data-sev]');
    for (const badge of badges) {
      badge.classList.toggle('active', badge.dataset.sev === currentSeverity);
    }
  }

  function emitChange() {
    onFilterChange({ severity: currentSeverity, q: currentQ });
  }

  function updateBadgeCounts(bySeverity) {
    const badges = badgesContainer.querySelectorAll('.badge[data-sev]');
    for (const badge of badges) {
      const sev = badge.dataset.sev;
      const countEl = badge.querySelector('.badge-count');
      if (countEl && bySeverity[sev] !== undefined) {
        countEl.textContent = bySeverity[sev].toLocaleString();
      }
    }
  }

  return { updateBadgeCounts };
}
