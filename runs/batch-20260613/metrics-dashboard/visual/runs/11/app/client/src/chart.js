// Hand-drawn time-series line chart on a canvas.
// - Reads theme colors from CSS custom properties so it restyles with the theme.
// - Scales for devicePixelRatio so it stays crisp.
// - Redraws to fit its container; caller invokes drawChart() on resize.

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

function niceTicks(min, max, count) {
  const range = Math.max(max - min, 1);
  const rawStep = range / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  let step;
  if (norm < 1.5) step = 1;
  else if (norm < 3) step = 2;
  else if (norm < 7) step = 5;
  else step = 10;
  step *= mag;
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(v);
  return { ticks, niceMin, niceMax };
}

function fmtAxisNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

export function drawChart(canvas, wrap, series) {
  if (!canvas || !wrap || !series || series.length === 0) return;

  const dpr = window.devicePixelRatio || 1;
  const cssW = wrap.clientWidth;
  const cssH = wrap.clientHeight;
  if (cssW === 0 || cssH === 0) return;

  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const colAxis = cssVar('--chart-axis', '#aeb6c6');
  const colGrid = cssVar('--chart-grid', '#e7eaf1');
  const colLine = cssVar('--chart-line', '#3a6df0');
  const colFill = cssVar('--chart-fill', 'rgba(58,109,240,0.14)');
  const colLabel = cssVar('--chart-label', '#5b6478');

  // Margins: leave room for y labels (left) and x labels (bottom).
  const isNarrow = cssW < 420;
  const m = {
    top: 12,
    right: 14,
    bottom: 26,
    left: isNarrow ? 38 : 46,
  };
  const plotW = Math.max(cssW - m.left - m.right, 10);
  const plotH = Math.max(cssH - m.top - m.bottom, 10);

  const values = series.map((d) => d.visitors);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const { ticks, niceMin, niceMax } = niceTicks(
    Math.min(dataMin, dataMax),
    dataMax,
    4
  );
  const yMin = Math.min(niceMin, dataMin);
  const yMax = Math.max(niceMax, dataMax);

  const xFor = (i) =>
    m.left + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const yFor = (v) =>
    m.top + plotH - ((v - yMin) / Math.max(yMax - yMin, 1)) * plotH;

  ctx.font =
    '11px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textBaseline = 'middle';

  // Y gridlines + labels
  ctx.strokeStyle = colGrid;
  ctx.fillStyle = colLabel;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (const t of ticks) {
    if (t < yMin - 1 || t > yMax + 1) continue;
    const y = Math.round(yFor(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(m.left, y);
    ctx.lineTo(m.left + plotW, y);
    ctx.stroke();
    ctx.fillText(fmtAxisNum(t), m.left - 6, yFor(t));
  }

  // Axes (left + bottom)
  ctx.strokeStyle = colAxis;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(m.left + 0.5, m.top);
  ctx.lineTo(m.left + 0.5, m.top + plotH);
  ctx.lineTo(m.left + plotW, m.top + plotH);
  ctx.stroke();

  // X labels: show a handful of date ticks to avoid crowding.
  ctx.fillStyle = colLabel;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const maxLabels = isNarrow ? 4 : 6;
  const stepX = Math.ceil(series.length / maxLabels);
  for (let i = 0; i < series.length; i += stepX) {
    const d = new Date(series[i].day);
    const label = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
    let x = xFor(i);
    // keep last label from overflowing right edge
    x = Math.min(Math.max(x, m.left + 14), m.left + plotW - 14);
    ctx.fillText(label, x, m.top + plotH + 7);
  }

  // Area fill under the line
  ctx.beginPath();
  ctx.moveTo(xFor(0), yFor(values[0]));
  for (let i = 1; i < series.length; i++) ctx.lineTo(xFor(i), yFor(values[i]));
  ctx.lineTo(xFor(series.length - 1), m.top + plotH);
  ctx.lineTo(xFor(0), m.top + plotH);
  ctx.closePath();
  ctx.fillStyle = colFill;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(xFor(0), yFor(values[0]));
  for (let i = 1; i < series.length; i++) ctx.lineTo(xFor(i), yFor(values[i]));
  ctx.strokeStyle = colLine;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Endpoint dot
  const lastX = xFor(series.length - 1);
  const lastY = yFor(values[series.length - 1]);
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3.2, 0, Math.PI * 2);
  ctx.fillStyle = colLine;
  ctx.fill();
}
