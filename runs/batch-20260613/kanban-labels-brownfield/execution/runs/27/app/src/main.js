import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let showLabelManager = false;

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
  if (selectedLabelIds.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((l) => l.id);
  for (const id of selectedLabelIds) {
    if (cardLabelIds.includes(id)) return true;
  }
  return false;
}

function getVisibleBoard() {
  if (selectedLabelIds.size === 0) return board;
  return {
    columns: board.columns.map((col) => ({
      ...col,
      cards: col.cards.filter(cardMatchesFilter),
    })),
  };
}

function render() {
  const visible = getVisibleBoard();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div style="display:flex; align-items:center; gap:0.75rem;">
        <button id="manage-labels-btn" style="background:#334155;color:white;border:none;border-radius:999px;padding:0.4rem 0.9rem;font-size:0.85rem;cursor:pointer;">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <div class="filter-bar">
      <span class="filter-label">Filter by labels:</span>
      <div class="filter-chips">
        ${allLabels.length === 0 ? '<span style="color:#64748b;font-size:0.85rem;">No labels yet</span>' : ''}
        ${allLabels.map((label) => {
          const active = selectedLabelIds.has(label.id);
          return `<span class="filter-chip${active ? ' active' : ''}" data-label-id="${escapeHtml(label.id)}" style="background:${active ? label.color : 'white'};color:${active ? 'white' : '#172033'};">${escapeHtml(label.name)}</span>`;
        }).join('')}
        ${selectedLabelIds.size > 0 ? `<button id="clear-filter" style="margin-left:0.5rem;font-size:0.75rem;padding:0.2rem 0.5rem;">Clear</button>` : ''}
      </div>
    </div>
    ${showLabelManager ? renderLabelManager() : ''}
    <main class="board">
      ${visible.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelManager() {
  return `
    <div class="label-manager">
      <h3>Label Manager</h3>
      <div class="label-list">
        ${allLabels.map((label) => `
          <div class="label-item" data-label-id="${escapeHtml(label.id)}">
            <input type="text" value="${escapeHtml(label.name)}" data-field="name" />
            <input type="color" value="${escapeHtml(label.color)}" data-field="color" class="color-input" />
            <div class="label-actions">
              <button data-action="save">Save</button>
              <button data-action="delete">Delete</button>
            </div>
          </div>
        `).join('')}
        ${allLabels.length === 0 ? '<span style="color:#64748b;">No labels created yet.</span>' : ''}
      </div>
      <div class="create-label">
        <input id="new-label-name" type="text" placeholder="New label name" maxlength="50" />
        <input id="new-label-color" type="color" value="#3b82f6" />
        <button id="create-label-btn">Create Label</button>
        <button id="close-manager-btn" style="margin-left:auto;">Close</button>
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
  const labelsHtml = (card.labels || []).map((label) => `
    <span class="label-chip" style="background:${escapeHtml(label.color)};" data-label-id="${escapeHtml(label.id)}">
      ${escapeHtml(label.name)}
      <span class="remove" data-action="remove-label" data-label-id="${escapeHtml(label.id)}" title="Remove">×</span>
    </span>
  `).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${escapeHtml(card.text)}
      <div class="card-labels">${labelsHtml}</div>
      <div style="margin-top:0.4rem;">
        <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}" style="font-size:0.65rem;padding:0.1rem 0.35rem;border:1px solid #cbd5e1;border-radius:4px;background:white;cursor:pointer;">+ Label</button>
      </div>
    </article>
  `;
}

function bindEvents() {
  // manage labels
  const manageBtn = document.getElementById('manage-labels-btn');
  if (manageBtn) {
    manageBtn.onclick = () => {
      showLabelManager = !showLabelManager;
      render();
    };
  }

  const closeBtn = document.getElementById('close-manager-btn');
  if (closeBtn) closeBtn.onclick = () => { showLabelManager = false; render(); };

  // create label
  const createBtn = document.getElementById('create-label-btn');
  if (createBtn) {
    createBtn.onclick = async () => {
      const nameInput = document.getElementById('new-label-name');
      const colorInput = document.getElementById('new-label-color');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      try {
        await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        nameInput.value = '';
        await loadLabels();
        render();
      } catch (e) {
        alert('Failed to create label: ' + e.message);
      }
    };
  }

  // label manager edits
  document.querySelectorAll('.label-item').forEach((item) => {
    const labelId = item.dataset.labelId;
    item.querySelectorAll('button').forEach((btn) => {
      btn.onclick = async () => {
        const action = btn.dataset.action;
        if (action === 'save') {
          const name = item.querySelector('input[data-field="name"]').value.trim();
          const color = item.querySelector('input[data-field="color"]').value;
          try {
            await fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name, color }),
            });
            await loadLabels();
            render();
          } catch (e) { alert('Update failed'); }
        } else if (action === 'delete') {
          if (!confirm('Delete this label?')) return;
          fetch(`${API_BASE}/api/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' })
            .then(() => { loadLabels(); render(); });
        }
      };
    });
  });

  // filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.onclick = () => {
      const id = chip.dataset.labelId;
      if (selectedLabelIds.has(id)) selectedLabelIds.delete(id);
      else selectedLabelIds.add(id);
      render();
    };
  });

  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) clearBtn.onclick = () => { selectedLabelIds.clear(); render(); };

  // add card forms
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

  // card drag
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  // drop zones
  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.dragging');
      if (!dragging) return;
      if (afterElement == null) list.appendChild(dragging);
      else list.insertBefore(dragging, afterElement);
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getNeighborsFromDom(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      try {
        const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move rejected: ${error.message}`, true);
        await loadBoard();
      }
    });
  });

  // assign label buttons and remove
  document.querySelectorAll('.assign-label-btn').forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopImmediatePropagation();
      const cardId = btn.dataset.cardId;
      await showLabelPicker(cardId, btn);
    };
  });

  document.querySelectorAll('.label-chip .remove').forEach((rem) => {
    rem.onclick = async (e) => {
      e.stopImmediatePropagation();
      const cardEl = rem.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const labelId = rem.dataset.labelId;
      await unassignLabel(cardId, labelId);
    };
  });
}

async function showLabelPicker(cardId, anchorEl) {
  // simple picker: prompt or create a small floating div
  const picker = document.createElement('div');
  picker.style.cssText = 'position:absolute;background:white;border:1px solid #cbd5e1;border-radius:8px;padding:0.5rem;box-shadow:0 4px 12px rgba(0,0,0,0.1);z-index:100;';
  picker.innerHTML = allLabels.length ? allLabels.map(l => `
    <div style="padding:0.25rem 0.5rem;cursor:pointer;display:flex;align-items:center;gap:0.4rem;" data-label-id="${escapeHtml(l.id)}">
      <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${escapeHtml(l.color)};"></span>
      ${escapeHtml(l.name)}
    </div>
  `).join('') : '<div style="padding:0.25rem;">No labels</div>';

  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  picker.style.left = (rect.left + window.scrollX) + 'px';
  document.body.appendChild(picker);

  picker.querySelectorAll('[data-label-id]').forEach((el) => {
    el.onclick = async () => {
      const labelId = el.dataset.labelId;
      document.body.removeChild(picker);
      await assignLabel(cardId, labelId);
    };
  });

  setTimeout(() => {
    document.addEventListener('click', function onDoc(ev) {
      if (!picker.contains(ev.target)) {
        if (picker.parentNode) picker.parentNode.removeChild(picker);
        document.removeEventListener('click', onDoc);
      }
    }, { once: true });
  }, 0);
}

async function loadLabels() {
  try {
    const res = await fetch(`${API_BASE}/api/labels`);
    if (res.ok) {
      const data = await res.json();
      allLabels = data.labels || [];
    }
  } catch (_) {}
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  await loadLabels();
  render();
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

async function assignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!res.ok) throw new Error('Assign failed');
  } catch (e) {
    setStatus('Assign failed', true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
  } catch (e) {
    setStatus('Unassign failed', true);
  }
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    // refresh labels list too in case
    loadLabels().then(() => render());
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

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function getNeighborsFromDom(list, cardId) {
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
