/**
 * Hand-drawn canvas time-series chart.
 * Draws a 30-day revenue line chart with axes, gridlines, and labeled ticks.
 * Redraws to fit its container on every call.
 */

// ── Colour palettes ───────────────────────────────────────────────────────────

const PALETTES = {
  light: {
    bg:       '#ffffff',
    line:     '#3b82f6',
    fill:     'rgba(59,130,246,0.10)',
    grid:     '#e2e6ea',
    axis:     '#6b7280',
    label:    '#374151',
    dot:      '#3b82f6',
    dotBg:    '#ffffff',
  },
  dark: {
    bg:       '#1a1d27',
    line:     '#60a5fa',
    fill:     'rgba(96,165,250,0.10)',
    grid:     '#2d3148',
    axis:     '#8b92a8',
    label:    '#c9cfe0',
    dot:      '#60a5fa',
    dotBg:    '#1a1d27',
  },
};

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtK(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtAxisDate(dateStr) {
  // dateStr is "YYYY-MM-DD"
  const [, m, d] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// ── Nice axis scale ───────────────────────────────────────────────────────────

function niceScale(min, max, targetTicks = 5) {
  const range = max - min || 1;
  const rough = range / targetTicks;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const nice  = [1, 2, 2.5, 5, 10].find(f => f * mag >= rough) * mag;
  const lo    = Math.floor(min / nice) * nice;
  const hi    = Math.ceil(max  / nice) * nice;
  const ticks = [];
  for (let v = lo; v <= hi + nice * 0.01; v += nice) ticks.push(Math.round(v));
  return { lo, hi, ticks };
}

// ── Main draw function ────────────────────────────────────────────────────────

export function drawChart(data, theme = 'light') {
  const canvas = document.getElementById('timeseries-chart');
  if (!canvas) return;

  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;

  // Physical pixel dimensions
  const W = container.clientWidth;
  const H = container.clientHeight;

  if (W === 0 || H === 0) return;

  // Set canvas resolution
  canvas.width  = W * dpr;
  canvas.height = H * dpr;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pal = PALETTES[theme] || PALETTES.light;

  // ── Margins ────────────────────────────────────────────────────────────────
  // Compute Y-axis label width dynamically
  const revenues = data.map(d => parseFloat(d.revenue));
  const { lo, hi, ticks: yTicks } = niceScale(
    Math.min(...revenues),
    Math.max(...revenues),
    Math.max(3, Math.floor(H / 60))
  );

  ctx.font = `${Math.max(9, Math.min(11, W / 60))}px system-ui, sans-serif`;
  const yLabelWidth = Math.max(...yTicks.map(t => ctx.measureText(fmtK(t)).width)) + 8;

  // Estimate right margin needed for last X-axis label
  const lastDateLabel = data.length > 0 ? fmtAxisDate(data[data.length - 1].date) : '';
  const lastLabelHalfW = ctx.measureText(lastDateLabel).width / 2 + 4;

  const marginLeft   = Math.ceil(yLabelWidth) + 4;
  const marginRight  = Math.max(16, Math.ceil(lastLabelHalfW));
  const marginTop    = 16;
  const marginBottom = Math.max(28, Math.min(40, H * 0.18));

  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop  - marginBottom;

  if (plotW <= 0 || plotH <= 0) return;

  // ── Clear ──────────────────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);

  // ── Coordinate helpers ─────────────────────────────────────────────────────
  const n = data.length;
  const xOf = i => marginLeft + (i / (n - 1)) * plotW;
  const yOf = v => marginTop + plotH - ((v - lo) / (hi - lo)) * plotH;

  // ── Gridlines + Y-axis labels ──────────────────────────────────────────────
  const fontSize = Math.max(9, Math.min(11, W / 60));
  ctx.font = `${fontSize}px system-ui, sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  yTicks.forEach(tick => {
    const y = yOf(tick);
    if (y < marginTop - 2 || y > marginTop + plotH + 2) return;

    // Gridline
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(marginLeft, y);
    ctx.lineTo(marginLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = pal.axis;
    ctx.fillText(fmtK(tick), marginLeft - 6, y);
  });

  // ── X-axis ticks ──────────────────────────────────────────────────────────
  // Choose tick density based on available width
  const maxXTicks = Math.max(3, Math.floor(plotW / 55));
  const step = Math.ceil((n - 1) / (maxXTicks - 1));
  const xTickIndices = [];
  for (let i = 0; i < n; i += step) xTickIndices.push(i);
  if (xTickIndices[xTickIndices.length - 1] !== n - 1) xTickIndices.push(n - 1);

  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle    = pal.axis;

  xTickIndices.forEach(i => {
    const x = xOf(i);
    const y = marginTop + plotH;

    // Tick mark
    ctx.strokeStyle = pal.axis;
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 4);
    ctx.stroke();

    // Label
    ctx.fillText(fmtAxisDate(data[i].date), x, y + 6);
  });

  // ── Axes ───────────────────────────────────────────────────────────────────
  ctx.strokeStyle = pal.axis;
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();
  // Y axis
  ctx.moveTo(marginLeft, marginTop);
  ctx.lineTo(marginLeft, marginTop + plotH);
  // X axis
  ctx.lineTo(marginLeft + plotW, marginTop + plotH);
  ctx.stroke();

  // ── Area fill ─────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(revenues[0]));
  for (let i = 1; i < n; i++) {
    ctx.lineTo(xOf(i), yOf(revenues[i]));
  }
  ctx.lineTo(xOf(n - 1), marginTop + plotH);
  ctx.lineTo(xOf(0),     marginTop + plotH);
  ctx.closePath();
  ctx.fillStyle = pal.fill;
  ctx.fill();

  // ── Line ──────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(revenues[0]));
  for (let i = 1; i < n; i++) {
    ctx.lineTo(xOf(i), yOf(revenues[i]));
  }
  ctx.strokeStyle = pal.line;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.lineCap     = 'round';
  ctx.setLineDash([]);
  ctx.stroke();

  // ── Data dots (only if enough space) ──────────────────────────────────────
  const dotR = plotW / n > 14 ? 3 : 0;
  if (dotR > 0) {
    revenues.forEach((v, i) => {
      const x = xOf(i);
      const y = yOf(v);
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fillStyle   = pal.dotBg;
      ctx.fill();
      ctx.strokeStyle = pal.dot;
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    });
  }
}

// Re-export for convenience (ResizeObserver calls drawChart directly)
export function resizeChart(data, theme) {
  drawChart(data, theme);
}
