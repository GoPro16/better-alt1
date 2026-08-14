//! Measures what a grab actually costs on this machine. Ignored by default; it needs a
//! live display and reports numbers rather than asserting.
//!
//!   cargo test --test capture_cost -- --ignored --nocapture
//!
//! Exists because capture cost drives the whole design, and it is wildly non-uniform:
//! whole-window and whole-monitor grabs cost hundreds of milliseconds, while a small
//! monitor *region* grab costs about twenty.
//!
//! Reports max as well as median. The tail is what users feel — a grab that occasionally
//! takes ten times the median shows up as the app locking up, and a "best of N" number
//! hides it completely.

use std::time::Instant;

use better_alt1_lib::capture::{capture, list_targets, CaptureTarget, Rect, TargetKind};

const RUNS: usize = 20;

fn report(label: &str, mut times: Vec<u128>, dims: (u32, u32), bytes: usize) {
    times.sort_unstable();
    let median = times[times.len() / 2];
    let p90 = times[times.len() * 9 / 10];
    let max = *times.last().unwrap();
    println!(
        "{label:<38} {:>5}x{:<5} {:>7.2} MiB  median {median:>4}ms  p90 {p90:>4}ms  max {max:>5}ms",
        dims.0,
        dims.1,
        bytes as f64 / 1_048_576.0,
    );
}

fn probe(label: &str, id: &str, region: Option<Rect>, cap: Option<u32>) {
    if capture(id, region, cap, None).is_err() {
        println!("{label:<38} unavailable");
        return;
    }

    let mut times = Vec::with_capacity(RUNS);
    let mut bytes = 0;
    let mut dims = (0, 0);
    for _ in 0..RUNS {
        let start = Instant::now();
        let Ok(frame) = capture(id, region, cap, None) else {
            println!("{label:<38} failed mid-run");
            return;
        };
        times.push(start.elapsed().as_millis());
        bytes = frame.len();
        dims = (
            u32::from_le_bytes(frame[8..12].try_into().unwrap()),
            u32::from_le_bytes(frame[12..16].try_into().unwrap()),
        );
    }
    report(label, times, dims, bytes);
}

fn is_game(target: &CaptureTarget) -> bool {
    format!("{} {}", target.title, target.app_name).to_lowercase().contains("runescape")
}

#[test]
#[ignore = "requires a live display; reports timings rather than asserting"]
fn capture_cost() {
    // Enumeration happens inside every grab, so its cost is paid per frame.
    let mut enumerate = Vec::with_capacity(RUNS);
    let mut count = 0;
    for _ in 0..RUNS {
        let start = Instant::now();
        count = list_targets().expect("enumerate targets").len();
        enumerate.push(start.elapsed().as_millis());
    }
    enumerate.sort_unstable();
    println!(
        "list_targets ({count} targets)            median {}ms  p90 {}ms  max {}ms\n",
        enumerate[enumerate.len() / 2],
        enumerate[enumerate.len() * 9 / 10],
        enumerate.last().unwrap(),
    );

    let targets = list_targets().expect("enumerate targets");
    let small = Rect { x: 0, y: 0, width: 800, height: 600 };

    for target in targets.iter().filter(|t| is_game(t)) {
        probe("window whole", &target.id, None, None);
        probe("window whole, capped 1600", &target.id, None, Some(1600));
        probe("window region 800x600", &target.id, Some(small), None);
    }

    for target in targets.iter().filter(|t| t.kind == TargetKind::Monitor) {
        let id = &target.id;
        probe(&format!("monitor {id} whole"), id, None, None);
        probe(&format!("monitor {id} region 800x600"), id, Some(small), None);
    }
}
