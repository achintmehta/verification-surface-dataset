import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = []; // all labels in the system
let activeFilterLabelIds = new Set(); // client-side filter
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuCardId = null; // which card has its label-assign menu open

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

function contrastColor(hex) {
  const c = hex.replace('#', '');
  const full = c.length === 3 ? c[0]+c[0]+c[1]+c[1]+c[2]+c[2] : c;
  const r = parseInt(full.substr(0,2),16);
  const g = parseInt(full.substr(2,2),16);
  const b = parseInt(full.substr(4,2),16);
  const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
  return lum > 0.5 ? '#000000' : '#ffffff';
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="manage-labels-btn" title="Manage Labels">🏷️ Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
    ${cardLabelMenuCardId ? renderCardLabelMenu() : ''}
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
        return `<button class="filter-chip ${active ? 'active' : ''}" data-label-id="${escapeHtml(label.id)}"
          style="background:${active ? escapeHtml(label.color) : '#e2e8f0'};color:${active ? contrastColor(label.color) : '#334155'};border-color:${escapeHtml(label.color)}"
        >${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilterLabelIds.size > 0 ? '<button class="filter-clear" id="clear-filter">Clear</button>' : ''}
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
        ${column.cards.map((card) => renderCard(card, cardMatchesFilter(card))).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, visible) {
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="card-label-chip" style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>`
  ).join('');

  return `
    <article class="card ${visible ? '' : 'card-hidden'}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage card labels">🏷️</button>
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal" id="label-manager">
        <div class="modal-header">
          <h3>Manage Labels</h3>
          <button class="modal-close" id="close-label-manager">&times;</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="text" name="name" placeholder="Label name…" autocomplete="off" required />
          <input type="color" name="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${allLabels.length === 0 ? '<p class="label-empty">No labels yet.</p>' : ''}
          ${allLabels.map((label) => `
            <div class="label-row" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip-preview" style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
              <input type="text" class="label-rename-input" data-label-id="${escapeHtml(label.id)}" value="${escapeHtml(label.name)}" />
              <input type="color" class="label-recolor-input" data-label-id="${escapeHtml(label.id)}" value="${escapeHtml(label.color)}" />
              <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}" title="Save">✓</button>
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑️</button>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function renderCardLabelMenu() {
  const cardInfo = findCard(cardLabelMenuCardId);
  if (!cardInfo) return '';
  const card = cardInfo.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  return `
    <div class="modal-overlay" id="card-label-overlay">
      <div class="modal modal-small" id="card-label-menu">
        <div class="modal-header">
          <h3>Card Labels</h3>
          <button class="modal-close" id="close-card-label-menu">&times;</button>
        </div>
        <div class="card-label-list">
          ${allLabels.length === 0 ? '<p class="label-empty">No labels available. Create labels first.</p>' : ''}
          ${allLabels.map((label) => {
            const assigned = assignedIds.has(label.id);
            return `
              <label class="card-label-option ${assigned ? 'assigned' : ''}">
                <input type="checkbox" ${assigned ? 'checked' : ''} data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" class="card-label-checkbox" />
                <span class="label-chip-preview" style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
              </label>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;
}

function bindEvents() {
  // Manage labels button
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    labelManagerOpen = true;
    cardLabelMenuCardId = null;
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

  // Create label
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    try {
      const resp = await fetch(`${API_BASE}/api/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        setStatus(`Label error: ${err.error}`, true);
        return;
      }
      form.elements.name.value = '';
    } catch (error) {
      setStatus(`Label create failed: ${error.message}`, true);
    }
  });

  // Label save (rename/recolor)
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const nameInput = document.querySelector(`.label-rename-input[data-label-id="${labelId}"]`);
      const colorInput = document.querySelector(`.label-recolor-input[data-label-id="${labelId}"]`);
      if (!nameInput || !colorInput) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameInput.value.trim(), color: colorInput.value }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Label error: ${err.error}`, true);
        }
      } catch (error) {
        setStatus(`Label update failed: ${error.message}`, true);
      }
    });
  });

  // Label delete
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Label error: ${err.error}`, true);
        }
      } catch (error) {
        setStatus(`Label delete failed: ${error.message}`, true);
      }
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardLabelMenuCardId = btn.dataset.cardId;
      labelManagerOpen = false;
      render();
    });
  });

  // Close card label menu
  document.getElementById('close-card-label-menu')?.addEventListener('click', () => {
    cardLabelMenuCardId = null;
    render();
  });
  document.getElementById('card-label-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'card-label-overlay') {
      cardLabelMenuCardId = null;
      render();
    }
  });

  // Card label checkboxes
  document.querySelectorAll('.card-label-checkbox').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const cardId = cb.dataset.cardId;
      const labelId = cb.dataset.labelId;
      try {
        if (cb.checked) {
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
        setStatus(`Label assign failed: ${error.message}`, true);
      }
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const labelId = chip.dataset.labelId;
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

  // Existing card events: add-card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (text) {
        input.value = '';
        await createCard(form.dataset.columnId, text);
      }
    });
  });

  // Existing drag and drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      draggedCardId = null;
      el.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
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
      if (afterElement) {
        list.insertBefore(dragging, afterElement);
      } else {
        list.appendChild(dragging);
      }
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;

      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getNeighbors(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();

      try {
        const response = await fetch(`${API_BASE}/api/cards/${draggedCardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        await loadBoard();
      }
    });
  });
}

function getDragAfterElement(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = card;
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
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (labelManagerOpen) {
      render();
    }
    // Re-render filter bar if visible
    if (allLabels.length > 0) render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    if (message.label) {
      const idx = allLabels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) allLabels[idx] = message.label;
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
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

  if (message.type === 'card-label-assigned' || message.type === 'card-label-unassigned') {
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  // Existing mutation handling
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
  render();
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  allLabels = await response.json();
  allLabels.sort((a, b) => a.name.localeCompare(b.name));
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
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
