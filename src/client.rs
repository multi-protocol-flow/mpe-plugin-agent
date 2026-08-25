//! HTTP client builder and OpenAI-compatible API interaction for Agent plugin.

use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::types::{ChatMessage, FunctionCall, LlmProviderConfig, TokenUsage, ToolCall};

/// Result of a single LLM API invocation.
#[derive(Debug, Clone, Default)]
pub struct LlmCallResult {
    pub content: Option<String>,
    pub reasoning_content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub token_usage: Option<TokenUsage>,
    pub raw_response: String,
    pub duration_ms: u64,
}

/// Builds a configured `reqwest::Client` with rustls.
pub fn build_client(config: &LlmProviderConfig) -> Result<reqwest::Client, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    if let Some(api_key) = &config.api_key {
        let trimmed = api_key.trim();
        if !trimmed.is_empty() {
            let auth_str = if trimmed.starts_with("Bearer ") {
                trimmed.to_string()
            } else {
                format!("Bearer {}", trimmed)
            };
            let mut val = HeaderValue::from_str(&auth_str)
                .map_err(|e| format!("Invalid API key header: {e}"))?;
            val.set_sensitive(true);
            headers.insert(AUTHORIZATION, val);
        }
    }

    if let Some(custom) = &config.custom_headers {
        for (k, v) in custom {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }
    }

    let timeout = Duration::from_millis(config.timeout_ms.max(1000));

    reqwest::Client::builder()
        .default_headers(headers)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Normalizes endpoint URL by joining path to base_url without double slashes.
pub fn join_endpoint(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let ep = endpoint.trim_start_matches('/');
    format!("{}/{}", base, ep)
}

/// Masks an API key for safe display (e.g. `sk-a1****bc23`).
pub fn mask_key(key: Option<&str>) -> String {
    match key {
        Some(k) if k.len() > 8 => {
            let start = &k[..4];
            let end = &k[k.len() - 4..];
            format!("{start}****{end}")
        }
        Some(k) if !k.is_empty() => "****".to_string(),
        _ => "(none)".to_string(),
    }
}

/// Calls OpenAI chat completions API with tools, streaming or non-streaming.
pub async fn call_chat_completion(
    client: &reqwest::Client,
    provider: &LlmProviderConfig,
    messages: &[ChatMessage],
    tools: &[serde_json::Value],
    temperature: f32,
    stream: bool,
) -> Result<LlmCallResult, String> {
    let url = join_endpoint(&provider.base_url, "chat/completions");

    let mut body = serde_json::Map::new();
    body.insert("model".to_string(), serde_json::json!(provider.model));
    body.insert("messages".to_string(), serde_json::json!(messages));
    body.insert("temperature".to_string(), serde_json::json!(temperature));

    if !tools.is_empty() {
        body.insert("tools".to_string(), serde_json::json!(tools));
        body.insert("tool_choice".to_string(), serde_json::json!("auto"));
    }

    if stream {
        body.insert("stream".to_string(), serde_json::json!(true));
        let mut stream_opts = serde_json::Map::new();
        stream_opts.insert("include_usage".to_string(), serde_json::json!(true));
        body.insert(
            "stream_options".to_string(),
            serde_json::Value::Object(stream_opts),
        );
    } else {
        body.insert("stream".to_string(), serde_json::json!(false));
    }

    let start_time = Instant::now();

    let res = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP request error to {url}: {e}"))?;

    let status = res.status();
    if !status.is_success() {
        let err_text = res
            .text()
            .await
            .unwrap_or_else(|_| "Failed to read error body".to_string());
        return Err(format!("LLM API returned HTTP {status}: {err_text}"));
    }

    if !stream {
        let text = res
            .text()
            .await
            .map_err(|e| format!("Failed to read response body: {e}"))?;
        let duration_ms = start_time.elapsed().as_millis() as u64;

        let json_val: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Failed to parse response JSON ({e}): {text}"))?;

        let choice = json_val
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|c| c.first())
            .and_then(|c| c.get("message"));

        let content = choice
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        let reasoning_content = choice
            .and_then(|m| m.get("reasoning_content").or_else(|| m.get("reasoning")))
            .and_then(|c| c.as_str())
            .map(|s| s.to_string());

        let mut tool_calls = Vec::new();
        if let Some(calls) = choice.and_then(|m| m.get("tool_calls")).and_then(|t| t.as_array()) {
            for call in calls {
                if let Ok(tc) = serde_json::from_value::<ToolCall>(call.clone()) {
                    tool_calls.push(tc);
                }
            }
        }

        let token_usage = json_val.get("usage").and_then(|u| {
            Some(TokenUsage {
                prompt_tokens: u.get("prompt_tokens")?.as_u64()? as u32,
                completion_tokens: u.get("completion_tokens")?.as_u64()? as u32,
                total_tokens: u.get("total_tokens")?.as_u64()? as u32,
            })
        });

        return Ok(LlmCallResult {
            content,
            reasoning_content,
            tool_calls,
            token_usage,
            raw_response: text,
            duration_ms,
        });
    }

    // Streaming SSE response
    let mut stream = res.bytes_stream().eventsource();
    let mut content_acc = String::new();
    let mut reasoning_acc = String::new();
    let mut tool_calls_map: HashMap<usize, (String, String, String, String)> = HashMap::new(); // index -> (id, kind, name, arguments)
    let mut token_usage = None;
    let mut raw_chunks = Vec::new();

    while let Some(event_res) = stream.next().await {
        let event = match event_res {
            Ok(ev) => ev,
            Err(err) => return Err(format!("SSE stream error: {err}")),
        };

        if event.data == "[DONE]" {
            break;
        }

        raw_chunks.push(event.data.clone());

        if let Ok(chunk_json) = serde_json::from_str::<serde_json::Value>(&event.data) {
            // Check usage in final chunk
            if let Some(u) = chunk_json.get("usage") {
                if let (Some(pt), Some(ct), Some(tt)) = (
                    u.get("prompt_tokens").and_then(|v| v.as_u64()),
                    u.get("completion_tokens").and_then(|v| v.as_u64()),
                    u.get("total_tokens").and_then(|v| v.as_u64()),
                ) {
                    token_usage = Some(TokenUsage {
                        prompt_tokens: pt as u32,
                        completion_tokens: ct as u32,
                        total_tokens: tt as u32,
                    });
                }
            }

            if let Some(choices) = chunk_json.get("choices").and_then(|c| c.as_array()) {
                if let Some(choice) = choices.first() {
                    if let Some(delta) = choice.get("delta") {
                        if let Some(c) = delta.get("content").and_then(|c| c.as_str()) {
                            content_acc.push_str(c);
                        }
                        if let Some(rc) = delta
                            .get("reasoning_content")
                            .or_else(|| delta.get("reasoning"))
                            .and_then(|c| c.as_str())
                        {
                            reasoning_acc.push_str(rc);
                        }
                        if let Some(tcs) = delta.get("tool_calls").and_then(|t| t.as_array()) {
                            for tc in tcs {
                                let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                                let entry = tool_calls_map.entry(idx).or_insert_with(|| {
                                    (
                                        String::new(),
                                        "function".to_string(),
                                        String::new(),
                                        String::new(),
                                    )
                                });

                                if let Some(id) = tc.get("id").and_then(|v| v.as_str()) {
                                    let trimmed = id.trim();
                                    if !trimmed.is_empty()
                                        && (entry.0.is_empty()
                                            || (entry.0 != trimmed && trimmed.len() > entry.0.len()))
                                    {
                                        entry.0 = trimmed.to_string();
                                    }
                                }
                                if let Some(kind) = tc.get("type").and_then(|v| v.as_str()) {
                                    entry.1 = kind.to_string();
                                }
                                if let Some(f) = tc.get("function") {
                                    if let Some(name) = f.get("name").and_then(|v| v.as_str()) {
                                        if entry.2.is_empty() {
                                            entry.2 = name.to_string();
                                        } else if entry.2 != name {
                                            if name.starts_with(&entry.2) {
                                                entry.2 = name.to_string();
                                            } else if !entry.2.contains(name) {
                                                entry.2.push_str(name);
                                            }
                                        }
                                    }
                                    if let Some(args) = f.get("arguments").and_then(|v| v.as_str()) {
                                        entry.3.push_str(args);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let duration_ms = start_time.elapsed().as_millis() as u64;

    let mut tool_calls = Vec::new();
    let mut indices: Vec<usize> = tool_calls_map.keys().copied().collect();
    indices.sort_unstable();
    for idx in indices {
        if let Some((id, kind, name, args)) = tool_calls_map.remove(&idx) {
            tool_calls.push(ToolCall {
                id: if id.is_empty() { format!("call_{idx}") } else { id },
                kind,
                function: FunctionCall {
                    name,
                    arguments: args,
                },
            });
        }
    }

    let final_content = if content_acc.is_empty() {
        None
    } else {
        Some(content_acc)
    };

    let final_reasoning = if reasoning_acc.is_empty() {
        None
    } else {
        Some(reasoning_acc)
    };

    Ok(LlmCallResult {
        content: final_content,
        reasoning_content: final_reasoning,
        tool_calls,
        token_usage,
        raw_response: raw_chunks.join("\n"),
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_join_endpoint() {
        assert_eq!(join_endpoint("https://api.openai.com/v1/", "/chat/completions"), "https://api.openai.com/v1/chat/completions");
        assert_eq!(join_endpoint("https://api.openai.com/v1", "chat/completions"), "https://api.openai.com/v1/chat/completions");
    }

    #[test]
    fn test_mask_key() {
        assert_eq!(mask_key(Some("sk-1234567890abcdef")), "sk-1****cdef");
        assert_eq!(mask_key(Some("short")), "****");
        assert_eq!(mask_key(None), "(none)");
    }

    #[test]
    fn test_build_client_success() {
        let provider = LlmProviderConfig {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: Some("sk-test12345678".to_string()),
            model: "gpt-4o".to_string(),
            timeout_ms: 5000,
            custom_headers: None,
        };
        let client = build_client(&provider);
        assert!(client.is_ok());
    }
}
