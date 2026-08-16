export function drawChart(canvas, data) {
  if (!data || data.length === 0) return;

  const ctx = canvas.getContext('2d');
  const container = canvas.parentElement;
  
  // Handle high DPI displays
  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  
  ctx.scale(dpr, dpr);
  
  const width = rect.width;
  const height = rect.height;
  
  // Get CSS variables for colors
  const style = getComputedStyle(document.documentElement);
  const lineColor = style.getPropertyValue('--chart-line').trim() || '#3b82f6';
  const gridColor = style.getPropertyValue('--chart-grid').trim() || '#e4e4e7';
  const textColor = style.getPropertyValue('--chart-text').trim() || '#71717a';
  
  ctx.clearRect(0, 0, width, height);
  
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  
  const maxRevenue = Math.max(...data.map(d => d.revenue));
  const minRevenue = 0; // Start Y axis at 0
  
  // Draw Grid and Y-axis labels
  ctx.fillStyle = textColor;
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = minRevenue + (maxRevenue - minRevenue) * (i / yTicks);
    const y = padding.top + chartHeight - (chartHeight * (i / yTicks));
    
    // Grid line
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    
    // Label
    ctx.fillText(formatCompact(val), padding.left - 10, y);
  }
  
  // Draw X-axis labels (dates)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const index = Math.floor((data.length - 1) * (i / xTicks));
    const d = data[index];
    const x = padding.left + (chartWidth * (index / (data.length - 1)));
    
    const dateStr = new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    ctx.fillText(dateStr, x, height - padding.bottom + 10);
  }
  
  // Draw Line
  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  
  data.forEach((d, i) => {
    const x = padding.left + (chartWidth * (i / (data.length - 1)));
    const y = padding.top + chartHeight - (chartHeight * (d.revenue / maxRevenue));
    
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  
  ctx.stroke();
}

function formatCompact(val) {
  return new Intl.NumberFormat('en-US', { notation: 'compact', compactDisplay: 'short' }).format(val);
}