import { getSettings, updateSettings } from './api.js';

let currentTheme = 'light';
let onThemeChange = null;

export function setThemeChangeCallback(cb) {
  onThemeChange = cb;
}

export function getCurrentTheme() {
  return currentTheme;
}

export function applyTheme(theme) {
  currentTheme = theme;
  document.documentElement.setAttribute('data-theme', theme);

  const icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = theme === 'dark' ? '🌙' : '☀️';
  }

  if (onThemeChange) {
    onThemeChange(theme);
  }
}

export async function loadTheme() {
  try {
    const settings = await getSettings();
    applyTheme(settings.theme || 'light');
  } catch {
    // Fallback to light theme if API is unavailable
    applyTheme('light');
  }
}

export async function toggleTheme() {
  const newTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);

  try {
    await updateSettings({ theme: newTheme });
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
