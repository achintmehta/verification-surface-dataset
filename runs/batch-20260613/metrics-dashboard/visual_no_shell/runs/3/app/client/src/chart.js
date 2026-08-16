import { formatAxisDate, formatAxisNumber } from './format.js';

// ─── Theme color resolver ─────────────────────────────────────────────────────
function getThemeColors(theme) {
  const isDark = theme === 'dark';
  return {
    line:       isDark ? '#818cf8' : '#4f46e5',
    fill:       isDark ? 'rgba(129,140,248,0.12)' : 'rgba(79,70,229,0.08)',
    grid:       isDark ? '#2d3148' : '#e2e8f0',
    axis:       isDark ? '#6b7a9e' : '#94a3b8',
    label:      isDark ? '#a8b2d8' : '#4a5568',
    dot:        isDark ? '#818cf8' : '#4f46e5',
    dotStroke:  isDark ? '#1a1d27' : '#ffffff',
    bg:         isDark ? '#1a1d27' : '#ffffff',
  };
}

// ─── Canvas DPR helper ────────────────────────────────────────────────────────
function setupCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

// ─── Nice axis ticks ──────────────────────────────────────────────────────────
function niceScale(min, max, targetTicks = 5) {
  const range = max - min;
  if (range === 0) return { min: 0, max: max * 1.2 || 10, step: 2 };

  const roughStep = range / (targetTicks - 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;

  let niceStep;
  if (normalized <= 1) niceStep = 1;
  else if (normalized <= 2) niceStep = 2;
  else if (normalized <= 5) niceStep = 5;
  else niceStep = 10;

  niceStep *= magnitude;

  const niceMin = Math.floor(min / niceStep) * niceStep;
  const niceMax = Math.ceil(max / niceStep) * niceStep;

  return { min: niceMin, max: niceMax, step: niceStep };
}

// ─── Main draw function ───────────────────────────────────────────────────────
export function drawChart(data, theme) {
  const canvas = document.getElementById('timeseries-chart');
  if (!canvas) return;

  const container = document.getElementById('chart-container');
  if (!container) return;

  // Get actual rendered size
  const rect = container.getBoundingClientRect();
  const W = Math.max(rect.width, 200);
  const H = Math.max(rect.height, 150);

  const colors = getThemeColors(theme);

  // Margins — adapt to width
  const isNarrow = W < 400;
  const margin = {
    top:    16,
    right:  isNarrow ? 12 : 20,
    bottom: isNarrow ? 56 : 44,  // extra bottom for rotated labels on narrow
    left:   isNarrow ? 44 : 56,
  };

  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  const ctx = setupCanvas(canvas, W, H);

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Data
  const values = data.map(d => d.visitors);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const scale = niceScale(minVal * 0.9, maxVal * 1.05, 5);

  // Coordinate mappers
  const xOf = (i) => margin.left + (i / (data.length - 1)) * plotW;
  const yOf = (v) => margin.top + plotH - ((v - scale.min) / (scale.max - scale.min)) * plotH;

  // ── Gridlines & Y-axis ticks ──────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  const yTicks = [];
  for (let v = scale.min; v <= scale.max + scale.step * 0.01; v += scale.step) {
    yTicks.push(v);
  }

  yTicks.forEach(v => {
    const y = yOf(v);
    if (y < margin.top - 2 || y > margin.top + plotH + 2) return;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();
  });

  ctx.restore();

  // ── Y-axis labels ─────────────────────────────────────────────────────────
  ctx.save();
  ctx.fillStyle = colors.label;
  ctx.font = `${isNarrow ? 10 : 11}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  yTicks.forEach(v => {
    const y = yOf(v);
    if (y < margin.top - 2 || y > margin.top + plotH + 2) return;
    ctx.fillText(formatAxisNumber(v), margin.left - 6, y);
  });

  ctx.restore();

  // ── X-axis ticks & labels ─────────────────────────────────────────────────
  // Choose how many x labels to show based on width
  // Estimate label width to avoid overlap
  const fontSize = isNarrow ? 9 : 11;
  const approxLabelW = isNarrow ? 40 : 56; // "May 17" ~ 56px at 11px font
  const maxXLabels = Math.max(2, Math.floor(plotW / (approxLabelW + 8)));
  const xStep = Math.max(1, Math.floor((data.length - 1) / (maxXLabels - 1)));

  // Build the set of indices to label, always including first and last
  const labelIndices = new Set();
  for (let i = 0; i < data.length; i += xStep) {
    labelIndices.add(i);
  }
  labelIndices.add(data.length - 1);

  // Remove last if it would overlap second-to-last
  const sortedIndices = [...labelIndices].sort((a, b) => a - b);
  if (sortedIndices.length >= 2) {
    const last = sortedIndices[sortedIndices.length - 1];
    const prev = sortedIndices[sortedIndices.length - 2];
    const xLast = xOf(last);
    const xPrev = xOf(prev);
    if (xLast - xPrev < approxLabelW + 4) {
      labelIndices.delete(last);
    }
  }

  ctx.save();
  ctx.fillStyle = colors.label;
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (const i of labelIndices) {
    const x = xOf(i);
    const label = formatAxisDate(data[i].date);

    // Tick mark
    ctx.save();
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, margin.top + plotH);
    ctx.lineTo(x, margin.top + plotH + 4);
    ctx.stroke();
    ctx.restore();

    // Label — rotate on narrow screens
    if (isNarrow) {
      ctx.save();
      ctx.translate(x, margin.top + plotH + 8);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(label, x, margin.top + plotH + 6);
    }
  }

  ctx.restore();

  // ── Axes ──────────────────────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);

  // Y axis
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotH);
  ctx.stroke();

  // X axis
  ctx.beginPath();
  ctx.moveTo(margin.left, margin.top + plotH);
  ctx.lineTo(margin.left + plotW, margin.top + plotH);
  ctx.stroke();

  ctx.restore();

  // ── Area fill ─────────────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(data[0].visitors));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(xOf(i), yOf(data[i].visitors));
  }
  ctx.lineTo(xOf(data.length - 1), margin.top + plotH);
  ctx.lineTo(xOf(0), margin.top + plotH);
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();
  ctx.restore();

  // ── Line ──────────────────────────────────────────────────────────────────
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(data[0].visitors));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(xOf(i), yOf(data[i].visitors));
  }
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.restore();

  // ── Data dots (only on wider screens to avoid clutter) ────────────────────
  if (!isNarrow) {
    const dotRadius = 3;
    data.forEach((d, i) => {
      const x = xOf(i);
      const y = yOf(d.visitors);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = colors.dotStroke;
      ctx.fill();
      ctx.strokeStyle = colors.dot;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
    });
  }

  // ── Clip region indicator (subtle border around plot area) ────────────────
  // (optional visual polish — skip to keep it clean)
}

// ─── Redraw (called on resize / theme change) ─────────────────────────────────
export function redrawChart(data, theme) {
  // Use rAF to batch redraws
  requestAnimationFrame(() => drawChart(data, theme));
}
