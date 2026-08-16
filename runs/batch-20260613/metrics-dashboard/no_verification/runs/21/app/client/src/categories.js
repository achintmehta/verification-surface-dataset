/**
 * Category breakdown renderer – horizontal bars with value labels.
 */

export function renderCategories(categories) {
  const container = document.getElementById('categories-list');
  if (!container) return;

  container.innerHTML = '';

  const maxValue = Math.max(...categories.map(c => c.value));

  categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'category-row';

    const header = document.createElement('div');
    header.className = 'category-row__header';

    const name = document.createElement('span');
    name.className = 'category-row__name';
    name.textContent = cat.name;
    name.title = cat.name; // tooltip for truncated names

    const value = document.createElement('span');
    value.className = 'category-row__value';
    value.textContent = Number(cat.value).toLocaleString();

    header.appendChild(name);
    header.appendChild(value);

    const barBg = document.createElement('div');
    barBg.className = 'category-row__bar-bg';

    const barFill = document.createElement('div');
    barFill.className = 'category-row__bar-fill';
    const pct = maxValue > 0 ? (cat.value / maxValue) * 100 : 0;
    barFill.style.width = pct + '%';

    barBg.appendChild(barFill);

    row.appendChild(header);
    row.appendChild(barBg);
    container.appendChild(row);
  });
}
