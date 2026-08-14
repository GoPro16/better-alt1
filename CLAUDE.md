# better-alt1

Tauri desktop app + plugin host. A modern reimplementation of the Alt1 Toolkit model:
observe the game client's rendered pixels, show useful overlays/UI. Nothing else.

## Non-negotiable compliance rules

Alt1 is tolerated by Jagex because it is a **passive screen reader**. It reads the pixels
that are already on the user's screen and draws its own UI. Every capability below is
what separates "allowed overlay" from "bannable third-party client". Do not cross these
lines, and do not add a dependency that makes crossing them easy.

**Allowed**

- Capture the screen / a specific window's framebuffer.
- Analyse those pixels: template matching, OCR, colour sampling, diffing.
- Render our own windows and transparent always-on-top overlays.
- Persist user config, read/write our own files, make network calls to our own or
  public APIs (e.g. wiki, GE prices).

**Forbidden — never implement, never add a crate/package for**

- **Synthetic input.** No `SendInput`, `keybd_event`, `mouse_event`, `SetCursorPos`,
  `PostMessage`/`SendMessage` to the game window, no `enigo`/`rdev`/`inputbot`/
  `robotjs`/`nut-js`. The user's hands are the only input source.
- **Reading or writing game process memory.** No `ReadProcessMemory`,
  `WriteProcessMemory`, `OpenProcess`, no DLL injection, no hooking.
- **Network interception.** No reading, modifying, or replaying the game's packets.
- **Modifying game files** or shipping a modified client.
- **Automation of gameplay.** Even without synthetic input: no feature whose purpose is
  to play for the user. We inform; the user acts.

`pnpm lint:compliance` greps for the forbidden APIs/packages and fails the build. If you
have a legitimate reason to trip it, that is a conversation, not a bypass.

## Stack

pnpm 11 workspaces · TypeScript 7 · oxlint · Rust + Tauri 2 · React 19 · Vite 8 ·
Tailwind 4 · shadcn/ui · TanStack Router / Query / Form.

Third-party versions live in the **pnpm catalog** in `pnpm-workspace.yaml`. Package
manifests say `"dep": "catalog:"` — never a literal version. Bump in the catalog once.

`minimumReleaseAge: 1440` blocks installing anything published in the last 24h, so a
compromised release is usually yanked before we can pull it. When a genuinely needed
version is too fresh, prefer waiting or pinning the previous mature version;
`minimumReleaseAgeExclude` waives the check for an exact version and should stay short.

## Layout

```
apps/desktop            Tauri app
  src/                  React frontend
    routes/             TanStack Router file-based routes (routeTree.gen.ts is generated)
    components/ui/      shadcn/ui — generated, not hand-edited, excluded from lint
    hooks/, lib/        capture hooks, IPC wrappers, settings, cn()
  src-tauri/src/
    capture.rs          screen grabbing; owns the flash and cost tradeoffs
    store.rs            frames held in native memory, addressed by handle
    analyze.rs          native pixel analysis: pixel, signature, find_subimage
    lib.rs              Tauri commands, and the size guards on them
packages/core           framework-free primitives: geometry, frames, pixel access
packages/plugin-sdk     the API surface a plugin is written against
scripts/                repo tooling
```

Dependency direction is one-way: `plugin-sdk` -> `core`, `desktop` -> both. `core` and
`plugin-sdk` must stay free of Tauri and DOM-host assumptions so they can be unit tested
and, later, run inside a plugin sandbox.

## Commands

```
pnpm dev                run the desktop app (vite + tauri dev)
pnpm build              build all packages
pnpm lint               oxlint
pnpm lint:fix           oxlint --fix
pnpm lint:compliance    fail if forbidden APIs appear
pnpm typecheck          tsc -b across the workspace
pnpm test               vitest run
pnpm test:watch         vitest
pnpm fixture <name>     capture a fixture from the live screen (see Testing)
pnpm check              lint + compliance + typecheck + test
```

In `apps/desktop`: `pnpm routes` regenerates the route tree, `pnpm build:app` produces
an installer. In `src-tauri`: `cargo test`, `cargo clippy --all-targets -- -D warnings`.

`pnpm dlx shadcn@latest add <component> -c apps/desktop` — run from the repo root with
`-c`, or the CLI refuses.

## Testing

Vitest 4 (node environment) covers `packages/*`. `src/**/*.test.ts` holds unit tests;
`test/**/*.test.ts` holds tests that touch the filesystem or fixtures.

**Golden fixtures are the backbone.** `fixtures/*.ba1f` are byte-for-byte copies of what
`capture_frame` puts on the IPC wire, captured from a real running client, so analysis
code can be tested against actual game pixels instead of a moving target. Each has a
`.png` beside it for eyeballing. Regenerate or add one with:

```
pnpm fixture rs-client --target runescape --region 2900,1500,320,180
pnpm fixture desktop --target monitor
pnpm fixture whole-client --target runescape --full   # 33 MB — do not commit
```

Default region is 320x180 (230 KB) because a full 4K grab has no business in git.

`packages/core/test/golden-frame.test.ts` is the **only** test that proves the Rust
encoder and TypeScript decoder agree — the unit tests each define their own encoder, so
they would both stay green if the two drifted. Do not delete it, and do not refactor it
to share an encoder with `frame.test.ts`.

Rust: `cargo test` for units, `cargo test -- --ignored` for tests needing a live display.
`tests/capture_cost.rs` reports real grab timings on the current machine — run it before
assuming a frame rate, because the numbers are very uneven (see Capture strategy).

Not yet set up, in rough priority order: Vitest browser mode (`@vitest/browser` with the
Playwright provider) for canvas and component tests — jsdom has no real `ImageData`, so
it cannot honestly test the render path; Playwright against `vite dev` with `mockIPC`
from `@tauri-apps/api/mocks` replaying fixtures, for UI-level E2E; WebdriverIO plus
`tauri-driver` for a launch smoke test of the real binary. **Playwright cannot drive a
Tauri window** — it does not automate WebView2 — so WebDriver is the only option for the
real app, and it is Windows/Linux only.

## Pixels stay in Rust — this is the core design

**Captured frames never cross into JavaScript.** `capture_frame_handle` stores the frame in
`store.rs` and returns a `FrameHandle` — id, dimensions, native byte count. The frontend
then *asks questions* with commands that return small results:

| command | returns |
| --- | --- |
| `frame_pixel` | one packed `0xAARRGGBB` |
| `frame_signature` | a `u32` content fingerprint |
| `frame_find_subimage` | match coordinates — template matching runs natively |
| `frame_region` | raw RGBA, **guarded** at `MAX_REGION_BYTES` (1 MB) |
| `frame_png` | lossless PNG for display only |
| `frame_release` | frees early; frames also expire on a TTL |

This is Alt1's design, and its own API documents the reason: `bindRegion` binds a region
"in memory to apply functions to it without having to transfer it to the browser". Ours is
measured — a 4K frame is 33 MB and the transport stalls for seconds past ~2 MiB, while
asking whether an icon is lit costs four bytes.

**Rules that follow, and that must not be quietly relaxed:**

- New analysis belongs in `analyze.rs` as a command returning a small result. If you find
  yourself adding a command that returns pixels, that is the signal you are about to
  reintroduce the stall.
- `frame_region` is the one hole in the wall. It is size-guarded on purpose. Raising the
  guard is not the fix for a plugin that wants more pixels; moving its work into
  `analyze.rs` is.
- `packages/plugin-sdk` exposes `FrameReader`, never a pixel buffer. `onFrame` receives a
  `FrameHandle`.
- The preview is the sole exception, and it ships **PNG**, not raw: a full-resolution
  800x600 region is 457 KiB encoded against 1875 KiB raw (4.1x), which fits the transport's
  fast band without downscaling. It is decoded with `createImageBitmap` so the work happens
  off the main thread, and the pixel probe reads back single pixels from the canvas.

## Capture strategy — do not undo this

**We always read the screen, never a window's own device context.** Selecting a "window"
target resolves the window's monitor and reads that screen region; it does not call
`Window::capture_image`.

Capturing a window through its own DC (`PrintWindow` / `BitBlt`) asks the window to
repaint itself. On a hardware-accelerated game client that produces a **visible flash on
the user's screen**, and it is far slower. Measured on a 3840x2160 client
(`cargo test --test capture_cost -- --ignored --nocapture`):

| grab | size | cost |
| --- | --- | --- |
| whole client (screen read) | 31.6 MiB | ~375 ms |
| 800x600 region of the client | 1.8 MiB | ~23 ms |

**Cost is proportional to captured area, and there is no trick around it.** Measured
alternatives, same machine, same client:

| backend | 800x600 region | whole 4K client |
| --- | --- | --- |
| GDI `BitBlt` (xcap default) | **24 ms** | 342 ms |
| Windows Graphics Capture (`xcap` `wgc` feature) | 42 ms | 362 ms |

**Do not re-enable xcap's `wgc` feature expecting a win — it was measured at ~1.8x
slower for regions.** WGC is genuinely the faster API, but its advantage comes from a
*persistent* capture session streaming frames from a `Direct3D11CaptureFramePool`; xcap's
one-shot `capture_region` builds and tears down that pipeline per call, so we pay the
setup and get none of the benefit. Reaching the fast path would mean a persistent session
(a different crate, or Direct3D11CaptureFramePool / DXGI Desktop Duplication directly).
DXGI Desktop Duplication would additionally hand us **dirty rectangles** — the OS telling
us which parts of the screen changed — which is the ideal input for this kind of tool.
That is a real project, not a feature flag.

**The IPC transport has a hard cliff.** Measured on Windows/WebView2 via the app's
"test IPC alone" button: 64 KiB and 512 KiB round trip in ~11 ms, while 2 MiB *and* 4 MiB
both cost ~4.1 seconds. A fixed penalty past a threshold, not a bandwidth limit, and it
blocks the UI thread. `capture_frame` therefore takes a `max_bytes` budget and decimates
until the payload fits; the frontend passes `MAX_FRAME_BYTES` (1.5 MiB). Treat that as a
correctness constraint. Re-measure with the button before raising it.

Consequences to design around:

- **Region grabs are ~16x cheaper than whole-target grabs**, and the saving is in the grab
  itself. `max_dimension` shrinks the IPC payload but not the capture cost — a whole-client
  preview is capped around 2.5 fps, while a small region sustains 40 fps. Plugins should
  declare a region of interest and stay inside it.
- **Whatever is on screen is what we get.** A window covering the client is captured
  instead of it, and a minimised client returns `WindowMinimized`. This is the same
  limitation Alt1 has, and it follows from being a passive observer.
- Never pass `max_dimension: None` for a frame that is only going to be displayed. An
  uncapped 4K grab is ~33 MB per call and stalls the webview for seconds.

## Conventions

- oxlint is the only JS/TS linter — no ESLint, no Prettier config fights; oxlint's
  formatter-agnostic rules only.
- TypeScript: let inference work. Explicit types only where inference fails or is wrong.
  `typecheck` is `tsc -b` because `core` and `plugin-sdk` are composite project
  references — `--noEmit` cannot resolve them.
- Rust: `cargo clippy` clean. Capture code returns errors, never panics — a failed frame
  grab is normal (window minimised, display asleep) and must degrade gracefully.
- Frame buffers cross IPC as raw bytes with a small binary header (see
  `packages/core/src/frame.ts` and `src-tauri/src/capture.rs`) rather than JSON/base64.
  Keep those two in sync; the header format is the contract.
- A frame grab that overruns its interval **drops** that frame; it never queues. Capture
  is a sampler, not a pipeline.
- Overlay coordinates are virtual-desktop pixels, matching `CaptureTarget.bounds`. Frame
  coordinates are target-local. Converting between them is the caller's job.
