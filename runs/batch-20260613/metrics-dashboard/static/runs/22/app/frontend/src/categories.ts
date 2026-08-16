/** Render category breakdown as horizontal bars. */

import type { Category } from "./api";

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export function renderCategories(
  container: HTMLElement,
  categories: Category[]
): void {
  container.innerHTML = "";

  if (categories.length === 0) {
    container.textContent = "No categories available.";
    return;
  }

  const maxVal = Math.max(...categories.map((c) => c.value));

  categories.forEach((cat) => {
    const row = document.createElement("div");
    row.className = "category-row";

    const header = document.createElement("div");
    header.className = "category-header";

    const name = document.createElement("span");
    name.className = "category-name";
    name.textContent = cat.name;
    name.title = cat.name; // full name on hover

    const value = document.createElement("span");
    value.className = "category-value";
    value.textContent = formatNumber(cat.value);

    header.appendChild(name);
    header.appendChild(value);

    const track = document.createElement("div");
    track.className = "category-bar-track";

    const fill = document.createElement("div");
    fill.className = "category-bar-fill";
    const pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
    fill.style.width = `${pct}%`;

    track.appendChild(fill);
    row.appendChild(header);
    row.appendChild(track);
    container.appendChild(row);
  });
}
