import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelFilter = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;

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

function cardMatchesFilter(card) {
  if (selectedLabelFilter.size === 0) return true;
  const cardLabels = card.labels || [];
  for (const lid of selectedLabelFilter) {
    if (cardLabels.some((l) => l.id === lid)) return true;
  }
  return false;
}

function render() {
  const filteredBoard = {
    columns: board.columns.map((col) => ({
      ...col,
      cards: col.cards.filter(cardMatchesFilter),
    })),
  };
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <button class="open-labels-btn" id="open-labels">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <div class="filter-bar">
      <label>Filter by labels:</label>
      <div class="label-chips" id="filter-chips">
        ${labels.length === 0 ? '<span style="color:#64748b; font-size:0.85rem;">No labels yet</span>' : ''}
      </div>
      <button id="clear-filter" style="margin-left:auto; font-size:0.8rem; padding:0.25rem 0.5rem; border-radius:6px; border:1px solid #cbd5e1; background:white; cursor:pointer;">Clear</button>
    </div>
    <main class="board">
      ${filteredBoard.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
  renderFilterChips();
}

function renderFilterChips() {
  const container = document.getElementById('filter-chips');
  if (!container) return;
  container.innerHTML = '';
  labels.forEach((label) => {
    const chip = document.createElement('span');
    chip.className = 'label-chip';
    chip.style.background = label.color;
    chip.innerHTML = `${escapeHtml(label.name)} ${selectedLabelFilter.has(label.id) ? '✓' : ''}`;
    chip.onclick = () => {
      if (selectedLabelFilter.has(label.id)) {
        selectedLabelFilter.delete(label.id);
      } else {
        selectedLabelFilter.add(label.id);
      }
      render();
    };
    container.appendChild(chip);
  });
}

function renderLabelManager() {
  return `
    <div class="label-manager" id="label-manager">
      <h3>Label Manager</h3>
      <div class="create-label">
        <input type="text" id="new-label-name" placeholder="New label name" maxlength="50" />
        <input type="color" id="new-label-color" value="#3b82f6" />
        <button id="create-label-btn">Create</button>
        <button id="close-labels-btn">Close</button>
      </div>
      <div class="label-list">
        ${labels.map((label) => `
          <div class="label-row" data-label-id="${escapeHtml(label.id)}">
            <span class="chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
            <div class="label-actions">
              <button class="rename-btn">Rename</button>
              <button class="recolor-btn">Color</button>
              <button class="delete-btn danger">Delete</button>
            </div>
          </div>
        `).join('')}
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
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labelHtml = (card.labels || []).map(l => 
    `<span class="label-chip" style="background:${escapeHtml(l.color)}; font-size:0.65rem; padding:0.05rem 0.35rem;">${escapeHtml(l.name)}</span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div style="margin-bottom:0.35rem;">${escapeHtml(card.text)}</div>
      <div class="label-chips">${labelHtml}</div>
      <div style="margin-top:0.35rem; display:flex; gap:0.25rem; flex-wrap:wrap;">
        <select class="assign-label" data-card-id="${escapeHtml(card.id)}" style="font-size:0.7rem; padding:0.1rem;">
          <option value="">+ Label</option>
          ${labels.filter(l => !(card.labels||[]).some(cl => cl.id === l.id)).map(l => 
            `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`
          ).join('')}
        </select>
        ${(card.labels||[]).length > 0 ? `<select class="remove-label" data-card-id="${escapeHtml(card.id)}" style="font-size:0.7rem; padding:0.1rem;"><option value="">- Label</option>${(card.labels||[]).map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}</select>` : ''}
      </div>
    </article>
  `;
}

function bindEvents() {
  const openBtn = document.getElementById('open-labels');
  if (openBtn) openBtn.onclick = () => { labelManagerOpen = true; render(); };

  const closeBtn = document.getElementById('close-labels-btn');
  if (closeBtn) closeBtn.onclick = () => { labelManagerOpen = false; render(); };

  const createBtn = document.getElementById('create-label-btn');
  if (createBtn) {
    createBtn.onclick = async () => {
      const nameInput = document.getElementById('new-label-name');
      const colorInput = document.getElementById('new-label-color');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      try {
        const res = await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!res.ok) {
          const err = await res.json();
          alert(err.error || 'Failed');
          return;
        }
        nameInput.value = '';
        await loadLabels();
        render();
      } catch (e) {
        alert('Create failed');
      }
    };
  }

  document.querySelectorAll('.label-row').forEach((row) => {
    const lid = row.dataset.labelId;
    const rename = row.querySelector('.rename-btn');
    const recolor = row.querySelector('.recolor-btn');
    const del = row.querySelector('.delete-btn');
    if (rename) rename.onclick = async () => {
      const newName = prompt('New name?');
      if (!newName || !newName.trim()) return;
      try {
        const label = labels.find(l => l.id === lid);
        const res = await fetch(`${API_BASE}/api/labels/${lid}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName.trim(), color: label.color }),
        });
        if (!res.ok) { alert((await res.json()).error); return; }
        await loadLabels();
        render();
      } catch {}
    };
    if (recolor) recolor.onclick = async () => {
      const newColor = prompt('New color hex?', '#3b82f6');
      if (!newColor || !/^#[0-9a-fA-F]{6}$/.test(newColor)) return;
      try {
        const label = labels.find(l => l.id === lid);
        const res = await fetch(`${API_BASE}/api/labels/${lid}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: label.name, color: newColor }),
        });
        if (!res.ok) { alert((await res.json()).error); return; }
        await loadLabels();
        render();
      } catch {}
    };
    if (del) del.onclick = async () => {
      if (!confirm('Delete label?')) return;
      try {
        await fetch(`${API_BASE}/api/labels/${lid}`, { method: 'DELETE' });
        selectedLabelFilter.delete(lid);
        await loadLabels();
        render();
      } catch {}
    };
  });

  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) clearBtn.onclick = () => {
    selectedLabelFilter.clear();
    render();
  };

  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const columnId = form.dataset.columnId;
      if (input.value.trim()) {
        await createCard(columnId, input.value);
        input.value = '';
      }
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    const cardId = cardEl.dataset.cardId;

    cardEl.addEventListener('dragstart', (e) => {
      draggedCardId = cardId;
      cardEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    cardEl.addEventListener('dragend', () => {
      draggedCardId = null;
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
    });

    const assignSel = cardEl.querySelector('.assign-label');
    if (assignSel) {
      assignSel.onchange = async () => {
        const labelId = assignSel.value;
        if (!labelId) return;
        try {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
          await loadBoard();
          render();
        } catch {}
        assignSel.value = '';
      };
    }

    const removeSel = cardEl.querySelector('.remove-label');
    if (removeSel) {
      removeSel.onchange = async () => {
        const labelId = removeSel.value;
        if (!labelId) return;
        try {
          await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
          await loadBoard();
          render();
        } catch {}
        removeSel.value = '';
      };
    }
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(list, e.clientY, draggedCardId);
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });
}

function getDropPosition(list, clientY, cardId) {
  const cards = [...list.querySelectorAll('.card')].filter((el) => el.dataset.cardId !== cardId);
  if (cards.length === 0) return { afterId: null, beforeId: null };
  let afterId = null;
  let beforeId = null;
  for (let i = 0; i < cards.length; i++) {
    const rect = cards[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      beforeId = cards[i].dataset.cardId;
      afterId = i > 0 ? cards[i - 1].dataset.cardId : null;
      break;
    }
    afterId = cards[i].dataset.cardId;
  }
  return { afterId, beforeId };
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
  optimisticMove(cardId, columnId, beforeId, afterId);
  render();
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error('Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
    render();
  }
}

async function loadLabels() {
  try {
    const response = await fetch(`${API_BASE}/api/labels`);
    if (response.ok) labels = await response.json();
  } catch {}
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }
  if (message.type && message.type.startsWith('label')) {
    // reload labels and board for simplicity on label changes
    loadLabels().then(() => {
      loadBoard().then(() => render());
    });
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

async function loadInitial() {
  await loadLabels();
  await loadBoard();
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
    await loadInitial();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
