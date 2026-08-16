/**
 * chart.js — Hand-drawn SVG time-series line chart.
 *
 * Usage:
 *   const chart = createChart(wrapperElement);
 *   chart.render(data, metric);   // data: [{date, visitors, revenue}]
 *   chart.destroy();              // removes ResizeObserver
 *
 * The chart:
 *  - Draws axes, gridlines, labeled ticks, and the series line + area fill.
 *  - Redraws automatically when the wrapper element is resized.
 *  - Respects CSS custom properties for all colours (theme-aware).
 *  - Never draws outside the SVG viewport.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, cls = '') {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (cls) e.setAttribute('class', cls);
  return e;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name).trim();
}

// ── Number formatting ─────────────────────────────────────────────────────────
function fmtShort(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}

// ── Nice axis ticks ───────────────────────────────────────────────────────────
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

function niceRange(min, max, targetTicks = 5) {
  const step   = niceStep(max - min || 1, targetTicks);
  const nMin   = Math.floor(min / step) * step;
  const nMax   = Math.ceil(max  / step) * step;
  const ticks  = [];
  for (let v = nMin; v <= nMax + step * 0.001; v += step) {
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return { min: nMin, max: nMax, ticks };
}

// ── Date label formatting ─────────────────────────────────────────────────────
function fmtDateShort(dateStr) {
  // dateStr: "YYYY-MM-DD"
  const [, m, d] = dateStr.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// ── Main factory ──────────────────────────────────────────────────────────────
export function createChart(wrapper) {
  let _data   = [];
  let _metric = 'visitors';
  let _svg    = null;
  let _tooltip = null;
  let _ro     = null;
  let _rafId  = null;

  // Create tooltip element
  _tooltip = document.createElement('div');
  _tooltip.className = 'chart-tooltip hidden';
  wrapper.appendChild(_tooltip);

  function getValues() {
    return _data.map(d => d[_metric]);
  }

  function draw() {
    if (!_data.length) return;

    const W = wrapper.clientWidth  || 400;
    const H = wrapper.clientHeight || 260;

    // Margins — generous left for Y labels, bottom for X labels
    const margin = {
      top:    16,
      right:  16,
      bottom: 40,
      left:   56,
    };

    // On very narrow containers shrink left margin
    const effectiveLeft = W < 300 ? 44 : margin.left;
    const plotW = W - effectiveLeft - margin.right;
    const plotH = H - margin.top - margin.bottom;

    if (plotW <= 0 || plotH <= 0) return;

    const values = getValues();
    const yRange = niceRange(
      Math.min(...values) * 0.95,
      Math.max(...values) * 1.05,
      5
    );

    // ── Scales ────────────────────────────────────────────────────────────────
    const xScale = (i) =>
      effectiveLeft + (i / (_data.length - 1 || 1)) * plotW;

    const yScale = (v) =>
      margin.top + plotH - ((v - yRange.min) / (yRange.max - yRange.min || 1)) * plotH;

    // ── Build SVG ─────────────────────────────────────────────────────────────
    // Remove old SVG if present
    if (_svg) _svg.remove();

    _svg = el('svg', {
      width:   W,
      height:  H,
      viewBox: `0 0 ${W} ${H}`,
      role:    'img',
      'aria-label': `Time-series chart of ${_metric} over 30 days`,
    });

    // ── Gridlines ─────────────────────────────────────────────────────────────
    const gridG = el('g', {}, 'chart-gridlines');
    for (const tick of yRange.ticks) {
      const y = yScale(tick);
      if (y < margin.top - 1 || y > margin.top + plotH + 1) continue;
      gridG.appendChild(el('line', {
        x1: effectiveLeft, y1: y,
        x2: effectiveLeft + plotW, y2: y,
      }, 'chart-gridline'));
    }
    _svg.appendChild(gridG);

    // ── Area fill ─────────────────────────────────────────────────────────────
    const baseY = yScale(yRange.min);
    let areaD = `M ${xScale(0)} ${baseY}`;
    areaD += ` L ${xScale(0)} ${yScale(values[0])}`;
    for (let i = 1; i < _data.length; i++) {
      areaD += ` L ${xScale(i)} ${yScale(values[i])}`;
    }
    areaD += ` L ${xScale(_data.length - 1)} ${baseY} Z`;
    _svg.appendChild(el('path', { d: areaD }, 'chart-series-area'));

    // ── Series line ───────────────────────────────────────────────────────────
    let lineD = `M ${xScale(0)} ${yScale(values[0])}`;
    for (let i = 1; i < _data.length; i++) {
      lineD += ` L ${xScale(i)} ${yScale(values[i])}`;
    }
    _svg.appendChild(el('path', { d: lineD }, 'chart-series-line'));

    // ── Y axis ────────────────────────────────────────────────────────────────
    _svg.appendChild(el('line', {
      x1: effectiveLeft, y1: margin.top,
      x2: effectiveLeft, y2: margin.top + plotH,
    }, 'chart-axis-line'));

    // Y tick labels
    const yLabelG = el('g', {}, 'chart-y-labels');
    for (const tick of yRange.ticks) {
      const y = yScale(tick);
      if (y < margin.top - 4 || y > margin.top + plotH + 4) continue;
      const t = el('text', {
        x:            effectiveLeft - 8,
        y:            y,
        'text-anchor': 'end',
        'dominant-baseline': 'middle',
      }, 'chart-tick-label');
      t.textContent = fmtShort(tick);
      yLabelG.appendChild(t);
    }
    _svg.appendChild(yLabelG);

    // ── X axis ────────────────────────────────────────────────────────────────
    _svg.appendChild(el('line', {
      x1: effectiveLeft, y1: margin.top + plotH,
      x2: effectiveLeft + plotW, y2: margin.top + plotH,
    }, 'chart-axis-line'));

    // X tick labels — show every N-th label so they don't overlap
    const xLabelG = el('g', {}, 'chart-x-labels');
    const approxLabelWidth = 48; // px per label
    const maxLabels = Math.max(2, Math.floor(plotW / approxLabelWidth));
    const step = Math.ceil(_data.length / maxLabels);

    for (let i = 0; i < _data.length; i += step) {
      const x = xScale(i);
      const t = el('text', {
        x,
        y: margin.top + plotH + 16,
        'text-anchor': 'middle',
      }, 'chart-tick-label');
      t.textContent = fmtDateShort(_data[i].date);
      xLabelG.appendChild(t);

      // Tick mark
      _svg.appendChild(el('line', {
        x1: x, y1: margin.top + plotH,
        x2: x, y2: margin.top + plotH + 5,
      }, 'chart-axis-line'));
    }
    // Always include the last date
    const lastIdx = _data.length - 1;
    if (lastIdx % step !== 0) {
      const x = xScale(lastIdx);
      const t = el('text', {
        x,
        y: margin.top + plotH + 16,
        'text-anchor': 'middle',
      }, 'chart-tick-label');
      t.textContent = fmtDateShort(_data[lastIdx].date);
      xLabelG.appendChild(t);
      _svg.appendChild(el('line', {
        x1: x, y1: margin.top + plotH,
        x2: x, y2: margin.top + plotH + 5,
      }, 'chart-axis-line'));
    }
    _svg.appendChild(xLabelG);

    // ── Dots (only if not too many points) ────────────────────────────────────
    if (_data.length <= 30) {
      const dotsG = el('g', {}, 'chart-dots');
      for (let i = 0; i < _data.length; i++) {
        dotsG.appendChild(el('circle', {
          cx: xScale(i),
          cy: yScale(values[i]),
          r:  3,
        }, 'chart-dot'));
      }
      _svg.appendChild(dotsG);
    }

    // ── Invisible hit-area overlay for tooltip ────────────────────────────────
    const hitG = el('g', {}, 'chart-hit-areas');
    const colW = plotW / _data.length;
    for (let i = 0; i < _data.length; i++) {
      const rect = el('rect', {
        x:      xScale(i) - colW / 2,
        y:      margin.top,
        width:  colW,
        height: plotH,
        fill:   'transparent',
        'data-index': i,
      });
      hitG.appendChild(rect);
    }
    _svg.appendChild(hitG);

    // ── Tooltip vertical line (hidden by default) ─────────────────────────────
    const vLine = el('line', {
      x1: 0, y1: margin.top,
      x2: 0, y2: margin.top + plotH,
      visibility: 'hidden',
    }, 'chart-tooltip-line');
    _svg.appendChild(vLine);

    // ── Tooltip interaction ───────────────────────────────────────────────────
    function showTooltip(i, svgX) {
      const d = _data[i];
      const v = values[i];
      const label = _metric === 'revenue'
        ? `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
        : v.toLocaleString('en-US');

      _tooltip.innerHTML =
        `<div class="tooltip-date">${fmtDateShort(d.date)}</div>` +
        `<div class="tooltip-value">${label}</div>`;
      _tooltip.classList.remove('hidden');

      // Position tooltip: prefer right of cursor, flip left if near edge
      const tipW = _tooltip.offsetWidth  || 100;
      const tipH = _tooltip.offsetHeight || 50;
      let tx = svgX + 12;
      if (tx + tipW > W - 4) tx = svgX - tipW - 12;
      const ty = Math.max(4, Math.min(H - tipH - 4, yScale(v) - tipH / 2));
      _tooltip.style.left = `${tx}px`;
      _tooltip.style.top  = `${ty}px`;

      // Move vertical line
      vLine.setAttribute('x1', svgX);
      vLine.setAttribute('x2', svgX);
      vLine.setAttribute('visibility', 'visible');
    }

    function hideTooltip() {
      _tooltip.classList.add('hidden');
      vLine.setAttribute('visibility', 'hidden');
    }

    _svg.addEventListener('mousemove', (e) => {
      const rect = _svg.getBoundingClientRect();
      const mx   = e.clientX - rect.left;
      // Find nearest data point
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < _data.length; i++) {
        const dist = Math.abs(xScale(i) - mx);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      showTooltip(best, xScale(best));
    });

    _svg.addEventListener('mouseleave', hideTooltip);

    // Touch support
    _svg.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const rect = _svg.getBoundingClientRect();
      const mx   = e.touches[0].clientX - rect.left;
      let best = 0, bestDist = Infinity;
      for (let i = 0; i < _data.length; i++) {
        const dist = Math.abs(xScale(i) - mx);
        if (dist < bestDist) { bestDist = dist; best = i; }
      }
      showTooltip(best, xScale(best));
    }, { passive: false });

    _svg.addEventListener('touchend', hideTooltip);

    wrapper.appendChild(_svg);
  }

  function scheduleDraw() {
    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(draw);
  }

  // ResizeObserver — redraws whenever the wrapper changes size
  _ro = new ResizeObserver(() => scheduleDraw());
  _ro.observe(wrapper);

  return {
    render(data, metric = 'visitors') {
      _data   = data;
      _metric = metric;
      scheduleDraw();
    },

    setMetric(metric) {
      _metric = metric;
      scheduleDraw();
    },

    destroy() {
      if (_ro)    { _ro.disconnect(); _ro = null; }
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
      if (_svg)   { _svg.remove(); _svg = null; }
      if (_tooltip) { _tooltip.remove(); _tooltip = null; }
    },
  };
}
