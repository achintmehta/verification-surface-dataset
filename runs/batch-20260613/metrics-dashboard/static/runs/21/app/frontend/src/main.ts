import {
  getSummary,
  getTimeseries,
  getCategories,
  getRecent,
  getSettings,
  updateSettings,
  type SummaryData,
  type TimeSeriesPoint,
  type CategoryData,
  type RecentItem,
} from './api';
import { createChart, type ChartHandle } from './chart';

let currentTheme: 'light' | 'dark' = 'light';
let chartHandle: ChartHandle | null = null;

// ========== Theme Management ==========
function applyTheme(theme: 'light' | 'dark'): void {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

async function toggleTheme(): Promise<void> {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);

  // Re-render chart with new theme colors
  if (chartHandle) {
    // Small delay for CSS vars to propagate
    requestAnimationFrame(() => {
      chartHandle?.redraw();
    });
  }

  try {
    await updateSettings({ theme: newTheme });
  } catch (e) {
    console.error('Failed to persist theme:', e);
  }
}

// ========== Rendering Functions ==========
function renderStatCards(summary: SummaryData): void {
  const container = document.getElementById('stat-cards');
  if (!container) return;

  const cards = [
    {
      label: 'Total Visitors',
      value: summary.totalVisitors.toLocaleString('en-US'),
      trend: null as string | null,
      trendDir: null as string | null,
    },
    {
      label: 'Total Revenue',
      value: `$${summary.totalRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      trend: null,
      trendDir: null,
    },
    {
      label: 'Best Day',
      value: summary.bestDay
        ? `${summary.bestDay.visitors.toLocaleString('en-US')} visitors`
        : 'N/A',
      trend: summary.bestDay ? formatDate(summary.bestDay.date) : null,
      trendDir: null,
    },
    {
      label: '7-Day Trend',
      value: `${summary.trendPercent >= 0 ? '+' : ''}${summary.trendPercent}%`,
      trend: 'vs previous 7 days',
      trendDir: summary.trendPercent >= 0 ? 'up' : 'down',
    },
  ];

  container.innerHTML = cards.map(card => `
    <div class="stat-card">
      <div class="stat-card__label">${escapeHtml(card.label)}</div>
      <div class="stat-card__value">${escapeHtml(card.value)}</div>
      ${card.trend !== null ? `
        <div class="stat-card__trend${card.trendDir ? ` stat-card__trend--${card.trendDir}` : ''}">
          ${card.trendDir === 'up' ? '↑' : card.trendDir === 'down' ? '↓' : ''}
          ${escapeHtml(card.trend)}
        </div>
      ` : ''}
    </div>
  `).join('');
}

function renderCategories(categories: CategoryData[]): void {
  const container = document.getElementById('categories-list');
  if (!container) return;

  const maxValue = Math.max(...categories.map(c => c.value), 1);

  container.innerHTML = categories.map(cat => {
    const pct = (cat.value / maxValue) * 100;
    return `
      <div class="category-item">
        <div class="category-header">
          <span class="category-name" title="${escapeAttr(cat.name)}">${escapeHtml(cat.name)}</span>
          <span class="category-value">${cat.value.toLocaleString('en-US')}</span>
        </div>
        <div class="category-bar-track">
          <div class="category-bar-fill" style="width: ${pct.toFixed(1)}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderTable(items: RecentItem[]): void {
  const tbody = document.getElementById('table-body');
  if (!tbody) return;

  tbody.innerHTML = items.map(item => `
    <tr>
      <td>${escapeHtml(item.name)}</td>
      <td class="cell-category" title="${escapeAttr(item.category)}">${escapeHtml(item.category)}</td>
      <td>$${item.value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td>${formatDateTime(item.createdAt)}</td>
    </tr>
  `).join('');
}

function renderChart(data: TimeSeriesPoint[]): void {
  const wrapper = document.getElementById('chart-wrapper');
  if (!wrapper) return;

  if (chartHandle) {
    chartHandle.destroy();
    chartHandle = null;
  }

  chartHandle = createChart(wrapper, data);
}

// ========== Helpers ==========
function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ========== Initialization ==========
async function init(): Promise<void> {
  const loadingEl = document.getElementById('loading-state');
  const errorEl = document.getElementById('error-state');
  const contentEl = document.getElementById('dashboard-content');

  // Load theme first to prevent flash of wrong theme
  try {
    const settings = await getSettings();
    applyTheme(settings.theme);
  } catch {
    // Default to light if settings can't be loaded
    applyTheme('light');
  }

  // Set up theme toggle
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      void toggleTheme();
    });
  }

  try {
    const [summary, timeseries, categories, recent] = await Promise.all([
      getSummary(),
      getTimeseries(),
      getCategories(),
      getRecent(),
    ]);

    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'block';

    renderStatCards(summary);
    renderChart(timeseries);
    renderCategories(categories);
    renderTable(recent);
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'block';
    if (contentEl) contentEl.style.display = 'none';
  }
}

// Start the app
void init();
