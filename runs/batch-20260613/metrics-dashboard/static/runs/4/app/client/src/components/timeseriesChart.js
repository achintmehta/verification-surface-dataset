/**
 * Hand-drawn time-series line chart using Canvas 2D.
 *
 * Design goals:
 *  - Redraws on every ResizeObserver tick so it always fits its container.
 *  - Reads CSS custom properties for colours so it respects the theme.
 *  - Draws axes, gridlines, tick labels, and the filled area series.
 *  - Nothing is drawn outside the chart area (clip region enforced).
 */

/** @type {ResizeObserver|null} */
let resizeObserver = null;

/** @type {Array<{date:string, visitors:number, revenue:number}>} */
let chartData = [];

/** @type {HTMLCanvasElement|null} */
let canvas = null;

/** @type {CanvasRenderingContext2D|null} */
let ctx = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/**
 * Compute a "nice" step for axis ticks.
 * @param {number} range
 * @param {number} targetTicks
 */
function niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  let nice;
  if (norm < 1.5) nice = 1;
  else if (norm < 3)   nice = 2;
  else if (norm < 7)   nice = 5;
  else                 nice = 10;
  return nice * mag;
}

function niceRange(min, max, targetTicks) {
  const step = niceStep(max - min || 1, targetTicks);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  return { niceMin, niceMax, step };
}

function formatAxisLabel(value) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1) + 'M';
  if (value >= 1_000)     return (value / 1_000).toFixed(0) + 'k';
  return String(value);
}

function formatDateLabel(isoDate) {
  // isoDate: "2024-01-15"
  const d = new Date(isoDate + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Draw ─────────────────────────────────────────────────────────────────────

function draw() {
  if (!canvas || !ctx || chartData.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight;

  if (cssW === 0 || cssH === 0) return;

  const physW = Math.round(cssW * dpr);
  const physH = Math.round(cssH * dpr);

  // Resize backing store — this resets the transform, so we always re-scale
  if (canvas.width !== physW || canvas.height !== physH) {
    canvas.width  = physW;
    canvas.height = physH;
  }

  // Always reset transform and apply DPR scale (setting width/height resets it)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const H = cssH;

  // ── Colours from CSS vars ──────────────────────────────────────────────────
  const colLine  = getCssVar('--color-chart-line');
  const colFill  = getCssVar('--color-chart-fill');
  const colGrid  = getCssVar('--color-chart-grid');
  const colAxis  = getCssVar('--color-chart-axis');

  // ── Margins — enough room for axis labels ──────────────────────────────────
  const fontSize = Math.max(10, Math.min(12, W * 0.025));
  const fontStack = 'system-ui, -apple-system, sans-serif';
  ctx.font = `${fontSize}px ${fontStack}`;

  // Measure widest Y-axis label to set left margin
  const values = chartData.map(d => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const { niceMin, niceMax, step } = niceRange(minVal, maxVal, 5);

  const sampleLabel = formatAxisLabel(niceMax);
  const labelW = ctx.measureText(sampleLabel).width;

  const marginLeft   = Math.ceil(labelW + 12);
  const marginRight  = 12;
  const marginTop    = 12;
  // Bottom margin: enough for rotated date labels
  const marginBottom = Math.max(36, fontSize * 3.2);

  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  // ── Clear ──────────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  const xScale = i => marginLeft + (i / (chartData.length - 1)) * plotW;
  const yScale = v => marginTop + plotH - ((v - niceMin) / (niceMax - niceMin)) * plotH;

  // ── Gridlines & Y-axis ticks ───────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = colGrid;
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 3]);
  ctx.font = `${fontSize}px ${fontStack}`;
  ctx.fillStyle   = colAxis;
  ctx.textAlign   = 'right';
  ctx.textBaseline = 'middle';

  for (let v = niceMin; v <= niceMax + step * 0.01; v += step) {
    const y = yScale(v);
    if (y < marginTop - 1 || y > marginTop + plotH + 1) continue;
    // Gridline
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + plotW, y);
    ctx.stroke();
    // Label
    ctx.fillText(formatAxisLabel(v), marginLeft - 6, y);
  }
  ctx.setLineDash([]);
  ctx.restore();

  // ── X-axis ticks ───────────────────────────────────────────────────────────
  // Choose tick density based on available width
  const maxXTicks = Math.max(3, Math.floor(plotW / 60));
  const xTickStep = Math.max(1, Math.ceil((chartData.length - 1) / (maxXTicks - 1)));

  ctx.save();
  ctx.font = `${fontSize}px ${fontStack}`;
  ctx.fillStyle   = colAxis;
  ctx.textAlign   = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i < chartData.length; i += xTickStep) {
    const x = xScale(i);
    const label = formatDateLabel(chartData[i].date);

    // Tick mark
    ctx.strokeStyle = colGrid;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, marginTop + plotH);
    ctx.lineTo(x, marginTop + plotH + 4);
    ctx.stroke();

    // Rotated label
    ctx.save();
    ctx.translate(x, marginTop + plotH + 6);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = colAxis;
    ctx.textAlign = 'right';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
  ctx.restore();

  // ── Axis lines ─────────────────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = colAxis;
  ctx.lineWidth   = 1.5;
  ctx.beginPath();
  // Y axis
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, marginTop + plotH);
  // X axis
  ctx.lineTo(marginLeft + plotW, marginTop + plotH);
  ctx.stroke();
  ctx.restore();

  // ── Clip to plot area ──────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(marginLeft, marginTop, plotW, plotH);
  ctx.clip();

  // ── Filled area ───────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(xScale(0), yScale(chartData[0].visitors));
  for (let i = 1; i < chartData.length; i++) {
    ctx.lineTo(xScale(i), yScale(chartData[i].visitors));
  }
  // Close path down to x-axis
  ctx.lineTo(xScale(chartData.length - 1), marginTop + plotH);
  ctx.lineTo(xScale(0), marginTop + plotH);
  ctx.closePath();
  ctx.fillStyle = colFill;
  ctx.fill();

  // ── Line ──────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(xScale(0), yScale(chartData[0].visitors));
  for (let i = 1; i < chartData.length; i++) {
    ctx.lineTo(xScale(i), yScale(chartData[i].visitors));
  }
  ctx.strokeStyle = colLine;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // ── Data point dots ────────────────────────────────────────────────────────
  const dotRadius = Math.max(2, Math.min(4, plotW / chartData.length / 2));
  ctx.fillStyle = colLine;
  for (let i = 0; i < chartData.length; i++) {
    ctx.beginPath();
    ctx.arc(xScale(i), yScale(chartData[i].visitors), dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore(); // end clip
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initialise the chart with data. Call once after data is loaded.
 * @param {Array<{date:string, visitors:number}>} data
 */
export function initTimeseriesChart(data) {
  chartData = data;
  canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('timeseries-canvas'));
  if (!canvas) return;
  ctx = canvas.getContext('2d');

  // Disconnect any previous observer
  if (resizeObserver) resizeObserver.disconnect();

  resizeObserver = new ResizeObserver(() => {
    // draw() will detect the size change and resize the backing store
    requestAnimationFrame(draw);
  });

  const container = document.getElementById('timeseries-container');
  if (container) resizeObserver.observe(container);

  draw();
}

/**
 * Re-draw the chart (e.g. after a theme change).
 * Forces a full redraw by invalidating the cached dimensions.
 */
export function redrawTimeseriesChart() {
  if (canvas) {
    // Force dimension recalculation on next draw
    canvas.width  = 0;
    canvas.height = 0;
  }
  // Use rAF to ensure the DOM has settled after theme change
  requestAnimationFrame(draw);
}
