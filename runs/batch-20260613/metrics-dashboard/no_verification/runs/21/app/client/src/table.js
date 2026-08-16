/**
 * Recent items table renderer.
 */

export function renderTable(items) {
  const tbody = document.getElementById('recent-tbody');
  if (!tbody) return;

  tbody.innerHTML = '';

  items.forEach(item => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = item.name;
    tdName.title = item.name;

    const tdCat = document.createElement('td');
    tdCat.textContent = item.category;
    tdCat.title = item.category;

    const tdVal = document.createElement('td');
    tdVal.className = 'num-col';
    tdVal.textContent = '$' + Number(item.value).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

    const tdDate = document.createElement('td');
    const d = new Date(item.created_at);
    tdDate.textContent = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    tr.appendChild(tdName);
    tr.appendChild(tdCat);
    tr.appendChild(tdVal);
    tr.appendChild(tdDate);
    tbody.appendChild(tr);
  });
}
