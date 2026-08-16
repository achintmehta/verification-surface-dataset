/**
 * Hand-drawn time-series line chart on a <canvas> element.
 * Redraws to fit its container on every call to draw() or resize.
 */

let _canvas = null;
let _data = [];
let _resizeObserver = null;

/**
 * Initialise the chart with a canvas element and attach a ResizeObserver.
 * @param {HTMLCanvasElement} canvas
 */
export function initChart(canvas) {
  _canvas = canvas;

  if (_resizeObserver) {
    _resizeObserver.disconnect();
  }

  _resizeObserver = new ResizeObserver(() => {
    if (_data.length > 0) {
      draw(_data);
    }
  });

  _resizeObserver.observe(canvas.parentElement);
}

/**
 * Draw (or redraw) the chart with the given data.
 * @param {Array<{date: string, visitors: number, revenue: number}>} data
 */
export function draw(data) {
  if (!_canvas) return;
  _data = data;

  const container = _canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;

  // Size the canvas to its CSS container
  const cssW = container.clientWidth;
  const cssH = container.clientHeight;

  if (cssW === 0 || cssH === 0) return;

  _canvas.width  = Math.round(cssW * dpr);
  _canvas.height = Math.round(cssH * dpr);
  _canvas.style.width  = cssW + 'px';
  _canvas.style.height = cssH + 'px';

  const ctx = _canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // ── Read CSS custom properties for theme-aware colours ──────────────────
  const style = getComputedStyle(document.body);
  const colors = {
    bg:      style.getPropertyValue('--chart-bg').trim()      || '#ffffff',
    grid:    style.getPropertyValue('--chart-grid').trim()    || '#e2e8f0',
    axis:    style.getPropertyValue('--chart-axis').trim()    || '#94a3b8',
    line:    style.getPropertyValue('--chart-line').trim()    || '#3b82f6',
    fillA:   style.getPropertyValue('--chart-fill-a').trim()  || 'rgba(59,130,246,0.18)',
    fillB:   style.getPropertyValue('--chart-fill-b').trim()  || 'rgba(59,130,246,0)',
    dot:     style.getPropertyValue('--chart-dot').trim()     || '#3b82f6',
    dotBg:   style.getPropertyValue('--chart-dot-bg').trim()  || '#ffffff',
    label:   style.getPropertyValue('--chart-label').trim()   || '#64748b',
  };

  // ── Layout margins ───────────────────────────────────────────────────────
  // Adaptive margins based on canvas width
  const isNarrow = cssW < 400;
  const margin = {
    top:    isNarrow ? 12 : 16,
    right:  isNarrow ? 10 : 16,
    bottom: isNarrow ? 40 : 48,
    left:   isNarrow ? 46 : 58,
  };

  const plotW = cssW - margin.left - margin.right;
  const plotH = cssH - margin.top  - margin.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  // ── Clear ────────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // ── Data range ───────────────────────────────────────────────────────────
  const values = data.map((d) => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);

  // Nice round Y axis range
  const rawRange = maxVal - minVal || 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawRange)));
  const step = niceStep(rawRange / 5, magnitude);
  const yMin = Math.floor(minVal / step) * step;
  const yMax = Math.ceil(maxVal  / step) * step;
  const yRange = yMax - yMin || 1;

  // ── Helpers ──────────────────────────────────────────────────────────────
  const xOf = (i) => margin.left + (i / (data.length - 1)) * plotW;
  const yOf = (v) => margin.top  + (1 - (v - yMin) / yRange) * plotH;

  // ── Gridlines & Y-axis labels ────────────────────────────────────────────
  const yTicks = buildYTicks(yMin, yMax, step);
  const fontSize = isNarrow ? 9 : 11;

  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  yTicks.forEach((tick) => {
    const y = yOf(tick);
    // Gridline
    ctx.beginPath();
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = colors.label;
    ctx.fillText(formatK(tick), margin.left - 6, y);
  });

  // ── X-axis labels ────────────────────────────────────────────────────────
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = colors.label;

  // Decide how many x labels to show based on width
  const maxXLabels = isNarrow ? 5 : Math.min(data.length, Math.floor(plotW / 40));
  const xLabelStep = Math.max(1, Math.ceil(data.length / maxXLabels));

  data.forEach((d, i) => {
    if (i % xLabelStep !== 0 && i !== data.length - 1) return;
    const x = xOf(i);
    const label = formatDate(d.date);
    ctx.fillText(label, x, margin.top + plotH + 6);
  });

  // ── Axes ─────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1.5;
  // Y axis
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotH);
  // X axis
  ctx.lineTo(margin.left + plotW, margin.top + plotH);
  ctx.stroke();

  // ── Area fill ────────────────────────────────────────────────────────────
  const gradient = ctx.createLinearGradient(0, margin.top, 0, margin.top + plotH);
  gradient.addColorStop(0, colors.fillA);
  gradient.addColorStop(1, colors.fillB);

  ctx.beginPath();
  data.forEach((d, i) => {
    const x = xOf(i);
    const y = yOf(d.visitors);
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  });
  // Close path to bottom
  ctx.lineTo(xOf(data.length - 1), margin.top + plotH);
  ctx.lineTo(xOf(0), margin.top + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  // ── Line ─────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  data.forEach((d, i) => {
    const x = xOf(i);
    const y = yOf(d.visitors);
    if (i === 0) ctx.moveTo(x, y);
    else         ctx.lineTo(x, y);
  });
  ctx.stroke();

  // ── Dots (only on wider charts to avoid clutter) ─────────────────────────
  if (!isNarrow && data.length <= 35) {
    const dotR = 3;
    data.forEach((d, i) => {
      const x = xOf(i);
      const y = yOf(d.visitors);
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = colors.dotBg;
      ctx.fill();
      ctx.strokeStyle = colors.dot;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function niceStep(roughStep, magnitude) {
  const normalized = roughStep / magnitude;
  if (normalized < 1.5) return magnitude;
  if (normalized < 3.5) return 2 * magnitude;
  if (normalized < 7.5) return 5 * magnitude;
  return 10 * magnitude;
}

function buildYTicks(yMin, yMax, step) {
  const ticks = [];
  let t = yMin;
  while (t <= yMax + step * 0.01) {
    ticks.push(t);
    t += step;
  }
  return ticks;
}

function formatK(n) {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function formatDate(dateStr) {
  // dateStr: "2024-01-15" or similar
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
