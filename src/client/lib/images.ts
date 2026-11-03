import { el } from './dom';

/**
 * Center-crops a picture to a square and shrinks it to `size` pixels: a small upload
 * that looks right in round avatars. WebP when the browser can make it, else PNG.
 */
export async function squareImage(file: File, size: number, maxBytes: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const out = Math.min(size, side);
    const canvas = el('canvas');
    canvas.width = canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No canvas');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    for (const dataUrl of [canvas.toDataURL('image/webp', 0.88), canvas.toDataURL('image/png')]) {
      if (/^data:image\/(webp|png)/.test(dataUrl) && dataUrl.length * 0.75 <= maxBytes) return dataUrl;
    }
    throw new Error('Too large');
  } finally {
    URL.revokeObjectURL(url);
  }
}
