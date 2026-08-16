(function() {
  'use strict';

  const API_BASE = window.location.origin + '/api';

  // ========== Utility ==========
  function formatNumber(n) {
    if (n == null) return '—';
    return n.toLocaleString('en-US');
  }

  function formatCurrency(n) {
    if (n == null) return '—';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function formatDateTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ========== API Calls ==========
  async function fetchJSON(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  async function putJSON(url, data) {
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ========== Theme Management ==========
  async function loadTheme() {
    try {
      const { theme } = await fetchJSON(API_BASE + '/settings');
      applyTheme(theme);
    } catch (e) {
      // Default to light
      applyTheme('light');
    }
  }

  function applyTheme(theme) {
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
    // Redraw chart if data exists
    if (window.__timeseriesData) {
      drawTimeseriesChart(window.__timeseriesData);
    }
  }

  function getCurrentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }

  async function toggleTheme() {
    const current = getCurrentTheme();
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try {
      await putJSON(API_BASE + '/settings', { theme: next });
    } catch (e) {
      console.error('Failed to persist theme:', e);
    }
  }

  // ========== Stat Cards ==========
  function renderSummary(data) {
    document.getElementById('stat-visitors').textContent = formatNumber(data.totalVisitors);
    document.getElementById('stat-revenue').textContent = formatCurrency(data.totalRevenue);
    
    if (data.bestDay) {
      document.getElementById('stat-bestday').textContent = formatNumber(data.bestDay.visitors);
      document.getElementById('stat-bestday-date').textContent = formatDate(data.bestDay.date);
    }
    
    const trendVal = data.trendPercent;
    const trendEl = document.getElementById('stat-trend');
    const indicatorEl = document.getElementById('stat-trend-indicator');
    trendEl.textContent = (trendVal >= 0 ? '+' : '') + trendVal + '%';
    
    if (trendVal >= 0) {
      indicatorEl.textContent = '▲ Up from prior week';
      indicatorEl.className = 'stat-card__indicator up';
    } else {
      indicatorEl.textContent = '▼ Down from prior week';
      indicatorEl.className = 'stat-card__indicator down';
    }
  }

  // ========== Time-series Chart (SVG) ==========
  function getCSS(varName) {
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  }

  function drawTimeseriesChart(data) {
    const container = document.getElementById('timeseries-container');
    const svg = document.getElementById('timeseries-svg');
    
    const rect = container.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    
    if (width <= 0 || height <= 0) return;

    // Clear
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    // Colors from CSS custom properties
    const colorGrid = getCSS('--chart-grid');
    const colorAxis = getCSS('--chart-axis');
    const colorLine = getCSS('--chart-line');
    const colorFill = getCSS('--chart-fill');
    const colorDot = getCSS('--chart-dot');

    // Margins
    const marginTop = 10;
    const marginRight = 16;
    const marginBottom = 40;
    const marginLeft = 50;

    const plotW = width - marginLeft - marginRight;
    const plotH = height - marginTop - marginBottom;

    if (plotW <= 0 || plotH <= 0) return;

    // Data ranges
    const values = data.map(d => d.visitors);
    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const rangeV = maxV - minV || 1;
    const padding = rangeV * 0.1;
    const yMin = Math.max(0, minV - padding);
    const yMax = maxV + padding;
    const yRange = yMax - yMin;

    // Scales
    function xScale(i) {
      return marginLeft + (i / (data.length - 1)) * plotW;
    }
    function yScale(v) {
      return marginTop + plotH - ((v - yMin) / yRange) * plotH;
    }

    // SVG namespace helper
    function svgEl(tag, attrs) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) {
        el.setAttribute(k, v);
      }
      return el;
    }

    // Gridlines and Y-axis ticks
    const yTickCount = 5;
    for (let i = 0; i <= yTickCount; i++) {
      const v = yMin + (yRange * i) / yTickCount;
      const y = yScale(v);
      
      // Gridline
      svg.appendChild(svgEl('line', {
        x1: marginLeft, y1: y, x2: width - marginRight, y2: y,
        stroke: colorGrid, 'stroke-width': 1, 'stroke-dasharray': '3,3'
      }));
      
      // Tick label
      const label = svgEl('text', {
        x: marginLeft - 6, y: y + 4,
        'text-anchor': 'end', 'font-size': '11', fill: colorAxis,
        'font-family': 'sans-serif'
      });
      label.textContent = Math.round(v).toLocaleString();
      svg.appendChild(label);
    }

    // X-axis ticks (show ~6 evenly spaced)
    const xTickCount = Math.min(data.length, width < 500 ? 4 : 6);
    const step = Math.max(1, Math.floor((data.length - 1) / (xTickCount - 1)));
    for (let i = 0; i < data.length; i += step) {
      const x = xScale(i);
      const y = marginTop + plotH;

      // Tick mark
      svg.appendChild(svgEl('line', {
        x1: x, y1: y, x2: x, y2: y + 5,
        stroke: colorAxis, 'stroke-width': 1
      }));

      // Date label
      const label = svgEl('text', {
        x: x, y: y + 20,
        'text-anchor': 'middle', 'font-size': '10', fill: colorAxis,
        'font-family': 'sans-serif'
      });
      label.textContent = formatDate(data[i].date);
      svg.appendChild(label);
    }

    // X-axis line
    svg.appendChild(svgEl('line', {
      x1: marginLeft, y1: marginTop + plotH,
      x2: width - marginRight, y2: marginTop + plotH,
      stroke: colorAxis, 'stroke-width': 1
    }));

    // Y-axis line
    svg.appendChild(svgEl('line', {
      x1: marginLeft, y1: marginTop,
      x2: marginLeft, y2: marginTop + plotH,
      stroke: colorAxis, 'stroke-width': 1
    }));

    // Area fill
    let pathD = `M ${xScale(0)} ${yScale(data[0].visitors)}`;
    for (let i = 1; i < data.length; i++) {
      pathD += ` L ${xScale(i)} ${yScale(data[i].visitors)}`;
    }
    const areaD = pathD + ` L ${xScale(data.length - 1)} ${marginTop + plotH} L ${xScale(0)} ${marginTop + plotH} Z`;
    svg.appendChild(svgEl('path', {
      d: areaD, fill: colorFill, stroke: 'none'
    }));

    // Line
    svg.appendChild(svgEl('path', {
      d: pathD, fill: 'none', stroke: colorLine, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round'
    }));

    // Data points
    for (let i = 0; i < data.length; i++) {
      svg.appendChild(svgEl('circle', {
        cx: xScale(i), cy: yScale(data[i].visitors), r: 2.5,
        fill: colorDot, stroke: 'none'
      }));
    }
  }

  // ========== Category Breakdown ==========
  function renderCategories(data) {
    const container = document.getElementById('categories-container');
    container.innerHTML = '';

    const maxVal = Math.max(...data.map(c => c.value));

    data.forEach(cat => {
      const pct = (cat.value / maxVal) * 100;

      const row = document.createElement('div');
      row.className = 'category-row';

      row.innerHTML = `
        <div class="category-row__header">
          <span class="category-row__name" title="${cat.name}">${cat.name}</span>
          <span class="category-row__value">${formatNumber(cat.value)}</span>
        </div>
        <div class="category-row__bar-bg">
          <div class="category-row__bar-fill" style="width: ${pct}%"></div>
        </div>
      `;

      container.appendChild(row);
    });
  }

  // ========== Recent Items Table ==========
  function renderRecentItems(data) {
    const tbody = document.getElementById('recent-tbody');
    tbody.innerHTML = '';

    data.forEach(item => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td title="${item.name}">${item.name}</td>
        <td title="${item.category}">${item.category}</td>
        <td class="text-right">${formatCurrency(item.value)}</td>
        <td>${formatDateTime(item.createdAt)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // ========== Resize Handler for Chart ==========
  let resizeTimer;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (window.__timeseriesData) {
        drawTimeseriesChart(window.__timeseriesData);
      }
    }, 100);
  }

  // ========== Init ==========
  async function init() {
    // Load theme first (before data, to avoid flash)
    await loadTheme();

    // Wire up theme toggle
    document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

    // Wire up resize
    window.addEventListener('resize', onResize);

    try {
      // Fetch all data in parallel
      const [summary, timeseries, categories, recent] = await Promise.all([
        fetchJSON(API_BASE + '/summary'),
        fetchJSON(API_BASE + '/timeseries'),
        fetchJSON(API_BASE + '/categories'),
        fetchJSON(API_BASE + '/recent')
      ]);

      // Hide loading, show content
      document.getElementById('loading-state').style.display = 'none';
      document.getElementById('dashboard-content').style.display = 'block';

      // Render everything
      renderSummary(summary);

      window.__timeseriesData = timeseries;
      // Small delay to ensure container has dimensions
      requestAnimationFrame(() => {
        drawTimeseriesChart(timeseries);
      });

      renderCategories(categories);
      renderRecentItems(recent);

    } catch (err) {
      console.error('Failed to load dashboard data:', err);
      document.getElementById('loading-state').style.display = 'none';
      document.getElementById('error-state').style.display = 'block';
    }
  }

  // Start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
