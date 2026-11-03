/** Colour themes (see styles.css: each sets the hues every brand colour is derived from). */
export const PALETTES = [
  { id: 'violet', label: 'Violet' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'forest', label: 'Forest' },
  { id: 'sunset', label: 'Sunset' },
  { id: 'rose', label: 'Rose' },
  { id: 'graphite', label: 'Graphite' },
] as const;
export type PaletteId = (typeof PALETTES)[number]['id'];
export type TextSize = 'normal' | 'large';

const PALETTE_KEY = 'call9me:palette';
const TEXT_KEY = 'call9me:text';

/** The page applies these before first paint (inline script in partials/head.ejs). */
export function currentPalette(): PaletteId {
  return (document.documentElement.dataset.palette as PaletteId | undefined) ?? 'violet';
}

export function currentTextSize(): TextSize {
  return document.documentElement.dataset.text === 'large' ? 'large' : 'normal';
}

function store(key: string, value: string | null): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Not remembered (private mode); still applied for this visit.
  }
}

export function setPalette(id: PaletteId): void {
  const root = document.documentElement;
  if (id === 'violet') delete root.dataset.palette;
  else root.dataset.palette = id;
  store(PALETTE_KEY, id === 'violet' ? null : id);
}

export function setTextSize(size: TextSize): void {
  const root = document.documentElement;
  if (size === 'large') root.dataset.text = 'large';
  else delete root.dataset.text;
  store(TEXT_KEY, size === 'large' ? 'large' : null);
}
