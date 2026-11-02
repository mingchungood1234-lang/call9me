import { isStandalone } from './push';

/**
 * Installed PWA only: block page zoom (pinch, double-tap, Ctrl +/−/wheel) so the app
 * behaves like a native app. In a normal browser tab zoom stays available for accessibility.
 */
export function lockZoomInStandalone(): void {
  if (!isStandalone()) return;
  document.documentElement.classList.add('standalone');

  // Android/Chrome honour this; iOS mostly ignores it, hence the gesture handlers below.
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) {
    viewport.content =
      'width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  }

  // iOS Safari pinch gestures.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  }
  // Any two-finger move is a pinch.
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );
  // Double-tap zoom is disabled in CSS (`touch-action` on html.standalone), which unlike a
  // touchend handler doesn't swallow quick repeated taps on buttons.
  // Desktop PWA window: Ctrl/⌘ + wheel or trackpad pinch, and Ctrl/⌘ + / − / 0.
  document.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey) e.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
  });
}
