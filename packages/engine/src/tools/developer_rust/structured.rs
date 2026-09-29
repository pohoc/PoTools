use super::shared::*;
use crate::{EngineError, RunContext, ToolResult};
use quick_xml::{events::Event, reader::Reader, XmlVersion};
use serde::Serialize;
use serde_json::{json, Map, Value};

pub fn run(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    match ctx.tool {
        "json-format" => json_format(ctx),
        "xml-format" => xml_format(ctx),
        "xml-json" => xml_json(ctx),
        "yaml-json" => yaml_json(ctx),
        _ => Err(err("Unsupported structured tool")),
    }
}
fn source<'a>(ctx: &RunContext<'a>) -> Result<&'a str, EngineError> {
    required(ctx)
}
fn json_value(ctx: &RunContext<'_>, source: &str) -> Result<Value, EngineError> {
    serde_json::from_str(source).map_err(|_| error(ctx, "dev.error.json"))
}
fn json_pretty(value: &Value, width: usize) -> Result<String, EngineError> {
    let mut bytes = Vec::new();
    let indent = vec![b' '; width];
    let formatter = serde_json::ser::PrettyFormatter::with_indent(&indent);
    let mut serializer = serde_json::Serializer::with_formatter(&mut bytes, formatter);
    value
        .serialize(&mut serializer)
        .map_err(|e| err(e.to_string()))?;
    String::from_utf8(bytes).map_err(|e| err(e.to_string()))
}
fn json_format(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let input = source(ctx)?;
    let value = json_value(ctx, input)?;
    let mode = if string(ctx, "mode", "") == "minify" {
        "minify"
    } else {
        "pretty"
    };
    let width = number(ctx, "indent", 2.0).trunc().clamp(1.0, 8.0) as usize;
    let text = if mode == "minify" {
        serde_json::to_string(&value).map_err(|e| err(e.to_string()))?
    } else {
        json_pretty(&value, width)?
    };
    Ok(output(
        "json-formatted.json",
        text.clone(),
        extra([
            (String::from("mode"), json!(mode)),
            (String::from("inputBytes"), json!(utf8_len(input))),
            (String::from("outputBytes"), json!(utf8_len(&text))),
        ]),
    ))
}

#[derive(Default)]
struct XmlNode {
    name: String,
    attrs: Map<String, Value>,
    children: Map<String, Value>,
    text: String,
}
impl XmlNode {
    fn value(self) -> Value {
        if self.attrs.is_empty() && self.children.is_empty() {
            return Value::String(self.text);
        }
        let mut value = self.attrs;
        if !self.text.is_empty() {
            value.insert("#text".into(), Value::String(self.text));
        }
        value.extend(self.children);
        Value::Object(value)
    }
}
fn node_from_start(
    ctx: &RunContext<'_>,
    start: &quick_xml::events::BytesStart<'_>,
) -> Result<XmlNode, EngineError> {
    let name = start.name().as_ref().to_string();
    let mut node = XmlNode {
        name,
        ..XmlNode::default()
    };
    for attr in start.attributes().with_checks(true) {
        let attr = attr.map_err(|_| error(ctx, "dev.error.xml"))?;
        let key = attr.key.as_ref().to_string();
        let value = attr
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|_| error(ctx, "dev.error.xml"))?;
        node.attrs
            .insert(format!("@_{key}"), Value::String(value.into_owned()));
    }
    Ok(node)
}
fn add_node(parent: &mut XmlNode, name: String, value: Value) {
    match parent.children.get_mut(&name) {
        None => {
            parent.children.insert(name, value);
        }
        Some(Value::Array(items)) => items.push(value),
        Some(existing) => {
            let first = existing.clone();
            *existing = Value::Array(vec![first, value]);
        }
    }
}
fn xml_parse(ctx: &RunContext<'_>, source: &str) -> Result<Value, EngineError> {
    let mut reader = Reader::from_str(source);
    reader.config_mut().trim_text(false);
    let mut stack: Vec<XmlNode> = Vec::new();
    let mut root = Map::new();
    let mut root_count = 0;
    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => stack.push(node_from_start(ctx, &event)?),
            Ok(Event::Empty(event)) => {
                let node = node_from_start(ctx, &event)?;
                let name = node.name.clone();
                let value = node.value();
                if let Some(parent) = stack.last_mut() {
                    add_node(parent, name, value);
                } else {
                    add_node_to_map(&mut root, name, value);
                    root_count += 1;
                }
            }
            Ok(Event::Text(event)) => {
                let decoded = event.xml_content(XmlVersion::Implicit1_0);
                let text = quick_xml::escape::unescape(&decoded)
                    .map_err(|_| error(ctx, "dev.error.xml"))?;
                if let Some(node) = stack.last_mut() {
                    node.text.push_str(&text);
                } else if !text.trim().is_empty() {
                    return Err(error(ctx, "dev.error.xml"));
                }
            }
            Ok(Event::CData(event)) => {
                let text = event.xml_content(XmlVersion::Implicit1_0);
                if let Some(node) = stack.last_mut() {
                    node.text.push_str(&text);
                } else if !text.trim().is_empty() {
                    return Err(error(ctx, "dev.error.xml"));
                }
            }
            Ok(Event::End(event)) => {
                let node = stack.pop().ok_or_else(|| error(ctx, "dev.error.xml"))?;
                if node.name != event.name().as_ref() {
                    return Err(error(ctx, "dev.error.xml"));
                }
                let name = node.name.clone();
                let value = node.value();
                if let Some(parent) = stack.last_mut() {
                    add_node(parent, name, value);
                } else {
                    add_node_to_map(&mut root, name, value);
                    root_count += 1;
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return Err(error(ctx, "dev.error.xml")),
        }
    }
    if !stack.is_empty() || root_count != 1 {
        return Err(error(ctx, "dev.error.xml"));
    }
    Ok(Value::Object(root))
}
fn add_node_to_map(parent: &mut Map<String, Value>, name: String, value: Value) {
    match parent.get_mut(&name) {
        None => {
            parent.insert(name, value);
        }
        Some(Value::Array(items)) => items.push(value),
        Some(existing) => {
            let first = existing.clone();
            *existing = Value::Array(vec![first, value]);
        }
    }
}
fn scalar_string(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn xml_node(name: &str, value: &Value, depth: usize, pretty: bool, suppress_empty: bool) -> String {
    let pad = if pretty {
        "  ".repeat(depth)
    } else {
        String::new()
    };
    let newline = if pretty { "\n" } else { "" };
    let mut attrs = String::new();
    let mut children = Vec::new();
    let mut text = None;
    if let Value::Object(object) = value {
        for (key, item) in object {
            if let Some(key) = key.strip_prefix("@_") {
                attrs.push_str(&format!(" {key}=\"{}\"", xml_escape(&scalar_string(item))));
            } else if key == "#text" {
                text = Some(scalar_string(item));
            } else if let Value::Array(items) = item {
                for child in items {
                    children.push(xml_node(key, child, depth + 1, pretty, suppress_empty));
                }
            } else {
                children.push(xml_node(key, item, depth + 1, pretty, suppress_empty));
            }
        }
    } else {
        text = Some(scalar_string(value));
    }
    let text_value = text.unwrap_or_default();
    if children.is_empty() && text_value.is_empty() {
        return if suppress_empty {
            format!("{pad}<{name}{attrs}/>")
        } else {
            format!("{pad}<{name}{attrs}></{name}>")
        };
    }
    if children.is_empty() {
        return format!("{pad}<{name}{attrs}>{}</{name}>", xml_escape(&text_value));
    }
    let body = if text_value.is_empty() {
        children.join(newline)
    } else {
        format!(
            "{}{}{}",
            xml_escape(&text_value),
            newline,
            children.join(newline)
        )
    };
    format!("{pad}<{name}{attrs}>{newline}{body}{newline}{pad}</{name}>")
}
fn xml_build(value: &Value, pretty: bool, suppress_empty: bool) -> Result<String, EngineError> {
    let object = value
        .as_object()
        .ok_or_else(|| err("XML root must be an object"))?;
    Ok(object
        .iter()
        .map(|(name, value)| xml_node(name, value, 0, pretty, suppress_empty))
        .collect::<Vec<_>>()
        .join(if pretty { "\n" } else { "" }))
}
fn xml_format(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let input = source(ctx)?;
    let value = xml_parse(ctx, input)?;
    let pretty = string(ctx, "mode", "") != "minify";
    let text = xml_build(&value, pretty, false)?;
    Ok(output(
        "xml-formatted.xml",
        text.clone(),
        extra([
            (
                String::from("mode"),
                json!(if pretty { "pretty" } else { "minify" }),
            ),
            (String::from("inputBytes"), json!(utf8_len(input))),
            (String::from("outputBytes"), json!(utf8_len(&text))),
        ]),
    ))
}
fn xml_json(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let direction = string(ctx, "direction", "");
    let (name, text) = if direction == "json-xml" {
        let value = json_value(ctx, source(ctx)?)?;
        if !value.is_object() {
            return Err(error(ctx, "dev.error.jsonRoot"));
        }
        ("converted.xml", xml_build(&value, true, true)?)
    } else {
        let value = xml_parse(ctx, source(ctx)?)?;
        ("converted.json", json_pretty(&value, 2)?)
    };
    Ok(output(
        name,
        text.clone(),
        extra([
            (String::from("direction"), json!(direction)),
            (String::from("outputBytes"), json!(utf8_len(&text))),
        ]),
    ))
}
fn yaml_json(ctx: &RunContext<'_>) -> Result<ToolResult, EngineError> {
    let direction = string(ctx, "direction", "");
    let (name, text) = if direction == "json-yaml" {
        let value = json_value(ctx, source(ctx)?)?;
        let text = serde_saphyr::to_string(&value).map_err(|_| error(ctx, "dev.error.json"))?;
        ("converted.yaml", text)
    } else {
        let value: Value =
            serde_saphyr::from_str(source(ctx)?).map_err(|_| error(ctx, "dev.error.yaml"))?;
        ("converted.json", json_pretty(&value, 2)?)
    };
    Ok(output(
        name,
        text.clone(),
        extra([
            (String::from("direction"), json!(direction)),
            (String::from("outputBytes"), json!(utf8_len(&text))),
        ]),
    ))
}
