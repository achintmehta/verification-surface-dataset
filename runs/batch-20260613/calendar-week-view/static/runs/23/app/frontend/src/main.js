/**
 * Main application entry point.
 * Wires up the calendar UI with the API.
 */
import { fetchEvents, createEvent, updateEvent, deleteEvent } from "./api.js";
import {
  renderTimeGutter,
  renderWeekGrid,
  renderEvents,
  updateWeekTitle,
  getMonday,
  toLocalInputValue,
} from "./render.js";

// State
let currentMonday = getMonday(new Date());
let dayColumns = [];
let currentEvents = [];

// DOM elements
const weekTitle = document.getElementById("week-title");
const timeGutter = document.getElementById("time-gutter");
const weekGrid = document.getElementById("week-grid");
const btnPrev = document.getElementById("btn-prev");
const btnToday = document.getElementById("btn-today");
const btnNext = document.getElementById("btn-next");
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const eventForm = document.getElementById("event-form");
const inputTitle = document.getElementById("input-title");
const inputStart = document.getElementById("input-start");
const inputEnd = document.getElementById("input-end");
const formError = document.getElementById("form-error");
const btnSave = document.getElementById("btn-save");
const btnDelete = document.getElementById("btn-delete");
const btnCancel = document.getElementById("btn-cancel");

// Currently editing event (null = creating new)
let editingEvent = null;

// ============================================================
// Week navigation
// ============================================================

function navigateWeek(offset) {
  const newMonday = new Date(currentMonday);
  newMonday.setDate(newMonday.getDate() + offset * 7);
  currentMonday = newMonday;
  loadWeek();
}

btnPrev.addEventListener("click", () => navigateWeek(-1));
btnNext.addEventListener("click", () => navigateWeek(1));
btnToday.addEventListener("click", () => {
  currentMonday = getMonday(new Date());
  loadWeek();
});

// ============================================================
// Load and render the current week
// ============================================================

async function loadWeek() {
  updateWeekTitle(weekTitle, currentMonday);
  renderTimeGutter(timeGutter);
  dayColumns = renderWeekGrid(weekGrid, currentMonday, handleDayClick);

  // Fetch events for the week
  const weekEnd = new Date(currentMonday);
  weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    currentEvents = await fetchEvents(currentMonday, weekEnd);
  } catch (err) {
    console.error("Failed to fetch events:", err);
    currentEvents = [];
  }

  renderEvents(dayColumns, currentEvents, handleEventClick);

  // Scroll to ~8:00 AM on initial load
  const container = document.querySelector(".calendar-container");
  if (container) {
    container.scrollTop = 8 * 60; // 8 hours * 60px/hour
  }
}

// ============================================================
// Modal management
// ============================================================

function openModal(mode, { start, end, event } = {}) {
  formError.textContent = "";

  if (mode === "create") {
    modalTitle.textContent = "Create Event";
    btnDelete.style.display = "none";
    btnSave.textContent = "Create";
    inputTitle.value = "";
    inputStart.value = toLocalInputValue(start);
    inputEnd.value = toLocalInputValue(end);
    editingEvent = null;
  } else {
    modalTitle.textContent = "Edit Event";
    btnDelete.style.display = "inline-block";
    btnSave.textContent = "Save";
    inputTitle.value = event.title;
    inputStart.value = toLocalInputValue(new Date(event.start_at));
    inputEnd.value = toLocalInputValue(new Date(event.end_at));
    editingEvent = event;
  }

  modalOverlay.style.display = "flex";
  inputTitle.focus();
}

function closeModal() {
  modalOverlay.style.display = "none";
  editingEvent = null;
  formError.textContent = "";
}

btnCancel.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

// ============================================================
// Form submission
// ============================================================

eventForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.textContent = "";

  const title = inputTitle.value.trim();
  const start_at = inputStart.value;
  const end_at = inputEnd.value;

  // Client-side validation
  if (!title) {
    formError.textContent = "Title is required.";
    return;
  }
  if (!start_at || !end_at) {
    formError.textContent = "Start and end times are required.";
    return;
  }
  if (new Date(end_at) <= new Date(start_at)) {
    formError.textContent = "End time must be after start time.";
    return;
  }

  try {
    if (editingEvent) {
      await updateEvent(editingEvent.id, { title, start_at, end_at });
    } else {
      await createEvent({ title, start_at, end_at });
    }
    closeModal();
    await reloadEvents();
  } catch (err) {
    formError.textContent = err.message;
  }
});

// ============================================================
// Delete
// ============================================================

btnDelete.addEventListener("click", async () => {
  if (!editingEvent) return;
  if (!confirm("Delete this event?")) return;

  try {
    await deleteEvent(editingEvent.id);
    closeModal();
    await reloadEvents();
  } catch (err) {
    formError.textContent = err.message;
  }
});

// ============================================================
// Callbacks
// ============================================================

function handleDayClick(start, end) {
  openModal("create", { start, end });
}

function handleEventClick(event) {
  openModal("edit", { event });
}

async function reloadEvents() {
  const weekEnd = new Date(currentMonday);
  weekEnd.setDate(weekEnd.getDate() + 7);

  try {
    currentEvents = await fetchEvents(currentMonday, weekEnd);
  } catch (err) {
    console.error("Failed to fetch events:", err);
    currentEvents = [];
  }

  renderEvents(dayColumns, currentEvents, handleEventClick);
}

// ============================================================
// Keyboard shortcuts
// ============================================================

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && modalOverlay.style.display !== "none") {
    closeModal();
  }
});

// ============================================================
// Init
// ============================================================

loadWeek();
