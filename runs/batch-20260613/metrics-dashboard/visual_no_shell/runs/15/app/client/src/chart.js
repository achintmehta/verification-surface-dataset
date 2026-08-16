const SVG_NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text != null) node.textContent = text;
  return node;
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  const frac = value / base;
  let nice;
  if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * base;
}

function shortNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(Math.round(n));
}

/**
 * Renders a responsive line chart into `container` from a series of
 * { day, visitors } points. Redraws on container resize via ResizeObserver.
 */
export function createLineChart(container, series) {
  let data = series || [];

  function render() {
    const width = Math.max(240, Math.floor(container.clientWidth || 320));
    // Maintain a pleasant aspect ratio but cap height.
    const height = Math.max(180, Math.min(320, Math.round(width * 0.5)));

    const padL = 44;
    const padR = 12;
    const padT = 12;
    const padB = 28;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    container.innerHTML = '';
    const svg = el('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height: String(height),
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': '30 day visitors time series',
    });

    if (!data.length) {
      svg.appendChild(
        el('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'chart-axis-text' }, 'No data')
      );
      container.appendChild(svg);
      return;
    }

    const maxVal = niceCeil(Math.max(...data.map((d) => d.visitors)));
    const n = data.length;

    const xFor = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yFor = (v) => padT + plotH - (v / maxVal) * plotH;

    // Horizontal gridlines + y axis labels (5 ticks).
    const ticks = 5;
    for (let t = 0; t <= ticks; t++) {
      const val = (maxVal / ticks) * t;
      const y = yFor(val);
      svg.appendChild(
        el('line', { x1: padL, y1: y, x2: padL + plotW, y2: y, class: 'chart-grid-line' })
      );
      svg.appendChild(
        el(
          'text',
          { x: padL - 6, y: y + 3, 'text-anchor': 'end', class: 'chart-axis-text' },
          shortNum(val)
        )
      );
    }

    // X axis baseline.
    svg.appendChild(
      el('line', { x1: padL, y1: padT + plotH, x2: padL + plotW, y2: padT + plotH, class: 'chart-axis-line' })
    );

    // X tick labels: show roughly every ~6th day to avoid crowding.
    const labelEvery = Math.ceil(n / Math.max(4, Math.floor(plotW / 60)));
    for (let i = 0; i < n; i += labelEvery) {
      const d = data[i];
      const x = xFor(i);
      const md = d.day.slice(5); // MM-DD
      svg.appendChild(
        el('text', { x, y: padT + plotH + 16, 'text-anchor': 'middle', class: 'chart-axis-text' }, md)
      );
    }

    // Area fill under the line.
    let areaPath = `M ${xFor(0)} ${padT + plotH} `;
    data.forEach((d, i) => {
      areaPath += `L ${xFor(i)} ${yFor(d.visitors)} `;
    });
    areaPath += `L ${xFor(n - 1)} ${padT + plotH} Z`;
    svg.appendChild(el('path', { d: areaPath, class: 'chart-fill' }));

    // Line series.
    let linePath = '';
    data.forEach((d, i) => {
      linePath += (i === 0 ? 'M ' : 'L ') + xFor(i) + ' ' + yFor(d.visitors) + ' ';
    });
    svg.appendChild(el('path', { d: linePath, class: 'chart-series' }));

    container.appendChild(svg);
  }

  const ro = new ResizeObserver(() => render());
  ro.observe(container);
  window.addEventListener('resize', render);
  render();

  return {
    update(newSeries) {
      data = newSeries || [];
      render();
    },
    destroy() {
      ro.disconnect();
      window.removeEventListener('resize', render);
    },
  };
}
