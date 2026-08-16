const API_BASE = 'http://localhost:3001/api';

const ROW_HEIGHT = 40;
const OVERSCAN = 20;
const LIMIT = 100;

let totalRows = -1;
let currentSeverity = '';
let currentQuery = '';
let abortController = null;

const viewport = document.getElementById('viewport');
const spacer = document.getElementById('spacer');
const rowsContainer = document.getElementById('rows-container');
const statsEl = document.getElementById('stats');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

let rowCache = new Map();
let isFetching = false;
let lastRenderStart = -1;
let lastRenderEnd = -1;

let absoluteTotal = 0;

async function fetchStats() {
    try {
        const res = await fetch(`${API_BASE}/stats`);
        const data = await res.json();
        absoluteTotal = data.total;
        updateStatsDisplay();
    } catch (err) {
        console.error('Failed to fetch stats', err);
    }
}

function updateStatsDisplay() {
    if (totalRows === -1) {
        statsEl.textContent = 'Loading...';
        return;
    }
    if (absoluteTotal > 0) {
        statsEl.textContent = `${totalRows} of ${absoluteTotal}`;
    } else {
        statsEl.textContent = `${totalRows} rows found`;
    }
}

async function fetchLogs(offset, limit) {
    if (abortController) {
        abortController.abort();
    }
    abortController = new AbortController();

    const params = new URLSearchParams({
        offset,
        limit
    });
    if (currentSeverity) params.set('severity', currentSeverity);
    if (currentQuery) params.set('q', currentQuery);

    try {
        const res = await fetch(`${API_BASE}/logs?${params.toString()}`, {
            signal: abortController.signal
        });
        if (!res.ok) throw new Error('Network response was not ok');
        const data = await res.json();
        return data;
    } catch (err) {
        if (err.name === 'AbortError') {
            return null;
        }
        console.error('Failed to fetch logs', err);
        return null;
    }
}

function renderRow(row) {
    const div = document.createElement('div');
    div.className = 'log-row';
    
    const ts = document.createElement('div');
    ts.className = 'col-ts';
    ts.textContent = new Date(row.ts).toLocaleString();
    
    const sev = document.createElement('div');
    sev.className = `col-sev sev-${row.severity}`;
    sev.textContent = row.severity.toUpperCase();
    
    const svc = document.createElement('div');
    svc.className = 'col-svc';
    svc.textContent = row.service;
    
    const msg = document.createElement('div');
    msg.className = 'col-msg';
    msg.textContent = row.message;
    msg.title = row.message;
    
    div.appendChild(ts);
    div.appendChild(sev);
    div.appendChild(svc);
    div.appendChild(msg);
    
    return div;
}

async function updateView() {
    const scrollTop = viewport.scrollTop;
    const viewportHeight = viewport.clientHeight || 800;
    
    const startIdx = Math.floor(scrollTop / ROW_HEIGHT);
    const endIdx = Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT);
    
    const renderStart = Math.max(0, startIdx - OVERSCAN);
    // If totalRows is -1 (initial load), we don't know the end yet, so we guess a small number
    const renderEnd = totalRows >= 0 ? Math.min(totalRows, endIdx + OVERSCAN) : endIdx + OVERSCAN;
    
    let missing = false;
    for (let i = renderStart; i < renderEnd; i++) {
        if (!rowCache.has(i)) {
            missing = true;
            break;
        }
    }
    
    if (missing) {
        // Render placeholders immediately
        renderVisibleRows(renderStart, renderEnd);

        // Fetch a block of rows
        const fetchOffset = Math.max(0, startIdx - OVERSCAN);
        const fetchLimit = Math.min(200, (endIdx - startIdx) + OVERSCAN * 2);
        
        const data = await fetchLogs(fetchOffset, fetchLimit);
        if (data) {
            totalRows = data.total;
            spacer.style.height = `${totalRows * ROW_HEIGHT}px`;
            updateStatsDisplay();
            
            data.rows.forEach((row, idx) => {
                rowCache.set(fetchOffset + idx, row);
            });
            
            renderVisibleRows(renderStart, Math.min(totalRows, renderEnd));
        }
    } else {
        renderVisibleRows(renderStart, renderEnd);
    }
}

function renderVisibleRows(start, end) {
    if (start === lastRenderStart && end === lastRenderEnd && rowsContainer.children.length > 0) {
        // Check if any previously missing rows are now in cache
        let allPresent = true;
        for (let i = start; i < end; i++) {
            if (!rowCache.has(i)) {
                allPresent = false;
                break;
            }
        }
        // If we still have missing rows, or we already rendered them, we might need to re-render
        // Actually, just re-render to be safe and simple
    }

    rowsContainer.innerHTML = '';
    rowsContainer.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
    
    for (let i = start; i < end; i++) {
        const row = rowCache.get(i);
        if (row) {
            rowsContainer.appendChild(renderRow(row));
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'log-row';
            placeholder.textContent = 'Loading...';
            rowsContainer.appendChild(placeholder);
        }
    }
    
    lastRenderStart = start;
    lastRenderEnd = end;
}

let debounceTimer;

let ignoreScroll = false;

function handleFilterChange() {
    currentSeverity = severityFilter.value;
    currentQuery = searchInput.value.trim();
    
    rowCache.clear();
    if (viewport.scrollTop !== 0) {
        ignoreScroll = true;
        viewport.scrollTop = 0;
    }
    totalRows = -1;
    spacer.style.height = '0px';
    rowsContainer.innerHTML = '';
    lastRenderStart = -1;
    lastRenderEnd = -1;
    updateStatsDisplay();
    
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        updateView();
    }, 300);
}

severityFilter.addEventListener('change', handleFilterChange);
searchInput.addEventListener('input', handleFilterChange);

let scrollTicking = false;
viewport.addEventListener('scroll', () => {
    if (ignoreScroll) {
        ignoreScroll = false;
        return;
    }
    if (!scrollTicking) {
        window.requestAnimationFrame(() => {
            updateView();
            scrollTicking = false;
        });
        scrollTicking = true;
    }
});

// Initial load
fetchStats();
handleFilterChange();
