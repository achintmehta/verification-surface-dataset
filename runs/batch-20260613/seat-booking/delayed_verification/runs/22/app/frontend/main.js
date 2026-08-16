// ==================== State ====================

const API_BASE = "/api";

// Generate a unique session ID for this browser tab
const SESSION_ID =
  sessionStorage.getItem("seatBookingSessionId") ||
  (() => {
    const id = "session-" + crypto.randomUUID();
    sessionStorage.setItem("seatBookingSessionId", id);
    return id;
  })();

let seats = []; // Array of seat objects from server
let selectedSeatIds = new Set(); // Seat IDs the user has clicked to select
let currentHold = null; // { id, seatIds, expiresAt }
let countdownInterval = null;

// ==================== DOM Elements ====================

const seatMapEl = document.getElementById("seat-map");
const selectionInfoEl = document.getElementById("selection-info");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdTimerEl = document.getElementById("hold-timer");
const timerCountdownEl = document.getElementById("timer-countdown");
const errorMessageEl = document.getElementById("error-message");
const connectionStatusEl = document.getElementById("connection-status");

// ==================== API ====================

async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  return data.seats;
}

async function fetchInventory() {
  const res = await fetch(`${API_BASE}/inventory`);
  return await res.json();
}

async function requestHold(seatIds) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seatIds: Array.from(seatIds), sessionId: SESSION_ID }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw { status: res.status, ...data };
  }
  return data.hold;
}

async function requestConfirm(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: "POST",
  });
  const data = await res.json();
  if (!res.ok) {
    throw { status: res.status, ...data };
  }
  return data;
}

async function requestRelease(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: "DELETE",
  });
  const data = await res.json();
  if (!res.ok) {
    throw { status: res.status, ...data };
  }
  return data;
}

// ==================== SSE ====================

function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener("connected", () => {
    connectionStatusEl.textContent = "● Connected";
    connectionStatusEl.className = "connected";
  });

  evtSource.addEventListener("seats-updated", (event) => {
    const updatedSeats = JSON.parse(event.data);
    applyUpdates(updatedSeats);
  });

  evtSource.onerror = () => {
    connectionStatusEl.textContent = "● Disconnected";
    connectionStatusEl.className = "disconnected";
  };

  evtSource.onopen = () => {
    connectionStatusEl.textContent = "● Connected";
    connectionStatusEl.className = "connected";
  };
}

// ==================== Rendering ====================

function groupSeatsByRow(seatList) {
  const rowMap = new Map();
  for (const seat of seatList) {
    if (!rowMap.has(seat.row_label)) {
      rowMap.set(seat.row_label, []);
    }
    rowMap.get(seat.row_label).push(seat);
  }
  // Sort each row by seat_number
  for (const [, rowSeats] of rowMap) {
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);
  }
  return rowMap;
}

function renderSeatMap() {
  seatMapEl.innerHTML = "";

  // Stage
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.textContent = "STAGE";
  seatMapEl.appendChild(stage);

  const rowMap = groupSeatsByRow(seats);
  const sortedRows = Array.from(rowMap.keys()).sort();

  for (const rowLabel of sortedRows) {
    const rowSeats = rowMap.get(rowLabel);
    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const label = document.createElement("div");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = `seat ${getSeatClass(seat)}`;
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seat_number;
      seatEl.title = `${seat.row_label}${seat.seat_number} - ${getEffectiveStatus(seat)}`;
      seatEl.addEventListener("click", () => onSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowDiv);
  }

  updateInventoryBar();
  updateActionButtons();
}

function getSeatClass(seat) {
  const status = getEffectiveStatus(seat);

  if (selectedSeatIds.has(seat.id)) {
    return "selected";
  }

  if (status === "held") {
    // Check if this is our hold
    if (currentHold && currentHold.seatIds.includes(seat.id)) {
      return "my-held";
    }
    return "held";
  }

  return status; // 'available' or 'booked'
}

function getEffectiveStatus(seat) {
  if (seat.status === "held" && seat.hold_expires_at) {
    if (new Date(seat.hold_expires_at) <= new Date()) {
      return "available";
    }
  }
  return seat.status;
}

function updateInventoryBar() {
  let available = 0, held = 0, booked = 0;
  for (const seat of seats) {
    const status = getEffectiveStatus(seat);
    if (status === "available") available++;
    else if (status === "held") held++;
    else if (status === "booked") booked++;
  }
  document.getElementById("inv-available").textContent = `Available: ${available}`;
  document.getElementById("inv-held").textContent = `Held: ${held}`;
  document.getElementById("inv-booked").textContent = `Booked: ${booked}`;
  document.getElementById("inv-total").textContent = `Total: ${seats.length}`;
}

function updateActionButtons() {
  const hasSelection = selectedSeatIds.size > 0;
  const hasHold = currentHold !== null;

  btnHold.disabled = !hasSelection || hasHold;
  btnHold.style.display = hasHold ? "none" : "";

  btnConfirm.disabled = !hasHold;
  btnConfirm.style.display = hasHold ? "" : "none";

  btnRelease.disabled = !hasHold;
  btnRelease.style.display = hasHold ? "" : "none";

  if (hasHold) {
    selectionInfoEl.textContent = `Holding ${currentHold.seatIds.length} seat(s). Confirm or release.`;
  } else if (hasSelection) {
    selectionInfoEl.textContent = `${selectedSeatIds.size} seat(s) selected`;
  } else {
    selectionInfoEl.textContent = "Select seats to hold them";
  }
}

// ==================== Interactions ====================

function onSeatClick(seat) {
  const status = getEffectiveStatus(seat);

  // Can't click on held (not ours) or booked seats
  if (status === "booked") return;
  if (status === "held" && !(currentHold && currentHold.seatIds.includes(seat.id))) return;

  // If we have an active hold, don't allow selecting new seats
  if (currentHold) return;

  // Toggle selection
  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    if (status === "available") {
      selectedSeatIds.add(seat.id);
    }
  }

  renderSeatMap();
}

async function onHoldClick() {
  if (selectedSeatIds.size === 0) return;
  hideError();

  try {
    btnHold.disabled = true;
    btnHold.textContent = "Holding...";

    const hold = await requestHold(selectedSeatIds);
    currentHold = {
      id: hold.id,
      seatIds: hold.seatIds,
      expiresAt: new Date(hold.expiresAt),
    };
    selectedSeatIds.clear();

    // Refresh seats from server to get accurate state
    seats = await fetchSeats();
    renderSeatMap();
    startCountdown();
  } catch (err) {
    if (err.status === 409) {
      showError(
        `Could not hold seats: ${err.error}. ` +
          (err.conflictingSeats
            ? `Conflicting: ${err.conflictingSeats.map((s) => `${s.row_label}${s.seat_number}`).join(", ")}`
            : "")
      );
      // Mark conflicting seats
      if (err.conflictingSeats) {
        highlightConflicts(err.conflictingSeats.map((s) => s.id));
      }
      selectedSeatIds.clear();
      seats = await fetchSeats();
      renderSeatMap();
    } else {
      showError(err.error || "Failed to create hold");
    }
  } finally {
    btnHold.textContent = "Hold Selected Seats";
  }
}

async function onConfirmClick() {
  if (!currentHold) return;
  hideError();

  try {
    btnConfirm.disabled = true;
    btnConfirm.textContent = "Confirming...";

    await requestConfirm(currentHold.id);
    stopCountdown();
    currentHold = null;

    seats = await fetchSeats();
    renderSeatMap();
  } catch (err) {
    showError(err.error || "Failed to confirm hold");
    // If hold expired or invalid, reset
    if (err.status === 410 || err.status === 404 || err.status === 409) {
      stopCountdown();
      currentHold = null;
      seats = await fetchSeats();
      renderSeatMap();
    }
  } finally {
    btnConfirm.textContent = "Confirm Booking";
  }
}

async function onReleaseClick() {
  if (!currentHold) return;
  hideError();

  try {
    btnRelease.disabled = true;
    btnRelease.textContent = "Releasing...";

    await requestRelease(currentHold.id);
    stopCountdown();
    currentHold = null;

    seats = await fetchSeats();
    renderSeatMap();
  } catch (err) {
    showError(err.error || "Failed to release hold");
    // Reset state anyway
    stopCountdown();
    currentHold = null;
    seats = await fetchSeats();
    renderSeatMap();
  } finally {
    btnRelease.textContent = "Release Hold";
  }
}

// ==================== Timer ====================

function startCountdown() {
  holdTimerEl.style.display = "";
  updateCountdown();
  countdownInterval = setInterval(() => {
    updateCountdown();
  }, 500);
}

function updateCountdown() {
  if (!currentHold) {
    stopCountdown();
    return;
  }

  const remaining = Math.max(
    0,
    Math.ceil((currentHold.expiresAt.getTime() - Date.now()) / 1000)
  );
  timerCountdownEl.textContent = remaining;

  if (remaining <= 0) {
    // Hold expired
    stopCountdown();
    showError("Hold expired! Seats have been released.");
    currentHold = null;
    fetchSeats().then((s) => {
      seats = s;
      renderSeatMap();
    });
  }
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  holdTimerEl.style.display = "none";
}

// ==================== SSE Updates ====================

function applyUpdates(updatedSeats) {
  for (const updated of updatedSeats) {
    const idx = seats.findIndex((s) => s.id === updated.id);
    if (idx !== -1) {
      seats[idx] = { ...seats[idx], ...updated };
    }
  }

  // If our hold's seats were released by someone else (expiry), clear hold
  if (currentHold) {
    const holdSeatIds = new Set(currentHold.seatIds);
    for (const updated of updatedSeats) {
      if (holdSeatIds.has(updated.id) && updated.status === "available") {
        // Our hold seat was released
        stopCountdown();
        currentHold = null;
        showError("Your hold expired. Seats have been released.");
        break;
      }
    }
  }

  renderSeatMap();
}

// ==================== Helpers ====================

function showError(msg) {
  errorMessageEl.textContent = msg;
  errorMessageEl.style.display = "";
  setTimeout(() => hideError(), 8000);
}

function hideError() {
  errorMessageEl.style.display = "none";
}

function highlightConflicts(seatIds) {
  for (const id of seatIds) {
    const el = document.querySelector(`.seat[data-seat-id="${id}"]`);
    if (el) {
      el.classList.add("conflict");
      setTimeout(() => el.classList.remove("conflict"), 1000);
    }
  }
}

// ==================== Init ====================

async function init() {
  btnHold.addEventListener("click", onHoldClick);
  btnConfirm.addEventListener("click", onConfirmClick);
  btnRelease.addEventListener("click", onReleaseClick);

  try {
    seats = await fetchSeats();
    renderSeatMap();
    connectSSE();
  } catch (err) {
    showError("Failed to load seats. Is the server running?");
    console.error(err);
  }
}

init();
