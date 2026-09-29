//! Framed reports for the encoding tools (base64/hex/radix/url/unicode),
//! mirroring the product engine's `enc.*` output byte for byte.

use super::codec::{base32_decode, base32_encode, radix_decode, radix_encode};
use super::enc::{self, group_digits};
use super::hash::{b64_decode, b64_encode, boolean, decode_hex, hex, input_bytes, string};
use crate::tools::text::fmt::{align_rows, join_blocks, row, section};
use crate::{EngineError, RunContext, ToolResult};
use serde_json::json;

const RADIX_LABELS: [(&str, &str, &str); 6] = [
    ("base32", "Base32（RFC 4648）", "Base32 (RFC 4648)"),
    ("base32-crockford", "Base32（Crockford）", "Base32 (Crockford)"),
    ("base58-btc", "Base58（Bitcoin）", "Base58 (Bitcoin)"),
    ("base58-ripple", "Base58（Ripple）", "Base58 (Ripple)"),
    ("base36", "Base36", "Base36"),
    ("base16", "Base16（RFC 4648 十六进制）", "Base16 (RFC 4648 hex)"),
];

pub(super) fn emit(name: &str, text: String, extra: serde_json::Map<String, serde_json::Value>) -> ToolResult {
    let body = format!("{}\n", text.trim_end());
    let result = super::hash::artifact(name, body.clone(), extra);
    ToolResult {
        text: Some(body),
        ..result
    }
}

fn wrap_lines(text: &str, width: usize) -> String {
    text.as_bytes()
        .chunks(width)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn stats_section(en: bool, rows: &[(String, String)]) -> (String, String) {
    (section(enc::t(en, "统计", "Summary")), align_rows(rows))
}

pub(super) fn run_encoding(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let raw = super::hash::required(ctx, "input")?;
    match ctx.tool {
        "base64" => base64_report(ctx, raw),
        "hex" => hex_report(ctx, raw),
        "radix" => radix_report(ctx, raw),
        "url-codec" => super::codec_report_text::url_report(ctx, raw),
        "unicode-escape" => super::codec_report_text::unicode_report(ctx, raw),
        _ => Err(super::hash::bad("tool", "unsupported encoding tool")),
    }
}

fn base64_report(ctx: &RunContext<'_>, raw: &str) -> Result<ToolResult, EngineError> {
    let en = enc::is_en(ctx);
    let mode = if string(ctx, "mode", "encode") == "decode" { "decode" } else { "encode" };
    let url = string(ctx, "variant", "standard") == "urlsafe";
    let charset = string(ctx, "charset", "utf8");
    let charset_label = if charset == "latin1" { "latin1" } else { "UTF-8" };
    let wrap = (super::hash::number(ctx, "lineWrap", 0) as f64).max(0.0) as usize;
    let data_uri = boolean(ctx, "dataUri", false);
    let table = enc::t(
        en,
        if url { "URL 安全字符表（- _）" } else { "标准字符表（+ /）" },
        if url { "URL-safe alphabet (- _)" } else { "Standard alphabet (+ /)" },
    );
    let mut extra = serde_json::Map::new();
    extra.insert("mode".into(), json!(mode));
    extra.insert("variant".into(), json!(if url { "urlsafe" } else { "standard" }));
    let mut blocks: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    if mode == "encode" {
        let bytes = input_bytes(raw, charset);
        if bytes.is_empty() {
            return Err(super::hash::bad("input", "holds no content left to encode once whitespace is removed"));
        }
        let encoded = b64_encode(&bytes, url);
        let shown = if wrap > 0 { wrap_lines(&encoded, wrap) } else { encoded.clone() };
        blocks.push(section(&format!(
            "{}{table}",
            enc::t(en, "Base64 编码 · ", "Base64 encode - ")
        )));
        blocks.push(shown);
        if data_uri {
            let mime = string(ctx, "mime", "text/plain");
            blocks.push(section("Data URI"));
            blocks.push(format!("data:{mime};base64,{encoded}"));
        }
        let padding = encoded.len() - encoded.trim_end_matches('=').len();
        let bytes_label = if en {
            format!("{} bytes ({charset_label})", group_digits(bytes.len()))
        } else {
            format!("{} 字节（{charset_label}）", group_digits(bytes.len()))
        };
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "输入字符", "Input characters"), enc::code_points(raw).to_string()),
            row(enc::t(en, "输入字节", "Input bytes"), bytes_label),
            row(enc::t(en, "输出字符", "Output characters"), encoded.len().to_string()),
            row(enc::t(en, "填充 =", "Padding ="), padding.to_string()),
            row(
                enc::t(en, "输出行数", "Output lines"),
                (if wrap > 0 { encoded.len().div_ceil(wrap) } else { 1 }).to_string(),
            ),
        ]);
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(
            enc::t(
                en,
                if url {
                    "· URL 安全变体仍保留 = 填充，如需放进查询串可直接使用。"
                } else {
                    "· 标准变体使用 + / 与 = 填充。"
                },
                if url {
                    "- The URL-safe variant keeps the = padding, so it drops straight into a query string."
                } else {
                    "- The standard variant uses + / with = padding."
                },
            )
            .to_string(),
        );
        if wrap > 0 {
            notes.push(if en { format!("- A line break every {wrap} characters (PEM style); keep the breaks when copying.") } else { format!("· 每 {wrap} 个字符换行（PEM 风格），复制时请连同换行一起保留。") });
        }
        if data_uri {
            let mime = string(ctx, "mime", "text/plain");
            notes.push(if en { format!("- The Data URI form is data:{mime};base64,<data> on a single line.") } else { format!("· Data URI 形态为 data:{mime};base64,<数据>，单行不换行。") });
        } else {
            notes.push(enc::t(en, "· 关闭“输出 Data URI”时只给裸编码串。", "- With \"output Data URI\" off, only the bare encoded string is returned.").to_string());
        }
        extra.insert("inputBytes".into(), json!(bytes.len()));
        extra.insert("outputChars".into(), json!(encoded.len()));
        extra.insert("mime".into(), json!(if data_uri { string(ctx, "mime", "text/plain") } else { "-" }));
    } else {
        let body = raw
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(',').map(|(_, b)| b))
            .unwrap_or(raw);
        let bytes = b64_decode(body)?;
        let lossy = std::str::from_utf8(&bytes).is_err();
        let text = String::from_utf8_lossy(&bytes).to_string();
        let re_encoded = b64_encode(&bytes, url);
        let normalized = body.split_whitespace().collect::<String>().trim_end_matches('=').to_string();
        let stable = re_encoded.trim_end_matches('=') == normalized;
        blocks.push(section(&format!(
            "{}{table}",
            enc::t(en, "Base64 解码 · ", "Base64 decode - ")
        )));
        blocks.push(if text.is_empty() { enc::t(en, "(解码结果为空)", "(the decoded result is empty)").to_string() } else { text.clone() });
        let mut rows = vec![
            row(enc::t(en, "输入字符", "Input characters"), enc::code_points(body).to_string()),
            row(
                enc::t(en, "解码字节", "Decoded bytes"),
                format!(
                    "{}{}",
                    group_digits(bytes.len()),
                    if en { format!(" bytes ({})", human_bytes(bytes.len())) } else { format!(" 字节（{}）", human_bytes(bytes.len())) }
                ),
            ),
            row(
                enc::t(en, "解码文本", "Decoded text"),
                if en { format!("{} characters", enc::code_points(&text)) } else { format!("{} 字符", enc::code_points(&text)) },
            ),
            row("HEX", enc::preview(en, &enc::spaced_hex(&bytes), 96)),
            row("HEX (compact)", enc::preview(en, &hex(&bytes, false), 192)),
        ];
        rows.push(row(
            enc::t(en, "再编码一致", "Re-encode matches"),
            if stable {
                enc::t(en, "是", "Yes").to_string()
            } else if en {
                format!("No (canonical spelling {re_encoded})")
            } else {
                format!("否（标准写法 {re_encoded}）")
            },
        ));
        let (head, rows_text) = stats_section(en, &rows);
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(enc::t(en, "· 解码同时接受标准与 URL 安全写法，并允许缺少 = 填充。", "- Decoding accepts both the standard and the URL-safe spelling and allows missing = padding.").to_string());
        if lossy {
            notes.push(enc::t(en, "· 解码字节不是合法 UTF-8，已按替换字符显示；如需原样字节请选择 charset=latin1。", "- The decoded bytes are not valid UTF-8, so they are shown with replacement characters; pick charset=latin1 for the raw bytes.").to_string());
        }
        extra.insert("decodedBytes".into(), json!(bytes.len()));
        extra.insert("decodedChars".into(), json!(enc::code_points(&text)));
        extra.insert("roundTrip".into(), json!(if stable { "ok" } else { "differs" }));
        blocks.push(section(enc::t(en, "说明", "Notes")));
        blocks.push(notes.join("\n"));
        let mut result = emit("base64.txt", join_blocks(blocks.iter().map(String::as_str)), extra);
        if lossy {
            result.warnings.push(enc::t(en, "Base64 解码结果不是合法 UTF-8 文本，已按替换字符显示。", "The Base64 decode result is not valid UTF-8 text, so it is shown with replacement characters.").to_string());
        }
        if !stable {
            result.warnings.push(enc::t(en, "Base64 再编码结果与输入不一致，输入可能含多余填充或非规范写法。", "Re-encoding the Base64 result differs from the input, which may carry extra padding or a non-canonical spelling.").to_string());
        }
        return Ok(result);
    }
    blocks.push(section(enc::t(en, "说明", "Notes")));
    blocks.push(notes.join("\n"));
    Ok(emit("base64.txt", join_blocks(blocks.iter().map(String::as_str)), extra))
}

fn human_bytes(value: usize) -> String {
    if value < 1024 {
        format!("{value} B")
    } else if value < 1024 * 1024 {
        format!("{:.1} KB", value as f64 / 1024.0)
    } else {
        format!("{:.2} MB", value as f64 / 1_048_576.0)
    }
}

fn hex_report(ctx: &RunContext<'_>, raw: &str) -> Result<ToolResult, EngineError> {
    let en = enc::is_en(ctx);
    let mode = if string(ctx, "mode", "encode") == "decode" { "decode" } else { "encode" };
    let charset = string(ctx, "charset", "utf8");
    let charset_label = if charset == "latin1" { "latin1" } else { "UTF-8" };
    let separator = string(ctx, "separator", "none");
    let upper = boolean(ctx, "uppercase", false);
    let separator_label = match separator {
        "space" => enc::t(en, "空格分隔", "space separated"),
        "backslash-x" => enc::t(en, "\\x 前缀", "\\x prefix"),
        "prefix-0x" => enc::t(en, "0x 前缀", "0x prefix"),
        _ => enc::t(en, "连续输出", "continuous output"),
    };
    let mut extra = serde_json::Map::new();
    extra.insert("mode".into(), json!(mode));
    let mut blocks: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    if mode == "encode" {
        let bytes = input_bytes(raw, charset);
        if bytes.is_empty() {
            return Err(super::hash::bad("input", "holds no content left to encode once whitespace is removed"));
        }
        let pure = hex(&bytes, upper);
        let shown = match separator {
            "space" => pure.as_bytes().chunks(2).map(|c| std::str::from_utf8(c).unwrap()).collect::<Vec<_>>().join(" "),
            "backslash-x" => pure.as_bytes().chunks(2).map(|c| format!("\\x{}", std::str::from_utf8(c).unwrap())).collect(),
            "prefix-0x" => pure.as_bytes().chunks(2).map(|c| format!("0x{}", std::str::from_utf8(c).unwrap())).collect::<Vec<_>>().join(" "),
            _ => pure.clone(),
        };
        blocks.push(section(&format!(
            "{}{charset} · {separator_label}",
            enc::t(en, "十六进制编码 · ", "Hex encode - ")
        )));
        blocks.push(shown);
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "输入字符", "Input characters"), enc::code_points(raw).to_string()),
            row(
                enc::t(en, "输入字节", "Input bytes"),
                format!("{}{}", group_digits(bytes.len()), if en { format!(" bytes ({charset_label})") } else { format!(" 字节（{charset_label}）") }),
            ),
            row(enc::t(en, "HEX 位数", "HEX digits"), pure.len().to_string()),
            row(enc::t(en, "分隔方式", "Separator"), separator_label),
        ]);
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(if en { format!("- separator={separator} only changes the spelling; on decode, spaces, line breaks, 0x and \\x prefixes are all ignored.") } else { format!("· separator={separator} 只影响输出写法，解码时空格、换行、0x 与 \\x 前缀都会被忽略。") });
        notes.push(enc::t(en, if upper { "· uppercase=true：字母输出为大写。" } else { "· uppercase=false：字母输出为小写。" }, if upper { "- uppercase=true: letters are output in upper case." } else { "- uppercase=false: letters are output in lower case." }).to_string());
        extra.insert("bytes".into(), json!(bytes.len()));
        extra.insert("hexDigits".into(), json!(pure.len()));
    } else {
        let bytes = decode_hex(raw)?;
        let lossy = std::str::from_utf8(&bytes).is_err();
        let text = if charset == "latin1" {
            bytes.iter().map(|c| *c as char).collect::<String>()
        } else {
            String::from_utf8_lossy(&bytes).to_string()
        };
        let pure = hex(&bytes, upper);
        blocks.push(section(&format!(
            "{}{charset}",
            enc::t(en, "十六进制解码 · ", "Hex decode - ")
        )));
        blocks.push(if lossy {
            format!("{} {}", enc::t(en, "(非合法 UTF-8，按转义显示)", "(not valid UTF-8, shown as HEX)"), enc::spaced_hex(&bytes))
        } else if text.is_empty() {
            enc::t(en, "(解码结果为空)", "(the decoded result is empty)").to_string()
        } else {
            text.clone()
        });
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "字节数", "Byte count"), group_digits(bytes.len())),
            row(enc::t(en, "连续 HEX", "Contiguous HEX"), enc::preview(en, &pure, 96)),
            row(enc::t(en, "文本字符", "Text characters"), enc::code_points(&text).to_string()),
            row(
                enc::t(en, "再编码一致", "Re-encode matches"),
                if pure == hex(&input_bytes(&text, charset), upper) {
                    enc::t(en, "是", "Yes").to_string()
                } else {
                    enc::t(en, "否", "No").to_string()
                },
            ),
        ]);
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(enc::t(en, "· 解码先还原字节，再按 charset 解释为文本；latin1 可无损往返任意字节。", "- Decoding restores the bytes first, then reads them as text per charset; latin1 round-trips any byte losslessly.").to_string());
        extra.insert("bytes".into(), json!(bytes.len()));
        extra.insert("hexDigits".into(), json!(pure.len()));
        let mut result = emit("hex.txt", join_blocks(blocks.iter().map(String::as_str)), extra);
        if lossy {
            result.warnings.push(enc::t(en, "十六进制解码结果不是合法 UTF-8 文本，已按 HEX 显示。", "The hexadecimal decode result is not valid UTF-8 text, so it is shown as HEX.").to_string());
        }
        return Ok(result);
    }
    blocks.push(section(enc::t(en, "说明", "Notes")));
    blocks.push(notes.join("\n"));
    Ok(emit("hex.txt", join_blocks(blocks.iter().map(String::as_str)), extra))
}

fn radix_report(ctx: &RunContext<'_>, raw: &str) -> Result<ToolResult, EngineError> {
    let en = enc::is_en(ctx);
    let mode = if string(ctx, "mode", "encode") == "decode" { "decode" } else { "encode" };
    let name = match string(ctx, "alphabet", "base32") {
        "base32-crockford" => "base32-crockford",
        "base58-btc" => "base58-btc",
        "base58-ripple" => "base58-ripple",
        "base36" => "base36",
        "base16" => "base16",
        _ => "base32",
    };
    let alphabet: &[u8] = match name {
        "base32" => b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
        "base32-crockford" => b"0123456789ABCDEFGHJKMNPQRSTVWXYZ",
        "base58-btc" => b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",
        "base58-ripple" => b"rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz",
        "base36" => b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        _ => b"0123456789ABCDEF",
    };
    let label = RADIX_LABELS
        .iter()
        .find(|(key, _, _)| *key == name)
        .map(|(_, zh, english)| enc::t(en, zh, english))
        .unwrap_or("Base32");
    let mut extra = serde_json::Map::new();
    extra.insert("mode".into(), json!(mode));
    extra.insert("alphabet".into(), json!(name));
    let mut blocks: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    if mode == "encode" {
        let bytes = raw.as_bytes();
        if bytes.is_empty() {
            return Err(super::hash::bad("input", "holds no content left to encode once whitespace is removed"));
        }
        let encoded = if name == "base32" {
            base32_encode(bytes, alphabet, true)
        } else if name == "base32-crockford" {
            base32_encode(bytes, alphabet, false)
        } else {
            radix_encode(bytes, alphabet)
        };
        blocks.push(section(&format!("{label}{}", enc::t(en, " · 编码", " encode"))));
        blocks.push(encoded.clone());
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "输入字符", "Input characters"), enc::code_points(raw).to_string()),
            row(
                enc::t(en, "输入字节", "Input bytes"),
                format!("{}{}", group_digits(bytes.len()), if en { " bytes (UTF-8)" } else { " 字节（UTF-8）" }),
            ),
            row(enc::t(en, "输出字符", "Output characters"), encoded.len().to_string()),
            row(enc::t(en, "字符表长度", "Alphabet length"), alphabet.len().to_string()),
            row(enc::t(en, "字节 HEX", "Byte HEX"), enc::preview(en, &enc::spaced_hex(bytes), 96)),
        ]);
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(
            match name {
                "base58-btc" | "base58-ripple" => enc::t(en, "· Base58 按大整数换算，每个前导 0x00 字节写成 1 个字符表首字符（Bitcoin 为 \"1\"）。", "- Base58 converts by big integer, and every leading 0x00 byte becomes one leading alphabet character (Bitcoin uses \"1\")."),
                "base36" => enc::t(en, "· Base36 按大整数换算（0-9A-Z），字节流视作一个大端整数。", "- Base36 converts by big integer (0-9A-Z), treating the byte stream as one big-endian integer."),
                "base32-crockford" => enc::t(en, "· Crockford 变体不写 = 填充，输出为大写。", "- The Crockford variant writes no = padding and outputs upper case."),
                "base16" => enc::t(en, "· Base16 与十六进制一一对应（每字节 2 字符），输出大写、无填充。", "- Base16 maps one-to-one to hexadecimal (2 characters per byte), output is upper case with no padding."),
                _ => enc::t(en, "· RFC 4648 Base32 每字节流按 5 位分组，输出补齐到 8 的倍数。", "- RFC 4648 Base32 groups the byte stream by 5 bits and pads the output to a multiple of 8."),
            }
            .to_string(),
        );
        extra.insert("inputBytes".into(), json!(bytes.len()));
        extra.insert("outputChars".into(), json!(encoded.len()));
    } else {
        let bytes = if name == "base32" || name == "base32-crockford" {
            base32_decode(raw, alphabet, name == "base32-crockford")?
        } else {
            radix_decode(raw, alphabet, name == "base36" || name == "base16")?
        };
        if bytes.is_empty() {
            return Err(super::hash::bad("input", "decodes to an empty byte sequence"));
        }
        let lossy = std::str::from_utf8(&bytes).is_err();
        let text = String::from_utf8_lossy(&bytes).to_string();
        let re_encoded = if name == "base32" {
            base32_encode(&bytes, alphabet, true)
        } else if name == "base32-crockford" {
            base32_encode(&bytes, alphabet, false)
        } else {
            radix_encode(&bytes, alphabet)
        };
        let normalized: String = raw.split_whitespace().collect::<String>().trim_end_matches('=').to_string();
        let stable = re_encoded.to_uppercase() == normalized.to_uppercase();
        blocks.push(section(&format!("{label}{}", enc::t(en, " · 解码", " decode"))));
        blocks.push(if lossy {
            format!("{} {}", enc::t(en, "(非合法 UTF-8，按转义显示)", "(not valid UTF-8, shown as HEX)"), enc::spaced_hex(&bytes))
        } else if text.is_empty() {
            enc::t(en, "(解码结果为空)", "(the decoded result is empty)").to_string()
        } else {
            text
        });
        let (head, rows_text) = stats_section(en, &[
            row(enc::t(en, "字节数", "Byte count"), group_digits(bytes.len())),
            row("HEX", enc::preview(en, &enc::spaced_hex(&bytes), 96)),
            row(enc::t(en, "大整数值", "Big integer value"), big_int_value(&bytes)),
            row(
                enc::t(en, "回编码一致", "Re-encode matches"),
                if stable {
                    enc::t(en, "是", "Yes").to_string()
                } else if en {
                    format!("No (canonical spelling {re_encoded})")
                } else {
                    format!("否（规范写法 {re_encoded}）")
                },
            ),
        ]);
        blocks.push(section(enc::t(en, "字节", "Bytes")));
        blocks.push(head);
        blocks.push(rows_text);
        notes.push(enc::t(en, "· 解码按字节还原，再按 UTF-8 解释为文本；不可打印时给出 HEX。", "- Decoding restores the bytes first, then reads them as UTF-8 text; unprintable input is shown as HEX.").to_string());
        notes.push(enc::t(en, "· 大整数值把解码字节视作一个无符号大端整数，可用于核对前导零（0x00000001 → 1）。", "- The big integer value treats the decoded bytes as one unsigned big-endian integer, which is handy to check leading zeros (0x00000001 -> 1).").to_string());
        extra.insert("decodedBytes".into(), json!(bytes.len()));
        extra.insert("stable".into(), json!(if stable { "yes" } else { "no" }));
        let mut result = emit("radix.txt", join_blocks(blocks.iter().map(String::as_str)), extra);
        if lossy {
            result.warnings.push(enc::t(en, "Base 解码结果不是合法 UTF-8 文本，已按 HEX 显示。", "The Base decode result is not valid UTF-8 text, so it is shown as HEX.").to_string());
        }
        if !stable {
            result.warnings.push(enc::t(en, "Base 再编码结果与输入不一致，输入可能含填充或非规范写法。", "Re-encoding the Base result differs from the input, which may carry padding or a non-canonical spelling.").to_string());
        }
        return Ok(result);
    }
    blocks.push(section(enc::t(en, "说明", "Notes")));
    blocks.push(notes.join("\n"));
    Ok(emit("radix.txt", join_blocks(blocks.iter().map(String::as_str)), extra))
}

fn big_int_value(bytes: &[u8]) -> String {
    let mut value = Vec::new();
    for byte in bytes {
        let mut carry = *byte as u32;
        for digit in value.iter_mut() {
            carry += (*digit as u32) << 8;
            *digit = (carry % 10) as u8;
            carry /= 10;
        }
        while carry > 0 {
            value.push((carry % 10) as u8);
            carry /= 10;
        }
    }
    if value.is_empty() {
        return "0".into();
    }
    value.iter().rev().map(|d| (b'0' + d) as char).collect()
}

