export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'call9me:theme';
const THEME_COLORS: Record<Theme, string> = { light: '#f3f5fb', dark: '#0b0e1a' };

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

/** The theme in effect: an explicit choice on <html data-theme>, else the system setting. */
export function currentTheme(): Theme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === 'light' || chosen === 'dark') return chosen;
  return systemDark.matches ? 'dark' : 'light';
}

function syncThemeColor(): void {
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.removeAttribute('media');
    meta.content = THEME_COLORS[currentTheme()];
  }
}

/**
 * Wires a light/dark toggle button. The initial theme is applied before first paint
 * by the inline script in views/partials/head.ejs; this keeps it in sync afterwards.
 */
export function bindThemeToggle(button: HTMLButtonElement): void {
  const render = () => {
    const dark = currentTheme() === 'dark';
    button.classList.toggle('is-dark', dark);
    const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
    button.title = label;
    button.setAttribute('aria-label', label);
    syncThemeColor();
  };

  button.addEventListener('click', () => {
    const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisted (private mode); the toggle still works for this page.
    }
    render();
  });
  systemDark.addEventListener('change', render);
  render();
}
