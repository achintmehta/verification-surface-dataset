const API_BASE = window.location.origin + "/api";

// ─── State ────────────────────────────────────────────────────
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, expiresAt, seatIds }
let timerInterval = null;
const sessionId = crypto.randomUUID();

// ─── DOM refs ─────────────────────────────────────────────────
const seatMap = document.getElementById("seat-map");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdTimer = document.getElementById("hold-timer");
const timerValue = document.getElementById("timer-value");
const selectionInfo = document.getElementById("selection-info");
const messagesDiv = document.getElementById("messages");
const sseStatus = document.getElementById("sse-status");

// ─── Messages ─────────────────────────────────────────────────
function showMessage(text, type = "info") {
  const div = document.createElement("div");
  div.className = `message ${type}`;
  div.textContent = text;
  messagesDiv.prepend(div);
  // Keep only 5 messages
  while (messagesDiv.children.length > 5) {
    messagesDiv.removeChild(messagesDiv.lastChild);
  }
  setTimeout(() => {
    if (div.parentNode) div.remove();
  }, 5000);
}

// ─── Render seat map ──────────────────────────────────────────
function renderSeats() {
  seatMap.innerHTML = "";

  // Stage
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.textContent = "Stage";
  seatMap.appendChild(stage);

  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  for (const [label, rowSeats] of Object.entries(rows)) {
    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const labelEl = document.createElement("div");
    labelEl.className = "row-label";
    labelEl.textContent = label;
    rowDiv.appendChild(labelEl);

    for (const seat of rowSeats.sort((a, b) => a.seat_number - b.seat_number)) {
      const el = document.createElement("div");
      el.className = `seat ${seat.status}`;
      el.dataset.id = seat.id;
      el.textContent = seat.seat_number;

      if (seat.status === "held" && seat.session_id === sessionId) {
        el.classList.add("mine");
      }

      if (selectedSeatIds.has(seat.id) && seat.status === "available") {
        el.classList.add("selected");
      }

      el.addEventListener("click", () => handleSeatClick(seat));
      rowDiv.appendChild(el);
    }

    seatMap.appendChild(rowDiv);
  }

  updateInventory();
  updateSelectionInfo();
}

function updateInventory() {
  let avail = 0, held = 0, booked = 0;
  for (const s of seats) {
    if (s.status === "available") avail++;
    else if (s.status === "held") held++;
    else if (s.status === "booked") booked++;
  }
  document.getElementById("inv-available").textContent = `Available: ${avail}`;
  document.getElementById("inv-held").textContent = `Held: ${held}`;
  document.getElementById("inv-booked").textContent = `Booked: ${booked}`;
  document.getElementById("inv-total").textContent = `Total: ${seats.length}`;
}

function updateSelectionInfo() {
  if (currentHold) {
    selectionInfo.textContent = `Holding ${currentHold.seatIds.length} seat(s)`;
  } else if (selectedSeatIds.size > 0) {
    selectionInfo.textContent = `${selectedSeatIds.size} seat(s) selected`;
  } else {
    selectionInfo.textContent = "Select seats to hold them";
  }
}

// ─── Seat click handler ───────────────────────────────────────
function handleSeatClick(seat) {
  // Can't select if we have an active hold
  if (currentHold) return;

  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  btnHold.disabled = selectedSeatIds.size === 0;
  renderSeats();
}

// ─── Hold ─────────────────────────────────────────────────────
async function requestHold() {
  if (selectedSeatIds.size === 0) return;

  btnHold.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeatIds),
        sessionId,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      if (resp.status === 409) {
        showMessage(
          `Seats already taken: ${data.conflictingSeatIds?.join(", ") || "unknown"}`,
          "error"
        );
        // Clear conflicting seats from selection
        if (data.conflictingSeatIds) {
          for (const id of data.conflictingSeatIds) {
            selectedSeatIds.delete(id);
          }
        }
        // Refresh seat map
        await fetchSeats();
      } else {
        showMessage(data.error || "Failed to hold seats", "error");
      }
      btnHold.disabled = selectedSeatIds.size === 0;
      return;
    }

    currentHold = {
      holdId: data.holdId,
      expiresAt: new Date(data.expiresAt),
      seatIds: data.seatIds,
    };
    selectedSeatIds.clear();

    showMessage(`Holding ${currentHold.seatIds.length} seat(s) — confirm before timer expires!`, "success");

    // Show confirm/release, hide hold
    btnHold.style.display = "none";
    btnConfirm.style.display = "inline-block";
    btnConfirm.disabled = false;
    btnRelease.style.display = "inline-block";
    btnRelease.disabled = false;
    holdTimer.style.display = "block";

    startTimer();
    await fetchSeats();
  } catch (err) {
    showMessage("Network error", "error");
    btnHold.disabled = selectedSeatIds.size === 0;
  }
}

// ─── Confirm ──────────────────────────────────────────────────
async function confirmHold() {
  if (!currentHold) return;

  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const data = await resp.json();

    if (!resp.ok) {
      showMessage(data.error || "Confirmation failed", "error");
      // If hold expired, reset
      if (resp.status === 410 || resp.status === 404) {
        resetHoldUI();
        await fetchSeats();
      } else {
        btnConfirm.disabled = false;
        btnRelease.disabled = false;
      }
      return;
    }

    showMessage(`Booking confirmed! ${data.seatIds.length} seat(s) booked.`, "success");
    resetHoldUI();
    await fetchSeats();
  } catch (err) {
    showMessage("Network error", "error");
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  }
}

// ─── Release ──────────────────────────────────────────────────
async function releaseHold() {
  if (!currentHold) return;

  btnConfirm.disabled = true;
  btnRelease.disabled = true;

  try {
    const resp = await fetch(`${API_BASE}/holds/${currentHold.holdId}`, {
      method: "DELETE",
    });

    if (!resp.ok) {
      const data = await resp.json();
      showMessage(data.error || "Release failed", "error");
    } else {
      showMessage("Hold released", "info");
    }

    resetHoldUI();
    await fetchSeats();
  } catch (err) {
    showMessage("Network error", "error");
    btnConfirm.disabled = false;
    btnRelease.disabled = false;
  }
}

// ─── Timer ────────────────────────────────────────────────────
function startTimer() {
  if (timerInterval) clearInterval(timerInterval);

  function tick() {
    if (!currentHold) {
      stopTimer();
      return;
    }
    const remaining = Math.max(0, currentHold.expiresAt - Date.now());
    const secs = Math.ceil(remaining / 1000);
    timerValue.textContent = `${secs}s`;

    if (remaining <= 0) {
      showMessage("Hold expired!", "error");
      resetHoldUI();
      fetchSeats();
    }
  }

  tick();
  timerInterval = setInterval(tick, 250);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

function resetHoldUI() {
  currentHold = null;
  selectedSeatIds.clear();
  stopTimer();
  btnHold.style.display = "inline-block";
  btnHold.disabled = true;
  btnConfirm.style.display = "none";
  btnConfirm.disabled = true;
  btnRelease.style.display = "none";
  btnRelease.disabled = true;
  holdTimer.style.display = "none";
}

// ─── Fetch seats ──────────────────────────────────────────────
async function fetchSeats() {
  try {
    const resp = await fetch(`${API_BASE}/seats`);
    seats = await resp.json();
    renderSeats();
  } catch (err) {
    showMessage("Failed to load seats", "error");
  }
}

// ─── SSE ──────────────────────────────────────────────────────
function connectSSE() {
  const source = new EventSource(`${API_BASE}/stream`);

  source.addEventListener("connected", () => {
    sseStatus.textContent = "● Connected";
    sseStatus.className = "sse-connected";
  });

  source.addEventListener("seat-update", (e) => {
    try {
      const updates = JSON.parse(e.data);
      for (const update of updates) {
        const idx = seats.findIndex((s) => s.id === update.id);
        if (idx >= 0) {
          seats[idx] = { ...seats[idx], ...update };
        }
      }

      // Check if our hold was expired
      if (currentHold) {
        const ourSeats = seats.filter((s) => currentHold.seatIds.includes(s.id));
        const anyReleased = ourSeats.some(
          (s) => s.status === "available" && s.hold_id === null
        );
        if (anyReleased) {
          showMessage("Your hold has expired", "error");
          resetHoldUI();
        }
      }

      renderSeats();
    } catch (err) {
      console.error("SSE parse error:", err);
    }
  });

  source.onerror = () => {
    sseStatus.textContent = "● Disconnected";
    sseStatus.className = "sse-disconnected";
    source.close();
    // Reconnect after 2s
    setTimeout(connectSSE, 2000);
  };
}

// ─── Init ─────────────────────────────────────────────────────
btnHold.addEventListener("click", requestHold);
btnConfirm.addEventListener("click", confirmHold);
btnRelease.addEventListener("click", releaseHold);

fetchSeats();
connectSSE();
