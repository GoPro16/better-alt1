//! Counting occupied inventory slots — calibration-free.
//!
//! An empty slot is a flat dark rectangle: its interior barely varies. Any item sprite
//! has outlines and shading. So occupancy needs no "known empty" reference capture at
//! all: measure each cell interior's mean absolute luma deviation and threshold it.
//! Measured on a real client: empty interiors sit around 2, item sprites at 39-51 — a
//! ~20x separation, and it does not care that 27 stacked fish all look identical.
//!
//! Caveat: a semi-transparent interface skin puts the moving game world behind empty
//! slots and raises their deviation. The threshold is user-tunable for exactly that.

use serde::{Deserialize, Serialize};

use crate::{capture::Rect, store::StoredFrame};

const BYTES_PER_PIXEL: usize = 4;

/// Mean absolute luma deviation above which a cell interior holds something.
pub const DEFAULT_DETAIL_THRESHOLD: u8 = 10;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotGrid {
    /// Area of the frame holding the grid, in frame coordinates.
    pub region: Rect,
    pub columns: u32,
    pub rows: u32,
    /// Pixels trimmed from every cell edge, to keep slot borders and the highlight of a
    /// hovered slot out of the comparison.
    #[serde(default)]
    pub inset: u32,
}

impl SlotGrid {
    pub fn slot_count(&self) -> usize {
        self.columns as usize * self.rows as usize
    }

    pub fn is_valid(&self) -> bool {
        self.columns > 0
            && self.rows > 0
            && self.region.width >= self.columns
            && self.region.height >= self.rows
    }

    /// Cell bounds for a slot, insets applied.
    ///
    /// Edges are computed from the grid extent rather than a fixed cell size, so rounding
    /// never accumulates into a drifting final column.
    pub fn cell(&self, column: u32, row: u32) -> Rect {
        let left = self.region.x + (column * self.region.width).div_euclid(self.columns) as i32;
        let right =
            self.region.x + ((column + 1) * self.region.width).div_euclid(self.columns) as i32;
        let top = self.region.y + (row * self.region.height).div_euclid(self.rows) as i32;
        let bottom = self.region.y + ((row + 1) * self.region.height).div_euclid(self.rows) as i32;

        // Never inset a cell out of existence.
        let inset = self.inset.min(((right - left) as u32).saturating_sub(1) / 2);
        let inset_y = self.inset.min(((bottom - top) as u32).saturating_sub(1) / 2);

        Rect {
            x: left + inset as i32,
            y: top + inset_y as i32,
            width: ((right - left) as u32).saturating_sub(inset * 2).max(1),
            height: ((bottom - top) as u32).saturating_sub(inset_y * 2).max(1),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryScan {
    /// Mean absolute luma deviation per cell interior, row-major. Shipped so the UI can
    /// expose a sensitivity readout; 28 floats is nothing.
    pub detail: Vec<f32>,
    pub occupied: Vec<bool>,
    pub occupied_count: u32,
    pub free_count: u32,
}

/// Scan every cell of the grid and read occupancy directly from interior detail.
pub fn scan(frame: &StoredFrame, grid: &SlotGrid, threshold: u8) -> InventoryScan {
    let mut detail = Vec::with_capacity(grid.slot_count());
    for row in 0..grid.rows {
        for column in 0..grid.columns {
            detail.push(cell_detail(frame, interior(grid.cell(column, row))));
        }
    }

    let occupied: Vec<bool> = detail.iter().map(|&d| d > threshold as f32).collect();
    let occupied_count = occupied.iter().filter(|o| **o).count() as u32;
    let free_count = occupied.len() as u32 - occupied_count;

    InventoryScan { detail, occupied, occupied_count, free_count }
}

/// Shrink well inside the cell: clears the border lines, the rounded corners, and the
/// 2px band where the overlay draws its armed-slot ring, so none of them read as detail.
fn interior(cell: Rect) -> Rect {
    let margin_x = (cell.width / 6).max(6).min(cell.width.saturating_sub(1) / 2);
    let margin_y = (cell.height / 6).max(6).min(cell.height.saturating_sub(1) / 2);
    Rect {
        x: cell.x + margin_x as i32,
        y: cell.y + margin_y as i32,
        width: cell.width.saturating_sub(margin_x * 2).max(1),
        height: cell.height.saturating_sub(margin_y * 2).max(1),
    }
}

/// Mean absolute deviation of luma over a rect, clamped to the frame. Two passes; the
/// area is ~3.5k pixels per cell, so this costs nothing at scan rates.
fn cell_detail(frame: &StoredFrame, rect: Rect) -> f32 {
    let mut lumas: Vec<u16> = Vec::with_capacity(rect.width as usize * rect.height as usize);

    for y in 0..rect.height {
        let frame_y = rect.y as i64 + y as i64;
        if frame_y < 0 || frame_y >= frame.height as i64 {
            continue;
        }
        for x in 0..rect.width {
            let frame_x = rect.x as i64 + x as i64;
            if frame_x < 0 || frame_x >= frame.width as i64 {
                continue;
            }
            let offset =
                (frame_y as usize * frame.width as usize + frame_x as usize) * BYTES_PER_PIXEL;
            let luma = (frame.pixels[offset] as u16
                + 2 * frame.pixels[offset + 1] as u16
                + frame.pixels[offset + 2] as u16)
                / 4;
            lumas.push(luma);
        }
    }

    if lumas.is_empty() {
        return 0.0;
    }
    let mean = lumas.iter().map(|&v| v as f64).sum::<f64>() / lumas.len() as f64;
    let deviation =
        lumas.iter().map(|&v| (v as f64 - mean).abs()).sum::<f64>() / lumas.len() as f64;
    deviation as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::FrameStore;

    const CELL: u32 = 32;

    /// Builds a frame where each cell of a 4x7 grid is flat grey (empty) or holds a
    /// textured "item" (checkerboard — real sprites always have internal contrast).
    fn inventory(occupied_slots: &[usize]) -> (FrameStore, u64, SlotGrid) {
        let grid = SlotGrid {
            region: Rect { x: 0, y: 0, width: CELL * 4, height: CELL * 7 },
            columns: 4,
            rows: 7,
            inset: 2,
        };
        let (width, height) = (grid.region.width, grid.region.height);
        let mut pixels = vec![0u8; width as usize * height as usize * BYTES_PER_PIXEL];

        for row in 0..7u32 {
            for column in 0..4u32 {
                let index = (row * 4 + column) as usize;
                let filled = occupied_slots.contains(&index);

                for y in row * CELL..(row + 1) * CELL {
                    for x in column * CELL..(column + 1) * CELL {
                        let value = if filled && (x / 3 + y / 3) % 2 == 0 { 200 } else { 48 };
                        let offset =
                            (y as usize * width as usize + x as usize) * BYTES_PER_PIXEL;
                        pixels[offset] = value;
                        pixels[offset + 1] = value;
                        pixels[offset + 2] = value;
                        pixels[offset + 3] = 255;
                    }
                }
            }
        }

        let store = FrameStore::new();
        let handle = store.insert(
            width,
            height,
            0,
            Rect { x: 0, y: 0, width, height },
            pixels,
        );
        (store, handle.id, grid)
    }

    #[test]
    fn grid_cells_tile_the_region_without_gaps_or_drift() {
        let grid = SlotGrid {
            // Deliberately not divisible by the column count.
            region: Rect { x: 5, y: 7, width: 103, height: 71 },
            columns: 4,
            rows: 7,
            inset: 0,
        };

        // Last column must end exactly on the region edge.
        let last = grid.cell(3, 6);
        assert_eq!(last.x + last.width as i32, grid.region.x + grid.region.width as i32);
        assert_eq!(last.y + last.height as i32, grid.region.y + grid.region.height as i32);

        // Cells must not overlap.
        let first = grid.cell(0, 0);
        let second = grid.cell(1, 0);
        assert_eq!(first.x + first.width as i32, second.x);
    }

    #[test]
    fn inset_never_collapses_a_cell() {
        let grid = SlotGrid {
            region: Rect { x: 0, y: 0, width: 8, height: 8 },
            columns: 4,
            rows: 4,
            inset: 50,
        };
        let cell = grid.cell(0, 0);
        assert!(cell.width >= 1 && cell.height >= 1, "collapsed to {cell:?}");
    }

    #[test]
    fn empty_inventory_reads_as_all_free_without_any_reference() {
        let (store, id, grid) = inventory(&[]);
        let result = store.with(id, |f| scan(f, &grid, DEFAULT_DETAIL_THRESHOLD)).unwrap();

        assert_eq!(result.occupied.len(), 28);
        assert_eq!(result.free_count, 28);
        assert_eq!(result.occupied_count, 0);
    }

    #[test]
    fn occupied_slots_are_counted_and_located() {
        let filled = [0usize, 5, 27];
        let (store, id, grid) = inventory(&filled);
        let result = store.with(id, |f| scan(f, &grid, DEFAULT_DETAIL_THRESHOLD)).unwrap();

        assert_eq!(result.occupied_count as usize, filled.len());
        for index in filled {
            assert!(result.occupied[index], "slot {index} should read as occupied");
        }
    }

    /// The alert fires on free slots, so an off-by-one here is the whole feature failing.
    #[test]
    fn free_count_tracks_fill_level_exactly() {
        for fill in [0usize, 1, 14, 26, 27, 28] {
            let filled: Vec<usize> = (0..fill).collect();
            let (store, id, grid) = inventory(&filled);
            let result = store.with(id, |f| scan(f, &grid, DEFAULT_DETAIL_THRESHOLD)).unwrap();
            assert_eq!(result.free_count as usize, 28 - fill, "with {fill} items");
        }
    }

    /// A uniformly brighter or darker panel (compositing, skins) must not read as items —
    /// flatness, not brightness, is the signal.
    #[test]
    fn flat_cells_read_empty_whatever_their_brightness() {
        let store = FrameStore::new();
        for shade in [20u8, 48, 90, 160] {
            let handle = store.insert(
                64,
                64,
                0,
                Rect { x: 0, y: 0, width: 64, height: 64 },
                vec![shade; 64 * 64 * BYTES_PER_PIXEL],
            );
            let grid = SlotGrid {
                region: Rect { x: 0, y: 0, width: 64, height: 64 },
                columns: 2,
                rows: 2,
                inset: 2,
            };
            let result = store.with(handle.id, |f| scan(f, &grid, DEFAULT_DETAIL_THRESHOLD));
            assert_eq!(result.unwrap().free_count, 4, "shade {shade}");
        }
    }

    /// Real pixels: every visible cell of the committed fixture crop holds an item; all
    /// must read occupied at the default threshold.
    #[test]
    fn real_item_cells_read_occupied() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../fixtures/rs-slots.ba1f");
        let bytes = std::fs::read(path).expect("fixtures/rs-slots.ba1f");
        let width = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
        let height = u32::from_le_bytes(bytes[12..16].try_into().unwrap());

        let store = FrameStore::new();
        let handle = store.insert(
            width,
            height,
            0,
            Rect { x: 0, y: 0, width, height },
            bytes[24..].to_vec(),
        );
        // Grid measured when the fixture was captured: origin (18,13), pitch 94x80.
        let grid = SlotGrid {
            region: Rect { x: 18, y: 13, width: 282, height: 240 },
            columns: 3,
            rows: 3,
            inset: 2,
        };

        let result =
            store.with(handle.id, |f| scan(f, &grid, DEFAULT_DETAIL_THRESHOLD)).unwrap();
        assert_eq!(result.occupied_count, 9, "details: {:?}", result.detail);
    }
}
