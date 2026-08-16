import { startOfWeek, endOfWeek, addWeeks, subWeeks, format, isSameDay, startOfDay, differenceInMinutes } from 'date-fns';

const PIXELS_PER_MINUTE = 1; // 60px per hour

let currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
let events = [];

const timeAxis = document.getElementById('time-axis');
const daysHeader = document.getElementById('days-header');
const daysContainer = document.getElementById('days-container');
const currentWeekLabel = document.getElementById('current-week-label');

const modal = document.getElementById('event-modal');
const modalTitle = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

document.getElementById('prev-week').addEventListener('click', () => {
  currentWeekStart = subWeeks(currentWeekStart, 1);
  renderWeek();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart = addWeeks(currentWeekStart, 1);
  renderWeek();
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  renderWeek();
});

cancelBtn.addEventListener('click', () => {
  modal.classList.add('hidden');
});

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = eventIdInput.value;
  const title = eventTitleInput.value;
  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();

  if (new Date(end_at) <= new Date(start_at)) {
    alert('End time must be after start time');
    return;
  }

  const payload = { title, start_at, end_at };

  try {
    let res;
    if (id) {
      res = await fetch(`/api/events/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(`/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Error saving event');
      return;
    }

    modal.classList.add('hidden');
    fetchEvents();
  } catch (err) {
    console.error(err);
    alert('Error saving event');
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  if (!confirm('Are you sure you want to delete this event?')) return;

  try {
    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Error deleting event');
      return;
    }
    modal.classList.add('hidden');
    fetchEvents();
  } catch (err) {
    console.error(err);
    alert('Error deleting event');
  }
});

function initGrid() {
  // Time axis
  timeAxis.innerHTML = '';
  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * 60 * PIXELS_PER_MINUTE}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
  }
}

async function fetchEvents() {
  const start = currentWeekStart.toISOString();
  const end = endOfWeek(currentWeekStart, { weekStartsOn: 1 }).toISOString();
  try {
    const res = await fetch(`/api/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    if (res.ok) {
      events = await res.json();
      renderEvents();
    }
  } catch (err) {
    console.error('Failed to fetch events', err);
  }
}

function renderWeek() {
  const end = endOfWeek(currentWeekStart, { weekStartsOn: 1 });
  currentWeekLabel.textContent = `${format(currentWeekStart, 'MMM d, yyyy')} - ${format(end, 'MMM d, yyyy')}`;

  daysHeader.innerHTML = '';
  daysContainer.innerHTML = '';

  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + i);

    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameDay(dayDate, today)) {
      header.classList.add('today');
    }
    header.innerHTML = `<div>${format(dayDate, 'EEE')}</div><div>${format(dayDate, 'd')}</div>`;
    daysHeader.appendChild(header);

    // Column
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = format(dayDate, 'yyyy-MM-dd');

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
      col.appendChild(line);
    }

    // Click to create
    col.addEventListener('mousedown', (e) => {
      if (e.target !== col) return;
      const offsetY = e.offsetY;
      const minutes = Math.floor(offsetY / PIXELS_PER_MINUTE);
      const startHour = Math.floor(minutes / 60);
      const startMin = minutes % 60;
      
      const start = new Date(dayDate);
      start.setHours(startHour, startMin, 0, 0);
      const end = new Date(start);
      end.setHours(startHour + 1, startMin, 0, 0);

      openModal({ start_at: start.toISOString(), end_at: end.toISOString() });
    });

    daysContainer.appendChild(col);
  }

  fetchEvents();
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const eventsByDay = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date(currentWeekStart);
    d.setDate(d.getDate() + i);
    eventsByDay[format(d, 'yyyy-MM-dd')] = [];
  }

  events.forEach(ev => {
    const start = new Date(ev.start_at);
    const end = new Date(ev.end_at);
    
    for (let i = 0; i < 7; i++) {
      const d = new Date(currentWeekStart);
      d.setDate(d.getDate() + i);
      const dayStart = startOfDay(d);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      if (start < dayEnd && end > dayStart) {
        eventsByDay[format(d, 'yyyy-MM-dd')].push({
          ...ev,
          clampedStart: start < dayStart ? dayStart : start,
          clampedEnd: end > dayEnd ? dayEnd : end
        });
      }
    }
  });

  for (const [dateStr, dayEvents] of Object.entries(eventsByDay)) {
    const col = document.querySelector(`.day-column[data-date="${dateStr}"]`);
    if (!col) continue;

    // Sort by start time, then end time
    dayEvents.sort((a, b) => a.clampedStart - b.clampedStart || b.clampedEnd - a.clampedEnd);

    // Cluster overlap layout
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(ev => {
      if (currentCluster.length === 0) {
        currentCluster.push(ev);
        clusterEnd = ev.clampedEnd;
      } else {
        if (ev.clampedStart < clusterEnd) {
          currentCluster.push(ev);
          if (ev.clampedEnd > clusterEnd) {
            clusterEnd = ev.clampedEnd;
          }
        } else {
          clusters.push(currentCluster);
          currentCluster = [ev];
          clusterEnd = ev.clampedEnd;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    clusters.forEach(cluster => {
      const columns = [];
      cluster.forEach(ev => {
        let placed = false;
        for (let i = 0; i < columns.length; i++) {
          const colEvents = columns[i];
          const lastEvent = colEvents[colEvents.length - 1];
          if (lastEvent.clampedEnd <= ev.clampedStart) {
            colEvents.push(ev);
            ev.colIdx = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          ev.colIdx = columns.length;
          columns.push([ev]);
        }
      });

      const numCols = columns.length;
      cluster.forEach(ev => {
        const dayStart = startOfDay(new Date(dateStr));
        const startMins = differenceInMinutes(ev.clampedStart, dayStart);
        const endMins = differenceInMinutes(ev.clampedEnd, dayStart);
        
        const top = startMins * PIXELS_PER_MINUTE;
        const height = (endMins - startMins) * PIXELS_PER_MINUTE;
        
        const width = 100 / numCols;
        const left = ev.colIdx * width;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.style.left = `${left}%`;
        block.style.width = `${width}%`;

        const titleEl = document.createElement('div');
        titleEl.className = 'event-title';
        titleEl.textContent = ev.title;

        const timeEl = document.createElement('div');
        timeEl.className = 'event-time';
        timeEl.textContent = `${format(ev.clampedStart, 'HH:mm')} - ${format(ev.clampedEnd, 'HH:mm')}`;

        block.appendChild(titleEl);
        block.appendChild(timeEl);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(ev);
        });

        col.appendChild(block);
      });
    });
  }
}

function openModal(ev = null) {
  modal.classList.remove('hidden');
  if (ev && ev.id) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = ev.id;
    eventTitleInput.value = ev.title;
    eventStartInput.value = format(new Date(ev.start_at), "yyyy-MM-dd'T'HH:mm");
    eventEndInput.value = format(new Date(ev.end_at), "yyyy-MM-dd'T'HH:mm");
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    if (ev && ev.start_at && ev.end_at) {
      eventStartInput.value = format(new Date(ev.start_at), "yyyy-MM-dd'T'HH:mm");
      eventEndInput.value = format(new Date(ev.end_at), "yyyy-MM-dd'T'HH:mm");
    } else {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      const end = new Date(now);
      end.setHours(now.getHours() + 1);
      eventStartInput.value = format(now, "yyyy-MM-dd'T'HH:mm");
      eventEndInput.value = format(end, "yyyy-MM-dd'T'HH:mm");
    }
    deleteBtn.classList.add('hidden');
  }
}

initGrid();
renderWeek();
