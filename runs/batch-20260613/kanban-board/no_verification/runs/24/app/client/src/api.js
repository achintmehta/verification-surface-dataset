const BASE = "/api";

export async function fetchBoard() {
  const res = await fetch(`${BASE}/board`);
  if (!res.ok) throw new Error("Failed to fetch board");
  return res.json();
}

export async function createCard(columnId, text) {
  const res = await fetch(`${BASE}/cards`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ columnId, text }),
  });
  if (!res.ok) throw new Error("Failed to create card");
  return res.json();
}

export async function moveCard(cardId, columnId, afterId, beforeId) {
  const body = { columnId };
  if (afterId) body.afterId = afterId;
  if (beforeId) body.beforeId = beforeId;

  const res = await fetch(`${BASE}/cards/${cardId}/move`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("Failed to move card");
  return res.json();
}

export async function deleteCard(cardId) {
  const res = await fetch(`${BASE}/cards/${cardId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete card");
  return res.json();
}
