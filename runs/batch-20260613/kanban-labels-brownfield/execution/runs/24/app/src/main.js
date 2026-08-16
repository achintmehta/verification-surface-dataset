import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilterLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuCardId = null; // which card's label assignment menu is open

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
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
        .map((card) => ({ ...card, labels: card.labels || [] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function cardMatchesFilter(card) {
  if (activeFilterLabelIds.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const filterId of activeFilterLabelIds) {
    if (cardLabelIds.includes(filterId)) return true;
  }
  return false;
}

function getContrastColor(hexColor) {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="manage-labels-btn">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    ${labelManagerOpen ? renderLabelManager() : ''}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-bar-label">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilterLabelIds.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-filter-label-id="${escapeHtml(label.id)}" style="background:${active ? escapeHtml(label.color) : '#e2e8f0'};color:${active ? getContrastColor(label.color) : '#334155'}">${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilterLabelIds.size > 0 ? '<button class="filter-clear" id="clear-filter">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-overlay" id="label-manager-overlay">
      <div class="label-manager">
        <div class="label-manager-header">
          <h3>Manage Labels</h3>
          <button id="close-label-manager" class="close-btn">&times;</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input name="labelName" type="text" placeholder="Label name…" autocomplete="off" maxlength="50" required />
          <input name="labelColor" type="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${allLabels.map((label) => `
            <div class="label-list-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip" style="background:${escapeHtml(label.color)};color:${getContrastColor(label.color)}">${escapeHtml(label.name)}</span>
              <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✎</button>
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">✕</button>
            </div>
          `).join('')}
          ${allLabels.length === 0 ? '<p class="empty-labels">No labels yet.</p>' : ''}
        </div>
      </div>
    </div>
  `;
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${column.cards.map((card) => renderCard(card, column.id)).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, columnId) {
  const hidden = !cardMatchesFilter(card) ? ' card-hidden' : '';
  const cardLabels = card.labels || [];
  const labelsHtml = cardLabels.length > 0
    ? `<div class="card-labels">${cardLabels.map((l) => `<span class="label-chip-small" style="background:${escapeHtml(l.color)};color:${getContrastColor(l.color)}">${escapeHtml(l.name)}</span>`).join('')}</div>`
    : '';
  const isMenuOpen = cardLabelMenuCardId === card.id;
  const menuHtml = isMenuOpen ? renderCardLabelMenu(card) : '';

  return `
    <article class="card${hidden}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${labelsHtml}
      <div class="card-text">${escapeHtml(card.text)}</div>
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
      ${menuHtml}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  if (allLabels.length === 0) {
    return `<div class="card-label-menu"><p class="empty-labels">No labels. Create one first.</p></div>`;
  }
  return `
    <div class="card-label-menu">
      ${allLabels.map((label) => {
        const assigned = cardLabelIds.includes(label.id);
        return `<label class="card-label-option">
          <input type="checkbox" ${assigned ? 'checked' : ''} data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" class="card-label-checkbox" />
          <span class="label-chip-small" style="background:${escapeHtml(label.color)};color:${getContrastColor(label.color)}">${escapeHtml(label.name)}</span>
        </label>`;
      }).join('')}
    </div>
  `;
}

function bindEvents() {
  // Manage labels button
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    labelManagerOpen = !labelManagerOpen;
    render();
  });

  // Close label manager
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    labelManagerOpen = false;
    render();
  });
  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'label-manager-overlay') {
      labelManagerOpen = false;
      render();
    }
  });

  // Create label form
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.labelName.value.trim();
    const color = form.labelColor.value;
    if (!name) return;
    try {
      const resp = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!resp.ok) {
        const data = await resp.json();
        setStatus(data.error || 'Create label failed', true);
        return;
      }
      const label = await resp.json();
      allLabels.push(label);
      render();
    } catch (error) {
      setStatus(`Create label failed: ${error.message}`, true);
    }
  });

  // Edit label buttons
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      const newName = prompt('Rename label:', label.name);
      if (newName === null) return;
      if (newName.trim().length === 0) {
        setStatus('Label name cannot be empty', true);
        return;
      }
      const newColor = prompt('New color (hex, e.g. #ff0000):', label.color);
      if (newColor === null) return;
      if (!/^#[0-9a-fA-F]{6}$/.test(newColor)) {
        setStatus('Invalid hex color', true);
        return;
      }
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName.trim(), color: newColor }),
        });
        if (!resp.ok) {
          const data = await resp.json();
          setStatus(data.error || 'Update label failed', true);
          return;
        }
        const updated = await resp.json();
        const idx = allLabels.findIndex((l) => l.id === labelId);
        if (idx !== -1) allLabels[idx] = updated;
        render();
      } catch (error) {
        setStatus(`Update label failed: ${error.message}`, true);
      }
    });
  });

  // Delete label buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!resp.ok) {
          const data = await resp.json();
          setStatus(data.error || 'Delete label failed', true);
          return;
        }
        allLabels = allLabels.filter((l) => l.id !== labelId);
        activeFilterLabelIds.delete(labelId);
        // Remove this label from all cards in local state
        for (const col of board.columns) {
          for (const card of col.cards) {
            card.labels = (card.labels || []).filter((l) => l.id !== labelId);
          }
        }
        render();
      } catch (error) {
        setStatus(`Delete label failed: ${error.message}`, true);
      }
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.filterLabelId;
      if (activeFilterLabelIds.has(labelId)) {
        activeFilterLabelIds.delete(labelId);
      } else {
        activeFilterLabelIds.add(labelId);
      }
      render();
    });
  });

  // Clear filter
  document.getElementById('clear-filter')?.addEventListener('click', () => {
    activeFilterLabelIds.clear();
    render();
  });

  // Card label toggle buttons (open/close label assignment menu)
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      if (cardLabelMenuCardId === cardId) {
        cardLabelMenuCardId = null;
      } else {
        cardLabelMenuCardId = cardId;
      }
      render();
    });
  });

  // Card label checkboxes
  document.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      e.stopPropagation();
      const cardId = checkbox.dataset.cardId;
      const labelId = checkbox.dataset.labelId;
      const assign = checkbox.checked;
      try {
        if (assign) {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
        } else {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
            method: 'DELETE',
          });
        }
      } catch (error) {
        setStatus(`Label assignment failed: ${error.message}`, true);
      }
    });
  });

  // Close card label menu by clicking outside
  document.addEventListener('click', (e) => {
    if (cardLabelMenuCardId && !e.target.closest('.card-label-menu') && !e.target.closest('.card-label-btn')) {
      cardLabelMenuCardId = null;
      render();
    }
  }, { once: true });

  // Add card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      const columnId = form.dataset.columnId;
      input.value = '';
      await createCard(columnId, text);
    });
  });

  // Drag-and-drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    el.addEventListener('dragend', () => {
      draggedCardId = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((b) => b.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      if (afterElement) list.insertBefore(dragging, afterElement);
      else list.appendChild(dragging);
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getNeighbors(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      try {
        const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
        render();
      }
    });
  });
}

function getDragAfterElement(list, y) {
  const elements = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const el of elements) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = el;
    }
  }
  return closest;
}

function getNeighbors(list, cardId) {
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

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    if (message.label && !allLabels.find((l) => l.id === message.label.id)) {
      allLabels.push(message.label);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    if (message.label) {
      const idx = allLabels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) allLabels[idx] = message.label;
      else allLabels.push(message.label);
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    if (message.labelId) {
      allLabels = allLabels.filter((l) => l.id !== message.labelId);
      activeFilterLabelIds.delete(message.labelId);
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-assigned' || message.type === 'label-unassigned') {
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  // Original mutation handling
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = message.card;
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  allLabels = await response.json();
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
    await Promise.all([loadBoard(), loadLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
