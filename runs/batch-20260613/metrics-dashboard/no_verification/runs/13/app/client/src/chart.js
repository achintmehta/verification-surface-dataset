/**
 * Hand-drawn responsive line chart using SVG.
 *
 * The chart draws into a viewBox sized to the container's current width,
 * and re-renders whenever the container resizes (via ResizeObserver). Because
 * we recompute geometry from the live width on every render, ticks, axis
 * labels, and the full series always fit the chart area at any width.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / pow;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

function formatTick(v) {
  if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
  return String(v);
}

function formatDate(iso) {
  // iso may be a Date string or 'YYYY-MM-DD'
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function createLineChart(container, data, options = {}) {
  const valueKey = options.valueKey || 'visitors';
  let observer;

  function render() {
    const width = Math.max(container.clientWidth || 320, 240);
    // keep a pleasant aspect ratio, clamp height
    const height = Math.max(180, Math.min(360, Math.round(width * 0.42)));

    const margin = { top: 16, right: 16, bottom: 28, left: 46 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    container.innerHTML = '';

    if (!data || data.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'status';
      empty.textContent = 'No time-series data.';
      container.appendChild(empty);
      return;
    }

    const values = data.map((d) => Number(d[valueKey]));
    const maxVal = niceMax(Math.max(...values));
    const minVal = 0;

    const n = data.length;
    const xFor = (i) => margin.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yFor = (v) =>
      margin.top + plotH - ((v - minVal) / (maxVal - minVal || 1)) * plotH;

    const svg = el('svg', {
      class: 'chart-svg',
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height: String(height),
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Time series chart',
    });

    // --- horizontal gridlines + y ticks ---
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const v = minVal + ((maxVal - minVal) * t) / ticks;
      const y = yFor(v);
      svg.appendChild(
        el('line', {
          class: 'chart-grid-line',
          x1: margin.left,
          y1: y,
          x2: margin.left + plotW,
          y2: y,
        })
      );
      svg.appendChild(
        el(
          'text',
          {
            x: margin.left - 8,
            y: y + 3,
            'text-anchor': 'end',
          },
          formatTick(Math.round(v))
        )
      );
    }

    // --- area fill ---
    const lineCmds = data
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${xFor(i)},${yFor(values[i])}`)
      .join(' ');
    const areaCmds =
      `M${xFor(0)},${yFor(minVal)} ` +
      data.map((d, i) => `L${xFor(i)},${yFor(values[i])}`).join(' ') +
      ` L${xFor(n - 1)},${yFor(minVal)} Z`;

    svg.appendChild(el('path', { class: 'chart-series-fill', d: areaCmds }));
    svg.appendChild(el('path', { class: 'chart-series-line', d: lineCmds }));

    // --- x axis line ---
    svg.appendChild(
      el('line', {
        class: 'chart-axis-line',
        x1: margin.left,
        y1: margin.top + plotH,
        x2: margin.left + plotW,
        y2: margin.top + plotH,
      })
    );

    // --- x ticks: pick a sensible number that fits the width ---
    const approxLabelW = 42;
    const maxLabels = Math.max(2, Math.floor(plotW / approxLabelW));
    const step = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i += step) {
      const x = xFor(i);
      svg.appendChild(
        el(
          'text',
          {
            x,
            y: margin.top + plotH + 18,
            'text-anchor': i === 0 ? 'start' : 'middle',
          },
          formatDate(data[i].day)
        )
      );
    }
    // always show the last date
    const lastX = xFor(n - 1);
    svg.appendChild(
      el(
        'text',
        { x: lastX, y: margin.top + plotH + 18, 'text-anchor': 'end' },
        formatDate(data[n - 1].day)
      )
    );

    container.appendChild(svg);
  }

  render();

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => render());
    observer.observe(container);
  } else {
    window.addEventListener('resize', render);
  }

  return {
    render,
    destroy() {
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', render);
    },
  };
}
