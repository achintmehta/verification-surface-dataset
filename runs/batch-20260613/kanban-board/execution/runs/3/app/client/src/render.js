/**
 * DOM rendering helpers.
 *
 * Strategy: keep a map of column/card elements and do targeted updates
 * rather than full re-renders, to avoid disrupting drag state.
 */

// Maps: id → DOM element
const columnEls = new Map(); // columnId → .column element
const cardEls   = new Map(); // cardId   → .card element

let boardEl = null;
let onAddCard = null; // callback(columnId, text)

export function initRenderer(board, addCardCallback) {
  boardEl = board;
  onAddCard = addCardCallback;
}

/* ------------------------------------------------------------------ */
/*  Full board render (initial load)                                    */
/* ------------------------------------------------------------------ */
export function renderBoard(columns) {
  boardEl.innerHTML = '';
  columnEls.clear();
  cardEls.clear();

  for (const col of columns) {
    const colEl = createColumnEl(col);
    boardEl.appendChild(colEl);
    columnEls.set(col.id, colEl);

    for (const card of col.cards) {
      const cardEl = createCardEl(card);
      getCardList(colEl).appendChild(cardEl);
      cardEls.set(card.id, cardEl);
    }

    updateCardCount(colEl, col.cards.length);
  }
}

/* ------------------------------------------------------------------ */
/*  Incremental updates                                                  */
/* ------------------------------------------------------------------ */

/**
 * Insert or update a card in the DOM, ensuring it lives in exactly one column.
 * @param {object} card - canonical card from server or optimistic state
 */
export function upsertCardEl(card) {
  // Remove from wherever it currently is
  const existing = cardEls.get(card.id);
  if (existing && existing.parentNode) {
    const oldList = existing.parentNode;
    oldList.removeChild(existing);
    updateCountForList(oldList);
  }

  // Get or create the card element
  const cardEl = existing ?? createCardEl(card);
  cardEl.dataset.cardId = card.id;
  cardEl.dataset.position = card.position;
  cardEl.querySelector('.card-text').textContent = card.text;
  cardEls.set(card.id, cardEl);

  // Insert into the target column at the correct position
  const colEl = columnEls.get(card.column_id);
  if (!colEl) {
    console.warn('[render] unknown column', card.column_id);
    return;
  }

  const list = getCardList(colEl);
  insertCardInOrder(list, cardEl, card.position);
  updateCountForList(list);
}

/**
 * Replace all cards in a column (after renormalization).
 */
export function replaceColumnCardsEl(columnId, cards) {
  const colEl = columnEls.get(columnId);
  if (!colEl) return;

  const list = getCardList(colEl);

  // Remove all existing card elements from this list
  const existingCards = [...list.querySelectorAll('.card:not(.card-ghost)')];
  for (const el of existingCards) {
    list.removeChild(el);
    // Don't delete from cardEls map – they'll be re-inserted
  }

  // Re-insert in canonical order
  const sorted = [...cards].sort((a, b) => a.position - b.position);
  for (const card of sorted) {
    let cardEl = cardEls.get(card.id);
    if (!cardEl) {
      cardEl = createCardEl(card);
      cardEls.set(card.id, cardEl);
    }
    cardEl.dataset.position = card.position;
    list.appendChild(cardEl);
  }

  updateCardCount(colEl, sorted.length);
}

/* ------------------------------------------------------------------ */
/*  Element factories                                                    */
/* ------------------------------------------------------------------ */

function createColumnEl(col) {
  const el = document.createElement('div');
  el.className = 'column';
  el.dataset.columnId = col.id;
  el.innerHTML = `
    <div class="column-header">
      <span class="column-title">${escHtml(col.title)}</span>
      <span class="card-count">0</span>
    </div>
    <div class="card-list" data-column-id="${col.id}"></div>
    <div class="add-card-area">
      <button class="add-card-btn">+ Add a card</button>
      <form class="add-card-form">
        <textarea placeholder="Enter card text…" rows="3"></textarea>
        <div class="form-actions">
          <button type="submit" class="btn-primary">Add card</button>
          <button type="button" class="btn-cancel">✕</button>
        </div>
      </form>
    </div>
  `;

  // Wire up add-card UI
  const btn  = el.querySelector('.add-card-btn');
  const form = el.querySelector('.add-card-form');
  const ta   = form.querySelector('textarea');
  const cancel = form.querySelector('.btn-cancel');

  btn.addEventListener('click', () => {
    btn.style.display = 'none';
    form.classList.add('open');
    ta.focus();
  });

  cancel.addEventListener('click', () => closeForm(btn, form, ta));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return;
    closeForm(btn, form, ta);
    await onAddCard(col.id, text);
  });

  // Close on Escape
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeForm(btn, form, ta);
  });

  return el;
}

function closeForm(btn, form, ta) {
  form.classList.remove('open');
  btn.style.display = '';
  ta.value = '';
}

function createCardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.cardId = card.id;
  el.dataset.position = card.position;
  el.innerHTML = `<span class="card-text">${escHtml(card.text)}</span>`;
  return el;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                              */
/* ------------------------------------------------------------------ */

function getCardList(colEl) {
  return colEl.querySelector('.card-list');
}

/**
 * Insert cardEl into list so that cards remain sorted by position.
 */
function insertCardInOrder(listEl, cardEl, position) {
  const siblings = [...listEl.querySelectorAll('.card:not(.card-ghost)')].filter(
    (el) => el !== cardEl
  );

  for (const sib of siblings) {
    const sibPos = parseFloat(sib.dataset.position);
    if (position < sibPos) {
      listEl.insertBefore(cardEl, sib);
      return;
    }
  }
  listEl.appendChild(cardEl);
}

function updateCountForList(listEl) {
  const colEl = listEl.closest('.column');
  if (!colEl) return;
  const count = listEl.querySelectorAll('.card:not(.card-ghost)').length;
  updateCardCount(colEl, count);
}

function updateCardCount(colEl, count) {
  const badge = colEl.querySelector('.card-count');
  if (badge) badge.textContent = count;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
