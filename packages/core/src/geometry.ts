export interface Point {
  x: number;
  y: number;
}

/** Axis-aligned rectangle. `x`/`y` are the top-left corner. */
export interface Rect extends Point {
  width: number;
  height: number;
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function right(r: Rect) {
  return r.x + r.width;
}

export function bottom(r: Rect) {
  return r.y + r.height;
}

export function area(r: Rect) {
  return Math.max(0, r.width) * Math.max(0, r.height);
}

export function isEmpty(r: Rect) {
  return r.width <= 0 || r.height <= 0;
}

export function contains(outer: Rect, inner: Rect) {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    right(inner) <= right(outer) &&
    bottom(inner) <= bottom(outer)
  );
}

export function containsPoint(r: Rect, p: Point) {
  return p.x >= r.x && p.y >= r.y && p.x < right(r) && p.y < bottom(r);
}

/** Overlap of two rects. Returns a zero-sized rect when they do not intersect. */
export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return rect(
    x,
    y,
    Math.max(0, Math.min(right(a), right(b)) - x),
    Math.max(0, Math.min(bottom(a), bottom(b)) - y),
  );
}

/** Smallest rect containing both inputs. */
export function union(a: Rect, b: Rect): Rect {
  if (isEmpty(a)) return b;
  if (isEmpty(b)) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return rect(x, y, Math.max(right(a), right(b)) - x, Math.max(bottom(a), bottom(b)) - y);
}

/** Grow (positive) or shrink (negative) a rect on all sides. */
export function inflate(r: Rect, by: number): Rect {
  return rect(r.x - by, r.y - by, r.width + by * 2, r.height + by * 2);
}

export function translate(r: Rect, dx: number, dy: number): Rect {
  return rect(r.x + dx, r.y + dy, r.width, r.height);
}

/** Move `r` so it sits inside `bounds`, shrinking only if it cannot fit. */
export function clampTo(r: Rect, bounds: Rect): Rect {
  const width = Math.min(r.width, bounds.width);
  const height = Math.min(r.height, bounds.height);
  return rect(
    Math.min(Math.max(r.x, bounds.x), right(bounds) - width),
    Math.min(Math.max(r.y, bounds.y), bottom(bounds) - height),
    width,
    height,
  );
}
