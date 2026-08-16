const ROW_HEIGHT = 36;
const PAGE_SIZE = 100;
const API_URL = 'http://localhost:3001/api';

let totalRows = 0;
let currentSeverity = '';
let currentSearch = '';
let rowCache = new Map();
let inFlightRequests = new Map();
let abortController = new AbortController();

const container = document.getElementById('table-container');
const scroller = document.getElementById('virtual-scroller');
const statsDisplay = document.getElementById('stats-display');
const badgesDisplay = document.getElementById('badges-display');
const severityFilter = document.getElementById('severity-filter');
const searchInput = document.getElementById('search-input');

let absoluteTotal = 0;

async function fetchStats() {
    try {
        const res = await fetch(`${API_URL}/stats`);
        const data = await res.json();
        absoluteTotal = data.total;
        
        badgesDisplay.innerHTML = '';
        const severities = ['debug', 'info', 'warn', 'error'];
        severities.forEach(sev => {
            if (data.counts[sev]) {
                const badge = document.createElement('div');
                badge.className = `badge ${sev}`;
                badge.textContent = `${sev}: ${data.counts[sev]}`;
                badgesDisplay.appendChild(badge);
            }
        });
        updateStatsDisplay();
    } catch (err) {
        console.error('Failed to fetch stats', err);
    }
}

async function fetchLogs(offset, limit, severity, q, signal) {
    const params = new URLSearchParams({ offset, limit });
    if (severity) params.append('severity', severity);
    if (q) params.append('q', q);
    
    const res = await fetch(`${API_URL}/logs?${params.toString()}`, { signal });
    if (!res.ok) throw new Error('Network response was not ok');
    return res.json();
}

function updateStatsDisplay() {
    if (absoluteTotal > 0) {
        statsDisplay.textContent = `${totalRows} of ${absoluteTotal} rows`;
    } else {
        statsDisplay.textContent = `${totalRows} rows`;
    }
}

async function loadPage(pageIndex) {
    if (rowCache.has(pageIndex) || inFlightRequests.has(pageIndex)) {
        return;
    }
    
    const offset = pageIndex * PAGE_SIZE;
    const promise = fetchLogs(offset, PAGE_SIZE, currentSeverity, currentSearch, abortController.signal)
        .then(data => {
            totalRows = data.total;
            scroller.style.height = `${totalRows * ROW_HEIGHT}px`;
            updateStatsDisplay();
            
            const rows = data.rows;
            rowCache.set(pageIndex, rows);
            inFlightRequests.delete(pageIndex);
            renderVisibleRows();
        })
        .catch(err => {
            if (err.name !== 'AbortError') {
                console.error('Failed to fetch page', pageIndex, err);
            }
            inFlightRequests.delete(pageIndex);
        });
        
    inFlightRequests.set(pageIndex, promise);
}

function renderVisibleRows() {
    const scrollTop = container.scrollTop;
    const clientHeight = container.clientHeight;
    
    const startIndex = Math.floor(scrollTop / ROW_HEIGHT);
    const endIndex = Math.min(totalRows - 1, Math.floor((scrollTop + clientHeight) / ROW_HEIGHT));
    
    // Overscan
    const overscan = 10;
    const renderStart = Math.max(0, startIndex - overscan);
    const renderEnd = Math.min(totalRows - 1, endIndex + overscan);
    
    const startPage = Math.floor(renderStart / PAGE_SIZE);
    const endPage = Math.floor(renderEnd / PAGE_SIZE);
    
    for (let p = startPage; p <= endPage; p++) {
        loadPage(p);
    }
    
    // Update DOM
    const existingRows = Array.from(scroller.children);
    const existingRowIndices = new Set(existingRows.map(r => parseInt(r.dataset.index, 10)));
    const neededRowIndices = new Set();
    
    for (let i = renderStart; i <= renderEnd; i++) {
        neededRowIndices.add(i);
    }
    
    // Remove rows no longer needed
    existingRows.forEach(row => {
        const idx = parseInt(row.dataset.index, 10);
        if (!neededRowIndices.has(idx)) {
            scroller.removeChild(row);
        }
    });
    
    // Add new rows
    for (let i = renderStart; i <= renderEnd; i++) {
        if (!existingRowIndices.has(i)) {
            const pageIndex = Math.floor(i / PAGE_SIZE);
            const pageData = rowCache.get(pageIndex);
            
            const row = document.createElement('div');
            row.className = 'table-row';
            row.style.top = `${i * ROW_HEIGHT}px`;
            row.style.height = `${ROW_HEIGHT}px`;
            row.dataset.index = i;
            
            if (pageData) {
                const rowData = pageData[i % PAGE_SIZE];
                if (rowData) {
                    row.innerHTML = `
                        <div class="cell ts">${new Date(rowData.ts).toLocaleString()}</div>
                        <div class="cell severity severity-text ${rowData.severity}">${rowData.severity}</div>
                        <div class="cell service">${rowData.service}</div>
                        <div class="cell message" title="${rowData.message.replace(/"/g, '&quot;')}">${rowData.message}</div>
                    `;
                } else {
                    row.innerHTML = `<div class="cell">Loading...</div>`;
                }
            } else {
                row.innerHTML = `<div class="cell">Loading...</div>`;
            }
            
            scroller.appendChild(row);
        } else {
            // Update loading rows if data is now available
            const row = scroller.querySelector(`[data-index="${i}"]`);
            if (row && row.textContent === 'Loading...') {
                const pageIndex = Math.floor(i / PAGE_SIZE);
                const pageData = rowCache.get(pageIndex);
                if (pageData) {
                    const rowData = pageData[i % PAGE_SIZE];
                    if (rowData) {
                        row.innerHTML = `
                            <div class="cell ts">${new Date(rowData.ts).toLocaleString()}</div>
                            <div class="cell severity severity-text ${rowData.severity}">${rowData.severity}</div>
                            <div class="cell service">${rowData.service}</div>
                            <div class="cell message" title="${rowData.message.replace(/"/g, '&quot;')}">${rowData.message}</div>
                        `;
                    }
                }
            }
        }
    }
}

container.addEventListener('scroll', () => {
    requestAnimationFrame(renderVisibleRows);
});

let searchTimeout;

function resetAndFetch() {
    abortController.abort();
    abortController = new AbortController();
    
    rowCache.clear();
    inFlightRequests.clear();
    scroller.innerHTML = '';
    container.scrollTop = 0;
    totalRows = 0;
    scroller.style.height = '0px';
    
    // Fetch first page to get total
    loadPage(0);
}

severityFilter.addEventListener('change', (e) => {
    currentSeverity = e.target.value;
    resetAndFetch();
});

searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
        currentSearch = e.target.value;
        resetAndFetch();
    }, 300);
});

// Initial load
fetchStats();
resetAndFetch();
