/** Render recent items as a data table. */

import type { RecentItem } from "./api";

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function renderTable(
  wrapper: HTMLElement,
  items: RecentItem[]
): void {
  wrapper.innerHTML = "";

  if (items.length === 0) {
    wrapper.textContent = "No recent items available.";
    return;
  }

  const table = document.createElement("table");
  table.className = "data-table";

  // Header
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const headers = ["Name", "Category", "Value", "Date"];
  headers.forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement("tbody");
  items.forEach((item) => {
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.textContent = item.name;
    tr.appendChild(tdName);

    const tdCat = document.createElement("td");
    tdCat.textContent = item.category;
    tr.appendChild(tdCat);

    const tdVal = document.createElement("td");
    tdVal.textContent = formatNumber(item.value);
    tr.appendChild(tdVal);

    const tdDate = document.createElement("td");
    tdDate.textContent = formatDate(item.created_at);
    tr.appendChild(tdDate);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrapper.appendChild(table);
}
