export function drawChart(canvas, data) {
  const ctx = canvas.getContext('2d');
  
  // Handle high DPI displays
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = rect.height;
  
  ctx.clearRect(0, 0, width, height);
  
  if (!data || data.length === 0) return;
  
  // Get CSS variables for colors
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue('--chart-line').trim();
  const gridColor = style.getPropertyValue('--chart-grid').trim();
  const textColor = style.getPropertyValue('--chart-text').trim();
  
  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  // Find min/max
  const maxVal = Math.max(...data.map(d => parseFloat(d.revenue)));
  const minVal = 0; // Start y-axis at 0
  
  // Draw grid and Y-axis labels
  ctx.font = '12px sans-serif';
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minVal + (maxVal - minVal) * (i / yTicks);
    const y = padding.top + chartHeight - (chartHeight * (i / yTicks));
    
    // Grid line
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    
    // Label
    ctx.fillText(Math.round(val).toLocaleString(), padding.left - 10, y);
  }
  
  // Draw X-axis labels (sparse)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((data.length - 1) * (i / xTicks));
    const d = data[index];
    if (!d) continue;
    
    const x = padding.left + (chartWidth * (index / (data.length - 1)));
    const dateStr = new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    
    ctx.fillText(dateStr, x, height - padding.bottom + 10);
  }
  
  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * (i / (data.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * ((parseFloat(d.revenue) - minVal) / (maxVal - minVal)));
    
    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  
  ctx.stroke();
}