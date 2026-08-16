/**
 * Log Explorer — Main entry point
 * Wires together the API client, virtual scroller, and filter controls.
 */

import { createApiClient } from './api.js';
import { createVirtualScroller } from './virtualScroller.js';
import { createFilterBar } from './filterBar.js';

const API_BASE = '/api';

async function main() {
  const api = createApiClient(API_BASE);

  // DOM refs
  const scrollContainer = document.getElementById('scroll-container');
  const scrollSpacer    = document.getElementById('scroll-spacer');
  const virtualRows     = document.getElementById('virtual-rows');
  const emptyState      = document.getElementById('empty-state');
  const loadingOverlay  = document.getElementById('loading-overlay');
  const rowCountEl      = document.getElementById('row-count');
  const corpusBadge     = document.getElementById('corpus-badge');

  // State
  let currentFilters = { severity: '', q: '' };
  let currentTotal   = 0;
  let isLoading      = false;

  // Virtual scroller
  const scroller = createVirtualScroller({
    container:  scrollContainer,
    spacer:     scrollSpacer,
    rowsEl:     virtualRows,
    rowHeight:  36,
    overscan:   5,
    fetchWindow: async (offset, limit) => {
      return api.getLogs({ offset, limit, ...currentFilters });
    },
    onTotalChange: (total) => {
      currentTotal = total;
      updateRowCount();
      updateEmptyState();
    },
    onLoadingChange: (loading) => {
      isLoading = loading;
      loadingOverlay.style.display = loading ? 'flex' : 'none';
    },
  });

  // Filter bar — defined after scroller so both exist before stats load
  const filterBar = createFilterBar({
    severitySelect:  document.getElementById('severity-select'),
    searchInput:     document.getElementById('search-input'),
    searchClear:     document.getElementById('search-clear'),
    badgesContainer: document.getElementById('severity-badges'),
    debounceMs:      250,
    onFilterChange:  (filters) => {
      currentFilters = filters;
      scroller.resetAndFetch();
    },
  });

  // Load stats for corpus badge and severity count badges
  api.getStats().then((stats) => {
    corpusBadge.textContent = `${stats.total.toLocaleString()} entries`;
    filterBar.updateBadgeCounts(stats.bySeverity);
  }).catch((err) => {
    console.warn('[main] Stats load failed:', err);
    corpusBadge.textContent = 'corpus';
  });

  function updateRowCount() {
    const { severity, q } = currentFilters;
    const hasFilter = severity || q;
    if (hasFilter) {
      rowCountEl.textContent = `${currentTotal.toLocaleString()} of 100,000 rows`;
    } else {
      rowCountEl.textContent = `${currentTotal.toLocaleString()} rows`;
    }
  }

  function updateEmptyState() {
    const isEmpty = currentTotal === 0 && !isLoading;
    emptyState.style.display = isEmpty ? 'flex' : 'none';
    scrollContainer.style.display = isEmpty ? 'none' : '';
  }

  // Initial load
  scroller.resetAndFetch();
}

main().catch(console.error);
