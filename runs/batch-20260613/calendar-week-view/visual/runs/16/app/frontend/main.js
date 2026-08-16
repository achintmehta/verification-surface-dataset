import { 
  startOfWeek, 
  endOfWeek, 
  addDays, 
  format, 
  isSameDay, 
  parseISO, 
  differenceInMinutes,
  startOfDay,
  addWeeks,
  subWeeks
} from 'date-fns';

const API_BASE = 'http://localhost:3001/api/events';
const PIXELS_PER_MINUTE = 1; // 1 minute = 1 pixel, so 24 hours = 1440 pixels
const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;

let currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
let events = [];

const timeAxisEl = document.getElementById('time-axis');
const weekGridEl = document.getElementById('week-grid');
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
  currentWeekStart = subWeeks(currentWeekStart, 1);
  render();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart = addWeeks(currentWeekStart, 1);
  render();
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  render();
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
      res = await fetch(`${API_BASE}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      res = await fetch(API_BASE, {
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

    closeModal();
    fetchEventsAndRender();
  } catch (err) {
    console.error(err);
    alert('Network error');
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  try {
    const res = await fetch(`${API_BASE}/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Error deleting event');
      return;
    }
    closeModal();
    fetchEventsAndRender();
  } catch (err) {
    console.error(err);
    alert('Network error');
  }
});

function openModal(event = null, defaultStart = null, defaultEnd = null) {
  modal.classList.remove('hidden');
  if (event) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    // Format for datetime-local: YYYY-MM-DDThh:mm
    eventStartInput.value = format(new Date(event.start_at), "yyyy-MM-dd'T'HH:mm");
    eventEndInput.value = format(new Date(event.end_at), "yyyy-MM-dd'T'HH:mm");
    deleteBtn.classList.remove('hidden');
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
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
}

async function fetchEventsAndRender() {
  const start = currentWeekStart.toISOString();
  const end = endOfWeek(currentWeekStart, { weekStartsOn: 1 }).toISOString();
  
  try {
    const res = await fetch(`${API_BASE}?start=${start}&end=${end}`);
    if (res.ok) {
      events = await res.json();
    } else {
      console.error('Failed to fetch events');
    }
  } catch (err) {
    console.error(err);
  }
  
  renderGrid();
}

function render() {
  currentWeekLabel.textContent = `${format(currentWeekStart, 'MMM d, yyyy')} - ${format(endOfWeek(currentWeekStart, { weekStartsOn: 1 }), 'MMM d, yyyy')}`;
  fetchEventsAndRender();
}

function renderGrid() {
  // Render time axis
  timeAxisEl.innerHTML = '';
  const axisHeight = 24 * 60 * PIXELS_PER_MINUTE;
  timeAxisEl.style.height = `${axisHeight}px`;
  
  for (let i = 0; i < 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * 60 * PIXELS_PER_MINUTE}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxisEl.appendChild(label);
  }

  // Render week grid
  weekGridEl.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const isToday = isSameDay(dayDate, today);

    const col = document.createElement('div');
    col.className = 'day-column';

    const header = document.createElement('div');
    header.className = `day-header ${isToday ? 'today' : ''}`;
    header.textContent = format(dayDate, 'EEE M/d');
    col.appendChild(header);

    const content = document.createElement('div');
    content.className = 'day-content';
    content.style.height = `${axisHeight}px`;

    // Hour lines
    for (let h = 0; h < 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
      content.appendChild(line);
    }

    // Click to create event
    content.addEventListener('click', (e) => {
      if (e.target !== content && !e.target.classList.contains('hour-line')) return;
      const rect = content.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      const start = new Date(dayDate);
      start.setHours(0, minutes, 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      openModal(null, start, end);
    });

    // Render events for this day
    const dayEvents = events.filter(ev => {
      const evStart = new Date(ev.start_at);
      const evEnd = new Date(ev.end_at);
      const dayStart = startOfDay(dayDate);
      const dayEnd = addDays(dayStart, 1);
      return evStart < dayEnd && evEnd > dayStart;
    });

    const layoutedEvents = layoutEvents(dayEvents, dayDate);
    
    layoutedEvents.forEach(le => {
      const block = document.createElement('div');
      block.className = 'event-block';
      block.style.top = `${le.top}px`;
      block.style.height = `${le.height}px`;
      block.style.left = `${le.left}%`;
      block.style.width = `${le.width}%`;

      const title = document.createElement('div');
      title.className = 'event-title';
      title.textContent = le.event.title;

      const time = document.createElement('div');
      time.className = 'event-time';
      time.textContent = `${format(new Date(le.event.start_at), 'HH:mm')} - ${format(new Date(le.event.end_at), 'HH:mm')}`;

      block.appendChild(title);
      block.appendChild(time);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        openModal(le.event);
      });

      content.appendChild(block);
    });

    col.appendChild(content);
    weekGridEl.appendChild(col);
  }
}

function layoutEvents(dayEvents, dayDate) {
  const dayStart = startOfDay(dayDate);
  const dayEnd = addDays(dayStart, 1);

  // Map to layout objects
  const items = dayEvents.map(ev => {
    let start = new Date(ev.start_at);
    let end = new Date(ev.end_at);

    // Clamp to day
    if (start < dayStart) start = dayStart;
    if (end > dayEnd) end = dayEnd;

    const startMins = differenceInMinutes(start, dayStart);
    const endMins = differenceInMinutes(end, dayStart);

    return {
      event: ev,
      startMins,
      endMins,
      top: startMins * PIXELS_PER_MINUTE,
      height: (endMins - startMins) * PIXELS_PER_MINUTE
    };
  });

  // Sort by start time, then end time
  items.sort((a, b) => {
    if (a.startMins !== b.startMins) return a.startMins - b.startMins;
    return a.endMins - b.endMins;
  });

  const clusters = [];
  let currentCluster = [];
  let clusterEnd = 0;

  items.forEach(item => {
    if (currentCluster.length === 0) {
      currentCluster.push(item);
      clusterEnd = item.endMins;
    } else {
      if (item.startMins < clusterEnd) {
        currentCluster.push(item);
        clusterEnd = Math.max(clusterEnd, item.endMins);
      } else {
        clusters.push(currentCluster);
        currentCluster = [item];
        clusterEnd = item.endMins;
      }
    }
  });

  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const result = [];

  clusters.forEach(cluster => {
    const columns = [];

    cluster.forEach(item => {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        if (columns[i] <= item.startMins) {
          columns[i] = item.endMins;
          item.colIdx = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        item.colIdx = columns.length;
        columns.push(item.endMins);
      }
    });

    const numCols = columns.length;
    cluster.forEach(item => {
      item.width = 100 / numCols;
      item.left = item.colIdx * item.width;
      result.push(item);
    });
  });

  return result;
}

render();
