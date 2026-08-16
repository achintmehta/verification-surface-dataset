/**
 * main.js – Entry point for the week-view calendar frontend.
 *
 * Responsibilities:
 *  - Render the week grid (time axis, day headers, hour lines, day columns).
 *  - Fetch events from the API and render them with the overlap layout engine.
 *  - Handle drag-to-create on empty space.
 *  - Handle click-to-edit on existing events.
 *  - Week navigation (prev / today / next).
 *  - Modal form for create / edit / delete.
 */

import {
  computeDayLayout,
  formatTime,
  toDatetimeLocal,
  HOUR_HEIGHT,
  TOTAL_HEIGHT,
} from './layout.js';

import {
  getWeekStart,
  getWeekDays,
  shiftWeek,
  getWeekRange,
  formatWeekLabel,
  getDayName,
  isToday,
  yToMinutes,
  snapMinutes,
  dayPlusMinutes,
} from './week.js';

import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';

/* ============================================================
   State
   ============================================================ */

/** @type {Date} Monday of the currently displayed week. */
let weekStart = getWeekStart(new Date());

/** @type {Array<object>} Events for the current week (raw API rows). */
let events = [];

/* ============================================================
   DOM references
   ============================================================ */

const timeAxisEl   = /** @type {HTMLElement} */ (document.getElementById('time-axis'));
const dayHeadersEl = /** @type {HTMLElement} */ (document.getElementById('day-headers'));
const hourLinesEl  = /** @type {HTMLElement} */ (document.getElementById('hour-lines'));
const dayColumnsEl = /** @type {HTMLElement} */ (document.getElementById('day-columns'));
const weekLabelEl  = /** @type {HTMLElement} */ (document.getElementById('week-label'));
const gridScrollEl = /** @type {HTMLElement} */ (document.getElementById('grid-scroll'));

const modalOverlay = /** @type {HTMLElement} */ (document.getElementById('modal-overlay'));
const modalTitle   = /** @type {HTMLElement} */ (document.getElementById('modal-title'));
const eventForm    = /** @type {HTMLFormElement} */ (document.getElementById('event-form'));
const fieldTitle   = /** @type {HTMLInputElement} */ (document.getElementById('field-title'));
const fieldStart   = /** @type {HTMLInputElement} */ (document.getElementById('field-start'));
const fieldEnd     = /** @type {HTMLInputElement} */ (document.getElementById('field-end'));
const formError    = /** @type {HTMLElement} */ (document.getElementById('form-error'));
const btnSave      = /** @type {HTMLButtonElement} */ (document.getElementById('btn-save'));
const btnDelete    = /** @type {HTMLButtonElement} */ (document.getElementById('btn-delete'));
const btnCancel    = /** @type {HTMLButtonElement} */ (document.getElementById('btn-cancel'));

/* ============================================================
   Grid initialisation (static structure, built once)
   ============================================================ */

function buildTimeAxis() {
  timeAxisEl.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    // Show label for each hour; the 00:00 label is hidden via CSS.
    label.textContent = h === 24 ? '' : `${String(h).padStart(2, '0')}:00`;
    timeAxisEl.appendChild(label);
  }
}

function buildHourLines() {
  hourLinesEl.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line major';
    line.style.top = `${h * HOUR_HEIGHT}px`;
    hourLinesEl.appendChild(line);

    // Half-hour dashed line (skip after 24:00)
    if (h < 24) {
      const half = document.createElement('div');
      half.className = 'half-hour-line';
      half.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      hourLinesEl.appendChild(half);
    }
  }
}

/* ============================================================
   Week rendering
   ============================================================ */

/**
 * Render the day header row for the current week.
 * @param {Date[]} days
 */
function renderDayHeaders(days) {
  dayHeadersEl.innerHTML = '';
  days.forEach((day) => {
    const col = document.createElement('div');
    col.className = 'day-header' + (isToday(day) ? ' today' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'day-name';
    nameEl.textContent = getDayName(day);

    const dateEl = document.createElement('span');
    dateEl.className = 'day-date';
    dateEl.textContent = String(day.getDate());

    col.appendChild(nameEl);
    col.appendChild(dateEl);
    dayHeadersEl.appendChild(col);
  });
}

/**
 * Render all day columns with their events.
 * @param {Date[]} days
 */
function renderDayColumns(days) {
  dayColumnsEl.innerHTML = '';

  // We need the column width for layout. Measure after appending a placeholder
  // or estimate from the container.
  const containerWidth = dayColumnsEl.getBoundingClientRect().width || estimateContainerWidth();
  const colWidth = containerWidth / 7;

  days.forEach((day, _dayIndex) => {
    const col = document.createElement('div');
    col.className = 'day-col' + (isToday(day) ? ' today' : '');

    // Filter events belonging to this day (matched by start date in local time).
    const dayEvents = events.filter((ev) => {
      const evStart = new Date(ev.start_at);
      return (
        evStart.getFullYear() === day.getFullYear() &&
        evStart.getMonth()    === day.getMonth()    &&
        evStart.getDate()     === day.getDate()
      );
    });

    // Compute layout using the estimated column width.
    const layouts = computeDayLayout(dayEvents, colWidth);

    // Render event blocks using percentage-based left/width so they scale
    // correctly if the column is slightly different from our estimate.
    layouts.forEach(({ event, top, height, left, width }) => {
      const block = createEventBlock(event, top, height, left, width, colWidth);
      col.appendChild(block);
    });

    // Attach drag-to-create listeners.
    attachDragListeners(col, day);

    dayColumnsEl.appendChild(col);
  });
}

/**
 * Estimate the day column container width before the DOM has been painted.
 * @returns {number}
 */
function estimateContainerWidth() {
  const timeAxisWidth = 56; // matches --time-axis-width in CSS
  return window.innerWidth - timeAxisWidth;
}

/**
 * Create a single event block DOM element.
 * left and width are in pixels relative to colWidth; we convert to percentages
 * so the block scales correctly with the actual rendered column width.
 *
 * @param {object} event
 * @param {number} top       px from top of grid
 * @param {number} height    px
 * @param {number} left      px (relative to colWidth)
 * @param {number} width     px (relative to colWidth)
 * @param {number} colWidth  reference column width used for layout
 * @returns {HTMLElement}
 */
function createEventBlock(event, top, height, left, width, colWidth) {
  const block = document.createElement('div');
  block.className = 'event-block';
  block.dataset.id = String(event.id);
  block.dataset.color = String(event.id % 8);

  // Use percentage-based horizontal positioning so the layout is correct
  // regardless of any sub-pixel difference between estimated and actual width.
  const leftPct  = (left  / colWidth) * 100;
  const widthPct = (width / colWidth) * 100;

  block.style.top    = `${top}px`;
  block.style.height = `${height}px`;
  block.style.left   = `${leftPct}%`;
  block.style.width  = `${widthPct}%`;

  const titleEl = document.createElement('div');
  titleEl.className = 'event-title';
  titleEl.textContent = event.title;

  const timeEl = document.createElement('div');
  timeEl.className = 'event-time';
  timeEl.textContent = `${formatTime(event.start_at)} – ${formatTime(event.end_at)}`;

  block.appendChild(titleEl);
  block.appendChild(timeEl);

  // Click opens the edit modal.
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    openEditModal(event);
  });

  return block;
}

/* ============================================================
   Layout recalculation on resize
   ============================================================ */

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    const days = getWeekDays(weekStart);
    renderDayColumns(days);
  }, 100);
});

/* ============================================================
   Drag-to-create
   ============================================================ */

/**
 * Attach mousedown → mousemove → mouseup drag listeners to a day column.
 *
 * Interaction model:
 *  - A plain click (mousedown + mouseup with minimal movement) opens the
 *    create modal pre-filled with a 1-hour slot at the clicked time.
 *  - A drag (mousedown + significant mousemove + mouseup) opens the create
 *    modal pre-filled with the dragged time range.
 *  - In both cases the modal is opened exactly once.
 *
 * @param {HTMLElement} col
 * @param {Date} day
 */
function attachDragListeners(col, day) {
  /** @type {number|null} */
  let dragStartY = null;
  /** @type {HTMLElement|null} */
  let dragEl = null;
  /** Whether the pointer moved enough to count as a drag (> 5px). */
  let isDrag = false;

  col.addEventListener('mousedown', (e) => {
    // Only respond to left-button clicks on the column background (not events).
    if (e.button !== 0) return;
    if (e.target !== col) return;

    e.preventDefault();

    const rect = col.getBoundingClientRect();
    dragStartY = e.clientY - rect.top + gridScrollEl.scrollTop;
    isDrag = false;

    // Create a visual drag selection element (hidden until drag threshold).
    dragEl = document.createElement('div');
    dragEl.className = 'drag-selection';
    dragEl.style.top    = `${dragStartY}px`;
    dragEl.style.height = '0px';
    dragEl.style.display = 'none';
    col.appendChild(dragEl);

    /**
     * @param {MouseEvent} ev
     */
    function onMouseMove(ev) {
      if (dragStartY === null || dragEl === null) return;

      const r = col.getBoundingClientRect();
      const currentY = ev.clientY - r.top + gridScrollEl.scrollTop;
      const delta = Math.abs(currentY - dragStartY);

      if (delta > 5) {
        isDrag = true;
        dragEl.style.display = '';
      }

      if (isDrag) {
        const top    = Math.min(dragStartY, currentY);
        const height = Math.abs(currentY - dragStartY);
        dragEl.style.top    = `${top}px`;
        dragEl.style.height = `${Math.max(height, 2)}px`;
      }
    }

    /**
     * @param {MouseEvent} ev
     */
    function onMouseUp(ev) {
      document.removeEventListener('mousemove', onMouseMove);

      if (dragEl && dragEl.parentNode) {
        dragEl.parentNode.removeChild(dragEl);
      }
      dragEl = null;

      if (dragStartY === null) return;

      const savedStartY = dragStartY;
      dragStartY = null;

      if (isDrag) {
        // Drag: use the dragged range.
        const r = col.getBoundingClientRect();
        const endY = ev.clientY - r.top + gridScrollEl.scrollTop;

        const rawStartMins = yToMinutes(Math.min(savedStartY, endY), TOTAL_HEIGHT);
        const rawEndMins   = yToMinutes(Math.max(savedStartY, endY), TOTAL_HEIGHT);

        let startMins = snapMinutes(rawStartMins);
        let endMins   = snapMinutes(rawEndMins);

        // Ensure at least 15 minutes duration.
        if (endMins <= startMins) endMins = startMins + 15;

        // Clamp to [0, 1440].
        startMins = Math.max(0, Math.min(1425, startMins));
        endMins   = Math.max(startMins + 15, Math.min(1440, endMins));

        const startDate = dayPlusMinutes(day, startMins);
        const endDate   = dayPlusMinutes(day, endMins);

        openCreateModal(startDate, endDate);
      }
      // If not a drag, the 'click' event will fire and handle it.
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp, { once: true });
  });

  // Plain click on the column background (fires after mousedown+mouseup with no drag).
  col.addEventListener('click', (e) => {
    if (e.target !== col) return;
    // If this was a drag, onMouseUp already opened the modal.
    if (isDrag) {
      isDrag = false;
      return;
    }

    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top + gridScrollEl.scrollTop;
    const startMins = snapMinutes(yToMinutes(y, TOTAL_HEIGHT));
    const endMins   = Math.min(startMins + 60, 1440);

    const startDate = dayPlusMinutes(day, startMins);
    const endDate   = dayPlusMinutes(day, endMins);

    openCreateModal(startDate, endDate);
  });
}

/* ============================================================
   Modal – create
   ============================================================ */

/**
 * @param {Date} startDate
 * @param {Date} endDate
 */
function openCreateModal(startDate, endDate) {
  modalTitle.textContent = 'New Event';
  fieldTitle.value = '';
  fieldStart.value = toDatetimeLocal(startDate);
  fieldEnd.value   = toDatetimeLocal(endDate);
  btnDelete.classList.add('hidden');
  hideFormError();

  eventForm.onsubmit = async (e) => {
    e.preventDefault();
    await handleCreate();
  };

  showModal();
  fieldTitle.focus();
}

async function handleCreate() {
  const data = readFormData();
  if (!data) return;

  try {
    btnSave.disabled = true;
    await createEvent(data);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(/** @type {Error} */ (err).message);
  } finally {
    btnSave.disabled = false;
  }
}

/* ============================================================
   Modal – edit
   ============================================================ */

/**
 * @param {object} event
 */
function openEditModal(event) {
  modalTitle.textContent = 'Edit Event';
  fieldTitle.value = event.title;
  fieldStart.value = toDatetimeLocal(event.start_at);
  fieldEnd.value   = toDatetimeLocal(event.end_at);
  btnDelete.classList.remove('hidden');
  hideFormError();

  eventForm.onsubmit = async (e) => {
    e.preventDefault();
    await handleUpdate(event.id);
  };

  btnDelete.onclick = async () => {
    await handleDelete(event.id);
  };

  showModal();
  fieldTitle.focus();
}

/**
 * @param {number} id
 */
async function handleUpdate(id) {
  const data = readFormData();
  if (!data) return;

  try {
    btnSave.disabled = true;
    await updateEvent(id, data);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(/** @type {Error} */ (err).message);
  } finally {
    btnSave.disabled = false;
  }
}

/**
 * @param {number} id
 */
async function handleDelete(id) {
  try {
    btnDelete.disabled = true;
    await deleteEvent(id);
    closeModal();
    await loadAndRender();
  } catch (err) {
    showFormError(/** @type {Error} */ (err).message);
  } finally {
    btnDelete.disabled = false;
  }
}

/* ============================================================
   Modal helpers
   ============================================================ */

/**
 * Read and validate the form fields.
 * @returns {{ title: string, start_at: string, end_at: string }|null}
 */
function readFormData() {
  const title    = fieldTitle.value.trim();
  const startVal = fieldStart.value;
  const endVal   = fieldEnd.value;

  if (!title) {
    showFormError('Title is required.');
    fieldTitle.focus();
    return null;
  }

  if (!startVal || !endVal) {
    showFormError('Start and end times are required.');
    return null;
  }

  const startDate = new Date(startVal);
  const endDate   = new Date(endVal);

  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    showFormError('Invalid date/time values.');
    return null;
  }

  if (endDate <= startDate) {
    showFormError('End time must be after start time.');
    return null;
  }

  return {
    title,
    start_at: startDate.toISOString(),
    end_at:   endDate.toISOString(),
  };
}

function showModal() {
  modalOverlay.classList.remove('hidden');
}

function closeModal() {
  modalOverlay.classList.add('hidden');
  eventForm.onsubmit = null;
  btnDelete.onclick  = null;
}

/**
 * @param {string} msg
 */
function showFormError(msg) {
  formError.textContent = msg;
  formError.classList.remove('hidden');
}

function hideFormError() {
  formError.textContent = '';
  formError.classList.add('hidden');
}

// Close modal on overlay click.
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) closeModal();
});

// Close modal on Escape key.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) {
    closeModal();
  }
});

btnCancel.addEventListener('click', closeModal);

/* ============================================================
   Navigation
   ============================================================ */

document.getElementById('btn-prev')?.addEventListener('click', async () => {
  weekStart = shiftWeek(weekStart, -1);
  await loadAndRender();
});

document.getElementById('btn-today')?.addEventListener('click', async () => {
  weekStart = getWeekStart(new Date());
  await loadAndRender();
});

document.getElementById('btn-next')?.addEventListener('click', async () => {
  weekStart = shiftWeek(weekStart, 1);
  await loadAndRender();
});

/* ============================================================
   Sync time-axis scroll with grid scroll
   ============================================================ */

gridScrollEl.addEventListener('scroll', () => {
  // The time axis is not scrollable itself; we sync its scrollTop to match.
  timeAxisEl.scrollTop = gridScrollEl.scrollTop;
});

/* ============================================================
   Load & render
   ============================================================ */

async function loadAndRender() {
  const days = getWeekDays(weekStart);
  const { start, end } = getWeekRange(weekStart);

  weekLabelEl.textContent = formatWeekLabel(weekStart);

  try {
    events = await fetchEvents(start, end);
  } catch (err) {
    console.error('Failed to fetch events:', err);
    events = [];
  }

  renderDayHeaders(days);
  renderDayColumns(days);
}

/* ============================================================
   Bootstrap
   ============================================================ */

buildTimeAxis();
buildHourLines();
loadAndRender().then(() => {
  // Scroll to 07:00 on initial load so the morning is visible.
  gridScrollEl.scrollTop = 7 * HOUR_HEIGHT;
});
