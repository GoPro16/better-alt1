import { describe, expect, it } from "vitest";
import {
  area,
  clampTo,
  contains,
  containsPoint,
  inflate,
  intersect,
  isEmpty,
  rect,
  translate,
  union,
} from "./geometry.js";

describe("intersect", () => {
  it("returns the overlap", () => {
    expect(intersect(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toEqual(rect(5, 5, 5, 5));
  });

  it("returns an empty rect when there is no overlap", () => {
    const result = intersect(rect(0, 0, 5, 5), rect(10, 10, 5, 5));
    expect(isEmpty(result)).toBe(true);
    expect(area(result)).toBe(0);
  });

  it("treats edge-touching rects as non-overlapping", () => {
    expect(isEmpty(intersect(rect(0, 0, 5, 5), rect(5, 0, 5, 5)))).toBe(true);
  });
});

describe("union", () => {
  it("covers both rects", () => {
    expect(union(rect(0, 0, 5, 5), rect(10, 10, 5, 5))).toEqual(rect(0, 0, 15, 15));
  });

  it("ignores an empty operand rather than stretching to its origin", () => {
    expect(union(rect(100, 100, 0, 0), rect(0, 0, 5, 5))).toEqual(rect(0, 0, 5, 5));
    expect(union(rect(0, 0, 5, 5), rect(100, 100, 0, 0))).toEqual(rect(0, 0, 5, 5));
  });
});

describe("clampTo", () => {
  it("slides a rect back inside its bounds", () => {
    expect(clampTo(rect(90, 90, 20, 20), rect(0, 0, 100, 100))).toEqual(rect(80, 80, 20, 20));
  });

  it("handles negative bounds origins, as on a display above the primary", () => {
    expect(clampTo(rect(-5000, -5000, 100, 100), rect(1264, -2160, 3840, 2160))).toEqual(
      rect(1264, -2160, 100, 100),
    );
  });

  it("shrinks only when the rect cannot fit", () => {
    expect(clampTo(rect(0, 0, 500, 500), rect(0, 0, 100, 200))).toEqual(rect(0, 0, 100, 200));
  });
});

describe("containment", () => {
  it("contains is inclusive of shared edges", () => {
    expect(contains(rect(0, 0, 10, 10), rect(0, 0, 10, 10))).toBe(true);
    expect(contains(rect(0, 0, 10, 10), rect(0, 0, 11, 10))).toBe(false);
  });

  it("containsPoint excludes the far edges, matching pixel indexing", () => {
    expect(containsPoint(rect(0, 0, 10, 10), { x: 0, y: 0 })).toBe(true);
    expect(containsPoint(rect(0, 0, 10, 10), { x: 9, y: 9 })).toBe(true);
    expect(containsPoint(rect(0, 0, 10, 10), { x: 10, y: 9 })).toBe(false);
  });
});

describe("inflate and translate", () => {
  it("inflate grows on all sides", () => {
    expect(inflate(rect(10, 10, 10, 10), 5)).toEqual(rect(5, 5, 20, 20));
  });

  it("inflate accepts a negative amount to shrink", () => {
    expect(inflate(rect(10, 10, 10, 10), -2)).toEqual(rect(12, 12, 6, 6));
  });

  it("translate moves without resizing", () => {
    expect(translate(rect(1, 2, 3, 4), 10, -20)).toEqual(rect(11, -18, 3, 4));
  });
});
