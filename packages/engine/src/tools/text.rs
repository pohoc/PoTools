//! Native implementations for text based calendar, duration and amount tools.

use super::{EngineError, RunContext, ToolResult};
mod amount;
mod calendar;
mod common;
mod cron;
mod date_diff;
mod date_format;
mod date_math;
mod date_ops;
mod duration;
pub mod fmt;
pub mod fmt_cal;
mod relative;
mod timezone_board;
mod workdays;
mod workdays_scan;

pub fn run(context: &RunContext<'_>) -> Result<Option<ToolResult>, EngineError> {
    let result = match context.tool {
        "timestamp" | "date-diff" | "date-math" => date_ops::run(context),
        "workdays" => workdays::run(context),
        "timezone-board" => timezone_board::run(context),
        "duration" => duration::run(context),
        "date-format" => date_format::run(context),
        "relative-time" => relative::run(context),
        "amount-convert" => amount::run(context),
        "cron" => cron::run(context),
        _ => return Ok(None),
    }?;
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::amount::{amount_number, amount_upper};
    use super::calendar::add_calendar;
    use super::common::*;
    use super::date_format::render_date_pattern;
    use super::date_ops::run_timestamp;
    use super::duration::run_duration;
    use super::timezone_board::run_timezone_board;
    use super::*;
    fn ctx<'a>(tool: &'a str, options: &'a serde_json::Value) -> RunContext<'a> {
        RunContext {
            tool,
            options,
            locale: "zh-CN",
            inputs: &[],
            name_pattern: None,
            runtime_data: None,
        }
    }
    #[test]
    fn duration_default_is_copyable_hhmmss() {
        let v = serde_json::json!({"value":"3735","unit":"s","style":"hhmmss"});
        let r = run_duration(&ctx("duration", &v)).unwrap();
        assert_eq!(r.text.as_deref(), Some("01:02:15\n"));
    }
    #[test]
    fn amount_upper_and_number_round_trip() {
        assert_eq!(amount_upper("1234.05").unwrap(), "壹仟贰佰叁拾肆元零伍分");
        assert_eq!(amount_number("壹仟贰佰叁拾肆元零伍分").unwrap(), "1234.05");
    }
    #[test]
    fn date_math_clamps_month_end() {
        let tz = chrono_tz::Asia::Shanghai;
        let base = parse_at("2024-01-31 12:00:00", tz).unwrap();
        let got = add_calendar(base, tz, "months", 1).unwrap();
        assert_eq!(fmt_local(got, tz), "2024-02-29 12:00:00");
    }
    #[test]
    fn timezone_board_accepts_iana_zones() {
        let v = serde_json::json!({"at":"2024-01-01T00:00:00Z","zones":"UTC\nAsia/Tokyo"});
        let r = run_timezone_board(&ctx("timezone-board", &v)).unwrap();
        assert!(r.text.unwrap().contains("Asia/Tokyo"));
    }
    #[test]
    fn date_format_preserves_literals_and_repeated_tokens() {
        let instant = parse_at("2024-02-29T13:04:05Z", chrono_tz::UTC).unwrap();
        assert_eq!(
            render_date_pattern(
                "YYYY-MM-DD HH:mm:ss [ddd] ddd",
                local(instant, chrono_tz::UTC),
                "en-US"
            ),
            "2024-02-29 13:04:05 [Thu] Thu"
        );
    }
    #[test]
    fn timestamp_respects_explicit_microsecond_unit() {
        let options = serde_json::json!({"input":"1700000000123456","unit":"us","style":"iso","timezone":"UTC"});
        let result = run_timestamp(&ctx("timestamp", &options)).unwrap();
        // isoInZone renders whole seconds only; sub-second precision is not shown.
        assert_eq!(result.text.as_deref(), Some("2023-11-14T22:13:20+00:00\n"));
    }
    #[test]
    fn duration_full_report_matches_product_framing() {
        let options = serde_json::json!({"value":"3735","unit":"s","style":"all"});
        let result = run_duration(&ctx("duration", &options)).unwrap();
        let text = result.text.unwrap();
        assert!(text.starts_with("── 时长换算 · 3735 秒 ─"));
        assert!(text.contains("── 写法 · HH:MM:SS ─"));
        assert!(text.contains("  HH:MM:SS  01:02:15"));
        assert!(text.contains("── 总量（各单位） ─"));
    }
    #[test]
    fn date_diff_matches_product_framing() {
        let options =
            serde_json::json!({"from":"2026-01-05","to":"2026-03-08","timezone":"Asia/Shanghai"});
        let result = super::date_diff::run(&ctx("date-diff", &options)).unwrap();
        let text = result.text.unwrap();
        assert!(text.starts_with("── 结果 ─"));
        assert!(text.contains("  日历分解  2个月 3天"));
        assert!(text.contains("── 总量（各单位） ─"));
        assert!(text.contains("  天    62 天"));
    }
    #[test]
    fn relative_time_matches_product_framing() {
        let options = serde_json::json!({"input":"2026-12-31 23:59:59","base":"2026-09-22 04:00:00","timezone":"Asia/Shanghai"});
        let result = super::relative::run(&ctx("relative-time", &options)).unwrap();
        let text = result.text.unwrap();
        assert!(text.starts_with("── 相对时间 · zh-CN · Asia/Shanghai ─"));
        assert!(text.contains("  口语        3个月后"));
        assert!(text.contains("── 倒计时 ─"));
    }
    #[test]
    fn timestamp_default_style_matches_product_framing() {
        let options = serde_json::json!({"input":"1700000000","timezone":"Asia/Shanghai"});
        let result = run_timestamp(&ctx("timestamp", &options)).unwrap();
        assert_eq!(
            result.text.as_deref(),
            Some("日期时间：2023-11-15 06:13:20\nUnix 秒：1700000000\nUnix 毫秒：1700000000000\n")
        );
    }
}
