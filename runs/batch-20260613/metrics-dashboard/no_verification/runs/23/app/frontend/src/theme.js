import { putSettings } from './api.js';

let currentTheme = 'light';

export function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

export function getCurrentTheme() {
  return currentTheme;
}

export function setupToggle(onThemeChange) {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const newTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyTheme(newTheme);
    if (onThemeChange) onThemeChange(newTheme);
    try {
      await putSettings({ theme: newTheme });
    } catch (e) {
      console.error('Failed to persist theme:', e);
    }
  });
}
