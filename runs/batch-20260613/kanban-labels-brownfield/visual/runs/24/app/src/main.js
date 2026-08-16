import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilterLabelIds = new Set();
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
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

/* ---------- Filtering logic ---------- */

function cardPassesFilter(card) {
  if (activeFilterLabelIds.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const filterId of activeFilterLabelIds) {
    if (cardLabelIds.includes(filterId)) return true;
  }
  return false;
}

/* ---------- Text color contrast ---------- */

function contrastColor(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c[0]+c[0]+c[1]+c[1]+c[2]+c[2];
  const r = parseInt(c.substring(0,2),16);
  const g = parseInt(c.substring(2,4),16);
  const b = parseInt(c.substring(4,6),16);
  const luminance = (0.299*r + 0.587*g + 0.114*b) / 255;
  return luminance > 0.5 ? '#000000' : '#ffffff';
}

/* ---------- Render ---------- */

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
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-bar-title">Filter by label:</span>
      ${allLabels.map((label) => {
        const active = activeFilterLabelIds.has(label.id);
        return `<button class="filter-chip ${active ? 'active' : ''}" data-filter-label-id="${escapeHtml(label.id)}" style="background:${active ? escapeHtml(label.color) : '#e2e8f0'}; color:${active ? contrastColor(label.color) : '#334155'}; border-color:${escapeHtml(label.color)}">${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilterLabelIds.size > 0 ? '<button class="filter-clear-btn" id="clear-filters">Clear filter</button>' : ''}
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
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const hidden = !cardPassesFilter(card);
  const labels = card.labels || [];
  return `
    <article class="card ${hidden ? 'card-hidden' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${labels.map((l) => `<span class="label-chip" style="background:${escapeHtml(l.color)}; color:${contrastColor(l.color)}">${escapeHtml(l.name)}</span>`).join('')}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-label-actions">
        <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}">Labels</button>
      </div>
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div id="label-manager" class="label-manager">
      <button id="toggle-label-manager" class="label-manager-toggle">⚙ Manage Labels</button>
      <div id="label-manager-panel" class="label-manager-panel" style="display:none">
        <h3>Labels</h3>
        <form id="create-label-form" class="create-label-form">
          <input type="text" name="name" placeholder="Label name" maxlength="50" autocomplete="off" required />
          <input type="color" name="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <ul class="label-list">
          ${allLabels.map((label) => `
            <li class="label-list-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-chip" style="background:${escapeHtml(label.color)}; color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
              <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">Edit</button>
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">&times;</button>
            </li>
          `).join('')}
        </ul>
      </div>
    </div>
  `;
}

/* ---------- Label assignment popup ---------- */

function showLabelPopup(cardId) {
  // Remove existing popup
  closeLabelPopup();
  const cardInfo = findCard(cardId);
  if (!cardInfo) return;
  const cardLabels = (cardInfo.card.labels || []).map((l) => l.id);
  
  const popup = document.createElement('div');
  popup.className = 'label-popup-overlay';
  popup.id = 'label-popup';
  popup.innerHTML = `
    <div class="label-popup">
      <h3>Assign Labels</h3>
      <div class="label-popup-list">
        ${allLabels.length === 0 ? '<p class="label-popup-empty">No labels created yet.</p>' : ''}
        ${allLabels.map((label) => {
          const assigned = cardLabels.includes(label.id);
          return `
            <label class="label-popup-item">
              <input type="checkbox" data-card-id="${escapeHtml(cardId)}" data-label-id="${escapeHtml(label.id)}" ${assigned ? 'checked' : ''} />
              <span class="label-chip" style="background:${escapeHtml(label.color)}; color:${contrastColor(label.color)}">${escapeHtml(label.name)}</span>
            </label>
          `;
        }).join('')}
      </div>
      <button class="label-popup-close" id="close-label-popup">Close</button>
    </div>
  `;
  document.body.appendChild(popup);

  popup.querySelector('#close-label-popup').addEventListener('click', closeLabelPopup);
  popup.addEventListener('click', (e) => {
    if (e.target === popup) closeLabelPopup();
  });

  popup.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', async (e) => {
      const cid = e.target.dataset.cardId;
      const lid = e.target.dataset.labelId;
      if (e.target.checked) {
        await assignLabel(cid, lid);
      } else {
        await unassignLabel(cid, lid);
      }
    });
  });
}

function closeLabelPopup() {
  const existing = document.getElementById('label-popup');
  if (existing) existing.remove();
}

/* ---------- Label edit popup ---------- */

function showEditLabelPopup(labelId) {
  const label = allLabels.find((l) => l.id === labelId);
  if (!label) return;
  closeEditLabelPopup();

  const popup = document.createElement('div');
  popup.className = 'label-popup-overlay';
  popup.id = 'edit-label-popup';
  popup.innerHTML = `
    <div class="label-popup">
      <h3>Edit Label</h3>
      <form id="edit-label-form" class="create-label-form">
        <input type="text" name="name" value="${escapeHtml(label.name)}" maxlength="50" autocomplete="off" required />
        <input type="color" name="color" value="${escapeHtml(label.color)}" />
        <button type="submit">Save</button>
      </form>
      <button class="label-popup-close" id="close-edit-label-popup">Cancel</button>
    </div>
  `;
  document.body.appendChild(popup);

  popup.querySelector('#close-edit-label-popup').addEventListener('click', closeEditLabelPopup);
  popup.addEventListener('click', (e) => {
    if (e.target === popup) closeEditLabelPopup();
  });

  popup.querySelector('#edit-label-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.elements.name.value.trim();
    const color = e.target.elements.color.value;
    if (!name) return;
    try {
      const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color }),
      });
      if (!resp.ok) {
        const err = await resp.json();
        setStatus(`Update failed: ${err.error}`, true);
        return;
      }
      closeEditLabelPopup();
    } catch (error) {
      setStatus(`Update failed: ${error.message}`, true);
    }
  });
}

function closeEditLabelPopup() {
  const existing = document.getElementById('edit-label-popup');
  if (existing) existing.remove();
}

/* ---------- Bind events ---------- */

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

  bindDragAndDrop();
  bindLabelManagerEvents();
  bindFilterEvents();
  bindCardLabelButtons();
}

function bindCardLabelButtons() {
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      showLabelPopup(btn.dataset.cardId);
    });
  });
}

function bindFilterEvents() {
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

  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilterLabelIds.clear();
      render();
    });
  }
}

function bindLabelManagerEvents() {
  const toggle = document.getElementById('toggle-label-manager');
  const panel = document.getElementById('label-manager-panel');
  if (toggle && panel) {
    toggle.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });
  }

  const form = document.getElementById('create-label-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
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
          setStatus(`Create label failed: ${err.error}`, true);
          return;
        }
        form.elements.name.value = '';
      } catch (error) {
        setStatus(`Create label failed: ${error.message}`, true);
      }
    });
  }

  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      showEditLabelPopup(btn.dataset.labelId);
    });
  });

  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!confirm(`Delete label "${label?.name || labelId}"?`)) return;
      try {
        const resp = await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
        if (!resp.ok) {
          const err = await resp.json();
          setStatus(`Delete failed: ${err.error}`, true);
        }
      } catch (error) {
        setStatus(`Delete failed: ${error.message}`, true);
      }
    });
  });
}

/* ---------- Drag & Drop ---------- */

function bindDragAndDrop() {
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
      const after = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.card.dragging');
      if (dragging) {
        if (after) list.insertBefore(dragging, after);
        else list.appendChild(dragging);
      }
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
      const { afterId, beforeId } = getNeighborIds(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, afterId, beforeId }),
        });
      } catch (error) {
        setStatus(`Move failed: ${error.message}`, true);
        board = normalizeBoard(await (await fetch(`${API_BASE}/api/board`)).json());
        render();
      }
    });
  });
}

function getDragAfterElement(container, y) {
  const cards = [...container.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const child of cards) {
    const { top, height } = child.getBoundingClientRect();
    const offset = y - top - height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = child;
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

/* ---------- API calls ---------- */

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

async function assignLabel(cardId, labelId) {
  try {
    const resp = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!resp.ok) {
      const err = await resp.json();
      setStatus(`Assign failed: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const resp = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      const err = await resp.json();
      setStatus(`Unassign failed: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

/* ---------- SSE & mutations ---------- */

function applyMutation(message) {
  // Handle label-specific mutations
  if (message.type === 'label-created') {
    if (!allLabels.find((l) => l.id === message.label.id)) {
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
    } else {
      allLabels.push(message.label);
    }
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
    // Also update label info on all cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          const li = card.labels.findIndex((l) => l.id === message.label.id);
          if (li !== -1) {
            card.labels[li] = { ...message.label };
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
    // Remove from filter
    activeFilterLabelIds.delete(message.labelId);
    // Remove from all cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          card.labels = card.labels.filter((l) => l.id !== message.labelId);
        }
      }
    }
    render();
    setStatus('Synced');
    return;
  }

  // Board-carrying mutations (including label-assigned, label-unassigned, and original card mutations)
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
