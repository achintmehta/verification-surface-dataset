import { getSettings, putSettings } from './api.js';
import { redrawTimeseriesChart } from './components/timeseriesChart.js';

/**
 * Apply a theme to the document root.
 * @param {'light'|'dark'} theme
 */
export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

/**
 * Initialise the theme toggle button.
 * Fetches the persisted theme, applies it, and wires up the toggle.
 */
export async function initTheme() {
  // Fetch persisted preference
  let theme = 'light';
  try {
    const settings = await getSettings();
    theme = settings.theme === 'dark' ? 'dark' : 'light';
  } catch {
    // If the server is unreachable, fall back to light
    theme = 'light';
  }

  applyTheme(theme);

  const btn = document.getElementById('theme-toggle');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';

    // Apply immediately for snappy UX
    applyTheme(next);

    // Redraw chart with new colours
    redrawTimeseriesChart();

    // Persist to server (best-effort)
    try {
      await putSettings({ theme: next });
    } catch (err) {
      console.warn('[theme] failed to persist theme:', err);
    }
  });
}
