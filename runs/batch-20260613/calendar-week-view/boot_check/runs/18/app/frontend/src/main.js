const API_URL = 'http://localhost:3000/api/events';

const PIXELS_PER_MINUTE = 1;
const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;
const TOTAL_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;
const CALENDAR_HEIGHT = TOTAL_MINUTES * PIXELS_PER_MINUTE;

let currentDate = new Date();
let events = [];

const timeAxisEl = document.getElementById('time-axis');
const daysGridEl = document.getElementById('days-grid');
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
  currentDate.setDate(currentDate.getDate() - 7);
  renderWeek();
});

document.getElementById('today').addEventListener('click', () => {
  currentDate = new Date();
  renderWeek();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() + 7);
  renderWeek();
});

cancelBtn.addEventListener('click', closeModal);

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
      res = await fetch(`${API_URL}/${id}`, {
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
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;
  if (!confirm('Delete this event?')) return;

  try {
    const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed to delete event');
    closeModal();
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
  const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
  return localISOTime;
}

function openModal(event = null, defaultStart = null, defaultEnd = null) {
  modal.classList.remove('hidden');
  if (event) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = toLocalISOString(new Date(event.start_at));
    eventEndInput.value = toLocalISOString(new Date(event.end_at));
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = defaultStart ? toLocalISOString(defaultStart) : '';
    eventEndInput.value = defaultEnd ? toLocalISOString(defaultEnd) : '';
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

async function fetchEvents() {
  const startOfWeek = getStartOfWeek(currentDate);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  try {
    const res = await fetch(`${API_URL}?start=${startOfWeek.toISOString()}&end=${endOfWeek.toISOString()}`);
    if (!res.ok) throw new Error('Failed to fetch events');
    events = await res.json();
    renderEvents();
  } catch (err) {
    console.error(err);
  }
}

function renderTimeAxis() {
  timeAxisEl.innerHTML = '';
  
  const headerSpacer = document.createElement('div');
  headerSpacer.className = 'time-axis-header';
  timeAxisEl.appendChild(headerSpacer);

  const axisContent = document.createElement('div');
  axisContent.style.position = 'relative';
  axisContent.style.height = `${CALENDAR_HEIGHT}px`;

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * 60 * PIXELS_PER_MINUTE}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    axisContent.appendChild(label);
  }
  timeAxisEl.appendChild(axisContent);
}

function renderWeek() {
  const startOfWeek = getStartOfWeek(currentDate);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 6);

  currentWeekLabel.textContent = `${startOfWeek.toLocaleDateString()} - ${endOfWeek.toLocaleDateString()}`;

  daysGridEl.innerHTML = '';
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(startOfWeek);
    dayDate.setDate(dayDate.getDate() + i);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    header.textContent = dayDate.toLocaleDateString([], { weekday: 'short', month: 'numeric', day: 'numeric' });
    col.appendChild(header);

    const content = document.createElement('div');
    content.className = 'day-content';
    content.style.height = `${CALENDAR_HEIGHT}px`;

    // Draw hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
      content.appendChild(line);
    }

    // Click to create event
    content.addEventListener('mousedown', (e) => {
      if (e.target !== content && !e.target.classList.contains('hour-line')) return;
      
      const rect = content.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      // Snap to 30 min
      const snappedMinutes = Math.floor(minutes / 30) * 30;
      
      const start = new Date(dayDate);
      start.setHours(0, snappedMinutes, 0, 0);
      
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + 60); // Default 1 hour

      openModal(null, start, end);
    });

    col.appendChild(content);
    daysGridEl.appendChild(col);
  }

  fetchEvents();
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  const startOfWeek = getStartOfWeek(currentDate);

  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);

  events.forEach(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    
    // Find which days this event spans
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(startOfWeek);
      dayStart.setDate(dayStart.getDate() + i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      if (start < dayEnd && end > dayStart) {
        eventsByDay[i].push({
          ...event,
          startObj: start,
          endObj: end,
          dayStart,
          dayEnd
        });
      }
    }
  });

  eventsByDay.forEach((dayEvents, dayIndex) => {
    if (dayEvents.length === 0) return;

    // Sort by start time, then end time
    dayEvents.sort((a, b) => {
      if (a.startObj.getTime() !== b.startObj.getTime()) {
        return a.startObj.getTime() - b.startObj.getTime();
      }
      return b.endObj.getTime() - a.endObj.getTime();
    });

    // Cluster overlapping events
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(event => {
      if (currentCluster.length === 0) {
        currentCluster.push(event);
        clusterEnd = event.endObj;
      } else {
        if (event.startObj < clusterEnd) {
          currentCluster.push(event);
          if (event.endObj > clusterEnd) {
            clusterEnd = event.endObj;
          }
        } else {
          clusters.push(currentCluster);
          currentCluster = [event];
          clusterEnd = event.endObj;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    const dayCol = daysGridEl.children[dayIndex].querySelector('.day-content');

    clusters.forEach(cluster => {
      // Assign columns within cluster
      const columns = [];
      cluster.forEach(event => {
        let placed = false;
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          const lastEvent = col[col.length - 1];
          if (lastEvent.endObj <= event.startObj) {
            col.push(event);
            event.colIndex = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          columns.push([event]);
          event.colIndex = columns.length - 1;
        }
      });

      const numCols = columns.length;

      cluster.forEach(event => {
        // Calculate top and height
        // Clamp to day boundaries
        const renderStart = new Date(Math.max(event.startObj, event.dayStart));
        const renderEnd = new Date(Math.min(event.endObj, event.dayEnd));

        const startMinutes = (renderStart.getTime() - event.dayStart.getTime()) / 60000;
        const endMinutes = (renderEnd.getTime() - event.dayStart.getTime()) / 60000;

        const top = startMinutes * PIXELS_PER_MINUTE;
        const height = (endMinutes - startMinutes) * PIXELS_PER_MINUTE;

        const width = 100 / numCols;
        const left = event.colIndex * width;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = `${top}px`;
        block.style.height = `${height}px`;
        block.style.left = `${left}%`;
        block.style.width = `${width}%`;

        const titleEl = document.createElement('div');
        titleEl.className = 'event-title';
        titleEl.textContent = event.title;

        const timeEl = document.createElement('div');
        timeEl.className = 'event-time';
        timeEl.textContent = `${formatTime(event.startObj)} - ${formatTime(event.endObj)}`;

        block.appendChild(titleEl);
        block.appendChild(timeEl);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(event);
        });

        dayCol.appendChild(block);
      });
    });
  });
}

renderTimeAxis();
renderWeek();
