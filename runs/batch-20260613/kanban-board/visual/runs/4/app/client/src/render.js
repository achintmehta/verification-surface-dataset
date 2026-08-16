/**
 * DOM rendering helpers.
 *
 * We do a targeted reconcile rather than a full re-render to avoid
 * disrupting any in-progress drag operations.
 */

/* ------------------------------------------------------------------ */
/*  Full board render (initial load or hard reset)                      */
/* ------------------------------------------------------------------ */
export function renderBoard(boardEl, state) {
  boardEl.innerHTML = '';
  for (const col of state.columns) {
    const cards = state.cards[col.id] || [];
    boardEl.appendChild(createColumnEl(col, cards));
  }
}

/* ------------------------------------------------------------------ */
/*  Column element factory                                              */
/* ------------------------------------------------------------------ */
function createColumnEl(col, cards) {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset.columnId = col.id;

  colEl.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="column-count">${cards.length}</span>
    </div>
    <div class="column-cards"></div>
    <div class="column-footer">
      <button class="btn-add-card" data-column-id="${col.id}">
        <span class="plus-icon">+</span> Add card
      </button>
    </div>
  `;

  const cardsEl = colEl.querySelector('.column-cards');
  for (const card of cards) {
    cardsEl.appendChild(createCardEl(card));
  }

  return colEl;
}

/* ------------------------------------------------------------------ */
/*  Card element factory                                                */
/* ------------------------------------------------------------------ */
function createCardEl(card, isNew = false) {
  const el = document.createElement('div');
  el.className = 'card' + (isNew ? ' card-new' : '');
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;

  const date = new Date(card.created_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric',
  });

  el.innerHTML = `
    <div class="card-text">${escHtml(card.text)}</div>
    <div class="card-meta">${date}</div>
  `;
  return el;
}

/* ------------------------------------------------------------------ */
/*  Reconcile a single column's card list                               */
/*                                                                      */
/*  Strategy:                                                           */
/*   1. Remove cards that no longer belong to this column.              */
/*   2. Insert new cards (with animation).                              */
/*   3. Reorder existing cards to match the canonical sorted order,     */
/*      but skip any card that is currently being dragged.              */
/* ------------------------------------------------------------------ */
export function reconcileColumn(boardEl, columnId, cards) {
  const colEl = boardEl.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!colEl) return;

  const cardsEl = colEl.querySelector('.column-cards');
  const sorted  = [...cards].sort((a, b) => a.position - b.position);

  // Build a map of existing card elements
  const existing = new Map();
  for (const el of cardsEl.querySelectorAll('.card')) {
    existing.set(el.dataset.cardId, el);
  }

  // Remove cards that no longer belong here
  for (const [id, el] of existing) {
    if (!sorted.find(c => c.id === id)) {
      el.remove();
      existing.delete(id);
    }
  }

  // Insert / reorder (skip cards currently being dragged)
  for (let i = 0; i < sorted.length; i++) {
    const card = sorted[i];
    let el = existing.get(card.id);

    if (!el) {
      // New card – create and animate
      el = createCardEl(card, true);
      existing.set(card.id, el);
    } else {
      // Update position data attribute
      el.dataset.position = card.position;
    }

    // Skip reordering a card that is currently being dragged
    if (el.classList.contains('dragging')) continue;

    // Determine the correct DOM slot (ignoring placeholders and dragging cards)
    const domChildren = [...cardsEl.children].filter(
      c => !c.dataset.placeholder && !c.classList.contains('dragging')
    );

    if (domChildren[i] !== el) {
      // Find reference node: the next non-placeholder, non-dragging child
      const refNode = domChildren[i] || null;
      cardsEl.insertBefore(el, refNode);
    }
  }

  // Update count badge
  const countEl = colEl.querySelector('.column-count');
  if (countEl) {
    // Count only real cards (not placeholders)
    const realCards = cardsEl.querySelectorAll('.card:not([data-placeholder])').length;
    countEl.textContent = sorted.length;
  }
}

/* ------------------------------------------------------------------ */
/*  Utility                                                             */
/* ------------------------------------------------------------------ */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
