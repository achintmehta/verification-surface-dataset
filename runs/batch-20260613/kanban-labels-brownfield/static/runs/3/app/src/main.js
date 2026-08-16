import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ──────────────────────────────────────────────────────────────────

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
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return (
    Number(a.position) - Number(b.position) ||
    String(a.created_at).localeCompare(String(b.created_at)) ||
    a.id.localeCompare(b.id)
  );
}

// ── Filtering ──────────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Render ─────────────────────────────────────────────────────────────────────

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManager()}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) return '';
  const chips = labels
    .map((label) => {
      const active = activeFilters.has(label.id);
      return `<button
        class="filter-chip${active ? ' active' : ''}"
        data-filter-label-id="${escapeHtml(label.id)}"
        style="--chip-color:${escapeHtml(label.color)}"
        title="${active ? 'Remove filter' : 'Filter by'} ${escapeHtml(label.name)}"
      >${escapeHtml(label.name)}</button>`;
    })
    .join('');
  const clearBtn =
    activeFilters.size > 0
      ? `<button class="filter-clear" id="filter-clear-btn">Clear filter</button>`
      : '';
  return `<div class="filter-bar"><span class="filter-label-text">Filter:</span>${chips}${clearBtn}</div>`;
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
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labelChips = (card.labels || [])
    .map(
      (label) =>
        `<span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
    )
    .join('');
  const labelsHtml = labelChips
    ? `<div class="card-labels">${labelChips}</div>`
    : '';
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

// ── Label Manager UI ───────────────────────────────────────────────────────────

function renderLabelManager() {
  return `
    <div id="label-manager-overlay" class="lm-overlay hidden" role="dialog" aria-modal="true" aria-label="Label manager">
      <div class="lm-panel">
        <div class="lm-header">
          <h2>Labels</h2>
          <button class="lm-close" id="lm-close-btn" aria-label="Close">✕</button>
        </div>
        <div class="lm-body">
          <ul class="lm-list" id="lm-list">
            ${labels.map(renderLabelRow).join('')}
          </ul>
          <form class="lm-create-form" id="lm-create-form">
            <input class="lm-name-input" name="name" type="text" maxlength="80" placeholder="New label name…" autocomplete="off" required />
            <input class="lm-color-input" name="color" type="color" value="#2563eb" title="Pick a color" />
            <button type="submit" class="lm-create-btn">Create</button>
          </form>
          <div class="lm-error" id="lm-error"></div>
        </div>
      </div>
    </div>
    <div id="card-label-overlay" class="lm-overlay hidden" role="dialog" aria-modal="true" aria-label="Assign labels">
      <div class="lm-panel lm-panel--sm">
        <div class="lm-header">
          <h2>Assign Labels</h2>
          <button class="lm-close" id="cl-close-btn" aria-label="Close">✕</button>
        </div>
        <div class="lm-body" id="cl-body">
        </div>
      </div>
    </div>
    <button class="manage-labels-btn" id="manage-labels-btn" title="Manage labels">🏷 Labels</button>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="lm-row" data-label-id="${escapeHtml(label.id)}">
      <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="lm-name">${escapeHtml(label.name)}</span>
      <button class="lm-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit label">✏️</button>
      <button class="lm-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete label">🗑</button>
    </li>
  `;
}

function renderCardLabelBody(card) {
  if (labels.length === 0) {
    return '<p class="cl-empty">No labels yet. Create some in the Labels manager.</p>';
  }
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  return `<ul class="cl-list">${labels
    .map((label) => {
      const assigned = cardLabelIds.has(label.id);
      return `<li class="cl-row">
        <label class="cl-label-row">
          <input type="checkbox" class="cl-checkbox" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" ${assigned ? 'checked' : ''} />
          <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
          <span>${escapeHtml(label.name)}</span>
        </label>
      </li>`;
    })
    .join('')}</ul>`;
}

// ── Event binding ──────────────────────────────────────────────────────────────

function bindEvents() {
  // Add-card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.disabled = true;
      await createCard(form.dataset.columnId, text);
      input.disabled = false;
      input.focus();
    });
  });

  // Drag-and-drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getDropNeighbors(list, draggedCardId);
      const cardId = draggedCardId;
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.filterLabelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });

  const clearBtn = document.getElementById('filter-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Manage labels button
  const manageLabelBtn = document.getElementById('manage-labels-btn');
  if (manageLabelBtn) {
    manageLabelBtn.addEventListener('click', () => openLabelManager());
  }

  // Label manager close
  const lmClose = document.getElementById('lm-close-btn');
  if (lmClose) lmClose.addEventListener('click', closeLabelManager);

  const lmOverlay = document.getElementById('label-manager-overlay');
  if (lmOverlay) {
    lmOverlay.addEventListener('click', (e) => {
      if (e.target === lmOverlay) closeLabelManager();
    });
  }

  // Label create form
  const lmCreateForm = document.getElementById('lm-create-form');
  if (lmCreateForm) {
    lmCreateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = lmCreateForm.elements.name;
      const colorInput = lmCreateForm.elements.color;
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      setLmError('');
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) {
          const data = await res.json();
          setLmError(data.error || 'Failed to create label');
          return;
        }
        nameInput.value = '';
        // SSE will update labels list
      } catch (err) {
        setLmError(err.message);
      }
    });
  }

  // Label edit / delete buttons
  document.querySelectorAll('.lm-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openEditLabel(btn.dataset.labelId));
  });

  document.querySelectorAll('.lm-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => deleteLabel(btn.dataset.labelId));
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLabelPanel(btn.dataset.cardId);
    });
  });

  // Card label overlay close
  const clClose = document.getElementById('cl-close-btn');
  if (clClose) clClose.addEventListener('click', closeCardLabelPanel);

  const clOverlay = document.getElementById('card-label-overlay');
  if (clOverlay) {
    clOverlay.addEventListener('click', (e) => {
      if (e.target === clOverlay) closeCardLabelPanel();
    });
  }
}

// ── Label Manager actions ──────────────────────────────────────────────────────

function openLabelManager() {
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function closeLabelManager() {
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) overlay.classList.add('hidden');
  setLmError('');
}

function setLmError(msg) {
  const el = document.getElementById('lm-error');
  if (el) el.textContent = msg;
}

async function openEditLabel(labelId) {
  const label = labels.find((l) => l.id === labelId);
  if (!label) return;

  const newName = prompt('Rename label:', label.name);
  if (newName === null) return; // cancelled
  const trimmed = newName.trim();
  if (!trimmed) {
    alert('Label name cannot be empty.');
    return;
  }

  // For color, use a temporary input
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = label.color;
  // Trigger color picker
  colorInput.style.position = 'fixed';
  colorInput.style.opacity = '0';
  document.body.appendChild(colorInput);
  colorInput.click();

  await new Promise((resolve) => {
    colorInput.addEventListener('change', resolve, { once: true });
    // If user doesn't change, resolve after a short delay on blur
    colorInput.addEventListener('blur', () => setTimeout(resolve, 200), { once: true });
  });
  const newColor = colorInput.value;
  document.body.removeChild(colorInput);

  try {
    const res = await fetch(`${API_BASE}/api/labels/${labelId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed, color: newColor }),
    });
    if (!res.ok) {
      const data = await res.json();
      setLmError(data.error || 'Failed to update label');
    }
    // SSE will update
  } catch (err) {
    setLmError(err.message);
  }
}

async function deleteLabel(labelId) {
  const label = labels.find((l) => l.id === labelId);
  if (!label) return;
  if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      setLmError(data.error || 'Failed to delete label');
    }
    // SSE will update
  } catch (err) {
    setLmError(err.message);
  }
}

// ── Card-label panel ───────────────────────────────────────────────────────────

let currentCardLabelId = null;

function openCardLabelPanel(cardId) {
  currentCardLabelId = cardId;
  const found = findCard(cardId);
  if (!found) return;
  const overlay = document.getElementById('card-label-overlay');
  const body = document.getElementById('cl-body');
  if (!overlay || !body) return;
  body.innerHTML = renderCardLabelBody(found.card);
  bindCardLabelCheckboxes();
  overlay.classList.remove('hidden');
}

function closeCardLabelPanel() {
  const overlay = document.getElementById('card-label-overlay');
  if (overlay) overlay.classList.add('hidden');
  currentCardLabelId = null;
}

function bindCardLabelCheckboxes() {
  document.querySelectorAll('.cl-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const { cardId, labelId } = checkbox.dataset;
      if (checkbox.checked) {
        await assignLabel(cardId, labelId);
      } else {
        await unassignLabel(cardId, labelId);
      }
    });
  });
}

async function assignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!res.ok) {
      const data = await res.json();
      setStatus(`Assign failed: ${data.error}`, true);
    }
    // SSE will update
  } catch (err) {
    setStatus(`Assign failed: ${err.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const data = await res.json();
      setStatus(`Unassign failed: ${data.error}`, true);
    }
    // SSE will update
  } catch (err) {
    setStatus(`Unassign failed: ${err.message}`, true);
  }
}

// ── Drag helpers ───────────────────────────────────────────────────────────────

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

// ── API calls ──────────────────────────────────────────────────────────────────

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
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
  }
}

// ── SSE / state application ────────────────────────────────────────────────────

function applyMutation(message) {
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

function applyLabelMutation(message) {
  switch (message.type) {
    case 'label-create': {
      if (!labels.find((l) => l.id === message.label.id)) {
        labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    case 'label-update': {
      const idx = labels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) {
        labels[idx] = message.label;
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      // Update label data on all cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            const li = card.labels.findIndex((l) => l.id === message.label.id);
            if (li !== -1) card.labels[li] = message.label;
          }
        }
      }
      break;
    }
    case 'label-delete': {
      labels = labels.filter((l) => l.id !== message.labelId);
      // Remove from active filters
      activeFilters.delete(message.labelId);
      // Remove from all cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            card.labels = card.labels.filter((l) => l.id !== message.labelId);
          }
        }
      }
      break;
    }
    case 'card-label-assign':
    case 'card-label-unassign': {
      // Update the specific card's labels from the payload
      if (message.card) {
        const found = findCard(message.card.id);
        if (found) {
          found.card.labels = message.card.labels || [];
        }
        // If card label panel is open for this card, refresh it
        if (currentCardLabelId === message.card.id) {
          const body = document.getElementById('cl-body');
          if (body) {
            body.innerHTML = renderCardLabelBody(found ? found.card : message.card);
            bindCardLabelCheckboxes();
          }
        }
      }
      break;
    }
  }
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
  eventSource.addEventListener('label-mutation', (event) => {
    applyLabelMutation(JSON.parse(event.data));
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
    statusTimer = setTimeout(
      () => setStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Reconnecting…'),
      4000
    );
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
