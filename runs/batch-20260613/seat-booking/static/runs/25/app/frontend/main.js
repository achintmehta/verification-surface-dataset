// @ts-check

// ─── State ────────────────────────────────────────
const API_BASE = "/api";

/** @type {string} */
const sessionId = loadOrCreateSessionId();

/** @type {Map<number, SeatData>} */
const seatsMap = new Map();

/** @type {Set<number>} */
const selectedSeatIds = new Set();

/** @type {HoldState | null} */
let currentHold = null;

/** @type {number | null} */
let countdownInterval = null;

/**
 * @typedef {{
 *   id: number,
 *   row_label: string,
 *   seat_number: number,
 *   status: string,
 *   hold_id: string | null,
 *   hold_expires_at: string | null,
 *   session_id: string | null,
 *   booked_by: string | null,
 * }} SeatData
 */

/**
 * @typedef {{
 *   holdId: string,
 *   seatIds: number[],
 *   expiresAt: string,
 * }} HoldState
 */

// ─── Initialization ───────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("session-id").textContent = sessionId;

  await fetchSeats();
  renderSeatMap();
  updateInventory();
  setupSSE();
  setupButtons();
});

// ─── Session ID ───────────────────────────────────

function loadOrCreateSessionId() {
  let id = localStorage.getItem("seat-booking-session-id");
  if (!id) {
    id = "sess-" + crypto.randomUUID();
    localStorage.setItem("seat-booking-session-id", id);
  }
  return id;
}

// ─── API ──────────────────────────────────────────

async function fetchSeats() {
  try {
    const res = await fetch(`${API_BASE}/seats`);
    const data = await res.json();
    seatsMap.clear();
    for (const seat of data.seats) {
      seatsMap.set(seat.id, seat);
    }
  } catch (err) {
    showMessage("Failed to load seats", "error");
    console.error(err);
  }
}

/**
 * @param {number[]} seatIds
 */
async function requestHold(seatIds) {
  try {
    const res = await fetch(`${API_BASE}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seatIds, sessionId }),
    });

    const data = await res.json();

    if (res.ok) {
      currentHold = {
        holdId: data.hold.holdId,
        seatIds: data.hold.seatIds,
        expiresAt: data.hold.expiresAt,
      };
      selectedSeatIds.clear();
      showMessage(`Held ${data.hold.seatIds.length} seat(s)! Confirm within the time limit.`, "success");
      startCountdown();
      updateUI();
    } else {
      // 409 conflict
      if (data.conflicting) {
        const conflictInfo = data.conflicting
          .map((c) => `Seat ${c.seatId} (${c.reason})`)
          .join(", ");
        showMessage(`Hold failed: ${conflictInfo}`, "error");
        // Refresh to get latest state
        await fetchSeats();
        selectedSeatIds.clear();
        updateUI();
      } else {
        showMessage(`Hold failed: ${data.error || "Unknown error"}`, "error");
      }
    }
  } catch (err) {
    showMessage("Network error requesting hold", "error");
    console.error(err);
  }
}

async function confirmCurrentHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    const data = await res.json();

    if (res.ok) {
      showMessage(`Booking confirmed for ${currentHold.seatIds.length} seat(s)!`, "success");
      stopCountdown();
      currentHold = null;
      updateUI();
    } else {
      showMessage(`Confirmation failed: ${data.error || "Unknown error"}`, "error");
      stopCountdown();
      currentHold = null;
      await fetchSeats();
      updateUI();
    }
  } catch (err) {
    showMessage("Network error confirming hold", "error");
    console.error(err);
  }
}

async function releaseCurrentHold() {
  if (!currentHold) return;

  try {
    const res = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });

    if (res.ok) {
      showMessage("Hold released", "info");
    } else {
      const data = await res.json();
      showMessage(`Release failed: ${data.error || "Unknown error"}`, "error");
    }

    stopCountdown();
    currentHold = null;
    await fetchSeats();
    updateUI();
  } catch (err) {
    showMessage("Network error releasing hold", "error");
    console.error(err);
  }
}

// ─── SSE ──────────────────────────────────────────

function setupSSE() {
  const evtSource = new EventSource(`${API_BASE}/stream`);

  evtSource.addEventListener("seat-update", (event) => {
    const data = JSON.parse(event.data);
    const seat = seatsMap.get(data.seatId);
    if (seat) {
      seat.status = data.status;
      seat.hold_id = data.holdId || null;
      seat.hold_expires_at = data.holdExpiresAt || null;
      seat.session_id = data.sessionId || null;
      seat.booked_by = data.bookedBy || null;

      // If our hold's seat was released by expiry, clear the hold
      if (currentHold && currentHold.seatIds.includes(data.seatId) && data.status === "available") {
        // Check if all our held seats are now available (hold expired)
        const allReleased = currentHold.seatIds.every((id) => {
          const s = seatsMap.get(id);
          return s && s.status === "available";
        });
        if (allReleased) {
          showMessage("Your hold has expired", "error");
          stopCountdown();
          currentHold = null;
        }
      }

      renderSeat(data.seatId);
      updateInventory();
      updateButtons();
    }
  });

  evtSource.onerror = () => {
    console.warn("SSE connection error, will retry automatically");
  };
}

// ─── Rendering ────────────────────────────────────

function renderSeatMap() {
  const container = document.getElementById("seat-map");
  if (!container) return;
  container.innerHTML = "";

  // Add stage indicator
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.textContent = "stage";
  container.appendChild(stage);

  // Group seats by row
  /** @type {Map<string, SeatData[]>} */
  const rows = new Map();
  for (const seat of seatsMap.values()) {
    if (!rows.has(seat.row_label)) {
      rows.set(seat.row_label, []);
    }
    rows.get(seat.row_label).push(seat);
  }

  // Sort rows alphabetically
  const sortedRows = [...rows.entries()].sort(([a], [b]) => a.localeCompare(b));

  for (const [rowLabel, seats] of sortedRows) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    // Sort seats by number
    seats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of seats) {
      const seatEl = createSeatElement(seat);
      rowDiv.appendChild(seatEl);
    }

    container.appendChild(rowDiv);
  }
}

/**
 * @param {SeatData} seat
 * @returns {HTMLElement}
 */
function createSeatElement(seat) {
  const el = document.createElement("div");
  el.className = "seat";
  el.id = `seat-${seat.id}`;
  el.textContent = `${seat.seat_number}`;
  el.dataset.seatId = String(seat.id);

  applySeatClass(el, seat);

  el.addEventListener("click", () => onSeatClick(seat.id));

  return el;
}

/**
 * @param {HTMLElement} el
 * @param {SeatData} seat
 */
function applySeatClass(el, seat) {
  el.classList.remove("available", "held", "held-mine", "booked", "selected");

  if (selectedSeatIds.has(seat.id)) {
    el.classList.add("selected");
    el.title = `${seat.row_label}${seat.seat_number} - Selected`;
  } else if (seat.status === "available") {
    el.classList.add("available");
    el.title = `${seat.row_label}${seat.seat_number} - Available`;
  } else if (seat.status === "held") {
    if (seat.session_id === sessionId) {
      el.classList.add("held-mine");
      el.title = `${seat.row_label}${seat.seat_number} - Your Hold`;
    } else {
      el.classList.add("held");
      el.title = `${seat.row_label}${seat.seat_number} - Held`;
    }
  } else if (seat.status === "booked") {
    el.classList.add("booked");
    el.title = `${seat.row_label}${seat.seat_number} - Booked`;
  }
}

/**
 * Re-render a single seat.
 * @param {number} seatId
 */
function renderSeat(seatId) {
  const el = document.getElementById(`seat-${seatId}`);
  const seat = seatsMap.get(seatId);
  if (el && seat) {
    applySeatClass(el, seat);
  }
}

// ─── Interaction ──────────────────────────────────

/**
 * @param {number} seatId
 */
function onSeatClick(seatId) {
  const seat = seatsMap.get(seatId);
  if (!seat) return;

  // Can't select if we have an active hold
  if (currentHold) return;

  // Can only select available seats
  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seatId)) {
    selectedSeatIds.delete(seatId);
  } else {
    selectedSeatIds.add(seatId);
  }

  renderSeat(seatId);
  updateButtons();
  updateSelectionInfo();
}

function updateSelectionInfo() {
  const el = document.getElementById("selected-count");
  if (el) {
    el.textContent = `${selectedSeatIds.size} seat(s) selected`;
  }
}

// ─── Buttons ──────────────────────────────────────

function setupButtons() {
  document.getElementById("btn-hold")?.addEventListener("click", () => {
    if (selectedSeatIds.size > 0) {
      requestHold([...selectedSeatIds]);
    }
  });

  document.getElementById("btn-confirm")?.addEventListener("click", () => {
    confirmCurrentHold();
  });

  document.getElementById("btn-release")?.addEventListener("click", () => {
    releaseCurrentHold();
  });

  updateButtons();
}

function updateButtons() {
  const btnHold = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-hold"));
  const btnConfirm = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-confirm"));
  const btnRelease = /** @type {HTMLButtonElement | null} */ (document.getElementById("btn-release"));

  if (btnHold) {
    btnHold.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  }
  if (btnConfirm) {
    btnConfirm.disabled = currentHold === null;
  }
  if (btnRelease) {
    btnRelease.disabled = currentHold === null;
  }
}

// ─── Countdown ────────────────────────────────────

function startCountdown() {
  stopCountdown();
  const holdInfo = document.getElementById("hold-info");
  if (holdInfo) holdInfo.classList.remove("hidden");

  updateCountdownDisplay();

  countdownInterval = window.setInterval(() => {
    updateCountdownDisplay();
  }, 1000);
}

function updateCountdownDisplay() {
  if (!currentHold) {
    stopCountdown();
    return;
  }

  const holdSeatsEl = document.getElementById("hold-seats");
  const countdownEl = document.getElementById("hold-countdown");

  if (holdSeatsEl) {
    const seatLabels = currentHold.seatIds.map((id) => {
      const s = seatsMap.get(id);
      return s ? `${s.row_label}${s.seat_number}` : `#${id}`;
    });
    holdSeatsEl.textContent = seatLabels.join(", ");
  }

  if (countdownEl) {
    const now = Date.now();
    const expires = new Date(currentHold.expiresAt).getTime();
    const remaining = Math.max(0, Math.ceil((expires - now) / 1000));

    if (remaining <= 0) {
      countdownEl.textContent = "EXPIRED";
      showMessage("Your hold has expired", "error");
      stopCountdown();
      currentHold = null;
      fetchSeats().then(() => updateUI());
    } else {
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      countdownEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
    }
  }
}

function stopCountdown() {
  if (countdownInterval !== null) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  const holdInfo = document.getElementById("hold-info");
  if (holdInfo) holdInfo.classList.add("hidden");
}

// ─── Inventory Display ───────────────────────────

function updateInventory() {
  let available = 0;
  let held = 0;
  let booked = 0;

  for (const seat of seatsMap.values()) {
    switch (seat.status) {
      case "available":
        available++;
        break;
      case "held":
        held++;
        break;
      case "booked":
        booked++;
        break;
    }
  }

  const total = available + held + booked;

  const elAvail = document.getElementById("count-available");
  const elHeld = document.getElementById("count-held");
  const elBooked = document.getElementById("count-booked");
  const elTotal = document.getElementById("count-total");

  if (elAvail) elAvail.textContent = String(available);
  if (elHeld) elHeld.textContent = String(held);
  if (elBooked) elBooked.textContent = String(booked);
  if (elTotal) elTotal.textContent = String(total);
}

// ─── Messages ─────────────────────────────────────

/**
 * @param {string} text
 * @param {"success" | "error" | "info"} type
 */
function showMessage(text, type) {
  const container = document.getElementById("messages");
  if (!container) return;

  const msg = document.createElement("div");
  msg.className = `message ${type}`;
  msg.textContent = text;
  container.prepend(msg);

  // Remove after 8 seconds
  setTimeout(() => {
    msg.remove();
  }, 8000);

  // Keep only last 10 messages
  while (container.children.length > 10) {
    container.lastChild?.remove();
  }
}

// ─── UI Update Helper ─────────────────────────────

function updateUI() {
  renderSeatMap();
  updateInventory();
  updateButtons();
  updateSelectionInfo();
}
