//! Declarative tool option schemas shared by UI generation and engine validation.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowIf {
    pub field: String,
    #[serde(rename = "in")]
    pub values: Vec<Value>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FieldSection {
    Main,
    Layout,
    Advanced,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldPreset {
    pub value: Value,
    pub label_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldOption {
    pub value: Value,
    pub label_key: String,
    pub description_key: Option<String>,
    pub applies: Option<Map<String, Value>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FieldKind {
    Text {
        placeholder_key: Option<String>,
        max_length: Option<u32>,
        mono: Option<bool>,
        required: Option<bool>,
        presets: Option<Vec<FieldPreset>>,
    },
    Password {
        placeholder_key: Option<String>,
        max_length: Option<u32>,
        required: Option<bool>,
        auto_complete: Option<String>,
    },
    Textarea {
        placeholder_key: Option<String>,
        mono: Option<bool>,
        rows: Option<u32>,
        max_length: Option<u32>,
        required: Option<bool>,
    },
    Number {
        min: Option<f64>,
        max: Option<f64>,
        step: Option<f64>,
        suffix_key: Option<String>,
        display_unit: Option<String>,
    },
    Boolean,
    Select {
        options: Vec<FieldOption>,
        presentation: Option<String>,
    },
    Slider {
        min: f64,
        max: f64,
        step: f64,
        unit: Option<String>,
        display_unit: Option<String>,
        presets: Option<Vec<FieldPreset>>,
    },
    Color,
    Timezone,
    DateTime {
        placeholder_key: Option<String>,
        mono: Option<bool>,
        required: Option<bool>,
        allow_time: Option<bool>,
        presets: Option<Vec<String>>,
    },
    PageRanges {
        placeholder_key: Option<String>,
        allow_empty: Option<bool>,
        allow_all: Option<bool>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolField {
    pub key: String,
    pub label_key: String,
    pub description_key: Option<String>,
    pub section: Option<FieldSection>,
    pub show_if: Option<ShowIf>,
    pub row: Option<String>,
    pub ui_only: Option<bool>,
    pub default: Value,
    #[serde(flatten)]
    pub kind: FieldKind,
}

pub fn fields_of(fields: &[ToolField]) -> Map<String, Value> {
    fields
        .iter()
        .map(|field| (field.key.clone(), field.default.clone()))
        .collect()
}

pub fn visible_fields<'a>(
    fields: &'a [ToolField],
    values: &Map<String, Value>,
) -> Vec<&'a ToolField> {
    fields
        .iter()
        .filter(|field| match &field.show_if {
            None => true,
            Some(condition) => values
                .get(&condition.field)
                .is_some_and(|value| condition.values.contains(value)),
        })
        .collect()
}
