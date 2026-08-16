import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedFilterLabels = new Set();
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

function renderLabelItem(label) {
  return `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="chip" style="background:${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <input type="text" class="label-name-edit" value="${escapeHtml(label.name)}" />
      <input type="color" class="label-color-edit" value="${escapeHtml(label.color)}" />
      <button class="save-label-btn">Save</button>
      <button class="delete-label-btn">Delete</button>
    </div>
  `;
}

function render() {
  const filterActive = selectedFilterLabels.size > 0;
  const labelOptions = labels.map(l => `
    <label class="label-filter">
      <input type="checkbox" value="${escapeHtml(l.id)}" ${selectedFilterLabels.has(l.id) ? 'checked' : ''} />
      <span class="chip" style="background:${escapeHtml(l.color)}">${escapeHtml(l.name)}</span>
    </label>
  `).join('');

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels-btn" class="secondary">Manage Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    <div class="filter-bar">
      <span class="filter-label">Filter by labels:</span>
      <div class="label-filters">${labelOptions || '<span class="no-labels">No labels yet</span>'}</div>
      ${filterActive ? '<button id="clear-filter-btn" class="secondary small">Clear</button>' : ''}
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="label-modal" class="modal hidden">
      <div class="modal-content">
        <h3>Manage Labels</h3>
        <div class="label-list">
          ${labels.length ? labels.map(renderLabelItem).join('') : '<p>No labels defined.</p>'}
        </div>
        <form id="create-label-form" class="create-label">
          <input name="name" type="text" placeholder="New label name" maxlength="50" required />
          <input name="color" type="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
        <button id="close-modal-btn" class="secondary">Close</button>
      </div>
    </div>
  `;
  bindEvents();
}

function renderColumn(column) {
  let cards = column.cards;
  if (selectedFilterLabels.size > 0) {
    cards = cards.filter(card => (card.labels || []).some(l => selectedFilterLabels.has(l.id)));
  }
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const chips = (card.labels || []).map(l => 
    `<span class="chip" style="background:${escapeHtml(l.color)}" data-label-id="${escapeHtml(l.id)}">${escapeHtml(l.name)}</span>`
  ).join('');
  const available = labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id));
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-labels">${chips}</div>
      <div class="card-actions">
        <select class="assign-label" data-card-id="${escapeHtml(card.id)}">
          <option value="">+ Label</option>
          ${available.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
      </div>
    </article>
  `;
}

function bindEvents() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const columnId = form.dataset.columnId;
      if (input && columnId && input.value.trim()) {
        await createCard(columnId, input.value.trim());
        input.value = '';
      }
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (e) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach(c => c.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (e) => { e.preventDefault(); list.classList.add('drop-target'); });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const ids = [...list.querySelectorAll('.card')].map(el => el.dataset.cardId).filter(id => id !== draggedCardId);
      // insert at end for simplicity in this impl; full would use mouse pos
      const beforeId = null;
      const afterId = ids.length ? ids[ids.length-1] : null;
      await moveCard(draggedCardId, columnId, beforeId, afterId);
      draggedCardId = null;
    });
  });

  // filters
  document.querySelectorAll('.label-filter input').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) selectedFilterLabels.add(cb.value);
      else selectedFilterLabels.delete(cb.value);
      render();
    });
  });
  const clear = document.getElementById('clear-filter-btn');
  if (clear) clear.onclick = () => { selectedFilterLabels.clear(); render(); };

  // modal
  const mng = document.getElementById('manage-labels-btn');
  const modal = document.getElementById('label-modal');
  if (mng && modal) mng.onclick = () => modal.classList.remove('hidden');
  const cls = document.getElementById('close-modal-btn');
  if (cls && modal) cls.onclick = () => modal.classList.add('hidden');

  // create label
  const cf = document.getElementById('create-label-form');
  if (cf) cf.onsubmit = async (e) => {
    e.preventDefault();
    const nm = cf.elements.name.value.trim();
    const cl = cf.elements.color.value;
    if (!nm) return;
    const r = await fetch(`${API_BASE}/api/labels`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:nm, color:cl}) });
    if (!r.ok) alert((await r.json()).error || 'Error');
    cf.reset();
  };

  // edit/delete labels
  document.querySelectorAll('.save-label-btn').forEach(btn => {
    btn.onclick = async () => {
      const it = btn.closest('.label-item');
      const id = it.dataset.labelId;
      const nm = it.querySelector('.label-name-edit').value.trim();
      const cl = it.querySelector('.label-color-edit').value;
      if (!nm) return alert('name needed');
      const r = await fetch(`${API_BASE}/api/labels/${id}`, {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name:nm,color:cl})});
      if (!r.ok) alert((await r.json()).error||'fail');
    };
  });
  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.onclick = async () => {
      const it = btn.closest('.label-item');
      if (!confirm('Delete label?')) return;
      await fetch(`${API_BASE}/api/labels/${it.dataset.labelId}`, {method:'DELETE'});
    };
  });

  // assign
  document.querySelectorAll('.assign-label').forEach(sel => {
    sel.onchange = async () => {
      if (!sel.value) return;
      const cid = sel.dataset.cardId;
      await fetch(`${API_BASE}/api/cards/${cid}/labels`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({labelId: sel.value})});
      sel.value = '';
    };
  });

  // unassign on chip click
  document.querySelectorAll('.card-labels .chip').forEach(ch => {
    ch.onclick = async (ev) => {
      ev.stopImmediatePropagation();
      const card = ch.closest('.card');
      const lid = ch.dataset.labelId;
      await fetch(`${API_BASE}/api/cards/${card.dataset.cardId}/labels/${lid}`, {method:'DELETE'});
    };
  });
}

function getPositionInfo(list, cardId) {
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

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-create' || message.type === 'label-update') {
    const idx = labels.findIndex(l => l.id === message.label.id);
    if (idx >= 0) labels[idx] = message.label;
    else labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-delete') {
    labels = labels.filter(l => l.id !== message.labelId);
    for (const col of board.columns) {
      for (const card of col.cards) {
        card.labels = (card.labels || []).filter(l => l.id !== message.labelId);
      }
    }
    selectedFilterLabels.delete(message.labelId);
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-assign') {
    const { cardId, label } = message;
    const loc = findCard(cardId);
    if (loc) {
      const card = loc.card;
      card.labels = card.labels || [];
      if (!card.labels.some(l => l.id === label.id)) card.labels.push(label);
    }
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-unassign') {
    const { cardId, labelId } = message;
    const loc = findCard(cardId);
    if (loc) {
      const card = loc.card;
      card.labels = (card.labels || []).filter(l => l.id !== labelId);
    }
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
  const [boardRes, labelsRes] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`)
  ]);
  if (!boardRes.ok) throw new Error('Could not load board');
  if (labelsRes.ok) labels = await labelsRes.json();
  board = normalizeBoard(await boardRes.json());
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
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
