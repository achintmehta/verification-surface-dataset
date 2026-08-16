/**
 * Hand-drawn SVG time-series line chart.
 * Redraws on container resize via ResizeObserver.
 */

let resizeObserver = null;
let lastData = null;
let lastTheme = 'light';

// ─── Theme color resolver ─────────────────────────────────────────────────────

function getThemeColors(theme) {
  const dark = theme === 'dark';
  return {
    line:     dark ? '#60a5fa' : '#3b82f6',
    fill:     dark ? 'rgba(96,165,250,0.15)' : 'rgba(59,130,246,0.12)',
    grid:     dark ? '#334155' : '#e2e8f0',
    axis:     dark ? '#64748b' : '#94a3b8',
    text:     dark ? '#94a3b8' : '#64748b',
    dot:      dark ? '#60a5fa' : '#3b82f6',
    dotBg:    dark ? '#1e293b' : '#ffffff',
    bg:       dark ? '#1e293b' : '#ffffff',
  };
}

// ─── Main draw function ───────────────────────────────────────────────────────

export function drawTimeSeries(data, theme) {
  lastData  = data;
  lastTheme = theme;

  const container = document.getElementById('timeseries-container');
  if (!container) return;

  // Remove old SVG
  const old = container.querySelector('svg.ts-chart');
  if (old) old.remove();

  // Also remove canvas if present (we use SVG)
  const canvas = container.querySelector('canvas');
  if (canvas) canvas.style.display = 'none';

  if (!data || data.length === 0) return;

  const rect = container.getBoundingClientRect();
  const W = Math.max(rect.width  || container.clientWidth  || 600, 200);
  const H = Math.max(rect.height || container.clientHeight || 280, 160);

  // Margins — generous left for Y labels, bottom for X labels
  // Shrink margins on very narrow containers
  const narrow = W < 320;
  const margin = {
    top:    12,
    right:  narrow ? 8 : 14,
    bottom: 40,
    left:   narrow ? 44 : 58,
  };

  const innerW = Math.max(W - margin.left - margin.right, 10);
  const innerH = Math.max(H - margin.top  - margin.bottom, 10);

  const colors = getThemeColors(theme);

  // ── Data extents ──────────────────────────────────────────────────────────
  const values   = data.map(d => d.visitors);
  const rawMin   = Math.min(...values);
  const rawMax   = Math.max(...values);
  const padding  = (rawMax - rawMin) * 0.1 || 100;
  const yMin     = Math.max(0, rawMin - padding);
  const yMax     = rawMax + padding;

  // ── Scale helpers ─────────────────────────────────────────────────────────
  const xScale = i => (i / (data.length - 1)) * innerW;
  const yScale = v => innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // ── Y-axis ticks ──────────────────────────────────────────────────────────
  const yTickCount = Math.max(3, Math.min(6, Math.floor(innerH / 50)));
  const yTicks = niceLinearTicks(yMin, yMax, yTickCount);

  // ── X-axis ticks (dates) ──────────────────────────────────────────────────
  // Show ~6 evenly spaced date labels
  const xTickCount = Math.max(2, Math.min(6, Math.floor(innerW / 70)));
  const xTickIndices = evenlySpaced(data.length, xTickCount);

  // ── Build SVG ─────────────────────────────────────────────────────────────
  const svg = svgEl('svg', {
    class:   'ts-chart',
    viewBox: `0 0 ${W} ${H}`,
    width:   '100%',
    height:  '100%',
    style:   'display:block;overflow:hidden',
    'aria-hidden': 'true',
  });

  // Clip path so series never draws outside plot area
  const clipId = 'ts-clip-' + Math.random().toString(36).slice(2);
  const defs = svgEl('defs');
  const clipPath = svgEl('clipPath', { id: clipId });
  clipPath.appendChild(svgEl('rect', {
    x: 0, y: 0, width: innerW, height: innerH,
  }));
  defs.appendChild(clipPath);
  svg.appendChild(defs);

  // Group offset by margins
  const g = svgEl('g', { transform: `translate(${margin.left},${margin.top})` });
  svg.appendChild(g);

  // ── Gridlines ─────────────────────────────────────────────────────────────
  yTicks.forEach(tick => {
    const y = yScale(tick);
    g.appendChild(svgEl('line', {
      x1: 0, y1: y, x2: innerW, y2: y,
      stroke: colors.grid, 'stroke-width': 1,
      'stroke-dasharray': '3 3',
    }));
  });

  // ── Area fill ─────────────────────────────────────────────────────────────
  const areaPoints = [
    `${xScale(0)},${innerH}`,
    ...data.map((d, i) => `${xScale(i)},${yScale(d.visitors)}`),
    `${xScale(data.length - 1)},${innerH}`,
  ].join(' ');

  const area = svgEl('polygon', {
    points: areaPoints,
    fill:   colors.fill,
    'clip-path': `url(#${clipId})`,
  });
  g.appendChild(area);

  // ── Line ──────────────────────────────────────────────────────────────────
  const linePoints = data.map((d, i) => `${xScale(i)},${yScale(d.visitors)}`).join(' ');
  const line = svgEl('polyline', {
    points:         linePoints,
    fill:           'none',
    stroke:         colors.line,
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap':  'round',
    'clip-path': `url(#${clipId})`,
  });
  g.appendChild(line);

  // ── Dots (only if not too many points) ───────────────────────────────────
  if (data.length <= 35) {
    data.forEach((d, i) => {
      const cx = xScale(i);
      const cy = yScale(d.visitors);
      // Outer dot
      g.appendChild(svgEl('circle', {
        cx, cy, r: 3.5,
        fill:   colors.dot,
        'clip-path': `url(#${clipId})`,
      }));
      // Inner dot (bg color)
      g.appendChild(svgEl('circle', {
        cx, cy, r: 1.8,
        fill:   colors.dotBg,
        'clip-path': `url(#${clipId})`,
      }));
    });
  }

  // ── Y-axis labels ─────────────────────────────────────────────────────────
  yTicks.forEach(tick => {
    const y = yScale(tick);
    g.appendChild(svgEl('text', {
      x:           -8,
      y:           y,
      'text-anchor':    'end',
      'dominant-baseline': 'middle',
      fill:        colors.text,
      'font-size': '11',
      'font-family': 'inherit',
    }, fmtAxisNumber(tick)));
  });

  // ── X-axis labels ─────────────────────────────────────────────────────────
  xTickIndices.forEach(i => {
    const x = xScale(i);
    const label = fmtAxisDate(data[i].date);
    g.appendChild(svgEl('text', {
      x,
      y:           innerH + 18,
      'text-anchor':    'middle',
      fill:        colors.text,
      'font-size': '11',
      'font-family': 'inherit',
    }, label));
  });

  // ── Axes ──────────────────────────────────────────────────────────────────
  // Y axis line
  g.appendChild(svgEl('line', {
    x1: 0, y1: 0, x2: 0, y2: innerH,
    stroke: colors.axis, 'stroke-width': 1,
  }));
  // X axis line
  g.appendChild(svgEl('line', {
    x1: 0, y1: innerH, x2: innerW, y2: innerH,
    stroke: colors.axis, 'stroke-width': 1,
  }));

  container.appendChild(svg);
}

// ─── ResizeObserver ───────────────────────────────────────────────────────────

export function initChartResize() {
  const container = document.getElementById('timeseries-container');
  if (!container) return;

  if (resizeObserver) resizeObserver.disconnect();

  resizeObserver = new ResizeObserver(() => {
    if (lastData) {
      drawTimeSeries(lastData, lastTheme);
    }
  });

  resizeObserver.observe(container);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  if (text !== undefined) el.textContent = text;
  return el;
}

function fmtAxisNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return String(Math.round(n));
}

function fmtAxisDate(dateStr) {
  // dateStr may be a full ISO string or a YYYY-MM-DD string
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function niceLinearTicks(min, max, count) {
  const range = max - min;
  if (range === 0) return [min];
  const step = niceStep(range / (count - 1));
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.01; v += step) {
    ticks.push(Math.round(v));
    if (ticks.length >= count + 2) break;
  }
  return ticks;
}

function niceStep(roughStep) {
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const frac = roughStep / mag;
  if (frac < 1.5) return mag;
  if (frac < 3)   return 2 * mag;
  if (frac < 7)   return 5 * mag;
  return 10 * mag;
}

function evenlySpaced(total, count) {
  if (total <= 1) return [0];
  const indices = [];
  for (let i = 0; i < count; i++) {
    indices.push(Math.round(i * (total - 1) / (count - 1)));
  }
  return [...new Set(indices)];
}
