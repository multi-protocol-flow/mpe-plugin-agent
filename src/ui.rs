//! UI Call handlers for design-time operations in Agent config panel.

use std::time::Instant;
use serde_json::json;

use crate::client::{build_client, join_endpoint};
use crate::types::{audit_tool_call_safety, LlmProviderConfig};

/// Handles `uiCall` design-time requests dispatched from the host / config panel.
pub async fn handle_ui_call(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match method {
        "test_connection" => test_connection(params).await,
        "list_models" => list_models(params).await,
        "test_tool_safety" => test_tool_safety(params).await,
        "submit_human_response" => submit_human_response(params).await,
        "interrupt_agent" => interrupt_agent(params).await,
        other => Err(format!("Unknown UI call method: {other}")),
    }
}

async fn extract_provider_config(params: &serde_json::Value) -> Result<LlmProviderConfig, String> {
    if let Some(provider_val) = params.get("provider") {
        serde_json::from_value(provider_val.clone())
            .map_err(|e| format!("Invalid provider config: {e}"))
    } else {
        serde_json::from_value(params.clone()).map_err(|e| format!("Invalid config: {e}"))
    }
}

async fn test_connection(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let provider = extract_provider_config(&params).await?;
    let client = build_client(&provider)?;
    let url = join_endpoint(&provider.base_url, "models");

    let start = Instant::now();
    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Connection test failed: {e}"))?;

    let latency_ms = start.elapsed().as_millis() as u64;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Ok(json!({
            "success": false,
            "latency_ms": latency_ms,
            "error": format!("HTTP {status}: {body}")
        }));
    }

    let json_val: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse JSON response: {e}"))?;

    let models_count = json_val
        .get("data")
        .and_then(|d| d.as_array())
        .map(|a| a.len())
        .unwrap_or(0);

    Ok(json!({
        "success": true,
        "latency_ms": latency_ms,
        "models_count": models_count,
        "message": format!("Connected successfully. {models_count} models available.")
    }))
}

async fn list_models(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let provider = extract_provider_config(&params).await?;
    let client = build_client(&provider)?;
    let url = join_endpoint(&provider.base_url, "models");

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch models: {e}"))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {body}"));
    }

    let json_val: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse JSON response: {e}"))?;

    let mut model_ids = Vec::new();
    if let Some(data) = json_val.get("data").and_then(|d| d.as_array()) {
        for item in data {
            if let Some(id) = item.get("id").and_then(|i| i.as_str()) {
                model_ids.push(id.to_string());
            }
        }
    }

    model_ids.sort();
    Ok(json!({ "models": model_ids }))
}

async fn test_tool_safety(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let node_type = params
        .get("node_type")
        .and_then(|v| v.as_str())
        .unwrap_or("db:query");
    let config = params
        .get("config")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let read_only_mode = params
        .get("read_only_mode")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);

    match audit_tool_call_safety(node_type, &config, read_only_mode) {
        Ok(_) => Ok(json!({ "allowed": true })),
        Err(err) => Ok(json!({ "allowed": false, "reason": err })),
    }
}
async fn submit_human_response(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let interaction_id = params
        .get("interaction_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing required parameter 'interaction_id'".to_string())?;

    let resp: crate::types::HumanResponse = if let Some(resp_val) = params.get("response") {
        if let Some(text_str) = resp_val.as_str() {
            crate::types::HumanResponse {
                text: Some(text_str.to_string()),
                ..Default::default()
            }
        } else {
            serde_json::from_value(resp_val.clone())
                .map_err(|e| format!("Invalid human response payload: {e}"))?
        }
    } else if let Some(text_str) = params.get("text").or_else(|| params.get("answer")).and_then(|v| v.as_str()) {
        crate::types::HumanResponse {
            text: Some(text_str.to_string()),
            ..Default::default()
        }
    } else {
        serde_json::from_value(params.clone())
            .map_err(|e| format!("Invalid human response payload: {e}"))?
    };

    let completed = crate::types::complete_interaction(interaction_id, resp);
    Ok(json!({
        "success": completed,
        "interaction_id": interaction_id,
        "message": if completed { "Response accepted by agent session" } else { "Interaction channel not found or expired" }
    }))
}

async fn interrupt_agent(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let execution_id = params
        .get("execution_id")
        .and_then(|v| v.as_str())
        .unwrap_or("default");

    let text = params
        .get("text")
        .or_else(|| params.get("message"))
        .or_else(|| params.get("content"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Missing interruption text / message".to_string())?;

    crate::types::push_interruption(execution_id, text.to_string());
    Ok(json!({
        "success": true,
        "execution_id": execution_id,
        "message": "Interruption instruction queued for next agent step boundary"
    }))
}
