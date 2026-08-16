// When running via Vite dev server with proxy, use relative URLs
// When running standalone, fall back to absolute URL
const API_BASE = window.location.port === "5173" ? "/api" : "http://localhost:3000/api";

// Generate a simple session ID
const SESSION_ID =
  localStorage.getItem("sessionId") ||
  (() => {
    const id = "session-" + Math.random().toString(36).substring(2, 10);
    localStorage.setItem("sessionId", id);
    return id;
  })();

// State
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { id, seatIds, expiresAt }
let countdownInterval = null;

// DOM elements
const seatMapEl = document.getElementById("seat-map");
const selectedSeatsEl = document.getElementById("selected-seats");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdInfoEl = document.getElementById("hold-info");
const holdIdEl = document.getElementById("hold-id");
const holdCountdownEl = document.getElementById("hold-countdown");
const errorEl = document.getElementById("error-message");
const successEl = document.getElementById("success-message");
const sseStatusEl = document.getElementById("sse-status");
const countAvailableEl = document.getElementById("count-available");
const countHeldEl = document.getElementById("count-held");
const countBookedEl = document.getElementById("count-booked");
const countTotalEl = document.getElementById("count-total");

// ----- Fetch seats -----
async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seats = data.seats;
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showError("Failed to fetch seats: " + err.message);
  }
}

// ----- Render seat map -----
function renderSeatMap() {
  seatMapEl.innerHTML = "";

  // Screen
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.textContent = "STAGE";
  seatMapEl.appendChild(screen);

  // Legend
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML = `
    <div class="legend-item"><div class="legend-swatch" style="background:#22c55e"></div> Available</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#f59e0b"></div> Held</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#3b82f6"></div> Your Hold</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#ef4444"></div> Booked</div>
  `;
  seatMapEl.appendChild(legend);

  // Group seats by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  for (const [rowLabel, rowSeats] of Object.entries(rows)) {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const label = document.createElement("div");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of rowSeats.sort((a, b) => a.seat_number - b.seat_number)) {
      const seatEl = document.createElement("div");
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.seatId = seat.id;

      // Is this seat held by us?
      if (seat.status === "held" && seat.session_id === SESSION_ID) {
        seatEl.classList.add("mine");
      }

      // Is it selected?
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add("selected");
      }

      seatEl.addEventListener("click", () => handleSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    const labelRight = document.createElement("div");
    labelRight.className = "row-label";
    labelRight.textContent = rowLabel;
    rowEl.appendChild(labelRight);

    seatMapEl.appendChild(rowEl);
  }
}

function handleSeatClick(seat) {
  // Can only select available seats, and only when we don't have an active hold
  if (currentHold) return;
  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  updateSelectionUI();
  renderSeatMap();
}

function updateSelectionUI() {
  if (selectedSeatIds.size === 0) {
    selectedSeatsEl.textContent = "None";
    btnHold.disabled = true;
  } else {
    const seatLabels = [];
    for (const id of selectedSeatIds) {
      const seat = seats.find((s) => s.id === id);
      if (seat) seatLabels.push(`${seat.row_label}${seat.seat_number}`);
    }
    selectedSeatsEl.textContent = seatLabels.join(", ");
    btnHold.disabled = false;
  }
}

function updateInventory() {
  const available = seats.filter((s) => s.status === "available").length;
  const held = seats.filter((s) => s.status === "held").length;
  const booked = seats.filter((s) => s.status === "booked").length;
  countAvailableEl.textContent = available;
  countHeldEl.textContent = held;
  countBookedEl.textContent = booked;
  countTotalEl.textContent = seats.length;
}

// ----- Hold -----
async function requestHold() {
  hideMessages();
  const seatIds = Array.from(selectedSeatIds);
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await res.json();

    if (!res.ok) {
      if (res.status === 409) {
        showError(
          `Seats already taken: ${(data.conflictingSeatIds || [])
            .map((id) => {
              const s = seats.find((s) => s.id === id);
              return s ? `${s.row_label}${s.seat_number}` : id;
            })
            .join(", ")}`
        );
        // Refresh to show current state
        selectedSeatIds.clear();
        await fetchSeats();
        updateSelectionUI();
      } else {
        showError(data.error || "Failed to hold seats");
      }
      return;
    }

    currentHold = {
      id: data.hold.id,
      seatIds: data.hold.seatIds,
      expiresAt: new Date(data.hold.expiresAt),
    };

    selectedSeatIds.clear();
    updateSelectionUI();
    updateHoldUI();
    await fetchSeats();
  } catch (err) {
    showError("Network error: " + err.message);
  }
}

// ----- Confirm -----
async function confirmHold() {
  if (!currentHold) return;
  hideMessages();

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}/confirm`, {
      method: "POST",
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Failed to confirm hold");
      clearHold();
      await fetchSeats();
      return;
    }

    showSuccess("Booking confirmed! Seats are now yours.");
    clearHold();
    await fetchSeats();
  } catch (err) {
    showError("Network error: " + err.message);
  }
}

// ----- Release -----
async function releaseHold() {
  if (!currentHold) return;
  hideMessages();

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.id}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json();
      showError(data.error || "Failed to release hold");
    }

    clearHold();
    await fetchSeats();
  } catch (err) {
    showError("Network error: " + err.message);
  }
}

function clearHold() {
  currentHold = null;
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  updateHoldUI();
}

function updateHoldUI() {
  if (currentHold) {
    holdInfoEl.classList.remove("hidden");
    holdIdEl.textContent = currentHold.id.substring(0, 8) + "...";
    btnHold.disabled = true;
    btnConfirm.disabled = false;
    btnRelease.disabled = false;

    // Start countdown
    if (countdownInterval) clearInterval(countdownInterval);
    const updateCountdown = () => {
      const remaining = Math.max(
        0,
        Math.ceil((currentHold.expiresAt.getTime() - Date.now()) / 1000)
      );
      holdCountdownEl.textContent = `${remaining}s`;
      if (remaining <= 0) {
        clearHold();
        showError("Hold expired. Seats released.");
        fetchSeats();
      }
    };
    updateCountdown();
    countdownInterval = setInterval(updateCountdown, 500);
  } else {
    holdInfoEl.classList.add("hidden");
    btnConfirm.disabled = true;
    btnRelease.disabled = true;
  }
}

// ----- SSE -----
function connectSSE() {
  const es = new EventSource(`${API_BASE}/stream`);

  es.addEventListener("connected", () => {
    sseStatusEl.textContent = "connected";
    sseStatusEl.className = "connected";
  });

  es.addEventListener("seats-updated", (event) => {
    try {
      const updatedSeats = JSON.parse(event.data);
      for (const updated of updatedSeats) {
        const idx = seats.findIndex((s) => s.id === updated.id);
        if (idx >= 0) {
          seats[idx] = { ...seats[idx], ...updated };
        }
      }
      renderSeatMap();
      updateInventory();

      // If our hold's seats just became available (expired), clear local hold
      if (currentHold) {
        const ourSeatStates = currentHold.seatIds.map((id) =>
          seats.find((s) => s.id === id)
        );
        const allReleased = ourSeatStates.every(
          (s) => s && s.status === "available"
        );
        if (allReleased) {
          clearHold();
          showError("Your hold expired. Seats released.");
        }
      }
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  });

  es.onerror = () => {
    sseStatusEl.textContent = "disconnected";
    sseStatusEl.className = "disconnected";
  };

  es.onopen = () => {
    sseStatusEl.textContent = "connected";
    sseStatusEl.className = "connected";
  };
}

// ----- Messages -----
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove("hidden");
  successEl.classList.add("hidden");
}

function showSuccess(msg) {
  successEl.textContent = msg;
  successEl.classList.remove("hidden");
  errorEl.classList.add("hidden");
}

function hideMessages() {
  errorEl.classList.add("hidden");
  successEl.classList.add("hidden");
}

// ----- Event listeners -----
btnHold.addEventListener("click", requestHold);
btnConfirm.addEventListener("click", confirmHold);
btnRelease.addEventListener("click", releaseHold);

// ----- Init -----
fetchSeats();
connectSSE();
