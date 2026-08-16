const API_BASE = "/api";

// Generate a session id
const SESSION_ID = crypto.randomUUID();

// State
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, seatIds, expiresAt }
let timerInterval = null;

// DOM elements
const seatMapEl = document.getElementById("seat-map");
const selectionInfoEl = document.getElementById("selection-info");
const holdInfoEl = document.getElementById("hold-info");
const holdTimerEl = document.getElementById("hold-timer");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const errorMsgEl = document.getElementById("error-msg");

// ---------------------------------------------------------------------------
// Fetch seats
// ---------------------------------------------------------------------------
async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  seats = await res.json();
  renderSeatMap();
  updateInventory();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function renderSeatMap() {
  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = "";
  for (const [label, rowSeats] of Object.entries(rows)) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);
    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const labelEl = document.createElement("span");
    labelEl.className = "row-label";
    labelEl.textContent = label;
    rowDiv.appendChild(labelEl);

    for (const seat of rowSeats) {
      const el = document.createElement("div");
      el.className = "seat " + getSeatClass(seat);
      el.textContent = seat.seat_number;
      el.dataset.seatId = seat.id;
      el.addEventListener("click", () => handleSeatClick(seat));
      rowDiv.appendChild(el);
    }
    seatMapEl.appendChild(rowDiv);
  }
}

function getSeatClass(seat) {
  if (selectedSeatIds.has(seat.id)) return "selected";
  if (seat.status === "booked") return "booked";
  if (seat.status === "held") {
    if (currentHold && currentHold.seatIds.includes(seat.id)) return "held-mine";
    if (seat.hold_session_id === SESSION_ID) return "held-mine";
    return "held";
  }
  return "available";
}

function updateInventory() {
  const available = seats.filter((s) => s.status === "available").length;
  const held = seats.filter((s) => s.status === "held").length;
  const booked = seats.filter((s) => s.status === "booked").length;
  document.getElementById("inv-available").textContent = `Available: ${available}`;
  document.getElementById("inv-held").textContent = `Held: ${held}`;
  document.getElementById("inv-booked").textContent = `Booked: ${booked}`;
  document.getElementById("inv-total").textContent = `Total: ${seats.length}`;
}

// ---------------------------------------------------------------------------
// Seat click / selection
// ---------------------------------------------------------------------------
function handleSeatClick(seat) {
  hideError();

  // Can't select if we have an active hold
  if (currentHold) return;

  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  btnHold.disabled = selectedSeatIds.size === 0;
  selectionInfoEl.textContent =
    selectedSeatIds.size > 0
      ? `${selectedSeatIds.size} seat(s) selected`
      : "Select one or more available seats";
}

// ---------------------------------------------------------------------------
// Hold
// ---------------------------------------------------------------------------
btnHold.addEventListener("click", async () => {
  if (selectedSeatIds.size === 0) return;
  hideError();

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeatIds),
        sessionId: SESSION_ID,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      if (res.status === 409 && err.conflictingSeatIds) {
        showError(
          `Seats already taken: ${err.conflictingSeatIds.join(", ")}. Please select other seats.`
        );
        // Deselect conflicting
        for (const id of err.conflictingSeatIds) {
          selectedSeatIds.delete(id);
        }
        await fetchSeats();
      } else {
        showError(err.error || "Failed to hold seats");
      }
      return;
    }

    const hold = await res.json();
    currentHold = {
      holdId: hold.holdId,
      seatIds: hold.seatIds,
      expiresAt: new Date(hold.expiresAt),
    };
    selectedSeatIds.clear();
    btnHold.disabled = true;
    holdInfoEl.style.display = "block";
    selectionInfoEl.textContent = "Seats held! Confirm or release before timer expires.";

    startTimer();
    await fetchSeats();
  } catch (e) {
    showError("Network error");
    console.error(e);
  }
});

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------
btnConfirm.addEventListener("click", async () => {
  if (!currentHold) return;
  hideError();

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
    });

    if (!res.ok) {
      const err = await res.json();
      showError(err.error || "Failed to confirm booking");
      clearHoldState();
      await fetchSeats();
      return;
    }

    clearHoldState();
    selectionInfoEl.textContent = "✅ Booking confirmed!";
    await fetchSeats();
  } catch (e) {
    showError("Network error");
    console.error(e);
  }
});

// ---------------------------------------------------------------------------
// Release
// ---------------------------------------------------------------------------
btnRelease.addEventListener("click", async () => {
  if (!currentHold) return;
  hideError();

  try {
    await fetch(`${API_BASE}/holds/${currentHold.holdId}`, { method: "DELETE" });
    clearHoldState();
    selectionInfoEl.textContent = "Hold released. Select new seats.";
    await fetchSeats();
  } catch (e) {
    showError("Network error");
    console.error(e);
  }
});

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
function startTimer() {
  clearTimer();
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 250);
}

function updateTimerDisplay() {
  if (!currentHold) {
    clearTimer();
    return;
  }
  const remaining = Math.max(0, currentHold.expiresAt - Date.now());
  const secs = Math.ceil(remaining / 1000);
  holdTimerEl.textContent = `⏱ ${secs}s remaining`;

  if (remaining <= 0) {
    clearHoldState();
    selectionInfoEl.textContent = "Hold expired. Select new seats.";
    fetchSeats();
  }
}

function clearTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function clearHoldState() {
  currentHold = null;
  selectedSeatIds.clear();
  holdInfoEl.style.display = "none";
  btnHold.disabled = true;
  clearTimer();
}

// ---------------------------------------------------------------------------
// Error display
// ---------------------------------------------------------------------------
function showError(msg) {
  errorMsgEl.textContent = msg;
  errorMsgEl.style.display = "block";
}

function hideError() {
  errorMsgEl.style.display = "none";
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener("seats-updated", (event) => {
    const updatedSeats = JSON.parse(event.data);
    for (const updated of updatedSeats) {
      const idx = seats.findIndex((s) => s.id === updated.id);
      if (idx !== -1) {
        seats[idx] = { ...seats[idx], ...updated };
      }
    }
    renderSeatMap();
    updateInventory();
  });

  evtSource.onerror = () => {
    // Auto-reconnect is built into EventSource
    console.warn("SSE connection error, will auto-reconnect");
  };
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
fetchSeats().then(() => {
  connectSSE();
});
