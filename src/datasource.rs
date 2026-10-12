//! OpenAPI / Datasource conversion utilities for Agent dynamic tool calling.
//!
//! Maps browsable DataItems (from OpenAPI, Swagger, Postman, Eolink datasources)
//! into `AgentToolDefinition` structures with standard OpenAI Function Calling JSON Schemas.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::AgentToolDefinition;

/// Key-value metadata pair attached to a DataItem.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KeyValue {
    /// Metadata label (e.g. "Tag", "Version").
    pub label: String,
    /// Metadata value.
    pub value: String,
}

/// Generic DataItem representing an API endpoint or document node from a datasource plugin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DataItem {
    /// Unique item identifier within the datasource.
    pub id: String,
    /// Display name / summary.
    pub name: String,
    /// Protocol kind ("http", "grpc", etc.).
    #[serde(default)]
    pub protocol: Option<String>,
    /// HTTP method (GET, POST, etc.).
    #[serde(default)]
    pub method: Option<String>,
    /// URL path template (e.g. `/pets/{petId}`).
    #[serde(default)]
    pub path: Option<String>,
    /// Long description / doc summary.
    #[serde(default)]
    pub summary: Option<String>,
    /// Extra metadata key-value tags.
    #[serde(default)]
    pub extra: Vec<KeyValue>,
    /// Raw protocol context (NormalizedOperation JSON or OpenAPI AST).
    #[serde(default)]
    pub raw: Option<Value>,
}

/// Converts a list of datasource DataItems into executable `AgentToolDefinition`s.
pub fn convert_datasource_spec_to_tools(
    _datasource_type: &str,
    items: &[DataItem],
    base_url_override: Option<&str>,
) -> Vec<AgentToolDefinition> {
    let mut tools = Vec::new();

    for item in items {
        // Skip document overview items (e.g. root doc without HTTP method and path)
        let method_opt = item.method.as_deref().or_else(|| {
            item.raw
                .as_ref()
                .and_then(|r| r.get("method"))
                .and_then(Value::as_str)
        });

        let path_opt = item.path.as_deref().or_else(|| {
            item.raw
                .as_ref()
                .and_then(|r| r.get("path"))
                .and_then(Value::as_str)
        });

        let (method, path) = match (method_opt, path_opt) {
            (Some(m), Some(p)) => (m.to_uppercase(), p.to_string()),
            _ => continue, // Not an actionable API endpoint
        };

        // Construct identifier: <method>_<path_slug>
        let path_clean = path
            .trim_matches('/')
            .replace(['{', '}', '-', ':', '.', ' '], "_")
            .replace('/', "_");
        let slug = if path_clean.is_empty() {
            "root".to_string()
        } else {
            path_clean
        };
        let tool_id = format!("{}_{}", method.to_lowercase(), slug);

        // Tool name exposed to model
        let tool_name = item
            .raw
            .as_ref()
            .and_then(|r| r.get("operation_id").or_else(|| r.get("operationId")))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.replace(['-', ':', ' ', '.'], "_"))
            .unwrap_or_else(|| tool_id.clone());

        // Tool description
        let description = item
            .summary
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| {
                item.raw
                    .as_ref()
                    .and_then(|r| r.get("summary"))
                    .and_then(Value::as_str)
            })
            .or_else(|| {
                item.raw
                    .as_ref()
                    .and_then(|r| r.get("description"))
                    .and_then(Value::as_str)
            })
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{method} {path}"));

        // Fixed config for target http:request node
        let base_url = base_url_override
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("{{BASE_URL}}");

        let fixed_config = serde_json::json!({
            "url": format!("{}{}", base_url.trim_end_matches('/'), path),
            "method": method.to_lowercase(),
        });

        // Dynamic Schema for LLM parameters
        let mut properties = serde_json::Map::new();
        let mut required_fields = Vec::new();

        // 1. Path parameters from URL template `{id}`
        for segment in path.split('/') {
            if let Some(param) = segment.strip_prefix('{').and_then(|s| s.strip_suffix('}')) {
                properties.insert(
                    param.to_string(),
                    serde_json::json!({
                        "type": "string",
                        "description": format!("Path parameter for {param}")
                    }),
                );
                if !required_fields.contains(&param.to_string()) {
                    required_fields.push(param.to_string());
                }
            }
        }

        // 2. Query / header parameters from raw context
        if let Some(raw) = &item.raw {
            if let Some(params) = raw.get("parameters").and_then(Value::as_array) {
                for p in params {
                    let name = p.get("name").and_then(Value::as_str).unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let desc = p.get("description").and_then(Value::as_str).unwrap_or("");
                    let schema_type = p
                        .get("schema")
                        .and_then(|s| s.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("string");
                    let is_required = p.get("required").and_then(Value::as_bool).unwrap_or(false);

                    let mut prop_obj = serde_json::json!({
                        "type": schema_type,
                        "description": desc,
                    });

                    if let Some(schema) = p.get("schema") {
                        if let Some(enum_vals) = schema.get("enum") {
                            prop_obj["enum"] = enum_vals.clone();
                        }
                    }

                    properties.insert(name.to_string(), prop_obj);
                    if is_required && !required_fields.contains(&name.to_string()) {
                        required_fields.push(name.to_string());
                    }
                }
            }

            // 3. Request body schema
            let body_val = raw.get("request_body").or_else(|| raw.get("requestBody"));

            if let Some(body) = body_val {
                let schema_opt = body.get("schema").cloned().or_else(|| {
                    body.get("content")
                        .and_then(|c| c.get("application/json"))
                        .and_then(|j| j.get("schema"))
                        .cloned()
                });

                if let Some(schema) = schema_opt {
                    properties.insert("body".to_string(), schema);
                    if body
                        .get("required")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        required_fields.push("body".to_string());
                    }
                }
            }
        }

        let dynamic_schema = serde_json::json!({
            "type": "object",
            "properties": properties,
            "required": required_fields,
        });

        tools.push(AgentToolDefinition {
            id: tool_id,
            name: tool_name,
            description,
            tool_type: "standalone_action".to_string(),
            target_node_type: "http:request".to_string(),
            target_node_id: None,
            fixed_config,
            dynamic_schema,
            require_confirmation: false,
        });
    }

    tools
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_convert_openapi_items_to_tools() {
        let items = vec![
            // Root doc item (should be skipped)
            DataItem {
                id: "doc".to_string(),
                name: "Petstore API".to_string(),
                protocol: Some("other".to_string()),
                method: None,
                path: None,
                summary: Some("Swagger Petstore API Spec".to_string()),
                extra: vec![],
                raw: None,
            },
            // GET /pets/{petId}
            DataItem {
                id: "get_pet".to_string(),
                name: "Find pet by ID".to_string(),
                protocol: Some("http".to_string()),
                method: Some("GET".to_string()),
                path: Some("/pets/{petId}".to_string()),
                summary: Some("Returns a single pet".to_string()),
                extra: vec![],
                raw: Some(serde_json::json!({
                    "path": "/pets/{petId}",
                    "method": "get",
                    "operation_id": "getPetById",
                    "summary": "Find pet by ID",
                    "parameters": [
                        {
                            "name": "petId",
                            "in": "path",
                            "required": true,
                            "description": "ID of pet to return",
                            "schema": { "type": "integer" }
                        }
                    ]
                })),
            },
            // POST /pets
            DataItem {
                id: "add_pet".to_string(),
                name: "Add a new pet".to_string(),
                protocol: Some("http".to_string()),
                method: Some("POST".to_string()),
                path: Some("/pets".to_string()),
                summary: Some("Add a new pet to the store".to_string()),
                extra: vec![],
                raw: Some(serde_json::json!({
                    "path": "/pets",
                    "method": "post",
                    "operation_id": "addPet",
                    "request_body": {
                        "required": true,
                        "schema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string" },
                                "status": { "type": "string" }
                            },
                            "required": ["name"]
                        }
                    }
                })),
            },
        ];

        let tools = convert_datasource_spec_to_tools(
            "openapi",
            &items,
            Some("https://petstore.example.com/v2"),
        );
        assert_eq!(tools.len(), 2);

        // Check GET pet
        let get_tool = &tools[0];
        assert_eq!(get_tool.name, "getPetById");
        assert_eq!(get_tool.target_node_type, "http:request");
        assert_eq!(
            get_tool.fixed_config["url"],
            "https://petstore.example.com/v2/pets/{petId}"
        );
        assert_eq!(get_tool.fixed_config["method"], "get");
        assert!(get_tool.dynamic_schema["properties"]["petId"].is_object());
        assert_eq!(
            get_tool.dynamic_schema["required"],
            serde_json::json!(["petId"])
        );

        // Check POST pet
        let post_tool = &tools[1];
        assert_eq!(post_tool.name, "addPet");
        assert_eq!(post_tool.target_node_type, "http:request");
        assert_eq!(
            post_tool.fixed_config["url"],
            "https://petstore.example.com/v2/pets"
        );
        assert_eq!(post_tool.fixed_config["method"], "post");
        assert!(post_tool.dynamic_schema["properties"]["body"].is_object());
        assert_eq!(
            post_tool.dynamic_schema["required"],
            serde_json::json!(["body"])
        );
    }
}
