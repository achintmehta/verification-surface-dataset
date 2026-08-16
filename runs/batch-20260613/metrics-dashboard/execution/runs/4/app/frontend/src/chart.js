/**
 * Hand-drawn time-series line chart using Canvas 2D.
 * Redraws to fit its container on every call.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getThemeColors() {
  return {
    line:    getCSSVar('--chart-line')    || '#3b82f6',
    fill:    getCSSVar('--chart-fill')    || 'rgba(59,130,246,0.12)',
    grid:    getCSSVar('--chart-grid')    || '#e2e8f0',
    axis:    getCSSVar('--chart-axis')    || '#94a3b8',
    dot:     getCSSVar('--chart-dot')     || '#2563eb',
    dotBg:   getCSSVar('--chart-dot-bg') || '#ffffff',
    text:    getCSSVar('--text-secondary') || '#475569',
    bg:      getCSSVar('--bg-card')       || '#ffffff',
  };
}

function niceMax(value) {
  if (value === 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  return Math.ceil(value / magnitude) * magnitude;
}

function formatAxisValue(v) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

function formatAxisDate(dateStr) {
  // dateStr may be "YYYY-MM-DD" or a full ISO string like "2024-01-15T00:00:00.000Z"
  const s = String(dateStr);
  // If it already has a T, parse as-is; otherwise append local midnight
  const d = s.includes('T') ? new Date(s) : new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Main render function ─────────────────────────────────────────────────────

export function renderChart(canvasId, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;

  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;

  // Size canvas to container
  const W = container.clientWidth;
  const H = container.clientHeight;

  if (W === 0 || H === 0) return;

  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const colors = getThemeColors();

  // ── Margins ────────────────────────────────────────────────────────────────
  // Adaptive margins based on available width
  const isNarrow = W < 400;
  const margin = {
    top:    16,
    right:  isNarrow ? 8 : 16,
    bottom: isNarrow ? 48 : 44,
    left:   isNarrow ? 48 : 60,
  };

  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top  - margin.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  // ── Clear ──────────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── Data ───────────────────────────────────────────────────────────────────
  if (!data || data.length === 0) {
    ctx.fillStyle = colors.text;
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No data', W / 2, H / 2);
    return;
  }

  const revenues = data.map(d => parseFloat(d.revenue));
  const maxRev   = Math.max(...revenues);
  const yMax     = niceMax(maxRev * 1.05);
  const yMin     = 0;

  const n = data.length;

  // ── Scale functions ────────────────────────────────────────────────────────
  function xScale(i) {
    return margin.left + (i / (n - 1)) * plotW;
  }
  function yScale(v) {
    return margin.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  }

  // ── Y gridlines & labels ───────────────────────────────────────────────────
  const yTicks = 5;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = `${isNarrow ? 9 : 11}px -apple-system, sans-serif`;

  for (let t = 0; t <= yTicks; t++) {
    const v = yMin + (t / yTicks) * (yMax - yMin);
    const y = yScale(v);

    // Gridline
    ctx.beginPath();
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = colors.text;
    ctx.fillText(formatAxisValue(v), margin.left - 6, y);
  }

  // ── X axis labels ──────────────────────────────────────────────────────────
  // Show a subset of date labels to avoid crowding
  const maxXLabels = isNarrow ? 4 : Math.min(8, n);
  const xStep = Math.max(1, Math.floor((n - 1) / (maxXLabels - 1)));

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `${isNarrow ? 9 : 11}px -apple-system, sans-serif`;
  ctx.fillStyle = colors.text;

  for (let i = 0; i < n; i += xStep) {
    const x = xScale(i);
    const label = formatAxisDate(data[i].date);

    // Tick mark
    ctx.beginPath();
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1;
    ctx.moveTo(x, margin.top + plotH);
    ctx.lineTo(x, margin.top + plotH + 4);
    ctx.stroke();

    // Label — rotate on narrow screens to prevent overlap
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
  // Always include the last label
  const lastIdx = n - 1;
  if (lastIdx % xStep !== 0) {
    const x = xScale(lastIdx);
    const label = formatAxisDate(data[lastIdx].date);
    ctx.beginPath();
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1;
    ctx.moveTo(x, margin.top + plotH);
    ctx.lineTo(x, margin.top + plotH + 4);
    ctx.stroke();
    if (isNarrow) {
      ctx.save();
      ctx.translate(x, margin.top + plotH + 8);
      ctx.rotate(-Math.PI / 4);
      ctx.textAlign = 'right';
      ctx.fillText(label, 0, 0);
      ctx.restore();
    } else {
      ctx.textAlign = 'center';
      ctx.fillText(label, x, margin.top + plotH + 6);
    }
  }

  // ── Axes ───────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = colors.axis;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  // Y axis
  ctx.moveTo(margin.left, margin.top);
  ctx.lineTo(margin.left, margin.top + plotH);
  // X axis
  ctx.lineTo(margin.left + plotW, margin.top + plotH);
  ctx.stroke();

  // ── Area fill ──────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(xScale(0), yScale(revenues[0]));
  for (let i = 1; i < n; i++) {
    ctx.lineTo(xScale(i), yScale(revenues[i]));
  }
  ctx.lineTo(xScale(n - 1), margin.top + plotH);
  ctx.lineTo(xScale(0),     margin.top + plotH);
  ctx.closePath();
  ctx.fillStyle = colors.fill;
  ctx.fill();

  // ── Line ───────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap  = 'round';
  ctx.setLineDash([]);
  ctx.moveTo(xScale(0), yScale(revenues[0]));
  for (let i = 1; i < n; i++) {
    ctx.lineTo(xScale(i), yScale(revenues[i]));
  }
  ctx.stroke();

  // ── Dots ───────────────────────────────────────────────────────────────────
  // Only draw dots if there's enough space (not too many points)
  const dotRadius = isNarrow ? 2.5 : 3.5;
  const drawDots  = n <= 35; // always true for 30-day data

  if (drawDots) {
    for (let i = 0; i < n; i++) {
      const x = xScale(i);
      const y = yScale(revenues[i]);
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = colors.dotBg;
      ctx.fill();
      ctx.strokeStyle = colors.dot;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }
}

export function destroyChart(canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}
