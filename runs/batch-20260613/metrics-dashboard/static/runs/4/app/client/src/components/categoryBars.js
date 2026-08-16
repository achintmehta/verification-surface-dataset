import { formatCurrency } from '../utils/format.js';

/**
 * Render horizontal category bars into #categories-container.
 * @param {Array<{name:string, value:number}>} categories
 */
export function renderCategoryBars(categories) {
  const container = document.getElementById('categories-container');
  if (!container) return;

  if (!categories || categories.length === 0) {
    container.innerHTML = '<p class="empty-state">No category data available.</p>';
    return;
  }

  const maxValue = Math.max(...categories.map(c => c.value));

  container.innerHTML = categories.map(cat => {
    const pct = maxValue > 0 ? (cat.value / maxValue) * 100 : 0;
    const formattedValue = formatCurrency(cat.value);
    // Escape HTML entities in the name for safe insertion
    const safeName = cat.name
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

    return `
      <div class="cat-row" role="figure" aria-label="${safeName}: ${formattedValue}">
        <div class="cat-row__label" title="${safeName}">${safeName}</div>
        <div class="cat-row__bar-track" aria-hidden="true">
          <div
            class="cat-row__bar-fill"
            style="width: ${pct.toFixed(2)}%"
          ></div>
        </div>
        <div class="cat-row__value">${formattedValue}</div>
      </div>
    `;
  }).join('');
}
