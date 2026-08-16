const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function niceMax(value) {
  if (value <= 0) return 10;
  const pow = Math.pow(10, Math.floor(Math.log10(value)));
  const norm = value / pow;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * pow;
}

function formatTick(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 ? 1 : 0) + 'k';
  return String(n);
}

function formatDay(iso) {
  // iso = YYYY-MM-DD -> "M/D"
  const [, m, d] = iso.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

/**
 * Draw a responsive line chart of `data` ([{day, visitors}]) into `container`.
 * Reads the actual measured width of the container and redraws to fit. Call
 * `render()` again on resize.
 */
export function createChart(container, getData) {
  function render() {
    const data = getData();
    container.innerHTML = '';
    if (!data || data.length === 0) return;

    const rect = container.getBoundingClientRect();
    const width = Math.max(240, Math.floor(rect.width));
    const height = Math.max(180, Math.floor(rect.height));

    const margin = { top: 12, right: 14, bottom: 28, left: 46 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;

    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width,
      height,
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': 'Visitors over the last 30 days',
    });

    const maxVal = niceMax(Math.max(...data.map((d) => d.visitors)));
    const n = data.length;

    const xAt = (i) => margin.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v) => margin.top + plotH - (v / maxVal) * plotH;

    // --- horizontal gridlines + y labels ---
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxVal / yTicks) * t;
      const y = yAt(val);
      el(
        'line',
        { x1: margin.left, y1: y, x2: margin.left + plotW, y2: y, class: 'chart-grid-line' },
        svg
      );
      const label = el(
        'text',
        { x: margin.left - 8, y: y + 4, 'text-anchor': 'end', class: 'chart-axis-label' },
        svg
      );
      label.textContent = formatTick(Math.round(val));
    }

    // --- x axis line ---
    el(
      'line',
      {
        x1: margin.left,
        y1: margin.top + plotH,
        x2: margin.left + plotW,
        y2: margin.top + plotH,
        class: 'chart-axis-line',
      },
      svg
    );

    // --- x labels: choose a sensible number to avoid overlap ---
    const approxLabelW = 34;
    const maxLabels = Math.max(2, Math.floor(plotW / approxLabelW));
    const stride = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = 0; i < n; i += stride) {
      const x = xAt(i);
      const label = el(
        'text',
        { x, y: margin.top + plotH + 18, 'text-anchor': 'middle', class: 'chart-axis-label' },
        svg
      );
      label.textContent = formatDay(data[i].day);
    }
    // always show last day label
    if ((n - 1) % stride !== 0) {
      const label = el(
        'text',
        {
          x: xAt(n - 1),
          y: margin.top + plotH + 18,
          'text-anchor': 'end',
          class: 'chart-axis-label',
        },
        svg
      );
      label.textContent = formatDay(data[n - 1].day);
    }

    // --- area + line path ---
    let linePath = '';
    data.forEach((d, i) => {
      const x = xAt(i);
      const y = yAt(d.visitors);
      linePath += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ',' + y.toFixed(2) + ' ';
    });

    const areaPath =
      `M${xAt(0).toFixed(2)},${(margin.top + plotH).toFixed(2)} ` +
      data
        .map((d, i) => `L${xAt(i).toFixed(2)},${yAt(d.visitors).toFixed(2)}`)
        .join(' ') +
      ` L${xAt(n - 1).toFixed(2)},${(margin.top + plotH).toFixed(2)} Z`;

    el('path', { d: areaPath, class: 'chart-series-area' }, svg);
    el('path', { d: linePath.trim(), class: 'chart-series-line' }, svg);

    container.appendChild(svg);
  }

  return { render };
}
