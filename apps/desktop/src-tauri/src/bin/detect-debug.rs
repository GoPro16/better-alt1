//! Run slot-grid detection against a `.ba1f` capture and print what it found.
//!
//! ```text
//! cargo run --bin detect-debug -- path/to/capture.ba1f
//! ```
//!
//! Set `DETECT_TRACE=1` to see every candidate the validator rejected and why.

use std::{fs, process::ExitCode};

use better_alt1_lib::detect::detect_slots;

const HEADER_BYTES: usize = 24;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            eprintln!("\nusage: cargo run --bin detect-debug -- <capture.ba1f>");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let path = std::env::args().nth(1).ok_or("a .ba1f path is required")?;
    let bytes = fs::read(&path).map_err(|e| format!("{path}: {e}"))?;
    if bytes.len() < HEADER_BYTES {
        return Err("file too short to hold a frame header".into());
    }

    let width = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let height = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    println!("frame {width}x{height}");

    let started = std::time::Instant::now();
    match detect_slots(width, height, &bytes[HEADER_BYTES..]) {
        Some(grid) => println!(
            "found: {}x{} cells at ({}, {}) {}x{} — pitch {:.1}x{:.1} — in {}ms",
            grid.columns,
            grid.rows,
            grid.region.x,
            grid.region.y,
            grid.region.width,
            grid.region.height,
            grid.region.width as f32 / grid.columns as f32,
            grid.region.height as f32 / grid.rows as f32,
            started.elapsed().as_millis(),
        ),
        None => println!("no slot grid found — in {}ms", started.elapsed().as_millis()),
    }
    Ok(())
}
