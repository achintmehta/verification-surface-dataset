import type { Board, Card, CreateCardRequest, MoveCardRequest } from '../../shared/types.js';

const API_BASE = '/api';

export async function fetchBoard(): Promise<Board> {
  const res = await fetch(`${API_BASE}/board`);
  if (!res.ok) {
    throw new Error(`Failed to fetch board: ${res.statusText}`);
  }
  return res.json() as Promise<Board>;
}

export async function createCard(data: CreateCardRequest): Promise<Card> {
  const res = await fetch(`${API_BASE}/cards`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Failed to create card: ${res.statusText}`);
  }
  return res.json() as Promise<Card>;
}

export async function moveCard(cardId: string, data: MoveCardRequest): Promise<Card> {
  const res = await fetch(`${API_BASE}/cards/${cardId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(`Failed to move card: ${res.statusText}`);
  }
  return res.json() as Promise<Card>;
}
