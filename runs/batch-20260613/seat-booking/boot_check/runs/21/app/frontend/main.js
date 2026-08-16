const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? `http://${window.location.hostname}:3001/api`
  : "/api";

const SSE_URL = API_BASE + "/stream";

// State
let seats = [];
let selectedSeatIds = new Set();
let currentHold = null; // { holdId, sessionId, seatIds, expiresAt }
let sessionId = localStorage.getItem("sessionId");
if (!sessionId) {
  sessionId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  localStorage.setItem("sessionId", sessionId);
}

let countdownInterval = null;

// DOM elements
const seatMapEl = document.getElementById("seat-map");
const selectedCountEl = document.getElementById("selected-count");
const selectedListEl = document.getElementById("selected-list");
const btnHold = document.getElementById("btn-hold");
const btnConfirm = document.getElementById("btn-confirm");
const btnRelease = document.getElementById("btn-release");
const holdInfoEl = document.getElementById("hold-info");
const holdIdDisplayEl = document.getElementById("hold-id-display");
const holdCountdownEl = document.getElementById("hold-countdown");
const holdSeatsDisplayEl = document.getElementById("hold-seats-display");
const statusMessageEl = document.getElementById("status-message");
const invAvailable = document.getElementById("inv-available");
const invHeld = document.getElementById("inv-held");
const invBooked = document.getElementById("inv-booked");
const invTotal = document.getElementById("inv-total");

// ---------- Fetch seats ----------
async function fetchSeats() {
  try {
    const res = await fetch(API_BASE + "/seats");
    const data = await res.json();
    seats = data.seats;
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showMessage("Failed to load seats", "error");
  }
}

// ---------- Render seat map ----------
function renderSeatMap() {
  // Group by row
  const rows = {};
  for (const seat of seats) {
    if (!rows[seat.row_label]) rows[seat.row_label] = [];
    rows[seat.row_label].push(seat);
  }

  seatMapEl.innerHTML = "";

  // Stage
  const stage = document.createElement("div");
  stage.className = "stage";
  stage.textContent = "STAGE";
  seatMapEl.appendChild(stage);

  const sortedRows = Object.keys(rows).sort();
  for (const rowLabel of sortedRows) {
    const rowSeats = rows[rowLabel].sort((a, b) => a.seat_number - b.seat_number);
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = "seat";
      seatEl.dataset.seatId = seat.id;
      seatEl.textContent = seat.seat_number;

      // Determine CSS class
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add("selected");
      } else if (seat.status === "booked") {
        seatEl.classList.add("booked");
        seatEl.title = "Booked";
      } else if (seat.status === "held") {
        if (seat.session_id === sessionId) {
          seatEl.classList.add("held-mine");
          seatEl.title = "Held by you";
        } else {
          seatEl.classList.add("held");
          seatEl.title = "Held by another user";
        }
      } else {
        seatEl.classList.add("available");
        seatEl.title = `${seat.row_label}${seat.seat_number} - Available`;
      }

      seatEl.addEventListener("click", () => handleSeatClick(seat));
      rowEl.appendChild(seatEl);
    }

    seatMapEl.appendChild(rowEl);
  }
}

function handleSeatClick(seat) {
  // Can't select if we have an active hold
  if (currentHold) return;

  // Only available seats can be selected
  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateControls();
}

// ---------- Update controls ----------
function updateControls() {
  selectedCountEl.textContent = selectedSeatIds.size;

  const selectedSeats = seats.filter((s) => selectedSeatIds.has(s.id));
  selectedListEl.textContent = selectedSeats
    .map((s) => `${s.row_label}${s.seat_number}`)
    .join(", ");

  btnHold.disabled = selectedSeatIds.size === 0 || currentHold !== null;
  btnConfirm.disabled = currentHold === null;
  btnRelease.disabled = currentHold === null;
}

// ---------- Hold ----------
btnHold.addEventListener("click", async () => {
  if (selectedSeatIds.size === 0) return;

  btnHold.disabled = true;
  hideMessage();

  try {
    const res = await fetch(API_BASE + "/holds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seatIds: Array.from(selectedSeatIds),
        sessionId,
      }),
    });

    const data = await res.json();

    if (res.status === 409) {
      // Conflict — show which seats were taken
      const conflicting = data.conflicting || [];
      const names = conflicting.map((c) => `${c.row_label}${c.seat_number}`).join(", ");
      showMessage(`Seats already taken: ${names}`, "error");
      selectedSeatIds.clear();
      await fetchSeats();
      return;
    }

    if (!res.ok) {
      showMessage(data.error || "Failed to hold seats", "error");
      return;
    }

    currentHold = data.hold;
    selectedSeatIds.clear();

    // Update local seat state
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx >= 0) seats[idx] = updatedSeat;
    }

    renderSeatMap();
    updateControls();
    showHoldInfo();
    showMessage("Seats held successfully!", "success");
  } catch (err) {
    showMessage("Network error", "error");
  }
});

// ---------- Confirm ----------
btnConfirm.addEventListener("click", async () => {
  if (!currentHold) return;

  btnConfirm.disabled = true;
  hideMessage();

  try {
    const res = await fetch(API_BASE + `/holds/${currentHold.holdId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    const data = await res.json();

    if (!res.ok) {
      showMessage(data.error || "Failed to confirm booking", "error");
      clearHold();
      await fetchSeats();
      return;
    }

    // Update local seats
    for (const updatedSeat of data.seats) {
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx >= 0) seats[idx] = updatedSeat;
    }

    clearHold();
    renderSeatMap();
    updateControls();
    updateInventory();
    showMessage("Booking confirmed! 🎉", "success");
  } catch (err) {
    showMessage("Network error", "error");
  }
});

// ---------- Release ----------
btnRelease.addEventListener("click", async () => {
  if (!currentHold) return;

  btnRelease.disabled = true;
  hideMessage();

  try {
    const res = await fetch(API_BASE + `/holds/${currentHold.holdId}`, {
      method: "DELETE",
    });

    const data = await res.json();

    if (!res.ok) {
      showMessage(data.error || "Failed to release hold", "error");
    } else {
      // Update local seats
      if (data.seats) {
        for (const updatedSeat of data.seats) {
          const idx = seats.findIndex((s) => s.id === updatedSeat.id);
          if (idx >= 0) seats[idx] = { ...updatedSeat, status: "available" };
        }
      }
      showMessage("Hold released", "info");
    }

    clearHold();
    renderSeatMap();
    updateControls();
    updateInventory();
  } catch (err) {
    showMessage("Network error", "error");
  }
});

// ---------- Hold info / countdown ----------
function showHoldInfo() {
  if (!currentHold) return;
  holdInfoEl.classList.remove("hidden");
  holdIdDisplayEl.textContent = currentHold.holdId.slice(0, 8) + "...";

  const heldSeatNames = seats
    .filter((s) => currentHold.seatIds.includes(s.id))
    .map((s) => `${s.row_label}${s.seat_number}`)
    .join(", ");
  holdSeatsDisplayEl.textContent = heldSeatNames;

  startCountdown();
}

function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);

  const tick = () => {
    if (!currentHold) {
      clearInterval(countdownInterval);
      return;
    }
    const remaining = Math.max(
      0,
      Math.floor((new Date(currentHold.expiresAt).getTime() - Date.now()) / 1000)
    );
    holdCountdownEl.textContent = remaining;

    if (remaining <= 0) {
      clearInterval(countdownInterval);
      showMessage("Hold expired", "error");
      clearHold();
      fetchSeats();
    }
  };

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function clearHold() {
  currentHold = null;
  holdInfoEl.classList.add("hidden");
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  updateControls();
}

// ---------- Inventory ----------
function updateInventory() {
  let available = 0,
    held = 0,
    booked = 0;
  for (const seat of seats) {
    if (seat.status === "available") available++;
    else if (seat.status === "held") held++;
    else if (seat.status === "booked") booked++;
  }
  invAvailable.textContent = `Available: ${available}`;
  invHeld.textContent = `Held: ${held}`;
  invBooked.textContent = `Booked: ${booked}`;
  invTotal.textContent = `Total: ${available + held + booked}`;
}

// ---------- Messages ----------
function showMessage(msg, type = "info") {
  statusMessageEl.textContent = msg;
  statusMessageEl.className = type;
  statusMessageEl.classList.remove("hidden");
  setTimeout(() => {
    statusMessageEl.classList.add("hidden");
  }, 5000);
}

function hideMessage() {
  statusMessageEl.classList.add("hidden");
}

// ---------- SSE ----------
function connectSSE() {
  const evtSource = new EventSource(SSE_URL);

  evtSource.addEventListener("seat-update", (event) => {
    try {
      const updatedSeat = JSON.parse(event.data);
      const idx = seats.findIndex((s) => s.id === updatedSeat.id);
      if (idx >= 0) {
        seats[idx] = { ...seats[idx], ...updatedSeat };
      } else {
        seats.push(updatedSeat);
      }
      renderSeatMap();
      updateInventory();
    } catch (e) {
      console.error("SSE parse error:", e);
    }
  });

  evtSource.addEventListener("connected", () => {
    console.log("SSE connected");
  });

  evtSource.onerror = () => {
    console.warn("SSE connection lost, reconnecting...");
    evtSource.close();
    setTimeout(connectSSE, 3000);
  };
}

// ---------- Init ----------
fetchSeats().then(() => {
  updateControls();
  connectSSE();
});
