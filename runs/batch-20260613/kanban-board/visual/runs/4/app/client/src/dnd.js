/**
 * Drag-and-drop module.
 *
 * Uses the HTML5 Drag-and-Drop API.
 * Emits a custom 'card-drop' event on the board element with:
 *   detail: { cardId, targetColumnId, afterId, beforeId }
 */

let dragCardId = null;
let dragSourceColumnId = null;
let placeholder = null;

export function initDnd(boardEl) {
  boardEl.addEventListener('dragstart', onDragStart);
  boardEl.addEventListener('dragend',   onDragEnd);
  boardEl.addEventListener('dragover',  onDragOver);
  boardEl.addEventListener('dragenter', onDragEnter);
  boardEl.addEventListener('dragleave', onDragLeave);
  boardEl.addEventListener('drop',      onDrop);
}

function getCardEl(el) {
  return el.closest('.card');
}

function getColumnEl(el) {
  return el.closest('.column');
}

function getCardsEl(el) {
  return el.closest('.column-cards');
}

/* ---- drag start ---- */
function onDragStart(e) {
  const card = getCardEl(e.target);
  if (!card) return;

  dragCardId = card.dataset.cardId;
  dragSourceColumnId = getColumnEl(card)?.dataset.columnId;

  card.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragCardId);

  // Create placeholder
  placeholder = document.createElement('div');
  placeholder.className = 'drop-placeholder';
  placeholder.dataset.placeholder = 'true';
}

/* ---- drag end ---- */
function onDragEnd(e) {
  const card = getCardEl(e.target);
  if (card) card.classList.remove('dragging');

  removePlaceholder();
  clearColumnHighlights();

  dragCardId = null;
  dragSourceColumnId = null;
}

/* ---- drag over (fires continuously) ---- */
function onDragOver(e) {
  if (!dragCardId) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';

  const cardsEl = getCardsEl(e.target);
  if (!cardsEl) return;

  // Find the card we're hovering over
  const overCard = getCardEl(e.target);

  if (overCard && overCard.dataset.cardId !== dragCardId && !overCard.dataset.placeholder) {
    const rect = overCard.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;

    if (e.clientY < midY) {
      // Insert before overCard
      cardsEl.insertBefore(placeholder, overCard);
    } else {
      // Insert after overCard
      cardsEl.insertBefore(placeholder, overCard.nextSibling);
    }
  } else if (!overCard || overCard.dataset.cardId === dragCardId) {
    // Hovering over empty space or the dragged card itself → append
    if (placeholder.parentElement !== cardsEl) {
      cardsEl.appendChild(placeholder);
    }
  }
}

/* ---- drag enter ---- */
function onDragEnter(e) {
  if (!dragCardId) return;
  const col = getColumnEl(e.target);
  if (col) col.classList.add('drag-over');
}

/* ---- drag leave ---- */
function onDragLeave(e) {
  if (!dragCardId) return;
  const col = getColumnEl(e.target);
  if (col && !col.contains(e.relatedTarget)) {
    col.classList.remove('drag-over');
  }
}

/* ---- drop ---- */
function onDrop(e) {
  if (!dragCardId) return;
  e.preventDefault();

  const col = getColumnEl(e.target);
  if (!col) { removePlaceholder(); return; }

  col.classList.remove('drag-over');

  const targetColumnId = col.dataset.columnId;
  const cardsEl = col.querySelector('.column-cards');

  // Determine afterId / beforeId from placeholder position
  let afterId  = null;
  let beforeId = null;

  if (placeholder.parentElement === cardsEl) {
    // Walk siblings to find neighbours (skip placeholder and dragged card)
    const siblings = [...cardsEl.children].filter(
      el => !el.dataset.placeholder && el.dataset.cardId !== dragCardId
    );
    const phIndex = [...cardsEl.children].indexOf(placeholder);

    // Cards before placeholder (in DOM order, excluding dragged card)
    const before = [...cardsEl.children]
      .slice(0, phIndex)
      .filter(el => !el.dataset.placeholder && el.dataset.cardId !== dragCardId);

    const after = [...cardsEl.children]
      .slice(phIndex + 1)
      .filter(el => !el.dataset.placeholder && el.dataset.cardId !== dragCardId);

    afterId  = before.length ? before[before.length - 1].dataset.cardId : null;
    beforeId = after.length  ? after[0].dataset.cardId                  : null;
  }

  removePlaceholder();
  clearColumnHighlights();

  // Emit custom event
  const event = new CustomEvent('card-drop', {
    bubbles: true,
    detail: { cardId: dragCardId, targetColumnId, afterId, beforeId },
  });
  col.dispatchEvent(event);
}

/* ---- helpers ---- */
function removePlaceholder() {
  placeholder?.parentElement?.removeChild(placeholder);
}

function clearColumnHighlights() {
  document.querySelectorAll('.column.drag-over').forEach(el => el.classList.remove('drag-over'));
}
