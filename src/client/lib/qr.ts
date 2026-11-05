import qrcode from 'qrcode-generator';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Light border around the code (in modules); scanners need it. */
const QUIET_ZONE = 4;

/** Draws `text` as a QR code (an SVG, always dark on light so cameras can read it) into `container`. */
export function renderQr(container: HTMLElement, text: string): void {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const size = count + QUIET_ZONE * 2;

  let d = '';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
    }
  }
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const background = document.createElementNS(SVG_NS, 'rect');
  background.setAttribute('width', String(size));
  background.setAttribute('height', String(size));
  background.setAttribute('fill', '#fff');
  const modules = document.createElementNS(SVG_NS, 'path');
  modules.setAttribute('d', d);
  modules.setAttribute('fill', '#000');
  svg.append(background, modules);
  container.replaceChildren(svg);
}

/** "ABCD2345" → "ABCD-2345" (easier to read out and type). */
export function formatPairCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}
