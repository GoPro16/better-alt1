//! Find the inventory slot lattice in a frame, with no shipped templates.
//!
//! The inventory is 28 near-identical cells at a constant pitch: thin lighter borders on
//! dark interiors, tiled in 3-8 columns. That *structure* survives interface skins and
//! scale settings that would break exact sprite matching, so detection works from
//! geometry alone: find long vertical edge lines repeating at a constant pitch, then long
//! horizontal lines at a compatible pitch within that x-extent, and demand the result
//! shapes like a 28-slot grid. Anything ambiguous returns `None` — a wrong auto-region is
//! worse than asking the user.

use serde::Serialize;

use crate::capture::Rect;

const BYTES_PER_PIXEL: usize = 4;

/// Slot pitch bounds, physical px. Compact 1080p layouts sit near the bottom, a 4K
/// client near the top (measured 93x80 there).
const MIN_PITCH: usize = 30;
const MAX_PITCH: usize = 170;

const SLOT_COUNT: usize = 28;
const MIN_COLUMNS: usize = 3;
const MAX_COLUMNS: usize = 8;

/// Luma step that counts as an edge. Measured on a real client: the slot border is a
/// bright 1-2px line only ~8 luma above the interior, so this must be permissive — the
/// long-run filter below is what keeps organic scene texture out.
const EDGE_THRESHOLD: u8 = 5;

/// An edge pixel only counts toward a line when it belongs to a straight run at least
/// this long — the discriminator between UI lines and organic scene texture.
const MIN_LINE_RUN: usize = 12;

/// A comb position is a grid boundary when the (smoothed) line profile there reaches this
/// fraction of the strongest position in the comb run.
const RELATIVE_STRENGTH: f32 = 0.35;

/// Absolute floor for a boundary line, in accumulated run-pixels: roughly two slot
/// heights' worth of border. Keeps a faint two-line coincidence from reading as a grid.
const MIN_LINE_STRENGTH: u32 = 48;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedGrid {
    pub region: Rect,
    pub columns: u32,
    pub rows: u32,
}

pub fn detect_slots(width: u32, height: u32, pixels: &[u8]) -> Option<DetectedGrid> {
    let w = width as usize;
    let h = height as usize;
    if w < 2 * MIN_PITCH || h < 2 * MIN_PITCH || pixels.len() < w * h * BYTES_PER_PIXEL {
        return None;
    }

    let luma = luma_map(w, h, pixels);

    // Long vertical lines, accumulated per column across the whole frame.
    let column_lines = vertical_lines(&luma, w, h, 0..h);

    // Combs are exact-length windows, so every candidate already has an inventory shape;
    // the decider is `gaps_are_uniform`: the bands between slots are never covered by
    // items, so a real grid has perfectly uniform gap lines flanked by brighter borders,
    // and ends at its edges — coincidental lattices, flat panels, and windows into
    // larger icon grids each fail one of those.
    for x_comb in best_combs(&column_lines, 64, MIN_COLUMNS + 1, MAX_COLUMNS + 1) {
        let cells_x = x_comb.boundaries - 1;
        let rows = SLOT_COUNT.div_ceil(cells_x);
        let row_lines = horizontal_lines(&luma, w, h, x_comb.start..x_comb.end() + 1);

        if !comb_contrast(&column_lines, &x_comb) {
            continue;
        }

        for y_comb in best_combs(&row_lines, 16, rows + 1, rows + 1) {
            let aspect = x_comb.pitch as f32 / y_comb.pitch as f32;
            if !(0.8..=1.5).contains(&aspect) {
                continue;
            }
            if !comb_contrast(&row_lines, &y_comb) {
                continue;
            }

            let region = Rect {
                x: x_comb.start as i32,
                y: y_comb.start as i32,
                width: (x_comb.end() - x_comb.start) as u32,
                height: (y_comb.end() - y_comb.start) as u32,
            };
            if gaps_are_uniform(&luma, w, h, region, cells_x, rows) {
                return Some(DetectedGrid { region, columns: cells_x as u32, rows: rows as u32 });
            }
        }
    }

    None
}

/// The item-proof invariant: the bands between slots are interface background, never
/// covered by icons. Along every internal grid boundary there must be a line whose
/// colour barely varies over the whole grid (the gap) AND a visibly brighter line beside
/// it (the slot border). Coincidental lattices fail the gap; flat empty panels have gaps
/// everywhere but no borders, and fail that.
fn gaps_are_uniform(
    luma: &[u8],
    w: usize,
    h: usize,
    region: Rect,
    columns: usize,
    rows: usize,
) -> bool {
    // Tracing for the detect-debug tool; a no-op in normal runs.
    let trace = |message: &str| {
        if std::env::var_os("DETECT_TRACE").is_some() {
            eprintln!(
                "  candidate ({}, {}) {}x{} as {columns}x{rows}: {message}",
                region.x, region.y, region.width, region.height
            );
        }
    };

    let x0 = region.x as usize;
    let y0 = region.y as usize;
    let width = region.width as usize;
    let height = region.height as usize;
    if x0 + width >= w || y0 + height >= h {
        trace("out of frame");
        return false;
    }

    for k in 1..columns {
        let boundary = x0 + k * width / columns;
        let lines: Vec<LineStat> = (boundary.saturating_sub(6)..=(boundary + 6).min(w - 1))
            .map(|x| line_stat((y0..y0 + height).map(|y| luma[y * w + x])))
            .collect();
        if !is_slot_boundary(&lines) {
            trace(&format!("vertical boundary {k} at x={boundary} not slot-like"));
            return false;
        }
    }

    for k in 1..rows {
        let boundary = y0 + k * height / rows;
        let lines: Vec<LineStat> = (boundary.saturating_sub(6)..=(boundary + 6).min(h - 1))
            .map(|y| line_stat((x0..x0 + width).map(|x| luma[y * w + x])))
            .collect();
        if !is_slot_boundary(&lines) {
            trace(&format!("horizontal boundary {k} at y={boundary} not slot-like"));
            return false;
        }
    }

    // Maximality: a real inventory *ends* at its edges. A window into a larger lattice
    // (keybind grids, banks) has more slot boundaries at pitch beyond it — probe one
    // pitch out on each side and reject if the grid appears to continue.
    let pitch_x = width / columns;
    let pitch_y = height / rows;

    let vertical_extension = |x: usize| -> bool {
        let lines: Vec<LineStat> = (x.saturating_sub(6)..=(x + 6).min(w - 1))
            .map(|column| line_stat((y0..y0 + height).map(|y| luma[y * w + column])))
            .collect();
        is_slot_boundary(&lines)
    };
    if x0 >= pitch_x && vertical_extension(x0 - pitch_x) {
        trace("lattice continues left");
        return false;
    }
    if x0 + width + pitch_x < w && vertical_extension(x0 + width + pitch_x) {
        trace("lattice continues right");
        return false;
    }

    let horizontal_extension = |y: usize| -> bool {
        let lines: Vec<LineStat> = (y.saturating_sub(6)..=(y + 6).min(h - 1))
            .map(|row| line_stat((x0..x0 + width).map(|x| luma[row * w + x])))
            .collect();
        is_slot_boundary(&lines)
    };
    if y0 >= pitch_y && horizontal_extension(y0 - pitch_y) {
        trace("lattice continues up");
        return false;
    }
    if y0 + height + pitch_y < h && horizontal_extension(y0 + height + pitch_y) {
        trace("lattice continues down");
        return false;
    }

    trace("accepted");
    true
}

struct LineStat {
    median: u8,
    /// Percentage of pixels within ±7 luma of the median.
    uniformity: usize,
}

fn line_stat(values: impl Iterator<Item = u8>) -> LineStat {
    let line: Vec<u8> = values.collect();
    if line.is_empty() {
        return LineStat { median: 0, uniformity: 0 };
    }
    let mut sorted = line.clone();
    sorted.sort_unstable();
    let median = sorted[sorted.len() / 2];
    let close = line.iter().filter(|&&v| v.abs_diff(median) <= 7).count();
    LineStat { median, uniformity: close * 100 / line.len() }
}

/// A slot boundary = a highly uniform dark gap line, plus a nearby brighter line (the
/// slot border; interrupted at gap crossings, so its uniformity bar is lower).
fn is_slot_boundary(lines: &[LineStat]) -> bool {
    let Some(gap) = lines
        .iter()
        .filter(|line| line.uniformity >= 85)
        .min_by_key(|line| line.median)
    else {
        return false;
    };

    lines
        .iter()
        .any(|line| line.uniformity >= 60 && line.median >= gap.median.saturating_add(5))
}

/// `(r + 2g + b) / 4` per pixel — cheap and monotonic enough for edge detection.
pub fn luma_map(w: usize, h: usize, pixels: &[u8]) -> Vec<u8> {
    let mut luma = Vec::with_capacity(w * h);
    for pixel in pixels.chunks_exact(BYTES_PER_PIXEL).take(w * h) {
        let value = (pixel[0] as u16 + 2 * pixel[1] as u16 + pixel[2] as u16) / 4;
        luma.push(value as u8);
    }
    luma
}

/// Border contrast hovers right at the edge threshold, so a real line reads as edge,
/// edge, miss, edge…; runs tolerate this many consecutive misses before flushing.
const MAX_RUN_BREAK: usize = 2;

/// Streams edge/no-edge decisions into gap-tolerant run lengths.
struct RunCounter {
    run: usize,
    misses: usize,
    total: u32,
}

impl RunCounter {
    fn new() -> Self {
        Self { run: 0, misses: 0, total: 0 }
    }

    fn push(&mut self, edge: bool) {
        if edge {
            self.run += self.misses + 1;
            self.misses = 0;
        } else if self.run > 0 {
            self.misses += 1;
            if self.misses > MAX_RUN_BREAK {
                self.flush();
            }
        }
    }

    fn flush(&mut self) {
        if self.run >= MIN_LINE_RUN {
            self.total += self.run as u32;
        }
        self.run = 0;
        self.misses = 0;
    }

    fn finish(mut self) -> u32 {
        self.flush();
        self.total
    }
}

/// Accumulated length of long vertical edge runs, per column, within a y range.
///
/// Adjacent-pixel differences, deliberately: slot borders are 1px lines, and a centered
/// `x±1` difference straddles them symmetrically and cancels to nearly zero.
pub fn vertical_lines(luma: &[u8], w: usize, h: usize, ys: std::ops::Range<usize>) -> Vec<u32> {
    let mut lines = vec![0u32; w];
    for x in 0..w - 1 {
        let mut counter = RunCounter::new();
        for y in ys.clone() {
            let row = y * w;
            counter.push(luma[row + x + 1].abs_diff(luma[row + x]) >= EDGE_THRESHOLD);
        }
        lines[x] = counter.finish();
    }
    let _ = h;
    lines
}

/// Accumulated length of long horizontal edge runs, per row, within an x range.
/// Adjacent-pixel differences for the same reason as `vertical_lines`.
pub fn horizontal_lines(luma: &[u8], w: usize, h: usize, xs: std::ops::Range<usize>) -> Vec<u32> {
    let mut lines = vec![0u32; h];
    for y in 0..h - 1 {
        let mut counter = RunCounter::new();
        for x in xs.clone() {
            counter.push(luma[(y + 1) * w + x].abs_diff(luma[y * w + x]) >= EDGE_THRESHOLD);
        }
        lines[y] = counter.finish();
    }
    lines
}

/// A run of equally spaced strong lines: the signature of a slot grid along one axis.
#[derive(Debug, Clone, Copy)]
pub struct Comb {
    pub start: usize,
    pub pitch: usize,
    /// Number of grid boundary lines in the run (cells + 1).
    pub boundaries: usize,
    pub score: u64,
    /// Strength of the window's weakest line.
    pub low: u32,
}

impl Comb {
    fn end(&self) -> usize {
        self.start + self.pitch * (self.boundaries - 1)
    }

    /// Ranking key: the weakest line in the window. A real grid is strong at EVERY
    /// boundary, while coincidental windows almost always carry at least one line that
    /// barely cleared the floor — total-strength rankings kept favouring those (they
    /// compensate with a few very strong lines, like panel edges). Ordering only decides
    /// how soon the real grid is reached; gap validation accepts or rejects.
    fn rank(&self) -> u64 {
        self.low as u64
    }
}

/// Best equally-spaced windows of strong positions in a line profile, strongest first,
/// each exactly `min_boundaries..=max_boundaries` lines. Fixed-length windows rather
/// than maximal runs: dense interfaces chain unrelated lattices into endless runs, while
/// a window is judged purely on its own lines (every one above the absolute floor and no
/// weaker than `RELATIVE_STRENGTH` of the window's peak). Overlapping windows describing
/// the same lattice are deduplicated by span, keeping the strongest.
pub fn best_combs(
    profile: &[u32],
    keep: usize,
    min_boundaries: usize,
    max_boundaries: usize,
) -> Vec<Comb> {
    let mut kept: Vec<Comb> = Vec::new();

    for pitch in MIN_PITCH..=MAX_PITCH.min(profile.len() / 2) {
        for phase in 0..pitch {
            let strengths: Vec<u32> =
                (phase..profile.len()).step_by(pitch).map(|p| window_max(profile, p)).collect();

            for from in 0..strengths.len() {
                for boundaries in min_boundaries..=max_boundaries.min(strengths.len() - from) {
                    let window = &strengths[from..from + boundaries];
                    let low = window.iter().copied().min().unwrap_or(0);
                    if low < MIN_LINE_STRENGTH {
                        // Growing the window only lowers the minimum further.
                        break;
                    }
                    let high = window.iter().copied().max().unwrap_or(0);
                    if (low as f32) < high as f32 * RELATIVE_STRENGTH {
                        continue;
                    }
                    submit(
                        &mut kept,
                        Comb {
                            start: phase + from * pitch,
                            pitch,
                            boundaries,
                            score: window.iter().map(|&s| s as u64).sum(),
                            low,
                        },
                        keep,
                    );
                }
            }
        }
    }

    kept.sort_by_key(|comb| std::cmp::Reverse(comb.rank()));
    kept.truncate(keep);
    kept
}

/// Keep a bounded set of best candidates, folding span-duplicates into the strongest.
/// Only windows with the SAME boundary count can be duplicates — a 6-line and a 7-line
/// window over almost the same span are different grid hypotheses, and folding them
/// would let an over-extended window swallow the exact one.
fn submit(kept: &mut Vec<Comb>, comb: Comb, keep: usize) {
    if let Some(existing) = kept.iter_mut().find(|existing| {
        existing.boundaries == comb.boundaries
            && (existing.start as i64 - comb.start as i64).abs() < existing.pitch as i64
            && (existing.end() as i64 - comb.end() as i64).abs() < existing.pitch as i64
    }) {
        if comb.rank() > existing.rank() {
            *existing = comb;
        }
        return;
    }

    kept.push(comb);
    if kept.len() > keep * 2 {
        kept.sort_by_key(|existing| std::cmp::Reverse(existing.rank()));
        kept.truncate(keep);
    }
}

/// A real grid is loud at its boundaries and quiet mid-cell. A pitch-aligned set of
/// coincidental panel lines has no such structure — its "boundaries" land mid-cell where
/// slot grids have almost nothing. Require the mean boundary line to dwarf the mean
/// mid-cell line.
fn comb_contrast(profile: &[u32], comb: &Comb) -> bool {
    let boundary: u64 = (0..comb.boundaries)
        .map(|k| window_max(profile, comb.start + k * comb.pitch) as u64)
        .sum();
    let mid: u64 = (0..comb.boundaries.saturating_sub(1))
        .map(|k| window_max(profile, comb.start + comb.pitch / 2 + k * comb.pitch) as u64)
        .sum();

    let boundary_mean = boundary / comb.boundaries as u64;
    let mid_mean = mid / comb.boundaries.saturating_sub(1).max(1) as u64;
    // 1.3x, not higher: item sprites have hard straight edges, so a full inventory's
    // mid-cell lines are genuinely loud — measured 1.5x on a real full inventory, while
    // panel-anchored impostors measure ~1.2x.
    let pass = boundary_mean * 10 >= (mid_mean * 13).max(MIN_LINE_STRENGTH as u64 * 10);
    if std::env::var_os("DETECT_TRACE").is_some() {
        eprintln!(
            "  contrast start={} pitch={} boundaries={}: boundary_mean={boundary_mean} mid_mean={mid_mean} -> {pass}",
            comb.start, comb.pitch, comb.boundaries
        );
    }
    pass
}

/// Boundary lines smear across a few pixels (borders are 1-2px, capture is not
/// bit-exact), so a comb position reads the local maximum.
fn window_max(profile: &[u32], position: usize) -> u32 {
    let from = position.saturating_sub(2);
    let to = (position + 3).min(profile.len());
    profile[from..to].iter().copied().max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INTERIOR: u8 = 60;
    const GAP: u8 = 30;
    const BORDER: u8 = 90;
    const BACKDROP: u8 = 120;

    /// Draws a synthetic slot grid: dark interiors, darker 2px gap edges with a bright
    /// border ring inside, item-like blobs in some cells, on a flat backdrop.
    fn lattice_frame(
        w: usize,
        h: usize,
        origin: (usize, usize),
        pitch: (usize, usize),
        cells: (usize, usize),
    ) -> Vec<u8> {
        let mut luma = vec![BACKDROP; w * h];
        let (x0, y0) = origin;
        let (px, py) = pitch;
        let (columns, rows) = cells;

        for cy in 0..rows {
            for cx in 0..columns {
                for y in 0..py {
                    for x in 0..px {
                        let distance_x = x.min(px - 1 - x);
                        let distance_y = y.min(py - 1 - y);
                        let value = match distance_x.min(distance_y) {
                            0 | 1 => GAP,
                            2 => BORDER,
                            _ => INTERIOR,
                        };
                        luma[(y0 + cy * py + y) * w + x0 + cx * px + x] = value;
                    }
                }
                // An "item" in a checkerboard of cells, clear of the gaps.
                if (cx + cy) % 2 == 0 {
                    for y in 10..py - 10 {
                        for x in 10..px - 10 {
                            luma[(y0 + cy * py + y) * w + x0 + cx * px + x] = 150;
                        }
                    }
                }
            }
        }

        // Grey RGBA so the luma map reproduces the plan exactly.
        luma.into_iter().flat_map(|v| [v, v, v, 255]).collect()
    }

    #[test]
    fn finds_a_synthetic_inventory_with_items() {
        let pixels = lattice_frame(400, 420, (100, 90), (40, 36), (5, 6));
        let grid = detect_slots(400, 420, &pixels).expect("grid should be found");

        // Integer pitch search can land one pixel per cell short; the scanner insets
        // every cell by 2px, so a few pixels of slack are genuinely fine.
        assert_eq!((grid.columns, grid.rows), (5, 6));
        assert!((grid.region.x - 100).abs() <= 4, "x = {}", grid.region.x);
        assert!((grid.region.y - 90).abs() <= 4, "y = {}", grid.region.y);
        assert!((grid.region.width as i32 - 200).abs() <= 6, "w = {}", grid.region.width);
        assert!((grid.region.height as i32 - 216).abs() <= 6, "h = {}", grid.region.height);
    }

    #[test]
    fn finds_a_four_column_layout() {
        let pixels = lattice_frame(400, 420, (60, 50), (36, 34), (4, 7));
        let grid = detect_slots(400, 420, &pixels).expect("grid should be found");
        assert_eq!((grid.columns, grid.rows), (4, 7));
    }

    #[test]
    fn a_flat_frame_has_no_grid() {
        let pixels: Vec<u8> =
            std::iter::repeat_n([40u8, 40, 40, 255], 400 * 400).flatten().collect();
        assert!(detect_slots(400, 400, &pixels).is_none());
    }

    #[test]
    fn a_noise_frame_has_no_grid() {
        // Deterministic pseudo-noise; organic texture must never read as an inventory.
        let mut state = 0x2545_f491u32;
        let mut pixels = Vec::with_capacity(400 * 400 * 4);
        for _ in 0..400 * 400 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let v = (state >> 24) as u8;
            pixels.extend_from_slice(&[v, v, v, 255]);
        }
        assert!(detect_slots(400, 400, &pixels).is_none());
    }

    #[test]
    fn a_window_into_a_larger_lattice_is_rejected() {
        // 8x12 lattice: any 28-slot-shaped window inside it must fail maximality.
        let pixels = lattice_frame(500, 560, (50, 40), (44, 40), (8, 12));
        let grid = detect_slots(500, 560, &pixels);
        assert!(grid.is_none(), "found a grid inside a larger lattice");
    }

    /// Real pixels: a small crop of a live client (a few slots, no complete grid) must
    /// not produce a false positive.
    #[test]
    fn no_false_positive_on_a_real_partial_crop() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../fixtures/rs-slots.ba1f");
        let bytes = std::fs::read(path).expect("fixtures/rs-slots.ba1f");
        let width = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let height = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
        assert!(detect_slots(width, height, &bytes[24..]).is_none());
    }

    /// End-to-end against whatever client is running right now.
    #[test]
    #[ignore = "requires a live display with a game client"]
    fn detect_finds_inventory_on_live_client() {
        let targets = crate::capture::list_targets().expect("enumerate");
        let target = targets
            .iter()
            .find(|t| t.title.to_lowercase().contains("runescape"))
            .expect("a running client");
        let capture = crate::capture::capture_pixels(&target.id, None, None).expect("grab");
        let grid = detect_slots(capture.width, capture.height, &capture.pixels)
            .expect("inventory should be found");
        assert!((3..=8).contains(&(grid.columns as usize)));
        assert_eq!(grid.rows, 28u32.div_ceil(grid.columns));
    }
}

