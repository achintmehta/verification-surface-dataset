/** API client for the metrics dashboard backend. */

const API_BASE = "/api";

export interface SummaryData {
  total_visitors: number;
  total_revenue: number;
  best_day: string | null;
  best_day_visitors: number;
  seven_day_trend: number;
}

export interface TimeseriesPoint {
  date: string;
  visitors: number;
  revenue: number;
}

export interface Category {
  id: number;
  name: string;
  value: number;
}

export interface RecentItem {
  id: number;
  name: string;
  category: string;
  value: number;
  created_at: string;
}

export interface Settings {
  theme: "light" | "dark";
}

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export function getSummary(): Promise<SummaryData> {
  return fetchJSON<SummaryData>("/summary");
}

export function getTimeseries(): Promise<TimeseriesPoint[]> {
  return fetchJSON<TimeseriesPoint[]>("/timeseries");
}

export function getCategories(): Promise<Category[]> {
  return fetchJSON<Category[]>("/categories");
}

export function getRecent(): Promise<RecentItem[]> {
  return fetchJSON<RecentItem[]>("/recent");
}

export function getSettings(): Promise<Settings> {
  return fetchJSON<Settings>("/settings");
}

export async function putSettings(settings: Settings): Promise<Settings> {
  const res = await fetch(`${API_BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<Settings>;
}
