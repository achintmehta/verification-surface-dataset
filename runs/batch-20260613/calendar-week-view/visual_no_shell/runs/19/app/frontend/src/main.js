const PIXELS_PER_MINUTE = 1;
const HOUR_HEIGHT = 60 * PIXELS_PER_MINUTE;

let currentWeekStart = getMonday(new Date());
let events = [];

const daysHeaderGrid = document.getElementById('days-header-grid');
const daysGrid = document.getElementById('days-grid');
const timeAxis = document.getElementById('time-axis');
const currentWeekLabel = document.getElementById('current-week-label');

const modal = document.getElementById('event-modal');
const eventForm = document.getElementById('event-form');
const modalTitle = document.getElementById('modal-title');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

document.getElementById('prev-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  renderWeek();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  renderWeek();
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = getMonday(new Date());
  renderWeek();
});

cancelBtn.addEventListener('click', closeModal);

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
      res = await fetch('/api/events', {
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

  try {
    const res = await fetch(`/api/events/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to delete event');
    }
    closeModal();
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

function getMonday(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  date.setDate(diff);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function toLocalISOString(date) {
  const tzOffset = date.getTimezoneOffset() * 60000;
  return (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
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
}

async function fetchEvents() {
  const endOfWeek = addDays(currentWeekStart, 7);
  const fetchForWeek = currentWeekStart.getTime();
  try {
    const res = await fetch(`/api/events?start=${currentWeekStart.toISOString()}&end=${endOfWeek.toISOString()}`);
    if (!res.ok) throw new Error('Failed to fetch events');
    const fetchedEvents = await res.json();
    if (fetchForWeek === currentWeekStart.getTime()) {
      events = fetchedEvents;
      renderEvents();
    }
  } catch (err) {
    console.error(err);
  }
}

function renderWeek() {
  const endOfWeek = addDays(currentWeekStart, 6);
  currentWeekLabel.textContent = `${currentWeekStart.toDateString()} - ${endOfWeek.toDateString()}`;

  daysHeaderGrid.innerHTML = '';
  daysGrid.innerHTML = '';
  timeAxis.innerHTML = '';

  // Render time axis
  for (let i = 0; i < 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * HOUR_HEIGHT}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxis.appendChild(label);
  }
  timeAxis.style.height = `${24 * HOUR_HEIGHT}px`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Render days
  for (let i = 0; i < 7; i++) {
    const currentDay = addDays(currentWeekStart, i);
    
    // Header
    const header = document.createElement('div');
    header.className = 'day-header';
    if (currentDay.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    header.textContent = `${dayNames[currentDay.getDay()]} ${currentDay.getDate()}`;
    daysHeaderGrid.appendChild(header);

    // Grid column
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = currentDay.toISOString();
    col.style.height = `${24 * HOUR_HEIGHT}px`;

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * HOUR_HEIGHT}px`;
      col.appendChild(line);
    }

    // Click to create event
    col.addEventListener('click', (e) => {
      if (e.target !== col && !e.target.classList.contains('hour-line')) return;
      const rect = col.getBoundingClientRect();
      const clickY = e.clientY - rect.top;
      
      const minutes = Math.floor(clickY / PIXELS_PER_MINUTE);
      const start = new Date(currentDay);
      start.setMinutes(minutes);
      const end = new Date(start);
      end.setHours(end.getHours() + 1);
      openModal(null, start, end);
    });

    daysGrid.appendChild(col);
  }

  fetchEvents();
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);

  events.forEach(event => {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    
    // Find which days this event spans
    for (let i = 0; i < 7; i++) {
      const dayStart = addDays(currentWeekStart, i);
      const dayEnd = addDays(dayStart, 1);
      
      if (start < dayEnd && end > dayStart) {
        // Event overlaps with this day
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
    
    const col = daysGrid.children[dayIndex];

    // Sort by start time, then end time
    dayEvents.sort((a, b) => {
      if (a.startObj.getTime() !== b.startObj.getTime()) {
        return a.startObj.getTime() - b.startObj.getTime();
      }
      return b.endObj.getTime() - a.endObj.getTime();
    });

    // Cluster overlapping events
    let clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(event => {
      const eventStart = Math.max(event.startObj.getTime(), event.dayStart.getTime());
      const eventEnd = Math.min(event.endObj.getTime(), event.dayEnd.getTime());

      if (currentCluster.length === 0) {
        currentCluster.push(event);
        clusterEnd = eventEnd;
      } else {
        if (eventStart < clusterEnd) {
          currentCluster.push(event);
          clusterEnd = Math.max(clusterEnd, eventEnd);
        } else {
          clusters.push(currentCluster);
          currentCluster = [event];
          clusterEnd = eventEnd;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    // Layout each cluster
    clusters.forEach(cluster => {
      const columns = [];

      cluster.forEach(event => {
        const eventStart = Math.max(event.startObj.getTime(), event.dayStart.getTime());
        
        let placed = false;
        for (let i = 0; i < columns.length; i++) {
          const colEvents = columns[i];
          const lastEvent = colEvents[colEvents.length - 1];
          const lastEventEnd = Math.min(lastEvent.endObj.getTime(), lastEvent.dayEnd.getTime());
          
          if (eventStart >= lastEventEnd) {
            colEvents.push(event);
            event.colIndex = i;
            placed = true;
            break;
          }
        }
        
        if (!placed) {
          event.colIndex = columns.length;
          columns.push([event]);
        }
      });

      const numCols = columns.length;

      cluster.forEach(event => {
        const eventStart = Math.max(event.startObj.getTime(), event.dayStart.getTime());
        const eventEnd = Math.min(event.endObj.getTime(), event.dayEnd.getTime());

        const startMinutes = (eventStart - event.dayStart.getTime()) / 60000;
        const endMinutes = (eventEnd - event.dayStart.getTime()) / 60000;

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
        const formatTime = (d) => d.toTimeString().substring(0, 5);
        timeEl.textContent = `${formatTime(event.startObj)} - ${formatTime(event.endObj)}`;

        block.appendChild(titleEl);
        block.appendChild(timeEl);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(event);
        });

        col.appendChild(block);
      });
    });
  });
}

renderWeek();
