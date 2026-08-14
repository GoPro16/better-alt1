import { describe, expect, it } from "vitest";
import { rect } from "./geometry.js";
import {
  type CaptureTarget,
  describeTarget,
  looksLikeGameClient,
  rankTargets,
  resolveTarget,
} from "./target.js";

function target(partial: Partial<CaptureTarget> & { id: string }): CaptureTarget {
  return {
    kind: "window",
    title: "",
    appName: "",
    bounds: rect(0, 0, 800, 600),
    scaleFactor: 1,
    isPrimary: false,
    isMinimized: false,
    ...partial,
  };
}

describe("looksLikeGameClient", () => {
  it("matches the real client seen on Windows", () => {
    // Exactly what enumeration reports for a running RS3 client.
    expect(
      looksLikeGameClient(target({ id: "window:1", title: "RuneScape", appName: "RuneScape Client" })),
    ).toBe(true);
  });

  it("matches other launchers and clients", () => {
    const titles = ["Jagex Launcher", "Old School RuneScape", "RuneLite", "rs2client"];
    for (const title of titles) {
      expect(looksLikeGameClient(target({ id: "window:2", title })), title).toBe(true);
    }
  });

  it("matches on app name when the title is unhelpful", () => {
    expect(looksLikeGameClient(target({ id: "window:3", title: "", appName: "RuneScape Client" }))).toBe(
      true,
    );
  });

  it("does not match unrelated windows", () => {
    for (const title of ["Discord", "Visual Studio Code", "better-alt1"]) {
      expect(looksLikeGameClient(target({ id: "window:4", title })), title).toBe(false);
    }
  });

  it("never matches a monitor, however it is named", () => {
    expect(
      looksLikeGameClient(target({ id: "monitor:1", kind: "monitor", title: "RuneScape" })),
    ).toBe(false);
  });
});

describe("rankTargets", () => {
  it("puts game clients first, then windows, then monitors", () => {
    const ranked = rankTargets([
      target({ id: "monitor:1", kind: "monitor", title: "LG ULTRAGEAR+" }),
      target({ id: "window:1", title: "Discord" }),
      target({ id: "window:2", title: "RuneScape", appName: "RuneScape Client" }),
    ]);

    expect(ranked.map((t) => t.id)).toEqual(["window:2", "window:1", "monitor:1"]);
  });

  it("breaks ties by title so the order is stable across re-enumeration", () => {
    const ranked = rankTargets([
      target({ id: "window:1", title: "Zed" }),
      target({ id: "window:2", title: "Alacritty" }),
    ]);

    expect(ranked.map((t) => t.title)).toEqual(["Alacritty", "Zed"]);
  });

  it("does not mutate the input", () => {
    const input = [
      target({ id: "monitor:1", kind: "monitor", title: "Display" }),
      target({ id: "window:1", title: "RuneScape" }),
    ];
    const before = input.map((t) => t.id);

    rankTargets(input);

    expect(input.map((t) => t.id)).toEqual(before);
  });

  it("handles duplicate monitor titles, which real multi-monitor setups produce", () => {
    const ranked = rankTargets([
      target({ id: "monitor:1", kind: "monitor", title: "LG ULTRAGEAR+" }),
      target({ id: "monitor:2", kind: "monitor", title: "LG ULTRAGEAR+" }),
    ]);

    expect(ranked).toHaveLength(2);
    expect(new Set(ranked.map((t) => t.id)).size).toBe(2);
  });
});

describe("resolveTarget", () => {
  const rs = target({ id: "window:1", title: "RuneScape", appName: "RuneScape Client" });

  it("resolves by exact id within a session", () => {
    const resolution = resolveTarget(describeTarget(rs), [target({ id: "window:9" }), rs]);
    expect(resolution).toEqual({ target: rs, via: "id" });
  });

  it("survives a client restart: same window, new id", () => {
    const descriptor = describeTarget(rs);
    const relaunched = target({ id: "window:777", title: "RuneScape", appName: "RuneScape Client" });

    const resolution = resolveTarget(descriptor, [target({ id: "window:2", title: "Discord" }), relaunched]);
    expect(resolution).toEqual({ target: relaunched, via: "descriptor" });
  });

  it("never descriptor-matches on empty fields (legacy id-only descriptors)", () => {
    const legacy = { id: "window:1", kind: "window" as const, title: "", appName: "" };
    const untitled = target({ id: "window:5", title: "", appName: "" });

    expect(resolveTarget(legacy, [untitled, target({ id: "window:6", title: "Discord" })])).toBeUndefined();
  });

  it("requires the kind to match", () => {
    const descriptor = { id: "monitor:1", kind: "monitor" as const, title: "RuneScape", appName: "" };
    const window = target({ id: "window:3", title: "RuneScape" });

    // The window is still found — but by the game-client heuristic, not the descriptor.
    expect(resolveTarget(descriptor, [window])).toEqual({ target: window, via: "heuristic" });
  });

  it("prefers an exact title over an app-name-only match when multi-boxing", () => {
    const descriptor = describeTarget(
      target({ id: "window:1", title: "RuneLite - Zezima", appName: "RuneLite" }),
    );
    const other = target({ id: "window:11", title: "RuneLite - Bob", appName: "RuneLite" });
    const mine = target({ id: "window:12", title: "RuneLite - Zezima", appName: "RuneLite" });

    expect(resolveTarget(descriptor, [other, mine])?.target).toBe(mine);
  });

  it("prefers a non-minimised window among equal matches", () => {
    const descriptor = describeTarget(rs);
    const minimised = target({ id: "window:21", title: "RuneScape", appName: "RuneScape Client", isMinimized: true });
    const visible = target({ id: "window:22", title: "RuneScape", appName: "RuneScape Client" });

    expect(resolveTarget(descriptor, [minimised, visible])?.target).toBe(visible);
  });

  it("falls back to detecting a game client when nothing is persisted", () => {
    const resolution = resolveTarget(undefined, [target({ id: "window:2", title: "Discord" }), rs]);
    expect(resolution).toEqual({ target: rs, via: "heuristic" });
  });

  it("returns undefined rather than guessing at an arbitrary window", () => {
    expect(resolveTarget(undefined, [target({ id: "window:2", title: "Discord" })])).toBeUndefined();
  });

  it("never heuristically picks a monitor, however it is named", () => {
    const monitor = target({ id: "monitor:1", kind: "monitor", title: "RuneScape" });
    expect(resolveTarget(undefined, [monitor])).toBeUndefined();
  });

  it("still resolves an explicitly chosen monitor by title", () => {
    const monitor = target({ id: "monitor:1", kind: "monitor", title: "LG ULTRAGEAR+" });
    const descriptor = describeTarget(monitor);
    const renumbered = target({ id: "monitor:7", kind: "monitor", title: "LG ULTRAGEAR+" });

    expect(resolveTarget(descriptor, [renumbered])).toEqual({
      target: renumbered,
      via: "descriptor",
    });
  });
});
