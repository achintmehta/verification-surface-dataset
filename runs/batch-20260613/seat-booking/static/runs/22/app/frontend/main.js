// @ts-nocheck
// When running behind Vite dev proxy, use empty base (relative).
// When running standalone against the backend, use the backend origin.
const API_BASE = window.location.port === "5173" ? "" : "http://localhost:3000";

// --- State ---
/** @type {Map<number, object>} */
const seatMap = new Map();  // id -> seat data
/** @type {Set<number>} */
const selectedSeatIds = new Set();
let sessionId = getOrCreateSessionId();
let currentHold = null; // { holdId, expiresAt, seatIds }
let countdownInterval = null;

// --- DOM refs ---
const seatMapEl = document.getElementById("seat-map");
const selectedCountEl = document.getElementById("selected-count");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdTimerEl = document.getElementById("hold-timer");
const timerValueEl = document.getElementById("timer-value");
const statusBar = document.getElementById("status-bar");
const invAvailable = document.getElementById("inv-available");
const invHeld = document.getElementById("inv-held");
const invBooked = document.getElementById("inv-booked");
const invTotal = document.getElementById("inv-total");

// --- Session ID ---
function getOrCreateSessionId() {
  let id = localStorage.getItem("seatBookingSessionId");
  if (!id) {
    id = "sess-" + Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
    localStorage.setItem("seatBookingSessionId", id);
  }
  return id;
}

// --- Status messages ---
function showStatus(msg, type = "info") {
  statusBar.textContent = msg;
  statusBar.className = type;
  if (type !== "error") {
    setTimeout(() => {
      if (statusBar.textContent === msg) {
        statusBar.textContent = "";
        statusBar.className = "";
      }
    }, 5000);
  }
}

// --- Fetch seats ---
async function fetchSeats() {
  try {
    const resp = await fetch(`${API_BASE}/api/seats`);
    const data = await resp.json();
    seatMap.clear();
    for (const seat of data.seats) {
      seatMap.set(seat.id, seat);
    }
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showStatus("Failed to load seats", "error");
    console.error(err);
  }
}

// --- Render ---
function renderSeatMap() {
  // Group seats by row
  const rows = new Map();
  for (const seat of seatMap.values()) {
    if (!rows.has(seat.row_label)) {
      rows.set(seat.row_label, []);
    }
    rows.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically, seats by number
  const sortedRows = [...rows.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  seatMapEl.innerHTML = "";
  for (const [rowLabel, seats] of sortedRows) {
    seats.sort((a, b) => a.seat_number - b.seat_number);
    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of seats) {
      const seatEl = document.createElement("div");
      seatEl.className = "seat " + getSeatClass(seat);
      seatEl.textContent = String(seat.seat_number);
      seatEl.dataset.seatId = String(seat.id);
      seatEl.addEventListener("click", () => onSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowDiv);
  }
}

function getSeatClass(seat) {
  // If seat is selected by current user
  if (selectedSeatIds.has(seat.id)) {
    return "selected";
  }

  if (seat.status === "booked") {
    if (seat.session_id === sessionId) {
      return "booked-mine";
    }
    return "booked";
  }

  if (seat.status === "held") {
    if (seat.session_id === sessionId || (currentHold && currentHold.seatIds.includes(seat.id))) {
      return "held-mine";
    }
    return "held";
  }

  return "available";
}

function onSeatClick(seat) {
  // Can only select available seats when there's no active hold
  if (currentHold) return;

  if (seat.status !== "available") return;

  // If it's held/booked by someone else, ignore
  if (seat.session_id && seat.session_id !== sessionId && seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateButtonStates();
}

function updateButtonStates() {
  const hasSelection = selectedSeatIds.size > 0;
  const hasHold = currentHold !== null;

  btnHold.disabled = !hasSelection || hasHold;
  btnHold.style.display = hasHold ? "none" : "";
  btnConfirm.style.display = hasHold ? "" : "none";
  btnConfirm.disabled = !hasHold;
  btnRelease.style.display = hasHold ? "" : "none";
  btnRelease.disabled = !hasHold;

  selectedCountEl.textContent = hasHold
    ? `${currentHold.seatIds.length} seats held`
    : `${selectedSeatIds.size} seat${selectedSeatIds.size !== 1 ? "s" : ""} selected`;
}

function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seatMap.values()) {
    if (seat.status === "available") available++;
    else if (seat.status === "held") held++;
    else if (seat.status === "booked") booked++;
  }
  invAvailable.textContent = String(available);
  invHeld.textContent = String(held);
  invBooked.textContent = String(booked);
  invTotal.textContent = String(seatMap.size);
}

// --- Hold ---
async function requestHold() {
  if (selectedSeatIds.size === 0) return;

  const seatIds = [...selectedSeatIds];
  btnHold.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/api/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    if (resp.status === 409) {
      const data = await resp.json();
      showStatus(`Seats unavailable: ${data.conflicting.map(s => `${s.row_label}${s.seat_number}`).join(", ")}`, "error");
      // Clear selection and refresh
      selectedSeatIds.clear();
      await fetchSeats();
      updateButtonStates();
      return;
    }

    if (!resp.ok) {
      const data = await resp.json();
      showStatus(data.error || "Failed to hold seats", "error");
      btnHold.disabled = false;
      return;
    }

    const data = await resp.json();
    currentHold = {
      holdId: data.holdId,
      expiresAt: new Date(data.expiresAt),
      seatIds: seatIds,
    };

    // Update local seat data
    for (const seat of data.seats) {
      seatMap.set(seat.id, seat);
    }

    selectedSeatIds.clear();
    showStatus("Seats held! Confirm your booking before the timer expires.", "success");
    renderSeatMap();
    updateButtonStates();
    updateInventory();
    startCountdown();
  } catch (err) {
    showStatus("Network error placing hold", "error");
    console.error(err);
    btnHold.disabled = false;
  }
}

// --- Confirm ---
async function confirmHold() {
  if (!currentHold) return;
  btnConfirm.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/api/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
    });

    if (!resp.ok) {
      const data = await resp.json();
      showStatus(data.error || "Failed to confirm booking", "error");
      clearHoldState();
      await fetchSeats();
      return;
    }

    const data = await resp.json();
    // Update local seat data
    for (const seat of data.seats) {
      seatMap.set(seat.id, seat);
    }

    showStatus("Booking confirmed! 🎉", "success");
    clearHoldState();
    renderSeatMap();
    updateButtonStates();
    updateInventory();
  } catch (err) {
    showStatus("Network error confirming booking", "error");
    console.error(err);
    btnConfirm.disabled = false;
  }
}

// --- Release ---
async function releaseHold() {
  if (!currentHold) return;
  btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/api/holds/${currentHold.holdId}`, {
      method: "DELETE",
    });

    if (!resp.ok) {
      const data = await resp.json();
      showStatus(data.error || "Failed to release hold", "error");
    } else {
      showStatus("Hold released.", "info");
    }

    clearHoldState();
    await fetchSeats();
    updateButtonStates();
  } catch (err) {
    showStatus("Network error releasing hold", "error");
    console.error(err);
    btnRelease.disabled = false;
  }
}

function clearHoldState() {
  currentHold = null;
  selectedSeatIds.clear();
  stopCountdown();
}

// --- Countdown ---
function startCountdown() {
  stopCountdown();
  holdTimerEl.style.display = "";
  updateTimerDisplay();
  countdownInterval = setInterval(() => {
    const remaining = updateTimerDisplay();
    if (remaining <= 0) {
      stopCountdown();
      showStatus("Your hold has expired. Seats have been released.", "error");
      clearHoldState();
      fetchSeats();
      updateButtonStates();
    }
  }, 500);
}

function updateTimerDisplay() {
  if (!currentHold) {
    timerValueEl.textContent = "--";
    return 0;
  }
  const remaining = Math.max(0, Math.ceil((currentHold.expiresAt.getTime() - Date.now()) / 1000));
  timerValueEl.textContent = String(remaining);
  return remaining;
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  holdTimerEl.style.display = "none";
}

// --- SSE ---
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/api/stream`);

  evtSource.addEventListener("seats-updated", (event) => {
    try {
      const data = JSON.parse(event.data);
      handleSeatUpdate(data);
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  });

  evtSource.onerror = () => {
    console.warn("SSE connection lost, reconnecting...");
    // EventSource will auto-reconnect
  };
}

function handleSeatUpdate(data) {
  if (!data.seats || !Array.isArray(data.seats)) return;

  for (const updatedSeat of data.seats) {
    const existing = seatMap.get(updatedSeat.id);
    if (existing) {
      // Merge updates
      Object.assign(existing, updatedSeat);
    }
  }

  // If our hold expired via server notification
  if (data.type === "expired" && currentHold) {
    const holdSeatIds = new Set(currentHold.seatIds);
    const expired = data.seats.some(s => holdSeatIds.has(s.id));
    if (expired) {
      showStatus("Your hold has expired. Seats have been released.", "error");
      clearHoldState();
      updateButtonStates();
    }
  }

  renderSeatMap();
  updateInventory();
}

// --- Event listeners ---
btnHold.addEventListener("click", requestHold);
btnConfirm.addEventListener("click", confirmHold);
btnRelease.addEventListener("click", releaseHold);

// --- Init ---
fetchSeats().then(() => {
  connectSSE();
});
