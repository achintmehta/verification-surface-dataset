import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilters = new Set(); // label IDs for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuCardId = null; // card id whose label-assign menu is open

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

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="manage-labels-btn">🏷️ Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    ${labelManagerOpen ? renderLabelManager() : ''}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${cardLabelMenuCardId ? renderCardLabelMenu() : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label-text">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilters.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-filter-label-id="${escapeHtml(label.id)}" style="--chip-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilters.size > 0 ? '<button class="filter-clear-btn" id="clear-filters">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-overlay" id="label-manager-overlay">
      <div class="label-manager">
        <div class="label-manager-header">
          <h3>Manage Labels</h3>
          <button id="close-label-manager" class="label-manager-close">&times;</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input type="text" name="name" placeholder="Label name…" maxlength="50" required autocomplete="off" />
          <input type="color" name="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${allLabels.map((label) => `
            <div class="label-list-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip-preview" style="background: ${escapeHtml(label.color)}"></span>
              <input type="text" class="label-edit-name" data-label-id="${escapeHtml(label.id)}" value="${escapeHtml(label.name)}" maxlength="50" />
              <input type="color" class="label-edit-color" data-label-id="${escapeHtml(label.id)}" value="${escapeHtml(label.color)}" />
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete label">&times;</button>
            </div>
          `).join('')}
          ${allLabels.length === 0 ? '<p class="label-empty">No labels yet.</p>' : ''}
        </div>
      </div>
    </div>
  `;
}

function renderCardLabelMenu() {
  const found = findCard(cardLabelMenuCardId);
  if (!found) return '';
  const card = found.card;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  return `
    <div class="card-label-menu-overlay" id="card-label-menu-overlay">
      <div class="card-label-menu">
        <div class="label-manager-header">
          <h3>Labels for card</h3>
          <button id="close-card-label-menu" class="label-manager-close">&times;</button>
        </div>
        <div class="card-label-list">
          ${allLabels.map((label) => {
            const assigned = cardLabelIds.includes(label.id);
            return `
              <div class="card-label-option ${assigned ? 'assigned' : ''}" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}">
                <span class="label-chip-preview" style="background: ${escapeHtml(label.color)}"></span>
                <span>${escapeHtml(label.name)}</span>
                <span class="card-label-check">${assigned ? '✓' : ''}</span>
              </div>
            `;
          }).join('')}
          ${allLabels.length === 0 ? '<p class="label-empty">Create labels first using the Labels button.</p>' : ''}
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
        ${column.cards.map((card) => renderCard(card, cardMatchesFilter(card))).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, visible) {
  const labelsHtml = (card.labels || []).map((label) =>
    `<span class="card-label-chip" style="background: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
  ).join('');

  return `
    <article class="card ${visible ? '' : 'card-hidden'}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷️</button>
    </article>
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
      input.value = '';
      await createCard(form.dataset.columnId, text);
    });
  });

  // Drag and drop
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
      document.querySelectorAll('.drop-target').forEach((col) => col.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');
      const after = getDragAfterElement(zone, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (dragging) {
        if (after) zone.insertBefore(dragging, after);
        else zone.appendChild(dragging);
      }
    });
    zone.addEventListener('dragleave', (event) => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop-target');
    });
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      const cardId = event.dataTransfer.getData('text/plain') || draggedCardId;
      if (!cardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = getNeighborIds(zone, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      try {
        await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
      }
    });
  });

  // Manage labels button
  const manageLabelBtn = document.getElementById('manage-labels-btn');
  if (manageLabelBtn) {
    manageLabelBtn.addEventListener('click', () => {
      labelManagerOpen = !labelManagerOpen;
      cardLabelMenuCardId = null;
      render();
    });
  }

  // Close label manager
  const closeLabelManager = document.getElementById('close-label-manager');
  if (closeLabelManager) {
    closeLabelManager.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }

  // Close on overlay click
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        labelManagerOpen = false;
        render();
      }
    });
  }

  // Label create form
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = createForm.elements.name;
      const colorInput = createForm.elements.color;
      const name = nameInput.value.trim();
      const color = colorInput.value.trim();
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Label create failed: ${err.error}`, true);
          return;
        }
        nameInput.value = '';
      } catch (error) {
        setStatus(`Label create failed: ${error.message}`, true);
      }
    });
  }

  // Label edit (name - on blur/enter)
  document.querySelectorAll('.label-edit-name').forEach((input) => {
    const handler = async () => {
      const labelId = input.dataset.labelId;
      const newName = input.value.trim();
      if (!newName) return;
      const label = allLabels.find((l) => l.id === labelId);
      if (label && newName === label.name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Rename failed: ${err.error}`, true);
        }
      } catch (error) {
        setStatus(`Rename failed: ${error.message}`, true);
      }
    };
    input.addEventListener('blur', handler);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
  });

  // Label edit (color)
  document.querySelectorAll('.label-edit-color').forEach((input) => {
    input.addEventListener('change', async () => {
      const labelId = input.dataset.labelId;
      const newColor = input.value.trim();
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ color: newColor }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Recolor failed: ${err.error}`, true);
        }
      } catch (error) {
        setStatus(`Recolor failed: ${error.message}`, true);
      }
    });
  });

  // Label delete
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      try {
        await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
      } catch (error) {
        setStatus(`Delete failed: ${error.message}`, true);
      }
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      cardLabelMenuCardId = btn.dataset.cardId;
      render();
    });
  });

  // Close card label menu
  const closeCardLabelMenu = document.getElementById('close-card-label-menu');
  if (closeCardLabelMenu) {
    closeCardLabelMenu.addEventListener('click', () => {
      cardLabelMenuCardId = null;
      render();
    });
  }

  const cardLabelOverlay = document.getElementById('card-label-menu-overlay');
  if (cardLabelOverlay) {
    cardLabelOverlay.addEventListener('click', (e) => {
      if (e.target === cardLabelOverlay) {
        cardLabelMenuCardId = null;
        render();
      }
    });
  }

  // Card label options (toggle assign/unassign)
  document.querySelectorAll('.card-label-option').forEach((opt) => {
    opt.addEventListener('click', async () => {
      const cardId = opt.dataset.cardId;
      const labelId = opt.dataset.labelId;
      const isAssigned = opt.classList.contains('assigned');
      try {
        if (isAssigned) {
          await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
        } else {
          await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
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
  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }
}

function getDragAfterElement(zone, y) {
  const cards = [...zone.querySelectorAll('.card:not(.dragging)')];
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

function getNeighborIds(list, cardId) {
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

function updateLabelsFromBoard() {
  // Rebuild allLabels from the board data and any existing allLabels
  // We keep allLabels authoritative from GET /api/labels and SSE events
}

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    if (message.label && !allLabels.find((l) => l.id === message.label.id)) {
      allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const idx = allLabels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) {
      allLabels[idx] = message.label;
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    // Also update label info on cards in the board
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          for (let i = 0; i < card.labels.length; i++) {
            if (card.labels[i].id === message.label.id) {
              card.labels[i] = { ...message.label };
            }
          }
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
