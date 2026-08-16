/**
 * Hand-drawn time-series chart using Canvas 2D.
 *
 * Draws two series (visitors on left axis, revenue on right axis)
 * with gridlines, labeled ticks, and a filled area under the visitors line.
 * Redraws on container resize via ResizeObserver.
 */

const PADDING = { top: 20, right: 60, bottom: 48, left: 64 };
const TICK_COUNT = 5;
const DATE_TICK_MAX = 8; // max date labels on x-axis

function getCSSVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

function getChartColors() {
  return {
    grid:    getCSSVar('--color-chart-grid'),
    axis:    getCSSVar('--color-chart-axis'),
    line:    getCSSVar('--color-chart-line'),
    line2:   getCSSVar('--color-chart-line2'),
    area:    getCSSVar('--color-chart-area'),
    text:    getCSSVar('--color-text-secondary'),
    surface: getCSSVar('--color-surface'),
  };
}

function niceMax(value) {
  if (value === 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  let nice;
  if (normalized <= 1)      nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else                      nice = 10;
  return nice * magnitude;
}

function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(Math.round(n));
}

function formatDate(dateStr) {
  // dateStr: "YYYY-MM-DD"
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m)}/${parseInt(d)}`;
}

export class TimeSeriesChart {
  constructor(canvas, container) {
    this.canvas    = canvas;
    this.container = container;
    this.ctx       = canvas.getContext('2d');
    this.data      = [];
    this._ro       = null;
    this._rafId    = null;

    this._bindResize();
  }

  setData(data) {
    this.data = data;
    this._scheduleRender();
  }

  /** Called when theme changes — just re-render with new CSS vars */
  onThemeChange() {
    this._scheduleRender();
  }

  _bindResize() {
    this._ro = new ResizeObserver(() => {
      this._scheduleRender();
    });
    this._ro.observe(this.container);
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  _scheduleRender() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(() => this._render());
  }

  _render() {
    const { canvas, ctx, container, data } = this;

    // Size canvas to container (device pixel ratio aware)
    const dpr  = window.devicePixelRatio || 1;
    const rect  = container.getBoundingClientRect();
    const cssW  = Math.max(rect.width,  200);
    const cssH  = Math.max(rect.height, 150);

    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';

    ctx.scale(dpr, dpr);

    const colors = getChartColors();
    const W = cssW;
    const H = cssH;
    const pad = PADDING;

    // Clear
    ctx.clearRect(0, 0, W, H);

    if (!data || data.length === 0) {
      ctx.fillStyle = colors.text;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data', W / 2, H / 2);
      return;
    }

    const plotW = W - pad.left - pad.right;
    const plotH = H - pad.top  - pad.bottom;

    if (plotW < 10 || plotH < 10) return;

    // Data ranges
    const visitors = data.map((d) => d.visitors);
    const revenues = data.map((d) => d.revenue);
    const maxV = niceMax(Math.max(...visitors));
    const maxR = niceMax(Math.max(...revenues));

    // Coordinate helpers
    const xOf = (i) => pad.left + (i / (data.length - 1)) * plotW;
    const yOfV = (v) => pad.top + plotH - (v / maxV) * plotH;
    const yOfR = (r) => pad.top + plotH - (r / maxR) * plotH;

    // ---- Gridlines ----
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);

    for (let t = 0; t <= TICK_COUNT; t++) {
      const y = pad.top + (t / TICK_COUNT) * plotH;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // ---- Axes ----
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth   = 1;

    // Left axis
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + plotH);
    ctx.stroke();

    // Bottom axis
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top + plotH);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    // Right axis
    ctx.beginPath();
    ctx.moveTo(pad.left + plotW, pad.top);
    ctx.lineTo(pad.left + plotW, pad.top + plotH);
    ctx.stroke();

    // ---- Y-axis labels (left — visitors) ----
    ctx.fillStyle  = colors.text;
    ctx.font       = `${Math.max(10, Math.min(12, plotW / 30))}px sans-serif`;
    ctx.textAlign  = 'right';
    ctx.textBaseline = 'middle';

    for (let t = 0; t <= TICK_COUNT; t++) {
      const val = maxV * (1 - t / TICK_COUNT);
      const y   = pad.top + (t / TICK_COUNT) * plotH;
      ctx.fillText(formatNumber(val), pad.left - 6, y);

      // Tick mark
      ctx.strokeStyle = colors.axis;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(pad.left - 4, y);
      ctx.lineTo(pad.left,     y);
      ctx.stroke();
    }

    // ---- Y-axis labels (right — revenue) ----
    ctx.textAlign = 'left';
    for (let t = 0; t <= TICK_COUNT; t++) {
      const val = maxR * (1 - t / TICK_COUNT);
      const y   = pad.top + (t / TICK_COUNT) * plotH;
      ctx.fillStyle = colors.line2;
      ctx.fillText('$' + formatNumber(val), pad.left + plotW + 6, y);
    }

    // ---- X-axis labels (dates) ----
    ctx.fillStyle    = colors.text;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';

    const step = Math.max(1, Math.ceil(data.length / DATE_TICK_MAX));
    for (let i = 0; i < data.length; i += step) {
      const x = xOf(i);
      ctx.fillText(formatDate(data[i].date), x, pad.top + plotH + 8);

      // Tick mark
      ctx.strokeStyle = colors.axis;
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x, pad.top + plotH);
      ctx.lineTo(x, pad.top + plotH + 4);
      ctx.stroke();
    }
    // Always label last point
    const lastX = xOf(data.length - 1);
    ctx.fillStyle = colors.text;
    ctx.fillText(formatDate(data[data.length - 1].date), lastX, pad.top + plotH + 8);

    // ---- Axis titles ----
    const axisFontSize = Math.max(9, Math.min(11, plotW / 40));
    ctx.font = `600 ${axisFontSize}px sans-serif`;

    // Left axis title
    ctx.save();
    ctx.translate(12, pad.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle  = colors.line;
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Visitors', 0, 0);
    ctx.restore();

    // Right axis title
    ctx.save();
    ctx.translate(W - 10, pad.top + plotH / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle  = colors.line2;
    ctx.textAlign  = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Revenue ($)', 0, 0);
    ctx.restore();

    // ---- Filled area under visitors line ----
    ctx.beginPath();
    ctx.moveTo(xOf(0), pad.top + plotH);
    for (let i = 0; i < data.length; i++) {
      ctx.lineTo(xOf(i), yOfV(data[i].visitors));
    }
    ctx.lineTo(xOf(data.length - 1), pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = colors.area;
    ctx.fill();

    // ---- Visitors line ----
    ctx.beginPath();
    ctx.strokeStyle = colors.line;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    for (let i = 0; i < data.length; i++) {
      const x = xOf(i);
      const y = yOfV(data[i].visitors);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();

    // ---- Revenue line ----
    ctx.beginPath();
    ctx.strokeStyle = colors.line2;
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.setLineDash([6, 3]);
    for (let i = 0; i < data.length; i++) {
      const x = xOf(i);
      const y = yOfR(data[i].revenue);
      if (i === 0) ctx.moveTo(x, y);
      else         ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // ---- Legend ----
    const legendY = H - 14;
    const legendX = pad.left;
    const legendFontSize = Math.max(9, Math.min(11, plotW / 35));
    ctx.font = `${legendFontSize}px sans-serif`;
    ctx.textBaseline = 'middle';

    // Visitors swatch
    ctx.fillStyle = colors.line;
    ctx.fillRect(legendX, legendY - 5, 16, 3);
    ctx.fillStyle = colors.text;
    ctx.textAlign = 'left';
    ctx.fillText('Visitors', legendX + 20, legendY);

    // Revenue swatch
    const revLegendX = legendX + 90;
    ctx.strokeStyle = colors.line2;
    ctx.lineWidth   = 2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(revLegendX, legendY - 3);
    ctx.lineTo(revLegendX + 16, legendY - 3);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.text;
    ctx.fillText('Revenue', revLegendX + 20, legendY);
  }
}
