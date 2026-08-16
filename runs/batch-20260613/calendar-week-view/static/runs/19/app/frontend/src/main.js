const API_URL = 'http://localhost:3000/api/events';

let currentDate = new Date();
// Normalize to start of week (Monday)
function getStartOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
  d.setDate(diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

let currentWeekStart = getStartOfWeek(currentDate);
let events = [];

const PIXELS_PER_MINUTE = 1;
const TOTAL_HEIGHT = 24 * 60 * PIXELS_PER_MINUTE;

async function fetchEvents() {
  const start = new Date(currentWeekStart);
  const end = new Date(currentWeekStart);
  end.setDate(end.getDate() + 7);
  
  const res = await fetch(\`\${API_URL}?start=\${start.toISOString()}&end=\${end.toISOString()}\`);
  events = await res.json();
  render();
}

function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';

  // Header
  const header = document.createElement('header');
  
  const prevBtn = document.createElement('button');
  prevBtn.textContent = 'Prev';
  prevBtn.onclick = () => {
    currentWeekStart.setDate(currentWeekStart.getDate() - 7);
    fetchEvents();
  };

  const todayBtn = document.createElement('button');
  todayBtn.textContent = 'Today';
  todayBtn.onclick = () => {
    currentWeekStart = getStartOfWeek(new Date());
    fetchEvents();
  };

  const nextBtn = document.createElement('button');
  nextBtn.textContent = 'Next';
  nextBtn.onclick = () => {
    currentWeekStart.setDate(currentWeekStart.getDate() + 7);
    fetchEvents();
  };

  const title = document.createElement('h1');
  const endOfWeek = new Date(currentWeekStart);
  endOfWeek.setDate(endOfWeek.getDate() + 6);
  title.textContent = \`\${currentWeekStart.toLocaleDateString()} - \${endOfWeek.toLocaleDateString()}\`;

  header.append(prevBtn, todayBtn, nextBtn, title);
  app.appendChild(header);

  // Calendar Container
  const container = document.createElement('div');
  container.className = 'calendar-container';

  // Calendar Header (Days)
  const calHeader = document.createElement('div');
  calHeader.className = 'calendar-header';
  
  const timeAxisHeader = document.createElement('div');
  timeAxisHeader.className = 'time-axis-header';
  calHeader.appendChild(timeAxisHeader);

  const today = new Date();
  today.setHours(0,0,0,0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(currentWeekStart);
    dayDate.setDate(dayDate.getDate() + i);
    
    const dayHeader = document.createElement('div');
    dayHeader.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      dayHeader.classList.add('today');
    }
    
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayHeader.textContent = \`\${dayNames[dayDate.getDay()]} \${dayDate.getDate()}\`;
    calHeader.appendChild(dayHeader);
  }
  container.appendChild(calHeader);

  // Calendar Body
  const calBody = document.createElement('div');
  calBody.className = 'calendar-body';

  // Time Axis
  const timeAxis = document.createElement('div');
  timeAxis.className = 'time-axis';
  timeAxis.style.height = \`\${TOTAL_HEIGHT}px\`;
  for (let h = 0; h <= 24; h++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = \`\${h * 60 * PIXELS_PER_MINUTE}px\`;
    label.textContent = \`\${h.toString().padStart(2, '0')}:00\`;
    timeAxis.appendChild(label);
  }
  calBody.appendChild(timeAxis);

  // Day Columns
  const dayColumns = document.createElement('div');
  dayColumns.className = 'day-columns';
  dayColumns.style.height = \`\${TOTAL_HEIGHT}px\`;

  // Hour lines across all columns
  for (let h = 0; h <= 24; h++) {
    const line = document.createElement('div');
    line.className = 'hour-line';
    line.style.top = \`\${h * 60 * PIXELS_PER_MINUTE}px\`;
    dayColumns.appendChild(line);
  }

  // Group events by day
  const eventsByDay = Array.from({ length: 7 }, () => []);
  for (const event of events) {
    const start = new Date(event.start_at);
    const end = new Date(event.end_at);
    
    // Find which day(s) this event belongs to
    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(currentWeekStart);
      dayStart.setDate(dayStart.getDate() + i);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);

      if (start < dayEnd && end > dayStart) {
        // Event overlaps this day
        // We need to clone the event so that layout properties (_col, _numCols) are per-day
        eventsByDay[i].push({ ...event });
      }
    }
  }

  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(currentWeekStart);
    dayStart.setDate(dayStart.getDate() + i);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);

    const col = document.createElement('div');
    col.className = 'day-column';
    
    // Handle click to create event
    col.addEventListener('click', (e) => {
      if (e.target !== col) return; // Ignore clicks on events
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      const startAt = new Date(dayStart);
      startAt.setMinutes(minutes);
      
      const endAt = new Date(startAt);
      endAt.setHours(endAt.getHours() + 1); // Default 1 hour duration
      
      showModal({ start_at: startAt.toISOString(), end_at: endAt.toISOString() });
    });

    const dayEvents = eventsByDay[i];
    layoutEvents(dayEvents);

    for (const event of dayEvents) {
      const evStart = new Date(event.start_at);
      const evEnd = new Date(event.end_at);
      
      // Clamp to day boundaries
      const clampedStart = evStart < dayStart ? dayStart : evStart;
      const clampedEnd = evEnd > dayEnd ? dayEnd : evEnd;

      const startMins = (clampedStart - dayStart) / 60000;
      const endMins = (clampedEnd - dayStart) / 60000;

      const top = startMins * PIXELS_PER_MINUTE;
      const height = (endMins - startMins) * PIXELS_PER_MINUTE;

      const el = document.createElement('div');
      el.className = 'event';
      el.style.top = \`\${top}px\`;
      el.style.height = \`\${height}px\`;
      
      const widthPct = 100 / event._numCols;
      const leftPct = event._col * widthPct;
      
      el.style.width = \`\${widthPct}%\`;
      el.style.left = \`\${leftPct}%\`;

      const titleEl = document.createElement('div');
      titleEl.className = 'event-title';
      titleEl.textContent = event.title;

      const timeEl = document.createElement('div');
      timeEl.className = 'event-time';
      timeEl.textContent = \`\${formatTime(evStart)} - \${formatTime(evEnd)}\`;

      el.appendChild(titleEl);
      el.appendChild(timeEl);

      el.addEventListener('click', (e) => {
        e.stopPropagation();
        showModal(event);
      });

      col.appendChild(el);
    }

    dayColumns.appendChild(col);
  }

  calBody.appendChild(dayColumns);
  container.appendChild(calBody);
  app.appendChild(container);
}

function formatTime(date) {
  return \`\${date.getHours().toString().padStart(2, '0')}:\${date.getMinutes().toString().padStart(2, '0')}\`;
}

function layoutEvents(events) {
  events.sort((a, b) => {
    const startDiff = new Date(a.start_at) - new Date(b.start_at);
    if (startDiff !== 0) return startDiff;
    return new Date(b.end_at) - new Date(a.end_at);
  });

  const clusters = [];
  let currentCluster = [];
  let clusterEnd = null;

  for (const event of events) {
    const start = new Date(event.start_at).getTime();
    const end = new Date(event.end_at).getTime();

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
  }
  if (currentCluster.length > 0) {
    clusters.push(currentCluster);
  }

  for (const cluster of clusters) {
    const columns = [];
    for (const event of cluster) {
      let placed = false;
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        const lastEvent = col[col.length - 1];
        if (new Date(lastEvent.end_at).getTime() <= new Date(event.start_at).getTime()) {
          col.push(event);
          event._col = i;
          placed = true;
          break;
        }
      }
      if (!placed) {
        event._col = columns.length;
        columns.push([event]);
      }
    }
    const numCols = columns.length;
    for (const event of cluster) {
      event._numCols = numCols;
    }
  }
}

function showModal(eventData) {
  const isEdit = !!eventData.id;
  
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const title = document.createElement('h2');
  title.textContent = isEdit ? 'Edit Event' : 'Create Event';
  modal.appendChild(title);

  const form = document.createElement('form');
  
  const titleGroup = document.createElement('div');
  titleGroup.className = 'form-group';
  titleGroup.innerHTML = \`<label>Title</label><input type="text" name="title" required value="\${eventData.title || ''}" />\`;
  form.appendChild(titleGroup);

  // Format for datetime-local input
  const formatForInput = (isoString) => {
    const d = new Date(isoString);
    // Adjust for local timezone offset
    const tzOffset = d.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(d - tzOffset)).toISOString().slice(0, 16);
    return localISOTime;
  };

  const startGroup = document.createElement('div');
  startGroup.className = 'form-group';
  startGroup.innerHTML = \`<label>Start</label><input type="datetime-local" name="start_at" required value="\${formatForInput(eventData.start_at)}" />\`;
  form.appendChild(startGroup);

  const endGroup = document.createElement('div');
  endGroup.className = 'form-group';
  endGroup.innerHTML = \`<label>End</label><input type="datetime-local" name="end_at" required value="\${formatForInput(eventData.end_at)}" />\`;
  form.appendChild(endGroup);

  const actions = document.createElement('div');
  actions.className = 'modal-actions';

  if (isEdit) {
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-danger';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = async () => {
      await fetch(\`\${API_URL}/\${eventData.id}\`, { method: 'DELETE' });
      document.body.removeChild(overlay);
      fetchEvents();
    };
    actions.appendChild(deleteBtn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn-secondary';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.onclick = () => document.body.removeChild(overlay);
  actions.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'submit';
  saveBtn.className = 'btn-primary';
  saveBtn.textContent = 'Save';
  actions.appendChild(saveBtn);

  form.appendChild(actions);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const payload = {
      title: formData.get('title'),
      start_at: new Date(formData.get('start_at')).toISOString(),
      end_at: new Date(formData.get('end_at')).toISOString()
    };

    try {
      const res = await fetch(isEdit ? \`\${API_URL}/\${eventData.id}\` : API_URL, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'An error occurred');
        return;
      }
      
      document.body.removeChild(overlay);
      fetchEvents();
    } catch (err) {
      alert(err.message);
    }
  };

  modal.appendChild(form);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// Initial load
fetchEvents();
