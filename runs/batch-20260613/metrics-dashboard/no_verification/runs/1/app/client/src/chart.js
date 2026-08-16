/**
 * Hand-drawn time-series line chart on a <canvas> element.
 *
 * Features:
 *  - Draws axes, gridlines, labeled ticks, and the 30-day series.
 *  - Reads CSS custom properties for all colours so it respects the theme.
 *  - Re-renders on container resize via ResizeObserver.
 *  - Nothing is drawn outside the chart area (clip region enforced).
 */

export class TimeseriesChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{date: string, visitors: number}>} data
   */
  constructor(canvas, data) {
    this._canvas = canvas;
    this._data = data;
    this._ro = null;
    this._rafId = null;

    this._bindResize();
    this._render();
  }

  /** Replace data and re-render */
  update(data) {
    this._data = data;
    this._render();
  }

  /** Re-render (called by ResizeObserver and theme changes) */
  redraw() {
    this._render();
  }

  destroy() {
    if (this._ro) this._ro.disconnect();
    if (this._rafId) cancelAnimationFrame(this._rafId);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _bindResize() {
    this._ro = new ResizeObserver(() => {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = requestAnimationFrame(() => this._render());
    });
    this._ro.observe(this._canvas.parentElement);
  }

  _getCSSVar(name) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
  }

  _render() {
    const canvas = this._canvas;
    const container = canvas.parentElement;
    if (!container) return;

    // ── Size the canvas to its container (device-pixel-ratio aware) ─────────
    const dpr = window.devicePixelRatio || 1;
    const cssW = container.clientWidth;
    const cssH = container.clientHeight;

    if (cssW === 0 || cssH === 0) return;

    canvas.width  = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width  = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const W = cssW;
    const H = cssH;

    // ── Colours from CSS vars ────────────────────────────────────────────────
    const clrBg     = this._getCSSVar('--color-surface');
    const clrGrid   = this._getCSSVar('--color-chart-grid');
    const clrAxis   = this._getCSSVar('--color-chart-axis');
    const clrLabel  = this._getCSSVar('--color-chart-label');
    const clrLine   = this._getCSSVar('--color-chart-line');
    const clrFill   = this._getCSSVar('--color-chart-fill');
    const clrDot    = this._getCSSVar('--color-chart-dot');
    const clrDotBg  = this._getCSSVar('--color-chart-dot-bg');

    // ── Margins — leave room for axis labels ─────────────────────────────────
    // Dynamically scale margins for small containers
    const isNarrow = W < 400;
    const marginTop    = 16;
    const marginRight  = isNarrow ? 8 : 16;
    const marginBottom = isNarrow ? 36 : 44;
    const marginLeft   = isNarrow ? 44 : 56;

    const plotW = W - marginLeft - marginRight;
    const plotH = H - marginTop  - marginBottom;

    if (plotW <= 0 || plotH <= 0) return;

    // ── Clear ────────────────────────────────────────────────────────────────
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = clrBg;
    ctx.fillRect(0, 0, W, H);

    const data = this._data;
    if (!data || data.length === 0) {
      ctx.fillStyle = clrLabel;
      ctx.font = `14px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.fillText('No data', W / 2, H / 2);
      return;
    }

    // ── Value range ──────────────────────────────────────────────────────────
    const values = data.map((d) => d.visitors);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    const padding = (rawMax - rawMin) * 0.1 || 100;
    const yMin = Math.max(0, rawMin - padding);
    const yMax = rawMax + padding;

    // ── Helpers ──────────────────────────────────────────────────────────────
    const xScale = (i) => marginLeft + (i / (data.length - 1)) * plotW;
    const yScale = (v) => marginTop + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // ── Clip to plot area ────────────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.rect(marginLeft, marginTop, plotW, plotH);
    ctx.clip();

    // ── Filled area under the line ───────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(xScale(0), yScale(data[0].visitors));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(xScale(i), yScale(data[i].visitors));
    }
    ctx.lineTo(xScale(data.length - 1), marginTop + plotH);
    ctx.lineTo(xScale(0), marginTop + plotH);
    ctx.closePath();
    ctx.fillStyle = clrFill;
    ctx.fill();

    // ── Line ─────────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(xScale(0), yScale(data[0].visitors));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(xScale(i), yScale(data[i].visitors));
    }
    ctx.strokeStyle = clrLine;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.restore(); // end clip

    // ── Y-axis gridlines & labels ────────────────────────────────────────────
    const yTickCount = isNarrow ? 4 : 5;
    const fontSize = isNarrow ? 10 : 11;
    ctx.font = `${fontSize}px ${getComputedStyle(document.body).fontFamily}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (let t = 0; t <= yTickCount; t++) {
      const v = yMin + ((yMax - yMin) * t) / yTickCount;
      const y = yScale(v);

      // Gridline
      ctx.beginPath();
      ctx.moveTo(marginLeft, y);
      ctx.lineTo(marginLeft + plotW, y);
      ctx.strokeStyle = clrGrid;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = clrLabel;
      ctx.fillText(formatK(v), marginLeft - 6, y);
    }

    // ── X-axis tick labels ───────────────────────────────────────────────────
    // Show ~6 evenly-spaced date labels
    const xTickCount = isNarrow ? 4 : 6;
    const step = Math.max(1, Math.floor((data.length - 1) / xTickCount));

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = clrLabel;

    for (let i = 0; i < data.length; i += step) {
      const x = xScale(i);
      const label = formatDate(data[i].date, isNarrow);

      // Tick mark
      ctx.beginPath();
      ctx.moveTo(x, marginTop + plotH);
      ctx.lineTo(x, marginTop + plotH + 4);
      ctx.strokeStyle = clrAxis;
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillText(label, x, marginTop + plotH + 7);
    }

    // ── Axes ─────────────────────────────────────────────────────────────────
    ctx.beginPath();
    ctx.moveTo(marginLeft, marginTop);
    ctx.lineTo(marginLeft, marginTop + plotH);
    ctx.lineTo(marginLeft + plotW, marginTop + plotH);
    ctx.strokeStyle = clrAxis;
    ctx.lineWidth = 1;
    ctx.stroke();

    // ── Dots on data points (only if not too many / not too narrow) ──────────
    if (data.length <= 30 && plotW / data.length > 6) {
      const dotR = isNarrow ? 2 : 3;
      for (let i = 0; i < data.length; i++) {
        const x = xScale(i);
        const y = yScale(data[i].visitors);
        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = clrDotBg;
        ctx.fill();
        ctx.strokeStyle = clrDot;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatK(n) {
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return Math.round(n).toString();
}

function formatDate(dateStr, short = false) {
  // dateStr is "YYYY-MM-DD" (possibly with time component — take first 10 chars)
  const s = String(dateStr).slice(0, 10);
  const parts = s.split('-');
  if (parts.length < 3) return s;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  const months = short
    ? ['J','F','M','A','M','J','J','A','S','O','N','D']
    : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[m - 1]} ${d}`;
}
