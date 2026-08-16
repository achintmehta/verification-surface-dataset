/**
 * Rendering module: builds the week grid, places events, handles interactions.
 */
import { layoutDay } from "./layout.js";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

// Constants matching CSS
const HOUR_HEIGHT = 60; // px per hour
const AXIS_HEIGHT = HOUR_HEIGHT * 24; // 1440px

/**
 * Get Monday of the week containing `date`.
 */
export function getMonday(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Format a Date to "HH:MM".
 */
function formatTime(dateStr) {
  const d = new Date(dateStr);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Format date for datetime-local input value.
 */
export function toLocalInputValue(date) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d}T${h}:${mi}`;
}

/**
 * Render the time gutter with hour labels.
 */
export function renderTimeGutter(container) {
  container.innerHTML = "";
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement("div");
    label.className = "hour-label";
    label.style.top = `${h * HOUR_HEIGHT}px`;
    label.textContent = `${String(h).padStart(2, "0")}:00`;
    container.appendChild(label);
  }
}

/**
 * Render the 7-day week grid with headers, hour lines, and empty event containers.
 * Returns an object with dayColumns array for later event placement.
 */
export function renderWeekGrid(container, monday, onDayClick) {
  container.innerHTML = "";

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const columns = [];

  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);

    const col = document.createElement("div");
    col.className = "day-column";

    // Check if this is today
    if (day.getTime() === today.getTime()) {
      col.classList.add("today");
    }

    // Header
    const header = document.createElement("div");
    header.className = "day-header";

    const dayName = document.createElement("div");
    dayName.className = "day-name";
    dayName.textContent = DAY_NAMES[i];

    const dayNum = document.createElement("div");
    dayNum.className = "day-number";
    dayNum.textContent = day.getDate();

    header.appendChild(dayName);
    header.appendChild(dayNum);
    col.appendChild(header);

    // Body
    const body = document.createElement("div");
    body.className = "day-body";

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement("div");
      line.className = "hour-line";
      line.style.top = `${h * HOUR_HEIGHT}px`;
      body.appendChild(line);

      const halfLine = document.createElement("div");
      halfLine.className = "half-hour-line";
      halfLine.style.top = `${h * HOUR_HEIGHT + HOUR_HEIGHT / 2}px`;
      body.appendChild(halfLine);
    }
    // Bottom edge line at 24:00
    const bottomLine = document.createElement("div");
    bottomLine.className = "hour-line";
    bottomLine.style.top = `${24 * HOUR_HEIGHT}px`;
    body.appendChild(bottomLine);

    // Click area for creating events
    const clickArea = document.createElement("div");
    clickArea.className = "day-click-area";
    setupDayClickHandler(clickArea, day, onDayClick);
    body.appendChild(clickArea);

    // Events container
    const eventsContainer = document.createElement("div");
    eventsContainer.className = "events-container";
    body.appendChild(eventsContainer);

    col.appendChild(body);
    container.appendChild(col);

    columns.push({ date: day, eventsContainer, body });
  }

  return columns;
}

/**
 * Set up click/drag on day body to select a time range.
 */
function setupDayClickHandler(clickArea, day, onDayClick) {
  let isDragging = false;
  let startY = 0;
  let endY = 0;
  let selectionEl = null;

  function yToMinutes(y) {
    const minutes = (y / AXIS_HEIGHT) * 1440;
    // Snap to 15-minute intervals
    return Math.max(0, Math.min(1440, Math.round(minutes / 15) * 15));
  }

  function getRelativeY(e) {
    const rect = clickArea.getBoundingClientRect();
    return e.clientY - rect.top;
  }

  clickArea.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    startY = getRelativeY(e);
    endY = startY;

    // Create selection overlay
    selectionEl = document.createElement("div");
    selectionEl.className = "drag-selection";
    clickArea.parentElement.appendChild(selectionEl);
    updateSelection();

    e.preventDefault();
  });

  clickArea.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    endY = getRelativeY(e);
    updateSelection();
  });

  function updateSelection() {
    if (!selectionEl) return;
    const topY = Math.min(startY, endY);
    const height = Math.abs(endY - startY);
    selectionEl.style.top = `${topY}px`;
    selectionEl.style.height = `${height}px`;
  }

  function finishDrag() {
    if (!isDragging) return;
    isDragging = false;

    if (selectionEl) {
      selectionEl.remove();
      selectionEl = null;
    }

    const minStartY = Math.min(startY, endY);
    const maxEndY = Math.max(startY, endY);

    let startMin = yToMinutes(minStartY);
    let endMin = yToMinutes(maxEndY);

    // If it's just a click (barely moved), create a 1-hour event
    if (endMin - startMin < 15) {
      endMin = Math.min(1440, startMin + 60);
      if (endMin === startMin) {
        startMin = Math.max(0, endMin - 60);
      }
    }

    const startDate = new Date(day);
    startDate.setHours(0, startMin, 0, 0);
    // setHours with minutes > 59: works correctly in JS (carries over)
    // Actually, let's be explicit:
    startDate.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);

    const endDate = new Date(day);
    endDate.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0);

    onDayClick(startDate, endDate);
  }

  clickArea.addEventListener("mouseup", finishDrag);
  clickArea.addEventListener("mouseleave", () => {
    if (isDragging) {
      finishDrag();
    }
  });
}

/**
 * Render events onto already-built day columns.
 */
export function renderEvents(columns, events, onEventClick) {
  // Group events by day
  const eventsByDay = new Map();

  for (const col of columns) {
    eventsByDay.set(col.date.getTime(), []);
  }

  for (const ev of events) {
    const evStart = new Date(ev.start_at);
    const evEnd = new Date(ev.end_at);

    // An event may span multiple days; render it on each day it touches
    for (const col of columns) {
      const dayStart = col.date.getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;

      if (evStart.getTime() < dayEnd && evEnd.getTime() > dayStart) {
        const list = eventsByDay.get(col.date.getTime());
        if (list) {
          list.push(ev);
        }
      }
    }
  }

  // Layout and render for each day
  for (const col of columns) {
    const dayEvents = eventsByDay.get(col.date.getTime()) || [];
    col.eventsContainer.innerHTML = "";

    const layouts = layoutDay(dayEvents, col.date, AXIS_HEIGHT);

    for (const item of layouts) {
      const block = document.createElement("div");
      block.className = "event-block";
      block.style.top = `${item.top}px`;
      block.style.height = `${item.height}px`;
      block.style.left = item.left;
      block.style.width = `calc(${item.width} - 2px)`; // 2px gap

      const titleEl = document.createElement("div");
      titleEl.className = "event-title";
      titleEl.textContent = item.event.title;

      const timeEl = document.createElement("div");
      timeEl.className = "event-time";
      timeEl.textContent = `${formatTime(item.event.start_at)} – ${formatTime(item.event.end_at)}`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener("click", (e) => {
        e.stopPropagation();
        onEventClick(item.event);
      });

      col.eventsContainer.appendChild(block);
    }
  }
}

/**
 * Update the week title display.
 */
export function updateWeekTitle(titleEl, monday) {
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const startMonth = MONTH_NAMES[monday.getMonth()];
  const endMonth = MONTH_NAMES[sunday.getMonth()];

  if (monday.getMonth() === sunday.getMonth()) {
    titleEl.textContent = `${startMonth} ${monday.getDate()} – ${sunday.getDate()}, ${monday.getFullYear()}`;
  } else if (monday.getFullYear() === sunday.getFullYear()) {
    titleEl.textContent = `${startMonth} ${monday.getDate()} – ${endMonth} ${sunday.getDate()}, ${monday.getFullYear()}`;
  } else {
    titleEl.textContent = `${startMonth} ${monday.getDate()}, ${monday.getFullYear()} – ${endMonth} ${sunday.getDate()}, ${sunday.getFullYear()}`;
  }
}
