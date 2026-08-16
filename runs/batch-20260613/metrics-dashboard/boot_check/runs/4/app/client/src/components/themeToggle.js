import { getSettings, putSettings } from '../api.js';

let currentTheme = 'light';

export async function initThemeToggle() {
  // Fetch persisted theme from server
  const settings = await getSettings();
  currentTheme = settings.theme || 'light';
  applyTheme(currentTheme);

  // Wire up toggle button
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', async () => {
      currentTheme = currentTheme === 'light' ? 'dark' : 'light';
      applyTheme(currentTheme);
      // Persist to server
      await putSettings({ theme: currentTheme });
      // Redraw chart with new theme colors
      window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: currentTheme } }));
    });
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

export function getCurrentTheme() {
  return currentTheme;
}
