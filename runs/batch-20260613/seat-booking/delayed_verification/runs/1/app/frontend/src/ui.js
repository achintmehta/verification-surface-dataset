/**
 * ui.js – Manages the action panel, notification bar, inventory, and countdown.
 */

import { getState } from './store.js';

// ── Panel elements ─────────────────────────────────────────────────────────
const defaultPanel     = document.getElementById('default-panel');
const holdPanel        = document.getElementById('hold-panel');
const activeHoldPanel  = document.getElementById('active-hold-panel');
const bookedPanel      = document.getElementById('booked-panel');

const selectedCountEl  = document.getElementById('selected-count');
const selectedListEl   = document.getElementById('selected-seat-list');
const holdSeatListEl   = document.getElementById('hold-seat-list');
const holdCountdownEl  = document.getElementById('hold-countdown');
const bookedSeatListEl = document.getElementById('booked-seat-list');

// ── Notification ───────────────────────────────────────────────────────────
const notifEl = document.getElementById('notification');
let notifTimer = null;

export function showNotification(type, message, durationMs = 5000) {
  notifEl.className = `notification ${type}`;
  notifEl.textContent = message;
  if (notifTimer) clearTimeout(notifTimer);
  if (durationMs > 0) {
    notifTimer = setTimeout(() => {
      notifEl.className = 'notification hidden';
    }, durationMs);
  }
}

export function hideNotification() {
  if (notifTimer) clearTimeout(notifTimer);
  notifEl.className = 'notification hidden';
}

// ── Inventory ──────────────────────────────────────────────────────────────
export function updateInventory() {
  const { seats } = getState();
  let available = 0, held = 0, booked = 0;
  for (const s of seats) {
    if (s.status === 'available') available++;
    else if (s.status === 'held')  held++;
    else if (s.status === 'booked') booked++;
  }
  document.getElementById('inv-available').textContent = available;
  document.getElementById('inv-held').textContent      = held;
  document.getElementById('inv-booked').textContent    = booked;
  document.getElementById('inv-total').textContent     = seats.length;
}

// ── Action panel ───────────────────────────────────────────────────────────
export function renderActionPanel() {
  const { selectedIds, activeHold, booking } = getState();

  // Hide all panels first.
  defaultPanel.classList.add('hidden');
  holdPanel.classList.add('hidden');
  activeHoldPanel.classList.add('hidden');
  bookedPanel.classList.add('hidden');

  if (booking) {
    bookedSeatListEl.textContent = booking.seatIds.join(', ');
    bookedPanel.classList.remove('hidden');
    return;
  }

  if (activeHold) {
    holdSeatListEl.textContent = activeHold.seatIds.join(', ');
    activeHoldPanel.classList.remove('hidden');
    return;
  }

  if (selectedIds.size > 0) {
    selectedCountEl.textContent = selectedIds.size;
    selectedListEl.textContent  = [...selectedIds].sort().join(', ');
    holdPanel.classList.remove('hidden');
    return;
  }

  defaultPanel.classList.remove('hidden');
}

// ── Countdown timer ────────────────────────────────────────────────────────
let countdownInterval = null;

export function startCountdown(expiresAt) {
  stopCountdown();
  countdownInterval = setInterval(() => {
    const remaining = Math.max(0, new Date(expiresAt) - Date.now());
    const secs = Math.ceil(remaining / 1000);
    const mins = Math.floor(secs / 60);
    const s    = secs % 60;
    holdCountdownEl.textContent = `${mins}:${String(s).padStart(2, '0')}`;
    holdCountdownEl.classList.toggle('urgent', secs <= 10);
    if (remaining === 0) stopCountdown();
  }, 500);
}

export function stopCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  holdCountdownEl.textContent = '--';
  holdCountdownEl.classList.remove('urgent');
}
