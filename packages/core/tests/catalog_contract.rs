//! CAT-01: mechanical contract checks for the shipped tool catalogs.
//!
//! Serde already proves the *shape* of every `ToolDescriptor` (known field
//! names, `type` tags that exist, enum values that parse). It cannot prove the
//! things that only make sense across several objects, and each of those is a
//! real class of bug:
//!
//! * `id` uniqueness across the 14 domain files — duplicate ids shadow each
//!   other in routing and in the embedded registry.
//! * `fields[].key` uniqueness per tool — the last entry wins in `fields_of()`,
//!   so an earlier default silently disappears.
//! * `default` matching the declared schema `type` — otherwise the UI submits a
//!   value the engine does not expect.
//! * `showIf.field` pointing at a real key whose values it can actually match —
//!   a typo leaves a control permanently hidden.
//! * `select` option `value`s being stable ids, not localized titles — values
//!   go into option payloads, persisted drafts and golden files.
//!
//! i18n key existence lives in `scripts/check-catalog-contract.mjs` instead,
//! because the message tables are TypeScript under `apps/web` and Rust must not
//! reach into UI code. Both run from `pnpm check`.

use potools_core::fields::{FieldKind, ToolField};
use potools_core::tools::{ToolDescriptor, CATALOG_SOURCES};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::OnceLock;

/// Parse every embedded catalog on its own so a finding can name the JSON file
/// it came from (the concatenated `all_tools()` view cannot). Cached because all
/// checks here walk the same ~187 KB of JSON.
fn catalogs() -> &'static [(&'static str, Vec<ToolDescriptor>)] {
    static PARSED: OnceLock<Vec<(&'static str, Vec<ToolDescriptor>)>> = OnceLock::new();
    PARSED.get_or_init(|| {
        CATALOG_SOURCES
            .iter()
            .map(|(file, source)| {
                let tools =
                    serde_json::from_str::<Vec<ToolDescriptor>>(source).unwrap_or_else(|error| {
                        panic!("{file}: catalog does not deserialize: {error}")
                    });
                (*file, tools)
            })
            .collect()
    })
}

/// `(file, tools)` pairs with both halves already borrowed, so the checks below
/// read as plain loops.
fn entries() -> impl Iterator<Item = (&'static str, &'static [ToolDescriptor])> {
    catalogs()
        .iter()
        .map(|(file, tools)| (*file, tools.as_slice()))
}

fn report(findings: &mut Vec<String>, file: &str, tool: &str, subject: &str, problem: &str) {
    findings.push(format!("{file} > tool '{tool}' > {subject}: {problem}"));
}

fn fail(findings: &[String]) -> ! {
    panic!(
        "{} catalog contract finding(s):\n{}",
        findings.len(),
        findings.join("\n")
    )
}

fn json_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// The catalog `type` tag for a field kind, so messages quote the JSON the
/// author wrote rather than a Rust variant name.
fn kind_label(kind: &FieldKind) -> &'static str {
    match kind {
        FieldKind::Text { .. } => "text",
        FieldKind::Password { .. } => "password",
        FieldKind::Textarea { .. } => "textarea",
        FieldKind::Number { .. } => "number",
        FieldKind::Boolean => "boolean",
        FieldKind::Select { .. } => "select",
        FieldKind::Slider { .. } => "slider",
        FieldKind::Color => "color",
        FieldKind::Timezone => "timezone",
        FieldKind::DateTime { .. } => "dateTime",
        FieldKind::PageRanges { .. } => "pageRanges",
    }
}

fn is_textual(kind: &FieldKind) -> bool {
    matches!(
        kind,
        FieldKind::Text { .. }
            | FieldKind::Password { .. }
            | FieldKind::Textarea { .. }
            | FieldKind::Color
            | FieldKind::Timezone
            | FieldKind::DateTime { .. }
            | FieldKind::PageRanges { .. }
    )
}

/// Declared numeric range, if the kind has one (`slider` bounds are required).
fn numeric_bounds(kind: &FieldKind) -> Option<(Option<f64>, Option<f64>)> {
    match kind {
        FieldKind::Number { min, max, .. } => Some((*min, *max)),
        FieldKind::Slider { min, max, .. } => Some((Some(*min), Some(*max))),
        _ => None,
    }
}

fn options_of(kind: &FieldKind) -> Option<&[potools_core::fields::FieldOption]> {
    match kind {
        FieldKind::Select { options, .. } => Some(options),
        _ => None,
    }
}

/// A `select` option `value` is an identifier: it is persisted, compared by
/// `showIf`, sent to the engine and matched against golden files. Localized
/// titles belong in `labelKey`.
fn stable_id_problem(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            if text.is_empty() {
                return Some("value is an empty string".to_owned());
            }
            if !text.is_ascii() {
                return Some(format!(
                    "value '{text}' is not ASCII: option values must be stable ids, \
                     localized text belongs in labelKey"
                ));
            }
            if !text.chars().all(|c| c.is_ascii_graphic()) {
                return Some(format!(
                    "value {text:?} contains whitespace or control characters; \
                     use a single stable token"
                ));
            }
            None
        }
        Value::Number(_) => None,
        other => Some(format!(
            "value must be a string or number id, found {}",
            json_type(other)
        )),
    }
}

/// Does `default` have the JSON type the declared `type` implies, and for
/// `select` is it one of the options?
fn default_problem(field: &ToolField) -> Option<String> {
    let default = &field.default;
    let label = kind_label(&field.kind);
    let mismatch = |expected: &str| {
        format!(
            "`default` {default} is {} but type '{label}' expects {expected}",
            json_type(default)
        )
    };
    if is_textual(&field.kind) {
        return (!default.is_string()).then(|| mismatch("a string"));
    }
    if matches!(&field.kind, FieldKind::Boolean) {
        return (!default.is_boolean()).then(|| mismatch("true/false"));
    }
    if numeric_bounds(&field.kind).is_some() {
        return (!default.is_number()).then(|| mismatch("a number"));
    }
    if let Some(options) = options_of(&field.kind) {
        if options.iter().any(|option| &option.value == default) {
            return None;
        }
        let allowed = options
            .iter()
            .map(|option| option.value.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Some(format!(
            "`default` {default} is not one of the select option values [{allowed}]"
        ));
    }
    None
}

#[test]
fn tool_ids_are_unique_across_catalogs() {
    let mut findings = Vec::new();
    let mut seen: BTreeMap<&str, &str> = BTreeMap::new();
    for (file, tools) in entries() {
        for tool in tools {
            if let Some(first) = seen.insert(tool.id.as_str(), file) {
                report(
                    &mut findings,
                    file,
                    &tool.id,
                    "id",
                    &format!("duplicate tool id, also declared by {first}"),
                );
            }
        }
    }
    if !findings.is_empty() {
        fail(&findings);
    }
}

#[test]
fn field_keys_are_unique_per_tool() {
    let mut findings = Vec::new();
    for (file, tools) in entries() {
        for tool in tools {
            let mut seen: BTreeSet<&str> = BTreeSet::new();
            for field in &tool.fields {
                if !seen.insert(field.key.as_str()) {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        &format!("field '{}'", field.key),
                        "duplicate field key: the earlier default is overwritten",
                    );
                }
            }
        }
    }
    if !findings.is_empty() {
        fail(&findings);
    }
}

#[test]
fn field_defaults_match_declared_type() {
    let mut findings = Vec::new();
    for (file, tools) in entries() {
        for tool in tools {
            for field in &tool.fields {
                if let Some(problem) = default_problem(field) {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        &format!("field '{}'", field.key),
                        &problem,
                    );
                }
            }
        }
    }
    if !findings.is_empty() {
        fail(&findings);
    }
}

#[test]
fn numeric_defaults_and_bounds_are_consistent() {
    let mut findings = Vec::new();
    for (file, tools) in entries() {
        for tool in tools {
            for field in &tool.fields {
                let subject = format!("field '{}'", field.key);
                let Some((min, max)) = numeric_bounds(&field.kind) else {
                    continue;
                };
                if let (Some(min), Some(max)) = (min, max) {
                    if min > max {
                        report(
                            &mut findings,
                            file,
                            &tool.id,
                            &subject,
                            &format!("min {min} is greater than max {max}"),
                        );
                    }
                }
                if let FieldKind::Slider { step, .. } = &field.kind {
                    if *step <= 0.0 {
                        report(
                            &mut findings,
                            file,
                            &tool.id,
                            &subject,
                            &format!("slider `step` must be positive, found {step}"),
                        );
                    }
                }
                let Some(value) = field.default.as_f64() else {
                    continue;
                };
                if min.is_some_and(|min| value < min) || max.is_some_and(|max| value > max) {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        &subject,
                        &format!(
                            "`default` {value} is outside the declared range [{min:?}, {max:?}]"
                        ),
                    );
                }
            }
        }
    }
    if !findings.is_empty() {
        fail(&findings);
    }
}

#[test]
fn select_option_values_are_stable_ids() {
    let mut findings = Vec::new();
    for (file, tools) in entries() {
        for tool in tools {
            for field in &tool.fields {
                let Some(options) = options_of(&field.kind) else {
                    continue;
                };
                let mut seen: BTreeSet<String> = BTreeSet::new();
                for option in options {
                    if let Some(problem) = stable_id_problem(&option.value) {
                        report(
                            &mut findings,
                            file,
                            &tool.id,
                            &format!("field '{}' option {}", field.key, option.value),
                            &problem,
                        );
                    }
                    let rendered = option.value.to_string();
                    if !seen.insert(rendered.clone()) {
                        report(
                            &mut findings,
                            file,
                            &tool.id,
                            &format!("field '{}'", field.key),
                            &format!("duplicate select option value {rendered}"),
                        );
                    }
                }
            }
        }
    }
    if !findings.is_empty() {
        fail(&findings);
    }
}

#[test]
fn show_if_conditions_resolve_against_real_fields() {
    let mut findings = Vec::new();
    for (file, tools) in entries() {
        for tool in tools {
            let by_key: BTreeMap<&str, &ToolField> = tool
                .fields
                .iter()
                .map(|field| (field.key.as_str(), field))
                .collect();
            for field in &tool.fields {
                let Some(condition) = &field.show_if else {
                    continue;
                };
                let subject = format!("field '{}' showIf", field.key);
                if condition.field == field.key {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        &subject,
                        &format!("field '{}' gates on itself", field.key),
                    );
                    continue;
                }
                let Some(target) = by_key.get(condition.field.as_str()) else {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        &subject,
                        &format!(
                            "`field` '{}' is not a key of this tool, so the control never shows",
                            condition.field
                        ),
                    );
                    continue;
                };
                // An empty `in` list can never match any value, so the gated
                // control is permanently hidden — the same failure the `field`
                // check above exists to catch, just written as `in: []`.
                if condition.values.is_empty() {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        &subject,
                        &format!("`in` is empty, so '{}' can never be shown", field.key),
                    );
                    continue;
                }
                for value in &condition.values {
                    let problem = if let Some(options) = options_of(&target.kind) {
                        (!options.iter().any(|option| option.value == *value)).then(|| {
                            format!(
                                "showIf value {value} is not an option of '{}' (select)",
                                target.key
                            )
                        })
                    } else if matches!(&target.kind, FieldKind::Boolean) {
                        (!value.is_boolean()).then(|| {
                            format!(
                                "showIf value {value} must be a boolean to match '{}' (boolean)",
                                target.key
                            )
                        })
                    } else if numeric_bounds(&target.kind).is_some() {
                        (!value.is_number()).then(|| {
                            format!(
                                "showIf value {value} must be a number to match '{}' ({})",
                                target.key,
                                kind_label(&target.kind)
                            )
                        })
                    } else if !value.is_string() {
                        Some(format!(
                            "showIf value {value} must be a string to match '{}' ({})",
                            target.key,
                            kind_label(&target.kind)
                        ))
                    } else {
                        None
                    };
                    if let Some(problem) = problem {
                        report(&mut findings, file, &tool.id, &subject, &problem);
                    }
                }
            }
        }
    }
    if !findings.is_empty() {
        fail(&findings);
    }
}

#[test]
fn option_applies_and_preset_values_reference_real_fields_and_types() {
    let mut findings = Vec::new();
    for (file, tools) in entries() {
        for tool in tools {
            let keys: BTreeSet<&str> = tool.fields.iter().map(|field| field.key.as_str()).collect();
            for field in &tool.fields {
                let subject = format!("field '{}'", field.key);
                for option in options_of(&field.kind).unwrap_or_default() {
                    let Some(applies) = &option.applies else {
                        continue;
                    };
                    for (key, value) in applies {
                        if !keys.contains(key.as_str()) {
                            report(
                                &mut findings,
                                file,
                                &tool.id,
                                &format!("{} option {} applies", subject, option.value),
                                &format!("'{}' is not a field key of this tool", key),
                            );
                        } else if let Some(problem) = stable_id_problem(value) {
                            report(
                                &mut findings,
                                file,
                                &tool.id,
                                &format!("{} option {} applies '{}'", subject, option.value, key),
                                &problem,
                            );
                        }
                    }
                }
                let presets = match &field.kind {
                    FieldKind::Text { presets, .. } | FieldKind::Slider { presets, .. } => {
                        presets.as_deref()
                    }
                    _ => None,
                };
                for preset in presets.unwrap_or_default() {
                    let wanted = if numeric_bounds(&field.kind).is_some() {
                        "number"
                    } else {
                        "string"
                    };
                    if json_type(&preset.value) != wanted {
                        report(
                            &mut findings,
                            file,
                            &tool.id,
                            &subject,
                            &format!(
                                "preset value {} is {} but type '{}' presets take a {wanted}",
                                preset.value,
                                json_type(&preset.value),
                                kind_label(&field.kind)
                            ),
                        );
                    }
                }
            }
        }
    }
    if !findings.is_empty() {
        fail(&findings);
    }
}

#[test]
fn tools_are_addressable_and_localizable() {
    let mut findings = Vec::new();
    for (file, tools) in entries() {
        for tool in tools {
            for (name, value) in [
                ("id", tool.id.as_str()),
                ("nameKey", tool.name_key.as_str()),
                ("descKey", tool.desc_key.as_str()),
                ("icon", tool.icon.as_str()),
                ("artifactKind", tool.artifact_kind.as_str()),
            ] {
                if value.trim().is_empty() {
                    report(
                        &mut findings,
                        file,
                        if tool.id.is_empty() {
                            "(no id)"
                        } else {
                            &tool.id
                        },
                        name,
                        "must not be empty",
                    );
                }
            }
            if tool.input_formats.is_empty() && tool.artifact_kind != "none" {
                report(
                    &mut findings,
                    file,
                    &tool.id,
                    "inputFormats",
                    "empty inputFormats next to a non-'none' artifactKind looks unintended",
                );
            }
        }
    }
    if !findings.is_empty() {
        fail(&findings);
    }
}

#[test]
fn every_catalog_file_on_disk_is_embedded_and_identical() {
    // The previous shape of this check compared `all_tools()` with `CATALOG_SOURCES`
    // — two views of the same constants, so it could never fail. What actually needs
    // proving is that the `include_str!` list matches the directory: a JSON file
    // added to `catalog/` but not embedded would be invisible to every other test
    // here, and a stale embed means the shipped registry is not the reviewed file.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("catalog");
    // Option data for a tool, not a tool list: `crate::id_photo` reads it directly.
    const OPTION_DATA_ONLY: [&str; 1] = ["id-photo.json"];

    let mut findings = Vec::new();
    let mut on_disk: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", dir.display()))
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.ends_with(".json").then_some(name)
        })
        .collect();
    on_disk.sort();

    let embedded: Vec<&str> = CATALOG_SOURCES.iter().map(|(file, _)| *file).collect();
    for name in &on_disk {
        if OPTION_DATA_ONLY.contains(&name.as_str()) {
            assert!(
                !embedded.contains(&name.as_str()),
                "{name} is listed as option data only but is also embedded as a tool list"
            );
            continue;
        }
        let source = match CATALOG_SOURCES.iter().find(|(file, _)| *file == name) {
            Some((_file, source)) => *source,
            None => {
                findings.push(format!(
                    "{name}: present on disk but not embedded in CATALOG_SOURCES"
                ));
                continue;
            }
        };
        let disk = std::fs::read_to_string(dir.join(name)).expect("read catalog file");
        if disk.replace("\r\n", "\n") != source.replace("\r\n", "\n") {
            findings.push(format!(
                "{name}: embedded copy differs from the file on disk"
            ));
        }
    }
    for name in &embedded {
        if !on_disk.iter().any(|file| file == name) {
            findings.push(format!("{name}: embedded but no such file on disk"));
        }
    }
    assert_eq!(
        on_disk.len(),
        embedded.len() + OPTION_DATA_ONLY.len(),
        "catalog file count drifted: disk {on_disk:?} vs embedded {embedded:?}"
    );
    if !findings.is_empty() {
        fail(&findings);
    }
}

/// RFC-0001 / `docs/standards/TOOL_INTERACTION.md` §1-2: every tool declares which
/// of the seven task shapes it is, and when it runs. `experience` is a required
/// field, so serde already refuses a tool that omits it — what is checked here is
/// the part serde cannot see: that the declared cadence is one the standard allows
/// for that kind of work, and that the classification actually spans the models.
#[test]
fn every_tool_declares_a_consistent_experience_model() {
    use potools_core::tools::{ExecutionMode, ExperienceKind};

    let mut findings = Vec::new();
    let mut kinds = BTreeMap::new();
    for (file, tools) in entries() {
        for tool in tools {
            let experience = tool.experience;
            *kinds
                .entry(format!("{:?}", experience.kind))
                .or_insert(0usize) += 1;
            // §2: automatic runs are reserved for cheap, side-effect-free local
            // work. This is checked for both `live` and `debounced` because
            // `useToolDraft` auto-runs on either — a network tool declared
            // `debounced` would silently issue outbound requests on a keystroke.
            if !matches!(experience.execution, ExecutionMode::Manual) {
                if tool
                    .network_access
                    .as_deref()
                    .is_some_and(|value| value != "none")
                {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        "experience.execution",
                        "an automatic run may not claim a tool that reaches the network",
                    );
                }
                if tool.multi_file {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        "experience.execution",
                        "an automatic run may not claim a multi-file batch job",
                    );
                }
                if tool.layout != potools_core::tools::ToolLayout::Text {
                    report(
                        &mut findings,
                        file,
                        &tool.id,
                        "experience.execution",
                        "a file tool may not auto-run: its result goes through the job queue, not the in-memory panel",
                    );
                }
            }
            // §2: `live` is additionally reserved for pure local transforms.
            if matches!(experience.execution, ExecutionMode::Live)
                && matches!(experience.kind, ExperienceKind::Generator)
            {
                report(
                    &mut findings,
                    file,
                    &tool.id,
                    "experience",
                    "a generator must not auto-rerun: it would replace the value the user is copying",
                );
            }
        }
    }

    // All seven shapes must be exercised: an unused kind means the migration from
    // the audit matrix dropped a model, and a template would ship unrouted.
    for kind in [
        "InstantTransform",
        "StructuredInspector",
        "Calculator",
        "Generator",
        "VisualEditor",
        "BatchProcessor",
        "GuidedWorkflow",
    ] {
        if !kinds.contains_key(kind) {
            findings.push(format!(
                "catalog-wide > experience.kind {kind}: no tool declares it"
            ));
        }
    }

    let total: usize = kinds.values().sum();
    assert_eq!(total, 98, "expected one experience entry per catalog tool");
    if !findings.is_empty() {
        fail(&findings);
    }
}
