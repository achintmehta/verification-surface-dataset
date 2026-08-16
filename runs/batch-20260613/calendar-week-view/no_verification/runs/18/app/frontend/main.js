const API_URL = '/api/events';
const HOUR_HEIGHT = 60; // 1 pixel per minute
const TOTAL_HOURS = 24;
const TOTAL_HEIGHT = TOTAL_HOURS * HOUR_HEIGHT;

let currentDate = new Date();
let events = [];

// DOM Elements
const timeAxis = document.getElementById('time-axis');
const weekGrid = document.getElementById('week-grid');
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

// Navigation
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

// Modal actions
btnCancel.addEventListener('click', closeModal);

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
    fetchEvents();
  } catch (err) {
    alert(err.message);
  }
});

btnDelete.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  if (confirm('Are you sure you want to delete this event?')) {
    try {
      const res = await fetch(\`\${API_URL}/\${id}\`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete event');
      closeModal();
      fetchEvents();
    } catch (err) {
      alert(err.message);
    }
  }
});

function openModal(event = null, defaultStart = null, defaultEnd = null) {
  modal.classList.remove('hidden');
  if (event) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = event.id;
    eventTitleInput.value = event.title;
    eventStartInput.value = formatForDatetimeLocal(new Date(event.start_at));
    eventEndInput.value = formatForDatetimeLocal(new Date(event.end_at));
    btnDelete.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = defaultStart ? formatForDatetimeLocal(defaultStart) : '';
    eventEndInput.value = defaultEnd ? formatForDatetimeLocal(defaultEnd) : '';
    btnDelete.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

function formatForDatetimeLocal(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  return \`\${date.getFullYear()}-\${pad(date.getMonth() + 1)}-\${pad(date.getDate())}T\${pad(date.getHours())}:\${pad(date.getMinutes())}\`;
}

function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function fetchEvents() {
  const startOfWeek = getStartOfWeek(currentDate);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  try {
    const res = await fetch(\`\${API_URL}?start=\${startOfWeek.toISOString()}&end=\${endOfWeek.toISOString()}\`);
    if (!res.ok) throw new Error('Failed to fetch events');
    events = await res.json();
    renderEvents();
  } catch (err) {
    console.error(err);
  }
}

function renderTimeAxis() {
  timeAxis.innerHTML = '';
  // Add a spacer for the header
  const headerSpacer = document.createElement('div');
  headerSpacer.style.height = '50px';
  timeAxis.appendChild(headerSpacer);

  const axisContent = document.createElement('div');
  axisContent.style.position = 'relative';
  axisContent.style.height = \`\${TOTAL_HEIGHT}px\`;

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = \`\${i * HOUR_HEIGHT}px\`;
    label.textContent = \`\${i.toString().padStart(2, '0')}:00\`;
    axisContent.appendChild(label);
  }
  timeAxis.appendChild(axisContent);
}

function renderWeek() {
  const startOfWeek = getStartOfWeek(currentDate);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 6);

  currentWeekLabel.textContent = \`\${startOfWeek.toLocaleDateString()} - \${endOfWeek.toLocaleDateString()}\`;

  weekGrid.innerHTML = '';
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(startOfWeek);
    dayDate.setDate(dayDate.getDate() + i);

    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.toDateString() === today.toDateString()) {
      header.classList.add('today');
    }
    
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    header.innerHTML = \`<div>\${dayNames[dayDate.getDay()]}</div><div>\${dayDate.getDate()}</div>\`;
    col.appendChild(header);

    const content = document.createElement('div');
    content.className = 'day-content';
    content.style.height = \`\${TOTAL_HEIGHT}px\`;

    // Hour lines
    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = \`\${h * HOUR_HEIGHT}px\`;
      content.appendChild(line);
    }

    // Click to create event
    content.addEventListener('click', (e) => {
      if (e.target !== content && !e.target.classList.contains('hour-line')) return;
      const rect = content.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / HOUR_HEIGHT * 60);
      
      const start = new Date(dayDate);
      start.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1); // Default 1 hour duration

      openModal(null, start, end);
    });

    col.appendChild(content);
    weekGrid.appendChild(col);
  }

  fetchEvents();
}

function renderEvents() {
  // Clear existing events
  document.querySelectorAll('.event-block').forEach(el => el.remove());

  const startOfWeek = getStartOfWeek(currentDate);

  // Group events by day
  const days = Array.from({ length: 7 }, () => []);

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
        // Event overlaps with this day
        days[i].push({
          ...event,
          startObj: start,
          endObj: end,
          dayStart,
          dayEnd
        });
      }
    }
  });

  days.forEach((dayEvents, dayIndex) => {
    if (dayEvents.length === 0) return;

    // Sort by start time, then end time
    dayEvents.sort((a, b) => {
      if (a.startObj.getTime() !== b.startObj.getTime()) {
        return a.startObj.getTime() - b.startObj.getTime();
      }
      return a.endObj.getTime() - b.endObj.getTime();
    });

    // Cluster overlapping events
    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(event => {
      const start = Math.max(event.startObj.getTime(), event.dayStart.getTime());
      const end = Math.min(event.endObj.getTime(), event.dayEnd.getTime());

      if (currentCluster.length === 0) {
        currentCluster.push(event);
        clusterEnd = end;
      } else {
        if (start < clusterEnd) {
          currentCluster.push(event);
          clusterEnd = Math.max(clusterEnd, end);
        } else {
          clusters.push(currentCluster);
          currentCluster = [event];
          clusterEnd = end;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    // Layout each cluster
    const dayCol = weekGrid.children[dayIndex].querySelector('.day-content');

    clusters.forEach(cluster => {
      const columns = [];

      cluster.forEach(event => {
        const start = Math.max(event.startObj.getTime(), event.dayStart.getTime());
        const end = Math.min(event.endObj.getTime(), event.dayEnd.getTime());

        let placed = false;
        for (let i = 0; i < columns.length; i++) {
          const colEnd = columns[i][columns[i].length - 1].end;
          if (start >= colEnd) {
            columns[i].push({ event, start, end });
            event.colIdx = i;
            placed = true;
            break;
          }
        }

        if (!placed) {
          columns.push([{ event, start, end }]);
          event.colIdx = columns.length - 1;
        }
      });

      const numCols = columns.length;

      cluster.forEach(event => {
        const start = Math.max(event.startObj.getTime(), event.dayStart.getTime());
        const end = Math.min(event.endObj.getTime(), event.dayEnd.getTime());

        const startObj = new Date(start);
        const endObj = new Date(end);
        
        const startMinutes = startObj.getHours() * 60 + startObj.getMinutes();
        let endMinutes = endObj.getHours() * 60 + endObj.getMinutes();
        
        // If the event ends exactly at the end of the day (midnight next day)
        if (endObj.getTime() === event.dayEnd.getTime() || (endObj.getHours() === 0 && endObj.getMinutes() === 0 && endObj.getTime() > startObj.getTime())) {
          endMinutes = 24 * 60;
        }

        const top = startMinutes;
        const height = endMinutes - startMinutes;

        const width = 100 / numCols;
        const left = event.colIdx * width;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = \`\${top}px\`;
        block.style.height = \`\${height}px\`;
        block.style.left = \`\${left}%\`;
        block.style.width = \`\${width}%\`;

        const title = document.createElement('div');
        title.className = 'event-title';
        title.textContent = event.title;

        const time = document.createElement('div');
        time.className = 'event-time';
        const formatTime = (d) => \`\${d.getHours().toString().padStart(2, '0')}:\${d.getMinutes().toString().padStart(2, '0')}\`;
        time.textContent = \`\${formatTime(event.startObj)} - \${formatTime(event.endObj)}\`;

        block.appendChild(title);
        block.appendChild(time);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(event);
        });

        dayCol.appendChild(block);
      });
    });
  });
}

// Initialize
renderTimeAxis();
renderWeek();
