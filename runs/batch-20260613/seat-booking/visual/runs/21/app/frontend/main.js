// Generate or retrieve session ID
function getSessionId() {
  let sid = sessionStorage.getItem("sessionId");
  if (!sid) {
    sid = crypto.randomUUID();
    sessionStorage.setItem("sessionId", sid);
  }
  return sid;
}

const SESSION_ID = getSessionId();

// State
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, seatIds, expiresAt }
let timerInterval = null;

// DOM refs
const seatMapEl = document.getElementById("seat-map");
const inventoryEl = document.getElementById("inventory");
const selectionInfoEl = document.getElementById("selection-info");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdTimerEl = document.getElementById("hold-timer");
const errorMessageEl = document.getElementById("error-message");
const sseStatusEl = document.getElementById("sse-status");

// ==================== API ====================
const API_BASE = "/api";

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  return data.seats;
}

async function requestHold(seatIds) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Hold failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function confirmHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Confirm failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function releaseHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: "DELETE",
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Release failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

// ==================== RENDERING ====================
function renderSeatMap() {
  // Group seats by row
  const rowMap = new Map();
  for (const seat of seats) {
    if (!rowMap.has(seat.row_label)) {
      rowMap.set(seat.row_label, []);
    }
    rowMap.get(seat.row_label).push(seat);
  }

  seatMapEl.innerHTML = "";

  for (const [rowLabel, rowSeats] of rowMap) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const labelEl = document.createElement("span");
    labelEl.className = "row-label";
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("button");
      seatEl.dataset.seatId = seat.id;

      // Determine visual class
      let cls = "seat ";
      if (selectedSeatIds.has(seat.id)) {
        cls += "selected";
      } else if (seat.status === "booked") {
        cls += "booked";
      } else if (seat.status === "held") {
        if (seat.session_id === SESSION_ID) {
          cls += "held-mine";
        } else {
          cls += "held";
        }
      } else {
        cls += "available";
      }

      seatEl.className = cls;
      seatEl.textContent = seat.seat_number;
      seatEl.title = `${rowLabel}${seat.seat_number} - ${seat.status}`;

      seatEl.addEventListener("click", () => onSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    // Right label
    const labelElR = document.createElement("span");
    labelElR.className = "row-label";
    labelElR.textContent = rowLabel;
    rowEl.appendChild(labelElR);

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
  updateActionButtons();
}

function updateInventory() {
  const available = seats.filter((s) => s.status === "available").length;
  const held = seats.filter((s) => s.status === "held").length;
  const booked = seats.filter((s) => s.status === "booked").length;
  inventoryEl.textContent = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${seats.length}`;
}

function updateActionButtons() {
  if (currentHold) {
    btnHold.style.display = "none";
    btnConfirm.style.display = "";
    btnRelease.style.display = "";
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
    selectionInfoEl.textContent = `Holding ${currentHold.seatIds.length} seat(s)`;
  } else {
    btnHold.style.display = "";
    btnConfirm.style.display = "none";
    btnRelease.style.display = "none";
    btnHold.disabled = selectedSeatIds.size === 0;
    selectionInfoEl.textContent =
      selectedSeatIds.size > 0
        ? `${selectedSeatIds.size} seat(s) selected`
        : "Select seats to hold them";
  }
}

function showError(msg) {
  errorMessageEl.textContent = msg;
  errorMessageEl.style.display = "block";
  setTimeout(() => {
    errorMessageEl.style.display = "none";
  }, 5000);
}

function hideError() {
  errorMessageEl.style.display = "none";
}

function flashConflictSeats(conflictIds) {
  for (const id of conflictIds) {
    const el = seatMapEl.querySelector(`[data-seat-id="${id}"]`);
    if (el) {
      el.classList.add("conflict");
      setTimeout(() => el.classList.remove("conflict"), 1500);
    }
  }
}

// ==================== HOLD TIMER ====================
function startHoldTimer() {
  if (!currentHold) return;
  holdTimerEl.style.display = "block";
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 250);
}

function updateTimerDisplay() {
  if (!currentHold) {
    stopHoldTimer();
    return;
  }
  const remaining = Math.max(0, new Date(currentHold.expiresAt) - Date.now());
  const seconds = Math.ceil(remaining / 1000);
  holdTimerEl.textContent = `⏱ Hold expires in ${seconds}s`;

  if (remaining <= 0) {
    holdTimerEl.textContent = "⏱ Hold expired!";
    stopHoldTimer();
    // Clear current hold state
    currentHold = null;
    selectedSeatIds.clear();
    renderSeatMap();
    // Refresh seats from server
    loadSeats();
  }
}

function stopHoldTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  holdTimerEl.style.display = "none";
}

// ==================== EVENT HANDLERS ====================
function onSeatClick(seat) {
  // If we have an active hold, don't allow selection changes
  if (currentHold) return;

  // Only available seats can be selected
  if (seat.status !== "available") return;

  hideError();

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
}

btnHold.addEventListener("click", async () => {
  if (selectedSeatIds.size === 0) return;
  hideError();
  btnHold.disabled = true;

  try {
    const result = await requestHold([...selectedSeatIds]);
    currentHold = {
      holdId: result.holdId,
      seatIds: result.seatIds,
      expiresAt: result.expiresAt,
    };
    selectedSeatIds.clear();

    // Update local seat state
    for (const updatedSeat of result.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx >= 0) seats[idx] = updatedSeat;
    }

    renderSeatMap();
    startHoldTimer();
  } catch (err) {
    if (err.status === 409 && err.data?.conflictingSeatIds) {
      showError(`Some seats are no longer available!`);
      flashConflictSeats(err.data.conflictingSeatIds);
      // Remove conflicting seats from selection
      for (const id of err.data.conflictingSeatIds) {
        selectedSeatIds.delete(id);
      }
      // Refresh seats
      await loadSeats();
    } else {
      showError(err.message);
    }
    btnHold.disabled = selectedSeatIds.size === 0;
  }
});

btnConfirm.addEventListener("click", async () => {
  if (!currentHold) return;
  hideError();
  btnConfirm.disabled = true;

  try {
    const result = await confirmHold(currentHold.holdId);
    stopHoldTimer();

    // Update local seat state
    for (const updatedSeat of result.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx >= 0) seats[idx] = updatedSeat;
    }

    currentHold = null;
    selectedSeatIds.clear();
    renderSeatMap();
  } catch (err) {
    showError(err.message);
    if (err.status === 410) {
      // Hold expired
      stopHoldTimer();
      currentHold = null;
      selectedSeatIds.clear();
      await loadSeats();
    }
    btnConfirm.disabled = false;
  }
});

btnRelease.addEventListener("click", async () => {
  if (!currentHold) return;
  hideError();
  btnRelease.disabled = true;

  try {
    await releaseHold(currentHold.holdId);
    stopHoldTimer();

    // Update seats to available
    for (const seatId of currentHold.seatIds) {
      const idx = seats.findIndex((s) => s.id === seatId);
      if (idx >= 0) {
        seats[idx] = { ...seats[idx], status: "available", hold_id: null, hold_expires_at: null, session_id: null };
      }
    }

    currentHold = null;
    selectedSeatIds.clear();
    renderSeatMap();
  } catch (err) {
    showError(err.message);
    btnRelease.disabled = false;
  }
});

// ==================== SSE ====================
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener("connected", () => {
    sseStatusEl.textContent = "🟢 Live updates connected";
    sseStatusEl.className = "connected";
  });

  evtSource.addEventListener("seatUpdate", (event) => {
    try {
      const updatedSeats = JSON.parse(event.data);
      for (const updated of updatedSeats) {
        const idx = seats.findIndex((s) => s.id === updated.id);
        if (idx >= 0) {
          seats[idx] = updated;
        }
      }

      // If our hold's seats were released (expired), clear the hold
      if (currentHold) {
        const holdSeatIds = new Set(currentHold.seatIds);
        const anyReleased = updatedSeats.some(
          (s) => holdSeatIds.has(s.id) && s.status === "available"
        );
        if (anyReleased) {
          // Check if it's truly our hold that was released
          const ourSeatsReleased = updatedSeats.filter(
            (s) => holdSeatIds.has(s.id) && s.status === "available" && s.session_id !== SESSION_ID
          );
          if (ourSeatsReleased.length > 0 || updatedSeats.some(s => holdSeatIds.has(s.id) && s.status === "available" && !s.hold_id)) {
            stopHoldTimer();
            currentHold = null;
            selectedSeatIds.clear();
          }
        }
      }

      renderSeatMap();
    } catch (e) {
      console.error("SSE parse error:", e);
    }
  });

  evtSource.onerror = () => {
    sseStatusEl.textContent = "🔴 Connection lost, reconnecting...";
    sseStatusEl.className = "disconnected";
  };

  return evtSource;
}

// ==================== INIT ====================
async function loadSeats() {
  try {
    seats = await fetchSeats();
    renderSeatMap();
  } catch (err) {
    showError("Failed to load seats: " + err.message);
  }
}

async function init() {
  await loadSeats();
  connectSSE();
}

init();
