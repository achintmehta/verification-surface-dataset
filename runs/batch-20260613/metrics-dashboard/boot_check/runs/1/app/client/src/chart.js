/**
 * Hand-drawn SVG time-series line chart.
 * Draws two series (visitors, revenue) with dual Y-axes,
 * gridlines, labeled ticks, and redraws on container resize.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    e.setAttribute(k, v);
  }
  return e;
}

function niceMax(value) {
  if (value <= 0) return 10;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  let nice;
  if (normalized <= 1)      nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else                      nice = 10;
  return nice * magnitude;
}

function niceStep(max, targetTicks = 5) {
  const raw = max / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(raw)));
  const normalized = raw / magnitude;
  let nice;
  if (normalized <= 1)      nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else                      nice = 10;
  return nice * magnitude;
}

function formatShort(value) {
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (value >= 1_000)     return (value / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(value));
}

function formatDate(dateStr) {
  // dateStr is YYYY-MM-DD
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getCSSVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export class TimeSeriesChart {
  constructor(svgEl, containerEl) {
    this.svg = svgEl;
    this.container = containerEl;
    this.data = [];
    this._ro = null;
    this._rafId = null;
    this._setupResizeObserver();
  }

  setData(data) {
    this.data = data;
    this._scheduleRender();
  }

  _setupResizeObserver() {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', () => this._scheduleRender());
      return;
    }
    this._ro = new ResizeObserver(() => this._scheduleRender());
    this._ro.observe(this.container);
  }

  _scheduleRender() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => {
      this._rafId = null;
      this.render();
    });
  }

  render() {
    const svg = this.svg;
    // Clear previous content
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    if (!this.data || this.data.length === 0) return;

    const W = this.container.clientWidth;
    const H = this.container.clientHeight;
    if (W <= 0 || H <= 0) return;

    // Margins — adapt to width
    const isNarrow = W < 400;
    const margin = {
      top:    16,
      right:  isNarrow ? 44 : 56,  // right Y-axis (revenue)
      bottom: 40,
      left:   isNarrow ? 40 : 52,  // left Y-axis (visitors)
    };

    const plotW = W - margin.left - margin.right;
    const plotH = H - margin.top - margin.bottom;

    if (plotW <= 0 || plotH <= 0) return;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);

    // Theme colors
    const colorVisitors = getCSSVar('--chart-visitors') || '#3b82f6';
    const colorRevenue  = getCSSVar('--chart-revenue')  || '#10b981';
    const colorGrid     = getCSSVar('--chart-grid')     || '#e2e6ea';
    const colorAxis     = getCSSVar('--chart-axis')     || '#9ca3af';
    const colorLabel    = getCSSVar('--chart-label')    || '#6b7280';

    const data = this.data;
    const n = data.length;

    // Data ranges
    const maxVisitors = Math.max(...data.map(d => d.visitors));
    const maxRevenue  = Math.max(...data.map(d => d.revenue));

    const vMax  = niceMax(maxVisitors);
    const rMax  = niceMax(maxRevenue);
    const vStep = niceStep(vMax, 5);
    const rStep = niceStep(rMax, 5);

    // Scale functions
    const xScale = i => margin.left + (i / (n - 1)) * plotW;
    const yScaleV = v => margin.top + plotH - (v / vMax) * plotH;
    const yScaleR = r => margin.top + plotH - (r / rMax) * plotH;

    // ── Gridlines (horizontal, based on visitor ticks) ──
    const gridG = el('g', { class: 'chart-grid' });
    for (let tick = 0; tick <= vMax; tick += vStep) {
      const y = yScaleV(tick);
      if (y < margin.top - 1) break;
      gridG.appendChild(el('line', {
        x1: margin.left, y1: y,
        x2: margin.left + plotW, y2: y,
        stroke: colorGrid,
        'stroke-width': '1',
        'stroke-dasharray': tick === 0 ? 'none' : '4 3',
      }));
    }
    svg.appendChild(gridG);

    // ── Left Y-axis (Visitors) ──
    const leftAxisG = el('g', { class: 'axis-left' });
    for (let tick = 0; tick <= vMax; tick += vStep) {
      const y = yScaleV(tick);
      if (y < margin.top - 1) break;
      // Tick mark
      leftAxisG.appendChild(el('line', {
        x1: margin.left - 4, y1: y,
        x2: margin.left, y2: y,
        stroke: colorAxis, 'stroke-width': '1',
      }));
      // Label
      const t = el('text', {
        x: margin.left - 7,
        y: y,
        'text-anchor': 'end',
        'dominant-baseline': 'middle',
        fill: colorLabel,
        'font-size': isNarrow ? '9' : '11',
        'font-family': 'system-ui, sans-serif',
      });
      t.textContent = formatShort(tick);
      leftAxisG.appendChild(t);
    }
    // Axis line
    leftAxisG.appendChild(el('line', {
      x1: margin.left, y1: margin.top,
      x2: margin.left, y2: margin.top + plotH,
      stroke: colorAxis, 'stroke-width': '1',
    }));
    // Axis label
    const leftLabel = el('text', {
      x: -(margin.top + plotH / 2),
      y: isNarrow ? 10 : 14,
      transform: 'rotate(-90)',
      'text-anchor': 'middle',
      fill: colorLabel,
      'font-size': isNarrow ? '9' : '11',
      'font-family': 'system-ui, sans-serif',
    });
    leftLabel.textContent = 'Visitors';
    leftAxisG.appendChild(leftLabel);
    svg.appendChild(leftAxisG);

    // ── Right Y-axis (Revenue) ──
    const rightAxisG = el('g', { class: 'axis-right' });
    for (let tick = 0; tick <= rMax; tick += rStep) {
      const y = yScaleR(tick);
      if (y < margin.top - 1) break;
      rightAxisG.appendChild(el('line', {
        x1: margin.left + plotW, y1: y,
        x2: margin.left + plotW + 4, y2: y,
        stroke: colorAxis, 'stroke-width': '1',
      }));
      const t = el('text', {
        x: margin.left + plotW + 7,
        y: y,
        'text-anchor': 'start',
        'dominant-baseline': 'middle',
        fill: colorLabel,
        'font-size': isNarrow ? '9' : '11',
        'font-family': 'system-ui, sans-serif',
      });
      t.textContent = formatShort(tick);
      rightAxisG.appendChild(t);
    }
    rightAxisG.appendChild(el('line', {
      x1: margin.left + plotW, y1: margin.top,
      x2: margin.left + plotW, y2: margin.top + plotH,
      stroke: colorAxis, 'stroke-width': '1',
    }));
    // Axis label
    const rightLabel = el('text', {
      x: margin.top + plotH / 2,
      y: -(W - (isNarrow ? 10 : 14)),
      transform: 'rotate(90)',
      'text-anchor': 'middle',
      fill: colorLabel,
      'font-size': isNarrow ? '9' : '11',
      'font-family': 'system-ui, sans-serif',
    });
    rightLabel.textContent = 'Revenue ($)';
    rightAxisG.appendChild(rightLabel);
    svg.appendChild(rightAxisG);

    // ── X-axis ──
    const xAxisG = el('g', { class: 'axis-x' });
    xAxisG.appendChild(el('line', {
      x1: margin.left, y1: margin.top + plotH,
      x2: margin.left + plotW, y2: margin.top + plotH,
      stroke: colorAxis, 'stroke-width': '1',
    }));

    // Determine how many x-ticks fit
    const tickEvery = isNarrow ? 7 : W < 600 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      if (i % tickEvery !== 0 && i !== n - 1) continue;
      const x = xScale(i);
      xAxisG.appendChild(el('line', {
        x1: x, y1: margin.top + plotH,
        x2: x, y2: margin.top + plotH + 4,
        stroke: colorAxis, 'stroke-width': '1',
      }));
      const t = el('text', {
        x: x,
        y: margin.top + plotH + 16,
        'text-anchor': 'middle',
        fill: colorLabel,
        'font-size': isNarrow ? '8' : '10',
        'font-family': 'system-ui, sans-serif',
      });
      t.textContent = formatDate(data[i].date);
      xAxisG.appendChild(t);
    }
    svg.appendChild(xAxisG);

    // ── Clip path to keep lines inside plot area ──
    const defs = el('defs');
    const clipPath = el('clipPath', { id: 'plot-clip' });
    clipPath.appendChild(el('rect', {
      x: margin.left,
      y: margin.top,
      width: plotW,
      height: plotH,
    }));
    defs.appendChild(clipPath);
    svg.appendChild(defs);

    // ── Revenue area fill ──
    const revenueAreaPoints = data.map((d, i) => `${xScale(i)},${yScaleR(d.revenue)}`).join(' ');
    const areaPath = [
      `M ${xScale(0)},${yScaleR(data[0].revenue)}`,
      ...data.slice(1).map((d, i) => `L ${xScale(i + 1)},${yScaleR(d.revenue)}`),
      `L ${xScale(n - 1)},${margin.top + plotH}`,
      `L ${xScale(0)},${margin.top + plotH}`,
      'Z',
    ].join(' ');

    const areaEl = el('path', {
      d: areaPath,
      fill: colorRevenue,
      'fill-opacity': '0.08',
      'clip-path': 'url(#plot-clip)',
    });
    svg.appendChild(areaEl);

    // ── Visitors area fill ──
    const visitorsAreaPath = [
      `M ${xScale(0)},${yScaleV(data[0].visitors)}`,
      ...data.slice(1).map((d, i) => `L ${xScale(i + 1)},${yScaleV(d.visitors)}`),
      `L ${xScale(n - 1)},${margin.top + plotH}`,
      `L ${xScale(0)},${margin.top + plotH}`,
      'Z',
    ].join(' ');

    const visitorsAreaEl = el('path', {
      d: visitorsAreaPath,
      fill: colorVisitors,
      'fill-opacity': '0.06',
      'clip-path': 'url(#plot-clip)',
    });
    svg.appendChild(visitorsAreaEl);

    // ── Revenue line ──
    const revenuePath = data.map((d, i) =>
      `${i === 0 ? 'M' : 'L'} ${xScale(i)},${yScaleR(d.revenue)}`
    ).join(' ');

    svg.appendChild(el('path', {
      d: revenuePath,
      fill: 'none',
      stroke: colorRevenue,
      'stroke-width': '2',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      'clip-path': 'url(#plot-clip)',
    }));

    // ── Visitors line ──
    const visitorsPath = data.map((d, i) =>
      `${i === 0 ? 'M' : 'L'} ${xScale(i)},${yScaleV(d.visitors)}`
    ).join(' ');

    svg.appendChild(el('path', {
      d: visitorsPath,
      fill: 'none',
      stroke: colorVisitors,
      'stroke-width': '2',
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      'clip-path': 'url(#plot-clip)',
    }));

    // ── Dots at data points (only if not too many / not too narrow) ──
    if (!isNarrow && n <= 31) {
      const dotsG = el('g', { 'clip-path': 'url(#plot-clip)' });
      for (let i = 0; i < n; i++) {
        // Visitors dot
        dotsG.appendChild(el('circle', {
          cx: xScale(i), cy: yScaleV(data[i].visitors),
          r: '3', fill: colorVisitors,
        }));
        // Revenue dot
        dotsG.appendChild(el('circle', {
          cx: xScale(i), cy: yScaleR(data[i].revenue),
          r: '3', fill: colorRevenue,
        }));
      }
      svg.appendChild(dotsG);
    }
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }
}
