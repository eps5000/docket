/**
 * Colour maths for the status palette test (B47): WCAG contrast, CIEDE2000
 * and simulated colour-vision deficiency. Pure, with no dependencies.
 */
export type Rgb = readonly [number, number, number];
type Lab = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as unknown as Rgb;
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toGamma = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** The WCAG 2 contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function toLab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
  const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

function hueDeg(b: number, a: number): number {
  if (a === 0 && b === 0) return 0;
  const deg = (Math.atan2(b, a) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** CIEDE2000 between two Lab colours (Sharma, Wu & Dalal 2005). */
export function deltaE2000Lab([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1;
  const ap2 = (1 + G) * a2;
  const C1 = Math.hypot(ap1, b1);
  const C2 = Math.hypot(ap2, b2);
  const h1 = hueDeg(b1, ap1);
  const h2 = hueDeg(b2, ap2);
  const chromatic = C1 * C2 !== 0;

  let dh = 0;
  if (chromatic) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dL = L2 - L1;
  const dC = C2 - C1;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin(rad(dh) / 2);

  const Lm = (L1 + L2) / 2;
  const Cm = (C1 + C2) / 2;
  let hm = h1 + h2;
  if (chromatic) {
    if (Math.abs(h1 - h2) <= 180) hm = (h1 + h2) / 2;
    else hm = h1 + h2 < 360 ? (h1 + h2 + 360) / 2 : (h1 + h2 - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos(rad(hm - 30)) +
    0.24 * Math.cos(rad(2 * hm)) +
    0.32 * Math.cos(rad(3 * hm + 6)) -
    0.2 * Math.cos(rad(4 * hm - 63));
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cm;
  const Sh = 1 + 0.015 * Cm * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

export const deltaE2000 = (a: Rgb, b: Rgb) => deltaE2000Lab(toLab(a), toLab(b));

export type Deficiency = 'deuteranopia' | 'protanopia';

/** Machado, Oliveira & Fernandes (2009), severity 1.0, in linear RGB. */
const CVD: Record<Deficiency, readonly Rgb[]> = {
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
};

export function simulate(rgb: Rgb, kind: Deficiency): Rgb {
  const [r, g, b] = rgb.map(toLinear) as [number, number, number];
  return CVD[kind].map(([x, y, z]) =>
    toGamma(Math.min(1, Math.max(0, x * r + y * g + z * b))),
  ) as unknown as Rgb;
}
