/** A box in the dock hint's coordinates, with its corner radius. */
export interface OutlineBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly radius: number;
}

/**
 * Traces the panel's silhouette for the dock hint: the composer, and the narrower drawer
 * standing on it when shown. Only the drawer's top corners are rounded; it meets the
 * composer's top edge in square inner corners.
 */
export function dockOutlinePath(composer: OutlineBox, drawer: OutlineBox | null): string {
  const c = { ...composer, radius: fitRadius(composer) };
  // A narrow panel leaves little shoulder beside the drawer; the composer's top corners shrink to fit.
  const top = drawer
    ? Math.max(0, Math.min(c.radius, drawer.left - c.left, c.right - drawer.right))
    : c.radius;
  const parts = [`M ${num(c.left + top)} ${num(c.top)}`];
  if (drawer) {
    const r = Math.min(drawer.radius, (drawer.right - drawer.left) / 2, c.top - drawer.top);
    parts.push(
      `L ${num(drawer.left)} ${num(c.top)}`,
      `L ${num(drawer.left)} ${num(drawer.top + r)}`,
      arc(r, drawer.left + r, drawer.top),
      `L ${num(drawer.right - r)} ${num(drawer.top)}`,
      arc(r, drawer.right, drawer.top + r),
      `L ${num(drawer.right)} ${num(c.top)}`,
    );
  }
  parts.push(
    `L ${num(c.right - top)} ${num(c.top)}`,
    arc(top, c.right, c.top + top),
    `L ${num(c.right)} ${num(c.bottom - c.radius)}`,
    arc(c.radius, c.right - c.radius, c.bottom),
    `L ${num(c.left + c.radius)} ${num(c.bottom)}`,
    arc(c.radius, c.left, c.bottom - c.radius),
    `L ${num(c.left)} ${num(c.top + top)}`,
    arc(top, c.left + top, c.top),
    'Z',
  );
  return parts.join(' ');
}

function fitRadius(box: OutlineBox): number {
  return Math.max(0, Math.min(box.radius, (box.right - box.left) / 2, (box.bottom - box.top) / 2));
}

function arc(radius: number, x: number, y: number): string {
  return `A ${num(radius)} ${num(radius)} 0 0 1 ${num(x)} ${num(y)}`;
}

function num(value: number): number {
  return Math.round(value * 100) / 100;
}
