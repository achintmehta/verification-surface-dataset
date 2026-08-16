(function() {
  'use strict';

  // ========== State ==========
  let currentTheme = 'light';
  let timeseriesData = [];
  let categoriesData = [];

  // ========== API helpers ==========
  const API_BASE = window.location.origin;

  async function apiFetch(path) {
    const resp = await fetch(API_BASE + path);
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  }

  async function apiPut(path, body) {
    const resp = await fetch(API_BASE + path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!resp.ok) throw new Error(`API error: ${resp.status}`);
    return resp.json();
  }

  // ========== Theme ==========
  function applyTheme(theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    const icon = document.getElementById('theme-icon');
    const label = document.getElementById('theme-label');
    if (theme === 'dark') {
      icon.textContent = '☀️';
      label.textContent = 'Light';
    } else {
      icon.textContent = '🌙';
      label.textContent = 'Dark';
    }
    // Re-render chart with new colors
    if (timeseriesData.length > 0) {
      drawTimeseriesChart(timeseriesData);
    }
  }

  async function toggleTheme() {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    try {
      await apiPut('/api/settings', { theme: newTheme });
    } catch (e) {
      console.error('Failed to persist theme:', e);
    }
  }

  // ========== Format helpers ==========
  function formatNumber(n) {
    if (n == null) return '—';
    return n.toLocaleString('en-US');
  }

  function formatCurrency(n) {
    if (n == null) return '—';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatDate(d) {
    if (!d) return '—';
    const date = new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatDateTime(d) {
    if (!d) return '—';
    const date = new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ========== Summary Cards ==========
  function renderSummary(data) {
    document.getElementById('val-visitors').textContent = formatNumber(data.totalVisitors);
    document.getElementById('val-revenue').textContent = formatCurrency(data.totalRevenue);
    if (data.bestDay) {
      document.getElementById('val-best-day').textContent = formatCurrency(data.bestDay.revenue);
      document.getElementById('val-best-day-date').textContent = formatDate(data.bestDay.date);
    }
    const trendEl = document.getElementById('val-trend');
    const indicatorEl = document.getElementById('trend-indicator');
    const trendVal = data.trend;
    const sign = trendVal >= 0 ? '+' : '';
    trendEl.textContent = sign + trendVal.toFixed(2) + '%';
    if (trendVal >= 0) {
      trendEl.style.color = 'var(--trend-up)';
      indicatorEl.textContent = '▲ Up from last week';
      indicatorEl.className = 'card-sub trend-indicator up';
    } else {
      trendEl.style.color = 'var(--trend-down)';
      indicatorEl.textContent = '▼ Down from last week';
      indicatorEl.className = 'card-sub trend-indicator down';
    }
  }

  // ========== Time-series Chart (SVG) ==========
  function drawTimeseriesChart(data) {
    timeseriesData = data;
    const container = document.getElementById('timeseries-container');
    const svg = document.getElementById('timeseries-chart');

    const rect = container.getBoundingClientRect();
    const totalWidth = Math.floor(rect.width);
    const totalHeight = Math.floor(rect.height);

    if (totalWidth <= 0 || totalHeight <= 0) return;

    // Get theme-aware colors from CSS vars
    const style = getComputedStyle(document.documentElement);
    const colorGrid = style.getPropertyValue('--chart-grid').trim();
    const colorAxis = style.getPropertyValue('--chart-axis').trim();
    const colorLine = style.getPropertyValue('--chart-line').trim();
    const colorFill = style.getPropertyValue('--chart-fill').trim();
    const colorDot = style.getPropertyValue('--chart-dot').trim();

    // Margins
    const margin = { top: 16, right: 16, bottom: 40, left: 52 };
    const w = totalWidth - margin.left - margin.right;
    const h = totalHeight - margin.top - margin.bottom;

    if (w <= 0 || h <= 0) return;

    const visitors = data.map(d => d.visitors);
    const minV = Math.min(...visitors);
    const maxV = Math.max(...visitors);
    const range = maxV - minV || 1;
    const yPad = range * 0.1;
    const yMin = Math.max(0, minV - yPad);
    const yMax = maxV + yPad;

    // Scale functions
    const xScale = (i) => margin.left + (i / (data.length - 1)) * w;
    const yScale = (v) => margin.top + h - ((v - yMin) / (yMax - yMin)) * h;

    // Build SVG content
    let svgContent = '';

    // Set viewBox for proper sizing
    svg.setAttribute('viewBox', `0 0 ${totalWidth} ${totalHeight}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // Gridlines (horizontal)
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      const val = yMin + (yMax - yMin) * (i / yTicks);
      const y = yScale(val);
      svgContent += `<line x1="${margin.left}" y1="${y}" x2="${totalWidth - margin.right}" y2="${y}" stroke="${colorGrid}" stroke-width="1" stroke-dasharray="4,3"/>`;
      svgContent += `<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" fill="${colorAxis}" font-size="10" font-family="sans-serif">${Math.round(val).toLocaleString()}</text>`;
    }

    // X-axis labels (show ~6-7 labels)
    const step = Math.max(1, Math.floor(data.length / 6));
    for (let i = 0; i < data.length; i += step) {
      const x = xScale(i);
      const label = formatDate(data[i].date);
      svgContent += `<text x="${x}" y="${totalHeight - 8}" text-anchor="middle" fill="${colorAxis}" font-size="10" font-family="sans-serif">${label}</text>`;
      svgContent += `<line x1="${x}" y1="${margin.top}" x2="${x}" y2="${margin.top + h}" stroke="${colorGrid}" stroke-width="1" stroke-dasharray="2,4" opacity="0.5"/>`;
    }
    // Always show last label
    if ((data.length - 1) % step !== 0) {
      const x = xScale(data.length - 1);
      const label = formatDate(data[data.length - 1].date);
      svgContent += `<text x="${x}" y="${totalHeight - 8}" text-anchor="middle" fill="${colorAxis}" font-size="10" font-family="sans-serif">${label}</text>`;
    }

    // Area fill
    let areaPath = `M ${xScale(0)} ${yScale(visitors[0])}`;
    for (let i = 1; i < data.length; i++) {
      areaPath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
    }
    areaPath += ` L ${xScale(data.length - 1)} ${margin.top + h} L ${xScale(0)} ${margin.top + h} Z`;
    svgContent += `<path d="${areaPath}" fill="${colorFill}"/>`;

    // Line
    let linePath = `M ${xScale(0)} ${yScale(visitors[0])}`;
    for (let i = 1; i < data.length; i++) {
      linePath += ` L ${xScale(i)} ${yScale(visitors[i])}`;
    }
    svgContent += `<path d="${linePath}" fill="none" stroke="${colorLine}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

    // Dots
    for (let i = 0; i < data.length; i++) {
      const cx = xScale(i);
      const cy = yScale(visitors[i]);
      svgContent += `<circle cx="${cx}" cy="${cy}" r="3" fill="${colorDot}" stroke="white" stroke-width="1"/>`;
    }

    // Axes lines
    svgContent += `<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + h}" stroke="${colorAxis}" stroke-width="1.5"/>`;
    svgContent += `<line x1="${margin.left}" y1="${margin.top + h}" x2="${totalWidth - margin.right}" y2="${margin.top + h}" stroke="${colorAxis}" stroke-width="1.5"/>`;

    svg.innerHTML = svgContent;
  }

  // ========== Categories Breakdown ==========
  function renderCategories(data) {
    categoriesData = data;
    const container = document.getElementById('categories-container');
    const maxValue = Math.max(...data.map(d => d.value));

    container.innerHTML = data.map(cat => {
      const pct = maxValue > 0 ? (cat.value / maxValue * 100) : 0;
      return `
        <div class="cat-row">
          <div class="cat-header">
            <span class="cat-name" title="${cat.name}">${escapeHtml(cat.name)}</span>
            <span class="cat-value">${formatNumber(cat.value)}</span>
          </div>
          <div class="cat-bar-bg">
            <div class="cat-bar-fill" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  // ========== Recent Items Table ==========
  function renderRecentItems(data) {
    const tbody = document.getElementById('recent-tbody');
    tbody.innerHTML = data.map(item => `
      <tr>
        <td title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</td>
        <td title="${escapeHtml(item.category)}">${escapeHtml(item.category)}</td>
        <td>${formatCurrency(item.value)}</td>
        <td>${formatDateTime(item.createdAt)}</td>
      </tr>
    `).join('');
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ========== Resize Handler ==========
  let resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (timeseriesData.length > 0) {
        drawTimeseriesChart(timeseriesData);
      }
    }, 100);
  }

  // ========== Init ==========
  async function init() {
    const loadingEl = document.getElementById('loading-state');
    const errorEl = document.getElementById('error-state');
    const contentEl = document.getElementById('dashboard-content');

    // Set up theme toggle
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // Load settings first (before painting content)
    try {
      const settings = await apiFetch('/api/settings');
      applyTheme(settings.theme || 'light');
    } catch (e) {
      console.warn('Could not load settings, using default theme');
    }

    // Load all data
    try {
      const [summary, timeseries, categories, recent] = await Promise.all([
        apiFetch('/api/summary'),
        apiFetch('/api/timeseries'),
        apiFetch('/api/categories'),
        apiFetch('/api/recent')
      ]);

      loadingEl.style.display = 'none';
      contentEl.style.display = 'block';

      renderSummary(summary);
      renderCategories(categories);
      renderRecentItems(recent);

      // Draw chart after DOM is visible (needs dimensions)
      requestAnimationFrame(() => {
        drawTimeseriesChart(timeseries);
      });

    } catch (e) {
      console.error('Failed to load dashboard data:', e);
      loadingEl.style.display = 'none';
      errorEl.style.display = 'block';
      return;
    }

    // Listen for resizes
    window.addEventListener('resize', onResize);
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
