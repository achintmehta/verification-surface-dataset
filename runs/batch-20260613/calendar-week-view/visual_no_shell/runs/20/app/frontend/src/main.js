import { 
  startOfWeek, 
  endOfWeek, 
  addDays, 
  subWeeks, 
  addWeeks, 
  format, 
  isSameDay, 
  parseISO, 
  differenceInMinutes,
  startOfDay,
  endOfDay,
  isBefore,
  isAfter,
  max,
  min
} from 'date-fns';

const PIXELS_PER_HOUR = 60;
const PIXELS_PER_MINUTE = PIXELS_PER_HOUR / 60;

let currentWeekStart = startOfWeek(new Date(), { weekStarts: 1 }); // Monday
let events = [];

const daysHeaderEl = document.getElementById('days-header');
const timeAxisEl = document.getElementById('time-axis');
const daysGridEl = document.getElementById('days-grid');
const currentWeekLabelEl = document.getElementById('current-week-label');

const modalEl = document.getElementById('event-modal');
const modalTitleEl = document.getElementById('modal-title');
const eventForm = document.getElementById('event-form');
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

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = startOfWeek(new Date(), { weekStarts: 1 });
  render();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart = addWeeks(currentWeekStart, 1);
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
    if (id) {
      const res = await fetch(`/api/events/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to update');
    } else {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to create');
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
    if (!res.ok) throw new Error('Failed to delete');
    closeModal();
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

function openModal(event = null, defaultStart = null, defaultEnd = null) {
  modalEl.classList.remove('hidden');
  if (event) {
    modalTitleEl.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = format(parseISO(event.start_at), "yyyy-MM-dd'T'HH:mm");
    eventEndInput.value = format(parseISO(event.end_at), "yyyy-MM-dd'T'HH:mm");
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitleEl.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = defaultStart ? format(defaultStart, "yyyy-MM-dd'T'HH:mm") : '';
    eventEndInput.value = defaultEnd ? format(defaultEnd, "yyyy-MM-dd'T'HH:mm") : '';
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modalEl.classList.add('hidden');
}

async function fetchEvents() {
  const start = currentWeekStart.toISOString();
  const end = endOfWeek(currentWeekStart, { weekStarts: 1 }).toISOString();
  try {
    const res = await fetch(`/api/events?start=${start}&end=${end}`);
    if (!res.ok) throw new Error('Failed to fetch events');
    events = await res.json();
    renderEvents();
  } catch (err) {
    console.error(err);
  }
}

function render() {
  currentWeekLabelEl.textContent = `${format(currentWeekStart, 'MMM d')} - ${format(endOfWeek(currentWeekStart, { weekStarts: 1 }), 'MMM d, yyyy')}`;
  
  // Render days header
  daysHeaderEl.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const day = addDays(currentWeekStart, i);
    const div = document.createElement('div');
    div.className = 'day-header';
    if (isSameDay(day, new Date())) {
      div.classList.add('today');
    }
    div.textContent = format(day, 'EEE M/d');
    daysHeaderEl.appendChild(div);
  }

  // Render time axis
  timeAxisEl.innerHTML = '<div style="height: 1440px; position: relative;"></div>';
  const timeAxisInner = timeAxisEl.firstChild;
  for (let i = 0; i < 24; i++) {
    const div = document.createElement('div');
    div.className = 'time-label';
    div.style.top = `${i * PIXELS_PER_HOUR}px`;
    div.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeAxisInner.appendChild(div);
  }

  // Render days grid
  daysGridEl.innerHTML = '';
  for (let i = 0; i < 7; i++) {
    const day = addDays(currentWeekStart, i);
    const div = document.createElement('div');
    div.className = 'day-column';
    div.dataset.date = format(day, 'yyyy-MM-dd');
    if (isSameDay(day, new Date())) {
      div.classList.add('today');
    }
    
    // Click to create event
    div.addEventListener('mousedown', (e) => {
      if (e.target !== div) return; // Ignore clicks on events
      const rect = div.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      const start = new Date(day);
      start.setHours(0, minutes, 0, 0);
      const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hour default
      openModal(null, start, end);
    });

    daysGridEl.appendChild(div);
  }

  // Sync scroll
  daysGridEl.addEventListener('scroll', () => {
    timeAxisEl.scrollTop = daysGridEl.scrollTop;
  });

  fetchEvents();
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);

  events.forEach(event => {
    const start = parseISO(event.start_at);
    const end = parseISO(event.end_at);
    
    for (let i = 0; i < 7; i++) {
      const day = addDays(currentWeekStart, i);
      const dayStart = startOfDay(day);
      const dayEnd = endOfDay(day);
      
      if (isBefore(start, dayEnd) && isAfter(end, dayStart)) {
        // Event overlaps with this day
        eventsByDay[i].push({
          ...event,
          renderStart: max([start, dayStart]),
          renderEnd: min([end, new Date(dayEnd.getTime() + 1)]) // up to 24:00
        });
      }
    }
  });

  eventsByDay.forEach((dayEvents, dayIndex) => {
    if (dayEvents.length === 0) return;

    // Sort by start time, then end time
    dayEvents.sort((a, b) => {
      if (a.renderStart.getTime() !== b.renderStart.getTime()) {
        return a.renderStart.getTime() - b.renderStart.getTime();
      }
      return a.renderEnd.getTime() - b.renderEnd.getTime();
    });

    // Cluster overlapping events
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(event => {
      if (currentCluster.length === 0) {
        currentCluster.push(event);
        clusterEnd = event.renderEnd;
      } else {
        if (event.renderStart < clusterEnd) {
          currentCluster.push(event);
          if (event.renderEnd > clusterEnd) {
            clusterEnd = event.renderEnd;
          }
        } else {
          clusters.push(currentCluster);
          currentCluster = [event];
          clusterEnd = event.renderEnd;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    // Layout each cluster
    const dayColumn = daysGridEl.children[dayIndex];

    clusters.forEach(cluster => {
      const columns = [];

      cluster.forEach(event => {
        let placed = false;
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          const lastEvent = col[col.length - 1];
          if (event.renderStart >= lastEvent.renderEnd) {
            col.push(event);
            event.column = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          event.column = columns.length;
          columns.push([event]);
        }
      });

      const numColumns = columns.length;

      cluster.forEach(event => {
        const startMinutes = event.renderStart.getHours() * 60 + event.renderStart.getMinutes();
        let endMinutes = event.renderEnd.getHours() * 60 + event.renderEnd.getMinutes();
        if (event.renderEnd.getHours() === 0 && event.renderEnd.getMinutes() === 0 && event.renderEnd > event.renderStart) {
          endMinutes = 24 * 60;
        }

        const top = startMinutes * PIXELS_PER_MINUTE;
        const height = (endMinutes - startMinutes) * PIXELS_PER_MINUTE;
        const width = 100 / numColumns;
        const left = event.column * width;

        const el = document.createElement('div');
        el.className = 'event-block';
        el.style.top = `${top}px`;
        el.style.height = `${height}px`;
        el.style.left = `${left}%`;
        el.style.width = `${width}%`;
        el.style.position = 'absolute';
        el.style.boxSizing = 'border-box';

        const titleEl = document.createElement('div');
        titleEl.className = 'event-title';
        titleEl.textContent = event.title;

        const timeEl = document.createElement('div');
        timeEl.className = 'event-time';
        timeEl.textContent = `${format(parseISO(event.start_at), 'HH:mm')} - ${format(parseISO(event.end_at), 'HH:mm')}`;

        el.appendChild(titleEl);
        el.appendChild(timeEl);

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(event);
        });

        dayColumn.appendChild(el);
      });
    });
  });
}

render();
