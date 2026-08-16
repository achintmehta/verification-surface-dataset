/**
 * Hand-drawn time-series line chart on a <canvas> element.
 *
 * Features:
 *  - Draws axes, gridlines, labeled ticks, and the data series.
 *  - Reads CSS custom properties for all colours so it respects the theme.
 *  - Re-renders on container resize via ResizeObserver.
 *  - Nothing is drawn outside the chart area (clip is applied).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a CSS custom property from the document root. */
function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** Format a date string (YYYY-MM-DD) to a short label like "Jan 1". */
function shortDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format a number with K/M suffix for axis labels. */
function fmtAxisNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}

/** Compute a "nice" step for axis ticks. */
function niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const candidates = [1, 2, 2.5, 5, 10].map((c) => c * mag);
  return candidates.find((c) => c >= rough) ?? candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// Chart state
// ---------------------------------------------------------------------------
let _canvas = null;
let _data   = [];
let _ro     = null;   // ResizeObserver

// ---------------------------------------------------------------------------
// Core draw function
// ---------------------------------------------------------------------------
function draw() {
  if (!_canvas || _data.length === 0) return;

  const container = _canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;

  // Sync canvas backing store to container size
  const W = container.clientWidth;
  const H = container.clientHeight;

  if (W <= 0 || H <= 0) return;

  _canvas.width  = Math.round(W * dpr);
  _canvas.height = Math.round(H * dpr);

  const ctx = _canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // --- Colours from CSS vars ---
  const colLine   = cssVar('--color-chart-line');
  const colFill   = cssVar('--color-chart-fill');
  const colGrid   = cssVar('--color-chart-grid');
  const colAxis   = cssVar('--color-chart-axis');
  const colLabel  = cssVar('--color-chart-label');
  const colDot    = cssVar('--color-chart-dot');
  const colDotBg  = cssVar('--color-chart-dot-bg');

  // --- Margins (leave room for axis labels) ---
  // Estimate Y-axis label width
  const values = _data.map((d) => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);

  const yStep = niceStep(maxVal - minVal || 1, 5);
  const yMin  = Math.floor(minVal / yStep) * yStep;
  const yMax  = Math.ceil(maxVal  / yStep) * yStep;

  // Measure widest Y label
  ctx.font = '11px system-ui, sans-serif';
  const widestYLabel = fmtAxisNum(yMax);
  const yLabelW = ctx.measureText(widestYLabel).width;

  const marginLeft   = Math.ceil(yLabelW) + 16;
  const marginRight  = 12;
  const marginTop    = 12;
  const marginBottom = 36; // room for X labels

  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop  - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  // --- Clear ---
  ctx.clearRect(0, 0, W, H);

  // --- Coordinate helpers ---
  const xScale = (i) => marginLeft + (i / (_data.length - 1)) * plotW;
  const yScale = (v) => marginTop  + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // --- Clip to plot area ---
  ctx.save();
  ctx.beginPath();
  ctx.rect(marginLeft, marginTop, plotW, plotH);
  ctx.clip();

  // --- Filled area under the line ---
  ctx.beginPath();
  _data.forEach((d, i) => {
    const x = xScale(i);
    const y = yScale(d.visitors);
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  });
  // Close path to bottom
  ctx.lineTo(xScale(_data.length - 1), marginTop + plotH);
  ctx.lineTo(xScale(0),                marginTop + plotH);
  ctx.closePath();
  ctx.fillStyle = colFill;
  ctx.fill();

  // --- Gridlines (horizontal) ---
  ctx.strokeStyle = colGrid;
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);

  for (let v = yMin; v <= yMax; v += yStep) {
    const y = yScale(v);
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + plotW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // --- Series line ---
  ctx.beginPath();
  _data.forEach((d, i) => {
    const x = xScale(i);
    const y = yScale(d.visitors);
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  });
  ctx.strokeStyle = colLine;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  ctx.restore(); // end clip

  // --- Y-axis labels ---
  ctx.font      = '11px system-ui, sans-serif';
  ctx.fillStyle = colLabel;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let v = yMin; v <= yMax; v += yStep) {
    const y = yScale(v);
    if (y < marginTop - 2 || y > marginTop + plotH + 2) continue;
    ctx.fillText(fmtAxisNum(v), marginLeft - 6, y);
  }

  // --- X-axis labels ---
  // Show ~6 evenly spaced labels; always include first and last
  const n = _data.length;
  const targetXTicks = Math.max(2, Math.min(6, Math.floor(plotW / 60)));
  const xTickStep = Math.max(1, Math.round((n - 1) / (targetXTicks - 1)));

  const xTickIndices = new Set();
  for (let i = 0; i < n; i += xTickStep) xTickIndices.add(i);
  xTickIndices.add(n - 1);

  ctx.font      = '11px system-ui, sans-serif';
  ctx.fillStyle = colLabel;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  xTickIndices.forEach((i) => {
    const x = xScale(i);
    const label = shortDate(_data[i].date);
    ctx.fillText(label, x, marginTop + plotH + 6);
  });

  // --- Axes (border lines) ---
  ctx.strokeStyle = colAxis;
  ctx.lineWidth   = 1;
  ctx.setLineDash([]);

  // Left axis
  ctx.beginPath();
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, marginTop + plotH);
  ctx.stroke();

  // Bottom axis
  ctx.beginPath();
  ctx.moveTo(marginLeft,          marginTop + plotH);
  ctx.lineTo(marginLeft + plotW,  marginTop + plotH);
  ctx.stroke();

  // --- Dots at data points (only if not too many) ---
  if (n <= 30) {
    _data.forEach((d, i) => {
      const x = xScale(i);
      const y = yScale(d.visitors);
      if (x < marginLeft || x > marginLeft + plotW) return;
      if (y < marginTop  || y > marginTop  + plotH) return;

      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle   = colDotBg;
      ctx.fill();
      ctx.strokeStyle = colDot;
      ctx.lineWidth   = 2;
      ctx.stroke();
    });
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the chart.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{date:string, visitors:number}>} data
 */
export function initChart(canvas, data) {
  _canvas = canvas;
  _data   = data;

  // Observe container size changes
  if (_ro) _ro.disconnect();
  _ro = new ResizeObserver(() => {
    // rAF to batch rapid resize events
    requestAnimationFrame(draw);
  });
  _ro.observe(canvas.parentElement);

  draw();
}

/**
 * Re-render the chart with new data (e.g. after theme change).
 */
export function redrawChart() {
  draw();
}
