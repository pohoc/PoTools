use super::shared::*;
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let mode = if string(ctx, "mode", "") == "verify" {
        "verify"
    } else {
        "hash"
    };
    let password = string(ctx, "bcryptPassword", "");
    if password.is_empty() {
        return Err(error(ctx, "dev.error.empty"));
    }
    if utf8_len(password) > 72 {
        return Err(error(ctx, "dev.error.bcryptLength"));
    }
    if mode == "hash" {
        let rounds = number(ctx, "rounds", 10.0).trunc().clamp(4.0, 12.0) as u32;
        let hash = bcrypt::hash(password, rounds).map_err(|_| error(ctx, "dev.error.bcrypt"))?;
        return Ok(output(
            "bcrypt-hash.txt",
            hash,
            extra([
                (String::from("mode"), json!(mode)),
                (String::from("rounds"), json!(rounds)),
                (String::from("valid"), json!("")),
            ]),
        ));
    }
    let hash = string(ctx, "bcryptHash", "");
    if !valid_bcrypt_hash(hash) {
        return Err(error(ctx, "dev.error.bcryptHash"));
    }
    let valid = bcrypt::verify(password, hash).map_err(|_| error(ctx, "dev.error.bcryptHash"))?;
    Ok(output(
        "bcrypt-verification.txt",
        msg(
            ctx,
            if valid {
                "dev.bcrypt.match"
            } else {
                "dev.bcrypt.noMatch"
            },
        )
        .into(),
        extra([
            (String::from("mode"), json!(mode)),
            (String::from("rounds"), json!("")),
            (String::from("valid"), json!(if valid { 1 } else { 0 })),
        ]),
    ))
}

fn valid_bcrypt_hash(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 60
        && bytes.starts_with(b"$2")
        && matches!(bytes.get(2), Some(b'a' | b'b' | b'y'))
        && bytes.get(3) == Some(&b'$')
        && bytes[4..6].iter().all(u8::is_ascii_digit)
        && bytes[6] == b'$'
        && bytes[7..]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'.' || *byte == b'/')
}
