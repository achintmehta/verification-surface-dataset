/**
 * Renders the category breakdown as horizontal bars.
 * Long category names truncate with ellipsis.
 */

function formatValue(n) {
  if (n >= 1_000_000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 2,
    }).format(n);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  if (!container || !categories || categories.length === 0) {
    if (container) {
      container.innerHTML = `<p style="color: var(--color-text-muted); font-size: 0.875rem;">No categories available.</p>`;
    }
    return;
  }

  const maxValue = Math.max(...categories.map(c => c.value));

  container.innerHTML = categories.map(cat => {
    const pct = maxValue > 0 ? (cat.value / maxValue) * 100 : 0;
    const displayValue = formatValue(cat.value);
    return `
      <div class="category-item">
        <div class="category-item__header">
          <span class="category-item__name" title="${escapeHtml(cat.name)}">${escapeHtml(cat.name)}</span>
          <span class="category-item__value">${displayValue}</span>
        </div>
        <div class="category-item__bar-track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100" aria-label="${escapeHtml(cat.name)}: ${displayValue}">
          <div class="category-item__bar-fill" style="width: ${pct.toFixed(2)}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
