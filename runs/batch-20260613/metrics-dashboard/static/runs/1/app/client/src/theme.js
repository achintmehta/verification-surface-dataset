/**
 * Theme management.
 *
 * - Applies theme to <html data-theme="..."> immediately.
 * - Persists via PUT /api/settings.
 * - On load, reads from GET /api/settings before first paint.
 */

import { api } from './api.js';

let _onThemeChange = null;

/**
 * Apply a theme immediately (no network call).
 * @param {'light'|'dark'} theme
 */
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  // Update toggle button aria-pressed
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
  }
}

/**
 * Persist the theme to the server and apply it.
 * @param {'light'|'dark'} theme
 */
export async function setTheme(theme) {
  applyTheme(theme);
  try {
    await api.putSettings({ theme });
  } catch (err) {
    console.warn('[theme] Failed to persist theme:', err);
  }
  if (_onThemeChange) _onThemeChange(theme);
}

/**
 * Toggle between light and dark.
 */
export async function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') ?? 'light';
  await setTheme(current === 'dark' ? 'light' : 'dark');
}

/**
 * Register a callback invoked whenever the theme changes.
 * Used to redraw the chart with new CSS variable values.
 * @param {(theme: string) => void} fn
 */
export function onThemeChange(fn) {
  _onThemeChange = fn;
}

/**
 * Wire up the toggle button.
 */
export function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => toggleTheme());
}
