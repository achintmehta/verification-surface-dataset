const API_URL = 'http://localhost:3000/api/events';

let currentWeekStart = getStartOfWeek(new Date());
let events = [];

const PIXELS_PER_MINUTE = 1; // 1 minute = 1 pixel, 24 hours = 1440 pixels

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function formatTime(date) {
  return date.toTimeString().substring(0, 5);
}

function toLocalISOString(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function fetchEvents() {
  const start = currentWeekStart.toISOString();
  const end = addDays(currentWeekStart, 7).toISOString();
  try {
    const res = await fetch(`${API_URL}?start=${start}&end=${end}`);
    if (!res.ok) {
      console.error('Failed to fetch events');
      return;
    }
    const data = await res.json();
    events = data.map(e => ({
      ...e,
      start_at: new Date(e.start_at),
      end_at: new Date(e.end_at)
    }));
    renderCalendar();
  } catch (err) {
    console.error(err);
  }
}

function renderCalendar() {
  document.getElementById('current-month-year').textContent = currentWeekStart.toLocaleDateString('default', { month: 'long', year: 'numeric' });
  
  const timeAxis = document.getElementById('time-axis');
  timeAxis.innerHTML = '';
  
  const timeHeader = document.createElement('div');
  timeHeader.className = 'time-header';
  timeAxis.appendChild(timeHeader);

  const timeContent = document.createElement('div');
  timeContent.style.position = 'relative';
  timeContent.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = `${i * 60 * PIXELS_PER_MINUTE}px`;
    label.textContent = `${i.toString().padStart(2, '0')}:00`;
    timeContent.appendChild(label);
  }
  timeAxis.appendChild(timeContent);

  const daysGrid = document.getElementById('days-grid');
  daysGrid.innerHTML = '';

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = addDays(currentWeekStart, i);
    const isToday = dayDate.getTime() === today.getTime();

    const dayCol = document.createElement('div');
    dayCol.className = 'day-column';
    dayCol.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = `day-header ${isToday ? 'today' : ''}`;
    header.textContent = dayDate.toLocaleDateString('default', { weekday: 'short', month: 'numeric', day: 'numeric' });
    dayCol.appendChild(header);

    const dayContent = document.createElement('div');
    dayContent.style.position = 'relative';
    dayContent.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;
    dayContent.addEventListener('mousedown', (e) => handleDayClick(e, dayDate));

    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
      dayContent.appendChild(line);
    }

    const dayEvents = events.filter(e => {
      const eStart = e.start_at;
      const eEnd = e.end_at;
      const dStart = dayDate;
      const dEnd = addDays(dayDate, 1);
      return eStart < dEnd && eEnd > dStart;
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
      time.textContent = `${formatTime(le.event.start_at)} - ${formatTime(le.event.end_at)}`;
      
      block.appendChild(title);
      block.appendChild(time);

      block.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        openModal(le.event);
      });

      dayContent.appendChild(block);
    });

    dayCol.appendChild(dayContent);
    daysGrid.appendChild(dayCol);
  }
}

function layoutEvents(dayEvents, dayDate) {
  const dStart = dayDate.getTime();
  const dEnd = addDays(dayDate, 1).getTime();

  const eventsToLayout = dayEvents.map(e => {
    const start = Math.max(e.start_at.getTime(), dStart);
    const end = Math.min(e.end_at.getTime(), dEnd);
    const startMin = (start - dStart) / 60000;
    const endMin = (end - dStart) / 60000;
    return {
      event: e,
      startMin,
      endMin,
      top: startMin * PIXELS_PER_MINUTE,
      height: (endMin - startMin) * PIXELS_PER_MINUTE
    };
  }).sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));

  const clusters = [];
  let currentCluster = [];
  let clusterEnd = -1;

  eventsToLayout.forEach(e => {
    if (currentCluster.length === 0) {
      currentCluster.push(e);
      clusterEnd = e.endMin;
    } else if (e.startMin < clusterEnd) {
      currentCluster.push(e);
      clusterEnd = Math.max(clusterEnd, e.endMin);
    } else {
      clusters.push(currentCluster);
      currentCluster = [e];
      clusterEnd = e.endMin;
    }
  });
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  const layouted = [];

  clusters.forEach(cluster => {
    const columns = [];
    cluster.forEach(e => {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEvent = col[col.length - 1];
        if (lastEvent.endMin <= e.startMin) {
          col.push(e);
          e.colIdx = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        e.colIdx = columns.length;
        columns.push([e]);
      }
    });

    const numCols = columns.length;
    cluster.forEach(e => {
      e.left = (e.colIdx / numCols) * 100;
      e.width = (1 / numCols) * 100;
      layouted.push(e);
    });
  });

  return layouted;
}

function handleDayClick(e, dayDate) {
  const rect = e.currentTarget.getBoundingClientRect();
  const y = e.clientY - rect.top;
  const minutes = Math.floor(y / PIXELS_PER_MINUTE);
  
  const start = new Date(dayDate);
  start.setMinutes(minutes);
  
  const end = new Date(start);
  end.setHours(end.getHours() + 1);

  openModal({
    title: '',
    start_at: start,
    end_at: end
  });
}

const modal = document.getElementById('event-modal');
const form = document.getElementById('event-form');
const titleInput = document.getElementById('event-title');
const startInput = document.getElementById('event-start');
const endInput = document.getElementById('event-end');
const idInput = document.getElementById('event-id');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');

function openModal(event) {
  titleInput.value = event.title || '';
  startInput.value = toLocalISOString(event.start_at);
  endInput.value = toLocalISOString(event.end_at);
  
  if (event.id) {
    idInput.value = event.id;
    document.getElementById('modal-title').textContent = 'Edit Event';
    deleteBtn.classList.remove('hidden');
  } else {
    idInput.value = '';
    document.getElementById('modal-title').textContent = 'Create Event';
    deleteBtn.classList.add('hidden');
  }
  
  modal.classList.remove('hidden');
}

function closeModal() {
  modal.classList.add('hidden');
  form.reset();
}

cancelBtn.addEventListener('click', closeModal);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = idInput.value;
  const payload = {
    title: titleInput.value,
    start_at: new Date(startInput.value).toISOString(),
    end_at: new Date(endInput.value).toISOString()
  };

  if (new Date(payload.end_at) <= new Date(payload.start_at)) {
    alert('End time must be after start time');
    return;
  }

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
      alert(err.error || 'Failed to save event');
      return;
    }

    closeModal();
    fetchEvents();
  } catch (err) {
    console.error(err);
    alert('Error saving event');
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = idInput.value;
  if (!id) return;
  
  if (!confirm('Are you sure you want to delete this event?')) return;

  try {
    const res = await fetch(`${API_URL}/${id}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to delete event');
      return;
    }
    closeModal();
    fetchEvents();
  } catch (err) {
    console.error(err);
    alert('Error deleting event');
  }
});

document.getElementById('prev-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, -7);
  fetchEvents();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentWeekStart = addDays(currentWeekStart, 7);
  fetchEvents();
});

document.getElementById('today').addEventListener('click', () => {
  currentWeekStart = getStartOfWeek(new Date());
  fetchEvents();
});

fetchEvents();
