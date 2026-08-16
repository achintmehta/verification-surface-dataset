/**
 * Seat Booking – Vanilla JS SPA
 */

const API = "http://localhost:3001/api";

// ── Session ID ────────────────────────────────────────────────────────────────
function getSessionId() {
  let id = sessionStorage.getItem("seat-booking-session");
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem("seat-booking-session", id);
  }
  return id;
}

const SESSION_ID = getSessionId();
document.getElementById("session-id-display").textContent =
  SESSION_ID.slice(0, 8) + "…";

// ── State ─────────────────────────────────────────────────────────────────────
let seats = {};          // id → seat object
let selectedIds = new Set();
let activeHold = null;   // { id, seat_ids, expires_at }
let countdownTimer = null;
let confirmedBooking = null; // { hold_id, seats }

// ── DOM refs ──────────────────────────────────────────────────────────────────
const seatMapEl      = document.getElementById("seat-map");
const selectedCount  = document.getElementById("selected-count");
const holdBtn        = document.getElementById("hold-btn");
const holdPanel      = document.getElementById("hold-panel");
const selectPanel    = document.getElementById("select-panel");
const bookingPanel   = document.getElementById("booking-panel");
const confirmBtn     = document.getElementById("confirm-btn");
const releaseBtn     = document.getElementById("release-btn");
const newBookingBtn  = document.getElementById("new-booking-btn");
const countdownEl    = document.getElementById("countdown");
const holdSeatList   = document.getElementById("hold-seat-list");
const bookedSeatList = document.getElementById("booked-seat-list");
const errorBanner    = document.getElementById("error-banner");

// ── Utilities ─────────────────────────────────────────────────────────────────
function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.classList.remove("hidden");
  setTimeout(() => errorBanner.classList.add("hidden"), 5000);
}

function hideError() {
  errorBanner.classList.add("hidden");
}

function seatLabel(seat) {
  return `${seat.row_label}${seat.seat_number}`;
}

// ── Seat map rendering ────────────────────────────────────────────────────────
function buildSeatMap(seatList) {
  // Group by row
  const rowMap = {};
  for (const s of seatList) {
    if (!rowMap[s.row_label]) rowMap[s.row_label] = [];
    rowMap[s.row_label].push(s);
    seats[s.id] = s;
  }

  seatMapEl.innerHTML = "";

  for (const rowLabel of Object.keys(rowMap).sort()) {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const labelEl = document.createElement("div");
    labelEl.className = "row-label";
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowMap[rowLabel].sort((a, b) => a.seat_number - b.seat_number)) {
      rowEl.appendChild(createSeatEl(seat));
    }

    seatMapEl.appendChild(rowEl);
  }
}

function createSeatEl(seat) {
  const el = document.createElement("div");
  el.className = "seat";
  el.id = `seat-${seat.id}`;
  el.textContent = seat.seat_number;
  el.title = `${seatLabel(seat)} – ${seat.status}`;
  applySeatClass(el, seat);
  el.addEventListener("click", () => onSeatClick(seat.id));
  return el;
}

function applySeatClass(el, seat) {
  el.classList.remove("available", "held-own", "held-other", "booked", "selected");

  if (selectedIds.has(seat.id)) {
    el.classList.add("selected");
    return;
  }

  if (seat.status === "booked") {
    el.classList.add("booked");
    return;
  }

  if (seat.status === "held") {
    // Is it our hold?
    if (activeHold && seat.hold_id === activeHold.id) {
      el.classList.add("held-own");
    } else {
      el.classList.add("held-other");
    }
    return;
  }

  el.classList.add("available");
}

function refreshSeatEl(seatId) {
  const seat = seats[seatId];
  if (!seat) return;
  const el = document.getElementById(`seat-${seatId}`);
  if (!el) return;
  el.title = `${seatLabel(seat)} – ${seat.status}`;
  applySeatClass(el, seat);
}

// ── Seat click ────────────────────────────────────────────────────────────────
function onSeatClick(seatId) {
  // Ignore if we have an active hold or confirmed booking
  if (activeHold || confirmedBooking) return;

  const seat = seats[seatId];
  if (!seat) return;
  if (seat.status === "booked") return;
  if (seat.status === "held") return;

  if (selectedIds.has(seatId)) {
    selectedIds.delete(seatId);
  } else {
    selectedIds.add(seatId);
  }

  refreshSeatEl(seatId);
  updateSelectionUI();
}

function updateSelectionUI() {
  const n = selectedIds.size;
  selectedCount.textContent =
    n === 0 ? "No seats selected." : `${n} seat${n > 1 ? "s" : ""} selected.`;
  holdBtn.disabled = n === 0;
}

// ── Hold flow ─────────────────────────────────────────────────────────────────
holdBtn.addEventListener("click", async () => {
  if (selectedIds.size === 0) return;
  hideError();

  const seatIds = [...selectedIds];
  holdBtn.disabled = true;
  holdBtn.textContent = "Placing hold…";

  try {
    const resp = await fetch(`${API}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      holdBtn.textContent = "Hold Selected Seats";
      holdBtn.disabled = selectedIds.size === 0;

      if (resp.status === 409 && data.conflicting) {
        showError(
          `Seats already taken: ${data.conflicting.join(", ")}. Please choose different seats.`
        );
        // Refresh seat map to show current state
        await loadSeats();
      } else {
        showError(data.error || "Failed to place hold");
      }
      return;
    }

    // Success
    activeHold = {
      id: data.hold.id,
      seat_ids: data.hold.seat_ids,
      expires_at: new Date(data.hold.expires_at),
    };

    selectedIds.clear();
    holdBtn.textContent = "Hold Selected Seats";

    // Update local seat state
    for (const id of activeHold.seat_ids) {
      if (seats[id]) {
        seats[id].status = "held";
        seats[id].hold_id = activeHold.id;
        seats[id].hold_expires_at = data.hold.expires_at;
      }
      refreshSeatEl(id);
    }

    showHoldPanel();
  } catch (err) {
    console.error(err);
    showError("Network error placing hold");
    holdBtn.textContent = "Hold Selected Seats";
    holdBtn.disabled = selectedIds.size === 0;
  }
});

function showHoldPanel() {
  selectPanel.classList.add("hidden");
  holdPanel.classList.remove("hidden");
  bookingPanel.classList.add("hidden");

  holdSeatList.textContent =
    "Seats: " + activeHold.seat_ids.join(", ");

  startCountdown();
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);

  function tick() {
    const remaining = Math.max(0, activeHold.expires_at - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    countdownEl.textContent = `${m}:${s.toString().padStart(2, "0")}`;

    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      onHoldExpiredLocally();
    }
  }

  tick();
  countdownTimer = setInterval(tick, 500);
}

function onHoldExpiredLocally() {
  // The server will have expired it; just reset UI
  activeHold = null;
  showSelectPanel();
  showError("Your hold has expired. Please select seats again.");
  loadSeats();
}

// ── Confirm ───────────────────────────────────────────────────────────────────
confirmBtn.addEventListener("click", async () => {
  if (!activeHold) return;
  hideError();
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Confirming…";

  try {
    const resp = await fetch(`${API}/holds/${activeHold.id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "✅ Confirm Booking";
      showError(data.error || "Confirmation failed");

      if (resp.status === 410) {
        // Expired
        activeHold = null;
        showSelectPanel();
        await loadSeats();
      }
      return;
    }

    // Booked!
    confirmedBooking = data.booking;
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    activeHold = null;

    for (const s of data.booking.seats) {
      if (seats[s.id]) {
        seats[s.id].status = "booked";
        seats[s.id].hold_id = null;
        seats[s.id].hold_expires_at = null;
        seats[s.id].booked_by = data.booking.hold_id;
      }
      refreshSeatEl(s.id);
    }

    showBookingPanel(data.booking.seats);
    confirmBtn.disabled = false;
    confirmBtn.textContent = "✅ Confirm Booking";
  } catch (err) {
    console.error(err);
    showError("Network error confirming booking");
    confirmBtn.disabled = false;
    confirmBtn.textContent = "✅ Confirm Booking";
  }
});

function showBookingPanel(bookedSeats) {
  holdPanel.classList.add("hidden");
  selectPanel.classList.add("hidden");
  bookingPanel.classList.remove("hidden");
  bookedSeatList.textContent =
    "Seats: " + bookedSeats.map((s) => s.id).join(", ");
}

// ── Release ───────────────────────────────────────────────────────────────────
releaseBtn.addEventListener("click", async () => {
  if (!activeHold) return;
  hideError();
  releaseBtn.disabled = true;

  try {
    const resp = await fetch(`${API}/holds/${activeHold.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION_ID }),
    });

    if (!resp.ok) {
      const data = await resp.json();
      showError(data.error || "Failed to release hold");
      releaseBtn.disabled = false;
      return;
    }

    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

    for (const id of activeHold.seat_ids) {
      if (seats[id]) {
        seats[id].status = "available";
        seats[id].hold_id = null;
        seats[id].hold_expires_at = null;
      }
      refreshSeatEl(id);
    }

    activeHold = null;
    showSelectPanel();
    releaseBtn.disabled = false;
  } catch (err) {
    console.error(err);
    showError("Network error releasing hold");
    releaseBtn.disabled = false;
  }
});

// ── New booking ───────────────────────────────────────────────────────────────
newBookingBtn.addEventListener("click", () => {
  confirmedBooking = null;
  showSelectPanel();
});

function showSelectPanel() {
  holdPanel.classList.add("hidden");
  bookingPanel.classList.add("hidden");
  selectPanel.classList.remove("hidden");
  selectedIds.clear();
  updateSelectionUI();
  // Re-render all seats to clear held-own styling
  for (const id of Object.keys(seats)) refreshSeatEl(id);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API}/stream`);

  es.addEventListener("seat-update", (e) => {
    const payload = JSON.parse(e.data);
    handleSeatUpdate(payload);
  });

  es.onerror = () => {
    // Reconnect automatically (EventSource does this natively)
    console.warn("[SSE] connection error, will retry…");
  };
}

function handleSeatUpdate(payload) {
  const { type, seats: updatedSeats } = payload;

  for (const update of updatedSeats) {
    if (!seats[update.id]) continue;

    // Don't overwrite our own hold's state from SSE (we already set it)
    if (activeHold && activeHold.seat_ids.includes(update.id)) continue;

    switch (type) {
      case "held":
        seats[update.id].status = "held";
        seats[update.id].hold_id = update.hold_id;
        seats[update.id].hold_expires_at = update.hold_expires_at;
        break;
      case "booked":
        seats[update.id].status = "booked";
        seats[update.id].hold_id = null;
        seats[update.id].hold_expires_at = null;
        seats[update.id].booked_by = update.booked_by;
        break;
      case "released":
        seats[update.id].status = "available";
        seats[update.id].hold_id = null;
        seats[update.id].hold_expires_at = null;
        break;
    }

    // Remove from selection if it's no longer available
    if (seats[update.id].status !== "available") {
      selectedIds.delete(update.id);
    }

    refreshSeatEl(update.id);
  }

  updateSelectionUI();
}

// ── Initial load ──────────────────────────────────────────────────────────────
async function loadSeats() {
  seatMapEl.innerHTML = '<div class="loading">Loading seats…</div>';
  try {
    const resp = await fetch(`${API}/seats`);
    const data = await resp.json();
    buildSeatMap(data.seats);
    updateSelectionUI();
  } catch (err) {
    console.error(err);
    seatMapEl.innerHTML = '<div class="loading">Failed to load seats. Retrying…</div>';
    setTimeout(loadSeats, 3000);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(async () => {
  await loadSeats();
  connectSSE();
})();
