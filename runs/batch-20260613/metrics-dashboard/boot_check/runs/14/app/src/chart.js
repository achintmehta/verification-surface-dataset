// Hand-drawn SVG line chart that redraws to fit its container.
const SVG_NS = 'http://www.w3.org/2000/svg';

export function createChart(container, getData) {
  let data = getData() || [];

  function setData(next) {
    data = next || [];
    render();
  }

  function el(name, attrs) {
    const node = document.createElementNS(SVG_NS, name);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function render() {
    const width = Math.max(220, container.clientWidth || 320);
    // Maintain a pleasant aspect ratio, but cap height.
    const height = Math.max(180, Math.min(320, Math.round(width * 0.5)));

    container.innerHTML = '';

    if (!data || data.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'panel-empty';
      empty.textContent = 'No time-series data available.';
      container.appendChild(empty);
      return;
    }

    const padL = 48;
    const padR = 12;
    const padT = 12;
    const padB = 28;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const values = data.map((d) => d.visitors);
    const maxV = Math.max(...values);
    const minV = Math.min(...values);
    const yMax = niceCeil(maxV);
    const yMin = 0;

    const svg = el('svg', {
      class: 'chart-svg',
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height: String(height),
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
      'aria-label': '30-day visitors time series'
    });

    const xFor = (i) => padL + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
    const yFor = (v) => padT + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH;

    // Y gridlines + labels (5 ticks)
    const yTicks = 4;
    for (let t = 0; t <= yTicks; t++) {
      const v = yMin + ((yMax - yMin) * t) / yTicks;
      const y = yFor(v);
      svg.appendChild(el('line', { class: 'chart-grid-line', x1: padL, y1: y, x2: width - padR, y2: y }));
      const label = el('text', {
        class: 'chart-axis-label',
        x: padL - 6,
        y: y + 3,
        'text-anchor': 'end'
      });
      label.textContent = formatTick(v);
      svg.appendChild(label);
    }

    // Y axis line
    svg.appendChild(el('line', { class: 'chart-axis-line', x1: padL, y1: padT, x2: padL, y2: padT + plotH }));
    // X axis line
    svg.appendChild(el('line', { class: 'chart-axis-line', x1: padL, y1: padT + plotH, x2: width - padR, y2: padT + plotH }));

    // X tick labels: show ~5 evenly spaced dates
    const xTickCount = Math.min(5, data.length);
    for (let t = 0; t < xTickCount; t++) {
      const idx = Math.round((t / (xTickCount - 1 || 1)) * (data.length - 1));
      const x = xFor(idx);
      const label = el('text', {
        class: 'chart-axis-label',
        x: x,
        y: padT + plotH + 18,
        'text-anchor': t === 0 ? 'start' : t === xTickCount - 1 ? 'end' : 'middle'
      });
      label.textContent = formatDate(data[idx].day);
      svg.appendChild(label);
    }

    // Area + line path
    let linePath = '';
    let areaPath = '';
    data.forEach((d, i) => {
      const x = xFor(i);
      const y = yFor(d.visitors);
      linePath += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
      areaPath += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
    });
    const x0 = xFor(0);
    const xN = xFor(data.length - 1);
    const yBase = padT + plotH;
    areaPath = `M${x0} ${yBase} ` + linePath.replace(/^M/, 'L') + `L${xN} ${yBase} Z`;

    svg.appendChild(el('path', { class: 'chart-series-area', d: areaPath }));
    svg.appendChild(el('path', { class: 'chart-series-line', d: linePath.trim() }));

    container.appendChild(svg);
  }

  function niceCeil(v) {
    if (v <= 0) return 10;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    let nice;
    if (norm <= 1) nice = 1;
    else if (norm <= 2) nice = 2;
    else if (norm <= 5) nice = 5;
    else nice = 10;
    return nice * mag;
  }

  function formatTick(v) {
    if (v >= 1000) return (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k';
    return String(Math.round(v));
  }

  function formatDate(day) {
    const d = new Date(day + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  // Redraw on container resize.
  let rafId = null;
  const ro = new ResizeObserver(() => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(render);
  });
  ro.observe(container);

  // Also redraw on window resize as a fallback.
  window.addEventListener('resize', () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(render);
  });

  render();

  return { setData, render };
}
