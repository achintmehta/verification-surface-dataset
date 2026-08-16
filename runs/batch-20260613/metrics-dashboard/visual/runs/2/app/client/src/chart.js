import { formatAxisDate, formatAxisValue } from './format.js';

/**
 * Draw a time-series line chart on a canvas element.
 * The canvas is sized to match its container's CSS dimensions,
 * accounting for device pixel ratio for crisp rendering.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} container
 * @param {Array<{date: string, revenue: number}>} data
 * @param {'light'|'dark'} theme
 */
export function drawTimeseriesChart(canvas, container, data, theme) {
  if (!canvas || !container || !data || data.length === 0) return;

  // ── Sizing ──────────────────────────────────────────────────
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = container.clientWidth;
  const cssHeight = container.clientHeight;

  if (cssWidth <= 0 || cssHeight <= 0) return;

  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = cssWidth + 'px';
  canvas.style.height = cssHeight + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const W = cssWidth;
  const H = cssHeight;

  // ── Theme colors ─────────────────────────────────────────────
  const isDark = theme === 'dark';
  const colors = {
    line:       isDark ? '#6b84f8' : '#4f6ef7',
    fillStart:  isDark ? 'rgba(107,132,248,0.30)' : 'rgba(79,110,247,0.22)',
    fillEnd:    isDark ? 'rgba(107,132,248,0.00)' : 'rgba(79,110,247,0.00)',
    grid:       isDark ? '#2e3347' : '#e2e6ea',
    axis:       isDark ? '#5c6480' : '#8a93a2',
    label:      isDark ? '#9aa3b8' : '#5a6270',
    dot:        isDark ? '#6b84f8' : '#4f6ef7',
    dotStroke:  isDark ? '#1a1d27' : '#ffffff',
    bg:         isDark ? '#1a1d27' : '#ffffff',
    tooltip:    isDark ? '#22263a' : '#ffffff',
    tooltipBorder: isDark ? '#2e3347' : '#e2e6ea',
    tooltipText: isDark ? '#e8eaf0' : '#1a1d23',
  };

  // ── Margins ───────────────────────────────────────────────────
  // Adaptive margins based on available width
  const isNarrow = W < 400;
  const isMedium = W < 600;

  const margin = {
    top:    16,
    right:  isNarrow ? 8 : 16,
    bottom: isNarrow ? 40 : 44,
    left:   isNarrow ? 48 : isMedium ? 56 : 64,
  };

  const plotW = W - margin.left - margin.right;
  const plotH = H - margin.top - margin.bottom;

  if (plotW <= 0 || plotH <= 0) return;

  // ── Data ──────────────────────────────────────────────────────
  const values = data.map(d => Number(d.revenue));
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);

  // Nice axis range
  const range = maxVal - minVal || 1;
  const padding = range * 0.1;
  const yMin = Math.max(0, minVal - padding);
  const yMax = maxVal + padding;
  const yRange = yMax - yMin;

  // ── Grid lines & Y axis ticks ─────────────────────────────────
  const numYTicks = isNarrow ? 4 : 5;
  const yTicks = niceLinearTicks(yMin, yMax, numYTicks);

  // ── X axis ticks ──────────────────────────────────────────────
  // Show a subset of dates to avoid crowding
  const maxXLabels = isNarrow ? 4 : isMedium ? 5 : 7;
  const xTickIndices = pickTickIndices(data.length, maxXLabels);

  // ── Coordinate helpers ────────────────────────────────────────
  function xPos(i) {
    return margin.left + (i / (data.length - 1)) * plotW;
  }
  function yPos(v) {
    return margin.top + plotH - ((v - yMin) / yRange) * plotH;
  }

  // ── Clear ─────────────────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);

  // ── Draw grid lines ───────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);

  for (const tick of yTicks) {
    const y = yPos(tick);
    if (y < margin.top || y > margin.top + plotH) continue;
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(margin.left + plotW, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  // ── Draw axes ─────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;

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

  // ── Y axis labels ─────────────────────────────────────────────
  ctx.save();
  ctx.fillStyle = colors.label;
  ctx.font = `${isNarrow ? 10 : 11}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (const tick of yTicks) {
    const y = yPos(tick);
    if (y < margin.top - 4 || y > margin.top + plotH + 4) continue;
    ctx.fillText(formatAxisValue(tick), margin.left - 6, y);
  }
  ctx.restore();

  // ── X axis labels ─────────────────────────────────────────────
  ctx.save();
  ctx.fillStyle = colors.label;
  ctx.font = `${isNarrow ? 10 : 11}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  for (const i of xTickIndices) {
    const x = xPos(i);
    const label = formatAxisDate(data[i].date);
    // Tick mark
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, margin.top + plotH);
    ctx.lineTo(x, margin.top + plotH + 4);
    ctx.stroke();
    // Label
    ctx.fillStyle = colors.label;
    ctx.fillText(label, x, margin.top + plotH + 7);
  }
  ctx.restore();

  // ── Draw area fill ────────────────────────────────────────────
  ctx.save();
  const gradient = ctx.createLinearGradient(0, margin.top, 0, margin.top + plotH);
  gradient.addColorStop(0, colors.fillStart);
  gradient.addColorStop(1, colors.fillEnd);

  ctx.beginPath();
  ctx.moveTo(xPos(0), margin.top + plotH);
  for (let i = 0; i < data.length; i++) {
    const x = xPos(i);
    const y = yPos(values[i]);
    if (i === 0) ctx.lineTo(x, y);
    else {
      // Smooth curve using cardinal spline
      const prev = { x: xPos(i - 1), y: yPos(values[i - 1]) };
      const curr = { x, y };
      const cp1x = prev.x + (curr.x - prev.x) * 0.4;
      const cp1y = prev.y;
      const cp2x = curr.x - (curr.x - prev.x) * 0.4;
      const cp2y = curr.y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, curr.x, curr.y);
    }
  }
  ctx.lineTo(xPos(data.length - 1), margin.top + plotH);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.restore();

  // ── Draw line ─────────────────────────────────────────────────
  ctx.save();
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = xPos(i);
    const y = yPos(values[i]);
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      const prev = { x: xPos(i - 1), y: yPos(values[i - 1]) };
      const curr = { x, y };
      const cp1x = prev.x + (curr.x - prev.x) * 0.4;
      const cp1y = prev.y;
      const cp2x = curr.x - (curr.x - prev.x) * 0.4;
      const cp2y = curr.y;
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, curr.x, curr.y);
    }
  }
  ctx.stroke();
  ctx.restore();

  // ── Draw dots at data points (only if not too crowded) ────────
  if (data.length <= 30 && plotW / data.length > 8) {
    const dotRadius = isNarrow ? 2.5 : 3;
    ctx.save();
    for (let i = 0; i < data.length; i++) {
      const x = xPos(i);
      const y = yPos(values[i]);
      // Outer dot (stroke)
      ctx.beginPath();
      ctx.arc(x, y, dotRadius + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = colors.dotStroke;
      ctx.fill();
      // Inner dot
      ctx.beginPath();
      ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = colors.dot;
      ctx.fill();
    }
    ctx.restore();
  }

  // ── Clip indicator: draw a subtle border around plot area ─────
  // (ensures nothing is drawn outside)
  ctx.save();
  ctx.beginPath();
  ctx.rect(margin.left, margin.top, plotW, plotH);
  ctx.clip();
  ctx.restore();
}

// ============================================================
// Helpers
// ============================================================

/**
 * Generate nice round tick values for a linear axis.
 */
function niceLinearTicks(min, max, count) {
  const range = max - min;
  if (range === 0) return [min];
  const step = niceStep(range / (count - 1));
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) {
    if (v >= min - step * 0.01) ticks.push(parseFloat(v.toPrecision(10)));
    if (ticks.length >= count + 2) break;
  }
  return ticks;
}

function niceStep(roughStep) {
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let nice;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 2.5) nice = 2.5;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

/**
 * Pick evenly-spaced indices from an array of length n,
 * always including first and last.
 */
function pickTickIndices(n, maxCount) {
  if (n <= 1) return [0];
  if (n <= maxCount) return Array.from({ length: n }, (_, i) => i);
  const indices = [0];
  const step = (n - 1) / (maxCount - 1);
  for (let i = 1; i < maxCount - 1; i++) {
    indices.push(Math.round(i * step));
  }
  indices.push(n - 1);
  // Deduplicate
  return [...new Set(indices)];
}
