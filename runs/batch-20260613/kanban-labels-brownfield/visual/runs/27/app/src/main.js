import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedFilterLabels = new Set();
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

function render() {
  const filteredBoard = getFilteredBoard();
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <button id="manage-labels-btn" style="background:#334155; color:white; border:none; padding:0.4rem 0.8rem; border-radius:6px; cursor:pointer;">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <div class="filter-bar">
      <label>Filter by labels:</label>
      <select id="label-filter" multiple size="1" style="min-width:180px;">
        ${labels.map(l => `<option value="${escapeHtml(l.id)}" ${selectedFilterLabels.has(l.id) ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
      </select>
      <button id="clear-filter">Clear</button>
    </div>
    <main class="board">
      ${filteredBoard.columns.map(renderColumn).join('')}
    </main>
    <div id="label-manager" class="label-manager ${labelManagerOpen ? 'open' : ''}">
      <h3>Label Manager</h3>
      <form id="create-label-form" style="display:flex; gap:0.5rem; margin:0.5rem 0;">
        <input name="name" placeholder="Label name" required style="flex:1;" />
        <input name="color" type="color" value="#3b82f6" />
        <button type="submit">Add</button>
      </form>
      <div class="label-list">
        ${labels.map(renderLabelItem).join('')}
      </div>
      <button id="close-manager" style="margin-top:1rem;">Close</button>
    </div>
  `;
  bindEvents();
}

function getFilteredBoard() {
  if (selectedFilterLabels.size === 0) return board;
  const filterSet = selectedFilterLabels;
  return {
    columns: board.columns.map(col => ({
      ...col,
      cards: col.cards.filter(card => {
        const cardLabels = card.labels || [];
        return cardLabels.some(l => filterSet.has(l.id));
      })
    }))
  };
}

function renderLabelItem(label) {
  return `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <input type="text" value="${escapeHtml(label.name)}" class="label-name-edit" />
      <input type="color" value="${escapeHtml(label.color)}" class="label-color-edit" />
      <div class="label-actions">
        <button class="save-label">Save</button>
        <button class="delete-label">Del</button>
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
  const chips = (card.labels || []).map(l => 
    `<span class="label-chip" style="background:${escapeHtml(l.color)}; font-size:0.65rem; padding:0.05rem 0.3rem;" data-label-id="${escapeHtml(l.id)}">${escapeHtml(l.name)}</span>`
  ).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div>${escapeHtml(card.text)}</div>
      <div class="label-chips">${chips}</div>
      <div style="margin-top:0.35rem;">
        <select class="assign-label" style="font-size:0.7rem; width:100%;">
          <option value="">+ Add label</option>
          ${labels.filter(l => !(card.labels||[]).some(cl => cl.id === l.id)).map(l => 
            `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`
          ).join('')}
        </select>
      </div>
    </article>
  `;
}

function bindEvents() {
  // manage labels button
  const manageBtn = document.getElementById('manage-labels-btn');
  if (manageBtn) {
    manageBtn.onclick = () => {
      labelManagerOpen = !labelManagerOpen;
      render();
    };
  }
  const closeBtn = document.getElementById('close-manager');
  if (closeBtn) closeBtn.onclick = () => { labelManagerOpen = false; render(); };

  // create label
  const createForm = document.getElementById('create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value;
      const color = createForm.elements.color.value;
      try {
        await fetch(`${API_BASE}/api/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        createForm.reset();
        await loadLabels();
        render();
      } catch (err) {
        alert('Create label failed: ' + err.message);
      }
    });
  }

  // label edits and deletes
  document.querySelectorAll('.label-item').forEach(item => {
    const id = item.dataset.labelId;
    const saveBtn = item.querySelector('.save-label');
    const delBtn = item.querySelector('.delete-label');
    const nameInput = item.querySelector('.label-name-edit');
    const colorInput = item.querySelector('.label-color-edit');
    if (saveBtn) {
      saveBtn.onclick = async () => {
        try {
          await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: nameInput.value, color: colorInput.value }),
          });
          await loadLabels();
          render();
        } catch (err) { alert('Update failed'); }
      };
    }
    if (delBtn) {
      delBtn.onclick = async () => {
        if (!confirm('Delete label?')) return;
        try {
          await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
          await loadLabels();
          render();
        } catch (err) { alert('Delete failed'); }
      };
    }
  });

  // filter
  const filterEl = document.getElementById('label-filter');
  if (filterEl) {
    filterEl.onchange = () => {
      selectedFilterLabels = new Set([...filterEl.selectedOptions].map(o => o.value));
      // re-render only board part? but simple re-render
      const main = document.querySelector('.board');
      if (main) {
        const filtered = getFilteredBoard();
        main.innerHTML = filtered.columns.map(renderColumn).join('');
        bindCardEvents(); // rebind cards
      }
    };
  }
  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) {
    clearBtn.onclick = () => {
      selectedFilterLabels.clear();
      render();
    };
  }

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

  bindCardEvents();
}

function bindCardEvents() {
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

    // assign label select
    const assignSel = cardEl.querySelector('.assign-label');
    if (assignSel) {
      assignSel.onchange = async () => {
        const labelId = assignSel.value;
        if (!labelId) return;
        const cardId = cardEl.dataset.cardId;
        try {
          await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId }),
          });
          // will update via SSE
        } catch (err) {
          alert('Assign failed');
        }
        assignSel.value = '';
      };
    }

    // remove label on chip click
    cardEl.querySelectorAll('.label-chip').forEach(chip => {
      chip.onclick = async (e) => {
        e.stopImmediatePropagation();
        const labelId = chip.dataset.labelId;
        const cardId = cardEl.dataset.cardId;
        try {
          await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, { method: 'DELETE' });
        } catch (err) { alert('Remove failed'); }
      };
      chip.style.cursor = 'pointer';
    });
  });

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
  await loadLabels();
  render();
}

async function loadLabels() {
  try {
    const res = await fetch(`${API_BASE}/api/labels`);
    if (res.ok) labels = await res.json();
  } catch (e) { /* ignore */ }
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
