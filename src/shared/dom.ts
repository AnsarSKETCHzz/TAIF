/** Colour and contrast helpers shared by the page scanner and the enhancer (DOM required). */

export type Rgba = [number, number, number, number];

export function parseColor(value: string): Rgba | null {
  const match = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i);
  if (!match) return null;
  const alpha = match[4] === undefined ? 1 : match[4].endsWith("%") ? Number.parseFloat(match[4]) / 100 : Number(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

export function blend(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1];
}

/**
 * The colour actually behind an element: walks up the ancestors, compositing translucent
 * backgrounds, until it reaches an opaque one. Returns `image` when a background image or
 * gradient is in the way, because contrast cannot be measured against it.
 */
export function effectiveBackground(element: Element): { color?: Rgba; image: boolean } {
  const layers: Rgba[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.backgroundImage && style.backgroundImage !== "none") return { image: true };
    const color = parseColor(style.backgroundColor);
    if (color && color[3] > 0) {
      layers.push(color);
      if (color[3] >= 0.99) break;
    }
  }
  let result: Rgba = [255, 255, 255, 1];
  if (layers.length && layers[layers.length - 1][3] >= 0.99) result = layers.pop()!;
  for (const layer of layers.reverse()) result = blend(layer, result);
  return { color: result, image: false };
}

export function luminance(color: Rgba): number {
  return color.slice(0, 3).map((part) => {
    const channel = part / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = foreground[3] < 1 ? blend(foreground, background) : foreground;
  const values = [luminance(fg), luminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

export function contrastOf(element: Element): { contrast?: number; image: boolean; fg: string; bg: string } {
  const style = getComputedStyle(element);
  const fg = parseColor(style.color);
  const bg = effectiveBackground(element);
  if (!fg || bg.image || !bg.color) return { image: bg.image, fg: style.color, bg: "image" };
  return { contrast: contrastRatio(fg, bg.color), image: false, fg: style.color, bg: `rgb(${bg.color.slice(0, 3).map(Math.round).join(", ")})` };
}
