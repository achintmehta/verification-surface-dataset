/**
 * Hand-drawn SVG time-series line chart.
 *
 * Usage:
 *   initChart(containerEl, rows, theme)
 *
 * The container element must have a defined width and height (via CSS).
 * The chart replaces any existing SVG inside the container on each call,
 * so it can be called repeatedly on resize.
 */

// ── CSS variable reader ───────────────────────────────────────────────────────

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function getColours() {
  return {
    line:    cssVar('--color-chart-line')  || '#4f6ef7',
    fill:    cssVar('--color-chart-fill')  || 'rgba(79,110,247,0.12)',
    grid:    cssVar('--color-chart-grid')  || '#e2e6ea',
    axis:    cssVar('--color-chart-axis')  || '#6b7280',
  };
}

// ── Number formatting ─────────────────────────────────────────────────────────

function fmtY(n) {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000)    return `$${(n / 1_000).toFixed(0)}k`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}k`;
  return `$${Math.round(n)}`;
}

// ── SVG helpers ───────────────────────────────────────────────────────────────

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function txt(content, attrs = {}) {
  const e = el('text', attrs);
  e.textContent = content;
  return e;
}

// ── Nice tick calculation ─────────────────────────────────────────────────────

function niceStep(range, targetTicks) {
  const rough = range / targetTicks;
  const mag   = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm  = rough / mag;
  let nice;
  if      (norm < 1.5) nice = 1;
  else if (norm < 3)   nice = 2;
  else if (norm < 7)   nice = 5;
  else                 nice = 10;
  return nice * mag;
}

function niceBounds(minVal, maxVal, targetTicks = 5) {
  if (minVal === maxVal) { minVal -= 1; maxVal += 1; }
  const range = maxVal - minVal;
  const step  = niceStep(range * 1.1, targetTicks);
  const lo    = Math.floor(minVal / step) * step;
  const hi    = Math.ceil(maxVal  / step) * step;
  return { lo, hi, step };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} container  - sized container element
 * @param {Array}       rows       - [{date, revenue, visitors}, …]
 * @param {string}      _theme     - 'light' | 'dark' (colours read from CSS vars)
 */
export function initChart(container, rows, _theme) {
  // Remove any previous SVG
  const prev = container.querySelector('svg.chart-svg');
  if (prev) prev.remove();

  const W = container.clientWidth;
  const H = container.clientHeight;

  if (!W || !H || W < 20 || H < 20) return;

  const colours = getColours();

  // ── Font size — scales with container width ────────────────────────────────
  const fontSize = Math.max(9, Math.min(11, Math.round(W / 50)));

  // ── Margins ────────────────────────────────────────────────────────────────
  // Left: wide enough for Y labels (e.g. "$10k")
  const marginLeft   = Math.max(44, fontSize * 5);
  const marginRight  = Math.max(12, fontSize * 1.5);
  const marginTop    = Math.max(12, fontSize * 1.5);
  const marginBottom = Math.max(28, fontSize * 3.2);

  const plotW = W - marginLeft - marginRight;
  const plotH = H - marginTop  - marginBottom;

  if (plotW < 10 || plotH < 10) return;

  // ── Data ───────────────────────────────────────────────────────────────────
  const values = rows.map(r => Number(r.revenue));
  const dates  = rows.map(r => r.date);
  const n      = values.length;

  if (n < 2) return;

  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const { lo: yMin, hi: yMax, step: yStep } = niceBounds(rawMin, rawMax,
    Math.max(3, Math.min(6, Math.floor(plotH / 40))));
  const yRange = yMax - yMin;

  // ── Coordinate mappers ─────────────────────────────────────────────────────
  const xOf = i  => marginLeft + (i / (n - 1)) * plotW;
  const yOf = v  => marginTop  + plotH - ((v - yMin) / yRange) * plotH;

  // ── SVG root ───────────────────────────────────────────────────────────────
  const svg = el('svg', {
    class:   'chart-svg',
    width:   W,
    height:  H,
    viewBox: `0 0 ${W} ${H}`,
    role:    'img',
    'aria-label': '30-day revenue time series chart',
  });

  // ── Clip path ─────────────────────────────────────────────────────────────
  const clipId = `cc${Math.random().toString(36).slice(2, 8)}`;
  const defs   = el('defs');
  const clip   = el('clipPath', { id: clipId });
  clip.appendChild(el('rect', {
    x: marginLeft, y: marginTop, width: plotW, height: plotH,
  }));
  defs.appendChild(clip);
  svg.appendChild(defs);

  // ── Y gridlines & labels ──────────────────────────────────────────────────
  for (let v = yMin; v <= yMax + yStep * 0.01; v += yStep) {
    const cy = yOf(v);
    if (cy < marginTop - 1 || cy > marginTop + plotH + 1) continue;

    // Gridline
    svg.appendChild(el('line', {
      x1: marginLeft, y1: cy,
      x2: marginLeft + plotW, y2: cy,
      stroke: colours.grid,
      'stroke-width': 1,
      'stroke-dasharray': Math.abs(v - yMin) < 0.01 ? 'none' : '4 3',
    }));

    // Y label
    const label = txt(fmtY(v), {
      x: marginLeft - 6,
      y: cy + fontSize * 0.4,
      'text-anchor': 'end',
      'font-size': fontSize,
      fill: colours.axis,
      'font-family': 'system-ui, sans-serif',
    });
    svg.appendChild(label);
  }

  // ── X axis labels ─────────────────────────────────────────────────────────
  // Aim for one label per ~60px of plot width
  const maxXLabels = Math.max(2, Math.min(7, Math.floor(plotW / 60)));
  const xIndices   = [];
  if (maxXLabels >= n) {
    for (let i = 0; i < n; i++) xIndices.push(i);
  } else {
    for (let li = 0; li < maxXLabels; li++) {
      xIndices.push(Math.round(li * (n - 1) / (maxXLabels - 1)));
    }
  }

  xIndices.forEach((i, li) => {
    const cx = xOf(i);
    const d  = new Date(dates[i]);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const anchor = li === 0 ? 'start' : li === xIndices.length - 1 ? 'end' : 'middle';

    svg.appendChild(el('line', {
      x1: cx, y1: marginTop + plotH,
      x2: cx, y2: marginTop + plotH + 4,
      stroke: colours.axis, 'stroke-width': 1,
    }));

    svg.appendChild(txt(label, {
      x: cx,
      y: marginTop + plotH + fontSize + 6,
      'text-anchor': anchor,
      'font-size': fontSize,
      fill: colours.axis,
      'font-family': 'system-ui, sans-serif',
    }));
  });

  // ── Area fill ─────────────────────────────────────────────────────────────
  const areaD = [
    `M ${xOf(0)},${yOf(values[0])}`,
    ...values.slice(1).map((v, i) => `L ${xOf(i + 1)},${yOf(v)}`),
    `L ${xOf(n - 1)},${marginTop + plotH}`,
    `L ${xOf(0)},${marginTop + plotH}`,
    'Z',
  ].join(' ');

  svg.appendChild(el('path', {
    d: areaD,
    fill: colours.fill,
    'clip-path': `url(#${clipId})`,
  }));

  // ── Line ──────────────────────────────────────────────────────────────────
  const lineD = [
    `M ${xOf(0)},${yOf(values[0])}`,
    ...values.slice(1).map((v, i) => `L ${xOf(i + 1)},${yOf(v)}`),
  ].join(' ');

  svg.appendChild(el('path', {
    d: lineD,
    fill: 'none',
    stroke: colours.line,
    'stroke-width': 2,
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
    'clip-path': `url(#${clipId})`,
  }));

  // ── Axis lines ────────────────────────────────────────────────────────────
  svg.appendChild(el('line', {
    x1: marginLeft, y1: marginTop + plotH,
    x2: marginLeft + plotW, y2: marginTop + plotH,
    stroke: colours.axis, 'stroke-width': 1,
  }));
  svg.appendChild(el('line', {
    x1: marginLeft, y1: marginTop,
    x2: marginLeft, y2: marginTop + plotH,
    stroke: colours.axis, 'stroke-width': 1,
  }));

  // ── Data point dots ───────────────────────────────────────────────────────
  const dotR = Math.max(2, Math.min(3.5, plotW / n / 2.5));
  values.forEach((v, i) => {
    svg.appendChild(el('circle', {
      cx: xOf(i), cy: yOf(v), r: dotR,
      fill: colours.line,
      'clip-path': `url(#${clipId})`,
    }));
  });

  container.appendChild(svg);
  return svg;
}
