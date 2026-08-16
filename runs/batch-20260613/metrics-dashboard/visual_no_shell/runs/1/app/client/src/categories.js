// ── Category breakdown bars ───────────────────────────────────────────────────

export function renderCategories(data) {
  const container = document.getElementById('categories-bars');
  if (!container) return;

  if (!data || data.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:0.875rem;padding:1rem 0">No data available</p>';
    return;
  }

  const maxVal = Math.max(...data.map(d => Number(d.value)));

  container.innerHTML = data.map(row => {
    const pct   = maxVal > 0 ? (Number(row.value) / maxVal) * 100 : 0;
    const label = formatValue(Number(row.value));
    // Escape HTML entities in name
    const name  = escapeHtml(row.name);
    return `
      <div class="cat-row">
        <div class="cat-row-top">
          <span class="cat-name" title="${name}">${name}</span>
          <span class="cat-value">${label}</span>
        </div>
        <div class="cat-bar-track" role="progressbar" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100" aria-label="${name}: ${label}">
          <div class="cat-bar-fill" style="width:${pct.toFixed(2)}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function formatValue(n) {
  if (n >= 1_000_000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 1,
      notation: 'compact',
    }).format(n);
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
