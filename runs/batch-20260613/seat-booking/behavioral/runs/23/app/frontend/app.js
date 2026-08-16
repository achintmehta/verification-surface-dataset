const API_BASE = window.location.port === "5173"
  ? "http://localhost:3000/api"
  : "/api";

// Generate a unique session ID
const SESSION_ID = crypto.randomUUID
  ? crypto.randomUUID()
  : "session-" + Math.random().toString(36).substr(2, 9);

let seats = [];
let selectedSeatIds = new Set();
let currentHold = null;
let countdownInterval = null;

// DOM elements
const seatMap = document.getElementById("seat-map");
const holdBtn = document.getElementById("hold-btn");
const confirmBtn = document.getElementById("confirm-btn");
const releaseBtn = document.getElementById("release-btn");
const selectionInfo = document.getElementById("selection-info");
const countdownEl = document.getElementById("countdown");
const timerEl = document.getElementById("timer");
const inventoryEl = document.getElementById("inventory");
const sessionInfoEl = document.getElementById("session-info");
const messagesEl = document.getElementById("messages");

// ── Initialize ──────────────────────────────────────────────────────────────
async function init() {
  sessionInfoEl.textContent = `Session: ${SESSION_ID.substring(0, 8)}…`;
  await loadSeats();
  connectSSE();
  setupEventListeners();
}

// ── Load seats ──────────────────────────────────────────────────────────────
async function loadSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seats = data.seats;
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showMessage("Failed to load seats", "error");
  }
}

// ── Render seat map ─────────────────────────────────────────────────────────
function renderSeatMap() {
  seatMap.innerHTML = "";

  // Add screen
  const screen = document.createElement("div");
  screen.className = "screen";
  seatMap.appendChild(screen);

  // Add legend
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML = `
    <div class="legend-item"><div class="legend-swatch" style="background:#2d6a4f"></div> Available</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#e9c46a"></div> Held</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#f4a261"></div> My Hold</div>
    <div class="legend-item"><div class="legend-swatch" style="background:#e63946"></div> Booked</div>
  `;
  seatMap.appendChild(legend);

  // Group seats by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.rowLabel]) rows[seat.rowLabel] = [];
    rows[seat.rowLabel].push(seat);
  }

  for (const [rowLabel, rowSeats] of Object.entries(rows)) {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const label = document.createElement("div");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = `seat ${seat.status}`;
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seatNumber;

      if (seat.status === "held" && seat.sessionId === SESSION_ID) {
        seatEl.classList.add("mine");
      }

      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add("selected");
      }

      seatEl.addEventListener("click", () => toggleSeat(seat));
      rowEl.appendChild(seatEl);
    }

    seatMap.appendChild(rowEl);
  }
}

// ── Toggle seat selection ───────────────────────────────────────────────────
function toggleSeat(seat) {
  if (currentHold) return; // Can't select while holding

  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateControls();
}

// ── Update controls ─────────────────────────────────────────────────────────
function updateControls() {
  const hasSelection = selectedSeatIds.size > 0;
  const hasHold = !!currentHold;

  holdBtn.disabled = !hasSelection || hasHold;
  confirmBtn.disabled = !hasHold;
  releaseBtn.disabled = !hasHold;

  if (hasHold) {
    selectionInfo.textContent = `Holding ${currentHold.seatIds.length} seat(s)`;
  } else if (hasSelection) {
    selectionInfo.textContent = `${selectedSeatIds.size} seat(s) selected`;
  } else {
    selectionInfo.textContent = "Select seats to hold them";
  }
}

// ── Hold seats ──────────────────────────────────────────────────────────────
async function holdSeats() {
  const seatIds = [...selectedSeatIds];
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatIds, sessionId: SESSION_ID }),
    });

    if (res.status === 409) {
      const data = await res.json();
      showMessage(
        `Seats already taken: ${data.conflictingSeatIds.join(", ")}`,
        "error"
      );
      selectedSeatIds.clear();
      await loadSeats();
      updateControls();
      return;
    }

    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || "Failed to hold seats", "error");
      return;
    }

    const hold = await res.json();
    currentHold = hold;
    selectedSeatIds.clear();
    showMessage(`Hold created! Expires at ${new Date(hold.expiresAt).toLocaleTimeString()}`, "success");
    startCountdown(hold.expiresAt);
    await loadSeats();
    updateControls();
  } catch (err) {
    showMessage("Network error", "error");
  }
}

// ── Confirm hold ────────────────────────────────────────────────────────────
async function confirmHold() {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
    });

    if (!res.ok) {
      const data = await res.json();
      showMessage(data.error || "Failed to confirm", "error");
      currentHold = null;
      stopCountdown();
      await loadSeats();
      updateControls();
      return;
    }

    showMessage("Booking confirmed! 🎉", "success");
    currentHold = null;
    stopCountdown();
    await loadSeats();
    updateControls();
  } catch (err) {
    showMessage("Network error", "error");
  }
}

// ── Release hold ────────────────────────────────────────────────────────────
async function releaseHold() {
  if (!currentHold) return;
  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: "DELETE",
    });

    currentHold = null;
    stopCountdown();
    showMessage("Hold released", "info");
    await loadSeats();
    updateControls();
  } catch (err) {
    showMessage("Network error", "error");
  }
}

// ── Countdown timer ─────────────────────────────────────────────────────────
function startCountdown(expiresAt) {
  stopCountdown();
  countdownEl.style.display = "block";

  const update = () => {
    const remaining = Math.max(
      0,
      Math.ceil((new Date(expiresAt) - Date.now()) / 1000)
    );
    timerEl.textContent = remaining;

    if (remaining <= 0) {
      stopCountdown();
      currentHold = null;
      showMessage("Hold expired!", "error");
      loadSeats();
      updateControls();
    }
  };

  update();
  countdownInterval = setInterval(update, 1000);
}

function stopCountdown() {
  countdownEl.style.display = "none";
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// ── SSE connection ──────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource(`${API_BASE}/stream`);

  es.addEventListener("seatUpdates", (event) => {
    const updates = JSON.parse(event.data);
    for (const update of updates) {
      const seat = seats.find((s) => s.id === update.seatId);
      if (seat) {
        seat.status = update.status;
        seat.holdId = update.holdId;
        seat.holdExpiresAt = update.holdExpiresAt;
        seat.sessionId = update.sessionId;
        seat.bookedBy = update.bookedBy || null;
      }
    }
    renderSeatMap();
    updateInventory();
  });

  es.onerror = () => {
    // EventSource will auto-reconnect
  };
}

// ── Update inventory display ────────────────────────────────────────────────
function updateInventory() {
  const counts = { available: 0, held: 0, booked: 0 };
  for (const seat of seats) {
    counts[seat.status] = (counts[seat.status] || 0) + 1;
  }
  const total = counts.available + counts.held + counts.booked;
  inventoryEl.textContent = `Available: ${counts.available} | Held: ${counts.held} | Booked: ${counts.booked} | Total: ${total}`;
}

// ── Show message ────────────────────────────────────────────────────────────
function showMessage(text, type = "info") {
  const msg = document.createElement("div");
  msg.className = `message ${type}`;
  msg.textContent = text;
  messagesEl.prepend(msg);
  setTimeout(() => msg.remove(), 5000);

  // Keep only last 5 messages
  while (messagesEl.children.length > 5) {
    messagesEl.lastChild.remove();
  }
}

// ── Event listeners ─────────────────────────────────────────────────────────
function setupEventListeners() {
  holdBtn.addEventListener("click", holdSeats);
  confirmBtn.addEventListener("click", confirmHold);
  releaseBtn.addEventListener("click", releaseHold);
}

// Start the app
init();
