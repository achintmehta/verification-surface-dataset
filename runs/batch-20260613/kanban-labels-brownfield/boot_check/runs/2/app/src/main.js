import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

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

// ── Filtering ─────────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Render ────────────────────────────────────────────────────────────────────

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-right">
        <button class="btn-manage-labels" id="btn-manage-labels">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManagerModal()}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) return '<div class="filter-bar filter-bar--empty"></div>';
  return `
    <div class="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${labels.map((l) => `
        <button
          class="filter-chip${activeFilters.has(l.id) ? ' filter-chip--active' : ''}"
          data-filter-label-id="${escapeHtml(l.id)}"
          style="--chip-color: ${escapeHtml(l.color)}"
          title="Filter by ${escapeHtml(l.name)}"
        >${escapeHtml(l.name)}</button>
      `).join('')}
      ${activeFilters.size > 0 ? '<button class="filter-clear" id="btn-filter-clear">✕ Clear</button>' : ''}
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

function renderCard(card, visible = true) {
  const labelsHtml = (card.labels || []).map((l) => `
    <span class="label-chip" style="background:${escapeHtml(l.color)}" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>
  `).join('');

  return `
    <article
      class="card${visible ? '' : ' card--hidden'}"
      draggable="true"
      data-card-id="${escapeHtml(card.id)}"
      title="Drag to move"
    >
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

// ── Label Manager Modal ───────────────────────────────────────────────────────

function renderLabelManagerModal() {
  return `
    <div class="modal-overlay" id="label-manager-overlay" style="display:none">
      <div class="modal" id="label-manager-modal">
        <div class="modal-header">
          <h2>Manage Labels</h2>
          <button class="modal-close" id="label-manager-close">✕</button>
        </div>
        <div class="modal-body">
          <form class="label-create-form" id="label-create-form">
            <input
              type="text"
              name="name"
              placeholder="Label name…"
              maxlength="100"
              autocomplete="off"
              required
            />
            <input type="color" name="color" value="#2563eb" title="Pick a color" />
            <button type="submit">Create</button>
          </form>
          <div id="label-list" class="label-list">
            ${renderLabelList()}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderLabelList() {
  if (labels.length === 0) return '<p class="label-list-empty">No labels yet.</p>';
  return labels.map((l) => `
    <div class="label-item" data-label-id="${escapeHtml(l.id)}">
      <span class="label-swatch" style="background:${escapeHtml(l.color)}"></span>
      <span class="label-item-name" data-label-id="${escapeHtml(l.id)}">${escapeHtml(l.name)}</span>
      <input
        class="label-edit-name"
        type="text"
        value="${escapeHtml(l.name)}"
        maxlength="100"
        data-label-id="${escapeHtml(l.id)}"
        style="display:none"
      />
      <input
        class="label-edit-color"
        type="color"
        value="${escapeHtml(l.color)}"
        data-label-id="${escapeHtml(l.id)}"
        style="display:none"
      />
      <button class="label-edit-btn" data-label-id="${escapeHtml(l.id)}" title="Edit">✏️</button>
      <button class="label-save-btn" data-label-id="${escapeHtml(l.id)}" title="Save" style="display:none">💾</button>
      <button class="label-cancel-btn" data-label-id="${escapeHtml(l.id)}" title="Cancel" style="display:none">✕</button>
      <button class="label-delete-btn" data-label-id="${escapeHtml(l.id)}" title="Delete">🗑</button>
    </div>
  `).join('');
}

// ── Card-label assignment modal ───────────────────────────────────────────────

function renderCardLabelModal(card) {
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="modal-overlay" id="card-label-overlay">
      <div class="modal modal--sm" id="card-label-modal">
        <div class="modal-header">
          <h2>Labels for card</h2>
          <button class="modal-close" id="card-label-close">✕</button>
        </div>
        <div class="modal-body">
          <p class="card-label-card-text">${escapeHtml(card.text)}</p>
          ${labels.length === 0
            ? '<p class="label-list-empty">No labels exist yet. Create some in the Labels manager.</p>'
            : `<div class="card-label-list">
                ${labels.map((l) => `
                  <label class="card-label-row">
                    <input
                      type="checkbox"
                      class="card-label-checkbox"
                      data-card-id="${escapeHtml(card.id)}"
                      data-label-id="${escapeHtml(l.id)}"
                      ${cardLabelIds.has(l.id) ? 'checked' : ''}
                    />
                    <span class="label-swatch" style="background:${escapeHtml(l.color)}"></span>
                    <span>${escapeHtml(l.name)}</span>
                  </label>
                `).join('')}
              </div>`
          }
        </div>
      </div>
    </div>
  `;
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  // ── Filter bar ──
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
      if (activeFilters.has(id)) {
        activeFilters.delete(id);
      } else {
        activeFilters.add(id);
      }
      render();
    });
  });

  const clearBtn = document.getElementById('btn-filter-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // ── Label manager modal ──
  const btnManage = document.getElementById('btn-manage-labels');
  if (btnManage) {
    btnManage.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'flex';
    });
  }

  const closeManager = document.getElementById('label-manager-close');
  if (closeManager) {
    closeManager.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'none';
    });
  }

  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  }

  // ── Create label ──
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = createForm.elements.name;
      const colorInput = createForm.elements.color;
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Create label failed: ${err.error}`, true);
          return;
        }
        nameInput.value = '';
        // SSE will update labels list
      } catch (err) {
        setStatus(`Create label failed: ${err.message}`, true);
      }
    });
  }

  // ── Edit / save / cancel / delete label ──
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.labelId;
      const item = document.querySelector(`.label-item[data-label-id="${id}"]`);
      item.querySelector('.label-item-name').style.display = 'none';
      item.querySelector('.label-edit-name').style.display = '';
      item.querySelector('.label-edit-color').style.display = '';
      item.querySelector('.label-edit-btn').style.display = 'none';
      item.querySelector('.label-save-btn').style.display = '';
      item.querySelector('.label-cancel-btn').style.display = '';
    });
  });

  document.querySelectorAll('.label-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.labelId;
      const item = document.querySelector(`.label-item[data-label-id="${id}"]`);
      item.querySelector('.label-item-name').style.display = '';
      item.querySelector('.label-edit-name').style.display = 'none';
      item.querySelector('.label-edit-color').style.display = 'none';
      item.querySelector('.label-edit-btn').style.display = '';
      item.querySelector('.label-save-btn').style.display = 'none';
      item.querySelector('.label-cancel-btn').style.display = 'none';
    });
  });

  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const item = document.querySelector(`.label-item[data-label-id="${id}"]`);
      const name = item.querySelector('.label-edit-name').value.trim();
      const color = item.querySelector('.label-edit-color').value;
      if (!name) { setStatus('Label name cannot be empty', true); return; }
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Update label failed: ${err.error}`, true);
          return;
        }
        // SSE will re-render
      } catch (err) {
        setStatus(`Update label failed: ${err.message}`, true);
      }
    });
  });

  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (!resp.ok && resp.status !== 204) {
          const err = await resp.json();
          setStatus(`Delete label failed: ${err.error}`, true);
        }
        // SSE will re-render
      } catch (err) {
        setStatus(`Delete label failed: ${err.message}`, true);
      }
    });
  });

  // ── Card label assignment buttons ──
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      const found = findCard(cardId);
      if (!found) return;
      openCardLabelModal(found.card);
    });
  });

  // ── Drag and drop ──
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
      const { beforeId, afterId } = getDropPosition(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // ── Add card forms ──
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
}

// ── Card-label modal ──────────────────────────────────────────────────────────

function openCardLabelModal(card) {
  // Remove any existing modal
  const existing = document.getElementById('card-label-overlay');
  if (existing) existing.remove();

  const div = document.createElement('div');
  div.innerHTML = renderCardLabelModal(card);
  document.body.appendChild(div.firstElementChild);

  const overlay = document.getElementById('card-label-overlay');

  document.getElementById('card-label-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.card-label-checkbox').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const { cardId, labelId } = cb.dataset;
      try {
        if (cb.checked) {
          const resp = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
          if (!resp.ok) {
            const err = await resp.json();
            setStatus(`Assign label failed: ${err.error}`, true);
            cb.checked = false;
          }
        } else {
          const resp = await fetch(
            `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
            { method: 'DELETE' }
          );
          if (!resp.ok) {
            const err = await resp.json();
            setStatus(`Unassign label failed: ${err.error}`, true);
            cb.checked = true;
          }
        }
      } catch (err) {
        setStatus(`Label assignment failed: ${err.message}`, true);
        cb.checked = !cb.checked;
      }
    });
  });
}

// ── Drag helpers ──────────────────────────────────────────────────────────────

function getDropPosition(list, cardId) {
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

// ── API calls ─────────────────────────────────────────────────────────────────

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
  }
}

// ── SSE / board state ─────────────────────────────────────────────────────────

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

function applyLabelEvent(message) {
  switch (message.type) {
    case 'label-created': {
      if (!labels.find((l) => l.id === message.label.id)) {
        labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    case 'label-updated': {
      const idx = labels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) {
        labels[idx] = message.label;
      } else {
        labels.push(message.label);
      }
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update label data on all cards in board
      for (const col of board.columns) {
        for (const card of col.cards) {
          card.labels = (card.labels || []).map((l) =>
            l.id === message.label.id ? message.label : l
          );
        }
      }
      break;
    }
    case 'label-deleted': {
      labels = labels.filter((l) => l.id !== message.labelId);
      activeFilters.delete(message.labelId);
      // Remove label from all cards
      for (const col of board.columns) {
        for (const card of col.cards) {
          card.labels = (card.labels || []).filter((l) => l.id !== message.labelId);
        }
      }
      break;
    }
    case 'card-label-assigned':
    case 'card-label-unassigned': {
      if (message.card) {
        // Update the card in our local board state
        for (const col of board.columns) {
          const idx = col.cards.findIndex((c) => c.id === message.card.id);
          if (idx !== -1) {
            col.cards[idx] = { ...col.cards[idx], labels: message.card.labels || [] };
          }
        }
        // If card-label modal is open for this card, refresh it
        const overlay = document.getElementById('card-label-overlay');
        if (overlay) {
          const found = findCard(message.card.id);
          if (found) {
            overlay.remove();
            openCardLabelModal(found.card);
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
  eventSource.addEventListener('label', (event) => {
    applyLabelEvent(JSON.parse(event.data));
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
