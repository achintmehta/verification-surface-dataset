// ── Summary stat cards ────────────────────────────────────────────────────────

export function renderSummary(data) {
  // Remove skeleton state
  document.querySelectorAll('.stat-card.skeleton').forEach(el => el.classList.remove('skeleton'));

  // Total visitors
  setText('val-visitors', formatNumber(data.total_visitors));
  setTrend('trend-visitors', '30-day total', '');

  // Total revenue
  setText('val-revenue', formatCurrency(data.total_revenue));
  setTrend('trend-revenue', '30-day total', '');

  // Best day
  const bestDate = data.best_day_date
    ? new Date(data.best_day_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '—';
  setText('val-best-day', formatNumber(data.best_day_visitors));
  setTrend('trend-best-day', `on ${bestDate}`, '');

  // 7-day trend
  const pct = data.trend_pct;
  const trendEl = document.getElementById('val-trend');
  if (trendEl) {
    const arrow = pct > 0 ? '↑' : pct < 0 ? '↓' : '→';
    const sign  = pct > 0 ? '+' : '';
    trendEl.textContent = `${arrow} ${sign}${pct.toFixed(1)}%`;
    const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : '';
    trendEl.className = `stat-value trend-value ${dir}`;
  }
  setTrend('trend-detail', 'vs previous 7 days', '');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function setTrend(id, text, dir) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `stat-trend${dir ? ' ' + dir : ''}`;
}

function formatNumber(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

function formatCurrency(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}
