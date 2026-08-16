/**
 * Formatting utilities for numbers, currency, and dates.
 */

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const currencyFmt2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFmt = new Intl.NumberFormat('en-US');

const compactFmt = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const dateShortFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
});

export function formatCurrency(value) {
  return currencyFmt.format(value);
}

export function formatCurrencyFull(value) {
  return currencyFmt2.format(value);
}

export function formatNumber(value) {
  return numberFmt.format(value);
}

export function formatCompact(value) {
  return compactFmt.format(value);
}

export function formatDate(isoString) {
  // isoString may be "2024-01-15" or a full ISO timestamp
  const d = new Date(isoString.length === 10 ? isoString + 'T00:00:00' : isoString);
  return dateFmt.format(d);
}

export function formatDateShort(isoString) {
  const d = new Date(isoString.length === 10 ? isoString + 'T00:00:00' : isoString);
  return dateShortFmt.format(d);
}

export function formatTrend(pct) {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}
