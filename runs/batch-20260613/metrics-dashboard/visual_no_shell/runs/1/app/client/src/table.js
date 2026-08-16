// ── Recent items table ────────────────────────────────────────────────────────

export function renderRecent(data) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="table-loading">No recent items</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(row => {
    const name     = escapeHtml(row.name);
    const category = escapeHtml(row.category);
    const value    = formatCurrency(Number(row.value));
    const date     = formatDate(row.created_at);
    return `
      <tr>
        <td class="td-name" title="${name}">${name}</td>
        <td class="td-category" title="${category}">${category}</td>
        <td class="td-value">${value}</td>
        <td class="td-date">${date}</td>
      </tr>
    `;
  }).join('');
}

function formatCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(n);
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
