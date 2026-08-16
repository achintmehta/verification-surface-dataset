const API_BASE = '/api';

export interface SummaryData {
  totalVisitors: number;
  totalRevenue: number;
  bestDay: { date: string; visitors: number } | null;
  sevenDayTrend: number;
}

export interface TimeseriesPoint {
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

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function getSummary(): Promise<SummaryData> {
  return fetchJSON<SummaryData>(`${API_BASE}/summary`);
}

export function getTimeseries(): Promise<TimeseriesPoint[]> {
  return fetchJSON<TimeseriesPoint[]>(`${API_BASE}/timeseries`);
}

export function getCategories(): Promise<CategoryData[]> {
  return fetchJSON<CategoryData[]>(`${API_BASE}/categories`);
}

export function getRecent(): Promise<RecentItem[]> {
  return fetchJSON<RecentItem[]>(`${API_BASE}/recent`);
}

export function getSettings(): Promise<SettingsData> {
  return fetchJSON<SettingsData>(`${API_BASE}/settings`);
}

export async function putSettings(settings: SettingsData): Promise<SettingsData> {
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
