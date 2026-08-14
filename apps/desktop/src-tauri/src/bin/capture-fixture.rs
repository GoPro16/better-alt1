//! Dumps a real frame to disk so tests can run against actual game pixels.
//!
//! Writes two files per fixture: a `.ba1f` holding the exact bytes `capture_frame` sends
//! over IPC (so TypeScript tests decode the real wire format), and a `.png` for eyeballing.
//!
//! ```text
//! cargo run --bin capture-fixture -- rs-lobby
//! cargo run --bin capture-fixture -- rs-inv --target runescape --region 3000,1600,320,180
//! cargo run --bin capture-fixture -- desktop --target monitor
//! ```
//!
//! Region defaults to 320x180 at the target's origin: big enough to be recognisable,
//! small enough to commit. A full 4K grab is 33 MB and has no business in git.

use std::{fs, path::PathBuf, process::ExitCode};

use better_alt1_lib::capture::{capture, list_targets, CaptureTarget, Rect, TargetKind};

const DEFAULT_REGION: Rect = Rect { x: 0, y: 0, width: 320, height: 180 };
const HEADER_BYTES: usize = 24;

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("error: {message}");
            eprintln!(
                "\nusage: cargo run --bin capture-fixture -- <name> [--target <substring>] \
                 [--region x,y,w,h] [--full]"
            );
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut name = None;
    let mut wanted = None;
    let mut region = Some(DEFAULT_REGION);
    let mut index = 0;

    while index < args.len() {
        match args[index].as_str() {
            "--target" => {
                index += 1;
                wanted = Some(args.get(index).ok_or("--target needs a value")?.to_lowercase());
            }
            "--region" => {
                index += 1;
                region = Some(parse_region(args.get(index).ok_or("--region needs a value")?)?);
            }
            "--full" => region = None,
            other if other.starts_with("--") => return Err(format!("unknown flag {other}")),
            other => name = Some(other.to_owned()),
        }
        index += 1;
    }

    let name = name.ok_or("a fixture name is required")?;
    let targets = list_targets().map_err(|e| e.to_string())?;
    let target = pick(&targets, wanted.as_deref())?;

    println!(
        "target {:?} ({:?}) {:?} {}x{}",
        target.title, target.app_name, target.kind, target.bounds.width, target.bounds.height
    );

    // Fixtures are golden data: never downsample, or tests would assert against pixels
    // that never appeared on screen.
    let bytes = capture(&target.id, region, None, None).map_err(|e| e.to_string())?;
    let width = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let height = u32::from_le_bytes(bytes[12..16].try_into().unwrap());

    let dir = fixtures_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let raw_path = dir.join(format!("{name}.ba1f"));
    fs::write(&raw_path, &bytes).map_err(|e| e.to_string())?;

    let png_path = dir.join(format!("{name}.png"));
    let image =
        xcap::image::RgbaImage::from_raw(width, height, bytes[HEADER_BYTES..].to_vec())
            .ok_or("captured bytes do not match the header dimensions")?;
    image.save(&png_path).map_err(|e| e.to_string())?;

    println!("wrote {} ({}x{}, {} bytes)", raw_path.display(), width, height, bytes.len());
    println!("wrote {}", png_path.display());
    Ok(())
}

/// Match on title or app name; falls back to the primary monitor when nothing is asked for.
fn pick<'a>(
    targets: &'a [CaptureTarget],
    wanted: Option<&str>,
) -> Result<&'a CaptureTarget, String> {
    let Some(wanted) = wanted else {
        return targets
            .iter()
            .find(|t| t.kind == TargetKind::Monitor && t.is_primary)
            .ok_or_else(|| "no primary monitor found".to_owned());
    };

    if wanted == "monitor" {
        return targets
            .iter()
            .find(|t| t.kind == TargetKind::Monitor && t.is_primary)
            .ok_or_else(|| "no primary monitor found".to_owned());
    }

    targets
        .iter()
        .find(|t| {
            format!("{} {}", t.title, t.app_name).to_lowercase().contains(wanted)
        })
        .ok_or_else(|| {
            let available: Vec<_> = targets.iter().map(|t| t.title.as_str()).collect();
            format!("no target matching {wanted:?}. available: {available:?}")
        })
}

fn parse_region(raw: &str) -> Result<Rect, String> {
    let parts: Vec<&str> = raw.split(',').collect();
    let [x, y, width, height] = parts.as_slice() else {
        return Err(format!("expected --region x,y,w,h but got {raw:?}"));
    };
    Ok(Rect {
        x: x.trim().parse().map_err(|_| format!("bad x in {raw:?}"))?,
        y: y.trim().parse().map_err(|_| format!("bad y in {raw:?}"))?,
        width: width.trim().parse().map_err(|_| format!("bad width in {raw:?}"))?,
        height: height.trim().parse().map_err(|_| format!("bad height in {raw:?}"))?,
    })
}

/// `<repo>/fixtures`, derived from this crate's location so it works from any cwd.
fn fixtures_dir() -> Result<PathBuf, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .map(|repo| repo.join("fixtures"))
        .ok_or_else(|| format!("could not locate the repo root from {}", manifest.display()))
}
