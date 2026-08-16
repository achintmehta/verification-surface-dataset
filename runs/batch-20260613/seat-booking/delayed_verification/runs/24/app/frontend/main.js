import "./style.css";

// ─── State ────────────────────────────────────────────────────────────────────

const API_BASE = "/api";

// Generate or retrieve session ID
function getSessionId() {
  let id = sessionStorage.getItem("sessionId");
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessionStorage.setItem("sessionId", id);
  }
  return id;
}

const sessionId = getSessionId();
document.getElementById("session-id").textContent = sessionId.slice(0, 8) + "…";

let seats = []; // full seat data from server
let selectedSeatIds = new Set(); // seats user has clicked to select
let currentHold = null; // { holdId, seatIds, expiresAt }
let countdownInterval = null;

// ─── DOM Elements ─────────────────────────────────────────────────────────────

const seatMapEl = document.getElementById("seat-map");
const selectedCountEl = document.getElementById("selected-count");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdInfoEl = document.getElementById("hold-info");
const holdCountdownEl = document.getElementById("hold-countdown");
const holdSeatsEl = document.getElementById("hold-seats");
const toastContainer = document.getElementById("toast-container");
const sseStatusEl = document.getElementById("sse-status");

// ─── Toast Notifications ──────────────────────────────────────────────────────

function showToast(message, type = "info", duration = 4000) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ─── API Helpers ──────────────────────────────────────────────────────────────

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  seats = data.seats;
  renderSeatMap();
  updateInventory();
}

async function fetchInventory() {
  const res = await fetch(`${API_BASE}/inventory`);
  const data = await res.json();
  document.getElementById("inv-available").textContent = data.available;
  document.getElementById("inv-held").textContent = data.held;
  document.getElementById("inv-booked").textContent = data.booked;
  document.getElementById("inv-total").textContent = data.total;
}

async function requestHold() {
  if (selectedSeatIds.size === 0) return;

  btnHold.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seatIds: [...selectedSeatIds],
        sessionId,
      }),
    });

    if (res.status === 409) {
      const data = await res.json();
      showToast(
        `Seats unavailable: ${data.conflictingSeatIds.join(", ")}`,
        "error"
      );
      // Clear selection of conflicting seats
      for (const id of data.conflictingSeatIds) {
        selectedSeatIds.delete(id);
      }
      // Refresh seat map to get current state
      await fetchSeats();
      updateControls();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || "Failed to hold seats", "error");
      updateControls();
      return;
    }

    const data = await res.json();
    currentHold = {
      holdId: data.holdId,
      seatIds: data.seatIds,
      expiresAt: new Date(data.expiresAt),
    };

    selectedSeatIds.clear();

    // Update local seat data with response
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = updatedSeat;
      }
    }

    renderSeatMap();
    updateControls();
    startCountdown();
    showToast(`Held ${data.seatIds.length} seat(s)!`, "success");
  } catch (err) {
    console.error("Hold error:", err);
    showToast("Network error while requesting hold", "error");
    updateControls();
  }
}

async function confirmHold() {
  if (!currentHold) return;

  btnConfirm.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

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
      showToast(data.error || "Failed to confirm", "error");
      updateControls();
      return;
    }

    const data = await res.json();

    // Update local seat data
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = updatedSeat;
      }
    }

    clearHold();
    renderSeatMap();
    updateControls();
    showToast(`Booking confirmed for ${data.seats.length} seat(s)!`, "success");
  } catch (err) {
    console.error("Confirm error:", err);
    showToast("Network error while confirming", "error");
    updateControls();
  }
}

async function releaseHold() {
  if (!currentHold) return;

  btnRelease.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: "DELETE",
    });

    if (!res.ok) {
      const data = await res.json();
      showToast(data.error || "Failed to release hold", "error");
      // If the hold is already gone, clear it
      if (res.status === 404 || res.status === 400) {
        clearHold();
        await fetchSeats();
      }
      updateControls();
      return;
    }

    const data = await res.json();

    // Update local seat data
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = updatedSeat;
      }
    }

    clearHold();
    renderSeatMap();
    updateControls();
    showToast("Hold released", "info");
  } catch (err) {
    console.error("Release error:", err);
    showToast("Network error while releasing", "error");
    updateControls();
  }
}

// ─── Hold Countdown ───────────────────────────────────────────────────────────

function startCountdown() {
  holdInfoEl.classList.remove("hidden");
  updateHoldDisplay();

  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (!currentHold) {
      clearCountdown();
      return;
    }

    const remaining = Math.max(
      0,
      Math.ceil((currentHold.expiresAt.getTime() - Date.now()) / 1000)
    );

    holdCountdownEl.textContent = remaining;

    if (remaining <= 5) {
      holdCountdownEl.classList.add("urgent");
    } else {
      holdCountdownEl.classList.remove("urgent");
    }

    if (remaining <= 0) {
      // Hold expired client-side
      clearHold();
      showToast("Hold expired", "error");
      fetchSeats();
    }
  }, 250);
}

function updateHoldDisplay() {
  if (!currentHold) return;
  const seatLabels = currentHold.seatIds
    .map((id) => {
      const seat = seats.find((s) => s.id === id);
      return seat ? `${seat.row_label}${seat.seat_number}` : `#${id}`;
    })
    .join(", ");
  holdSeatsEl.textContent = `Seats: ${seatLabels}`;
}

function clearCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  holdInfoEl.classList.add("hidden");
  holdCountdownEl.textContent = "--";
  holdCountdownEl.classList.remove("urgent");
}

function clearHold() {
  currentHold = null;
  clearCountdown();
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderSeatMap() {
  // Group seats by row
  const rowMap = {};
  for (const seat of seats) {
    if (!rowMap[seat.row_label]) {
      rowMap[seat.row_label] = [];
    }
    rowMap[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = "";

  const rowLabels = Object.keys(rowMap).sort();

  for (const rowLabel of rowLabels) {
    const rowSeats = rowMap[rowLabel].sort(
      (a, b) => a.seat_number - b.seat_number
    );

    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const label = document.createElement("div");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("button");
      seatEl.className = "seat";
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.seatId = seat.id;

      const isSelected = selectedSeatIds.has(seat.id);
      const isMyHold =
        seat.status === "held" && seat.hold_session_id === sessionId;

      if (isSelected) {
        seatEl.classList.add("selected");
      } else if (seat.status === "available") {
        seatEl.classList.add("available");
      } else if (seat.status === "held" && isMyHold) {
        seatEl.classList.add("held-mine");
      } else if (seat.status === "held") {
        seatEl.classList.add("held-other");
      } else if (seat.status === "booked") {
        seatEl.classList.add("booked");
      }

      // Click handler
      seatEl.addEventListener("click", () => handleSeatClick(seat));

      rowEl.appendChild(seatEl);
    }

    // Right label
    const labelRight = document.createElement("div");
    labelRight.className = "row-label";
    labelRight.textContent = rowLabel;
    rowEl.appendChild(labelRight);

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function handleSeatClick(seat) {
  // Can only select available seats when no active hold
  if (currentHold) {
    // If we have a hold, don't allow selection
    return;
  }

  if (seat.status !== "available") {
    return;
  }

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateControls();
}

function updateControls() {
  selectedCountEl.textContent = selectedSeatIds.size;

  const hasSelection = selectedSeatIds.size > 0;
  const hasHold = currentHold !== null;

  btnHold.disabled = !hasSelection || hasHold;
  btnConfirm.disabled = !hasHold;
  btnRelease.disabled = !hasHold;
}

function updateInventory() {
  let available = 0,
    held = 0,
    booked = 0;
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

// ─── SSE Connection ───────────────────────────────────────────────────────────

function connectSSE() {
  const eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener("connected", () => {
    sseStatusEl.textContent = "🟢 Connected (live updates)";
    sseStatusEl.className = "connected";
  });

  eventSource.addEventListener("seatUpdate", (event) => {
    const updatedSeat = JSON.parse(event.data);

    // Update local seat data
    const idx = seats.findIndex((s) => s.id === updatedSeat.id);
    if (idx !== -1) {
      seats[idx] = { ...seats[idx], ...updatedSeat };
    }

    // If this seat was in our selection and is no longer available, remove it
    if (updatedSeat.status !== "available" && selectedSeatIds.has(updatedSeat.id)) {
      // Only remove if it's not ours
      if (updatedSeat.hold_session_id !== sessionId) {
        selectedSeatIds.delete(updatedSeat.id);
      }
    }

    // If our held seats got released (expired), clear the hold
    if (currentHold && currentHold.seatIds.includes(updatedSeat.id)) {
      if (updatedSeat.status === "available" && updatedSeat.hold_id !== currentHold.holdId) {
        // Our hold expired server-side
        clearHold();
        showToast("Your hold has expired", "error");
      }
    }

    renderSeatMap();
    updateControls();
  });

  eventSource.onerror = () => {
    sseStatusEl.textContent = "🔴 Disconnected (reconnecting…)";
    sseStatusEl.className = "disconnected";
  };

  return eventSource;
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

btnHold.addEventListener("click", requestHold);
btnConfirm.addEventListener("click", confirmHold);
btnRelease.addEventListener("click", releaseHold);

// ─── Initialize ───────────────────────────────────────────────────────────────

async function init() {
  await fetchSeats();
  updateControls();
  connectSSE();
}

init();
