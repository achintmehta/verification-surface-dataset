const API_BASE = '/api';

export interface SummaryData {
  totalVisitors: number;
  totalRevenue: number;
  bestDay: { date: string; visitors: number } | null;
  trendPercent: number;
}

export interface TimeSeriesPoint {
  date: string;
  visitors: number;
  revenue: number;
}

export interface CategoryData {
  name: string;
  value: number;
}

export interface RecentItem {
  name: string;
  category: string;
  value: number;
  createdAt: string;
}

export interface SettingsData {
  theme: 'light' | 'dark';
}

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export async function getSummary(): Promise<SummaryData> {
  return fetchJSON<SummaryData>('/summary');
}

export async function getTimeseries(): Promise<TimeSeriesPoint[]> {
  return fetchJSON<TimeSeriesPoint[]>('/timeseries');
}

export async function getCategories(): Promise<CategoryData[]> {
  return fetchJSON<CategoryData[]>('/categories');
}

export async function getRecent(): Promise<RecentItem[]> {
  return fetchJSON<RecentItem[]>('/recent');
}

export async function getSettings(): Promise<SettingsData> {
  return fetchJSON<SettingsData>('/settings');
}

export async function updateSettings(settings: SettingsData): Promise<SettingsData> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<SettingsData>;
}
