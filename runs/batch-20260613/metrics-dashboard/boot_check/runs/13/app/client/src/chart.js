/**
 * Hand-drawn time-series line chart on a canvas.
 *
 * Responsibilities:
 *  - Render `data` ({ date, visitors }[]) as a line chart with axes,
 *    gridlines and labeled ticks.
 *  - Stay crisp on HiDPI screens (scales backing store by devicePixelRatio).
 *  - Redraw to fit its container whenever the container resizes.
 *  - Pull colors from CSS custom properties so theme changes restyle internals.
 */
export class TimeSeriesChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.host = canvas.parentElement;
    this.data = [];

    this._ro = new ResizeObserver(() => this.draw());
    this._ro.observe(this.host);
    // Also handle viewport resizes that may not change host box immediately.
    this._onResize = () => this.draw();
    window.addEventListener('resize', this._onResize);
  }

  setData(data) {
    this.data = Array.isArray(data) ? data : [];
    this.draw();
  }

  _colors() {
    const cs = getComputedStyle(document.documentElement);
    const get = (name, fallback) => {
      const v = cs.getPropertyValue(name).trim();
      return v || fallback;
    };
    return {
      axis: get('--chart-axis', '#b6bfd0'),
      grid: get('--chart-grid', '#e9edf5'),
      line: get('--chart-line', '#3b6ef5'),
      fill: get('--chart-fill', 'rgba(59,110,245,0.12)'),
      label: get('--chart-label', '#5a6577'),
    };
  }

  draw() {
    const canvas = this.canvas;
    const host = this.host;
    if (!host) return;

    const rect = host.getBoundingClientRect();
    const cssW = Math.max(1, Math.floor(rect.width));
    const cssH = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const colors = this._colors();
    const data = this.data;

    if (!data || data.length === 0) {
      ctx.fillStyle = colors.label;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data', cssW / 2, cssH / 2);
      return;
    }

    // Layout / padding. Keep enough room for axis labels at small widths.
    const padLeft = 48;
    const padRight = 12;
    const padTop = 12;
    const padBottom = 26;

    const plotW = Math.max(1, cssW - padLeft - padRight);
    const plotH = Math.max(1, cssH - padTop - padBottom);
    const x0 = padLeft;
    const y0 = padTop;

    const values = data.map((d) => d.visitors);
    let minV = Math.min(...values);
    let maxV = Math.max(...values);
    if (minV === maxV) {
      minV -= 1;
      maxV += 1;
    }
    // Pad the value range a touch.
    const range = maxV - minV;
    minV = Math.max(0, minV - range * 0.1);
    maxV = maxV + range * 0.1;

    const xFor = (i) =>
      data.length === 1
        ? x0 + plotW / 2
        : x0 + (i / (data.length - 1)) * plotW;
    const yFor = (v) => y0 + plotH - ((v - minV) / (maxV - minV)) * plotH;

    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    // --- Horizontal gridlines + Y tick labels ---
    const yTicks = 4;
    ctx.lineWidth = 1;
    for (let t = 0; t <= yTicks; t++) {
      const v = minV + (t / yTicks) * (maxV - minV);
      const y = yFor(v);
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x0 + plotW, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = colors.label;
      ctx.textAlign = 'right';
      ctx.fillText(this._fmtCompact(v), x0 - 8, y);
    }

    // --- Axes ---
    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + 0.5, y0);
    ctx.lineTo(x0 + 0.5, y0 + plotH);
    ctx.lineTo(x0 + plotW, y0 + plotH);
    ctx.stroke();

    // --- X tick labels (a few evenly spaced dates) ---
    const desiredXLabels = Math.min(
      data.length,
      Math.max(2, Math.floor(plotW / 70))
    );
    const step = Math.max(1, Math.round((data.length - 1) / (desiredXLabels - 1)));
    ctx.fillStyle = colors.label;
    ctx.textBaseline = 'top';
    for (let i = 0; i < data.length; i += step) {
      const x = xFor(i);
      const label = this._fmtDate(data[i].date);
      // Keep edge labels inside the plot area.
      let align = 'center';
      if (i === 0) align = 'left';
      if (i >= data.length - step) align = 'right';
      ctx.textAlign = align;
      const lx = i === 0 ? x0 : i >= data.length - step ? x0 + plotW : x;
      ctx.fillText(label, lx, y0 + plotH + 7);
    }

    // --- Area fill ---
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(values[0]));
    for (let i = 1; i < data.length; i++) ctx.lineTo(xFor(i), yFor(values[i]));
    ctx.lineTo(xFor(data.length - 1), y0 + plotH);
    ctx.lineTo(xFor(0), y0 + plotH);
    ctx.closePath();
    ctx.fillStyle = colors.fill;
    ctx.fill();

    // --- Series line ---
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(values[0]));
    for (let i = 1; i < data.length; i++) ctx.lineTo(xFor(i), yFor(values[i]));
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // --- Points (only when there is room) ---
    if (plotW / data.length > 14) {
      ctx.fillStyle = colors.line;
      for (let i = 0; i < data.length; i++) {
        ctx.beginPath();
        ctx.arc(xFor(i), yFor(values[i]), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  _fmtCompact(n) {
    if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
    return String(Math.round(n));
  }

  _fmtDate(iso) {
    // iso = YYYY-MM-DD
    const parts = String(iso).split('-');
    if (parts.length < 3) return iso;
    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    const m = months[Number(parts[1]) - 1] || '';
    return `${m} ${Number(parts[2])}`;
  }

  destroy() {
    this._ro.disconnect();
    window.removeEventListener('resize', this._onResize);
  }
}
