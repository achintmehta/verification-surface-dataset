/**
 * Renders horizontal bar chart for category breakdown.
 */

export function drawCategoryBars(container, data) {
  container.innerHTML = '';
  if (!data || data.length === 0) return;

  const maxVal = Math.max(...data.map(d => d.value));

  for (const item of data) {
    const row = document.createElement('div');
    row.className = 'cat-row';

    const labelRow = document.createElement('div');
    labelRow.className = 'cat-label-row';

    const name = document.createElement('span');
    name.className = 'cat-name';
    name.textContent = item.name;
    name.title = item.name; // full text on hover

    const value = document.createElement('span');
    value.className = 'cat-value';
    value.textContent = Number(item.value).toLocaleString();

    labelRow.appendChild(name);
    labelRow.appendChild(value);

    const track = document.createElement('div');
    track.className = 'cat-bar-track';

    const fill = document.createElement('div');
    fill.className = 'cat-bar-fill';
    const pct = maxVal > 0 ? (item.value / maxVal) * 100 : 0;
    fill.style.width = `${pct}%`;

    track.appendChild(fill);
    row.appendChild(labelRow);
    row.appendChild(track);
    container.appendChild(row);
  }
}
