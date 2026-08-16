import { startOfWeek, addDays, format, parseISO, isSameDay, startOfDay, differenceInMinutes } from 'date-fns';

const API_BASE = '/api';
const HOUR_HEIGHT = 60; // pixels per hour

let currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
let events = [];

const appDiv = document.getElementById('app');

function renderApp() {
  appDiv.innerHTML = `
    <header>
      <button id="btn-prev">Prev</button>
      <button id="btn-today">Today</button>
      <button id="btn-next">Next</button>
      <h2 id="week-title"></h2>
    </header>
    <div class="calendar-container">
      <div class="calendar-header" id="calendar-header"></div>
      <div class="calendar-body" id="calendar-body"></div>
    </div>
  `;

  document.getElementById('btn-prev').addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    renderGrid();
    loadEvents();
  });
  document.getElementById('btn-today').addEventListener('click', () => {
    currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
    renderGrid();
    loadEvents();
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    renderGrid();
    loadEvents();
  });

  renderGrid();
  loadEvents();
}

function renderGrid() {
  const headerDiv = document.getElementById('calendar-header');
  const bodyDiv = document.getElementById('calendar-body');

  const weekEnd = addDays(currentWeekStart, 6);
  document.getElementById('week-title').textContent = `${format(currentWeekStart, 'MMM d, yyyy')} - ${format(weekEnd, 'MMM d, yyyy')}`;

  let headerHtml = '<div class="time-axis-header"></div>';
  let bodyHtml = '<div class="time-axis">';
  
  for (let i = 0; i <= 24; i++) {
    bodyHtml += `<div class="hour-line" style="top: ${i * HOUR_HEIGHT}px;"></div>`;
    if (i > 0 && i < 24) {
      bodyHtml += `<div class="time-label" style="top: ${i * HOUR_HEIGHT}px;">${i.toString().padStart(2, '0')}:00</div>`;
    }
  }
  bodyHtml += '</div>';

  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const day = addDays(currentWeekStart, i);
    const isToday = isSameDay(day, today);
    headerHtml += `
      <div class="day-header ${isToday ? 'today' : ''}">
        <div>${format(day, 'EEE')}</div>
        <div>${format(day, 'd')}</div>
      </div>
    `;
    bodyHtml += `
      <div class="day-column" data-date="${format(day, 'yyyy-MM-dd')}">
        ${Array.from({length: 25}).map((_, i) => `<div class="hour-line" style="top: ${i * HOUR_HEIGHT}px;"></div>`).join('')}
      </div>
    `;
  }

  headerDiv.innerHTML = headerHtml;
  bodyDiv.innerHTML = bodyHtml;

  // Add click listeners to day columns for creating events
  document.querySelectorAll('.day-column').forEach(col => {
    col.addEventListener('click', (e) => {
      if (e.target.closest('.event')) return; // Ignore clicks on events
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = (y / HOUR_HEIGHT) * 60;
      const startMinutes = Math.floor(minutes / 30) * 30; // snap to 30 mins
      const endMinutes = startMinutes + 60;
      
      const dateStr = col.getAttribute('data-date');
      const start = new Date(`${dateStr}T00:00:00`);
      start.setMinutes(startMinutes);
      const end = new Date(`${dateStr}T00:00:00`);
      end.setMinutes(endMinutes);

      openModal({ start_at: start, end_at: end });
    });
  });
}

async function loadEvents() {
  const start = currentWeekStart.toISOString();
  const end = addDays(currentWeekStart, 7).toISOString();
  try {
    const res = await fetch(`${API_BASE}/events?start=${start}&end=${end}`);
    const data = await res.json();
    events = data.map(e => ({
      ...e,
      start_at: new Date(e.start_at),
      end_at: new Date(e.end_at)
    }));
    renderEvents();
  } catch (err) {
    console.error('Failed to load events', err);
  }
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event').forEach(el => el.remove());

  // Group by day
  const days = {};
  for (let i = 0; i < 7; i++) {
    days[format(addDays(currentWeekStart, i), 'yyyy-MM-dd')] = [];
  }

  for (const event of events) {
    for (let i = 0; i < 7; i++) {
      const day = addDays(currentWeekStart, i);
      const dayStart = startOfDay(day);
      const dayEnd = addDays(dayStart, 1);
      
      if (event.start_at < dayEnd && event.end_at > dayStart) {
        const dateStr = format(day, 'yyyy-MM-dd');
        if (days[dateStr]) {
          days[dateStr].push(event);
        }
      }
    }
  }

  for (const [dateStr, dayEvents] of Object.entries(days)) {
    const dayStart = new Date(`${dateStr}T00:00:00`);
    
    const clampedEvents = dayEvents.map(event => {
      let startMins = differenceInMinutes(event.start_at, dayStart);
      let endMins = differenceInMinutes(event.end_at, dayStart);
      
      if (startMins < 0) startMins = 0;
      if (endMins > 24 * 60) endMins = 24 * 60;
      
      return {
        ...event,
        originalEvent: event,
        clampedStart: startMins,
        clampedEnd: endMins
      };
    });

    layoutEvents(clampedEvents);
    
    const col = document.querySelector(`.day-column[data-date="${dateStr}"]`);
    if (!col) continue;

    for (const event of clampedEvents) {
      const top = (event.clampedStart / 60) * HOUR_HEIGHT;
      const height = ((event.clampedEnd - event.clampedStart) / 60) * HOUR_HEIGHT;

      const width = 100 / event.numCols;
      const left = event.colIdx * width;

      const el = document.createElement('div');
      el.className = 'event';
      el.style.top = `${top}px`;
      el.style.height = `${height}px`;
      el.style.left = `${left}%`;
      el.style.width = `${width}%`;

      el.innerHTML = `
        <div class="event-title">${escapeHtml(event.title)}</div>
        <div class="event-time">${format(event.originalEvent.start_at, 'HH:mm')} - ${format(event.originalEvent.end_at, 'HH:mm')}</div>
      `;

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(event.originalEvent);
      });

      col.appendChild(el);
    }
  }
}

function layoutEvents(dayEvents) {
  dayEvents.sort((a, b) => {
    if (a.clampedStart !== b.clampedStart) {
      return a.clampedStart - b.clampedStart;
    }
    return a.clampedEnd - b.clampedEnd;
  });

  let clusters = [];
  let currentCluster = null;

  for (const event of dayEvents) {
    if (!currentCluster) {
      currentCluster = { events: [event], maxEnd: event.clampedEnd };
      clusters.push(currentCluster);
    } else {
      if (event.clampedStart < currentCluster.maxEnd) {
        currentCluster.events.push(event);
        currentCluster.maxEnd = Math.max(currentCluster.maxEnd, event.clampedEnd);
      } else {
        currentCluster = { events: [event], maxEnd: event.clampedEnd };
        clusters.push(currentCluster);
      }
    }
  }

  for (const cluster of clusters) {
    let columns = [];
    for (const event of cluster.events) {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEvent = col[col.length - 1];
        if (lastEvent.clampedEnd <= event.clampedStart) {
          col.push(event);
          event.colIdx = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push([event]);
        event.colIdx = columns.length - 1;
      }
    }
    const numCols = columns.length;
    for (const event of cluster.events) {
      event.numCols = numCols;
    }
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function openModal(eventData) {
  const isEdit = !!eventData.id;
  
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  
  const startLocal = format(eventData.start_at, "yyyy-MM-dd'T'HH:mm");
  const endLocal = format(eventData.end_at, "yyyy-MM-dd'T'HH:mm");

  overlay.innerHTML = `
    <div class="modal">
      <h3>${isEdit ? 'Edit Event' : 'New Event'}</h3>
      <label>
        Title
        <input type="text" id="event-title" value="${eventData.title ? escapeHtml(eventData.title) : ''}" />
      </label>
      <label>
        Start
        <input type="datetime-local" id="event-start" value="${startLocal}" />
      </label>
      <label>
        End
        <input type="datetime-local" id="event-end" value="${endLocal}" />
      </label>
      <div class="modal-actions">
        ${isEdit ? `<button class="btn-delete" id="btn-delete">Delete</button>` : ''}
        <button class="btn-cancel" id="btn-cancel">Cancel</button>
        <button class="btn-save" id="btn-save">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();

  document.getElementById('btn-cancel').addEventListener('click', close);
  
  if (isEdit) {
    document.getElementById('btn-delete').addEventListener('click', async () => {
      try {
        await fetch(`${API_BASE}/events/${eventData.id}`, { method: 'DELETE' });
        close();
        loadEvents();
      } catch (err) {
        alert('Failed to delete');
      }
    });
  }

  document.getElementById('btn-save').addEventListener('click', async () => {
    const title = document.getElementById('event-title').value;
    const start = document.getElementById('event-start').value;
    const end = document.getElementById('event-end').value;

    if (!title.trim()) {
      alert('Title is required');
      return;
    }
    if (new Date(end) <= new Date(start)) {
      alert('End time must be after start time');
      return;
    }

    const payload = {
      title,
      start_at: new Date(start).toISOString(),
      end_at: new Date(end).toISOString()
    };

    try {
      const res = await fetch(`${API_BASE}/events${isEdit ? `/${eventData.id}` : ''}`, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Failed to save');
        return;
      }
      close();
      loadEvents();
    } catch (err) {
      alert('Failed to save');
    }
  });
}

renderApp();
