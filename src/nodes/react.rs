//! ReAct autonomous agent node executor (`agent:react`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use mpe_plugin_sdk::pool::ConnectionPool;
use mpe_plugin_sdk::prelude::*;

use crate::client::{
    build_client, call_chat_completion, call_chat_completion_with_stream_channel, LlmCallResult,
    StreamChunkDelta,
};
use crate::types::{
    ask_human_tool_definition, audit_tool_call_safety, clear_execution_interactions,
    drain_interruptions, extract_json_from_text, merge_tool_config, next_interaction_id,
    register_interaction, tool_to_openai_function, truncate_error_message, truncate_tool_output,
    validate_structured_output, AgentReactConfig, AgentReactOutput, AgentToolDefinition,
    ChatMessage, HumanResponse, LlmProviderConfig, PendingInteraction, TimelineStep,
    TimelineToolCall, TokenUsage,
};

/// Tool execution dispatcher interface.
pub async fn execute_tool_dispatch(
    tool: &AgentToolDefinition,
    merged_config: &serde_json::Value,
    ctx: &mut ExecuteContext,
    fallback_provider: &LlmProviderConfig,
    pool: &Arc<ConnectionPool>,
    exec_id: &str,
    bridge_url: &str,
    bridge_token: &str,
) -> (bool, Option<serde_json::Value>, Option<String>, String, u64) {
    let start = Instant::now();

    // Log tool invocation to host
    let tool_name = if tool.name.is_empty() {
        &tool.id
    } else {
        &tool.name
    };
    ctx.log(
        "info",
        format!(
            "Agent invoking tool '{tool_name}' ({})",
            tool.target_node_type
        ),
    );

    let (success, output, error, raw_resp) = match tool.target_node_type.as_str() {
        "llm:chat" | "llm:structured" => {
            let mut tool_provider = fallback_provider.clone();
            if let Some(prov_uuid) = merged_config
                .get("provider_uuid")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                let override_timeout = merged_config
                    .get("override_timeout_ms")
                    .and_then(|v| v.as_u64());
                if let Ok(p) = crate::types::resolve_effective_provider(
                    pool,
                    Some(ctx.providers()),
                    exec_id,
                    Some(prov_uuid),
                    fallback_provider,
                    merged_config.get("override_model").and_then(|v| v.as_str()),
                    override_timeout,
                ) {
                    tool_provider = p;
                }
            } else if let Some(prov_val) = merged_config.get("provider") {
                if let Ok(mut p) = serde_json::from_value::<LlmProviderConfig>(prov_val.clone()) {
                    if p.api_key.as_deref().unwrap_or("").trim().is_empty() {
                        p.api_key = fallback_provider.api_key.clone();
                    }
                    if !p.base_url.trim().is_empty() {
                        tool_provider = p;
                    }
                }
            }

            if let Some(model_override) = merged_config
                .get("override_model")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                tool_provider.model = model_override.to_string();
            }

            let mut tool_messages = Vec::new();
            if let Some(msgs) = merged_config.get("messages").and_then(|v| v.as_array()) {
                for m in msgs {
                    let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
                    let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                    if !content.trim().is_empty() {
                        tool_messages.push(ChatMessage {
                            role: role.to_string(),
                            content: Some(content.to_string()),
                            reasoning_content: None,
                            name: None,
                            tool_call_id: None,
                            tool_calls: None,
                        });
                    }
                }
            }

            if let Some(single_msg) = merged_config
                .get("message")
                .or_else(|| merged_config.get("user_message"))
                .or_else(|| merged_config.get("input"))
                .or_else(|| merged_config.get("prompt"))
                .or_else(|| merged_config.get("query"))
                .or_else(|| merged_config.get("text"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
            {
                tool_messages.push(ChatMessage::user(single_msg));
            }

            if tool_messages.is_empty() {
                tool_messages.push(ChatMessage::user("Please provide a status check."));
            }

            let stream = merged_config
                .get("parameters")
                .and_then(|p| p.get("stream"))
                .or_else(|| merged_config.get("stream"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let temp = merged_config
                .get("parameters")
                .and_then(|p| p.get("temperature"))
                .or_else(|| merged_config.get("temperature"))
                .and_then(|v| v.as_f64())
                .map(|f| f as f32)
                .unwrap_or(0.7);

            match build_client(&tool_provider) {
                Err(build_err) => {
                    let err = format!("Failed to build client for {tool_name}: {build_err}");
                    (
                        false,
                        None,
                        Some(err.clone()),
                        format!("{{\"error\": \"{err}\"}}"),
                    )
                }
                Ok(client) => {
                    match call_chat_completion(
                        &client,
                        &tool_provider,
                        &tool_messages,
                        &[],
                        temp,
                        stream,
                    )
                    .await
                    {
                        Ok(res) => {
                            let content_text = res.content.clone().unwrap_or_default();
                            let output_val = serde_json::json!({
                                "status": "success",
                                "content": content_text,
                                "reasoning_content": res.reasoning_content,
                                "token_usage": res.token_usage,
                                "duration_ms": res.duration_ms,
                            });
                            let raw = output_val.to_string();
                            (true, Some(output_val), None, raw)
                        }
                        Err(call_err) => {
                            let err = format!("LLM call failed for {tool_name}: {call_err}");
                            (
                                false,
                                None,
                                Some(err.clone()),
                                format!("{{\"error\": \"{err}\"}}"),
                            )
                        }
                    }
                }
            }
        }
        _ if !bridge_url.is_empty() => {
            let timeout_ms = merged_config
                .get("timeout_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(60_000);
            let http_client = reqwest::Client::builder()
                .timeout(Duration::from_millis(timeout_ms.max(5000)))
                .build()
                .unwrap_or_default();

            let payload = serde_json::json!({
                "execution_id": exec_id,
                "node_type": tool.target_node_type,
                "config": merged_config,
            });

            match http_client
                .post(format!("{}/tool/execute", bridge_url.trim_end_matches('/')))
                .header("x-mpe-bridge-token", bridge_token)
                .json(&payload)
                .send()
                .await
            {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    if status == 200 {
                        match resp.json::<serde_json::Value>().await {
                            Ok(json_resp) => {
                                let success = json_resp
                                    .get("success")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                let output = json_resp.get("output").cloned();
                                let error = json_resp
                                    .get("error_message")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                let raw_resp = json_resp
                                    .get("raw_response")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .unwrap_or_else(|| json_resp.to_string());
                                (success, output, error, raw_resp)
                            }
                            Err(parse_err) => {
                                let err_msg = format!(
                                    "Failed to parse Tool Bridge JSON response: {parse_err}"
                                );
                                (
                                    false,
                                    None,
                                    Some(err_msg.clone()),
                                    format!("{{\"error\": \"{err_msg}\"}}"),
                                )
                            }
                        }
                    } else {
                        let text = resp.text().await.unwrap_or_default();
                        let err_msg = format!("Tool Bridge HTTP {status}: {text}");
                        (
                            false,
                            None,
                            Some(err_msg.clone()),
                            format!("{{\"error\": \"{err_msg}\"}}"),
                        )
                    }
                }
                Err(req_err) => {
                    let err_msg = format!("Tool Bridge dispatch failed: {req_err}");
                    (
                        false,
                        None,
                        Some(err_msg.clone()),
                        format!("{{\"error\": \"{err_msg}\"}}"),
                    )
                }
            }
        }
        "http:request" | "http" => {
            let url = merged_config
                .get("url")
                .and_then(|s| s.as_str())
                .unwrap_or("https://example.com");
            let method = merged_config
                .get("method")
                .and_then(|s| s.as_str())
                .unwrap_or("GET")
                .to_uppercase();

            if url.starts_with("http://") || url.starts_with("https://") {
                let timeout_ms = merged_config
                    .get("timeout_ms")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(15_000);
                let http_client = reqwest::Client::builder()
                    .timeout(Duration::from_millis(timeout_ms.max(2000)))
                    .build()
                    .unwrap_or_default();

                let req_builder = match method.as_str() {
                    "POST" => {
                        let body = merged_config
                            .get("body")
                            .unwrap_or(&serde_json::Value::Null);
                        http_client.post(url).json(body)
                    }
                    "PUT" => {
                        let body = merged_config
                            .get("body")
                            .unwrap_or(&serde_json::Value::Null);
                        http_client.put(url).json(body)
                    }
                    "DELETE" => http_client.delete(url),
                    _ => http_client.get(url),
                };

                match req_builder.send().await {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let text = resp.text().await.unwrap_or_default();
                        let parsed_json: Option<serde_json::Value> =
                            serde_json::from_str(&text).ok();
                        let result_val = serde_json::json!({
                            "status": status,
                            "url": url,
                            "data": parsed_json.unwrap_or_else(|| serde_json::json!(text)),
                        });
                        let raw = result_val.to_string();
                        (
                            status < 400,
                            Some(result_val),
                            if status >= 400 {
                                Some(format!("HTTP {status}"))
                            } else {
                                None
                            },
                            raw,
                        )
                    }
                    Err(err) => {
                        let err_msg = format!("HTTP request failed: {err}");
                        (
                            false,
                            None,
                            Some(err_msg.clone()),
                            format!("{{\"error\": \"{err_msg}\"}}"),
                        )
                    }
                }
            } else {
                let err_msg = format!(
                    "Invalid HTTP URL: '{url}' (must start with http:// or https://)"
                );
                (
                    false,
                    None,
                    Some(err_msg.clone()),
                    format!("{{\"error\": \"{err_msg}\"}}"),
                )
            }
        }
        other => {
            let err_msg = format!(
                "Tool Bridge is offline: cannot execute '{other}' without host connection. Please execute via MPE flow."
            );
            (
                false,
                None,
                Some(err_msg.clone()),
                format!("{{\"error\": \"{err_msg}\"}}"),
            )
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    (success, output, error, raw_resp, duration_ms)
}

/// Executes the `agent:react` node logic.
pub async fn execute_react(ctx: &mut ExecuteContext, pool: &Arc<ConnectionPool>) -> ExecuteResult {
    let config_val = ctx.config().clone();
    let config: AgentReactConfig = match serde_json::from_value(config_val) {
        Ok(cfg) => cfg,
        Err(err) => return ExecuteResult::fail(format!("Invalid agent:react config: {err}")),
    };

    let exec_id = ctx.execution_id().unwrap_or("default").to_string();
    // Extract Host Tool Bridge settings from providers, config, or environment
    let (bridge_url, bridge_token) = {
        let from_providers = ctx.providers().get("tool_bridge").and_then(|v| {
            let url = v.get("url").and_then(|u| u.as_str())?.to_string();
            let token = v.get("token").and_then(|t| t.as_str())?.to_string();
            Some((url, token))
        });

        let from_config = ctx.config().get("tool_bridge").and_then(|v| {
            let url = v.get("url").and_then(|u| u.as_str())?.to_string();
            let token = v.get("token").and_then(|t| t.as_str())?.to_string();
            Some((url, token))
        });

        let from_env = if let (Ok(url), Ok(token)) = (
            std::env::var("MPE_TOOL_BRIDGE_URL"),
            std::env::var("MPE_TOOL_BRIDGE_TOKEN"),
        ) {
            Some((url, token))
        } else {
            None
        };

        from_providers
            .or(from_config)
            .or(from_env)
            .unwrap_or_default()
    };

    if !bridge_url.is_empty() {
        ctx.log(
            "info",
            format!("Agent connected to Host Tool Bridge at {bridge_url}"),
        );
    }

    let provider = match crate::types::resolve_effective_provider(
        pool,
        Some(ctx.providers()),
        &exec_id,
        config.provider_uuid.as_deref(),
        &config.provider,
        config.override_model.as_deref(),
        config.override_timeout_ms,
    ) {
        Ok(p) => p,
        Err(err) => return ExecuteResult::fail(err),
    };

    if provider.model.trim().is_empty() {
        return ExecuteResult::fail("Model name is required in agent provider configuration");
    }

    let client = match build_client(&provider) {
        Ok(c) => c,
        Err(err) => return ExecuteResult::fail(err),
    };
    let mut tools_json: Vec<serde_json::Value> =
        config.tools.iter().map(tool_to_openai_function).collect();

    // Inject built-in ask_human tool if enabled and not already present
    if config.enable_ask_human
        && !tools_json.iter().any(|t| {
            t.get("function")
                .and_then(|f| f.get("name"))
                .and_then(|n| n.as_str())
                == Some("ask_human")
        })
    {
        tools_json.push(ask_human_tool_definition());
    }
    let user_prompt = config.user_prompt.trim();
    if user_prompt.is_empty() {
        return ExecuteResult::fail(crate::i18n::t(
            "Agent 目标提示词 (User Prompt) 不能为空，请在节点配置中输入具体执行任务或目标",
            "Agent user prompt cannot be empty; please configure a task goal in node User Prompt",
        ));
    }

    // Prepare initial conversation history
    let mut messages: Vec<ChatMessage> = Vec::new();
    let mut sys_prompt = config.system_prompt.trim().to_string();
    if config.structured_output_enabled {
        if let Some(schema) = &config.structured_output_schema {
            let schema_json =
                serde_json::to_string_pretty(schema).unwrap_or_else(|_| schema.to_string());
            sys_prompt.push_str(&format!(
                "\n\n[MANDATORY OUTPUT FORMAT]\nWhen you have concluded all necessary tool actions and are ready to output your final answer, you MUST respond ONLY with a valid JSON object matching this JSON Schema:\n{schema_json}\nDo NOT wrap the JSON in Markdown backticks or commentary."
            ));
        }
    }
    if !sys_prompt.is_empty() {
        messages.push(ChatMessage::system(sys_prompt));
    }
    messages.push(ChatMessage::user(user_prompt));
    let mut timeline: Vec<TimelineStep> = Vec::new();
    let mut total_token_usage = TokenUsage::default();
    let mut total_tool_calls_count = 0u32;
    let mut self_corrections_count = 0u32;
    let mut previous_round_had_error = false;
    let mut final_answer = String::new();
    let mut converged = false;
    let mut final_structured_output: Option<serde_json::Value> = None;
    let mut final_structured_errors: Option<Vec<String>> = None;
    let mut paused_total_duration = Duration::ZERO;
    let mut step_by_step_active = config.step_by_step;

    let overall_start = Instant::now();
    let max_timeout = Duration::from_secs(config.timeout_secs.max(1));
    let interaction_timeout = Duration::from_secs(config.interaction_timeout_secs.max(1));
    let is_non_interactive = std::env::var("MPE_NON_INTERACTIVE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        || exec_id.contains("_tool_node_")
        || config.mock_human_response.is_some();
    ctx.log(
        "info",
        format!(
            "Starting ReAct agent execution (max_iterations: {})",
            config.max_iterations
        ),
    );

    for round in 1..=config.max_iterations {
        let elapsed_active = overall_start
            .elapsed()
            .saturating_sub(paused_total_duration);
        if elapsed_active > max_timeout {
            ctx.log(
                "warn",
                format!("Agent execution timed out after {}s", config.timeout_secs),
            );
            break;
        }

        // 1. Process pending human interruptions / steering messages at step boundary
        let pending_interruptions = drain_interruptions(&exec_id);
        for interruption_text in pending_interruptions {
            ctx.log(
                "info",
                format!("Agent received human interruption: {interruption_text}"),
            );
            messages.push(ChatMessage::user(format!(
                "[Human Interruption / Steering]: {interruption_text}"
            )));
            ctx.emit(
                "stream",
                serde_json::json!({
                    "type": "interrupted",
                    "text": &interruption_text,
                    "step_index": round,
                }),
            )
            .await;
            timeline.push(TimelineStep {
                step_index: round,
                step_type: "interrupted".to_string(),
                thought: Some(interruption_text.clone()),
                tool_calls: Vec::new(),
                duration_ms: 0,
                self_correction: false,
                tokens: None,
                human_interaction: None,
                human_response: Some(HumanResponse {
                    text: Some(interruption_text),
                    ..Default::default()
                }),
            });
        }

        ctx.log(
            "info",
            format!("Agent round {round}/{} thinking...", config.max_iterations),
        );

        // 2. Real-time streaming LLM invocation with backpressure emit to host
        let llm_res_result = {
            let (stream_tx, mut stream_rx) =
                tokio::sync::mpsc::unbounded_channel::<StreamChunkDelta>();

            let call_fut = call_chat_completion_with_stream_channel(
                &client,
                &provider,
                &messages,
                &tools_json,
                config.temperature,
                config.stream,
                Some(stream_tx),
            );
            tokio::pin!(call_fut);

            let res = loop {
                tokio::select! {
                    call_res = &mut call_fut => break call_res,
                    Some(delta) = stream_rx.recv() => {
                        let is_reasoning = !delta.delta_reasoning.is_empty();
                        let chunk_text = if is_reasoning {
                            &delta.delta_reasoning
                        } else {
                            &delta.delta_content
                        };
                        ctx.emit(
                            "stream",
                            serde_json::json!({
                                "kind": if is_reasoning { "reasoning" } else { "content" },
                                "delta_reasoning": delta.delta_reasoning,
                                "delta_content": delta.delta_content,
                                "text": chunk_text,
                                "fullContent": delta.full_content,
                                "fullReasoning": delta.full_reasoning,
                                "step_index": round,
                            }),
                        )
                        .await;
                    }
                }
            };

            // Drain any remaining buffered chunk deltas
            while let Ok(delta) = stream_rx.try_recv() {
                let is_reasoning = !delta.delta_reasoning.is_empty();
                let chunk_text = if is_reasoning {
                    &delta.delta_reasoning
                } else {
                    &delta.delta_content
                };
                ctx.emit(
                    "stream",
                    serde_json::json!({
                        "kind": if is_reasoning { "reasoning" } else { "content" },
                        "delta_reasoning": delta.delta_reasoning,
                        "delta_content": delta.delta_content,
                        "text": chunk_text,
                        "fullContent": delta.full_content,
                        "fullReasoning": delta.full_reasoning,
                        "step_index": round,
                    }),
                )
                .await;
            }

            res
        };

        let llm_res: LlmCallResult = match llm_res_result {
            Ok(call_res) => call_res,
            Err(err) => {
                ctx.log(
                    "error",
                    format!("LLM API call failed in round {round}: {err}"),
                );
                timeline.push(TimelineStep {
                    step_index: round,
                    step_type: "error".to_string(),
                    thought: Some(format!("LLM invocation error: {err}")),
                    tool_calls: Vec::new(),
                    duration_ms: 0,
                    self_correction: previous_round_had_error,
                    tokens: None,
                    human_interaction: None,
                    human_response: None,
                });
                clear_execution_interactions(&exec_id);
                return ExecuteResult {
                    success: false,
                    next_ports: vec!["false".to_string()],
                    output_data: None,
                    errors: vec![err],
                    report_data: Some(
                        serde_json::to_value(AgentReactOutput {
                            success: false,
                            final_answer: "Execution failed due to LLM API error".to_string(),
                            iterations: round,
                            tool_call_count: total_tool_calls_count,
                            self_corrections_count,
                            token_usage: total_token_usage,
                            total_duration_ms: overall_start
                                .elapsed()
                                .saturating_sub(paused_total_duration)
                                .as_millis() as u64,
                            timeline,
                            structured_output: None,
                            structured_output_errors: None,
                        })
                        .unwrap_or_default(),
                    ),
                };
            }
        };

        if let Some(tokens) = &llm_res.token_usage {
            total_token_usage.prompt_tokens += tokens.prompt_tokens;
            total_token_usage.completion_tokens += tokens.completion_tokens;
            total_token_usage.total_tokens += tokens.total_tokens;
        }

        // Case A: Model decided NOT to call any tools (Converged to final answer)
        if llm_res.tool_calls.is_empty() {
            let candidate_answer = llm_res.content.clone().unwrap_or_default();

            if config.structured_output_enabled {
                if let Some(schema) = &config.structured_output_schema {
                    let parsed_opt = extract_json_from_text(&candidate_answer);
                    let validation_res = match &parsed_opt {
                        Some(val) => validate_structured_output(val, schema),
                        None => Err(vec!["Output is not valid JSON".to_string()]),
                    };

                    match validation_res {
                        Ok(()) => {
                            let parsed_val = parsed_opt.unwrap_or_default();
                            final_answer = candidate_answer;
                            final_structured_output = Some(parsed_val.clone());
                            converged = true;

                            if config.export_variables {
                                if let Some(obj) = parsed_val.as_object() {
                                    for (k, v) in obj {
                                        if !k.contains('.') {
                                            ctx.set_variable(k.clone(), v.clone());
                                        }
                                    }
                                }
                            }

                            timeline.push(TimelineStep {
                                step_index: round,
                                step_type: "final_answer".to_string(),
                                thought: llm_res.reasoning_content,
                                tool_calls: Vec::new(),
                                duration_ms: llm_res.duration_ms,
                                self_correction: previous_round_had_error,
                                tokens: llm_res.token_usage,
                                human_interaction: None,
                                human_response: None,
                            });

                            ctx.log(
                                "info",
                                format!("Agent converged in round {round} with structured output"),
                            );
                            ctx.emit(
                                "stream",
                                serde_json::json!({
                                    "type": "converged",
                                    "final_answer": &final_answer,
                                    "structured_output": &parsed_val,
                                    "iterations": round,
                                    "step_index": round,
                                }),
                            )
                            .await;
                            break;
                        }
                        Err(errors) => {
                            let error_details = errors.join("; ");
                            self_corrections_count += 1;
                            previous_round_had_error = true;

                            if round < config.max_iterations {
                                ctx.log(
                                    "warn",
                                    format!("Structured output validation failed in round {round}: {error_details}. Driving self-correction."),
                                );
                                timeline.push(TimelineStep {
                                    step_index: round,
                                    step_type: "self_correction".to_string(),
                                    thought: llm_res.reasoning_content.clone(),
                                    tool_calls: Vec::new(),
                                    duration_ms: llm_res.duration_ms,
                                    self_correction: true,
                                    tokens: llm_res.token_usage,
                                    human_interaction: None,
                                    human_response: None,
                                });

                                ctx.emit(
                                    "stream",
                                    serde_json::json!({
                                        "type": "self_correction",
                                        "error": &error_details,
                                        "iterations": round,
                                        "step_index": round,
                                    }),
                                )
                                .await;

                                messages.push(ChatMessage::assistant_text(
                                    candidate_answer,
                                    llm_res.reasoning_content,
                                ));
                                messages.push(ChatMessage::user(format!(
                                    "Structured Output Validation Failed: {error_details}. Please correct your response and output strictly conforming JSON."
                                )));
                                continue;
                            } else {
                                ctx.log(
                                    "error",
                                    format!("Structured output validation failed on final round {round}: {error_details}"),
                                );
                                timeline.push(TimelineStep {
                                    step_index: round,
                                    step_type: "error".to_string(),
                                    thought: llm_res.reasoning_content,
                                    tool_calls: Vec::new(),
                                    duration_ms: llm_res.duration_ms,
                                    self_correction: true,
                                    tokens: llm_res.token_usage,
                                    human_interaction: None,
                                    human_response: None,
                                });
                                final_structured_output = None;
                                final_structured_errors = Some(errors);
                                converged = false;
                                break;
                            }
                        }
                    }
                } else {
                    final_answer = candidate_answer;
                    converged = true;
                    timeline.push(TimelineStep {
                        step_index: round,
                        step_type: "final_answer".to_string(),
                        thought: llm_res.reasoning_content,
                        tool_calls: Vec::new(),
                        duration_ms: llm_res.duration_ms,
                        self_correction: previous_round_had_error,
                        tokens: llm_res.token_usage,
                        human_interaction: None,
                        human_response: None,
                    });
                    ctx.log(
                        "info",
                        format!("Agent converged in round {round} with final answer"),
                    );
                    ctx.emit(
                        "stream",
                        serde_json::json!({
                            "type": "converged",
                            "final_answer": &final_answer,
                            "iterations": round,
                            "step_index": round,
                        }),
                    )
                    .await;
                    break;
                }
            } else {
                final_answer = candidate_answer;
                converged = true;
                timeline.push(TimelineStep {
                    step_index: round,
                    step_type: "final_answer".to_string(),
                    thought: llm_res.reasoning_content,
                    tool_calls: Vec::new(),
                    duration_ms: llm_res.duration_ms,
                    self_correction: previous_round_had_error,
                    tokens: llm_res.token_usage,
                    human_interaction: None,
                    human_response: None,
                });
                ctx.log(
                    "info",
                    format!("Agent converged in round {round} with final answer"),
                );
                ctx.emit(
                    "stream",
                    serde_json::json!({
                        "type": "converged",
                        "final_answer": &final_answer,
                        "iterations": round,
                        "step_index": round,
                    }),
                )
                .await;
                break;
            }
        }

        let is_self_correction_round = previous_round_had_error;
        let mut step_tool_calls = Vec::new();
        let mut current_round_has_error = false;
        let mut round_human_interaction: Option<PendingInteraction> = None;
        let mut round_human_response: Option<HumanResponse> = None;

        // Record assistant's tool_calls message into conversation history
        let content_cleaned = match &llm_res.content {
            Some(c) if !c.trim().is_empty() => Some(c.clone()),
            _ => None,
        };
        messages.push(ChatMessage::assistant_tool_calls(
            content_cleaned,
            llm_res.reasoning_content.clone(),
            llm_res.tool_calls.clone(),
        ));

        let calls_to_exec = llm_res
            .tool_calls
            .iter()
            .take(config.max_tool_calls_per_round as usize);

        for tc in calls_to_exec {
            total_tool_calls_count += 1;
            let func_name = &tc.function.name;

            // Check if this is the built-in `ask_human` tool
            if func_name == "ask_human" {
                let question = serde_json::from_str::<serde_json::Value>(&tc.function.arguments)
                    .ok()
                    .and_then(|v| {
                        v.get("question")
                            .and_then(|q| q.as_str())
                            .map(|s| s.to_string())
                    })
                    .unwrap_or_else(|| {
                        if tc.function.arguments.trim().is_empty() {
                            "Agent requests clarification from user.".to_string()
                        } else {
                            tc.function.arguments.clone()
                        }
                    });

                let interaction_id = next_interaction_id("ask", &exec_id);
                let (tx, rx) = tokio::sync::oneshot::channel();
                register_interaction(&interaction_id, tx);

                let now_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let pending = PendingInteraction {
                    interaction_id: interaction_id.clone(),
                    execution_id: exec_id.clone(),
                    interaction_type: "ask_human".to_string(),
                    prompt: question.clone(),
                    tool_id: Some("ask_human".to_string()),
                    tool_name: Some("ask_human".to_string()),
                    input_args: Some(serde_json::json!({ "question": &question })),
                    step_index: Some(round),
                    created_at_ms: now_ms,
                };

                ctx.log("info", format!("Agent asking human: {question}"));
                ctx.emit(
                    "stream",
                    serde_json::json!({
                        "type": "waiting_human",
                        "interaction": &pending,
                        "step_index": round,
                    }),
                )
                .await;

                let pause_start = Instant::now();
                let human_resp = if is_non_interactive {
                    let default_text = config.mock_human_response.clone().unwrap_or_else(|| {
                        "Non-interactive environment / single node test: human input not available. Proceed with autonomous reasoning.".to_string()
                    });
                    ctx.log("info", format!("ask_human auto-resumed: {default_text}"));
                    HumanResponse {
                        text: Some(default_text),
                        ..Default::default()
                    }
                } else {
                    match tokio::time::timeout(interaction_timeout, rx).await {
                        Ok(Ok(resp)) => resp,
                        Ok(Err(_)) => HumanResponse {
                            text: Some("Human response channel closed".to_string()),
                            ..Default::default()
                        },
                        Err(_) => {
                            crate::types::cancel_interaction(&interaction_id);
                            ctx.log(
                                "warn",
                                format!(
                                    "Timed out after {}s waiting for human response to question: {question}",
                                    interaction_timeout.as_secs()
                                ),
                            );
                            ctx.emit(
                                "stream",
                                serde_json::json!({
                                    "type": "human_timeout",
                                    "interaction_id": &interaction_id,
                                    "step_index": round,
                                }),
                            )
                            .await;
                            HumanResponse {
                                text: Some("Timed out waiting for human user response. Proceed with best autonomous judgment.".to_string()),
                                ..Default::default()
                            }
                        }
                    }
                };
                let pause_dur = pause_start.elapsed();
                paused_total_duration += pause_dur;
                let user_answer = human_resp
                    .text
                    .clone()
                    .unwrap_or_else(|| "Confirmed".to_string());

                ctx.log("info", format!("Human response received: {user_answer}"));
                ctx.emit(
                    "stream",
                    serde_json::json!({
                        "type": "human_resumed",
                        "interaction_id": &interaction_id,
                        "prompt": &pending.prompt,
                        "tool_name": &pending.tool_name,
                        "response": &human_resp,
                        "user_answer": &user_answer,
                        "step_index": round,
                    })
                )
                .await;

                round_human_interaction = Some(pending.clone());
                round_human_response = Some(human_resp.clone());

                messages.push(ChatMessage::tool_result(&tc.id, &user_answer));

                step_tool_calls.push(TimelineToolCall {
                    call_id: tc.id.clone(),
                    tool_id: "ask_human".to_string(),
                    tool_name: "ask_human".to_string(),
                    node_type: "human:interaction".to_string(),
                    input_args: serde_json::json!({ "question": &question }),
                    merged_config: serde_json::json!({ "question": &question }),
                    success: true,
                    output_data: Some(serde_json::json!({
                        "question": &question,
                        "user_response": &user_answer,
                        "answer": &user_answer,
                    })),
                    error_message: None,
                    raw_response: user_answer,
                    duration_ms: pause_dur.as_millis() as u64,
                });
                continue;
            }

            // Find matching registered tool definition
            let tool_def = config.tools.iter().find(|t| {
                t.name == *func_name
                    || t.id == *func_name
                    || t.name.replace(' ', "_") == *func_name
                    || t.name.replace('_', " ") == *func_name
                    || t.name.to_lowercase() == func_name.to_lowercase()
            });

            match tool_def {
                None => {
                    let err_msg = format!("Tool '{func_name}' is not registered");
                    current_round_has_error = true;
                    self_corrections_count += 1;

                    messages.push(ChatMessage::tool_result(
                        &tc.id,
                        format!(
                            "Error: {err_msg}. Available tools: {:?}",
                            config.tools.iter().map(|t| &t.name).collect::<Vec<_>>()
                        ),
                    ));

                    step_tool_calls.push(TimelineToolCall {
                        call_id: tc.id.clone(),
                        tool_id: func_name.clone(),
                        tool_name: func_name.clone(),
                        node_type: "unknown".to_string(),
                        input_args: serde_json::json!({ "raw": tc.function.arguments }),
                        merged_config: serde_json::json!({}),
                        success: false,
                        output_data: None,
                        error_message: Some(err_msg.clone()),
                        raw_response: format!("{{\"error\": \"{err_msg}\"}}"),
                        duration_ms: 0,
                    });
                }
                Some(tool) => {
                    let parse_args: Result<serde_json::Value, _> =
                        serde_json::from_str(&tc.function.arguments);

                    match parse_args {
                        Err(json_err) => {
                            let err_msg = format!(
                                "Failed to parse tool arguments JSON ({json_err}): {}",
                                tc.function.arguments
                            );
                            current_round_has_error = true;
                            self_corrections_count += 1;

                            messages.push(ChatMessage::tool_result(
                                &tc.id,
                                format!("Error: {err_msg}"),
                            ));

                            step_tool_calls.push(TimelineToolCall {
                                call_id: tc.id.clone(),
                                tool_id: tool.id.clone(),
                                tool_name: tool.name.clone(),
                                node_type: tool.target_node_type.clone(),
                                input_args: serde_json::json!({ "raw": tc.function.arguments }),
                                merged_config: serde_json::json!({}),
                                success: false,
                                output_data: None,
                                error_message: Some(err_msg.clone()),
                                raw_response: format!("{{\"error\": \"{err_msg}\"}}"),
                                duration_ms: 0,
                            });
                        }
                        Ok(dynamic_args) => {
                            // Sensitive tool confirmation check
                            if tool.require_confirmation {
                                let interaction_id = next_interaction_id("confirm", &exec_id);
                                let (tx, rx) = tokio::sync::oneshot::channel();
                                register_interaction(&interaction_id, tx);

                                let now_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .unwrap_or_default()
                                    .as_millis()
                                    as u64;
                                let pending = PendingInteraction {
                                    interaction_id: interaction_id.clone(),
                                    execution_id: exec_id.clone(),
                                    interaction_type: "confirmation".to_string(),
                                    prompt: format!(
                                        "Tool '{}' requires human confirmation before execution",
                                        tool.name
                                    ),
                                    tool_id: Some(tool.id.clone()),
                                    tool_name: Some(tool.name.clone()),
                                    input_args: Some(dynamic_args.clone()),
                                    step_index: Some(round),
                                    created_at_ms: now_ms,
                                };

                                ctx.log(
                                    "info",
                                    format!(
                                        "Waiting for human confirmation to execute tool '{}'",
                                        tool.name
                                    ),
                                );
                                ctx.emit(
                                    "stream",
                                    serde_json::json!({
                                        "type": "waiting_human",
                                        "interaction": &pending,
                                        "step_index": round,
                                    }),
                                )
                                .await;

                                let pause_start = Instant::now();
                                let human_resp = if is_non_interactive {
                                    ctx.log(
                                        "warn",
                                        format!(
                                            "Non-interactive environment: tool '{}' requires confirmation and was auto-rejected",
                                            tool.name
                                        ),
                                    );
                                    HumanResponse {
                                        approved: Some(false),
                                        reason: Some("Non-interactive execution environment (auto-rejected for safety)".to_string()),
                                        ..Default::default()
                                    }
                                } else {
                                    match tokio::time::timeout(interaction_timeout, rx).await {
                                        Ok(Ok(resp)) => resp,
                                        Ok(Err(_)) => HumanResponse {
                                            approved: Some(false),
                                            reason: Some("Approval channel closed".to_string()),
                                            ..Default::default()
                                        },
                                        Err(_) => {
                                            crate::types::cancel_interaction(&interaction_id);
                                            ctx.log(
                                                "warn",
                                                format!(
                                                    "Timed out after {}s waiting for human confirmation for tool '{}' (auto-rejected for safety)",
                                                    interaction_timeout.as_secs(),
                                                    tool.name
                                                ),
                                            );
                                            ctx.emit(
                                                "stream",
                                                serde_json::json!({
                                                    "type": "human_timeout",
                                                    "interaction_id": &interaction_id,
                                                    "step_index": round,
                                                }),
                                            )
                                            .await;
                                            HumanResponse {
                                                approved: Some(false),
                                                reason: Some("Timed out waiting for human confirmation (auto-rejected for safety)".to_string()),
                                                ..Default::default()
                                            }
                                        }
                                    }
                                };
                                let pause_dur = pause_start.elapsed();
                                paused_total_duration += pause_dur;

                                ctx.emit(
                                    "stream",
                                    serde_json::json!({
                                        "type": "human_resumed",
                                        "interaction_id": &interaction_id,
                                        "prompt": &pending.prompt,
                                        "tool_name": &tool.name,
                                        "response": &human_resp,
                                        "approved": human_resp.approved,
                                        "step_index": round,
                                    })
                                )
                                .await;

                                if human_resp.approved != Some(true) {
                                    let reject_reason = human_resp.reason.unwrap_or_else(|| {
                                        "Human rejected tool execution".to_string()
                                    });
                                    current_round_has_error = true;
                                    self_corrections_count += 1;

                                    messages.push(ChatMessage::tool_result(
                                        &tc.id,
                                        format!(
                                            "Error: Human rejected tool execution: {reject_reason}"
                                        ),
                                    ));

                                    step_tool_calls.push(TimelineToolCall {
                                        call_id: tc.id.clone(),
                                        tool_id: tool.id.clone(),
                                        tool_name: tool.name.clone(),
                                        node_type: tool.target_node_type.clone(),
                                        input_args: dynamic_args,
                                        merged_config: serde_json::json!({}),
                                        success: false,
                                        output_data: None,
                                        error_message: Some(reject_reason.clone()),
                                        raw_response: format!("{{\"error\": \"{reject_reason}\"}}"),
                                        duration_ms: pause_dur.as_millis() as u64,
                                    });
                                    continue;
                                }
                            }

                            // Merge parameters
                            match merge_tool_config(
                                &tool.fixed_config,
                                &dynamic_args,
                                &tool.dynamic_schema,
                            ) {
                                Err(merge_err) => {
                                    let err_msg =
                                        format!("Parameter validation error: {merge_err}");
                                    current_round_has_error = true;
                                    self_corrections_count += 1;

                                    messages.push(ChatMessage::tool_result(
                                        &tc.id,
                                        format!("Error: {err_msg}"),
                                    ));

                                    step_tool_calls.push(TimelineToolCall {
                                        call_id: tc.id.clone(),
                                        tool_id: tool.id.clone(),
                                        tool_name: tool.name.clone(),
                                        node_type: tool.target_node_type.clone(),
                                        input_args: dynamic_args,
                                        merged_config: serde_json::json!({}),
                                        success: false,
                                        output_data: None,
                                        error_message: Some(err_msg.clone()),
                                        raw_response: format!("{{\"error\": \"{err_msg}\"}}"),
                                        duration_ms: 0,
                                    });
                                }
                                Ok(merged_cfg) => {
                                    // Audit safety guardrails
                                    if let Err(safety_err) = audit_tool_call_safety(
                                        &tool.target_node_type,
                                        &merged_cfg,
                                        config.read_only_mode,
                                    ) {
                                        current_round_has_error = true;
                                        self_corrections_count += 1;

                                        messages.push(ChatMessage::tool_result(
                                            &tc.id,
                                            format!("Security Error: {safety_err}"),
                                        ));

                                        step_tool_calls.push(TimelineToolCall {
                                            call_id: tc.id.clone(),
                                            tool_id: tool.id.clone(),
                                            tool_name: tool.name.clone(),
                                            node_type: tool.target_node_type.clone(),
                                            input_args: dynamic_args,
                                            merged_config: merged_cfg,
                                            success: false,
                                            output_data: None,
                                            error_message: Some(safety_err.clone()),
                                            raw_response: format!(
                                                "{{\"security_error\": \"{safety_err}\"}}"
                                            ),
                                            duration_ms: 0,
                                        });
                                    } else {
                                        // Emit tool_start event to host/UI
                                        ctx.emit(
                                            "stream",
                                            serde_json::json!({
                                                "type": "tool_start",
                                                "step_index": round,
                                                "tool_id": &tool.id,
                                                "tool_name": &tool.name,
                                                "input_args": &dynamic_args,
                                            }),
                                        )
                                        .await;

                                        // Execute tool
                                        let (t_ok, t_out, t_err, t_raw, t_dur) =
                                            execute_tool_dispatch(
                                                tool,
                                                &merged_cfg,
                                                ctx,
                                                &provider,
                                                pool,
                                                &exec_id,
                                                &bridge_url,
                                                &bridge_token,
                                            )
                                            .await;

                                        // Emit tool_end event to host/UI
                                        ctx.emit(
                                            "stream",
                                            serde_json::json!({
                                                "type": "tool_end",
                                                "step_index": round,
                                                "tool_id": &tool.id,
                                                "tool_name": &tool.name,
                                                "success": t_ok,
                                                "output": &t_out,
                                                "error": &t_err,
                                                "duration_ms": t_dur,
                                            }),
                                        )
                                        .await;

                                        if !t_ok {
                                            current_round_has_error = true;
                                            self_corrections_count += 1;
                                            let err_str = t_err.unwrap_or_else(|| {
                                                "Tool execution failed".to_string()
                                            });
                                            let truncated_err = truncate_error_message(&err_str, 1000);
                                            messages.push(ChatMessage::tool_result(
                                                &tc.id,
                                                format!("Tool Execution Error: {truncated_err}"),
                                            ));

                                            step_tool_calls.push(TimelineToolCall {
                                                call_id: tc.id.clone(),
                                                tool_id: tool.id.clone(),
                                                tool_name: tool.name.clone(),
                                                node_type: tool.target_node_type.clone(),
                                                input_args: dynamic_args,
                                                merged_config: merged_cfg,
                                                success: false,
                                                output_data: None,
                                                error_message: Some(err_str),
                                                raw_response: t_raw,
                                                duration_ms: t_dur,
                                            });
                                        } else {
                                            let out_val = t_out.unwrap_or_else(
                                                || serde_json::json!({ "status": "ok" }),
                                            );
                                            let truncated_output = truncate_tool_output(&out_val, 4000);
                                            messages.push(ChatMessage::tool_result(
                                                &tc.id,
                                                truncated_output,
                                            ));

                                            step_tool_calls.push(TimelineToolCall {
                                                call_id: tc.id.clone(),
                                                tool_id: tool.id.clone(),
                                                tool_name: tool.name.clone(),
                                                node_type: tool.target_node_type.clone(),
                                                input_args: dynamic_args,
                                                merged_config: merged_cfg,
                                                success: true,
                                                output_data: Some(out_val),
                                                error_message: None,
                                                raw_response: t_raw,
                                                duration_ms: t_dur,
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        previous_round_had_error = current_round_has_error;

        let current_step = TimelineStep {
            step_index: round,
            step_type: if round_human_interaction.is_some() {
                "ask_human".to_string()
            } else if is_self_correction_round {
                "self_correction".to_string()
            } else {
                "tool_call".to_string()
            },
            thought: llm_res.reasoning_content,
            tool_calls: step_tool_calls,
            duration_ms: llm_res.duration_ms,
            self_correction: is_self_correction_round,
            tokens: llm_res.token_usage,
            human_interaction: round_human_interaction,
            human_response: round_human_response,
        };

        ctx.emit(
            "stream",
            serde_json::json!({
                "type": "step_completed",
                "step": &current_step,
                "step_index": round,
            }),
        )
        .await;

        timeline.push(current_step);

        // 3. Step-by-step debug mode pause check
        if step_by_step_active {
            let interaction_id = next_interaction_id("step", &exec_id);
            let (tx, rx) = tokio::sync::oneshot::channel();
            register_interaction(&interaction_id, tx);

            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let pending = PendingInteraction {
                interaction_id: interaction_id.clone(),
                execution_id: exec_id.clone(),
                interaction_type: "step_pause".to_string(),
                prompt: format!("Step {round} completed. Paused for step-by-step debug."),
                tool_id: None,
                tool_name: None,
                input_args: None,
                step_index: Some(round),
                created_at_ms: now_ms,
            };

            ctx.log(
                "info",
                format!("Agent paused after step {round} for debug stepping"),
            );
            ctx.emit(
                "stream",
                serde_json::json!({
                    "type": "waiting_human",
                    "interaction": &pending,
                    "step_index": round,
                }),
            )
            .await;

            let pause_start = Instant::now();
            let human_resp = if is_non_interactive {
                ctx.log(
                    "info",
                    "Non-interactive environment: step pause auto-continued",
                );
                HumanResponse {
                    action: Some("continue".to_string()),
                    ..Default::default()
                }
            } else {
                match tokio::time::timeout(interaction_timeout, rx).await {
                    Ok(Ok(resp)) => resp,
                    Ok(Err(_)) => HumanResponse {
                        action: Some("continue".to_string()),
                        ..Default::default()
                    },
                    Err(_) => {
                        crate::types::cancel_interaction(&interaction_id);
                        ctx.log(
                            "warn",
                            format!(
                                "Timed out after {}s waiting for step debug confirmation, auto-continuing",
                                interaction_timeout.as_secs()
                            ),
                        );
                        ctx.emit(
                            "stream",
                            serde_json::json!({
                                "type": "human_timeout",
                                "interaction_id": &interaction_id,
                                "step_index": round,
                            }),
                        )
                        .await;
                        HumanResponse {
                            action: Some("continue".to_string()),
                            ..Default::default()
                        }
                    }
                }
            };
            let pause_dur = pause_start.elapsed();
            paused_total_duration += pause_dur;

            ctx.emit(
                "stream",
                serde_json::json!({
                    "type": "human_resumed",
                    "interaction_id": &interaction_id,
                    "prompt": &pending.prompt,
                    "response": &human_resp,
                    "action": &human_resp.action,
                    "step_index": round,
                })
            )
            .await;

            if human_resp.action.as_deref() == Some("run_to_end") {
                step_by_step_active = false;
            } else if human_resp.action.as_deref() == Some("cancel") {
                ctx.log("info", "Agent step-by-step debug cancelled by user");
                break;
            }
        }
    }

    clear_execution_interactions(&exec_id);
    let total_duration_ms = overall_start
        .elapsed()
        .saturating_sub(paused_total_duration)
        .as_millis() as u64;

    let output = AgentReactOutput {
        success: converged,
        final_answer: if converged {
            final_answer
        } else if let Some(errs) = &final_structured_errors {
            format!("Structured output validation failed: {}", errs.join("; "))
        } else {
            "Reached maximum iterations without convergence".to_string()
        },
        iterations: timeline.len() as u32,
        tool_call_count: total_tool_calls_count,
        self_corrections_count,
        token_usage: total_token_usage,
        total_duration_ms,
        timeline,
        structured_output: final_structured_output.clone(),
        structured_output_errors: final_structured_errors.clone(),
    };

    let mut output_val = match serde_json::to_value(&output) {
        Ok(v) => v,
        Err(e) => return ExecuteResult::fail(format!("Failed to serialize agent output: {e}")),
    };

    if converged {
        if let Some(parsed) = &final_structured_output {
            if let Some(obj) = output_val.as_object_mut() {
                obj.insert("data".to_string(), parsed.clone());
            }
        }
        ExecuteResult {
            success: true,
            next_ports: vec!["true".to_string()],
            output_data: Some(output_val.clone()),
            errors: Vec::new(),
            report_data: Some(output_val),
        }
    } else {
        let err_list = if let Some(errs) = final_structured_errors {
            errs
        } else {
            vec!["Reached maximum iterations without convergence".to_string()]
        };
        ExecuteResult {
            success: false,
            next_ports: vec!["false".to_string()],
            output_data: Some(output_val.clone()),
            errors: err_list,
            report_data: Some(output_val),
        }
    }
}
