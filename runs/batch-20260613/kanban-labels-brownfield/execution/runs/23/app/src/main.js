import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilters = new Set(); // label IDs currently used as filters
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let showLabelManager = false;
let labelAssignCardId = null; // card ID currently showing label-assign popover

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
  if (activeFilters.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const filterId of activeFilters) {
    if (cardLabelIds.includes(filterId)) return true;
  }
  return false;
}

function contrastColor(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
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
      <div class="topbar-right">
        <button id="manage-labels-btn" class="manage-labels-btn">🏷️ Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    ${showLabelManager ? renderLabelManager() : ''}
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
      <span class="filter-label-text">Filter by label:</span>
      ${allLabels.map((label) => `
        <button class="filter-chip ${activeFilters.has(label.id) ? 'active' : ''}"
                data-filter-label-id="${escapeHtml(label.id)}"
                style="background:${escapeHtml(label.color)}; color:${contrastColor(label.color)}">
          ${escapeHtml(label.name)}
        </button>
      `).join('')}
      ${activeFilters.size > 0 ? '<button class="filter-clear" id="clear-filters">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-overlay" id="label-manager-overlay">
      <div class="label-manager">
        <div class="label-manager-header">
          <h3>Manage Labels</h3>
          <button class="label-manager-close" id="close-label-manager">✕</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input name="name" type="text" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${allLabels.map((label) => `
            <div class="label-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip-preview" style="background:${escapeHtml(label.color)}; color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
              <input type="text" class="label-edit-name" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" />
              <input type="color" class="label-edit-color" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" />
              <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}">Save</button>
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
            </div>
          `).join('')}
          ${allLabels.length === 0 ? '<p class="no-labels">No labels yet. Create one above.</p>' : ''}
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
  const hidden = !cardMatchesFilter(card);
  const labelChips = (card.labels || []).map((l) => `
    <span class="card-label-chip" style="background:${escapeHtml(l.color)}; color:${contrastColor(l.color)}">${escapeHtml(l.name)}</span>
  `).join('');

  const isAssigning = labelAssignCardId === card.id;

  return `
    <article class="card ${hidden ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelChips ? `<div class="card-labels">${labelChips}</div>` : ''}
      <button class="card-label-toggle" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷️</button>
      ${isAssigning ? renderLabelAssignPopover(card) : ''}
    </article>
  `;
}

function renderLabelAssignPopover(card) {
  const assignedIds = new Set((card.labels || []).map((l) => l.id));
  if (allLabels.length === 0) {
    return `<div class="label-assign-popover"><p class="no-labels">No labels available.</p></div>`;
  }
  return `
    <div class="label-assign-popover" data-card-id="${escapeHtml(card.id)}">
      ${allLabels.map((label) => {
        const assigned = assignedIds.has(label.id);
        return `
          <label class="label-assign-option">
            <input type="checkbox" ${assigned ? 'checked' : ''}
                   data-card-id="${escapeHtml(card.id)}"
                   data-label-id="${escapeHtml(label.id)}"
                   class="label-assign-checkbox" />
            <span class="label-chip-preview" style="background:${escapeHtml(label.color)}; color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
          </label>
        `;
      }).join('')}
    </div>
  `;
}

function bindEvents() {
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

  // Drag and drop
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      draggedCardId = card.dataset.cardId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      draggedCardId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.cards.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      const after = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      if (after) list.insertBefore(dragging, after);
      else list.appendChild(dragging);
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getNeighbourIds(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      setStatus('Saving…');
      try {
        await fetch(`${API_BASE}/api/cards/${draggedCardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
      }
    });
  });

  // Label manager button
  document.getElementById('manage-labels-btn')?.addEventListener('click', () => {
    showLabelManager = !showLabelManager;
    render();
  });

  // Close label manager
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    showLabelManager = false;
    render();
  });

  // Label manager overlay click to close
  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'label-manager-overlay') {
      showLabelManager = false;
      render();
    }
  });

  // Create label form
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    const color = e.target.elements.color.value.trim();
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
      e.target.elements.name.value = '';
    } catch (error) {
      setStatus(`Label create failed: ${error.message}`, true);
    }
  });

  // Save label edits
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const nameInput = document.querySelector(`.label-edit-name[data-label-id="${labelId}"]`);
      const colorInput = document.querySelector(`.label-edit-color[data-label-id="${labelId}"]`);
      const name = nameInput?.value.trim();
      const color = colorInput?.value.trim();
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Label error: ${err.error}`, true);
        }
      } catch (error) {
        setStatus(`Label save failed: ${error.message}`, true);
      }
    });
  });

  // Delete label
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      try {
        await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
      } catch (error) {
        setStatus(`Label delete failed: ${error.message}`, true);
      }
    });
  });

  // Card label toggle (show/hide assign popover)
  document.querySelectorAll('.card-label-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      labelAssignCardId = labelAssignCardId === cardId ? null : cardId;
      render();
    });
  });

  // Label assign/unassign checkboxes
  document.querySelectorAll('.label-assign-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      e.stopPropagation();
      const cardId = checkbox.dataset.cardId;
      const labelId = checkbox.dataset.labelId;
      try {
        if (checkbox.checked) {
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

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const labelId = chip.dataset.filterLabelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });

  // Clear filters
  document.getElementById('clear-filters')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Close label assign popover when clicking outside
  document.addEventListener('click', (e) => {
    if (labelAssignCardId && !e.target.closest('.label-assign-popover') && !e.target.closest('.card-label-toggle')) {
      labelAssignCardId = null;
      render();
    }
  }, { once: true });
}

function getDragAfterElement(list, y) {
  const cards = [...list.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const child of cards) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = child;
    }
  }
  return closest;
}

function getNeighbourIds(list, cardId) {
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
    allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const idx = allLabels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) allLabels[idx] = message.label;
    else allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
    // Also update labels on cards in the board
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          const li = card.labels.findIndex((l) => l.id === message.label.id);
          if (li !== -1) card.labels[li] = { ...message.label };
        }
      }
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    allLabels = allLabels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    if (message.board) {
      board = normalizeBoard(message.board);
    } else {
      // Remove label from all cards
      for (const col of board.columns) {
        for (const card of col.cards) {
          if (card.labels) {
            card.labels = card.labels.filter((l) => l.id !== message.labelId);
          }
        }
      }
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
