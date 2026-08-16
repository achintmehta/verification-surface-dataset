// ── Theme management ──────────────────────────────────────────────────────────

let currentTheme = 'light';

/**
 * Fetch the persisted theme from the server and apply it.
 * Falls back to localStorage if the server is unreachable.
 */
export async function initTheme(apiBase) {
  let theme = 'light';
  try {
    const res = await fetch(`${apiBase}/api/settings`);
    if (res.ok) {
      const data = await res.json();
      theme = data.theme === 'dark' ? 'dark' : 'light';
    }
  } catch {
    // Server offline — fall back to localStorage
    theme = localStorage.getItem('theme') === 'dark' ? 'dark' : 'light';
  }
  applyTheme(theme);
}

/**
 * Apply a theme to the document and update UI chrome.
 */
export function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);

  const label = document.getElementById('theme-label');
  if (label) label.textContent = theme === 'dark' ? 'Dark' : 'Light';
}

/**
 * Wire up the toggle button.
 */
export function setupThemeToggle(apiBase) {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const next = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(next);

    // Persist to server (fire-and-forget, but log errors)
    try {
      await fetch(`${apiBase}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: next }),
      });
    } catch (err) {
      console.warn('[theme] Could not persist theme to server:', err);
    }

    // Re-render the SVG chart so its colours update
    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  });
}

export function getTheme() {
  return currentTheme;
}
