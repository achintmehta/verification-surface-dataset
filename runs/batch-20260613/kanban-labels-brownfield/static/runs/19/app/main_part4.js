rdEl.classList.remove('dragging');
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
        const response = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/move\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(\`Move rejected: \${error.message}\`, true);
        await loadBoard();
      }
    });
  });

  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabelIds.add(e.target.value);
      } else {
        selectedLabelIds.delete(e.target.value);
      }
      render();
    });
  });

  const clearFilterBtn = document.getElementById('clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }

  const manageLabelsBtn = document.getElementById('manage-labels-btn');
  if (manageLabelsBtn) {
    manageLabelsBtn.addEventListener('click', () => {
      document.getElementById('label-manager-dialog').showModal();
    });
  }

  const createLabelBtn = document.getElementById('create-label-btn');
  if (createLabelBtn) {
    createLabelBtn.addEventListener('click', async () => {
      const name = document.getElementById('new-label-name').value.trim();
      const color = document.getElementById('new-label-color').value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Create label failed');
      } catch (err) {
        alert(err.message);
      }
    });
  }

  document.querySelectorAll('.edit-label-name, .edit-label-color').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const li = e.target.closest('li');
      const name = li.querySelector('.edit-label-name').value.trim();
      const color = li.querySelector('.edit-label-color').value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${encodeURIComponent(id)}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Update label failed');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${encodeURIComponent(id)}\`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Delete label failed');
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.assign-label-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const cardId = e.target.dataset.cardId;
      const cardInfo = findCard(cardId);
      if (!cardInfo) return;
      const card = cardInfo.card;
      const cardLabelIds = new Set((card.labels || []).map(l => l.id));
      
      const listHtml = labels.map(l => \`
        <label>
          <input type="checkbox" class="assign-checkbox" data-card-id="\${escapeHtml(cardId)}" value="\${escapeHtml(l.id)}" \${cardLabelIds.has(l.id) ? 'checked' : ''}>
          <span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)}</span>
        </label>
      \`).join('<br>');
      
      const dialog = document.getElementById('assign-label-dialog');
      document.getElementById('assign-label-list').innerHTML = listHtml;
      
      document.querySelectorAll('.assign-checkbox').forEach(cb => {
        cb.addEventListener('change', async (ev) => {
          const lId = ev.target.value;
          const cId = ev.target.dataset.cardId;
          try {
            if (ev.target.checked) {
              await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cId)}/labels\`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ labelId: lId })
              });
            } else {
              await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cId)}/labels/\${encodeURIComponent(lId)}\`, {
                method: 'DELETE'
              });
            }
          } catch (err) {
            alert(err.message);
          }
        });
      });
      
      dialog.showModal();
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
  if (message.type === 'create_label') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    return;
  }
  if (message.type === 'update_label') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update labels in cards
      for (const col of board.columns) {
        for (const card of col.cards) {
          if (card.labels) {
            const lIndex = card.labels.findIndex(l => l.id === message.label.id);
            if (lIndex !== -1) card.labels[lIndex] = message.label;
          }
        }
      }
      render();
    }
    return;
  }
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
    // Remove from cards
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          card.labels = card.labels.filter(l => l.id !== message.labelId);
        }
      }
    }
    render();
    return;
  }
  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    const cardInfo = findCard(message.cardId);
    if (cardInfo) {
      cardInfo.card.labels = message.card.labels;
      render();
    }
    return;
  }

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
