import { useState } from 'react';
import { Input } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';

type RGB = [number, number, number];
type ColorField = 'hex' | 'rgb' | 'hsl' | 'hwb' | 'lch' | 'cmyk' | 'name';
type ColorValues = Record<ColorField, string>;

const COLOR_FIELDS: ColorField[] = ['hex', 'rgb', 'hsl', 'hwb', 'lch', 'cmyk', 'name'];
const CSS_COLOR_NAMES = `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgrey darkgreen darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray grey green greenyellow honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgrey lightgreen lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen`.split(' ');
const CSS_COLOR_CACHE = new Map<string, RGB | null>();
let cssColorContext: CanvasRenderingContext2D | null | undefined;

const clamp = (value: number, min = 0, max = 255) => Math.max(min, Math.min(max, value));
const hueWrap = (hue: number) => ((hue % 360) + 360) % 360;

function themeColor(): RGB {
  const channels = getComputedStyle(document.documentElement).getPropertyValue('--ui-accent').trim().split(/\s+/).map(Number);
  return channels.length === 3 && channels.every(Number.isFinite) ? channels.map((channel) => clamp(channel)) as RGB : [17, 24, 39];
}

function hexToRgb(hex: string): RGB {
  const normalized = hex.replace(/^#/, '');
  const expanded = normalized.length === 3 ? [...normalized].map((part) => part + part).join('') : normalized;
  return [0, 2, 4].map((index) => Number.parseInt(expanded.slice(index, index + 2), 16)) as RGB;
}

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const h = hueWrap(hue) / 360, s = clamp(saturation, 0, 100) / 100, l = clamp(lightness, 0, 100) / 100;
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}

function rgbToHsl([red, green, blue]: RGB): [number, number, number] {
  const r = red / 255, g = green / 255, b = blue / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  let hue = 0;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (delta) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
  }
  return [Math.round(hueWrap(hue * 60)), Math.round(saturation * 100), Math.round(lightness * 100)];
}

function srgbToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const channel = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(clamp(channel * 255));
}

function rgbToLch(rgb: RGB): [number, number, number] {
  const [r, g, b] = rgb.map(srgbToLinear);
  const x = (0.4124564 * r! + 0.3575761 * g! + 0.1804375 * b!) / 0.95047;
  const y = 0.2126729 * r! + 0.7151522 * g! + 0.072175 * b!;
  const z = (0.0193339 * r! + 0.119192 * g! + 0.9503041 * b!) / 1.08883;
  const delta = 6 / 29;
  const f = (value: number) => value > delta ** 3 ? Math.cbrt(value) : value / (3 * delta ** 2) + 4 / 29;
  const fx = f(x), fy = f(y), fz = f(z);
  const l = 116 * fy - 16, a = 500 * (fx - fy), labB = 200 * (fy - fz);
  return [l, Math.hypot(a, labB), hueWrap(Math.atan2(labB, a) * 180 / Math.PI)];
}

function lchToRgb(lightness: number, chroma: number, hue: number): RGB {
  const radians = hueWrap(hue) * Math.PI / 180;
  const a = chroma * Math.cos(radians), labB = chroma * Math.sin(radians);
  const fy = (lightness + 16) / 116, fx = fy + a / 500, fz = fy - labB / 200;
  const delta = 6 / 29;
  const inverse = (value: number) => value > delta ? value ** 3 : 3 * delta ** 2 * (value - 4 / 29);
  const x = 0.95047 * inverse(fx), y = inverse(fy), z = 1.08883 * inverse(fz);
  return [
    linearToSrgb(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    linearToSrgb(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    linearToSrgb(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}

function parseParts(value: string, name: string, expected = 3): number[] | null {
  const match = value.trim().match(new RegExp(`^${name}\\((.*)\\)$`, 'i'));
  if (!match) return null;
  const parts = match[1]!.trim().split(/[\s,/]+/).filter(Boolean).map((part) => Number.parseFloat(part));
  return parts.length === expected && parts.every(Number.isFinite) ? parts : null;
}

function cssNamedColorRgb(name: string): RGB | null {
  const key = name.trim().toLowerCase();
  if (CSS_COLOR_CACHE.has(key)) return CSS_COLOR_CACHE.get(key) ?? null;
  if (typeof document === 'undefined' || !key || key === 'transparent') return null;
  if (cssColorContext === undefined) cssColorContext = document.createElement('canvas').getContext('2d');
  if (!cssColorContext) return null;
  cssColorContext.fillStyle = '#010203';
  cssColorContext.fillStyle = key;
  const normalized = cssColorContext.fillStyle;
  if (normalized === '#010203' && key !== '#010203') { CSS_COLOR_CACHE.set(key, null); return null; }
  const hex = normalized.match(/^#([\da-f]{6})$/i);
  const rgb = hex ? hexToRgb(hex[1]!) : normalized.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  const result = hex ? hexToRgb(hex[1]!) : rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] as RGB : null;
  CSS_COLOR_CACHE.set(key, result);
  return result;
}

function parseColor(field: ColorField, value: string): RGB | null {
  const text = value.trim();
  if (field === 'hex' || (field === 'name' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(text))) {
    if (!/^#?(?:[\da-f]{3}|[\da-f]{6})$/i.test(text)) return null;
    return hexToRgb(text);
  }
  if (field === 'rgb') {
    const match = text.match(/^rgba?\((.*)\)$/i);
    if (!match) return null;
    const parts = match[1]!.trim().split(/[\s,/]+/).filter(Boolean);
    if (parts.length !== 3) return null;
    const channels = parts.map((part) => part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number(part));
    return channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255) ? channels.map(Math.round) as RGB : null;
  }
  if (field === 'hsl') {
    const values = parseParts(text, 'hsla?');
    return values && values[1]! >= 0 && values[1]! <= 100 && values[2]! >= 0 && values[2]! <= 100 ? hslToRgb(values[0]!, values[1]!, values[2]!) : null;
  }
  if (field === 'hwb') {
    const values = parseParts(text, 'hwb');
    if (!values || values[1]! < 0 || values[1]! > 100 || values[2]! < 0 || values[2]! > 100) return null;
    const white = values[1]! / 100, black = values[2]! / 100;
    if (white + black >= 1) { const gray = Math.round(255 * white / (white + black)); return [gray, gray, gray]; }
    const pure = hslToRgb(values[0]!, 100, 50);
    return pure.map((channel) => Math.round(channel * (1 - white - black) + 255 * white)) as RGB;
  }
  if (field === 'lch') {
    const values = parseParts(text, 'lch');
    return values && values[0]! >= 0 && values[0]! <= 100 && values[1]! >= 0 ? lchToRgb(values[0]!, values[1]!, values[2]!) : null;
  }
  if (field === 'cmyk') {
    const values = parseParts(text, 'cmyk', 4);
    if (!values || values.some((part) => part < 0 || part > 100)) return null;
    const [c, m, y, k] = values.map((part) => part / 100);
    return [Math.round(255 * (1 - c!) * (1 - k!)), Math.round(255 * (1 - m!) * (1 - k!)), Math.round(255 * (1 - y!) * (1 - k!))];
  }
  if (field === 'name') {
    return cssNamedColorRgb(text);
  }
  return null;
}

function closestName(rgb: RGB): string {
  let bestName = 'custom', bestDistance = Infinity;
  for (const name of CSS_COLOR_NAMES) {
    const candidate = cssNamedColorRgb(name);
    if (!candidate) continue;
    const distance = (rgb[0] - candidate[0]) ** 2 + (rgb[1] - candidate[1]) ** 2 + (rgb[2] - candidate[2]) ** 2;
    if (distance < bestDistance) { bestName = name; bestDistance = distance; }
  }
  return bestDistance < 75 ** 2 ? bestName : 'custom';
}

function formatColor(rgb: RGB): ColorValues {
  const [r, g, b] = rgb;
  const hex = `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  const [h, s, l] = rgbToHsl(rgb);
  const [lightness, chroma, hue] = rgbToLch(rgb);
  const max = Math.max(...rgb), min = Math.min(...rgb);
  const k = 1 - max / 255;
  const cmyk = k >= 1 ? [0, 0, 0, 100] : [((1 - r / 255 - k) / (1 - k)) * 100, ((1 - g / 255 - k) / (1 - k)) * 100, ((1 - b / 255 - k) / (1 - k)) * 100, k * 100];
  return {
    hex,
    rgb: `rgb(${r}, ${g}, ${b})`,
    hsl: `hsl(${h}, ${s}%, ${l}%)`,
    hwb: `hwb(${h}, ${Math.round(min / 255 * 100)}%, ${Math.round((1 - max / 255) * 100)}%)`,
    lch: `lch(${lightness.toFixed(2)} ${chroma.toFixed(2)} ${hue.toFixed(2)})`,
    cmyk: `cmyk(${cmyk.map((part) => `${Math.round(part)}%`).join(', ')})`,
    name: closestName(rgb),
  };
}

export function ColorPickerPanel() {
  const { t } = useI18n();
  const [rgb, setRgb] = useState<RGB>(themeColor);
  const [values, setValues] = useState<ColorValues>(() => formatColor(themeColor()));
  const pickerHex = formatColor(rgb).hex;

  const updateColor = (next: RGB) => {
    setRgb(next);
    setValues(formatColor(next));
  };

  const editValue = (field: ColorField, value: string) => {
    setValues((previous) => ({ ...previous, [field]: value }));
    const parsed = parseColor(field, value);
    if (parsed) updateColor(parsed);
  };

  const restoreValue = (field: ColorField) => {
    if (!parseColor(field, values[field])) setValues((previous) => ({ ...previous, [field]: formatColor(rgb)[field] }));
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface p-4 shadow-card sm:p-6">
      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-raised px-4 py-3.5">
        <span className="text-[12px] font-medium text-muted">{t('colorPicker.picker')}</span>
        <input
          type="color"
          aria-label={t('colorPicker.chooseColor')}
          value={pickerHex}
          onChange={(event) => updateColor(hexToRgb(event.target.value))}
          className="h-9 w-10 shrink-0 cursor-pointer rounded border border-line bg-white p-1"
        />
        <span aria-label={`${t('colorPicker.preview')}: ${pickerHex}`} className="h-10 w-10 shrink-0 rounded-md border border-black/10 shadow-sm" style={{ backgroundColor: pickerHex }} />
        <code className="font-mono text-[14px] font-semibold tracking-wide text-ink">{pickerHex}</code>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2 sm:gap-y-6">
        {COLOR_FIELDS.map((field) => (
          <label key={field} className="block min-w-0">
            <span className="mb-1.5 block text-[11.5px] font-medium text-muted">{t(`colorPicker.field.${field}`)}</span>
            <Input
              value={values[field]}
              onChange={(event) => editValue(field, event.target.value)}
              onBlur={() => restoreValue(field)}
              autoComplete="off"
              spellCheck={false}
              aria-label={t(`colorPicker.field.${field}`)}
              className="h-10 font-mono text-[12.5px]"
            />
          </label>
        ))}
      </div>
    </section>
  );
}
