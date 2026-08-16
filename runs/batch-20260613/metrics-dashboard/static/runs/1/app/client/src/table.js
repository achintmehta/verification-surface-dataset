/**
 * Renders the recent-items table body.
 */

import { formatCurrency2, formatTimestamp } from './utils/format.js';

/**
 * @param {HTMLElement} tbody
 * @param {Array<{id: number, name: string, category: string, value: number, created_at: string}>} data
 */
export function renderTable(tbody, data) {
  if (!data || data.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.style.textAlign = 'center';
    td.style.color = 'var(--color-text-muted)';
    td.style.padding = '2rem';
    td.textContent = 'No recent items.';
    tr.appendChild(td);
    tbody.innerHTML = '';
    tbody.appendChild(tr);
    return;
  }

  const rows = data.map(item => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    tdName.title = item.name;

    const tdCat = document.createElement('td');
    tdCat.textContent = item.category;
    tdCat.title = item.category;
    tdCat.style.maxWidth = '160px';
    tdCat.style.overflow = 'hidden';
    tdCat.style.textOverflow = 'ellipsis';
    tdCat.style.whiteSpace = 'nowrap';

    const tdVal = document.createElement('td');
    tdVal.className = 'col-value';
    tdVal.textContent = formatCurrency2(item.value);

    const tdDate = document.createElement('td');
    tdDate.className = 'col-date';
    tdDate.textContent = formatTimestamp(item.created_at);

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);

    return tr;
  });

  tbody.innerHTML = '';
  rows.forEach(r => tbody.appendChild(r));
}
