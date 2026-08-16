const API_URL = 'http://localhost:3001/api/events';

let currentDate = new Date();
function getMonday(d) {
  d = new Date(d);
  const day = d.getDay(),
      diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff));
}

currentDate = getMonday(currentDate);
currentDate.setHours(0, 0, 0, 0);

const PIXELS_PER_MINUTE = 1;
const DAY_START_HOUR = 0;
const DAY_END_HOUR = 24;
const TOTAL_MINUTES = (DAY_END_HOUR - DAY_START_HOUR) * 60;

const timeAxis = document.getElementById('time-axis');
const weekGrid = document.getElementById('week-grid');
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

let events = [];

function initGrid() {
  timeAxis.innerHTML = '';
  const headerSpace = document.createElement('div');
  headerSpace.style.height = '31px'; // 20px height + 10px padding + 1px border
  headerSpace.style.position = 'sticky';
  headerSpace.style.top = '0';
  headerSpace.style.background = '#fafafa';
  headerSpace.style.zIndex = '10';
  timeAxis.appendChild(headerSpace);

  for (let i = 0; i <= 24; i++) {
    const label = document.createElement('div');
    label.className = 'time-label';
    label.style.top = \`\${31 + i * 60 * PIXELS_PER_MINUTE}px\`;
    label.textContent = \`\${i.toString().padStart(2, '0')}:00\`;
    timeAxis.appendChild(label);
  }
}

function formatDateForInput(date) {
  if (!date) return '';
  const d = new Date(date);
  const pad = (n) => n.toString().padStart(2, '0');
  return \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}T\${pad(d.getHours())}:\${pad(d.getMinutes())}\`;
}

function renderWeek() {
  weekGrid.innerHTML = '';
  const monday = getMonday(currentDate);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  
  currentWeekLabel.textContent = \`\${monday.toLocaleDateString()} - \${sunday.toLocaleDateString()}\`;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const dayDate = new Date(monday);
    dayDate.setDate(dayDate.getDate() + i);
    
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.date = dayDate.toISOString();

    const header = document.createElement('div');
    header.className = 'day-header';
    if (dayDate.getTime() === today.getTime()) {
      header.classList.add('today');
    }
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    header.textContent = \`\${days[dayDate.getDay()]} \${dayDate.getDate()}\`;
    col.appendChild(header);

    const gridContent = document.createElement('div');
    gridContent.style.position = 'relative';
    gridContent.style.height = \`\${TOTAL_MINUTES * PIXELS_PER_MINUTE}px\`;
    gridContent.className = 'grid-content';

    for (let h = 0; h <= 24; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      line.style.top = \`\${h * 60 * PIXELS_PER_MINUTE}px\`;
      gridContent.appendChild(line);
    }

    gridContent.addEventListener('mousedown', (e) => {
      if (e.target !== gridContent && !e.target.classList.contains('hour-line')) return;
      
      const rect = gridContent.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const minutes = Math.floor(y / PIXELS_PER_MINUTE);
      
      const start = new Date(dayDate);
      start.setHours(0, minutes, 0, 0);
      
      const end = new Date(start);
      end.setHours(start.getHours() + 1);

      openModal(null, start, end);
    });

    col.appendChild(gridContent);
    weekGrid.appendChild(col);
  }

  renderEvents();
}

function renderEvents() {
  const monday = getMonday(currentDate);
  
  const eventsByDay = Array.from({ length: 7 }, () => []);

  for (let i = 0; i < 7; i++) {
    const dayStart = new Date(monday);
    dayStart.setDate(dayStart.getDate() + i);
    dayStart.setHours(0, 0, 0, 0);
    
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    
    events.forEach(ev => {
      const start = new Date(ev.start_at);
      const end = new Date(ev.end_at);
      
      if (start < dayEnd && end > dayStart) {
        const clampedStart = start < dayStart ? dayStart : start;
        const clampedEnd = end > dayEnd ? dayEnd : end;
        
        eventsByDay[i].push({
          ...ev,
          start: clampedStart,
          end: clampedEnd,
          originalStart: start,
          originalEnd: end
        });
      }
    });
  }

  const columns = weekGrid.querySelectorAll('.day-column');

  eventsByDay.forEach((dayEvents, dayIndex) => {
    const gridContent = columns[dayIndex].querySelector('.grid-content');
    
    dayEvents.sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());

    const clusters = [];
    let currentCluster = [];
    let clusterEnd = null;

    dayEvents.forEach(ev => {
      if (currentCluster.length === 0) {
        currentCluster.push(ev);
        clusterEnd = ev.end;
      } else {
        if (ev.start < clusterEnd) {
          currentCluster.push(ev);
          if (ev.end > clusterEnd) {
            clusterEnd = ev.end;
          }
        } else {
          clusters.push(currentCluster);
          currentCluster = [ev];
          clusterEnd = ev.end;
        }
      }
    });
    if (currentCluster.length > 0) {
      clusters.push(currentCluster);
    }

    clusters.forEach(cluster => {
      const columnsInCluster = [];
      
      cluster.forEach(ev => {
        let placed = false;
        for (let i = 0; i < columnsInCluster.length; i++) {
          const col = columnsInCluster[i];
          const lastEv = col[col.length - 1];
          if (lastEv.end <= ev.start) {
            col.push(ev);
            ev.colIndex = i;
            placed = true;
            break;
          }
        }
        if (!placed) {
          columnsInCluster.push([ev]);
          ev.colIndex = columnsInCluster.length - 1;
        }
      });

      const numCols = columnsInCluster.length;

      cluster.forEach(ev => {
        const startMinutes = ev.start.getHours() * 60 + ev.start.getMinutes();
        let endMinutes = ev.end.getHours() * 60 + ev.end.getMinutes();
        
        const dayStart = new Date(monday);
        dayStart.setDate(dayStart.getDate() + dayIndex);
        dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        if (ev.end.getTime() === dayEnd.getTime()) {
          endMinutes = 24 * 60;
        }

        const top = startMinutes * PIXELS_PER_MINUTE;
        const height = (endMinutes - startMinutes) * PIXELS_PER_MINUTE;

        const block = document.createElement('div');
        block.className = 'event-block';
        block.style.top = \`\${top}px\`;
        block.style.height = \`\${height}px\`;
        block.style.left = \`\${(ev.colIndex / numCols) * 100}%\`;
        block.style.width = \`\${(1 / numCols) * 100}%\`;

        const title = document.createElement('div');
        title.className = 'event-title';
        title.textContent = ev.title;
        
        const time = document.createElement('div');
        time.className = 'event-time';
        const formatTime = (d) => \`\${d.getHours().toString().padStart(2, '0')}:\${d.getMinutes().toString().padStart(2, '0')}\`;
        
        time.textContent = \`\${formatTime(ev.originalStart)} - \${formatTime(ev.originalEnd)}\`;

        block.appendChild(title);
        block.appendChild(time);

        block.addEventListener('click', (e) => {
          e.stopPropagation();
          openModal(ev);
        });

        gridContent.appendChild(block);
      });
    });
  });
}

async function fetchEvents() {
  const monday = getMonday(currentDate);
  const nextMonday = new Date(monday);
  nextMonday.setDate(nextMonday.getDate() + 7);

  try {
    const res = await fetch(\`\${API_URL}?start=\${monday.toISOString()}&end=\${nextMonday.toISOString()}\`);
    events = await res.json();
    renderWeek();
  } catch (err) {
    console.error('Failed to fetch events', err);
  }
}

function openModal(ev = null, start = null, end = null) {
  modal.classList.remove('hidden');
  if (ev) {
    modalTitle.textContent = 'Edit Event';
    eventIdInput.value = ev.id;
    eventTitleInput.value = ev.title;
    eventStartInput.value = formatDateForInput(ev.originalStart);
    eventEndInput.value = formatDateForInput(ev.originalEnd);
    deleteBtn.classList.remove('hidden');
  } else {
    modalTitle.textContent = 'Create Event';
    eventIdInput.value = '';
    eventTitleInput.value = '';
    eventStartInput.value = formatDateForInput(start);
    eventEndInput.value = formatDateForInput(end);
    deleteBtn.classList.add('hidden');
  }
}

function closeModal() {
  modal.classList.add('hidden');
  eventForm.reset();
}

cancelBtn.addEventListener('click', closeModal);

eventForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = eventIdInput.value;
  const title = eventTitleInput.value;
  const start_at = new Date(eventStartInput.value).toISOString();
  const end_at = new Date(eventEndInput.value).toISOString();

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
      alert(\`Error: \${err.error}\`);
      return;
    }

    closeModal();
    fetchEvents();
  } catch (err) {
    console.error(err);
    alert('Failed to save event');
  }
});

deleteBtn.addEventListener('click', async () => {
  const id = eventIdInput.value;
  if (!id) return;

  if (!confirm('Are you sure you want to delete this event?')) return;

  try {
    const res = await fetch(\`\${API_URL}/\${id}\`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json();
      alert(\`Error: \${err.error}\`);
      return;
    }
    closeModal();
    fetchEvents();
  } catch (err) {
    console.error(err);
    alert('Failed to delete event');
  }
});

document.getElementById('prev-week').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() - 7);
  fetchEvents();
});

document.getElementById('next-week').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() + 7);
  fetchEvents();
});

document.getElementById('today').addEventListener('click', () => {
  currentDate = getMonday(new Date());
  currentDate.setHours(0, 0, 0, 0);
  fetchEvents();
});

initGrid();
fetchEvents();