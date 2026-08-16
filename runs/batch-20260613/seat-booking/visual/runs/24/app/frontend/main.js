const API_BASE = window.location.origin;

// Generate a stable session id per browser tab
const SESSION_ID = crypto.randomUUID
  ? crypto.randomUUID()
  : "sess-" + Math.random().toString(36).slice(2, 15);

// ────────────────────────────────────────────
// State
// ────────────────────────────────────────────

let seats = [];           // array of seat objects from server
let selectedSeatIds = new Set();
let currentHold = null;   // { holdId, expiresAt, seatIds }
let timerInterval = null;

// DOM refs
const seatMapEl = document.getElementById("seat-map");
const selectionPanel = document.getElementById("selection-panel");
const selectedSeatsList = document.getElementById("selected-seats-list");
const holdPanel = document.getElementById("hold-panel");
const holdInfo = document.getElementById("hold-info");
const holdTimer = document.getElementById("hold-timer");
const btnHold = document.getElementById("btn-hold");
const btnClear = document.getElementById("btn-clear");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const sseStatusEl = document.getElementById("sse-status");
const toastContainer = document.getElementById("toast-container");

// ────────────────────────────────────────────
// Toast
// ────────────────────────────────────────────

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ────────────────────────────────────────────
// API calls
// ────────────────────────────────────────────

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/api/seats`);
    const data = await res.json();
    seats = data.seats;
    renderSeatMap();
    updateInventory();
  } catch (err) {
    console.error("Failed to fetch seats:", err);
    showToast("Failed to load seats", "error");
  }
}

async function requestHold() {
  if (selectedSeatIds.size === 0) return;

  btnHold.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/api/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeatIds),
        sessionId: SESSION_ID,
      }),
    });

    if (res.status === 409) {
      const data = await res.json();
      const conflictLabels = data.conflicting
        .map((c) => `${c.row_label}${c.seat_number}`)
        .join(", ");
      showToast(`Seats already taken: ${conflictLabels}`, "error");
      selectedSeatIds.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || "Failed to hold seats", "error");
      return;
    }

    const data = await res.json();
    currentHold = {
      holdId: data.holdId,
      expiresAt: new Date(data.expiresAt),
      seatIds: data.seats.map((s) => s.id),
    };

    // Update local seat state
    for (const updated of data.seats) {
      const idx = seats.findIndex((s) => s.id === updated.id);
      if (idx >= 0) seats[idx] = updated;
    }

    selectedSeatIds.clear();
    renderSeatMap();
    updateInventory();
    showSelectionPanel();
    showHoldPanel();
    startHoldTimer();
    showToast("Seats held successfully!", "success");
  } catch (err) {
    console.error("Hold request failed:", err);
    showToast("Failed to hold seats", "error");
  } finally {
    btnHold.disabled = false;
  }
}

async function confirmHold() {
  if (!currentHold) return;

  btnConfirm.disabled = true;
  try {
    const res = await fetch(
      `${API_BASE}/api/holds/${currentHold.holdId}/confirm`,
      { method: "POST" }
    );

    if (res.status === 410) {
      const data = await res.json();
      showToast(data.error || "Hold expired", "error");
      clearHold();
      await fetchSeats();
      return;
    }

    if (res.status === 404) {
      showToast("Hold not found", "error");
      clearHold();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || "Confirmation failed", "error");
      return;
    }

    const data = await res.json();

    // Update local seat state
    for (const updated of data.seats) {
      const idx = seats.findIndex((s) => s.id === updated.id);
      if (idx >= 0) seats[idx] = updated;
    }

    clearHold();
    renderSeatMap();
    updateInventory();
    showToast("Booking confirmed! 🎉", "success");
  } catch (err) {
    console.error("Confirm failed:", err);
    showToast("Failed to confirm booking", "error");
  } finally {
    btnConfirm.disabled = false;
  }
}

async function releaseHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/api/holds/${currentHold.holdId}`, {
      method: "DELETE",
    });

    if (res.ok) {
      const data = await res.json();
      for (const updated of data.seats) {
        const idx = seats.findIndex((s) => s.id === updated.id);
        if (idx >= 0) seats[idx] = updated;
      }
    }

    clearHold();
    renderSeatMap();
    updateInventory();
    showToast("Hold released", "info");
  } catch (err) {
    console.error("Release failed:", err);
    showToast("Failed to release hold", "error");
  }
}

// ────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────

function renderSeatMap() {
  // Group seats by row
  const rowMap = new Map();
  for (const seat of seats) {
    if (!rowMap.has(seat.row_label)) {
      rowMap.set(seat.row_label, []);
    }
    rowMap.get(seat.row_label).push(seat);
  }

  // Sort rows
  const sortedRows = Array.from(rowMap.keys()).sort();

  seatMapEl.innerHTML = "";

  for (const rowLabel of sortedRows) {
    const rowSeats = rowMap.get(rowLabel).sort(
      (a, b) => a.seat_number - b.seat_number
    );

    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = "seat";
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seat_number;

      const isMine = seat.session_id === SESSION_ID || seat.booked_by === SESSION_ID;
      const isMyHold =
        currentHold && currentHold.seatIds.includes(seat.id);

      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add("selected");
      } else if (seat.status === "booked") {
        seatEl.classList.add("booked");
        if (isMine) seatEl.classList.add("mine");
      } else if (seat.status === "held") {
        seatEl.classList.add("held");
        if (isMine || isMyHold) seatEl.classList.add("mine");
      } else {
        seatEl.classList.add("available");
      }

      seatEl.addEventListener("click", () => onSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    // Right label
    const labelRight = document.createElement("span");
    labelRight.className = "row-label";
    labelRight.textContent = rowLabel;
    rowDiv.appendChild(labelRight);

    seatMapEl.appendChild(rowDiv);
  }

  // Legend
  let legend = document.getElementById("legend");
  if (!legend) {
    legend = document.createElement("div");
    legend.id = "legend";
    legend.innerHTML = `
      <div class="legend-item"><div class="legend-swatch" style="background:#2d4a3e;border:1px solid #4ecca3"></div> Available</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#1a3d5c;border:1px solid #3498db"></div> Selected</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#4a3d1a;border:1px solid #f9a825"></div> Held</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#3d1a1a;border:1px solid #e74c3c"></div> Booked</div>
      <div class="legend-item"><div class="legend-swatch" style="background:#1a3a1a;border:1px solid #27ae60"></div> Your Booking</div>
    `;
    seatMapEl.appendChild(legend);
  }
}

function updateInventory() {
  const available = seats.filter((s) => s.status === "available").length;
  const held = seats.filter((s) => s.status === "held").length;
  const booked = seats.filter((s) => s.status === "booked").length;

  document.getElementById("inventory-available").textContent = `Available: ${available}`;
  document.getElementById("inventory-held").textContent = `Held: ${held}`;
  document.getElementById("inventory-booked").textContent = `Booked: ${booked}`;
}

function showSelectionPanel() {
  if (selectedSeatIds.size > 0 && !currentHold) {
    selectionPanel.classList.remove("hidden");
    const labels = Array.from(selectedSeatIds)
      .map((id) => {
        const s = seats.find((seat) => seat.id === id);
        return s ? `${s.row_label}${s.seat_number}` : `#${id}`;
      })
      .join(", ");
    selectedSeatsList.textContent = labels;
  } else {
    selectionPanel.classList.add("hidden");
  }
}

function showHoldPanel() {
  if (currentHold) {
    holdPanel.classList.remove("hidden");
    const labels = currentHold.seatIds
      .map((id) => {
        const s = seats.find((seat) => seat.id === id);
        return s ? `${s.row_label}${s.seat_number}` : `#${id}`;
      })
      .join(", ");
    holdInfo.textContent = `Seats: ${labels}`;
  } else {
    holdPanel.classList.add("hidden");
  }
}

// ────────────────────────────────────────────
// Interaction
// ────────────────────────────────────────────

function onSeatClick(seat) {
  // If we have a current hold, don't allow selecting more seats
  if (currentHold) return;

  if (seat.status === "available") {
    if (selectedSeatIds.has(seat.id)) {
      selectedSeatIds.delete(seat.id);
    } else {
      selectedSeatIds.add(seat.id);
    }
    renderSeatMap();
    showSelectionPanel();
  } else if (seat.status === "held" && seat.session_id === SESSION_ID) {
    // Already held by us, ignore
  }
  // booked or held by others: do nothing
}

function clearSelection() {
  selectedSeatIds.clear();
  renderSeatMap();
  showSelectionPanel();
}

function clearHold() {
  currentHold = null;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  holdTimer.textContent = "";
  holdTimer.classList.remove("expiring");
  showHoldPanel();
}

function startHoldTimer() {
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    updateTimerDisplay();
  }, 1000);
}

function updateTimerDisplay() {
  if (!currentHold) return;

  const now = Date.now();
  const remaining = Math.max(0, currentHold.expiresAt.getTime() - now);
  const seconds = Math.ceil(remaining / 1000);

  if (seconds <= 0) {
    holdTimer.textContent = "EXPIRED";
    holdTimer.classList.add("expiring");
    showToast("Your hold has expired", "error");
    clearHold();
    fetchSeats();
    return;
  }

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  holdTimer.textContent = `⏱ ${mins}:${secs.toString().padStart(2, "0")} remaining`;

  if (seconds <= 10) {
    holdTimer.classList.add("expiring");
  } else {
    holdTimer.classList.remove("expiring");
  }
}

// ────────────────────────────────────────────
// SSE
// ────────────────────────────────────────────

function connectSSE() {
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.addEventListener("connected", () => {
    sseStatusEl.textContent = "● Connected";
    sseStatusEl.className = "sse-connected";
  });

  es.addEventListener("seatUpdate", (event) => {
    try {
      const updatedSeats = JSON.parse(event.data);
      for (const updated of updatedSeats) {
        const idx = seats.findIndex((s) => s.id === updated.id);
        if (idx >= 0) {
          seats[idx] = updated;
        }
      }

      // Check if our hold was expired by the server
      if (currentHold) {
        const myHeldSeats = currentHold.seatIds;
        const anyReleased = myHeldSeats.some((id) => {
          const seat = seats.find((s) => s.id === id);
          return seat && seat.status === "available";
        });
        if (anyReleased) {
          // Check if ALL our hold seats are no longer held
          const allReleased = myHeldSeats.every((id) => {
            const seat = seats.find((s) => s.id === id);
            return !seat || seat.status !== "held" || seat.hold_id !== currentHold.holdId;
          });
          if (allReleased) {
            showToast("Your hold has expired", "error");
            clearHold();
          }
        }
      }

      renderSeatMap();
      updateInventory();
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  });

  es.onerror = () => {
    sseStatusEl.textContent = "● Disconnected";
    sseStatusEl.className = "sse-disconnected";
  };

  return es;
}

// ────────────────────────────────────────────
// Event listeners
// ────────────────────────────────────────────

btnHold.addEventListener("click", requestHold);
btnClear.addEventListener("click", clearSelection);
btnConfirm.addEventListener("click", confirmHold);
btnRelease.addEventListener("click", releaseHold);

// ────────────────────────────────────────────
// Init
// ────────────────────────────────────────────

async function init() {
  await fetchSeats();
  // Delay SSE connection slightly so page finishes loading for screenshots
  setTimeout(() => connectSSE(), 500);
}

init();
