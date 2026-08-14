use serde::{Serialize, Serializer};

use crate::capture::Rect;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("screen capture failed: {0}")]
    Capture(#[from] xcap::XCapError),

    #[error("no capture target with id {0:?}; re-enumerate targets")]
    UnknownTarget(String),

    #[error("malformed target id {0:?}; expected \"monitor:<n>\" or \"window:<n>\"")]
    BadTargetId(String),

    #[error("window {0:?} is minimised; there are no on-screen pixels to read")]
    WindowMinimized(String),

    #[error("window {0:?} is entirely off-screen")]
    WindowOffscreen(String),

    #[error(
        "region {}x{} at ({}, {}) does not overlap the {width}x{height} target",
        region.width, region.height, region.x, region.y
    )]
    RegionOutOfBounds { region: Rect, width: u32, height: u32 },

    #[error("capture worker panicked: {0}")]
    Worker(String),

    #[error("no frame with handle {0}; it was released or expired — capture again")]
    UnknownFrame(u64),

    #[error("stored frame does not match its {width}x{height} dimensions")]
    MalformedFrame { width: u32, height: u32 },

    #[error("could not encode frame: {0}")]
    Encode(String),

    #[error(
        "region needs {requested} bytes, over the {limit} byte limit; \
         use an analysis command instead of transferring pixels"
    )]
    RegionTooLarge { requested: usize, limit: usize },

    #[error("template {width}x{height} needs {} bytes of RGBA but got {len}", width * height * 4)]
    MalformedTemplate { width: u32, height: u32, len: usize },

    #[error("a {columns}x{rows} grid does not fit in a {width}x{height} region")]
    InvalidGrid { columns: u32, rows: u32, width: u32, height: u32 },
}

/// Tauri sends command errors to the frontend as JSON, so a plain string keeps the
/// message readable in the UI instead of leaking enum shape.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
