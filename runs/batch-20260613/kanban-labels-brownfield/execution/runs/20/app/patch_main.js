import fs from 'fs';

const code = `import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabels = new Set();
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

function render() {
  app.innerHTML = \`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="controls">
      <div class="filter-bar">
        <strong>Filter:</strong>
        \${labels.map(label => \`
          <label class="filter-label">
            <input type="checkbox" value="\${escapeHtml(label.id)}" \${selectedLabels.has(label.id) ? 'checked' : ''}>
            <span class="chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
          </label>
        \`).join('')}
        \${selectedLabels.size > 0 ? \`<button id="clear-filter">Clear</button>\` : ''}
      </div>
      <div class="label-manager">
        <strong>Labels:</strong>
        <form id="add-label-form">
          <input type="text" name="name" placeholder="New label name" required>
          <input type="color" name="color" value="#ff0000" required>
          <button type="submit">Add</button>
        </form>
        <div class="label-list">
          \${labels.map(label => \`
            <div class="label-item" data-label-id="\${escapeHtml(label.id)}">
              <input type="color" class="edit-label-color" value="\${escapeHtml(label.color)}">
              <input type="text" class="edit-label-name" value="\${escapeHtml(label.name)}">
              <button class="delete-label">X</button>
            </div>
          \`).join('')}
        </div>
      </div>
    </div>
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
  \`;
  bindEvents();
}

function renderColumn(column) {
  const filteredCards = column.cards.filter(card => {
    if (selectedLabels.size === 0) return true;
    return card.labels && card.labels.some(l => selectedLabels.has(l.id));
  });

  return \`
    <section class="column" data-column-id="\${escapeHtml(column.id)}">
      <h2>\${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="\${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="\${escapeHtml(column.id)}">
        \${filteredCards.map(renderCard).join('')}
      </div>
    </section>
  \`;
}

function renderCard(card) {
  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${(card.labels || []).map(l => \`
          <span class="chip" style="background-color: \${escapeHtml(l.color)}">
            \${escapeHtml(l.name)}
            <button class="remove-card-label" data-label-id="\${escapeHtml(l.id)}">&times;</button>
          </span>
        \`).join('')}
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
      <div class="card-actions">
        <select class="add-card-label">
          <option value="">Add label...</option>
          \${labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(l => \`
            <option value="\${escapeHtml(l.id)}">\${escapeHtml(l.name)}</option>
          \`).join('')}
        </select>
      </div>
    </article>
  \`;
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

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      draggedCardId = card.dataset.cardId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });

    card.addEventListener('dragend', () => {
      draggedCardId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
    });

    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) {
        list.classList.remove('drop-target');
      }
    });

    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = event.dataTransfer.getData('text/plain');
      if (!cardId) return;

      const columnId = list.dataset.columnId;
      const afterElement = getDragAfterElement(list, event.clientY);
      
      let beforeId = null;
      let afterId = null;

      if (afterElement) {
        beforeId = afterElement.dataset.cardId;
        const prev = afterElement.previousElementSibling;
        if (prev && prev.classList.contains('card')) {
          afterId = prev.dataset.cardId;
        }
      } else {
        const last = list.lastElementChild;
        if (last && last.classList.contains('card')) {
          afterId = last.dataset.cardId;
        }
      }

      const current = findCard(cardId);
      if (!current) return;
      const { beforeId: currentBefore, afterId: currentAfter } = getNeighbors(current.column.id, cardId);
      if (current.column.id === columnId && currentBefore === beforeId && currentAfter === afterId) {
        return;
      }

      optimisticMove(cardId, columnId, beforeId, afterId);
      render();

      try {
        const response = await fetch(\`\${API_BASE}/api/cards/\${cardId}/move\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(\`Move failed: \${error.message}\`, true);
        await loadBoard();
      }
    });
  });

  // Label filtering
  document.querySelectorAll('.filter-label input').forEach(input => {
    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabels.add(e.target.value);
      } else {
        selectedLabels.delete(e.target.value);
      }
      render();
    });
  });

  const clearFilterBtn = document.getElementById('clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabels.clear();
      render();
    });
  }

  // Label management
  const addLabelForm = document.getElementById('add-label-form');
  if (addLabelForm) {
    addLabelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = addLabelForm.elements.name.value.trim();
      const color = addLabelForm.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to create label');
        addLabelForm.reset();
      } catch (err) {
        alert(err.message);
      }
    });
  }

  document.querySelectorAll('.edit-label-name').forEach(input => {
    input.addEventListener('change', async (e) => {
      const labelId = e.target.closest('.label-item').dataset.labelId;
      const name = e.target.value.trim();
      const color = e.target.closest('.label-item').querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${labelId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to update label');
      } catch (err) {
        alert(err.message);
        await loadBoard();
      }
    });
  });

  document.querySelectorAll('.edit-label-color').forEach(input => {
    input.addEventListener('change', async (e) => {
      const labelId = e.target.closest('.label-item').dataset.labelId;
      const color = e.target.value;
      const name = e.target.closest('.label-item').querySelector('.edit-label-name').value.trim();
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${labelId}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to update label');
      } catch (err) {
        alert(err.message);
        await loadBoard();
      }
    });
  });

  document.querySelectorAll('.delete-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const labelId = e.target.closest('.label-item').dataset.labelId;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${labelId}\`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete label');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  // Card label assignment
  document.querySelectorAll('.add-card-label').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (!labelId) return;
      const cardId = e.target.closest('.card').dataset.cardId;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to add label to card');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.remove-card-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const labelId = e.target.dataset.labelId;
      const cardId = e.target.closest('.card').dataset.cardId;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels/\${labelId}\`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to remove label from card');
      } catch (err) {
        alert(err.message);
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
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
}

function getNeighbors(columnId, cardId) {
  const column = board.columns.find((c) => c.id === columnId);
  if (!column) return { beforeId: null, afterId: null };
  const list = document.querySelector(\`.cards[data-column-id="\${escapeHtml(columnId)}"]\`);
  if (!list) return { beforeId: null, afterId: null };
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
    const response = await fetch(\`\${API_BASE}/api/cards\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
  } catch (error) {
    setStatus(\`Create failed: \${error.message}\`, true);
  }
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label_created') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    return;
  }

  if (message.type === 'label_updated') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update labels in cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            const lIndex = card.labels.findIndex(l => l.id === message.label.id);
            if (lIndex !== -1) {
              card.labels[lIndex] = message.label;
            }
          }
        }
      }
      render();
    }
    return;
  }

  if (message.type === 'label_deleted') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabels.delete(message.labelId);
    // Remove label from cards
    for (const column of board.columns) {
      for (const card of column.cards) {
        if (card.labels) {
          card.labels = card.labels.filter(l => l.id !== message.labelId);
        }
      }
    }
    render();
    return;
  }

  if (message.type === 'card_label_added' || message.type === 'card_label_removed') {
    const cardInfo = findCard(message.cardId);
    if (cardInfo) {
      cardInfo.card.labels = message.card.labels;
      render();
    }
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
    fetch(\`\${API_BASE}/api/board\`),
    fetch(\`\${API_BASE}/api/labels\`)
  ]);
  if (!boardRes.ok || !labelsRes.ok) throw new Error('Could not load board or labels');
  board = normalizeBoard(await boardRes.json());
  labels = await labelsRes.json();
  render();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(\`\${API_BASE}/api/stream\`);
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
    app.innerHTML = \`<div class="loading error">\${escapeHtml(error.message)}</div>\`;
  }
}

start();
`;

fs.writeFileSync('src/main.js', code);
