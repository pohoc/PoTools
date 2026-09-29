//! Shared, platform-neutral contracts and helpers for the PoTools UI and engine.

pub mod fields;
pub mod id_photo;
pub mod pages;
pub mod password_strength;
pub mod protocol;
pub mod tools;

pub use protocol::{Artifact, InputFile, ToolResult};
