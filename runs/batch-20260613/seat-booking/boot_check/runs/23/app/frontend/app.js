// ─── Configuration ────────────────────────────────────────────────────────────
const API_BASE = window.location.origin + "/api";

// ─── State ────────────────────────────────────────────────────────────────────
let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = crypto.randomUUID ? crypto.randomUUID() : `sess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem("sessionId", sessionId);
}

let seats = []; // Array of seat objects
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, seatIds, expiresAt }
let countdownInterval = null;

// ─── DOM References ───────────────────────────────────────────────────────────
const seatMapEl = document.getElementById("seat-map");
const selectedListEl = document.getElementById("selected-list");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdInfoEl = document.getElementById("hold-info");
const holdIdDisplay = document.getElementById("hold-id-display");
const holdCountdown = document.getElementById("hold-countdown");
const statusMessage = document.getElementById("status-message");

// ─── API Helpers ──────────────────────────────────────────────────────────────
async function fetchSeats() {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  return data.seats;
}

async function fetchInventory() {
  const res = await fetch(`${API_BASE}/inventory`);
  return res.json();
}

async function requestHold(seatIds) {
  const res = await fetch(`${API_BASE}/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seatIds, sessionId }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw { status: res.status, ...data };
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
    throw { status: res.status, ...data };
  }
  return data;
}

async function releaseHold(holdId) {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: "DELETE",
  });
  const data = await res.json();
  if (!res.ok) {
    throw { status: res.status, ...data };
  }
  return data;
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function renderSeatMap() {
  // Group seats by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.rowLabel]) rows[seat.rowLabel] = [];
    rows[seat.rowLabel].push(seat);
  }

  seatMapEl.innerHTML = "";

  const sortedRows = Object.keys(rows).sort();
  for (const rowLabel of sortedRows) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    const rowSeats = rows[rowLabel].sort(
      (a, b) => a.seatNumber - b.seatNumber
    );

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = "seat";
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seatNumber;

      // Determine visual class
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add("selected");
      } else if (seat.status === "booked") {
        seatEl.classList.add("booked");
        seatEl.title = "Booked";
      } else if (seat.status === "held") {
        if (seat.sessionId === sessionId) {
          seatEl.classList.add("held-mine");
          seatEl.title = "Your hold";
        } else {
          seatEl.classList.add("held");
          seatEl.title = "Held by another user";
        }
      } else {
        seatEl.classList.add("available");
        seatEl.title = "Available";
      }

      seatEl.addEventListener("click", () => handleSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowDiv);
  }
}

function renderSelectedList() {
  if (selectedSeatIds.size === 0 && !currentHold) {
    selectedListEl.innerHTML =
      '<p class="placeholder">Click available seats to select them</p>';
  } else {
    const ids = currentHold ? currentHold.seatIds : [...selectedSeatIds];
    const tags = ids
      .map((id) => {
        const seat = seats.find((s) => s.id === id);
        if (!seat) return "";
        return `<span class="seat-tag">${seat.rowLabel}${seat.seatNumber}</span>`;
      })
      .join("");
    selectedListEl.innerHTML = tags || '<p class="placeholder">No seats</p>';
  }
}

function updateButtons() {
  if (currentHold) {
    btnHold.disabled = true;
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  } else {
    btnHold.disabled = selectedSeatIds.size === 0;
    btnConfirm.disabled = true;
    btnRelease.disabled = true;
  }
}

function updateInventory(inv) {
  document.getElementById("inv-available").textContent = `Available: ${inv.available}`;
  document.getElementById("inv-held").textContent = `Held: ${inv.held}`;
  document.getElementById("inv-booked").textContent = `Booked: ${inv.booked}`;
  document.getElementById("inv-total").textContent = `Total: ${inv.total}`;
}

function showStatus(msg, type = "info") {
  statusMessage.textContent = msg;
  statusMessage.className = type;
  if (type === "success" || type === "info") {
    setTimeout(() => {
      if (statusMessage.textContent === msg) {
        statusMessage.textContent = "";
        statusMessage.className = "";
      }
    }, 5000);
  }
}

function startCountdown() {
  stopCountdown();
  if (!currentHold) return;

  holdInfoEl.classList.remove("hidden");
  holdIdDisplay.textContent = currentHold.holdId.slice(0, 8) + "...";

  countdownInterval = setInterval(() => {
    if (!currentHold) {
      stopCountdown();
      return;
    }
    const remaining = Math.max(
      0,
      Math.ceil((new Date(currentHold.expiresAt).getTime() - Date.now()) / 1000)
    );
    holdCountdown.textContent = `${remaining}s`;

    if (remaining <= 0) {
      stopCountdown();
      // Hold expired
      currentHold = null;
      selectedSeatIds.clear();
      holdInfoEl.classList.add("hidden");
      showStatus("Hold expired. Seats have been released.", "error");
      refreshSeats();
    }
  }, 250);
}

function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
}

// ─── Event Handlers ───────────────────────────────────────────────────────────
function handleSeatClick(seat) {
  // If we have an active hold, don't allow changing selection
  if (currentHold) return;

  // Only allow selecting available seats
  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  renderSelectedList();
  updateButtons();
}

async function handleHold() {
  if (selectedSeatIds.size === 0) return;

  try {
    btnHold.disabled = true;
    showStatus("Placing hold...", "info");

    const result = await requestHold([...selectedSeatIds]);

    currentHold = {
      holdId: result.holdId,
      seatIds: result.seatIds,
      expiresAt: result.expiresAt,
    };

    selectedSeatIds.clear();
    showStatus(
      `Hold placed! You have ${result.ttlSeconds}s to confirm.`,
      "success"
    );

    // Update local seat state
    for (const updatedSeat of result.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = updatedSeat;
      }
    }

    renderSeatMap();
    renderSelectedList();
    updateButtons();
    startCountdown();
    refreshInventory();
  } catch (err) {
    if (err.status === 409) {
      showStatus(
        `Seats already taken: ${(err.conflictingSeatIds || []).join(", ")}. Refreshing...`,
        "error"
      );
      selectedSeatIds.clear();
      await refreshSeats();
    } else {
      showStatus(`Hold failed: ${err.error || "Unknown error"}`, "error");
    }
    updateButtons();
  }
}

async function handleConfirm() {
  if (!currentHold) return;

  try {
    btnConfirm.disabled = true;
    showStatus("Confirming booking...", "info");

    const result = await confirmHold(currentHold.holdId);

    stopCountdown();
    currentHold = null;
    holdInfoEl.classList.add("hidden");

    // Update local seat state
    for (const updatedSeat of result.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx !== -1) {
        seats[idx] = updatedSeat;
      }
    }

    showStatus("Booking confirmed! 🎉", "success");
    renderSeatMap();
    renderSelectedList();
    updateButtons();
    refreshInventory();
  } catch (err) {
    showStatus(
      `Confirmation failed: ${err.error || "Unknown error"}`,
      "error"
    );
    stopCountdown();
    currentHold = null;
    holdInfoEl.classList.add("hidden");
    await refreshSeats();
    updateButtons();
  }
}

async function handleRelease() {
  if (!currentHold) return;

  try {
    btnRelease.disabled = true;
    showStatus("Releasing hold...", "info");

    await releaseHold(currentHold.holdId);

    stopCountdown();
    currentHold = null;
    holdInfoEl.classList.add("hidden");

    showStatus("Hold released.", "info");
    await refreshSeats();
    updateButtons();
  } catch (err) {
    showStatus(`Release failed: ${err.error || "Unknown error"}`, "error");
    stopCountdown();
    currentHold = null;
    holdInfoEl.classList.add("hidden");
    await refreshSeats();
    updateButtons();
  }
}

// ─── Data Refresh ─────────────────────────────────────────────────────────────
async function refreshSeats() {
  try {
    seats = await fetchSeats();
    renderSeatMap();
    renderSelectedList();
    refreshInventory();
  } catch (err) {
    console.error("Failed to fetch seats:", err);
  }
}

async function refreshInventory() {
  try {
    const inv = await fetchInventory();
    updateInventory(inv);
  } catch (err) {
    console.error("Failed to fetch inventory:", err);
  }
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
function connectSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener("connected", () => {
    console.log("SSE connected");
  });

  evtSource.addEventListener("seats-updated", (event) => {
    try {
      const updatedSeats = JSON.parse(event.data);
      for (const updatedSeat of updatedSeats) {
        const idx = seats.findIndex((s) => s.id === updatedSeat.id);
        if (idx !== -1) {
          seats[idx] = updatedSeat;
        }
      }

      // Check if our current hold's seats got released/expired by someone else
      if (currentHold) {
        const holdSeatIds = new Set(currentHold.seatIds);
        const lostSeats = updatedSeats.filter(
          (s) =>
            holdSeatIds.has(s.id) &&
            s.status === "available"
        );
        if (lostSeats.length > 0) {
          // Our hold expired server-side
          stopCountdown();
          currentHold = null;
          holdInfoEl.classList.add("hidden");
          selectedSeatIds.clear();
          showStatus("Your hold expired. Seats were released.", "error");
        }
      }

      renderSeatMap();
      refreshInventory();
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  });

  evtSource.onerror = () => {
    console.warn("SSE connection error, will auto-reconnect...");
  };
}

// ─── Button Listeners ─────────────────────────────────────────────────────────
btnHold.addEventListener("click", handleHold);
btnConfirm.addEventListener("click", handleConfirm);
btnRelease.addEventListener("click", handleRelease);

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  await refreshSeats();
  updateButtons();
  connectSSE();
}

init();
