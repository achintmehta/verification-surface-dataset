/**
 * Application entry point.
 * Wires together: week navigation, API calls, calendar rendering, and modals.
 */

import { fetchEvents, createEvent, updateEvent, deleteEvent } from './api.js';
import { renderCalendar } from './calendar.js';
import { openCreateModal, openEditModal } from './modal.js';
import {
  getWeekStart,
  getWeekEnd,
  shiftWeek,
  weekLabel,
} from './week.js';

// ── State ─────────────────────────────────────────────────────────────────────
let currentWeekStart = getWeekStart(new Date());
let currentEvents    = [];

// ── DOM references ────────────────────────────────────────────────────────────
const app = document.getElementById('app');

// Build the app shell
app.innerHTML = `
  <div class="toolbar">
    <h1>📅 Week Calendar</h1>
    <button class="btn" id="btn-prev">&#8592; Prev</button>
    <span class="week-label" id="week-label"></span>
    <button class="btn" id="btn-today">Today</button>
    <button class="btn" id="btn-next">Next &#8594;</button>
  </div>
  <div class="calendar-container" id="calendar-container"></div>
  <div class="status-bar" id="status-bar"></div>
`;

const calendarContainer = document.getElementById('calendar-container');
const weekLabelEl       = document.getElementById('week-label');
const btnPrev           = document.getElementById('btn-prev');
const btnToday          = document.getElementById('btn-today');
const btnNext           = document.getElementById('btn-next');
const statusBar         = document.getElementById('status-bar');

// ── Status bar ────────────────────────────────────────────────────────────────
let statusTimer = null;

function showStatus(msg, isError = false) {
  statusBar.textContent = msg;
  statusBar.className   = 'status-bar visible' + (isError ? ' error' : '');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusBar.className = 'status-bar';
  }, 3000);
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  weekLabelEl.textContent = weekLabel(currentWeekStart);
  renderCalendar(calendarContainer, {
    weekStart:    currentWeekStart,
    events:       currentEvents,
    onEventClick: handleEventClick,
    onNewEvent:   handleNewEvent,
  });
}

// ── Data loading ──────────────────────────────────────────────────────────────
async function loadWeek() {
  const start = currentWeekStart;
  const end   = getWeekEnd(currentWeekStart);

  try {
    currentEvents = await fetchEvents(start, end);
    render();
  } catch (err) {
    showStatus(`Failed to load events: ${err.message}`, true);
    currentEvents = [];
    render();
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
btnPrev.addEventListener('click', () => {
  currentWeekStart = shiftWeek(currentWeekStart, -1);
  loadWeek();
});

btnToday.addEventListener('click', () => {
  currentWeekStart = getWeekStart(new Date());
  loadWeek();
});

btnNext.addEventListener('click', () => {
  currentWeekStart = shiftWeek(currentWeekStart, 1);
  loadWeek();
});

// ── Event handlers ────────────────────────────────────────────────────────────

/**
 * Called when the user drags on an empty time slot.
 * Opens the create modal pre-filled with the selected range.
 */
function handleNewEvent({ start_at, end_at }) {
  openCreateModal({ start_at, end_at }, async (payload) => {
    const created = await createEvent(payload);
    showStatus(`Event "${created.title}" created.`);
    await loadWeek();
  });
}

/**
 * Called when the user clicks an existing event block.
 * Opens the edit modal.
 */
function handleEventClick(event) {
  openEditModal(
    event,
    // onSave
    async (payload) => {
      const updated = await updateEvent(event.id, payload);
      showStatus(`Event "${updated.title}" updated.`);
      await loadWeek();
    },
    // onDelete
    async () => {
      await deleteEvent(event.id);
      showStatus(`Event deleted.`);
      await loadWeek();
    }
  );
}

// ── Boot ──────────────────────────────────────────────────────────────────────
loadWeek();
