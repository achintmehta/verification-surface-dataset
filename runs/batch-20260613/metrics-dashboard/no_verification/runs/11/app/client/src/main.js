import { TimeSeriesChart } from "./chart.js";

const API_BASE = "/api";

const fmtInt = new Intl.NumberFormat("en-US");
const fmtCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});
const fmtCurrencyCents = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

let chart = null;

async function api(path, options) {
  const res = await fetch(API_BASE + path, options);
  if (!res.ok) {
    throw new Error(`Request to ${path} failed: ${res.status}`);
  }
  return res.json();
}

function showStatus(message, detail) {
  const el = document.getElementById("status");
  el.hidden = false;
  el.innerHTML = "";
  const title = document.createElement("p");
  title.className = "status__title";
  title.textContent = message;
  el.appendChild(title);
  if (detail) {
    const d = document.createElement("p");
    d.className = "status__detail";
    d.textContent = detail;
    el.appendChild(d);
  }
}

function clearStatus() {
  const el = document.getElementById("status");
  el.hidden = true;
  el.innerHTML = "";
}

/* ---------------- Theme ---------------- */
function applyTheme(theme) {
  const t = theme === "dark" ? "dark" : "light";
  document.body.setAttribute("data-theme", t);
  const label = document.querySelector(".theme-toggle__label");
  if (label) label.textContent = t === "dark" ? "Light mode" : "Dark mode";
  // Repaint chart so its internals match the new palette.
  if (chart) chart.draw();
}

async function loadTheme() {
  try {
    const { theme } = await api("/settings");
    applyTheme(theme);
    return theme;
  } catch {
    applyTheme("light");
    return "light";
  }
}

async function saveTheme(theme) {
  try {
    await api("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme }),
    });
  } catch (err) {
    console.error("Failed to persist theme", err);
  }
}

function setupThemeToggle() {
  const btn = document.getElementById("theme-toggle");
  btn.addEventListener("click", async () => {
    const current = document.body.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    applyTheme(next);
    await saveTheme(next);
  });
}

/* ---------------- Renderers ---------------- */
function renderSummary(summary) {
  const el = document.getElementById("stats");
  el.innerHTML = "";

  const trendUp = summary.trendPct >= 0;
  const trendSym = trendUp ? "▲" : "▼";
  const bestDate = summary.bestDay ? formatDate(summary.bestDay.date) : "—";
  const bestVisitors = summary.bestDay
    ? fmtInt.format(summary.bestDay.visitors)
    : "—";

  const cards = [
    {
      label: "Total Visitors",
      value: fmtInt.format(summary.totalVisitors),
      sub: "Across 30 days",
    },
    {
      label: "Total Revenue",
      value: fmtCurrency.format(summary.totalRevenue),
      sub: "Across 30 days",
    },
    {
      label: "Best Day",
      value: bestVisitors,
      sub: `${bestDate} · visitors`,
    },
    {
      label: "7-Day Trend",
      value: `${trendUp ? "+" : ""}${summary.trendPct}%`,
      sub: "vs prior 7 days",
      trend: trendUp ? "up" : "down",
      trendSym,
    },
  ];

  for (const c of cards) {
    const card = document.createElement("div");
    card.className = "stat";

    const label = document.createElement("p");
    label.className = "stat__label";
    label.textContent = c.label;

    const value = document.createElement("p");
    value.className = "stat__value";
    if (c.trend) {
      const span = document.createElement("span");
      span.className = `trend trend--${c.trend}`;
      span.textContent = `${c.trendSym} ${c.value}`;
      value.appendChild(span);
    } else {
      value.textContent = c.value;
    }

    const sub = document.createElement("p");
    sub.className = "stat__sub";
    sub.textContent = c.sub;

    card.append(label, value, sub);
    el.appendChild(card);
  }
}

function renderCategories(categories) {
  const el = document.getElementById("breakdown");
  el.innerHTML = "";
  const max = Math.max(...categories.map((c) => c.value), 1);

  for (const cat of categories) {
    const row = document.createElement("div");
    row.className = "bar-row";

    const name = document.createElement("span");
    name.className = "bar-row__name";
    name.textContent = cat.name;
    name.title = cat.name;

    const value = document.createElement("span");
    value.className = "bar-row__value";
    value.textContent = fmtCurrency.format(cat.value);

    const track = document.createElement("div");
    track.className = "bar-row__track";
    const fill = document.createElement("div");
    fill.className = "bar-row__fill";
    fill.style.width = `${(cat.value / max) * 100}%`;
    track.appendChild(fill);

    row.append(name, value, track);
    el.appendChild(row);
  }
}

function renderRecent(items) {
  const el = document.getElementById("recent");
  el.innerHTML = "";

  const table = document.createElement("table");
  table.className = "recent";

  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Name</th>
      <th>Category</th>
      <th style="text-align:right">Value</th>
      <th>Created</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const item of items) {
    const tr = document.createElement("tr");

    const name = document.createElement("td");
    name.className = "name";
    name.textContent = item.name;
    name.title = item.name;

    const cat = document.createElement("td");
    cat.className = "category";
    cat.textContent = item.category;
    cat.title = item.category;

    const value = document.createElement("td");
    value.className = "value";
    value.textContent = fmtCurrencyCents.format(item.value);

    const created = document.createElement("td");
    created.textContent = formatDate(item.created_at);

    tr.append(name, cat, value, created);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  el.appendChild(table);
}

function formatDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* ---------------- Boot ---------------- */
async function loadDashboard() {
  // Theme first so first paint is correct.
  await loadTheme();

  const container = document.getElementById("chart-container");
  const canvas = document.getElementById("chart");
  if (!chart) chart = new TimeSeriesChart(canvas, container);

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      api("/summary"),
      api("/timeseries"),
      api("/categories"),
      api("/recent"),
    ]);

    clearStatus();
    renderSummary(summary);
    chart.setData(timeseries);
    renderCategories(categories);
    renderRecent(recent);
  } catch (err) {
    console.error(err);
    showStatus(
      "Unable to load dashboard data.",
      "The backend API is unreachable. Start the server and reload the page."
    );
    // Clear any partial content so nothing stale is shown.
    document.getElementById("stats").innerHTML = "";
    document.getElementById("breakdown").innerHTML = "";
    document.getElementById("recent").innerHTML = "";
    if (chart) chart.setData([]);
  }
}

setupThemeToggle();
loadDashboard();
