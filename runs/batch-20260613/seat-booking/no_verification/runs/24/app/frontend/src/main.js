// Generate a unique session id for this browser tab
const SESSION_ID = crypto.randomUUID
  ? crypto.randomUUID()
  : "sess-" + Math.random().toString(36).slice(2) + Date.now().toString(36);

const API_BASE = "/api";

// ── State ──────────────────────────────────────────────────────────────────
let seats = []; // full seat list from server
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let countdownTimer = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const seatMapEl = document.getElementById("seat-map");
const selectionPanel = document.getElementById("selection-panel");
const selectedSeatsList = document.getElementById("selected-seats-list");
const btnHold = document.getElementById("btn-hold");
const btnClear = document.getElementById("btn-clear");
const holdPanel = document.getElementById("hold-panel");
const holdInfo = document.getElementById("hold-info");
const holdCountdown = document.getElementById("hold-countdown");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const bookingPanel = document.getElementById("booking-panel");
const bookingInfo = document.getElementById("booking-info");
const btnNew = document.getElementById("btn-new");
const errorToast = document.getElementById("error-toast");
const successToast = document.getElementById("success-toast");
const invAvailable = document.getElementById("inv-available");
const invHeld = document.getElementById("inv-held");
const invBooked = document.getElementById("inv-booked");
const invTotal = document.getElementById("inv-total");

// ── API helpers ────────────────────────────────────────────────────────────
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

// ── Rendering ──────────────────────────────────────────────────────────────
function seatLabel(seat) {
  return `${seat.row_label}${seat.seat_number}`;
}

function effectiveStatus(seat) {
  // Client-side fallback: if held and expired, treat as available
  if (
    seat.status === "held" &&
    seat.hold_expires_at &&
    new Date(seat.hold_expires_at) <= new Date()
  ) {
    return "available";
  }
  return seat.status;
}

function renderSeatMap() {
  seatMapEl.innerHTML = "";

  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  const sortedRowLabels = Object.keys(rows).sort();

  for (const rowLabel of sortedRowLabels) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const labelEl = document.createElement("span");
    labelEl.className = "row-label";
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const status = effectiveStatus(seat);
      const el = document.createElement("div");
      el.className = `seat ${status}`;
      el.textContent = seat.seat_number;
      el.dataset.seatId = seat.id;

      // Mark seats belonging to this session
      const isMine =
        seat.session_id === SESSION_ID || seat.booked_by === SESSION_ID;
      if (isMine) el.classList.add("mine");

      // Mark selected
      if (selectedSeatIds.has(seat.id)) {
        el.classList.add("selected");
      }

      el.addEventListener("click", () => onSeatClick(seat));
      rowEl.appendChild(el);
    }

    // Right label
    const labelRight = document.createElement("span");
    labelRight.className = "row-label";
    labelRight.textContent = rowLabel;
    rowEl.appendChild(labelRight);

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
}

function updateInventory() {
  let avail = 0, held = 0, booked = 0;
  for (const s of seats) {
    const st = effectiveStatus(s);
    if (st === "available") avail++;
    else if (st === "held") held++;
    else if (st === "booked") booked++;
  }
  invAvailable.textContent = `Available: ${avail}`;
  invHeld.textContent = `Held: ${held}`;
  invBooked.textContent = `Booked: ${booked}`;
  invTotal.textContent = `Total: ${avail + held + booked}`;
}

function updateSelectionPanel() {
  if (selectedSeatIds.size === 0 || currentHold) {
    selectionPanel.classList.add("hidden");
    return;
  }
  selectionPanel.classList.remove("hidden");

  const selectedSeats = seats.filter((s) => selectedSeatIds.has(s.id));
  selectedSeatsList.textContent = selectedSeats.map(seatLabel).join(", ");
}

function updateHoldPanel() {
  if (!currentHold || currentHold.confirmed) {
    holdPanel.classList.add("hidden");
    stopCountdown();
    return;
  }

  holdPanel.classList.remove("hidden");
  const holdSeats = seats.filter((s) => currentHold.seatIds.includes(s.id));
  holdInfo.textContent = `Seats: ${holdSeats.map(seatLabel).join(", ")}`;
  startCountdown();
}

function updateBookingPanel() {
  if (!currentHold || !currentHold.confirmed) {
    bookingPanel.classList.add("hidden");
    return;
  }

  bookingPanel.classList.remove("hidden");
  const bookedSeats = seats.filter((s) => currentHold.seatIds.includes(s.id));
  bookingInfo.textContent = `Seats: ${bookedSeats.map(seatLabel).join(", ")}`;
}

function startCountdown() {
  stopCountdown();
  const update = () => {
    if (!currentHold) return;
    const remaining = Math.max(
      0,
      Math.ceil((new Date(currentHold.expiresAt) - Date.now()) / 1000)
    );
    holdCountdown.textContent = `⏱ ${remaining}s remaining`;
    if (remaining <= 0) {
      stopCountdown();
      // The hold expired
      showError("Hold expired! Seats have been released.");
      currentHold = null;
      selectedSeatIds.clear();
      refreshSeats();
    }
  };
  update();
  countdownTimer = setInterval(update, 500);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

// ── Toasts ─────────────────────────────────────────────────────────────────
let errorTimeout, successTimeout;

function showError(msg) {
  errorToast.textContent = msg;
  errorToast.classList.remove("hidden");
  clearTimeout(errorTimeout);
  errorTimeout = setTimeout(() => errorToast.classList.add("hidden"), 4000);
}

function showSuccess(msg) {
  successToast.textContent = msg;
  successToast.classList.remove("hidden");
  clearTimeout(successTimeout);
  successTimeout = setTimeout(() => successToast.classList.add("hidden"), 4000);
}

// ── Event handlers ─────────────────────────────────────────────────────────
function onSeatClick(seat) {
  const status = effectiveStatus(seat);

  // If we have an active hold or confirming, ignore clicks
  if (currentHold) return;

  if (status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateSelectionPanel();
}

btnHold.addEventListener("click", async () => {
  if (selectedSeatIds.size === 0) return;
  btnHold.disabled = true;

  try {
    const seatIds = [...selectedSeatIds];
    const result = await requestHold(seatIds);

    currentHold = {
      holdId: result.holdId,
      expiresAt: result.expiresAt,
      seatIds: seatIds,
      confirmed: false,
    };

    // Update local seats from response
    applySeatUpdates(result.seats);

    selectedSeatIds.clear();
    renderSeatMap();
    updateSelectionPanel();
    updateHoldPanel();
    showSuccess("Seats held successfully!");
  } catch (err) {
    if (err.status === 409 && err.data) {
      const conflicting = err.data.conflictingSeats || [];
      const labels = conflicting
        .map((s) => `${s.row_label}${s.seat_number}`)
        .join(", ");
      showError(`Seats already taken: ${labels}`);

      // Remove conflicting seats from selection
      if (err.data.conflictingSeatIds) {
        for (const id of err.data.conflictingSeatIds) {
          selectedSeatIds.delete(id);
        }
      }

      // Refresh to get current state
      await refreshSeats();
    } else {
      showError(err.message);
    }
  } finally {
    btnHold.disabled = false;
  }
});

btnClear.addEventListener("click", () => {
  selectedSeatIds.clear();
  renderSeatMap();
  updateSelectionPanel();
});

btnConfirm.addEventListener("click", async () => {
  if (!currentHold) return;
  btnConfirm.disabled = true;

  try {
    const result = await confirmHold(currentHold.holdId);
    currentHold.confirmed = true;

    applySeatUpdates(result.seats);
    renderSeatMap();
    updateHoldPanel();
    updateBookingPanel();
    showSuccess("Booking confirmed! 🎉");
  } catch (err) {
    showError(`Confirmation failed: ${err.message}`);
    currentHold = null;
    await refreshSeats();
    updateHoldPanel();
    updateBookingPanel();
  } finally {
    btnConfirm.disabled = false;
  }
});

btnRelease.addEventListener("click", async () => {
  if (!currentHold) return;
  btnRelease.disabled = true;

  try {
    await releaseHold(currentHold.holdId);
    currentHold = null;
    selectedSeatIds.clear();
    await refreshSeats();
    updateHoldPanel();
    showSuccess("Hold released.");
  } catch (err) {
    showError(`Release failed: ${err.message}`);
  } finally {
    btnRelease.disabled = false;
  }
});

btnNew.addEventListener("click", () => {
  currentHold = null;
  selectedSeatIds.clear();
  renderSeatMap();
  updateSelectionPanel();
  updateHoldPanel();
  updateBookingPanel();
});

// ── Data updates ───────────────────────────────────────────────────────────
function applySeatUpdates(updatedSeats) {
  if (!Array.isArray(updatedSeats)) return;
  for (const updated of updatedSeats) {
    const idx = seats.findIndex((s) => s.id === updated.id);
    if (idx >= 0) {
      seats[idx] = { ...seats[idx], ...updated };
    }
  }
}

async function refreshSeats() {
  try {
    seats = await fetchSeats();
    renderSeatMap();
    updateSelectionPanel();
    updateHoldPanel();
    updateBookingPanel();
  } catch (err) {
    console.error("Failed to fetch seats:", err);
  }
}

// ── SSE ────────────────────────────────────────────────────────────────────
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener("seats-updated", (event) => {
    try {
      const updatedSeats = JSON.parse(event.data);
      applySeatUpdates(updatedSeats);
      renderSeatMap();
      updateSelectionPanel();

      // Check if our hold was expired by the server
      if (currentHold && !currentHold.confirmed) {
        const ourHoldSeats = seats.filter((s) =>
          currentHold.seatIds.includes(s.id)
        );
        const allReleased = ourHoldSeats.every(
          (s) => effectiveStatus(s) === "available" && s.hold_id !== currentHold.holdId
        );
        if (allReleased) {
          showError("Your hold has expired.");
          currentHold = null;
          selectedSeatIds.clear();
          updateHoldPanel();
          updateBookingPanel();
          renderSeatMap();
        }
      }
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  });

  evtSource.addEventListener("connected", () => {
    console.log("SSE connected");
  });

  evtSource.onerror = () => {
    console.warn("SSE connection lost, reconnecting...");
    evtSource.close();
    setTimeout(connectSSE, 2000);
  };
}

// ── Init ───────────────────────────────────────────────────────────────────
async function init() {
  await refreshSeats();
  connectSSE();
}

init();
