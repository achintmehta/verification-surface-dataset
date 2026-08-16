/**
 * Hand-drawn time-series line chart using Canvas 2D.
 *
 * Renders two series (visitors, revenue) with:
 *  - Labelled Y-axes (visitors left, revenue right)
 *  - Horizontal gridlines
 *  - X-axis date ticks (evenly spaced, never overlapping)
 *  - Smooth polyline for each series
 *  - Gradient fill under each line
 *  - Fully redraws to fit its container on every call
 *  - Reads CSS custom properties for colours so it respects the theme
 */

import { formatAxisValue, formatShortDate } from './format.js';

// ── Colour helpers ────────────────────────────────────────────────────────
function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getChartColors() {
  return {
    visitors:  getCSSVar('--chart-visitors')  || '#4f6ef7',
    revenue:   getCSSVar('--chart-revenue')   || '#f59e0b',
    grid:      getCSSVar('--chart-grid')      || '#e2e6ea',
    axisText:  getCSSVar('--chart-axis-text') || '#8a93a0',
    bg:        getCSSVar('--chart-bg')        || '#ffffff',
  };
}

// ── Nice axis scale ───────────────────────────────────────────────────────
function niceScale(min, max, targetTicks = 5) {
  if (min === max) { min = 0; max = max || 1; }
  const range = max - min;
  const rawStep = range / (targetTicks - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const niceStep = [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((s) => s >= rawStep) || rawStep;
  const niceMin = Math.floor(min / niceStep) * niceStep;
  const niceMax = Math.ceil(max / niceStep) * niceStep;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + niceStep * 0.001; v += niceStep) {
    ticks.push(Math.round(v * 1e9) / 1e9); // floating-point cleanup
  }
  return { min: niceMin, max: niceMax, ticks };
}

// ── Main render function ──────────────────────────────────────────────────
export function renderChart(container, data, _theme) {
  if (!container || !data || data.length === 0) return;

  // Get or create canvas
  let canvas = container.querySelector('canvas');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'timeseries-chart';
    canvas.setAttribute('aria-label', '30-day visitors and revenue line chart');
    container.appendChild(canvas);
  }

  const colors = getChartColors();

  // ── Size the canvas to its container (device-pixel-ratio aware) ──────────
  const dpr    = window.devicePixelRatio || 1;
  const W      = container.clientWidth;
  const H      = container.clientHeight;

  if (W === 0 || H === 0) return; // not yet laid out

  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width  = `${W}px`;
  canvas.style.height = `${H}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // ── Clear ─────────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── Margins — generous enough for axis labels ─────────────────────────────
  // Left margin: visitors Y-axis labels
  // Right margin: revenue Y-axis labels
  // Bottom margin: X-axis date labels
  // Top margin: breathing room
  const fontSize   = Math.max(9, Math.min(11, W / 55));
  const marginLeft  = Math.round(fontSize * 5.5);
  const marginRight = Math.round(fontSize * 5.5);
  const marginTop   = 12;
  const marginBot   = Math.round(fontSize * 3.2);

  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop - marginBot;

  if (plotW <= 0 || plotH <= 0) return;

  // ── Data extraction ───────────────────────────────────────────────────────
  const visitors = data.map((d) => Number(d.visitors));
  const revenues = data.map((d) => Number(d.revenue));
  const dates    = data.map((d) => d.date);
  const n        = data.length;

  // ── Scales ────────────────────────────────────────────────────────────────
  const vScale = niceScale(0, Math.max(...visitors), 5);
  const rScale = niceScale(0, Math.max(...revenues), 5);

  function xPos(i) {
    return marginLeft + (i / (n - 1)) * plotW;
  }
  function yPosV(v) {
    return marginTop + plotH - ((v - vScale.min) / (vScale.max - vScale.min)) * plotH;
  }
  function yPosR(v) {
    return marginTop + plotH - ((v - rScale.min) / (rScale.max - rScale.min)) * plotH;
  }

  // ── Background ────────────────────────────────────────────────────────────
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, W, H);

  // ── Gridlines (horizontal, based on visitors scale) ───────────────────────
  ctx.save();
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth   = 1;
  ctx.setLineDash([3, 4]);
  for (const tick of vScale.ticks) {
    const y = yPosV(tick);
    if (y < marginTop - 1 || y > marginTop + plotH + 1) continue;
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + plotW, y);
    ctx.stroke();
  }
  ctx.restore();

  // ── Y-axis labels — visitors (left) ──────────────────────────────────────
  ctx.save();
  ctx.font      = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.fillStyle = colors.axisText;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of vScale.ticks) {
    const y = yPosV(tick);
    if (y < marginTop - 4 || y > marginTop + plotH + 4) continue;
    ctx.fillText(formatAxisValue(tick), marginLeft - 6, y);
  }
  ctx.restore();

  // ── Y-axis labels — revenue (right) ──────────────────────────────────────
  ctx.save();
  ctx.font      = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.fillStyle = colors.axisText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const tick of rScale.ticks) {
    const y = yPosR(tick);
    if (y < marginTop - 4 || y > marginTop + plotH + 4) continue;
    ctx.fillText('$' + formatAxisValue(tick), marginLeft + plotW + 6, y);
  }
  ctx.restore();

  // ── X-axis ticks ──────────────────────────────────────────────────────────
  // Determine how many ticks fit without overlapping
  const tickLabelWidth = fontSize * 5.5; // approximate width of "Jan 15"
  const maxTicks = Math.max(2, Math.floor(plotW / (tickLabelWidth + 8)));
  const step = Math.ceil((n - 1) / (maxTicks - 1));
  const tickIndices = [];
  for (let i = 0; i < n; i += step) tickIndices.push(i);
  if (tickIndices[tickIndices.length - 1] !== n - 1) tickIndices.push(n - 1);

  ctx.save();
  ctx.font      = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.fillStyle = colors.axisText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xAxisY = marginTop + plotH + 5;
  for (const i of tickIndices) {
    const x = xPos(i);
    ctx.fillText(formatShortDate(dates[i]), x, xAxisY);
  }
  ctx.restore();

  // ── Axis lines ────────────────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth   = 1;
  // Bottom axis
  ctx.beginPath();
  ctx.moveTo(marginLeft, marginTop + plotH);
  ctx.lineTo(marginLeft + plotW, marginTop + plotH);
  ctx.stroke();
  // Left axis
  ctx.beginPath();
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, marginTop + plotH);
  ctx.stroke();
  ctx.restore();

  // ── Draw a series (fill + line) ───────────────────────────────────────────
  function drawSeries(values, yPosFn, color) {
    if (values.length < 2) return;

    // Gradient fill — use rgba() so it works regardless of color format
    const grad = ctx.createLinearGradient(0, marginTop, 0, marginTop + plotH);
    // Parse the color into an rgba string for the gradient stops
    // We draw a tiny off-screen rect to sample the computed color
    ctx.save();
    ctx.fillStyle = color;
    const parsedColor = ctx.fillStyle; // browser normalises to rgb(...)
    ctx.restore();
    // Convert "rgb(r, g, b)" → "rgba(r, g, b, a)"
    const rgbaHigh = parsedColor.replace('rgb(', 'rgba(').replace(')', ', 0.18)');
    const rgbaLow  = parsedColor.replace('rgb(', 'rgba(').replace(')', ', 0)');
    grad.addColorStop(0, rgbaHigh);
    grad.addColorStop(1, rgbaLow);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xPos(0), yPosFn(values[0]));
    for (let i = 1; i < values.length; i++) {
      ctx.lineTo(xPos(i), yPosFn(values[i]));
    }
    // Close path down to the axis
    ctx.lineTo(xPos(values.length - 1), marginTop + plotH);
    ctx.lineTo(xPos(0), marginTop + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();

    // Line
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xPos(0), yPosFn(values[0]));
    for (let i = 1; i < values.length; i++) {
      ctx.lineTo(xPos(i), yPosFn(values[i]));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.restore();
  }

  // Draw revenue first (behind visitors)
  drawSeries(revenues, yPosR, colors.revenue);
  drawSeries(visitors, yPosV, colors.visitors);

  // ── Dot on last data point ────────────────────────────────────────────────
  function drawEndDot(values, yPosFn, color) {
    const i = values.length - 1;
    const x = xPos(i);
    const y = yPosFn(values[i]);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = colors.bg;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  drawEndDot(revenues, yPosR, colors.revenue);
  drawEndDot(visitors, yPosV, colors.visitors);
}

export function destroyChart(container) {
  const canvas = container?.querySelector('canvas');
  if (canvas) canvas.remove();
}
