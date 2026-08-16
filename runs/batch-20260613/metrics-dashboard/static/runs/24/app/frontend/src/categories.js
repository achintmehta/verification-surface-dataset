/**
 * Renders horizontal bar chart for category breakdown.
 */

export function renderCategoryBars(categories) {
  const wrapper = document.getElementById('categories-wrapper');
  if (!wrapper || !categories || categories.length === 0) return;

  wrapper.innerHTML = '';

  const maxValue = Math.max(...categories.map((c) => c.value));

  categories.forEach((cat) => {
    const pct = maxValue > 0 ? (cat.value / maxValue) * 100 : 0;

    const item = document.createElement('div');
    item.className = 'bar-item';

    const header = document.createElement('div');
    header.className = 'bar-item__header';

    const nameEl = document.createElement('span');
    nameEl.className = 'bar-item__name';
    nameEl.textContent = cat.name;
    nameEl.title = cat.name;

    const valueEl = document.createElement('span');
    valueEl.className = 'bar-item__value';
    valueEl.textContent = formatValue(cat.value);

    header.appendChild(nameEl);
    header.appendChild(valueEl);

    const track = document.createElement('div');
    track.className = 'bar-item__track';

    const fill = document.createElement('div');
    fill.className = 'bar-item__fill';
    fill.style.width = pct + '%';

    track.appendChild(fill);

    item.appendChild(header);
    item.appendChild(track);
    wrapper.appendChild(item);
  });
}

function formatValue(n) {
  if (n >= 1_000_000) {
    return '$' + (n / 1_000_000).toFixed(2) + 'M';
  }
  if (n >= 1_000) {
    return '$' + (n / 1_000).toFixed(0) + 'K';
  }
  return '$' + n.toLocaleString('en-US');
}
