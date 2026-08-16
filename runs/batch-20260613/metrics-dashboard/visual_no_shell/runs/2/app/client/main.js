// ── Helpers ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function fmtNumber(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(n));
}

function fmtCurrency(n) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(n);
}

function fmtDate(iso) {
  var s = String(iso).slice(0, 10);
  var parts = s.split('-');
  var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateShort(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── API ───────────────────────────────────────────────────────────────────────

function apiFetch(path) {
  return fetch(path).then(function(r) {
    if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + path);
    return r.json();
  });
}

// ── Responsive layout manager ─────────────────────────────────────────────────
// Measures the actual rendered width of the main container and applies
// layout classes. This works regardless of how the viewport is constrained.

var BREAKPOINT_SM = 640;
var BREAKPOINT_LG = 1024;

function applyLayout() {
  var main = $('main-content');
  if (!main) return;

  var w = main.getBoundingClientRect().width;

  var statGrid  = $('stat-grid');
  var bodyGrid  = document.querySelector('.body-grid');
  var chartCont = $('chart-container');

  if (!statGrid || !bodyGrid) return;

  // Stat grid: 1 col < 640, 2 col 640–1023, 4 col ≥ 1024
  statGrid.classList.remove('layout-1col', 'layout-2col', 'layout-4col');
  if (w >= BREAKPOINT_LG) {
    statGrid.classList.add('layout-4col');
  } else if (w >= BREAKPOINT_SM) {
    statGrid.classList.add('layout-2col');
  } else {
    statGrid.classList.add('layout-1col');
  }

  // Body grid: side-by-side only at ≥ 1024
  bodyGrid.classList.remove('layout-2col');
  if (w >= BREAKPOINT_LG) {
    bodyGrid.classList.add('layout-2col');
  }

  // Chart aspect ratio: taller on narrow
  if (chartCont) {
    if (w >= BREAKPOINT_SM) {
      chartCont.style.aspectRatio = '16 / 7';
      chartCont.style.maxHeight   = 'none';
    } else {
      chartCont.style.aspectRatio = '4 / 3';
      chartCont.style.maxHeight   = '260px';
    }
  }

  // Redraw chart to fit new container size
  if (lastTimeseriesData) {
    requestAnimationFrame(function() { drawChart(lastTimeseriesData); });
  }
}

// ── Theme ─────────────────────────────────────────────────────────────────────

var currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
var lastTimeseriesData = null;

function applyTheme(theme, persist) {
  currentTheme = theme;
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  if (lastTimeseriesData) drawChart(lastTimeseriesData);
  if (persist !== false) {
    fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: theme }),
    }).catch(function() {});
  }
}

$('theme-toggle').addEventListener('click', function() {
  applyTheme(currentTheme === 'dark' ? 'light' : 'dark');
});

// ── Chart (hand-drawn on Canvas) ──────────────────────────────────────────────

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function niceYTicks(minVal, maxVal, count) {
  var range = maxVal - minVal || 1;
  var rough = range / (count - 1);
  var mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  var niceFactors = [1, 2, 2.5, 5, 10];
  var niceFactor = 10;
  for (var fi = 0; fi < niceFactors.length; fi++) {
    if (niceFactors[fi] * mag >= rough) { niceFactor = niceFactors[fi]; break; }
  }
  var nice  = niceFactor * mag;
  var start = Math.floor(minVal / nice) * nice;
  var ticks = [];
  for (var i = 0; ticks.length < count + 2; i++) {
    var t = start + i * nice;
    ticks.push(t);
    if (t >= maxVal && ticks.length >= count) break;
  }
  return ticks.slice(0, count + 1);
}

function drawChart(data) {
  lastTimeseriesData = data;
  var canvas    = $('timeseries-canvas');
  var container = $('chart-container');
  if (!canvas || !container || !data || data.length === 0) return;

  var rect = container.getBoundingClientRect();
  var dpr  = window.devicePixelRatio || 1;
  var W    = rect.width;
  var H    = rect.height;

  if (W < 1 || H < 1) return;

  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);

  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  var colLine      = getCSSVar('--chart-line');
  var colGrid      = getCSSVar('--chart-grid');
  var colAxis      = getCSSVar('--chart-axis');
  var colFillStart = getCSSVar('--chart-fill-start');
  var colFillEnd   = getCSSVar('--chart-fill-end');
  var colBg        = getCSSVar('--surface');

  var fontSize = Math.max(9, Math.min(12, W * 0.028));
  ctx.font = fontSize + 'px -apple-system, BlinkMacSystemFont, sans-serif';

  var values = data.map(function(d) { return d.visitors; });
  var maxVal = Math.max.apply(null, values);
  var minVal = Math.min.apply(null, values);

  var yTicks = niceYTicks(minVal, maxVal, 5);
  var yMax   = yTicks[yTicks.length - 1];
  var yMin   = yTicks[0];

  var widestLabel  = ctx.measureText(fmtNumber(yMax)).width;
  var marginLeft   = widestLabel + 14;
  var marginRight  = 12;
  var marginTop    = 14;
  var marginBottom = fontSize + 20;

  var plotW = W - marginLeft - marginRight;
  var plotH = H - marginTop  - marginBottom;

  if (plotW < 10 || plotH < 10) return;

  // Background
  ctx.fillStyle = colBg;
  ctx.fillRect(0, 0, W, H);

  function xOf(i) { return marginLeft + (i / (data.length - 1)) * plotW; }
  function yOf(v) { return marginTop  + plotH - ((v - yMin) / (yMax - yMin)) * plotH; }

  // Gridlines + Y labels
  ctx.font         = fontSize + 'px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'middle';

  for (var ti = 0; ti < yTicks.length; ti++) {
    var tick = yTicks[ti];
    var ty   = yOf(tick);
    ctx.strokeStyle = colGrid;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(marginLeft, ty);
    ctx.lineTo(marginLeft + plotW, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colAxis;
    ctx.fillText(fmtNumber(tick), marginLeft - 6, ty);
  }

  // X labels
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle    = colAxis;

  var xLabelCount = Math.min(data.length, Math.max(3, Math.floor(plotW / 65)));
  var xStep = Math.floor((data.length - 1) / (xLabelCount - 1));

  for (var li = 0; li < xLabelCount; li++) {
    var idx = Math.min(li * xStep, data.length - 1);
    var lx  = xOf(idx);
    var lbl = fmtDate(data[idx].date);
    ctx.fillText(lbl, lx, marginTop + plotH + 5);
  }

  // Area fill
  var grad = ctx.createLinearGradient(0, marginTop, 0, marginTop + plotH);
  grad.addColorStop(0, colFillStart);
  grad.addColorStop(1, colFillEnd);

  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(data[0].visitors));
  for (var i = 1; i < data.length; i++) {
    ctx.lineTo(xOf(i), yOf(data[i].visitors));
  }
  ctx.lineTo(xOf(data.length - 1), marginTop + plotH);
  ctx.lineTo(xOf(0), marginTop + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(data[0].visitors));
  for (var j = 1; j < data.length; j++) {
    ctx.lineTo(xOf(j), yOf(data[j].visitors));
  }
  ctx.strokeStyle = colLine;
  ctx.lineWidth   = 2.5;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.setLineDash([]);
  ctx.stroke();

  // Dots
  var dotR = Math.max(2, Math.min(4, plotW / data.length * 0.4));
  for (var k = 0; k < data.length; k++) {
    ctx.beginPath();
    ctx.arc(xOf(k), yOf(data[k].visitors), dotR, 0, Math.PI * 2);
    ctx.fillStyle   = colLine;
    ctx.fill();
    ctx.strokeStyle = colBg;
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }

  // Axis lines
  ctx.strokeStyle = colGrid;
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, marginTop + plotH);
  ctx.lineTo(marginLeft + plotW, marginTop + plotH);
  ctx.stroke();
}

// ── Resize observer ───────────────────────────────────────────────────────────

var resizeTimer;
var ro = new ResizeObserver(function() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(function() {
    applyLayout();
    if (lastTimeseriesData) drawChart(lastTimeseriesData);
  }, 60);
});
ro.observe($('main-content'));

// ── Render functions ──────────────────────────────────────────────────────────

function renderSummary(data) {
  ['card-visitors','card-revenue','card-best','card-trend'].forEach(function(id) {
    $(id).classList.remove('skeleton');
  });

  $('val-visitors').textContent = fmtNumber(data.total_visitors);
  $('sub-visitors').textContent = '30-day total';

  $('val-revenue').textContent  = fmtCurrency(data.total_revenue);
  $('sub-revenue').textContent  = '30-day total';

  $('val-best').textContent     = fmtNumber(data.best_day_visitors);
  $('sub-best').textContent     = data.best_day_date ? 'on ' + fmtDate(data.best_day_date) : '';

  var pct  = data.trend_pct;
  var sign = pct >= 0 ? '+' : '';
  $('val-trend').textContent = sign + pct + '%';
  $('val-trend').className   = 'stat-value ' + (pct >= 0 ? 'trend-positive' : 'trend-negative');
}

function renderCategories(data) {
  var list = $('categories-list');
  if (!data || data.length === 0) {
    list.innerHTML = '<div class="loading-msg">No data</div>';
    return;
  }
  var maxVal = Math.max.apply(null, data.map(function(d) { return d.value; }));
  list.innerHTML = data.map(function(cat) {
    var pct = maxVal > 0 ? (cat.value / maxVal) * 100 : 0;
    return '<div class="cat-row">' +
      '<div class="cat-header">' +
        '<span class="cat-name" title="' + escHtml(cat.name) + '">' + escHtml(cat.name) + '</span>' +
        '<span class="cat-value">' + fmtCurrency(cat.value) + '</span>' +
      '</div>' +
      '<div class="cat-bar-track">' +
        '<div class="cat-bar-fill" style="width:' + pct.toFixed(2) + '%"></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function renderRecent(data) {
  var tbody = $('recent-tbody');
  if (!data || data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="loading-msg">No data</td></tr>';
    return;
  }
  tbody.innerHTML = data.map(function(item) {
    return '<tr>' +
      '<td class="td-name" title="' + escHtml(item.name) + '">' + escHtml(item.name) + '</td>' +
      '<td class="td-category" title="' + escHtml(item.category) + '">' + escHtml(item.category) + '</td>' +
      '<td class="num-col">' + fmtCurrency(item.value) + '</td>' +
      '<td class="num-col">' + fmtDateShort(item.created_at) + '</td>' +
    '</tr>';
  }).join('');
}

function showError() {
  $('error-banner').hidden = false;
  ['card-visitors','card-revenue','card-best','card-trend'].forEach(function(id) {
    $(id).classList.remove('skeleton');
    $(id).querySelector('.stat-value').textContent = '\u2014';
  });
  $('categories-list').innerHTML = '<div class="loading-msg">Unavailable</div>';
  $('recent-tbody').innerHTML    = '<tr><td colspan="4" class="loading-msg">Unavailable</td></tr>';
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function init() {
  currentTheme = document.documentElement.getAttribute('data-theme') || 'light';

  // Apply layout immediately based on current container size
  applyLayout();

  Promise.all([
    apiFetch('/api/summary'),
    apiFetch('/api/timeseries'),
    apiFetch('/api/categories'),
    apiFetch('/api/recent'),
  ]).then(function(results) {
    var summary    = results[0];
    var timeseries = results[1];
    var categories = results[2];
    var recent     = results[3];

    renderSummary(summary);
    renderCategories(categories);
    renderRecent(recent);

    // Apply layout again after content is rendered, then draw chart
    applyLayout();
    requestAnimationFrame(function() {
      applyLayout();
      drawChart(timeseries);
    });
  }).catch(function(err) {
    console.error('Dashboard load failed:', err);
    showError();
  });
}

init();
