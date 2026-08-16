/**
 * Theme module – manages light/dark toggle, persists via API.
 */
import { fetchSettings, saveSettings } from './api.js';

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

export async function loadTheme() {
  try {
    const settings = await fetchSettings();
    applyTheme(settings.theme || 'light');
  } catch {
    // Default to light if server is unreachable
    applyTheme('light');
  }
}

export async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
  try {
    await saveSettings({ theme: newTheme });
  } catch (err) {
    console.error('Failed to persist theme:', err);
  }
}

export function initThemeToggle() {
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', toggleTheme);
  }
}
