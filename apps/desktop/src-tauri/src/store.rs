//! Captured frames held in native memory, addressed by handle.
//!
//! This is the core of the design, and it is copied from Alt1, whose own API documents
//! `bindRegion` as binding a region "in memory to apply functions to it without having to
//! transfer it to the browser". Pixels stay here; the frontend gets an id and asks
//! questions about it. That is what keeps a 33 MB frame from ever crossing the webview
//! boundary, where it costs seconds.
//!
//! Frames are evicted aggressively: they are stale the moment the screen changes, so
//! holding many is pointless and holding them long is a leak.

use std::{
    collections::BTreeMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Serialize;

use crate::capture::Rect;

/// How many frames stay resident. A handful is enough for "compare with the previous
/// frame"; more is just retained memory.
const MAX_FRAMES: usize = 8;

/// Frames older than this are dropped even if never released. A frontend that forgets to
/// release must not be able to leak the screen.
const TTL: Duration = Duration::from_secs(30);

pub struct StoredFrame {
    pub width: u32,
    pub height: u32,
    pub captured_at: u64,
    /// Which part of the target this frame covers, in target-local coordinates.
    pub source: Rect,
    pub pixels: Vec<u8>,
    inserted: Instant,
}

/// Everything the frontend gets when it captures: metadata and a handle, no pixels.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameHandle {
    pub id: u64,
    pub width: u32,
    pub height: u32,
    pub captured_at: u64,
    pub source: Rect,
    /// Bytes the frame occupies natively, so callers can see what they are not paying to
    /// transfer.
    pub byte_len: usize,
}

#[derive(Default)]
struct Inner {
    next_id: u64,
    frames: BTreeMap<u64, StoredFrame>,
}

#[derive(Default)]
pub struct FrameStore {
    inner: Mutex<Inner>,
}

impl FrameStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Store a frame and return its handle. Also evicts expired and surplus frames.
    pub fn insert(
        &self,
        width: u32,
        height: u32,
        captured_at: u64,
        source: Rect,
        pixels: Vec<u8>,
    ) -> FrameHandle {
        let mut inner = self.lock();
        inner.next_id += 1;
        let id = inner.next_id;
        let byte_len = pixels.len();

        inner.frames.insert(
            id,
            StoredFrame {
                width,
                height,
                captured_at,
                source,
                pixels,
                inserted: Instant::now(),
            },
        );

        prune(&mut inner);

        FrameHandle { id, width, height, captured_at, source, byte_len }
    }

    /// Run `read` against a stored frame. Returns `None` if the handle is unknown or
    /// expired — callers should treat that as "capture again", not as an error worth
    /// surfacing.
    pub fn with<T>(&self, id: u64, read: impl FnOnce(&StoredFrame) -> T) -> Option<T> {
        let mut inner = self.lock();
        prune(&mut inner);
        inner.frames.get(&id).map(read)
    }

    pub fn release(&self, id: u64) -> bool {
        self.lock().frames.remove(&id).is_some()
    }

    pub fn clear(&self) {
        self.lock().frames.clear();
    }

    pub fn len(&self) -> usize {
        self.lock().frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().frames.is_empty()
    }

    /// A poisoned lock means another thread panicked mid-update. The stored frames are
    /// still structurally valid, and losing the screen preview is not worth aborting the
    /// app, so recover rather than propagate.
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn prune(inner: &mut Inner) {
    let now = Instant::now();
    inner.frames.retain(|_, frame| now.duration_since(frame.inserted) < TTL);

    // Ids increase monotonically, so the lowest keys are the oldest.
    while inner.frames.len() > MAX_FRAMES {
        let Some(&oldest) = inner.frames.keys().next() else { break };
        inner.frames.remove(&oldest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect() -> Rect {
        Rect { x: 0, y: 0, width: 2, height: 1 }
    }

    fn store_one(store: &FrameStore, tag: u8) -> FrameHandle {
        store.insert(2, 1, 0, rect(), vec![tag; 8])
    }

    #[test]
    fn insert_returns_a_handle_without_pixels_and_reports_their_size() {
        let store = FrameStore::new();
        let handle = store_one(&store, 1);

        assert_eq!(handle.id, 1);
        assert_eq!((handle.width, handle.height), (2, 1));
        assert_eq!(handle.byte_len, 8);
    }

    #[test]
    fn handles_are_unique_and_increasing() {
        let store = FrameStore::new();
        let first = store_one(&store, 1);
        let second = store_one(&store, 2);
        assert!(second.id > first.id);
    }

    #[test]
    fn with_reads_the_right_frame() {
        let store = FrameStore::new();
        let first = store_one(&store, 0xaa);
        let second = store_one(&store, 0xbb);

        assert_eq!(store.with(first.id, |f| f.pixels[0]), Some(0xaa));
        assert_eq!(store.with(second.id, |f| f.pixels[0]), Some(0xbb));
    }

    #[test]
    fn unknown_handles_read_as_none_rather_than_panicking() {
        let store = FrameStore::new();
        assert_eq!(store.with(999, |f| f.width), None);
    }

    #[test]
    fn release_frees_the_frame_and_is_idempotent() {
        let store = FrameStore::new();
        let handle = store_one(&store, 1);

        assert!(store.release(handle.id));
        assert!(!store.release(handle.id));
        assert_eq!(store.with(handle.id, |f| f.width), None);
    }

    /// A frontend that never releases must not grow memory without bound.
    #[test]
    fn oldest_frames_are_evicted_past_the_cap() {
        let store = FrameStore::new();
        let handles: Vec<_> = (0..MAX_FRAMES + 4).map(|i| store_one(&store, i as u8)).collect();

        assert_eq!(store.len(), MAX_FRAMES);
        // The first four are gone; the most recent MAX_FRAMES survive.
        for handle in &handles[..4] {
            assert_eq!(store.with(handle.id, |f| f.width), None, "id {} survived", handle.id);
        }
        for handle in &handles[handles.len() - MAX_FRAMES..] {
            assert!(store.with(handle.id, |f| f.width).is_some(), "id {} evicted", handle.id);
        }
    }

    #[test]
    fn clear_drops_everything() {
        let store = FrameStore::new();
        store_one(&store, 1);
        store_one(&store, 2);
        store.clear();
        assert_eq!(store.len(), 0);
    }
}
