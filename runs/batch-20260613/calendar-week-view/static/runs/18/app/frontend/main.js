import { startOfWeek, addDays, subWeeks, addWeeks, format, isSameDay, parseISO, startOfDay, differenceInMinutes } from 'date-fns';

const API_URL = 'http://localhost:3000/api/events';
const PIXELS_PER_MINUTE = 1;
const DAY_START_HOURS = 0;
const DAY_END_HOURS = 24;
const TOTAL_MINUTES = (DAY_END_HOURS - DAY_START_HOURS) * 60;

let currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
let events = [];

const timeAxisEl = document.getElementById('time-axis');
const daysHeaderEl = document.getElementById('days-header');
const daysGridEl = document.getElementById('days-grid');
const currentWeekLabel = document.getElementById('current-week-label');

const modal = document.getElementById('event-modal');
const eventForm = document.getElementById('event-form');
const modalTitle = document.getElementById('modal-title');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const btnDelete = document.getElementById('btn-delete');
const btnCancel = document.getElementById('btn-cancel');

document.getElementById('btn-prev').addEventListener('click', () => {
  currentWeekStart = subWeeks(currentWeekStart, 1);
  loadWeek();
});

document.getElementById('btn-today').addEventListener('click', () => {
  currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  loadWeek();
});

document.getElementById('btn-next').addEventListener('click', () => {
  currentWeekStart = addWeeks(currentWeekStart, 1);
  loadWeek();
});

btnCancel.addEventListener('click', closeModal);

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = eventIdInput.value;
  const title = eventTitleInput.value.trim();
  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();

  if (!title) return alert('Title is required');
  if (new Date(end_at) <= new Date(start_at)) return alert('End time must be after start time');

  const payload = { title, start_at, end_at };

  try {
    let res;
    if (id) {
      res = await fetch(\`\${API_URL}/\${id}\`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save event');
    }

    closeModal();
    loadWeek();
  } catch (err) {
    alert(err.message);
  }
});

btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  if (!confirm('Are you sure you want to delete this event?')) return;

  try {
    const res = await fetch(\`\${API_URL}/\${id}\`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete event');
    closeModal();
    loadWeek();
  } catch (err) {
    alert(err.message);
  }
});

function openModal(event = null, defaultStart = null, defaultEnd = null) {
  modal.classList.remove('hidden');
  if (event) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    // Format for datetime-local: YYYY-MM-DDTHH:mm
    eventStartInput.value = format(event.start_at, "yyyy-MM-dd'T'HH:mm");
    eventEndInput.value = format(event.end_at, "yyyy-MM-dd'T'HH:mm");
    btnDelete.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    if (defaultStart && defaultEnd) {
      eventStartInput.value = format(defaultStart, "yyyy-MM-dd'T'HH:mm");
      eventEndInput.value = format(defaultEnd, "yyyy-MM-dd'T'HH:mm");
    } else {
      const now = new Date();
      now.setMinutes(0, 0, 0);
      const end = new Date(now.getTime() + 60 * 60 * 1000);
      eventStartInput.value = format(now, "yyyy-MM-dd'T'HH:mm");
      eventEndInput.value = format(end, "yyyy-MM-dd'T'HH:mm");
    }
    btnDelete.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
}

async function loadWeek() {
  const weekEnd = addDays(currentWeekStart, 7);
  currentWeekLabel.textContent = \`\${format(currentWeekStart, 'MMM d, yyyy')} - \${format(addDays(currentWeekStart, 6), 'MMM d, yyyy')}\`;

  try {
    const res = await fetch(\`\${API_URL}?start=\${currentWeekStart.toISOString()}&end=\${weekEnd.toISOString()}\`);
    if (!res.ok) throw new Error('Failed to fetch events');
    const data = await res.json();
    events = data.map(e => ({
      ...e,
      start_at: new Date(e.start_at),
      end_at: new Date(e.end_at)
    }));
    renderGrid();
  } catch (err) {
    console.error(err);
  }
}

function renderGrid() {
  timeAxisEl.innerHTML = '';
  daysHeaderEl.innerHTML = '';
  daysGridEl.innerHTML = '';

  // Render time axis
  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = \`\${i * 60 * PIXELS_PER_MINUTE}px\`;
    label.textContent = \`\${i.toString().padStart(2, '0')}:00\`;
    timeAxisEl.appendChild(label);
  }

  const today = new Date();

  // Render days
  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    
    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (isSameDay(dayDate, today)) {
      header.classList.add('today');
    }
    header.textContent = format(dayDate, 'EEE M/d');
    daysHeaderEl.appendChild(header);

    // Column
    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    dayCol.style.height = \`\${TOTAL_MINUTES * PIXELS_PER_MINUTE}px\`;

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = \`\${h * 60 * PIXELS_PER_MINUTE}px\`;
      dayCol.appendChild(line);
    }

    // Click to create event
    dayCol.addEventListener('click', (e) => {
      if (e.target !== dayCol && !e.target.classList.contains('hour-line')) return;
      const rect = dayCol.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      const start = new Date(dayDate);
      start.setHours(0, minutes, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour default
      openModal(null, start, end);
    });

    // Filter events for this day
    const dayStart = startOfDay(dayDate);
    const dayEnd = addDays(dayStart, 1);
    
    const dayEvents = events.filter(e => e.start_at < dayEnd && e.end_at > dayStart).map(e => {
      // Clamp to day boundaries
      const clampedStart = e.start_at < dayStart ? dayStart : e.start_at;
      const clampedEnd = e.end_at > dayEnd ? dayEnd : e.end_at;
      return { ...e, clampedStart, clampedEnd };
    });

    layoutEvents(dayEvents);

    for (const ev of dayEvents) {
      const startMins = differenceInMinutes(ev.clampedStart, dayStart);
      const endMins = differenceInMinutes(ev.clampedEnd, dayStart);
      const top = startMins * PIXELS_PER_MINUTE;
      const height = (endMins - startMins) * PIXELS_PER_MINUTE;

      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = \`\${top}px\`;
      block.style.height = \`\${height}px\`;
      block.style.left = \`\${ev.left}%\`;
      block.style.width = \`\${ev.width}%\`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = ev.title;
      
      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = \`\${format(ev.start_at, 'HH:mm')} - \${format(ev.end_at, 'HH:mm')}\`;

      block.appendChild(titleEl);
      block.appendChild(timeEl);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(events.find(x => x.id === ev.id));
      });

      dayCol.appendChild(block);
    }

    daysGridEl.appendChild(dayCol);
  }
}

function layoutEvents(dayEvents) {
  dayEvents.sort((a, b) => a.clampedStart.getTime() - b.clampedStart.getTime() || a.clampedEnd.getTime() - b.clampedEnd.getTime());

  let clusters = [];
  let currentCluster = [];
  let clusterEnd = null;

  for (const event of dayEvents) {
    if (currentCluster.length === 0) {
      currentCluster.push(event);
      clusterEnd = event.clampedEnd.getTime();
    } else {
      if (event.clampedStart.getTime() < clusterEnd) {
        currentCluster.push(event);
        clusterEnd = Math.max(clusterEnd, event.clampedEnd.getTime());
      } else {
        clusters.push(currentCluster);
        currentCluster = [event];
        clusterEnd = event.clampedEnd.getTime();
      }
    }
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  for (const cluster of clusters) {
    let columns = [];
    for (const event of cluster) {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEvent = col[col.length - 1];
        if (event.clampedStart.getTime() >= lastEvent.clampedEnd.getTime()) {
          col.push(event);
          event.columnIndex = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        columns.push([event]);
        event.columnIndex = columns.length - 1;
      }
    }

    const numColumns = columns.length;
    for (const event of cluster) {
      event.width = 100 / numColumns;
      event.left = event.columnIndex * event.width;
    }
  }
}

loadWeek();
