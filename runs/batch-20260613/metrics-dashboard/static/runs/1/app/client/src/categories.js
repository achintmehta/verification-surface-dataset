/**
 * Renders the category breakdown as horizontal bars.
 *
 * Long category names are truncated with CSS ellipsis (never overlapping bars).
 * Value labels are always fully visible.
 */

import { formatCurrency } from './utils/format.js';

/**
 * @param {HTMLElement} container
 * @param {Array<{name: string, value: number}>} data
 */
export function renderCategories(container, data) {
  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color:var(--color-text-muted);font-size:0.875rem">No data</p>';
    return;
  }

  const maxValue = Math.max(...data.map(d => d.value));

  container.innerHTML = '';

  for (const item of data) {
    const pct = maxValue > 0 ? (item.value / maxValue) * 100 : 0;

    const el = document.createElement('div');
    el.className = 'category-item';
    el.setAttribute('role', 'listitem');

    el.innerHTML = `
      <div class="category-item__header">
        <span class="category-item__name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
        <span class="category-item__value">${formatCurrency(item.value)}</span>
      </div>
      <div class="category-item__bar-track" role="progressbar"
           aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"
           aria-label="${escapeHtml(item.name)}: ${formatCurrency(item.value)}">
        <div class="category-item__bar-fill" style="width: ${pct.toFixed(2)}%"></div>
      </div>
    `;

    container.appendChild(el);
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
