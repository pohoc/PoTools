//! Rust implementations of encoding, digest, and password utility tools.
//!
//! Rust implementations of encoding and cryptography tools.

use crate::{EngineError, RunContext, ToolResult};

pub mod aes;
pub mod codec;
mod files;
pub mod hash;
pub mod jwt;
pub mod password;
pub mod rsa;
pub mod totp;
pub mod unicode;
pub mod url;
pub mod x509;

type RunResult = Result<Option<ToolResult>, EngineError>;

pub fn run(ctx: &RunContext<'_>) -> RunResult {
    if let Some(result) = files::run(ctx)? {
        return Ok(Some(result));
    }
    if let Some(result) = hash::run(ctx)? {
        return Ok(Some(result));
    }
    if let Some(result) = codec::run(ctx)? {
        return Ok(Some(result));
    }
    if let Some(result) = password::run(ctx)? {
        return Ok(Some(result));
    }
    if let Some(result) = totp::run(ctx)? {
        return Ok(Some(result));
    }
    if let Some(result) = aes::run(ctx)? {
        return Ok(Some(result));
    }
    if let Some(result) = jwt::run(ctx)? {
        return Ok(Some(result));
    }
    if let Some(result) = rsa::run(ctx)? {
        return Ok(Some(result));
    }
    if let Some(result) = x509::run(ctx)? {
        return Ok(Some(result));
    }
    Ok(None)
}
