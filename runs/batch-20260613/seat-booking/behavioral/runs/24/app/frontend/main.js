const API_BASE = window.location.hostname === "localhost"
  ? `http://localhost:3000`
  : "";

// Generate a unique session id
const SESSION_ID = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

let seats = [];
let selectedIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let countdownTimer = null;

// ---- DOM refs ----
const seatMapEl = document.getElementById("seat-map");
const inventoryEl = document.getElementById("inventory");
const selectionInfoEl = document.getElementById("selection-info");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const statusBar = document.getElementById("status-bar");
const countdownEl = document.getElementById("countdown");

// ---- Helpers ----
function setStatus(msg, type = "") {
  statusBar.textContent = msg;
  statusBar.className = type ? `status-${type}` : "";
}

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/api/seats`);
  seats = await res.json();
  render();
}

function render() {
  // Group by row
  const rows = {};
  for (const s of seats) {
    if (!rows[s.row_label]) rows[s.row_label] = [];
    rows[s.row_label].push(s);
  }

  seatMapEl.innerHTML = "";

  // Stage
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.textContent = "Stage";
  seatMapEl.appendChild(stage);

  for (const [label, rowSeats] of Object.entries(rows)) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);
    const rowDiv = document.createElement("div");
    rowDiv.className = "row";

    const labelSpan = document.createElement("span");
    labelSpan.className = "row-label";
    labelSpan.textContent = label;
    rowDiv.appendChild(labelSpan);

    for (const seat of rowSeats) {
      const el = document.createElement("div");
      el.className = `seat ${seat.status}`;
      el.textContent = seat.seat_number;
      el.dataset.id = seat.id;

      // Mark as mine
      if (seat.status === "held" && currentHold && currentHold.seatIds.includes(seat.id)) {
        el.classList.add("mine");
      }

      // Selected
      if (selectedIds.has(seat.id)) {
        el.classList.remove("available");
        el.classList.add("selected");
      }

      el.addEventListener("click", () => onSeatClick(seat));
      rowDiv.appendChild(el);
    }
    seatMapEl.appendChild(rowDiv);
  }

  updateControls();
  updateInventory();
}

function updateControls() {
  const hasSelection = selectedIds.size > 0;
  const hasHold = !!currentHold;

  btnHold.disabled = !hasSelection || hasHold;
  btnConfirm.disabled = !hasHold;
  btnRelease.disabled = !hasHold;

  if (hasHold) {
    selectionInfoEl.textContent = `Holding ${currentHold.seatIds.length} seat(s)`;
  } else if (hasSelection) {
    selectionInfoEl.textContent = `${selectedIds.size} seat(s) selected`;
  } else {
    selectionInfoEl.textContent = "Select seats to hold";
  }
}

function updateInventory() {
  const available = seats.filter(s => s.status === "available").length;
  const held = seats.filter(s => s.status === "held").length;
  const booked = seats.filter(s => s.status === "booked").length;
  inventoryEl.textContent = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${seats.length}`;
}

function onSeatClick(seat) {
  if (currentHold) return; // Can't select while holding
  if (seat.status !== "available") return;

  if (selectedIds.has(seat.id)) {
    selectedIds.delete(seat.id);
  } else {
    selectedIds.add(seat.id);
  }
  render();
}

// ---- Hold ----
btnHold.addEventListener("click", async () => {
  if (selectedIds.size === 0) return;
  setStatus("Requesting hold...");
  try {
    const res = await fetch(`${API_BASE}/api/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatIds: [...selectedIds], sessionId: SESSION_ID }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (res.status === 409) {
        setStatus(`Seats already taken: ${data.conflictingSeatIds.join(", ")}`, "error");
        selectedIds.clear();
        await fetchSeats();
      } else {
        setStatus(data.message || "Hold failed", "error");
      }
      return;
    }
    currentHold = {
      holdId: data.holdId,
      expiresAt: new Date(data.expiresAt),
      seatIds: data.seats.map(s => s.id),
    };
    selectedIds.clear();
    setStatus("Hold acquired!", "success");
    startCountdown();
    await fetchSeats();
  } catch (err) {
    setStatus("Network error: " + err.message, "error");
  }
});

// ---- Confirm ----
btnConfirm.addEventListener("click", async () => {
  if (!currentHold) return;
  setStatus("Confirming booking...");
  try {
    const res = await fetch(`${API_BASE}/api/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
    });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.message || "Confirmation failed", "error");
      currentHold = null;
      stopCountdown();
      await fetchSeats();
      return;
    }
    setStatus("Booking confirmed! 🎉", "success");
    currentHold = null;
    stopCountdown();
    await fetchSeats();
  } catch (err) {
    setStatus("Network error: " + err.message, "error");
  }
});

// ---- Release ----
btnRelease.addEventListener("click", async () => {
  if (!currentHold) return;
  setStatus("Releasing hold...");
  try {
    const res = await fetch(`${API_BASE}/api/holds/${currentHold.holdId}`, {
      method: "DELETE",
    });
    await res.json();
    currentHold = null;
    stopCountdown();
    setStatus("Hold released", "success");
    await fetchSeats();
  } catch (err) {
    setStatus("Network error: " + err.message, "error");
  }
});

// ---- Countdown ----
function startCountdown() {
  stopCountdown();
  countdownTimer = setInterval(() => {
    if (!currentHold) { stopCountdown(); return; }
    const remaining = Math.max(0, Math.floor((currentHold.expiresAt - Date.now()) / 1000));
    countdownEl.textContent = `Hold expires in ${remaining}s`;
    if (remaining <= 0) {
      countdownEl.textContent = "Hold expired";
      currentHold = null;
      stopCountdown();
      fetchSeats();
    }
  }, 500);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  countdownEl.textContent = "";
}

// ---- SSE ----
function connectSSE() {
  const es = new EventSource(`${API_BASE}/api/stream`);

  es.addEventListener("seats-updated", (event) => {
    const updatedSeats = JSON.parse(event.data);
    for (const updated of updatedSeats) {
      const idx = seats.findIndex(s => s.id === updated.id);
      if (idx !== -1) {
        seats[idx] = { ...seats[idx], ...updated };
      }
    }
    // If our hold's seats got released externally, clear hold
    if (currentHold) {
      const heldSeats = seats.filter(s => currentHold.seatIds.includes(s.id));
      const allStillHeld = heldSeats.every(s => s.status === "held" || s.status === "booked");
      if (!allStillHeld) {
        currentHold = null;
        stopCountdown();
        setStatus("Your hold was released (expired or taken)", "error");
      }
    }
    render();
  });

  es.addEventListener("connected", () => {
    console.log("SSE connected");
  });

  es.onerror = () => {
    console.warn("SSE connection error, will reconnect...");
  };
}

// ---- Init ----
fetchSeats().then(() => {
  connectSSE();
});
