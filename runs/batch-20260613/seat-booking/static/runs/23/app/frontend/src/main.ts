// ─── Types ───────────────────────────────────────────────────────────────────

interface Seat {
  id: number;
  rowLabel: string;
  seatNumber: number;
  status: "available" | "held" | "booked";
  holdId: string | null;
  holdExpiresAt: string | null;
  bookedBy: string | null;
}

interface HoldResponse {
  hold: {
    id: string;
    sessionId: string;
    seatIds: number[];
    expiresAt: string;
    status: string;
  };
}

interface SeatUpdate {
  seatId: number;
  rowLabel: string;
  seatNumber: number;
  status: "available" | "held" | "booked";
  holdId: string | null;
  holdExpiresAt: string | null;
}

// ─── State ───────────────────────────────────────────────────────────────────

const sessionId = crypto.randomUUID();
let seats: Map<number, Seat> = new Map();
let selectedSeatIds: Set<number> = new Set();
let currentHold: HoldResponse["hold"] | null = null;
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let eventSource: EventSource | null = null;

// ─── API ─────────────────────────────────────────────────────────────────────

const API_BASE = "/api";

async function fetchSeats(): Promise<Seat[]> {
  const res = await fetch(`${API_BASE}/seats`);
  const data = await res.json();
  return data.seats;
}

async function requestHold(seatIds: number[]): Promise<HoldResponse> {
  const res = await fetch(`${API_BASE}/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seatIds, sessionId }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw { status: res.status, ...err };
  }

  return res.json();
}

async function confirmHold(holdId: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const err = await res.json();
    throw { status: res.status, ...err };
  }

  return res.json();
}

async function releaseHold(holdId: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const err = await res.json();
    throw { status: res.status, ...err };
  }

  return res.json();
}

// ─── SSE ─────────────────────────────────────────────────────────────────────

function connectSSE(): void {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.addEventListener("connected", () => {
    const el = document.getElementById("connection-status")!;
    el.textContent = "● Connected";
    el.className = "connected";
  });

  eventSource.addEventListener("seat-updates", (event: MessageEvent) => {
    const updates: SeatUpdate[] = JSON.parse(event.data);
    for (const update of updates) {
      const seat = seats.get(update.seatId);
      if (seat) {
        seat.status = update.status;
        seat.holdId = update.holdId;
        seat.holdExpiresAt = update.holdExpiresAt;

        // If our held seat was released by expiry or someone else
        if (
          currentHold &&
          currentHold.seatIds.includes(update.seatId) &&
          update.status === "available" &&
          update.holdId === null
        ) {
          // Our hold expired
          handleHoldExpired();
        }
      }
    }
    renderSeatMap();
    updateInventory();
  });

  eventSource.onerror = () => {
    const el = document.getElementById("connection-status")!;
    el.textContent = "● Disconnected";
    el.className = "disconnected";
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderSeatMap(): void {
  const container = document.getElementById("seat-map")!;
  container.innerHTML = "";

  // Add legend
  const legend = document.createElement("div");
  legend.className = "legend";
  legend.innerHTML = `
    <div class="legend-item"><div class="legend-swatch available"></div> Available</div>
    <div class="legend-item"><div class="legend-swatch selected"></div> Selected</div>
    <div class="legend-item"><div class="legend-swatch held"></div> Held</div>
    <div class="legend-item"><div class="legend-swatch booked"></div> Booked</div>
  `;
  container.appendChild(legend);

  // Group seats by row
  const rows = new Map<string, Seat[]>();
  for (const seat of seats.values()) {
    if (!rows.has(seat.rowLabel)) {
      rows.set(seat.rowLabel, []);
    }
    rows.get(seat.rowLabel)!.push(seat);
  }

  // Sort rows
  const sortedRowLabels = [...rows.keys()].sort();

  for (const rowLabel of sortedRowLabels) {
    const rowSeats = rows.get(rowLabel)!;
    rowSeats.sort((a, b) => a.seatNumber - b.seatNumber);

    const rowDiv = document.createElement("div");
    rowDiv.className = "seat-row";

    const label = document.createElement("div");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowDiv.appendChild(label);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = `seat ${seat.status}`;
      seatEl.textContent = String(seat.seatNumber);
      seatEl.dataset.seatId = String(seat.id);

      // Check if this is our selected seat
      if (selectedSeatIds.has(seat.id) && seat.status === "available") {
        seatEl.classList.add("selected");
      }

      // Check if this is our held seat
      if (
        currentHold &&
        currentHold.seatIds.includes(seat.id) &&
        seat.status === "held"
      ) {
        seatEl.classList.add("mine");
      }

      seatEl.addEventListener("click", () => handleSeatClick(seat));
      rowDiv.appendChild(seatEl);
    }

    // Right label
    const rightLabel = document.createElement("div");
    rightLabel.className = "row-label";
    rightLabel.textContent = rowLabel;
    rowDiv.appendChild(rightLabel);

    container.appendChild(rowDiv);
  }
}

function updateInventory(): void {
  let available = 0;
  let held = 0;
  let booked = 0;

  for (const seat of seats.values()) {
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

  const el = document.getElementById("inventory-count")!;
  el.textContent = `Available: ${available} | Held: ${held} | Booked: ${booked} | Total: ${available + held + booked}`;
}

function updateSelectionPanel(): void {
  const panel = document.getElementById("selection-panel")!;
  const list = document.getElementById("selected-seats-list")!;
  const btn = document.getElementById("btn-hold") as HTMLButtonElement;

  if (selectedSeatIds.size === 0 || currentHold) {
    panel.classList.add("hidden");
    return;
  }

  panel.classList.remove("hidden");

  const seatLabels = [...selectedSeatIds]
    .map((id) => {
      const seat = seats.get(id);
      return seat ? `${seat.rowLabel}${seat.seatNumber}` : `#${id}`;
    })
    .sort();

  list.textContent = `Seats: ${seatLabels.join(", ")}`;
  btn.disabled = selectedSeatIds.size === 0;
}

function showHoldPanel(): void {
  if (!currentHold) return;

  document.getElementById("selection-panel")!.classList.add("hidden");
  document.getElementById("booking-panel")!.classList.add("hidden");
  document.getElementById("error-panel")!.classList.add("hidden");

  const panel = document.getElementById("hold-panel")!;
  panel.classList.remove("hidden");

  const seatLabels = currentHold.seatIds
    .map((id) => {
      const seat = seats.get(id);
      return seat ? `${seat.rowLabel}${seat.seatNumber}` : `#${id}`;
    })
    .sort();

  document.getElementById("hold-info")!.textContent =
    `Holding seats: ${seatLabels.join(", ")}`;

  startCountdown();
}

function startCountdown(): void {
  if (countdownInterval) clearInterval(countdownInterval);

  const update = () => {
    if (!currentHold) return;

    const remaining = Math.max(
      0,
      Math.ceil((new Date(currentHold.expiresAt).getTime() - Date.now()) / 1000)
    );

    const el = document.getElementById("hold-countdown")!;
    el.textContent = `⏱ ${remaining}s remaining`;

    if (remaining <= 5) {
      el.classList.add("urgent");
    } else {
      el.classList.remove("urgent");
    }

    if (remaining <= 0) {
      handleHoldExpired();
    }
  };

  update();
  countdownInterval = setInterval(update, 250);
}

function handleHoldExpired(): void {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  currentHold = null;
  selectedSeatIds.clear();

  document.getElementById("hold-panel")!.classList.add("hidden");
  showError("Your hold has expired. The seats are available again.");

  // Refresh seat map
  loadSeats();
}

function showBookingConfirmation(seatIds: number[]): void {
  document.getElementById("hold-panel")!.classList.add("hidden");
  document.getElementById("selection-panel")!.classList.add("hidden");
  document.getElementById("error-panel")!.classList.add("hidden");

  const panel = document.getElementById("booking-panel")!;
  panel.classList.remove("hidden");

  const seatLabels = seatIds
    .map((id) => {
      const seat = seats.get(id);
      return seat ? `${seat.rowLabel}${seat.seatNumber}` : `#${id}`;
    })
    .sort();

  document.getElementById("booking-info")!.textContent =
    `Seats booked: ${seatLabels.join(", ")}`;
}

function showError(message: string, conflictingSeatIds?: number[]): void {
  const panel = document.getElementById("error-panel")!;
  panel.classList.remove("hidden");

  let text = message;
  if (conflictingSeatIds && conflictingSeatIds.length > 0) {
    const labels = conflictingSeatIds
      .map((id) => {
        const seat = seats.get(id);
        return seat ? `${seat.rowLabel}${seat.seatNumber}` : `#${id}`;
      })
      .sort();
    text += ` Conflicting seats: ${labels.join(", ")}`;

    // Flash the conflicting seats
    for (const seatId of conflictingSeatIds) {
      const el = document.querySelector(`[data-seat-id="${seatId}"]`);
      if (el) {
        el.classList.add("conflict");
        setTimeout(() => el.classList.remove("conflict"), 1500);
      }
    }
  }

  document.getElementById("error-message")!.textContent = text;
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

function handleSeatClick(seat: Seat): void {
  // If we have an active hold or booking, don't allow new selection
  if (currentHold) return;

  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateSelectionPanel();
}

async function handleHoldClick(): Promise<void> {
  if (selectedSeatIds.size === 0) return;

  const seatIds = [...selectedSeatIds];

  try {
    const btn = document.getElementById("btn-hold") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Holding...";

    const response = await requestHold(seatIds);
    currentHold = response.hold;

    // Refresh seat map to get latest state
    await loadSeats();
    showHoldPanel();
  } catch (err: unknown) {
    const error = err as { status?: number; conflictingSeatIds?: number[]; error?: string };
    if (error.status === 409 && error.conflictingSeatIds) {
      showError(
        "Some seats are no longer available.",
        error.conflictingSeatIds
      );
      // Remove conflicting seats from selection
      for (const id of error.conflictingSeatIds) {
        selectedSeatIds.delete(id);
      }
      // Refresh seats
      await loadSeats();
      updateSelectionPanel();
    } else {
      showError(error.error || "Failed to hold seats.");
    }
  } finally {
    const btn = document.getElementById("btn-hold") as HTMLButtonElement;
    btn.disabled = false;
    btn.textContent = "Hold Selected Seats";
  }
}

async function handleConfirmClick(): Promise<void> {
  if (!currentHold) return;

  try {
    const btn = document.getElementById("btn-confirm") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "Confirming...";

    await confirmHold(currentHold.id);

    const bookedSeatIds = [...currentHold.seatIds];

    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    currentHold = null;
    selectedSeatIds.clear();

    // Refresh seat map
    await loadSeats();
    showBookingConfirmation(bookedSeatIds);
  } catch (err: unknown) {
    const error = err as { status?: number; error?: string };
    if (error.status === 410) {
      handleHoldExpired();
    } else {
      showError(error.error || "Failed to confirm booking.");
    }
  } finally {
    const btn = document.getElementById("btn-confirm") as HTMLButtonElement;
    btn.disabled = false;
    btn.textContent = "Confirm Booking";
  }
}

async function handleReleaseClick(): Promise<void> {
  if (!currentHold) return;

  try {
    await releaseHold(currentHold.id);

    if (countdownInterval) {
      clearInterval(countdownInterval);
      countdownInterval = null;
    }

    currentHold = null;
    selectedSeatIds.clear();

    document.getElementById("hold-panel")!.classList.add("hidden");

    // Refresh seat map
    await loadSeats();
  } catch (err: unknown) {
    const error = err as { error?: string };
    showError(error.error || "Failed to release hold.");
  }
}

function handleNewBooking(): void {
  document.getElementById("booking-panel")!.classList.add("hidden");
  document.getElementById("error-panel")!.classList.add("hidden");
  currentHold = null;
  selectedSeatIds.clear();
  renderSeatMap();
  updateSelectionPanel();
}

function handleDismissError(): void {
  document.getElementById("error-panel")!.classList.add("hidden");
}

// ─── Initialization ──────────────────────────────────────────────────────────

async function loadSeats(): Promise<void> {
  const seatList = await fetchSeats();
  seats.clear();
  for (const seat of seatList) {
    seats.set(seat.id, seat);
  }
  renderSeatMap();
  updateInventory();
  updateSelectionPanel();
}

async function init(): Promise<void> {
  // Wire up event handlers
  document
    .getElementById("btn-hold")!
    .addEventListener("click", handleHoldClick);
  document
    .getElementById("btn-confirm")!
    .addEventListener("click", handleConfirmClick);
  document
    .getElementById("btn-release")!
    .addEventListener("click", handleReleaseClick);
  document
    .getElementById("btn-new-booking")!
    .addEventListener("click", handleNewBooking);
  document
    .getElementById("btn-dismiss-error")!
    .addEventListener("click", handleDismissError);

  // Load seats
  await loadSeats();

  // Connect SSE
  connectSSE();
}

init().catch(console.error);
