import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelFilters = new Set();
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

function getVisibleCards(cards) {
  if (selectedLabelFilters.size === 0) return cards;
  return cards.filter(card => {
    const cardLabels = card.labels || [];
    return cardLabels.some(l => selectedLabelFilters.has(l.id));
  });
}

function render() {
  const filterHtml = `
    <div class="filter-bar">
      <span class="filter-label">Filter by labels:</span>
      <div class="label-filters">
        ${labels.map(label => `
          <label class="label-chip filter-chip ${selectedLabelFilters.has(label.id) ? 'selected' : ''}" style="--label-color: ${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">
            <input type="checkbox" ${selectedLabelFilters.has(label.id) ? 'checked' : ''} />
            ${escapeHtml(label.name)}
          </label>
        `).join('')}
        ${labels.length === 0 ? '<span class="no-labels">No labels yet</span>' : ''}
      </div>
      <button class="manage-labels-btn">Manage Labels</button>
    </div>
  `;

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="filter-container">
      ${filterHtml}
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    <div id="label-manager" class="label-manager hidden">
      <div class="label-manager-content">
        <h3>Manage Labels</h3>
        <form class="create-label-form">
          <input name="name" type="text" placeholder="Label name" maxlength="50" required />
          <input name="color" type="color" value="#3b82f6" />
          <button type="submit">Create</button>
        </form>
        <div class="label-list">
          ${labels.map(renderLabelItem).join('')}
        </div>
        <button class="close-manager-btn">Close</button>
      </div>
    </div>
  `;
  bindEvents();
  bindLabelEvents();
}

function renderColumn(column) {
  const visibleCards = getVisibleCards(column.cards);
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

function renderLabelItem(label) {
  return `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="--label-color: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <input type="text" class="label-name-edit" value="${escapeHtml(label.name)}" />
      <input type="color" class="label-color-edit" value="${escapeHtml(label.color)}" />
      <button class="save-label-btn">Save</button>
      <button class="delete-label-btn">Delete</button>
    </div>
  `;
}

function renderCard(card) {
  const labelsHtml = (card.labels || []).map(label => `
    <span class="label-chip card-chip" style="--label-color: ${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>
  `).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">${labelsHtml}</div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-actions">
        <button class="assign-label-btn" data-card-id="${escapeHtml(card.id)}" title="Assign label">+</button>
      </div>
    </article>
  `;
}

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

function bindLabelEvents() {
  // Filter chips
  document.querySelectorAll('.filter-chip').forEach(chip => {
    const checkbox = chip.querySelector('input');
    const labelId = chip.dataset.labelId;
    const toggle = () => {
      if (checkbox.checked) {
        selectedLabelFilters.add(labelId);
        chip.classList.add('selected');
      } else {
        selectedLabelFilters.delete(labelId);
        chip.classList.remove('selected');
      }
      // re-render board only
      const boardEl = document.querySelector('.board');
      if (boardEl) {
        boardEl.innerHTML = board.columns.map(renderColumn).join('');
        bindDragAndDrop();
        bindCardActions();
      }
    };
    chip.addEventListener('click', (e) => {
      if (e.target !== checkbox) {
        checkbox.checked = !checkbox.checked;
      }
      toggle();
    });
    checkbox.addEventListener('change', toggle);
  });

  // Manage labels button
  const manageBtn = document.querySelector('.manage-labels-btn');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      const manager = document.getElementById('label-manager');
      if (manager) manager.classList.remove('hidden');
    });
  }

  // Close manager
  const closeBtn = document.querySelector('.close-manager-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      const manager = document.getElementById('label-manager');
      if (manager) manager.classList.add('hidden');
      loadLabels().then(() => render());
    });
  }

  // Create label
  const createForm = document.querySelector('.create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
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
        await loadLabels();
        render();
      } catch (err) {
        alert('Create label failed');
      }
    });
  }

  // Label item actions in manager
  document.querySelectorAll('.label-item').forEach(item => {
    const labelId = item.dataset.labelId;
    const saveBtn = item.querySelector('.save-label-btn');
    const delBtn = item.querySelector('.delete-label-btn');
    const nameInput = item.querySelector('.label-name-edit');
    const colorInput = item.querySelector('.label-color-edit');

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        const color = colorInput.value;
        if (!name) return;
        try {
          const res = await fetch(`${API_BASE}/api/labels/${labelId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, color }),
          });
          if (!res.ok) {
            const err = await res.json();
            alert(err.error || 'Failed');
            return;
          }
          await loadLabels();
          render();
        } catch {
          alert('Update failed');
        }
      });
    }

    if (delBtn) {
      delBtn.addEventListener('click', async () => {
        if (!confirm('Delete this label?')) return;
        try {
          await fetch(`${API_BASE}/api/labels/${labelId}`, { method: 'DELETE' });
          await loadLabels();
          render();
        } catch {
          alert('Delete failed');
        }
      });
    }
  });

  // Assign label buttons
  bindCardActions();
}

function bindCardActions() {
  document.querySelectorAll('.assign-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      if (!labels.length) {
        alert('No labels available. Create some first.');
        return;
      }
      const labelOptions = labels.map(l => `${l.id}:${l.name}`).join('\n');
      const choice = prompt(`Enter label name or id to assign:\n${labelOptions}`);
      if (!choice) return;
      const found = labels.find(l => l.name === choice || l.id === choice);
      if (!found) {
        alert('Label not found');
        return;
      }
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId: found.id }),
        });
      } catch {
        alert('Assign failed');
      }
    });
  });

  // Click chip to remove label from card
  document.querySelectorAll('.card-chip').forEach(chip => {
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cardEl = chip.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const labelId = chip.dataset.labelId;
      try {
        await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
      } catch {
        alert('Remove failed');
      }
    });
  });
}

function bindDragAndDrop() {
  // rebind drag drop after filter re-render
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(list, draggedCardId);
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
        await loadBoard();
      }
    });
  });
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (message.type && message.type.startsWith('label-')) {
    // reload labels and board for label changes
    loadLabels().then(() => loadBoard()).catch(() => {});
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
  render();
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
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
