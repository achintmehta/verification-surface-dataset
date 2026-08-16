import type { Column, Card } from '../../shared/types.js';
import { getState, subscribe, optimisticMove } from './state.js';
import { createCard, moveCard } from './api.js';

let boardEl: HTMLElement;
let draggedCardId: string | null = null;
let draggedSourceColumnId: string | null = null;

export function initRenderer(): void {
  boardEl = document.getElementById('board')!;
  subscribe(render);
  render();
}

function render(): void {
  const { columns } = getState();
  if (columns.length === 0) {
    boardEl.innerHTML = '<p style="color:#8b949e;padding:40px">Loading board...</p>';
    return;
  }

  // Reconcile columns - update in place to preserve scroll/focus state
  const existingColumnEls = boardEl.querySelectorAll<HTMLElement>('.column');
  const existingColumnIds = new Set<string>();

  existingColumnEls.forEach((el) => {
    const colId = el.dataset['columnId'];
    if (colId) existingColumnIds.add(colId);
  });

  // Simple approach: rebuild (for a small board this is efficient and avoids stale references)
  boardEl.innerHTML = '';

  for (const column of columns) {
    boardEl.appendChild(renderColumn(column));
  }
}

function renderColumn(column: Column): HTMLElement {
  const colEl = document.createElement('div');
  colEl.className = 'column';
  colEl.dataset['columnId'] = column.id;

  // Header
  const header = document.createElement('div');
  header.className = 'column-header';
  header.innerHTML = `
    <span>${escapeHtml(column.title)}</span>
    <span class="card-count">${column.cards.length}</span>
  `;
  colEl.appendChild(header);

  // Card list
  const cardList = document.createElement('div');
  cardList.className = 'card-list';
  cardList.dataset['columnId'] = column.id;

  for (const card of column.cards) {
    cardList.appendChild(renderCard(card));
  }

  // Drag-and-drop events on the card list
  cardList.addEventListener('dragover', handleDragOver);
  cardList.addEventListener('dragenter', handleDragEnter);
  cardList.addEventListener('dragleave', handleDragLeave);
  cardList.addEventListener('drop', handleDrop);

  colEl.appendChild(cardList);

  // Add card button / form
  const addBtn = document.createElement('button');
  addBtn.className = 'add-card-btn';
  addBtn.textContent = '+ Add a card';
  addBtn.addEventListener('click', () => showAddCardForm(colEl, column.id));
  colEl.appendChild(addBtn);

  return colEl;
}

function renderCard(card: Card): HTMLElement {
  const cardEl = document.createElement('div');
  cardEl.className = 'card';
  cardEl.dataset['cardId'] = card.id;
  cardEl.draggable = true;
  cardEl.textContent = card.text;

  cardEl.addEventListener('dragstart', (e: DragEvent) => {
    draggedCardId = card.id;
    draggedSourceColumnId = card.column_id;
    cardEl.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', card.id);
  });

  cardEl.addEventListener('dragend', () => {
    cardEl.classList.remove('dragging');
    draggedCardId = null;
    draggedSourceColumnId = null;
    // Clean up any lingering drop indicators
    document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });

  return cardEl;
}

function handleDragEnter(e: DragEvent): void {
  e.preventDefault();
  const target = e.currentTarget as HTMLElement;
  target.classList.add('drag-over');
}

function handleDragLeave(e: DragEvent): void {
  const target = e.currentTarget as HTMLElement;
  // Only remove if actually leaving the container
  const relatedTarget = e.relatedTarget as HTMLElement | null;
  if (!target.contains(relatedTarget)) {
    target.classList.remove('drag-over');
    // Remove drop indicators
    target.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
  }
}

function handleDragOver(e: DragEvent): void {
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';

  const cardList = e.currentTarget as HTMLElement;
  const afterElement = getDragAfterElement(cardList, e.clientY);

  // Remove existing indicators
  cardList.querySelectorAll('.drop-indicator').forEach((el) => el.remove());

  // Add drop indicator
  const indicator = document.createElement('div');
  indicator.className = 'drop-indicator';

  if (afterElement) {
    cardList.insertBefore(indicator, afterElement);
  } else {
    cardList.appendChild(indicator);
  }
}

function handleDrop(e: DragEvent): void {
  e.preventDefault();
  const cardList = e.currentTarget as HTMLElement;
  cardList.classList.remove('drag-over');
  cardList.querySelectorAll('.drop-indicator').forEach((el) => el.remove());

  if (!draggedCardId) return;

  const targetColumnId = cardList.dataset['columnId']!;
  const afterElement = getDragAfterElement(cardList, e.clientY);

  // Calculate the target index
  const cardElements = Array.from(cardList.querySelectorAll<HTMLElement>('.card'))
    .filter((el) => el.dataset['cardId'] !== draggedCardId);

  let targetIndex: number;
  if (afterElement) {
    const afterIdx = cardElements.indexOf(afterElement as HTMLElement);
    targetIndex = afterIdx >= 0 ? afterIdx : cardElements.length;
  } else {
    targetIndex = cardElements.length;
  }

  const cardId = draggedCardId;

  // Optimistic update
  const { afterId, beforeId } = optimisticMove(cardId, targetColumnId, targetIndex);

  // Send to server
  moveCard(cardId, {
    columnId: targetColumnId,
    afterId,
    beforeId,
  }).catch((err) => {
    console.error('Failed to move card:', err);
    // The SSE stream will reconcile state
  });
}

/**
 * Find the element after which the dragged item should be inserted,
 * based on the mouse Y position.
 */
function getDragAfterElement(cardList: HTMLElement, y: number): Element | null {
  const draggableElements = Array.from(
    cardList.querySelectorAll<HTMLElement>('.card:not(.dragging)')
  );

  let closest: { offset: number; element: Element } | null = null;

  for (const child of draggableElements) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;

    if (offset < 0 && (closest === null || offset > closest.offset)) {
      closest = { offset, element: child };
    }
  }

  return closest ? closest.element : null;
}

function showAddCardForm(colEl: HTMLElement, columnId: string): void {
  // Remove existing form if any
  const existingForm = colEl.querySelector('.add-card-form');
  if (existingForm) {
    existingForm.remove();
    return;
  }

  // Hide the add button
  const addBtn = colEl.querySelector('.add-card-btn') as HTMLElement;
  addBtn.style.display = 'none';

  const form = document.createElement('div');
  form.className = 'add-card-form';

  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Enter card text...';

  const actions = document.createElement('div');
  actions.className = 'form-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = 'Add Card';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-secondary';
  cancelBtn.textContent = 'Cancel';

  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);

  form.appendChild(textarea);
  form.appendChild(actions);

  colEl.appendChild(form);
  textarea.focus();

  const closeForm = (): void => {
    form.remove();
    addBtn.style.display = '';
  };

  submitBtn.addEventListener('click', async () => {
    const text = textarea.value.trim();
    if (!text) return;

    submitBtn.disabled = true;
    try {
      await createCard({ column_id: columnId, text });
      closeForm();
    } catch (err) {
      console.error('Failed to create card:', err);
      submitBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', closeForm);

  textarea.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitBtn.click();
    }
    if (e.key === 'Escape') {
      closeForm();
    }
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
