// ── Types ───────────────────────────────────────────────────────────────────

export interface Card {
  id: string;
  column_id: string;
  text: string;
  position: number;
  created_at: string;
}

export interface Column {
  id: string;
  title: string;
  position: number;
  cards: Card[];
}

// ── API calls ───────────────────────────────────────────────────────────────

const BASE = "/api";

export async function fetchBoard(): Promise<Column[]> {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error(`Failed to fetch board: ${res.statusText}`);
  return res.json();
}

export async function createCard(
  columnId: string,
  text: string
): Promise<Card> {
  const res = await fetch(`${BASE}/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error(`Failed to create card: ${res.statusText}`);
  return res.json();
}

export async function moveCard(
  cardId: string,
  columnId: string,
  afterId: string | null,
  beforeId: string | null
): Promise<Card> {
  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, afterId, beforeId }),
  });
  if (!res.ok) throw new Error(`Failed to move card: ${res.statusText}`);
  return res.json();
}
