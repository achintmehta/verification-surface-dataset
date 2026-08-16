/** Main entry point for the metrics dashboard. */

import {
  getSummary,
  getTimeseries,
  getCategories,
  getRecent,
  getSettings,
  putSettings,
} from "./api";
import type { SummaryData, TimeseriesPoint } from "./api";
import { drawChart } from "./chart";
import { renderCategories } from "./categories";
import { renderTable } from "./table";

// ---- DOM refs ----
const themeToggleBtn = document.getElementById("theme-toggle")!;
const themeIcon = document.getElementById("theme-icon")!;
const errorBanner = document.getElementById("error-banner")!;
const chartContainer = document.getElementById("chart-container")!;
const categoriesContainer = document.getElementById("categories-container")!;
const tableWrapper = document.getElementById("table-wrapper")!;

// ---- State ----
let currentTheme: "light" | "dark" = "light";
let timeseriesData: TimeseriesPoint[] = [];

// ---- Theme ----
function applyTheme(theme: "light" | "dark"): void {
  currentTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  themeIcon.textContent = theme === "dark" ? "☀️" : "🌙";
}

themeToggleBtn.addEventListener("click", async () => {
  const newTheme = currentTheme === "light" ? "dark" : "light";
  applyTheme(newTheme);
  // Redraw chart with new theme colors
  if (timeseriesData.length > 0) {
    drawChart(chartContainer, timeseriesData);
  }
  try {
    await putSettings({ theme: newTheme });
  } catch {
    // If persist fails, still keep local change
    console.warn("Failed to persist theme setting");
  }
});

// ---- Formatting helpers ----
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCurrency(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatPercent(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// ---- Render summary cards ----
function renderSummary(data: SummaryData): void {
  const valVisitors = document.getElementById("val-visitors")!;
  const valRevenue = document.getElementById("val-revenue")!;
  const valBestDay = document.getElementById("val-bestday")!;
  const valTrend = document.getElementById("val-trend")!;
  const trendTrend = document.getElementById("trend-trend")!;

  valVisitors.textContent = formatNumber(data.total_visitors);
  valRevenue.textContent = formatCurrency(data.total_revenue);
  valBestDay.textContent = data.best_day ? formatDate(data.best_day) : "N/A";

  const trendVal = data.seven_day_trend;
  valTrend.textContent = formatPercent(trendVal);
  trendTrend.textContent = trendVal >= 0 ? "▲ trending up" : "▼ trending down";
  trendTrend.className = `stat-trend ${trendVal >= 0 ? "up" : "down"}`;

  // add subtitle info
  const trendVisitors = document.getElementById("trend-visitors")!;
  trendVisitors.textContent = "30-day total";
  trendVisitors.className = "stat-trend";

  const trendRevenue = document.getElementById("trend-revenue")!;
  trendRevenue.textContent = "30-day total";
  trendRevenue.className = "stat-trend";

  const trendBestDay = document.getElementById("trend-bestday")!;
  trendBestDay.textContent = `${formatNumber(data.best_day_visitors)} visitors`;
  trendBestDay.className = "stat-trend";

  // Remove skeleton
  document.querySelectorAll(".stat-card.skeleton").forEach((el) => {
    el.classList.remove("skeleton");
  });
}

// ---- Chart resize ----
let resizeTimer: number | undefined;
function onResize(): void {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    if (timeseriesData.length > 0) {
      drawChart(chartContainer, timeseriesData);
    }
  }, 150);
}
window.addEventListener("resize", onResize);

// ---- Show error ----
function showError(msg: string): void {
  const msgEl = document.getElementById("error-message")!;
  msgEl.textContent = msg;
  errorBanner.hidden = false;
}

function clearLoadingMessages(): void {
  const chartLoading = document.getElementById("chart-loading");
  if (chartLoading) chartLoading.remove();
  const catLoading = document.getElementById("cat-loading");
  if (catLoading) catLoading.remove();
  const tableLoading = document.getElementById("table-loading");
  if (tableLoading) tableLoading.remove();
}

// ---- Bootstrap ----
async function init(): Promise<void> {
  // 1. Load theme setting first (before data)
  try {
    const settings = await getSettings();
    applyTheme(settings.theme);
  } catch {
    // Use default light theme
    console.warn("Failed to load theme settings, using default");
  }

  // 2. Load all data
  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      getSummary(),
      getTimeseries(),
      getCategories(),
      getRecent(),
    ]);

    clearLoadingMessages();

    // Render summary
    renderSummary(summary);

    // Render chart
    timeseriesData = timeseries;
    drawChart(chartContainer, timeseriesData);

    // Render categories
    renderCategories(categoriesContainer, categories);

    // Render table
    renderTable(tableWrapper, recent);
  } catch (err) {
    clearLoadingMessages();
    const msg =
      err instanceof Error ? err.message : "Unknown error";
    showError(`Unable to load dashboard data. ${msg}`);

    // Show empty states
    chartContainer.innerHTML =
      '<p class="loading-msg">No data — backend unavailable</p>';
    categoriesContainer.innerHTML =
      '<p class="loading-msg">No data — backend unavailable</p>';
    tableWrapper.innerHTML =
      '<p class="loading-msg">No data — backend unavailable</p>';
  }
}

init();
