import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, index, card: column.cards[index] };
  }
  return null;
}

function removeCardEverywhere(cardId) {
  let removed = null;
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      const [card] = column.cards.splice(index, 1);
      removed = card;
    }
  }
  return removed;
}

function normalizeBoard(nextBoard) {
  const seen = new Set();
  const columns = [...(nextBoard.columns || [])]
    .map((column) => ({
      ...column,
      cards: [...(column.cards || [])]
        .filter((card) => {
          if (seen.has(card.id)) return false;
          seen.add(card.id);
          return true;
        })
        .map((card) => ({ ...card, labels: [...(card.labels || [])].sort(compareLabels) }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function compareLabels(a, b) {
  return String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (selectedLabelIds.size === 0) return true;
  return (card.labels || []).some((label) => selectedLabelIds.has(label.id));
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${renderLabelPanel()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelPanel() {
  return `
    <section class="labels-panel" aria-label="Labels">
      <div class="label-tools">
        <div>
          <h2>Labels</h2>
          <p>Create labels, assign them to cards, or filter your view.</p>
        </div>
        <form class="create-label">
          <input name="name" type="text" maxlength="80" placeholder="New label" autocomplete="off" required />
          <input name="color" type="color" value="#2563eb" aria-label="Label color" />
          <button type="submit">Create</button>
        </form>
      </div>
      <div class="filter-bar">
        <strong>Filter:</strong>
        <div class="filter-options">
          ${labels.map(renderFilterOption).join('') || '<span class="empty-hint">No labels yet</span>'}
        </div>
        ${selectedLabelIds.size ? '<button type="button" class="clear-filter">Clear</button>' : ''}
      </div>
      <div class="label-list">
        ${labels.map(renderLabelEditor).join('') || '<span class="empty-hint">Create a label to start tagging cards.</span>'}
      </div>
    </section>
  `;
}

function renderFilterOption(label) {
  const checked = selectedLabelIds.has(label.id) ? 'checked' : '';
  return `
    <label class="filter-chip" style="--label-color:${escapeAttr(label.color)}">
      <input type="checkbox" class="filter-label" value="${escapeAttr(label.id)}" ${checked} />
      <span>${escapeHtml(label.name)}</span>
    </label>
  `;
}

function renderLabelEditor(label) {
  return `
    <form class="label-editor" data-label-id="${escapeAttr(label.id)}">
      <span class="label-swatch" style="background:${escapeAttr(label.color)}"></span>
      <input name="name" type="text" maxlength="80" value="${escapeAttr(label.name)}" required />
      <input name="color" type="color" value="${escapeAttr(label.color)}" aria-label="Color for ${escapeAttr(label.name)}" />
      <button type="submit">Save</button>
      <button type="button" class="delete-label">Delete</button>
    </form>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
        ${visibleCards.length === 0 && selectedLabelIds.size > 0 ? '<div class="empty-column">No matching cards</div>' : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">
        ${(card.labels || []).map(renderCardLabel).join('')}
      </div>
      <details class="card-label-menu">
        <summary>Labels</summary>
        <div class="card-label-options">
          ${labels.map((label) => renderCardLabelOption(card, label)).join('') || '<span class="empty-hint">No labels available</span>'}
        </div>
      </details>
    </article>
  `;
}

function renderCardLabel(label) {
  return `<span class="label-chip" style="--label-color:${escapeAttr(label.color)}">${escapeHtml(label.name)}</span>`;
}

function renderCardLabelOption(card, label) {
  const checked = (card.labels || []).some((cardLabel) => cardLabel.id === label.id) ? 'checked' : '';
  return `
    <label class="card-label-option">
      <input type="checkbox" class="card-label-toggle" data-card-id="${escapeAttr(card.id)}" value="${escapeAttr(label.id)}" ${checked} />
      <span class="mini-chip" style="--label-color:${escapeAttr(label.color)}">${escapeHtml(label.name)}</span>
    </label>
  `;
}

function bindEvents() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await createCard(form.dataset.columnId, text);
    });
  });

  const createLabelForm = document.querySelector('.create-label');
  createLabelForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = createLabelForm.elements.name.value.trim();
    const color = createLabelForm.elements.color.value;
    if (!name) return;
    await createLabel(name, color);
    createLabelForm.reset();
    createLabelForm.elements.color.value = '#2563eb';
  });

  document.querySelectorAll('.label-editor').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      await updateLabel(form.dataset.labelId, form.elements.name.value.trim(), form.elements.color.value);
    });
    form.querySelector('.delete-label').addEventListener('click', async () => {
      const label = labels.find((item) => item.id === form.dataset.labelId);
      if (!label) return;
      if (window.confirm(`Delete label "${label.name}" from all cards?`)) await deleteLabel(label.id);
    });
  });

  document.querySelectorAll('.filter-label').forEach((input) => {
    input.addEventListener('change', () => {
      if (input.checked) selectedLabelIds.add(input.value);
      else selectedLabelIds.delete(input.value);
      render();
    });
  });
  document.querySelector('.clear-filter')?.addEventListener('click', () => {
    selectedLabelIds.clear();
    render();
  });

  document.querySelectorAll('.card-label-toggle').forEach((input) => {
    input.addEventListener('change', async () => {
      await setCardLabel(input.dataset.cardId, input.value, input.checked);
    });
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      if (event.target.closest('input, button, summary, details, label')) {
        event.preventDefault();
        return;
      }
      draggedCardId = card.dataset.cardId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.cards.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      const after = getCardAfterPointer(list, event.clientY);
      if (after) list.insertBefore(dragging, after);
      else list.appendChild(dragging);
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getDropNeighbors(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });
}

function getCardAfterPointer(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  return cards.reduce(
    (closest, child) => {
      const rect = child.getBoundingClientRect();
      const offset = y - rect.top - rect.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function getDropNeighbors(list, cardId) {
  const ids = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId);
  const index = ids.indexOf(cardId);
  return {
    afterId: index > 0 ? ids[index - 1] : null,
    beforeId: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  };
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const existing = removeCardEverywhere(cardId);
  if (!existing) return;
  const target = board.columns.find((column) => column.id === columnId);
  if (!target) return;
  const afterIndex = afterId ? target.cards.findIndex((card) => card.id === afterId) : -1;
  const beforeIndex = beforeId ? target.cards.findIndex((card) => card.id === beforeId) : -1;
  let insertAt = target.cards.length;
  if (afterIndex !== -1) insertAt = afterIndex + 1;
  else if (beforeIndex !== -1) insertAt = beforeIndex;
  target.cards.splice(insertAt, 0, { ...existing, column_id: columnId, optimistic: true });
}

async function createCard(columnId, text) {
  try {
    const response = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
  } catch (error) {
    setStatus(`Create failed: ${error.message}`, true);
  }
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
    labels = [...labels, await response.json()].sort(compareLabels);
    render();
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
    const label = await response.json();
    labels = labels.map((item) => (item.id === id ? label : item)).sort(compareLabels);
    board = normalizeBoard({
      columns: board.columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) => ({
          ...card,
          labels: (card.labels || []).map((cardLabel) => (cardLabel.id === id ? label : cardLabel)),
        })),
      })),
    });
    render();
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
    selectedLabelIds.delete(id);
    labels = labels.filter((label) => label.id !== id);
    board = normalizeBoard({
      columns: board.columns.map((column) => ({
        ...column,
        cards: column.cards.map((card) => ({ ...card, labels: (card.labels || []).filter((label) => label.id !== id) })),
      })),
    });
    render();
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function setCardLabel(cardId, labelId, enabled) {
  try {
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels${enabled ? '' : `/${encodeURIComponent(labelId)}`}`,
      {
        method: enabled ? 'POST' : 'DELETE',
        headers: enabled ? { 'Content-Type': 'application/json' } : undefined,
        body: enabled ? JSON.stringify({ labelId }) : undefined,
      }
    );
    if (!response.ok) throw new Error((await response.json()).error || 'Update card labels failed');
    const found = findCard(cardId);
    if (found) {
      const label = labels.find((item) => item.id === labelId);
      if (enabled && label && !(found.card.labels || []).some((item) => item.id === labelId)) {
        found.card.labels = [...(found.card.labels || []), label].sort(compareLabels);
      } else if (!enabled) {
        found.card.labels = (found.card.labels || []).filter((item) => item.id !== labelId);
      }
      render();
    }
  } catch (error) {
    setStatus(`Card label failed: ${error.message}`, true);
    await loadBoard();
  }
}

function applyMutation(message) {
  if (message.labels) {
    labels = [...message.labels].sort(compareLabels);
    selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labels.some((label) => label.id === id)));
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = { ...message.card, labels: message.card.labels || [] };
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const [boardResponse, labelsResponse] = await Promise.all([fetch(`${API_BASE}/api/board`), fetch(`${API_BASE}/api/labels`)]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  if (!labelsResponse.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardResponse.json());
  labels = (await labelsResponse.json()).sort(compareLabels);
  selectedLabelIds = new Set([...selectedLabelIds].filter((id) => labels.some((label) => label.id === id)));
  render();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  eventSource.addEventListener('connected', () => setStatus('Live'));
  eventSource.addEventListener('mutation', (event) => {
    applyMutation(JSON.parse(event.data));
  });
  eventSource.onerror = () => setStatus('Reconnecting…', true);
}

function setStatus(text, warn = false) {
  const status = document.querySelector('#status');
  if (status) {
    status.textContent = text;
    status.classList.toggle('warn', warn);
  }
  clearTimeout(statusTimer);
  if (warn) {
    statusTimer = setTimeout(() => setStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Reconnecting…'), 4000);
  }
}

async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
