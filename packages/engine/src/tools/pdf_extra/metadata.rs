use super::{
    boolean, info_dict, json_artifact, load, map, metadata_report, remove_xmp, save,
    set_info_string, store_info, string, EngineResult,
};
use crate::services::naming::{base_name, dedupe, render_name, NameContext};
use crate::{Artifact, EngineError, RunContext, ToolResult};
use chrono::Utc;
use lopdf::text_string;
use serde_json::Value;

pub(super) fn run(ctx: &RunContext<'_>) -> EngineResult<Option<ToolResult>> {
    let mode = string(ctx.options, "mode", "write");
    let mut result = ToolResult::default();
    let mut reports = map();

    for input in ctx.inputs {
        let mut document = load(input)?;
        if mode == "read" {
            reports.insert(
                base_name(&input.name).to_owned(),
                metadata_report(&document),
            );
            continue;
        }

        let mut info = info_dict(&document);
        if mode == "clear" {
            for key in [
                b"Title".as_slice(),
                b"Author",
                b"Subject",
                b"Keywords",
                b"Creator",
                b"Producer",
                b"CreationDate",
                b"ModDate",
            ] {
                info.remove(key);
            }
        } else {
            for (option, key) in [
                ("title", b"Title".as_slice()),
                ("author", b"Author"),
                ("subject", b"Subject"),
                ("keywords", b"Keywords"),
                ("creator", b"Creator"),
                ("producer", b"Producer"),
            ] {
                let value = string(ctx.options, option, "");
                if !value.trim().is_empty() {
                    let normalized = if option == "keywords" {
                        value
                            .split([',', '，', ';', '；'])
                            .map(str::trim)
                            .filter(|item| !item.is_empty())
                            .collect::<Vec<_>>()
                            .join(", ")
                    } else {
                        value.trim().to_owned()
                    };
                    set_info_string(&mut info, key, &normalized);
                }
            }
        }
        // pdf-lib updates these fields as part of every save. Keep its visible
        // metadata behavior when writing or clearing through the Rust engine.
        let saved_at = Utc::now().format("D:%Y%m%d%H%M%SZ").to_string();
        if info.get(b"Creator").is_err() {
            set_info_string(
                &mut info,
                b"Creator",
                "pdf-lib (https://github.com/Hopding/pdf-lib)",
            );
        }
        set_info_string(
            &mut info,
            b"Producer",
            "pdf-lib (https://github.com/Hopding/pdf-lib)",
        );
        set_info_string(&mut info, b"ModDate", &saved_at);
        if info.get(b"CreationDate").is_err() {
            info.set(b"CreationDate".to_vec(), text_string(&saved_at));
        }
        store_info(&mut document, info);
        if boolean(ctx.options, "stripXmp", false) {
            remove_xmp(&mut document)?;
        }
        let bytes = save(&mut document)?;
        let output_name = render_name(
            ctx.name_pattern,
            NameContext {
                name: base_name(&input.name),
                tool: if mode == "clear" { "clean" } else { "meta" },
                index: None,
                total: None,
                range: None,
            },
            "pdf",
        );
        let output_name = dedupe(output_name, |candidate| {
            result
                .artifacts
                .iter()
                .any(|artifact| artifact.name == candidate)
        });
        let mut artifact = Artifact::new(output_name, "pdf", bytes);
        artifact.source_file_id = Some(input.id.clone());
        result.artifacts.push(artifact);
    }

    if mode == "read" {
        if reports.is_empty() {
            return Err(EngineError::new("bad_request", "没有可读取的文档"));
        }
        result.artifacts.push(json_artifact(
            "document-info.json".to_owned(),
            Value::Object(reports.clone()),
        ));
        result
            .extra
            .insert("documents".into(), Value::from(reports.len()));
    } else {
        result.extra.insert("mode".into(), Value::from(mode));
    }
    Ok(Some(result))
}
