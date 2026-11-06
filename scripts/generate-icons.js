// Generates the PWA icons in public/icons and the Android app icons in android/app/src/main/res
// as PNGs, with no image dependencies.
// Usage: npm run icons
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, '..', 'public', 'icons');

// 5×7 bitmap of the "9" glyph.
const GLYPH = ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'];

function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {number} size
 * @param {{ background: boolean, radius: number, glyphScale: number }} opts
 *   radius: corner radius as a fraction of size (0 = square, full bleed);
 *   glyphScale: glyph height as a fraction of size.
 */
function render(size, { background, radius, glyphScale }) {
  const SS = 4; // supersampling for anti-aliasing
  const px = Buffer.alloc(size * size * 4);
  const r = radius * size;
  const glyphH = glyphScale * size;
  const cell = glyphH / GLYPH.length;
  const glyphW = cell * GLYPH[0].length;
  const gx0 = (size - glyphW) / 2;
  const gy0 = (size - glyphH) / 2;

  const insideRounded = (x, y) => {
    if (r === 0) return true;
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };
  const insideGlyph = (x, y) => {
    const col = Math.floor((x - gx0) / cell);
    const row = Math.floor((y - gy0) / cell);
    return row >= 0 && row < GLYPH.length && col >= 0 && col < GLYPH[0].length && GLYPH[row][col] === '#';
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          if (insideRounded(fx, fy)) bg++;
          if (insideGlyph(fx, fy)) fg++;
        }
      }
      bg /= SS * SS;
      fg /= SS * SS;
      const i = (y * size + x) * 4;
      if (background) {
        // Diagonal gradient #6c7cff → #a855f7, glyph in white.
        const t = (x + y) / (2 * size);
        const R = 0x6c + (0xa8 - 0x6c) * t;
        const G = 0x7c + (0x55 - 0x7c) * t;
        const B = 0xff + (0xf7 - 0xff) * t;
        px[i] = Math.round(R + (255 - R) * fg);
        px[i + 1] = Math.round(G + (255 - G) * fg);
        px[i + 2] = Math.round(B + (255 - B) * fg);
        px[i + 3] = Math.round(255 * bg);
      } else {
        // Monochrome badge: white glyph on transparent.
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = Math.round(255 * fg);
      }
    }
  }
  return encodePng(size, px);
}

const ICONS = [
  ['icon-192.png', 192, { background: true, radius: 0.22, glyphScale: 0.55 }],
  ['icon-512.png', 512, { background: true, radius: 0.22, glyphScale: 0.55 }],
  // Maskable: full bleed, glyph inside the 80% safe zone.
  ['icon-maskable-512.png', 512, { background: true, radius: 0, glyphScale: 0.42 }],
  ['apple-touch-icon.png', 180, { background: true, radius: 0, glyphScale: 0.55 }],
  ['badge-72.png', 72, { background: false, radius: 0, glyphScale: 0.7 }],
];

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size, opts] of ICONS) {
  fs.writeFileSync(path.join(OUT, name), render(size, opts));
  console.log(`wrote public/icons/${name}`);
}

// ---- Android app (android/, a Trusted Web Activity): the same icon in Android's formats ----
const RES = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');
// Adaptive icons are 108dp layers of which ~72dp shows: 0.55 × 72/108 keeps the "9" the same size.
const ADAPTIVE_GLYPH = 0.367;
const ANDROID = [
  // Legacy launcher icons (Android 7 and older launchers), square-ish and round.
  ...[
    ['mdpi', 48],
    ['hdpi', 72],
    ['xhdpi', 96],
    ['xxhdpi', 144],
    ['xxxhdpi', 192],
  ].flatMap(([density, size]) => [
    [`mipmap-${density}/ic_launcher.png`, size, { background: true, radius: 0.22, glyphScale: 0.55 }],
    [`mipmap-${density}/ic_launcher_round.png`, size, { background: true, radius: 0.5, glyphScale: 0.5 }],
  ]),
  // Adaptive icon (Android 8+): full-bleed gradient + "9"; monochrome layer for themed icons (13+).
  ['drawable-nodpi/ic_launcher_foreground.png', 432, { background: true, radius: 0, glyphScale: ADAPTIVE_GLYPH }],
  ['drawable-nodpi/ic_launcher_monochrome.png', 432, { background: false, radius: 0, glyphScale: ADAPTIVE_GLYPH }],
  // Status-bar notification icon (24dp, white on transparent).
  ['drawable-xxxhdpi/ic_notification.png', 96, { background: false, radius: 0, glyphScale: 0.7 }],
];
for (const [name, size, opts] of ANDROID) {
  const file = path.join(RES, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, render(size, opts));
  console.log(`wrote android/app/src/main/res/${name}`);
}
