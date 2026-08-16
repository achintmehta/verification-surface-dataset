const API_BASE = "http://localhost:3000/api";

// Generate a session ID or retrieve from storage
function getSessionId() {
  let sessionId = sessionStorage.getItem("sessionId");
  if (!sessionId) {
    sessionId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    sessionStorage.setItem("sessionId", sessionId);
  }
  return sessionId;
}

const sessionId = getSessionId();

// State
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let timerInterval = null;

// DOM elements
const seatMapEl = document.getElementById("seat-map");
const selectionInfoEl = document.getElementById("selection-info");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdTimerEl = document.getElementById("hold-timer");
const timerValueEl = document.getElementById("timer-value");
const statusMsgEl = document.getElementById("status-msg");
const sseIndicator = document.getElementById("sse-indicator");
const sseText = document.getElementById("sse-text");

// ─── Fetch seats ──────────────────────────────────────────────────
async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seats = data.seats;
    renderSeatMap();
    updateInventory();
  } catch (e) {
    showStatus("Failed to load seats", "error");
  }
}

// ─── Render seat map ──────────────────────────────────────────────
function renderSeatMap() {
  // Group seats by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = "";

  for (const [rowLabel, rowSeats] of Object.entries(rows)) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = `seat ${seat.status}`;
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seat_number;

      // Mark own seats
      if (seat.session_id === sessionId) {
        seatEl.classList.add("mine");
      }

      // Mark selected
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add("selected");
      }

      seatEl.addEventListener("click", () => handleSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    // Add row label on the right too
    const labelRight = document.createElement("span");
    labelRight.className = "row-label";
    labelRight.textContent = rowLabel;
    rowDiv.appendChild(labelRight);

    seatMapEl.appendChild(rowDiv);
  }
}

// ─── Handle seat click ───────────────────────────────────────────
function handleSeatClick(seat) {
  // If we have an active hold, don't allow selecting more seats
  if (currentHold) return;

  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateButtons();
}

// ─── Update button states ─────────────────────────────────────────
function updateButtons() {
  btnHold.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  btnConfirm.disabled = currentHold === null;
  btnRelease.disabled = currentHold === null;

  if (selectedSeatIds.size > 0 && !currentHold) {
    selectionInfoEl.textContent = `${selectedSeatIds.size} seat(s) selected`;
  } else if (currentHold) {
    selectionInfoEl.textContent = `Holding ${currentHold.seatIds.length} seat(s)`;
  } else {
    selectionInfoEl.textContent = "Select seats to hold them.";
  }
}

// ─── Update inventory display ─────────────────────────────────────
function updateInventory() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats) {
    if (seat.status === "available") available++;
    else if (seat.status === "held") held++;
    else if (seat.status === "booked") booked++;
  }
  document.getElementById("inv-available").textContent = available;
  document.getElementById("inv-held").textContent = held;
  document.getElementById("inv-booked").textContent = booked;
  document.getElementById("inv-total").textContent = seats.length;
}

// ─── Show status message ──────────────────────────────────────────
function showStatus(msg, type = "info") {
  statusMsgEl.textContent = msg;
  statusMsgEl.className = `status-msg ${type}`;
  if (type !== "error") {
    setTimeout(() => {
      if (statusMsgEl.textContent === msg) {
        statusMsgEl.textContent = "";
        statusMsgEl.className = "status-msg";
      }
    }, 5000);
  }
}

// ─── Hold seats ──────────────────────────────────────────────────
async function holdSeats() {
  if (selectedSeatIds.size === 0) return;

  const seatIds = [...selectedSeatIds];
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    const data = await res.json();

    if (res.status === 409) {
      // Conflict
      const conflictIds = data.conflicting.map(
        (c) => `${c.row_label}${c.seat_number}`
      );
      showStatus(
        `Seats already taken: ${conflictIds.join(", ")}. Refreshing...`,
        "error"
      );
      selectedSeatIds.clear();
      await fetchSeats();
      updateButtons();
      return;
    }

    if (!res.ok) {
      showStatus(data.error || "Failed to hold seats", "error");
      return;
    }

    currentHold = {
      holdId: data.holdId,
      expiresAt: new Date(data.expiresAt),
      seatIds: seatIds,
    };
    selectedSeatIds.clear();

    showStatus("Seats held! Confirm your booking before the timer runs out.", "success");
    startTimer();
    updateButtons();

    // Update local seat state
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx >= 0) seats[idx] = { ...seats[idx], ...updatedSeat };
    }
    renderSeatMap();
    updateInventory();
  } catch (e) {
    showStatus("Network error while holding seats", "error");
  }
}

// ─── Confirm hold ─────────────────────────────────────────────────
async function confirmHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const data = await res.json();

    if (!res.ok) {
      showStatus(data.error || "Failed to confirm booking", "error");
      stopTimer();
      currentHold = null;
      await fetchSeats();
      updateButtons();
      return;
    }

    stopTimer();
    currentHold = null;
    showStatus("Booking confirmed! 🎉", "success");

    // Update local seat state
    if (data.seats) {
      for (const updatedSeat of data.seats) {
        const idx = seats.findIndex((s) => s.id === updatedSeat.id);
        if (idx >= 0) seats[idx] = { ...seats[idx], ...updatedSeat };
      }
    }
    renderSeatMap();
    updateInventory();
    updateButtons();
  } catch (e) {
    showStatus("Network error while confirming", "error");
  }
}

// ─── Release hold ─────────────────────────────────────────────────
async function releaseHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: "DELETE",
    });

    const data = await res.json();

    stopTimer();
    currentHold = null;
    selectedSeatIds.clear();

    showStatus("Hold released", "info");
    await fetchSeats();
    updateButtons();
  } catch (e) {
    showStatus("Network error while releasing hold", "error");
  }
}

// ─── Timer ────────────────────────────────────────────────────────
function startTimer() {
  holdTimerEl.style.display = "block";
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    updateTimerDisplay();
  }, 250);
}

function stopTimer() {
  holdTimerEl.style.display = "none";
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function updateTimerDisplay() {
  if (!currentHold) {
    stopTimer();
    return;
  }
  const remaining = Math.max(
    0,
    Math.ceil((currentHold.expiresAt.getTime() - Date.now()) / 1000)
  );
  timerValueEl.textContent = remaining;

  if (remaining <= 0) {
    stopTimer();
    currentHold = null;
    selectedSeatIds.clear();
    showStatus("Hold expired! Seats released.", "error");
    fetchSeats();
    updateButtons();
  }
}

// ─── SSE ──────────────────────────────────────────────────────────
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onopen = () => {
    sseIndicator.className = "sse-dot connected";
    sseText.textContent = "Live";
  };

  evtSource.addEventListener("seats-updated", (event) => {
    try {
      const updatedSeats = JSON.parse(event.data);
      for (const updatedSeat of updatedSeats) {
        const idx = seats.findIndex((s) => s.id === updatedSeat.id);
        if (idx >= 0) {
          seats[idx] = { ...seats[idx], ...updatedSeat };
        }
      }
      renderSeatMap();
      updateInventory();

      // If our hold's seats got released by expiry (from server perspective)
      if (currentHold) {
        const holdSeatIds = new Set(currentHold.seatIds);
        const ourSeatsNowAvailable = updatedSeats.some(
          (s) => holdSeatIds.has(s.id) && s.status === "available"
        );
        if (ourSeatsNowAvailable) {
          stopTimer();
          currentHold = null;
          selectedSeatIds.clear();
          showStatus("Hold expired! Seats released.", "error");
          updateButtons();
        }
      }
    } catch (e) {
      console.error("SSE parse error:", e);
    }
  });

  evtSource.onerror = () => {
    sseIndicator.className = "sse-dot disconnected";
    sseText.textContent = "Reconnecting...";
  };
}

// ─── Initialize ───────────────────────────────────────────────────
btnHold.addEventListener("click", holdSeats);
btnConfirm.addEventListener("click", confirmHold);
btnRelease.addEventListener("click", releaseHold);

fetchSeats().then(() => {
  updateButtons();
  connectSSE();
});
