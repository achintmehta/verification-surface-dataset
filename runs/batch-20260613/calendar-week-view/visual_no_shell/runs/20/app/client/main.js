const API_URL = '/api/events';
const PIXELS_PER_MINUTE = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

let currentDate = new Date();
// Normalize to start of week (Monday)
function getStartOfWeek(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // adjust when day is sunday
    return new Date(d.setDate(diff));
}

let currentWeekStart = getStartOfWeek(currentDate);
let events = [];

const daysHeaderEl = document.getElementById('days-header');
const timeAxisEl = document.getElementById('time-axis');
const weekGridEl = document.getElementById('week-grid');
const currentWeekLabel = document.getElementById('current-week-label');

// Modal elements
const modal = document.getElementById('event-modal');
const eventForm = document.getElementById('event-form');
const eventIdInput = document.getElementById('event-id');
const eventTitleInput = document.getElementById('event-title');
const eventStartInput = document.getElementById('event-start');
const eventEndInput = document.getElementById('event-end');
const deleteBtn = document.getElementById('delete-btn');
const cancelBtn = document.getElementById('cancel-btn');
const modalTitle = document.getElementById('modal-title');

function initGrid() {
    timeAxisEl.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;
    weekGridEl.style.height = `${24 * 60 * PIXELS_PER_MINUTE}px`;

    // Render time axis
    for (let i = 0; i <= 24; i++) {
        const label = document.createElement('div');
        label.className = 'time-label';
        label.style.top = `${i * 60 * PIXELS_PER_MINUTE}px`;
        label.textContent = `${i.toString().padStart(2, '0')}:00`;
        timeAxisEl.appendChild(label);
    }
}

function renderHeaders() {
    daysHeaderEl.innerHTML = '';
    const today = new Date();
    today.setHours(0,0,0,0);

    for (let i = 0; i < 7; i++) {
        const d = new Date(currentWeekStart.getTime() + i * DAY_MS);
        const header = document.createElement('div');
        header.className = 'day-header';
        if (d.getTime() === today.getTime()) {
            header.classList.add('today');
        }
        const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
        const dateNum = d.getDate();
        header.textContent = `${dayName} ${dateNum}`;
        daysHeaderEl.appendChild(header);
    }

    const endOfWeek = new Date(currentWeekStart.getTime() + 6 * DAY_MS);
    currentWeekLabel.textContent = `${currentWeekStart.toLocaleDateString()} - ${endOfWeek.toLocaleDateString()}`;
}

function renderGrid() {
    weekGridEl.innerHTML = '';
    for (let i = 0; i < 7; i++) {
        const col = document.createElement('div');
        col.className = 'day-column';
        col.dataset.dayIndex = i;

        // Add hour lines
        for (let h = 0; h <= 24; h++) {
            const line = document.createElement('div');
            line.className = 'hour-line';
            line.style.top = `${h * 60 * PIXELS_PER_MINUTE}px`;
            col.appendChild(line);
        }

        // Click to create event
        col.addEventListener('mousedown', (e) => {
            if (e.target !== col && !e.target.classList.contains('hour-line')) return;
            const rect = col.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const minutes = Math.floor(y / PIXELS_PER_MINUTE);
            
            const startD = new Date(currentWeekStart.getTime() + i * DAY_MS);
            startD.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
            
            const endD = new Date(startD.getTime() + 60 * 60 * 1000); // default 1 hour

            openModal({ start_at: startD.toISOString(), end_at: endD.toISOString() });
        });

        weekGridEl.appendChild(col);
    }
}

function toLocalISOString(date) {
    const tzOffset = date.getTimezoneOffset() * 60000; // offset in milliseconds
    const localISOTime = (new Date(date.getTime() - tzOffset)).toISOString().slice(0, 16);
    return localISOTime;
}

function openModal(event = null) {
    modal.classList.remove('hidden');
    if (event && event.id) {
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
        if (event && event.start_at) {
            eventStartInput.value = toLocalISOString(new Date(event.start_at));
            eventEndInput.value = toLocalISOString(new Date(event.end_at));
        } else {
            const now = new Date();
            now.setMinutes(0, 0, 0);
            eventStartInput.value = toLocalISOString(now);
            const end = new Date(now.getTime() + 60 * 60 * 1000);
            eventEndInput.value = toLocalISOString(end);
        }
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
            alert(err.error || 'Error saving event');
            return;
        }

        closeModal();
        fetchEvents();
    } catch (err) {
        alert('Network error');
    }
});

deleteBtn.addEventListener('click', async () => {
    const id = eventIdInput.value;
    if (!id) return;
    if (!confirm('Delete this event?')) return;

    try {
        const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
        if (!res.ok) {
            const err = await res.json();
            alert(err.error || 'Error deleting event');
            return;
        }
        closeModal();
        fetchEvents();
    } catch (err) {
        alert('Network error');
    }
});

async function fetchEvents() {
    const endOfWeek = new Date(currentWeekStart.getTime() + 7 * DAY_MS);
    try {
        const res = await fetch(`${API_URL}?start=${currentWeekStart.toISOString()}&end=${endOfWeek.toISOString()}`);
        if (res.ok) {
            events = await res.json();
            renderEvents();
        }
    } catch (err) {
        console.error('Failed to fetch events', err);
    }
}

function renderEvents() {
    // Clear existing events
    document.querySelectorAll('.event-block').forEach(el => el.remove());

    // Group events by day
    const days = Array.from({ length: 7 }, () => []);

    events.forEach(ev => {
        const start = new Date(ev.start_at);
        const end = new Date(ev.end_at);
        
        // Find which days this event spans
        for (let i = 0; i < 7; i++) {
            const dayStart = new Date(currentWeekStart.getTime() + i * DAY_MS);
            const dayEnd = new Date(dayStart.getTime() + DAY_MS);

            if (start < dayEnd && end > dayStart) {
                days[i].push({ ...ev, start, end, dayStart, dayEnd });
            }
        }
    });

    days.forEach((dayEvents, dayIndex) => {
        if (dayEvents.length === 0) return;

        // Sort by start time, then end time
        dayEvents.sort((a, b) => {
            if (a.start.getTime() !== b.start.getTime()) {
                return a.start.getTime() - b.start.getTime();
            }
            return b.end.getTime() - a.end.getTime();
        });

        // Cluster overlapping events
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

        const colEl = weekGridEl.children[dayIndex];

        clusters.forEach(cluster => {
            // Assign columns within cluster
            const columns = [];
            cluster.forEach(ev => {
                let placed = false;
                for (let i = 0; i < columns.length; i++) {
                    const col = columns[i];
                    const lastEv = col[col.length - 1];
                    if (lastEv.end <= ev.start) {
                        col.push(ev);
                        ev.colIdx = i;
                        placed = true;
                        break;
                    }
                }
                if (!placed) {
                    columns.push([ev]);
                    ev.colIdx = columns.length - 1;
                }
            });

            const numCols = columns.length;

            cluster.forEach(ev => {
                // Calculate top and height
                // Clamp to day boundaries
                const renderStart = new Date(Math.max(ev.start.getTime(), ev.dayStart.getTime()));
                const renderEnd = new Date(Math.min(ev.end.getTime(), ev.dayEnd.getTime()));

                const startMinutes = (renderStart.getTime() - ev.dayStart.getTime()) / 60000;
                const endMinutes = (renderEnd.getTime() - ev.dayStart.getTime()) / 60000;

                const top = startMinutes * PIXELS_PER_MINUTE;
                const height = (endMinutes - startMinutes) * PIXELS_PER_MINUTE;

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
                const formatTime = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                timeEl.textContent = `${formatTime(ev.start)} - ${formatTime(ev.end)}`;

                block.appendChild(titleEl);
                block.appendChild(timeEl);

                block.addEventListener('click', (e) => {
                    e.stopPropagation();
                    openModal(ev);
                });

                colEl.appendChild(block);
            });
        });
    });
}

document.getElementById('prev-week').addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart.getTime() - 7 * DAY_MS);
    renderHeaders();
    fetchEvents();
});

document.getElementById('next-week').addEventListener('click', () => {
    currentWeekStart = new Date(currentWeekStart.getTime() + 7 * DAY_MS);
    renderHeaders();
    fetchEvents();
});

document.getElementById('today').addEventListener('click', () => {
    currentWeekStart = getStartOfWeek(new Date());
    renderHeaders();
    fetchEvents();
});

initGrid();
renderHeaders();
renderGrid();
fetchEvents();
