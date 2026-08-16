import { formatCurrencyFull, formatDate } from '../utils/format.js';

/**
 * Render the recent items table body.
 * @param {Array<{id:number, name:string, category:string, value:number, createdAt:string}>} items
 */
export function renderRecentTable(items) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  if (!items || items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" style="text-align:center; color: var(--color-text-muted); padding: 2rem;">
          No recent items found.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = items.map(item => {
    const safeName     = escapeHtml(item.name);
    const safeCategory = escapeHtml(item.category);
    const formattedVal  = formatCurrencyFull(item.value);
    const formattedDate = formatDate(item.createdAt);

    return `
      <tr>
        <td class="col-name">${safeName}</td>
        <td class="col-category" title="${safeCategory}">${safeCategory}</td>
        <td class="col-value">${formattedVal}</td>
        <td class="col-date">${formattedDate}</td>
      </tr>
    `;
  }).join('');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
