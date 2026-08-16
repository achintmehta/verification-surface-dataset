import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let activeFilterLabelIds = new Set();
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

function cardPassesFilter(card) {
  if (activeFilterLabelIds.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const filterId of activeFilterLabelIds) {
    if (cardLabelIds.includes(filterId)) return true;
  }
  return false;
}

function contrastColor(hex) {
  // Simple luminance check for text color
  const c = hex.replace('#', '');
  const full = c.length === 3 ? c.split('').map(ch => ch + ch).join('') : c;
  const r = parseInt(full.substring(0, 2), 16);
  const g = parseInt(full.substring(2, 4), 16);
  const b = parseInt(full.substring(4, 6), 16);
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
        <button class="btn-labels-manager" id="btn-labels-manager">⚙ Labels</button>
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
  if (labels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${labels.map((l) => {
        const active = activeFilterLabelIds.has(l.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-filter-label-id="${escapeHtml(l.id)}"
          style="background:${active ? escapeHtml(l.color) : '#e2e8f0'};color:${active ? contrastColor(l.color) : '#334155'}">
          ${escapeHtml(l.name)}
        </button>`;
      }).join('')}
      ${activeFilterLabelIds.size > 0 ? '<button class="filter-clear" id="filter-clear">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-overlay" id="label-manager-overlay">
      <div class="label-manager">
        <div class="label-manager-header">
          <h3>Manage Labels</h3>
          <button class="label-manager-close" id="label-manager-close">✕</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input name="name" type="text" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Add</button>
        </form>
        <div class="label-list">
          ${labels.map((l) => `
            <div class="label-item" data-label-id="${escapeHtml(l.id)}">
              <span class="label-chip-preview" style="background:${escapeHtml(l.color)};color:${contrastColor(l.color)}">${escapeHtml(l.name)}</span>
              <input class="label-edit-name" type="text" value="${escapeHtml(l.name)}" data-label-id="${escapeHtml(l.id)}" />
              <input class="label-edit-color" type="color" value="${escapeHtml(l.color)}" data-label-id="${escapeHtml(l.id)}" />
              <button class="label-delete-btn" data-label-id="${escapeHtml(l.id)}" title="Delete label">🗑</button>
            </div>
          `).join('')}
          ${labels.length === 0 ? '<p class="label-empty">No labels yet.</p>' : ''}
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
        ${column.cards.map((card) => renderCard(card, column)).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, column) {
  const hidden = !cardPassesFilter(card);
  const cardLabels = card.labels || [];
  const isMenuOpen = cardLabelMenuCardId === card.id;
  return `
    <article class="card ${hidden ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${cardLabels.length > 0 ? `
        <div class="card-labels">
          ${cardLabels.map((l) => `<span class="card-label-chip" style="background:${escapeHtml(l.color)};color:${contrastColor(l.color)}" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}" title="Click to remove label">${escapeHtml(l.name)} ×</span>`).join('')}
        </div>
      ` : ''}
      <div class="card-actions">
        <button class="card-label-toggle" data-card-id="${escapeHtml(card.id)}" title="Assign labels">🏷</button>
      </div>
      ${isMenuOpen ? renderCardLabelMenu(card) : ''}
    </article>
  `;
}

function renderCardLabelMenu(card) {
  const assignedIds = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="card-label-menu">
      ${labels.map((l) => {
        const assigned = assignedIds.has(l.id);
        return `<button class="card-label-option ${assigned ? 'assigned' : ''}" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}" data-assigned="${assigned}">
          <span class="card-label-option-chip" style="background:${escapeHtml(l.color)};color:${contrastColor(l.color)}">${escapeHtml(l.name)}</span>
          ${assigned ? '✓' : ''}
        </button>`;
      }).join('')}
      ${labels.length === 0 ? '<div class="card-label-menu-empty">No labels. Create one first.</div>' : ''}
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
      input.value = '';
      await createCard(form.dataset.columnId, text);
    });
  });

  // Drag & Drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((d) => d.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');
      const after = getDragAfterElement(zone, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (!dragging) return;
      if (after) {
        zone.insertBefore(dragging, after);
      } else {
        zone.appendChild(dragging);
      }
    });
    zone.addEventListener('dragleave', (event) => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop-target');
    });
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = getNeighborIds(zone, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      try {
        await fetch(`${API_BASE}/api/cards/${draggedCardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
        render();
      }
    });
  });

  // Label manager toggle
  const btnLabelsMgr = document.getElementById('btn-labels-manager');
  if (btnLabelsMgr) {
    btnLabelsMgr.addEventListener('click', () => {
      labelManagerOpen = !labelManagerOpen;
      render();
    });
  }

  // Label manager close
  const closeBtn = document.getElementById('label-manager-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }

  // Label manager overlay click-outside
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
  const labelForm = document.getElementById('label-create-form');
  if (labelForm) {
    labelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = labelForm.elements.name.value.trim();
      const color = labelForm.elements.color.value;
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
        const label = await resp.json();
        labels.push(label);
        labelForm.elements.name.value = '';
        render();
      } catch (error) {
        setStatus(`Label create failed: ${error.message}`, true);
      }
    });
  }

  // Label rename (on blur)
  document.querySelectorAll('.label-edit-name').forEach((input) => {
    input.addEventListener('change', async () => {
      const labelId = input.dataset.labelId;
      const newName = input.value.trim();
      if (!newName) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Rename error: ${err.error}`, true);
          return;
        }
        const updated = await resp.json();
        const idx = labels.findIndex((l) => l.id === labelId);
        if (idx !== -1) labels[idx] = updated;
        render();
      } catch (error) {
        setStatus(`Rename failed: ${error.message}`, true);
      }
    });
  });

  // Label recolor
  document.querySelectorAll('.label-edit-color').forEach((input) => {
    input.addEventListener('change', async () => {
      const labelId = input.dataset.labelId;
      const newColor = input.value;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ color: newColor }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Recolor error: ${err.error}`, true);
          return;
        }
        const updated = await resp.json();
        const idx = labels.findIndex((l) => l.id === labelId);
        if (idx !== -1) labels[idx] = updated;
        render();
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
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Delete error: ${err.error}`, true);
          return;
        }
        labels = labels.filter((l) => l.id !== labelId);
        // Remove from all cards
        for (const col of board.columns) {
          for (const card of col.cards) {
            card.labels = (card.labels || []).filter((l) => l.id !== labelId);
          }
        }
        // Remove from filter
        activeFilterLabelIds.delete(labelId);
        render();
      } catch (error) {
        setStatus(`Delete failed: ${error.message}`, true);
      }
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
      if (activeFilterLabelIds.has(id)) {
        activeFilterLabelIds.delete(id);
      } else {
        activeFilterLabelIds.add(id);
      }
      render();
    });
  });

  // Filter clear
  const clearBtn = document.getElementById('filter-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilterLabelIds.clear();
      render();
    });
  }

  // Card label toggle (open/close assign menu)
  document.querySelectorAll('.card-label-toggle').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      cardLabelMenuCardId = cardLabelMenuCardId === cardId ? null : cardId;
      render();
    });
  });

  // Card label assign/unassign
  document.querySelectorAll('.card-label-option').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      const isAssigned = btn.dataset.assigned === 'true';
      try {
        if (isAssigned) {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
        } else {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
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

  // Card label chip click to remove
  document.querySelectorAll('.card-label-chip').forEach((chip) => {
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = chip.dataset.cardId;
      const labelId = chip.dataset.labelId;
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
      } catch (error) {
        setStatus(`Unassign failed: ${error.message}`, true);
      }
    });
  });

  // Close card label menu on outside click
  document.addEventListener('click', (e) => {
    if (cardLabelMenuCardId && !e.target.closest('.card-label-menu') && !e.target.closest('.card-label-toggle')) {
      cardLabelMenuCardId = null;
      render();
    }
  }, { once: true });
}

function getDragAfterElement(zone, y) {
  const els = [...zone.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const el of els) {
    const box = el.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = el;
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

function updateCardInBoard(updatedCard) {
  for (const col of board.columns) {
    const idx = col.cards.findIndex((c) => c.id === updatedCard.id);
    if (idx !== -1) {
      // Preserve position and column fields, update labels
      col.cards[idx] = { ...col.cards[idx], labels: updatedCard.labels || [] };
      return;
    }
  }
}

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    if (!labels.find((l) => l.id === message.label.id)) {
      labels.push(message.label);
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const idx = labels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) labels[idx] = message.label;
    else labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    // Also update label data on all cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          const li = card.labels.findIndex((l) => l.id === message.label.id);
          if (li !== -1) card.labels[li] = message.label;
        }
      }
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    labels = labels.filter((l) => l.id !== message.labelId);
    activeFilterLabelIds.delete(message.labelId);
    for (const col of board.columns) {
      for (const card of col.cards) {
        card.labels = (card.labels || []).filter((l) => l.id !== message.labelId);
      }
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-assigned' || message.type === 'label-unassigned') {
    if (message.card) {
      updateCardInBoard(message.card);
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
  labels = await response.json();
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
