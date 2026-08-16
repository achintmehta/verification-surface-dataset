import { drawTimeseriesChart } from './chart.js';
import { renderCategoryBars } from './categories.js';

// ─── API Helpers ──────────────────────────────────────────────

const API_BASE = '/api';

async function fetchJSON(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// ─── Number Formatting ───────────────────────────────────────

function formatNumber(n) {
  return n.toLocaleString('en-US');
}

function formatCurrency(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatDateTime(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Theme ────────────────────────────────────────────────────

let currentTheme = 'light';

function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  const label = document.getElementById('theme-label');
  if (icon && label) {
    icon.textContent = theme === 'light' ? '🌙' : '☀️';
    label.textContent = theme === 'light' ? 'Dark' : 'Light';
  }
}

async function loadTheme() {
  try {
    const settings = await fetchJSON('/settings');
    applyTheme(settings.theme || 'light');
  } catch {
    applyTheme('light');
  }
}

async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);

  // Re-render chart with new theme colors
  if (window.__timeseriesData) {
    drawTimeseriesChart(window.__timeseriesData);
  }

  try {
    await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: newTheme }),
    });
  } catch (err) {
    console.warn('Failed to persist theme:', err);
  }
}

// ─── Render Functions ─────────────────────────────────────────

function renderSummary(data) {
  document.getElementById('stat-visitors').textContent = formatNumber(data.totalVisitors);
  document.getElementById('stat-revenue').textContent = formatCurrency(data.totalRevenue);
  document.getElementById('stat-bestday').textContent = formatNumber(data.bestDay.visitors) + ' visitors';
  document.getElementById('stat-bestday-date').textContent = formatDate(data.bestDay.date);

  const trendEl = document.getElementById('stat-trend');
  const indicatorEl = document.getElementById('stat-trend-indicator');
  const trendVal = data.sevenDayTrend;
  const sign = trendVal >= 0 ? '+' : '';
  trendEl.textContent = sign + trendVal.toFixed(2) + '%';

  if (trendVal >= 0) {
    indicatorEl.textContent = '▲ Up';
    indicatorEl.className = 'stat-card__indicator up';
  } else {
    indicatorEl.textContent = '▼ Down';
    indicatorEl.className = 'stat-card__indicator down';
  }
}

function renderRecentTable(items) {
  const tbody = document.getElementById('recent-tbody');
  tbody.innerHTML = '';
  items.forEach((item) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
      <td title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
      <td class="text-right">${formatCurrency(item.value)}</td>
      <td>${formatDateTime(item.created_at)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Initialization ──────────────────────────────────────────

async function init() {
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  // Load and apply theme first (before data) to avoid flash
  await loadTheme();

  // Set up theme toggle
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

  try {
    // Fetch all data in parallel
    const [summary, timeseries, categories, recent] = await Promise.all([
      fetchJSON('/summary'),
      fetchJSON('/timeseries'),
      fetchJSON('/categories'),
      fetchJSON('/recent'),
    ]);

    // Hide loading, show content
    loadingEl.style.display = 'none';
    contentEl.style.display = 'block';

    // Render summary cards
    renderSummary(summary);

    // Store timeseries for theme-change re-renders
    window.__timeseriesData = timeseries;

    // Render time-series chart
    drawTimeseriesChart(timeseries);

    // Render category bars
    renderCategoryBars(categories);

    // Render recent items table
    renderRecentTable(recent);

    // Re-draw chart on resize
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (window.__timeseriesData) {
          drawTimeseriesChart(window.__timeseriesData);
        }
      }, 100);
    });
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    loadingEl.style.display = 'none';
    errorEl.style.display = 'block';
    contentEl.style.display = 'none';
  }
}

document.addEventListener('DOMContentLoaded', init);
