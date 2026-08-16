/**
 * Stat cards rendering module.
 */

export function renderCards(summary) {
  const visitors = document.getElementById('val-visitors');
  const revenue = document.getElementById('val-revenue');
  const bestday = document.getElementById('val-bestday');
  const bestdayDate = document.getElementById('val-bestday-date');
  const trend = document.getElementById('val-trend');
  const trendIndicator = document.getElementById('trend-indicator');

  if (visitors) {
    visitors.textContent = summary.totalVisitors.toLocaleString();
  }

  if (revenue) {
    revenue.textContent = '$' + summary.totalRevenue.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  if (bestday) {
    bestday.textContent = summary.bestDay.visitors.toLocaleString() + ' visitors';
  }

  if (bestdayDate) {
    const d = new Date(summary.bestDay.date);
    bestdayDate.textContent = d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  if (trend) {
    const pct = summary.sevenDayTrend;
    const sign = pct >= 0 ? '+' : '';
    trend.textContent = sign + pct + '%';
  }

  if (trendIndicator) {
    const pct = summary.sevenDayTrend;
    if (pct >= 0) {
      trendIndicator.textContent = '▲ Trending up';
      trendIndicator.className = 'stat-card__indicator up';
    } else {
      trendIndicator.textContent = '▼ Trending down';
      trendIndicator.className = 'stat-card__indicator down';
    }
  }
}
