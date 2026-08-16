// ─── Types ───────────────────────────────────────────────────────────
interface Seat {
  id: number;
  row_label: string;
  seat_number: number;
  status: "available" | "held" | "booked";
  hold_id: string | null;
  hold_expires_at: string | null;
}

interface HoldResponse {
  holdId: string;
  seats: Seat[];
  expiresAt: string;
}

interface ConfirmResponse {
  holdId: string;
  seats: Seat[];
  confirmedAt: string;
}

interface SeatUpdateEvent {
  type: "seat_update";
  seats: Seat[];
  timestamp: string;
}

// ─── State ───────────────────────────────────────────────────────────
const sessionId = crypto.randomUUID();
let seats: Map<number, Seat> = new Map();
let selectedSeatIds: Set<number> = new Set();
let currentHoldId: string | null = null;
let currentHoldExpiry: Date | null = null;
let heldSeatIds: Set<number> = new Set();
let countdownInterval: ReturnType<typeof setInterval> | null = null;
let eventSource: EventSource | null = null;

// ─── API ─────────────────────────────────────────────────────────────
const API_BASE = "/api";

async function fetchSeats(): Promise<Seat[]> {
  const res = await fetch(`${API_BASE}/seats`);
  if (!res.ok) throw new Error("Failed to fetch seats");
  const data = await res.json();
  return data.seats;
}

async function requestHold(
  seatIds: number[]
): Promise<HoldResponse> {
  const res = await fetch(`${API_BASE}/holds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seatIds, sessionId }),
  });

  if (res.status === 409) {
    const data = await res.json();
    throw new HoldConflictError(data.error, data.conflictingSeatIds || []);
  }

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to hold seats");
  }

  return res.json();
}

async function confirmHold(holdId: string): Promise<ConfirmResponse> {
  const res = await fetch(`${API_BASE}/holds/${holdId}/confirm`, {
    method: "POST",
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to confirm hold");
  }

  return res.json();
}

async function releaseHold(holdId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/holds/${holdId}`, {
    method: "DELETE",
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Failed to release hold");
  }
}

class HoldConflictError extends Error {
  conflictingSeatIds: number[];
  constructor(message: string, conflictingSeatIds: number[]) {
    super(message);
    this.conflictingSeatIds = conflictingSeatIds;
  }
}

// ─── SSE ─────────────────────────────────────────────────────────────
function connectSSE(): void {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`${API_BASE}/stream`);

  eventSource.onopen = () => {
    updateConnectionStatus(true);
  };

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.type === "seat_update") {
        const update = data as SeatUpdateEvent;
        handleSeatUpdate(update.seats);
      }
    } catch (e) {
      console.error("Error parsing SSE message:", e);
    }
  };

  eventSource.onerror = () => {
    updateConnectionStatus(false);
    // EventSource will auto-reconnect
  };
}

function handleSeatUpdate(updatedSeats: Seat[]): void {
  for (const seat of updatedSeats) {
    seats.set(seat.id, seat);

    // If a seat we held or selected was taken by someone else, deselect it
    if (seat.status !== "available" && seat.hold_id !== currentHoldId) {
      selectedSeatIds.delete(seat.id);
    }

    // If our hold expired (seat went back to available), clear our hold state
    if (
      heldSeatIds.has(seat.id) &&
      seat.status === "available" &&
      seat.hold_id === null
    ) {
      heldSeatIds.delete(seat.id);
    }
  }

  // If all our held seats are gone, clear hold state
  if (currentHoldId && heldSeatIds.size === 0) {
    clearHoldState();
  }

  renderSeatMap();
  updateInventory();
  updateButtons();
}

// ─── Rendering ───────────────────────────────────────────────────────
function renderSeatMap(): void {
  const container = document.getElementById("seat-map")!;

  // Group seats by row
  const rowMap = new Map<string, Seat[]>();
  for (const seat of seats.values()) {
    const row = rowMap.get(seat.row_label) || [];
    row.push(seat);
    rowMap.set(seat.row_label, row);
  }

  // Sort rows
  const sortedRows = [...rowMap.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  );

  container.innerHTML = "";

  for (const [rowLabel, rowSeats] of sortedRows) {
    const rowEl = document.createElement("div");
    rowEl.className = "seat-row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = rowLabel;
    rowEl.appendChild(label);

    // Sort seats by number
    rowSeats.sort((a, b) => a.seat_number - b.seat_number);

    for (const seat of rowSeats) {
      const seatEl = document.createElement("div");
      seatEl.className = "seat";
      seatEl.textContent = `${seat.seat_number}`;
      seatEl.dataset.seatId = String(seat.id);

      // Determine visual class
      if (selectedSeatIds.has(seat.id)) {
        seatEl.classList.add("selected");
      } else if (heldSeatIds.has(seat.id)) {
        seatEl.classList.add("held-by-you");
      } else {
        seatEl.classList.add(seat.status);
      }

      // Handle click
      seatEl.addEventListener("click", () => onSeatClick(seat));

      rowEl.appendChild(seatEl);
    }

    // Right-side label
    const labelRight = document.createElement("span");
    labelRight.className = "row-label";
    labelRight.textContent = rowLabel;
    rowEl.appendChild(labelRight);

    container.appendChild(rowEl);
  }
}

function onSeatClick(seat: Seat): void {
  // Can't interact if we already have a hold
  if (currentHoldId) return;

  // Can only select/deselect available seats
  if (seat.status !== "available") return;

  if (selectedSeatIds.has(seat.id)) {
    selectedSeatIds.delete(seat.id);
  } else {
    selectedSeatIds.add(seat.id);
  }

  renderSeatMap();
  updateSelectedSeatsDisplay();
  updateButtons();
}

function updateSelectedSeatsDisplay(): void {
  const container = document.getElementById("selected-seats")!;

  if (selectedSeatIds.size === 0 && heldSeatIds.size === 0) {
    container.innerHTML = '<p class="placeholder">Click seats to select them</p>';
    return;
  }

  const displayIds = currentHoldId ? heldSeatIds : selectedSeatIds;
  const tags = [...displayIds]
    .map((id) => {
      const seat = seats.get(id);
      if (!seat) return "";
      return `<span class="seat-tag">${seat.row_label}${seat.seat_number}</span>`;
    })
    .join("");

  container.innerHTML = tags;
}

function updateButtons(): void {
  const btnHold = document.getElementById("btn-hold") as HTMLButtonElement;
  const btnConfirm = document.getElementById("btn-confirm") as HTMLButtonElement;
  const btnRelease = document.getElementById("btn-release") as HTMLButtonElement;
  const btnClear = document.getElementById("btn-clear") as HTMLButtonElement;

  if (currentHoldId) {
    btnHold.disabled = true;
    btnConfirm.disabled = false;
    btnRelease.style.display = "inline-block";
    btnRelease.disabled = false;
    btnClear.style.display = "none";
  } else {
    btnHold.disabled = selectedSeatIds.size === 0;
    btnConfirm.disabled = true;
    btnRelease.style.display = "none";
    btnClear.style.display = "inline-block";
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

  const total = available + held + booked;

  document.getElementById("inv-available")!.textContent = `Available: ${available}`;
  document.getElementById("inv-held")!.textContent = `Held: ${held}`;
  document.getElementById("inv-booked")!.textContent = `Booked: ${booked}`;
  document.getElementById("inv-total")!.textContent = `Total: ${total}`;
}

function updateConnectionStatus(connected: boolean): void {
  const el = document.getElementById("connection-status")!;
  if (connected) {
    el.className = "connection-status connected";
    el.textContent = "● Connected";
  } else {
    el.className = "connection-status disconnected";
    el.textContent = "● Disconnected";
  }
}

function showError(message: string, conflictingSeatIds?: number[]): void {
  const el = document.getElementById("error-message")!;
  let html = message;

  if (conflictingSeatIds && conflictingSeatIds.length > 0) {
    const seatLabels = conflictingSeatIds
      .map((id) => {
        const seat = seats.get(id);
        return seat ? `${seat.row_label}${seat.seat_number}` : `#${id}`;
      })
      .join(", ");
    html += `<br>Conflicting seats: <strong>${seatLabels}</strong>`;
  }

  el.innerHTML = html;
  el.style.display = "block";

  // Auto-hide after 5 seconds
  setTimeout(() => {
    el.style.display = "none";
  }, 5000);
}

function showSuccess(message: string): void {
  const el = document.getElementById("success-message")!;
  el.textContent = message;
  el.style.display = "block";

  setTimeout(() => {
    el.style.display = "none";
  }, 5000);
}

function hideMessages(): void {
  document.getElementById("error-message")!.style.display = "none";
  document.getElementById("success-message")!.style.display = "none";
}

// ─── Hold Management ─────────────────────────────────────────────────
function startCountdown(): void {
  if (countdownInterval) clearInterval(countdownInterval);

  const holdInfoEl = document.getElementById("hold-info")!;
  const countdownEl = document.getElementById("hold-countdown")!;
  const holdIdEl = document.getElementById("hold-id-display")!;

  holdInfoEl.style.display = "block";
  holdIdEl.textContent = currentHoldId || "--";

  const tick = () => {
    if (!currentHoldExpiry) return;

    const remaining = currentHoldExpiry.getTime() - Date.now();
    if (remaining <= 0) {
      countdownEl.textContent = "EXPIRED";
      clearHoldState();
      // Refresh seats to get latest state
      loadSeats();
      return;
    }

    const seconds = Math.ceil(remaining / 1000);
    countdownEl.textContent = `${seconds}s`;
  };

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function clearHoldState(): void {
  currentHoldId = null;
  currentHoldExpiry = null;
  heldSeatIds.clear();
  selectedSeatIds.clear();

  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  document.getElementById("hold-info")!.style.display = "none";
  updateSelectedSeatsDisplay();
  updateButtons();
  renderSeatMap();
}

// ─── Event Handlers ──────────────────────────────────────────────────
async function onHoldClick(): Promise<void> {
  if (selectedSeatIds.size === 0) return;

  hideMessages();

  try {
    const response = await requestHold([...selectedSeatIds]);

    currentHoldId = response.holdId;
    currentHoldExpiry = new Date(response.expiresAt);
    heldSeatIds = new Set(response.seats.map((s) => s.id));
    selectedSeatIds.clear();

    // Update seats state
    for (const seat of response.seats) {
      seats.set(seat.id, seat);
    }

    renderSeatMap();
    updateSelectedSeatsDisplay();
    updateButtons();
    updateInventory();
    startCountdown();

    showSuccess(
      `Hold acquired! ${heldSeatIds.size} seat(s) held for 60 seconds.`
    );
  } catch (err) {
    if (err instanceof HoldConflictError) {
      showError(err.message, err.conflictingSeatIds);

      // Highlight conflicting seats and deselect them
      for (const id of err.conflictingSeatIds) {
        selectedSeatIds.delete(id);
      }

      // Refresh seats to get latest state
      await loadSeats();
    } else {
      showError(err instanceof Error ? err.message : "Failed to hold seats");
    }
  }
}

async function onConfirmClick(): Promise<void> {
  if (!currentHoldId) return;

  hideMessages();

  try {
    const response = await confirmHold(currentHoldId);

    // Update seats state
    for (const seat of response.seats) {
      seats.set(seat.id, seat);
    }

    showSuccess(
      `Booking confirmed! ${response.seats.length} seat(s) booked.`
    );

    clearHoldState();
    renderSeatMap();
    updateInventory();
  } catch (err) {
    showError(err instanceof Error ? err.message : "Failed to confirm booking");
    clearHoldState();
    await loadSeats();
  }
}

async function onReleaseClick(): Promise<void> {
  if (!currentHoldId) return;

  hideMessages();

  try {
    await releaseHold(currentHoldId);
    showSuccess("Hold released.");
    clearHoldState();
    await loadSeats();
  } catch (err) {
    showError(err instanceof Error ? err.message : "Failed to release hold");
    clearHoldState();
    await loadSeats();
  }
}

function onClearClick(): void {
  selectedSeatIds.clear();
  hideMessages();
  renderSeatMap();
  updateSelectedSeatsDisplay();
  updateButtons();
}

// ─── Init ────────────────────────────────────────────────────────────
async function loadSeats(): Promise<void> {
  try {
    const seatList = await fetchSeats();
    seats.clear();
    for (const seat of seatList) {
      seats.set(seat.id, seat);
    }
    renderSeatMap();
    updateInventory();
    updateButtons();
  } catch (err) {
    console.error("Error loading seats:", err);
    showError("Failed to load seat map");
  }
}

async function init(): Promise<void> {
  // Load seats
  await loadSeats();

  // Connect SSE
  connectSSE();

  // Bind buttons
  document.getElementById("btn-hold")!.addEventListener("click", onHoldClick);
  document
    .getElementById("btn-confirm")!
    .addEventListener("click", onConfirmClick);
  document
    .getElementById("btn-release")!
    .addEventListener("click", onReleaseClick);
  document
    .getElementById("btn-clear")!
    .addEventListener("click", onClearClick);
}

init().catch(console.error);
