export type ImageType = 'png' | 'webp' | 'gif';

/**
 * Decodes an uploaded image data URL, trusting the bytes (magic numbers), not the
 * declared type, so only real PNG / WebP / GIF files are ever stored and served.
 */
export function decodeImage(dataUrl: unknown, maxBytes: number): { type: ImageType; data: Buffer } | null {
  if (typeof dataUrl !== 'string' || dataUrl.length > maxBytes * 1.4 + 100) return null;
  const match = /^data:image\/(?:png|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  const data = Buffer.from(match[1], 'base64');
  if (data.length === 0 || data.length > maxBytes) return null;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'png', data };
  const head = data.subarray(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') return { type: 'gif', data };
  if (data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { type: 'webp', data };
  }
  return null;
}
