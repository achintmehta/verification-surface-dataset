/**
 * UI helpers – panel visibility, notifications, countdown timer.
 */

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/** @param {'hold'|'active-hold'|'booked'|null} name */
export function showPanel(name) {
  const panels = {
    hold: document.getElementById('hold-panel'),
    'active-hold': document.getElementById('active-hold-panel'),
    booked: document.getElementById('booked-panel'),
  };
  const actionPanel = document.getElementById('action-panel');

  // Hide all panels first.
  for (const p of Object.values(panels)) {
    if (p) { p.classList.remove('visible'); p.classList.add('hidden'); }
  }

  if (name && panels[name]) {
    actionPanel?.classList.remove('hidden');
    panels[name].classList.remove('hidden');
    panels[name].classList.add('visible');
  } else {
    actionPanel?.classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

let _notifTimer = null;

/**
 * Show a notification banner.
 *
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} [type]
 * @param {number} [durationMs]  0 = persistent
 */
export function notify(message, type = 'info', durationMs = 4000) {
  const el = document.getElementById('notification');
  if (!el) return;

  el.textContent = message;
  el.className = `notification ${type}`;
  el.classList.remove('hidden');

  if (_notifTimer) clearTimeout(_notifTimer);
  if (durationMs > 0) {
    _notifTimer = setTimeout(() => el.classList.add('hidden'), durationMs);
  }
}

export function clearNotification() {
  const el = document.getElementById('notification');
  if (el) el.classList.add('hidden');
  if (_notifTimer) { clearTimeout(_notifTimer); _notifTimer = null; }
}

// ---------------------------------------------------------------------------
// Countdown timer
// ---------------------------------------------------------------------------

let _countdownInterval = null;

/**
 * Start a live countdown to `expiresAt` in the #hold-countdown element.
 * Calls `onExpired` when the countdown reaches zero.
 *
 * @param {string|Date} expiresAt
 * @param {() => void} onExpired
 */
export function startCountdown(expiresAt, onExpired) {
  stopCountdown();

  const el = document.getElementById('hold-countdown');
  if (!el) return;

  const expiry = new Date(expiresAt);

  function tick() {
    const remaining = Math.max(0, Math.floor((expiry - Date.now()) / 1000));
    const mins = Math.floor(remaining / 60);
    const secs = remaining % 60;
    el.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;

    if (remaining <= 10) {
      el.classList.add('urgent');
    } else {
      el.classList.remove('urgent');
    }

    if (remaining === 0) {
      stopCountdown();
      onExpired();
    }
  }

  tick();
  _countdownInterval = setInterval(tick, 1000);
}

export function stopCountdown() {
  if (_countdownInterval) {
    clearInterval(_countdownInterval);
    _countdownInterval = null;
  }
  const el = document.getElementById('hold-countdown');
  if (el) { el.textContent = ''; el.classList.remove('urgent'); }
}

// ---------------------------------------------------------------------------
// Selection count
// ---------------------------------------------------------------------------

/** @param {number} count */
export function updateSelectionCount(count) {
  const el = document.getElementById('selected-count');
  if (el) el.textContent = `${count} seat${count !== 1 ? 's' : ''} selected`;

  const btn = document.getElementById('btn-hold');
  if (btn) btn.disabled = count === 0;
}
