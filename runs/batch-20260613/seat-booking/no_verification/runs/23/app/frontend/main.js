// ─── State ──────────────────────────────────────────────────────────
const API_BASE = "/api";
let seats = []; // full seat list from server
let selectedSeatIds = new Set();
let currentHold = null; // { id, sessionId, seatIds, expiresAt, ttlSeconds }
let countdownInterval = null;
let sessionId = getOrCreateSessionId();

// ─── Session ID ─────────────────────────────────────────────────────
function getOrCreateSessionId() {
  let id = localStorage.getItem("seatBookingSessionId");
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : ("s-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
    localStorage.setItem("seatBookingSessionId", id);
  }
  return id;
}

// ─── DOM refs ───────────────────────────────────────────────────────
const seatMapEl = document.getElementById("seat-map");
const inventoryEl = document.getElementById("inventory");
const selectionInfoEl = document.getElementById("selection-info");
const holdInfoEl = document.getElementById("hold-info");
const holdTimerEl = document.getElementById("hold-timer");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const messagesEl = document.getElementById("messages");

// ─── API helpers ────────────────────────────────────────────────────
async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  return data.seats;
}

async function requestHold(seatIds) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seatIds, sessionId }),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Failed to hold seats");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function requestConfirm(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: "POST",
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Failed to confirm");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function requestRelease(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: "DELETE",
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || "Failed to release");
    err.status = res.status;
    throw err;
  }
  return data;
}

// ─── Rendering ──────────────────────────────────────────────────────
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
  const sortedRows = [...rowMap.keys()].sort();

  seatMapEl.innerHTML = "";

  // Stage indicator
  const stageEl = document.createElement("div");
  stageEl.className = "stage";
  stageEl.textContent = "Stage";
  seatMapEl.appendChild(stageEl);

  for (const rowLabel of sortedRows) {
    const rowSeats = rowMap.get(rowLabel).sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const labelEl = document.createElement("span");
    labelEl.className = "row-label";
    labelEl.textContent = rowLabel;
    rowEl.appendChild(labelEl);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = `seat ${getSeatClass(seat)}`;
      seatEl.textContent = seat.seat_number;
      seatEl.dataset.seatId = seat.id;

      if (seat.status === "available" && !currentHold) {
        seatEl.addEventListener("click", () => toggleSeatSelection(seat.id));
      }

      rowEl.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowEl);
  }

  updateInventory();
  updateControls();
}

function getSeatClass(seat) {
  // Check if this is one of our selected seats
  if (selectedSeatIds.has(seat.id) && seat.status === "available") {
    return "selected";
  }

  if (seat.status === "held") {
    // Check if this is our hold
    if (currentHold && currentHold.seatIds.includes(seat.id)) {
      return "held-mine";
    }
    return "held";
  }

  if (seat.status === "booked") {
    return "booked";
  }

  return "available";
}

function updateInventory() {
  const available = seats.filter((s) => s.status === "available").length;
  const held = seats.filter((s) => s.status === "held").length;
  const booked = seats.filter((s) => s.status === "booked").length;
  const total = seats.length;

  inventoryEl.innerHTML = `
    <span>Available: ${available}</span>
    <span>Held: ${held}</span>
    <span>Booked: ${booked}</span>
    <span>Total: ${total}</span>
  `;
}

function updateControls() {
  if (currentHold) {
    selectionInfoEl.style.display = "none";
    holdInfoEl.style.display = "flex";
    btnHold.style.display = "none";
  } else {
    selectionInfoEl.style.display = "block";
    holdInfoEl.style.display = "none";
    btnHold.style.display = "inline-block";

    if (selectedSeatIds.size > 0) {
      selectionInfoEl.textContent = `${selectedSeatIds.size} seat(s) selected`;
      btnHold.disabled = false;
    } else {
      selectionInfoEl.textContent = "Select seats to hold them.";
      btnHold.disabled = true;
    }
  }
}

// ─── Seat selection ─────────────────────────────────────────────────
function toggleSeatSelection(seatId) {
  if (currentHold) return;

  const seat = seats.find((s) => s.id === seatId);
  if (!seat || seat.status !== "available") return;

  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }

  renderSeatMap();
}

// ─── Hold flow ──────────────────────────────────────────────────────
async function handleHold() {
  if (selectedSeatIds.size === 0) return;

  const ids = [...selectedSeatIds];
  btnHold.disabled = true;
  btnHold.textContent = "Holding...";

  try {
    const result = await requestHold(ids);
    currentHold = result.hold;
    selectedSeatIds.clear();

    // Update local seat state
    for (const updatedSeat of result.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx !== -1) seats[idx] = updatedSeat;
    }

    showMessage("success", `Holding ${result.seats.length} seat(s) for ${currentHold.ttlSeconds}s. Confirm or release.`);
    startCountdown();
    renderSeatMap();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.conflicting) {
      const conflictLabels = err.data.conflicting
        .map((s) => `${s.row_label}${s.seat_number}`)
        .join(", ");
      showMessage("error", `Seats already taken: ${conflictLabels}`);

      // Deselect conflicting seats
      for (const c of err.data.conflicting) {
        selectedSeatIds.delete(c.id);
      }

      // Refresh seat map
      seats = await fetchSeats();
      renderSeatMap();
    } else {
      showMessage("error", err.message);
    }
  } finally {
    btnHold.textContent = "Hold Selected Seats";
    btnHold.disabled = selectedSeatIds.size === 0;
  }
}

// ─── Confirm flow ───────────────────────────────────────────────────
async function handleConfirm() {
  if (!currentHold) return;

  btnConfirm.disabled = true;
  btnConfirm.textContent = "Confirming...";

  try {
    const result = await requestConfirm(currentHold.id);

    // Update local seat state
    for (const updatedSeat of result.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx !== -1) seats[idx] = updatedSeat;
    }

    showMessage("success", `Booked ${result.seats.length} seat(s) successfully! 🎉`);
    stopCountdown();
    currentHold = null;
    renderSeatMap();
  } catch (err) {
    showMessage("error", `Confirm failed: ${err.message}`);
    stopCountdown();
    currentHold = null;
    seats = await fetchSeats();
    renderSeatMap();
  } finally {
    btnConfirm.disabled = false;
    btnConfirm.textContent = "✓ Confirm Booking";
  }
}

// ─── Release flow ───────────────────────────────────────────────────
async function handleRelease() {
  if (!currentHold) return;

  btnRelease.disabled = true;

  try {
    await requestRelease(currentHold.id);

    // Update local seat state
    for (const seatId of currentHold.seatIds) {
      const idx = seats.findIndex((s) => s.id === seatId);
      if (idx !== -1) {
        seats[idx] = { ...seats[idx], status: "available", hold_id: null, hold_expires_at: null };
      }
    }

    showMessage("info", "Hold released. Seats are available again.");
    stopCountdown();
    currentHold = null;
    renderSeatMap();
  } catch (err) {
    showMessage("error", `Release failed: ${err.message}`);
    stopCountdown();
    currentHold = null;
    seats = await fetchSeats();
    renderSeatMap();
  } finally {
    btnRelease.disabled = false;
  }
}

// ─── Countdown timer ────────────────────────────────────────────────
function startCountdown() {
  stopCountdown();

  function tick() {
    if (!currentHold) {
      stopCountdown();
      return;
    }

    const remaining = Math.max(0, Math.ceil((new Date(currentHold.expiresAt) - Date.now()) / 1000));
    holdTimerEl.textContent = `⏱ ${remaining}s`;

    if (remaining <= 10) {
      holdTimerEl.classList.add("urgent");
    } else {
      holdTimerEl.classList.remove("urgent");
    }

    if (remaining <= 0) {
      stopCountdown();
      showMessage("error", "Hold expired! Seats released.");
      currentHold = null;

      // Refresh from server
      fetchSeats().then((s) => {
        seats = s;
        renderSeatMap();
      });
    }
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  holdTimerEl.classList.remove("urgent");
}

// ─── Messages ───────────────────────────────────────────────────────
function showMessage(type, text) {
  const el = document.createElement("div");
  el.className = `message ${type}`;
  el.textContent = text;
  messagesEl.prepend(el);

  // Keep only 5 messages
  while (messagesEl.children.length > 5) {
    messagesEl.removeChild(messagesEl.lastChild);
  }

  // Auto-remove after 8 seconds
  setTimeout(() => {
    if (el.parentNode) {
      el.remove();
    }
  }, 8000);
}

// ─── SSE ────────────────────────────────────────────────────────────
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "seat-update" && data.seats) {
        handleSeatUpdates(data.seats);
      }
    } catch {
      // ignore parse errors
    }
  };

  evtSource.onerror = () => {
    // EventSource will auto-reconnect
    console.log("SSE connection lost, reconnecting...");
  };
}

function handleSeatUpdates(updatedSeats) {
  let changed = false;

  for (const updatedSeat of updatedSeats) {
    const idx = seats.findIndex((s) => s.id === updatedSeat.id);
    if (idx !== -1) {
      const oldSeat = seats[idx];
      // Only update if something changed
      if (
        oldSeat.status !== updatedSeat.status ||
        oldSeat.hold_id !== updatedSeat.hold_id
      ) {
        seats[idx] = { ...oldSeat, ...updatedSeat };
        changed = true;

        // If our held seat was released/booked by someone else, clear our hold
        if (
          currentHold &&
          currentHold.seatIds.includes(updatedSeat.id) &&
          updatedSeat.hold_id !== currentHold.id &&
          updatedSeat.status !== "held"
        ) {
          // Check if ALL our held seats have been released
          const allReleased = currentHold.seatIds.every((sid) => {
            const s = seats.find((seat) => seat.id === sid);
            return s && s.hold_id !== currentHold.id;
          });

          if (allReleased) {
            stopCountdown();
            currentHold = null;
            showMessage("info", "Your hold has expired.");
          }
        }
      }
    }
  }

  if (changed) {
    // Deselect any seats that are no longer available
    for (const seatId of [...selectedSeatIds]) {
      const seat = seats.find((s) => s.id === seatId);
      if (!seat || seat.status !== "available") {
        selectedSeatIds.delete(seatId);
      }
    }

    renderSeatMap();
  }
}

// ─── Event listeners ────────────────────────────────────────────────
btnHold.addEventListener("click", handleHold);
btnConfirm.addEventListener("click", handleConfirm);
btnRelease.addEventListener("click", handleRelease);

// ─── Init ───────────────────────────────────────────────────────────
async function init() {
  try {
    seats = await fetchSeats();
    renderSeatMap();
    connectSSE();
    showMessage("info", `Session: ${sessionId.slice(0, 8)}…`);
  } catch (err) {
    showMessage("error", "Failed to load seat map. Is the server running?");
    console.error(err);
  }
}

init();
