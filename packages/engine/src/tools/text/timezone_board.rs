//! Implementations for the timezone board text tool group.

use super::common::*;
use super::{EngineError, RunContext, ToolResult};
use chrono::Offset;
use chrono_tz::{OffsetComponents, Tz};
use serde_json::Map;
use std::str::FromStr;

pub(super) fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    run_timezone_board(ctx)
}

pub(super) fn run_timezone_board(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let zones = string(
        ctx,
        "zones",
        "Asia/Shanghai\nUTC\nAmerica/New_York\nEurope/London\nAsia/Tokyo",
    );
    let raw_zones: Vec<_> = zones
        .lines()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect();
    if raw_zones.is_empty() {
        return Err(err("Timezone list is empty"));
    }
    let mut valid: Vec<(&str, Tz)> = Vec::new();
    let mut invalid = Vec::new();
    for (index, name) in raw_zones.iter().enumerate() {
        if let Ok(tz) = Tz::from_str(name) {
            valid.push((*name, tz));
        } else {
            invalid.push(format!("{}: {name}", index + 1));
        }
    }
    let (reference, reference_zone) = valid.first().copied().unwrap_or(("UTC", chrono_tz::UTC));
    let at_raw = string(ctx, "at", "now");
    let at = parse_at(at_raw, reference_zone)?;
    let style = string(ctx, "style", "datetime");
    let style = if ["full", "date", "datetime"].contains(&style) {
        style
    } else {
        "datetime"
    };
    let show_day_shift = boolean(ctx, "showDayShift", true);
    let show_offset_delta = boolean(ctx, "showOffsetDelta", true);
    let mut lines = vec![format!(
        "Reference zone: {reference}\nInput: {at_raw} → {}\nUTC: {}",
        local(at, reference_zone).to_rfc3339(),
        fmt_local(at, chrono_tz::UTC)
    )];
    let mut baseline = None;
    let mut offsets = Vec::new();
    let mut dst_zones = Vec::new();
    let base_day = local(at, reference_zone).date_naive();
    let reference_offset = local(at, reference_zone).offset().fix().local_minus_utc() / 60;
    for (index, (name, tz)) in valid.iter().enumerate() {
        let p = local(at, *tz);
        let offset = p.offset().fix().local_minus_utc() / 60;
        let first_offset = *baseline.get_or_insert(reference_offset);
        offsets.push(offset);
        if p.offset().dst_offset() != chrono::Duration::zero() {
            dst_zones.push((*name).to_string());
        }
        let date = if style == "date" {
            p.format("%Y-%m-%d").to_string()
        } else if style == "full" {
            p.format("%A, %Y-%m-%d %H:%M:%S %Z").to_string()
        } else {
            p.format("%Y-%m-%d %H:%M").to_string()
        };
        let mut line = format!(
            "{}. {name}  {date} ({}) {}",
            index + 1,
            p.format("UTC%:z"),
            p.format("%a %Z"),
        );
        if show_day_shift {
            let shift = (p.date_naive() - base_day).num_days();
            if shift == 0 {
                line.push_str(" · same day");
            } else {
                line.push_str(&format!(" · {shift:+} day(s)"));
            }
        }
        if show_offset_delta {
            let delta = (offset - first_offset) as f64 / 60.0;
            line.push_str(&format!(" · Δ {delta:+} h"));
        }
        lines.push(line);
    }
    lines.push(format!(
        "\nOffset range: {} to {}",
        offsets
            .iter()
            .min()
            .map(|m| format_offset(*m))
            .unwrap_or_default(),
        offsets
            .iter()
            .max()
            .map(|m| format_offset(*m))
            .unwrap_or_default()
    ));
    lines.push(format!(
        "DST zones: {}",
        if dst_zones.is_empty() {
            "none".into()
        } else {
            dst_zones.join(", ")
        }
    ));
    if !invalid.is_empty() {
        lines.push(format!("Invalid zones skipped: {}", invalid.join("; ")));
    }
    let mut extra = Map::new();
    put(&mut extra, "zones", valid.len() as i64);
    put(&mut extra, "invalid", invalid.len() as i64);
    put(&mut extra, "reference", reference.to_string());
    put(&mut extra, "at", local(at, chrono_tz::UTC).to_rfc3339());
    put(&mut extra, "utc", fmt_local(at, chrono_tz::UTC));
    put(&mut extra, "style", style.to_string());
    put(&mut extra, "showDayShift", show_day_shift.to_string());
    put(&mut extra, "showOffsetDelta", show_offset_delta.to_string());
    Ok(output("timezone-board.txt", lines.join("\n"), extra))
}

pub(super) fn format_offset(minutes: i32) -> String {
    format!("UTC{:+03}:{:02}", minutes / 60, minutes.abs() % 60)
}
