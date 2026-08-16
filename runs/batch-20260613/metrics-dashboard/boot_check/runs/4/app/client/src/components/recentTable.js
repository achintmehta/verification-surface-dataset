/**
 * Renders the recent items data table.
 */

function formatCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderRecentTable(items) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align: center; color: var(--color-text-muted); padding: 2rem;">
          No recent items found.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map(item => `
    <tr>
      <td class="td-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
      <td class="td-category" title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
      <td class="td-value text-right">${formatCurrency(item.value)}</td>
      <td class="td-date text-right">${formatDate(item.createdAt)}</td>
    </tr>
  `).join('');
}
