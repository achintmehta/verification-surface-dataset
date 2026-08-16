/**
 * Hand-drawn time-series line chart using Canvas 2D.
 * Redraws to fit its container on every call to draw().
 */

const PADDING = { top: 20, right: 16, bottom: 48, left: 56 };

/**
 * Format a number with K/M suffix for axis labels.
 */
function fmtAxisNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

/**
 * Format a date string (YYYY-MM-DD) to short label like "Jan 1".
 */
function fmtDateShort(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Get CSS variable value from the document root.
 */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    || getComputedStyle(document.body).getPropertyValue(name).trim();
}

/**
 * Draw the chart onto the canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{date: string, visitors: number}>} data
 */
export function drawChart(canvas, data) {
  if (!canvas || !data || data.length === 0) return;

  const container = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = container.clientWidth;
  const cssHeight = container.clientHeight;

  // Set canvas resolution
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Read theme colors
  const colorGrid    = cssVar('--color-chart-grid')  || '#e2e6ea';
  const colorAxis    = cssVar('--color-chart-axis')  || '#718096';
  const colorLabel   = cssVar('--color-chart-label') || '#4a5568';
  const colorLine    = cssVar('--color-chart-line')  || '#3b82f6';
  const colorFill    = cssVar('--color-chart-fill')  || 'rgba(59,130,246,0.12)';
  const colorSurface = cssVar('--color-surface')     || '#ffffff';

  const W = cssWidth;
  const H = cssHeight;
  const pad = { ...PADDING };

  // Adjust left padding based on available width
  if (W < 400) {
    pad.left = 44;
    pad.bottom = 44;
  }

  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;

  if (chartW <= 0 || chartH <= 0) return;

  // Clear
  ctx.clearRect(0, 0, W, H);

  // Data bounds
  const values = data.map((d) => d.visitors);
  const minVal = 0;
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;

  // Scale helpers
  const xScale = (i) => pad.left + (i / (data.length - 1)) * chartW;
  const yScale = (v) => pad.top + chartH - ((v - minVal) / range) * chartH;

  // ---- Gridlines & Y-axis ticks ----
  const yTickCount = Math.max(3, Math.min(6, Math.floor(chartH / 50)));
  const yStep = range / yTickCount;

  ctx.save();
  ctx.font = `${W < 400 ? 10 : 11}px ${cssVar('--font-sans') || 'system-ui, sans-serif'}`;
  ctx.fillStyle = colorLabel;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= yTickCount; i++) {
    const v = minVal + i * yStep;
    const y = yScale(v);

    // Gridline
    ctx.beginPath();
    ctx.strokeStyle = colorGrid;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + chartW, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Y label
    ctx.fillText(fmtAxisNum(Math.round(v)), pad.left - 6, y);
  }
  ctx.restore();

  // ---- X-axis ticks ----
  // Choose tick interval so labels don't overlap
  const minTickSpacing = W < 500 ? 60 : 50;
  const maxTicks = Math.max(2, Math.floor(chartW / minTickSpacing));
  const tickStep = Math.ceil((data.length - 1) / maxTicks);

  ctx.save();
  ctx.font = `${W < 400 ? 10 : 11}px ${cssVar('--font-sans') || 'system-ui, sans-serif'}`;
  ctx.fillStyle = colorLabel;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (let i = 0; i < data.length; i += tickStep) {
    const x = xScale(i);
    const y = pad.top + chartH;

    // Tick mark
    ctx.beginPath();
    ctx.strokeStyle = colorAxis;
    ctx.lineWidth = 1;
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 4);
    ctx.stroke();

    // Label
    const label = fmtDateShort(data[i].date);
    ctx.fillText(label, x, y + 7);
  }
  // Always draw last tick
  const lastIdx = data.length - 1;
  if (lastIdx % tickStep !== 0) {
    const x = xScale(lastIdx);
    const y = pad.top + chartH;
    ctx.beginPath();
    ctx.strokeStyle = colorAxis;
    ctx.lineWidth = 1;
    ctx.moveTo(x, y);
    ctx.lineTo(x, y + 4);
    ctx.stroke();
    ctx.fillText(fmtDateShort(data[lastIdx].date), x, y + 7);
  }
  ctx.restore();

  // ---- Axes ----
  ctx.save();
  ctx.strokeStyle = colorAxis;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Y axis
  ctx.moveTo(pad.left, pad.top);
  ctx.lineTo(pad.left, pad.top + chartH);
  // X axis
  ctx.lineTo(pad.left + chartW, pad.top + chartH);
  ctx.stroke();
  ctx.restore();

  // ---- Area fill ----
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(xScale(0), yScale(data[0].visitors));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(xScale(i), yScale(data[i].visitors));
  }
  // Close path to bottom
  ctx.lineTo(xScale(data.length - 1), pad.top + chartH);
  ctx.lineTo(xScale(0), pad.top + chartH);
  ctx.closePath();
  ctx.fillStyle = colorFill;
  ctx.fill();
  ctx.restore();

  // ---- Line ----
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = colorLine;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.moveTo(xScale(0), yScale(data[0].visitors));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(xScale(i), yScale(data[i].visitors));
  }
  ctx.stroke();
  ctx.restore();

  // ---- Data point dots (only if enough space) ----
  if (chartW / data.length > 8) {
    ctx.save();
    for (let i = 0; i < data.length; i++) {
      const x = xScale(i);
      const y = yScale(data[i].visitors);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = colorLine;
      ctx.fill();
      ctx.strokeStyle = colorSurface;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }
}
