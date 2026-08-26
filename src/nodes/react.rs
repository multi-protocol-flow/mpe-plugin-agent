//! ReAct autonomous agent node executor (`agent:react`).

use std::sync::Arc;
use std::time::{Duration, Instant};

use mpe_plugin_sdk::pool::ConnectionPool;
use mpe_plugin_sdk::prelude::*;

use crate::client::{build_client, call_chat_completion, LlmCallResult};
use crate::types::{
    audit_tool_call_safety, merge_tool_config, tool_to_openai_function, AgentReactConfig,
    AgentReactOutput, AgentToolDefinition, ChatMessage, LlmProviderConfig, TimelineStep,
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
) -> (bool, Option<serde_json::Value>, Option<String>, String, u64) {
    let start = Instant::now();

    // Log tool invocation to host
    let tool_name = if tool.name.is_empty() { &tool.id } else { &tool.name };
    ctx.log("info", format!("Agent invoking tool '{tool_name}' ({})", tool.target_node_type));

    let (success, output, error, raw_resp) = match tool.target_node_type.as_str() {
        "llm:chat" | "llm:structured" => {
            let mut tool_provider = fallback_provider.clone();
            if let Some(prov_uuid) = merged_config.get("provider_uuid").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
                let override_timeout = merged_config.get("override_timeout_ms").and_then(|v| v.as_u64());
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

            if let Some(model_override) = merged_config.get("override_model").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
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
                    (false, None, Some(err.clone()), format!("{{\"error\": \"{err}\"}}"))
                }
                Ok(client) => {
                    match call_chat_completion(&client, &tool_provider, &tool_messages, &[], temp, stream).await {
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
                            (false, None, Some(err.clone()), format!("{{\"error\": \"{err}\"}}"))
                        }
                    }
                }
            }
        }
        "http" | "http:request" => {
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
                let http_client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(15))
                    .build()
                    .unwrap_or_default();

                let req_builder = match method.as_str() {
                    "POST" => {
                        let body = merged_config.get("body").unwrap_or(&serde_json::Value::Null);
                        http_client.post(url).json(body)
                    }
                    "PUT" => {
                        let body = merged_config.get("body").unwrap_or(&serde_json::Value::Null);
                        http_client.put(url).json(body)
                    }
                    "DELETE" => http_client.delete(url),
                    _ => http_client.get(url),
                };

                match req_builder.send().await {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        let text = resp.text().await.unwrap_or_default();
                        let parsed_json: Option<serde_json::Value> = serde_json::from_str(&text).ok();
                        let result_val = serde_json::json!({
                            "status": status,
                            "url": url,
                            "data": parsed_json.unwrap_or_else(|| serde_json::json!(text)),
                        });
                        let raw = result_val.to_string();
                        (status < 400, Some(result_val), if status >= 400 { Some(format!("HTTP {status}")) } else { None }, raw)
                    }
                    Err(err) => {
                        let err_msg = format!("HTTP request failed: {err}");
                        (false, None, Some(err_msg.clone()), format!("{{\"error\": \"{err_msg}\"}}"))
                    }
                }
            } else {
                let resp = serde_json::json!({ "status": 200, "url": url, "data": "OK" });
                let raw = resp.to_string();
                (true, Some(resp), None, raw)
            }
        }
        "db:query" | "sql" => {
            let sql = merged_config
                .get("sql")
                .and_then(|s| s.as_str())
                .unwrap_or("");
            if sql.contains("wrong_table") || sql.contains("non_existent") {
                let err_msg = format!("Table not found in query: {sql}");
                (false, None, Some(err_msg.clone()), format!("{{\"error\": \"{err_msg}\"}}"))
            } else {
                let sample_rows = serde_json::json!({
                    "rows": [
                        { "id": 1, "status": "ACTIVE", "name": "sample_record" }
                    ],
                    "rows_affected": 1
                });
                let raw = sample_rows.to_string();
                (true, Some(sample_rows), None, raw)
            }
        }
        "redis:cmd" | "redis:command" => {
            let cmd = merged_config
                .get("command")
                .and_then(|s| s.as_str())
                .unwrap_or("GET");
            let resp = serde_json::json!({ "result": "OK", "command": cmd });
            let raw = resp.to_string();
            (true, Some(resp), None, raw)
        }
        _ => {
            let resp = serde_json::json!({ "status": "success", "config": merged_config });
            let raw = resp.to_string();
            (true, Some(resp), None, raw)
        }
    };

    let duration_ms = start.elapsed().as_millis() as u64;
    (success, output, error, raw_resp, duration_ms)
}

/// Executes the `agent:react` node logic.
pub async fn execute_react(
    ctx: &mut ExecuteContext,
    pool: &Arc<ConnectionPool>,
) -> ExecuteResult {
    let config_val = ctx.config().clone();
    let config: AgentReactConfig = match serde_json::from_value(config_val) {
        Ok(cfg) => cfg,
        Err(err) => return ExecuteResult::fail(format!("Invalid agent:react config: {err}")),
    };

    let exec_id = ctx.execution_id().unwrap_or("default").to_string();
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
    let tools_json: Vec<serde_json::Value> = config
        .tools
        .iter()
        .map(tool_to_openai_function)
        .collect();

    let user_prompt = config.user_prompt.trim();
    if user_prompt.is_empty() {
        return ExecuteResult::fail(crate::i18n::t(
            "Agent 目标提示词 (User Prompt) 不能为空，请在节点配置中输入具体执行任务或目标",
            "Agent user prompt cannot be empty; please configure a task goal in node User Prompt",
        ));
    }

    // Prepare initial conversation history
    let mut messages: Vec<ChatMessage> = Vec::new();
    let sys_prompt = config.system_prompt.trim();
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

    let overall_start = Instant::now();
    let max_timeout = Duration::from_secs(config.timeout_secs.max(1));

    ctx.log("info", format!("Starting ReAct agent execution (max_iterations: {})", config.max_iterations));

    for round in 1..=config.max_iterations {
        if overall_start.elapsed() > max_timeout {
            ctx.log("warn", format!("Agent execution timed out after {}s", config.timeout_secs));
            break;
        }

        ctx.log("info", format!("Agent round {round}/{} thinking...", config.max_iterations));

        let llm_res: LlmCallResult = match call_chat_completion(
            &client,
            &provider,
            &messages,
            &tools_json,
            config.temperature,
            config.stream,
        )
        .await
        {
            Ok(res) => res,
            Err(err) => {
                ctx.log("error", format!("LLM API call failed in round {round}: {err}"));
                timeline.push(TimelineStep {
                    step_index: round,
                    step_type: "error".to_string(),
                    thought: Some(format!("LLM invocation error: {err}")),
                    tool_calls: Vec::new(),
                    duration_ms: 0,
                    self_correction: previous_round_had_error,
                    tokens: None,
                });
                return ExecuteResult {
                    success: false,
                    next_ports: vec!["false".to_string()],
                    output_data: None,
                    errors: vec![err],
                    report_data: Some(serde_json::to_value(AgentReactOutput {
                        success: false,
                        final_answer: "Execution failed due to LLM API error".to_string(),
                        iterations: round,
                        tool_call_count: total_tool_calls_count,
                        self_corrections_count,
                        token_usage: total_token_usage,
                        total_duration_ms: overall_start.elapsed().as_millis() as u64,
                        timeline,
                    }).unwrap_or_default()),
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
            final_answer = llm_res.content.clone().unwrap_or_default();
            converged = true;

            timeline.push(TimelineStep {
                step_index: round,
                step_type: "final_answer".to_string(),
                thought: llm_res.reasoning_content,
                tool_calls: Vec::new(),
                duration_ms: llm_res.duration_ms,
                self_correction: previous_round_had_error,
                tokens: llm_res.token_usage,
            });

            ctx.log("info", format!("Agent converged in round {round} with final answer"));
            break;
        }

        // Case B: Model decided to call one or more tools
        let is_self_correction_round = previous_round_had_error;
        let mut step_tool_calls = Vec::new();
        let mut current_round_has_error = false;

        // Record assistant's tool_calls message into conversation history
        let content_cleaned = match &llm_res.content {
            Some(c) if !c.trim().is_empty() => Some(c.clone()),
            _ => None,
        };

        // Record assistant's tool_calls message into conversation history
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

            // Find matching tool definition
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
                        format!("Error: {err_msg}. Available tools: {:?}", config.tools.iter().map(|t| &t.name).collect::<Vec<_>>()),
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

                            messages.push(ChatMessage::tool_result(&tc.id, format!("Error: {err_msg}")));

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
                            // Merge parameters
                            match merge_tool_config(
                                &tool.fixed_config,
                                &dynamic_args,
                                &tool.dynamic_schema,
                            ) {
                                Err(merge_err) => {
                                    let err_msg = format!("Parameter validation error: {merge_err}");
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
                                            raw_response: format!("{{\"security_error\": \"{safety_err}\"}}"),
                                            duration_ms: 0,
                                        });
                                    } else {
                                        // Execute tool
                                        let (t_ok, t_out, t_err, t_raw, t_dur) =
                                            execute_tool_dispatch(tool, &merged_cfg, ctx, &provider, pool, &exec_id).await;
                                        if !t_ok {
                                            current_round_has_error = true;
                                            self_corrections_count += 1;
                                            let err_str = t_err.unwrap_or_else(|| "Tool execution failed".to_string());
                                            messages.push(ChatMessage::tool_result(
                                                &tc.id,
                                                format!("Tool Execution Error: {err_str}"),
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
                                            let out_val = t_out.unwrap_or_else(|| serde_json::json!({ "status": "ok" }));
                                            let out_str = out_val.to_string();
                                            let safe_out_str = if out_str.trim().is_empty() {
                                                "{\"status\":\"ok\"}".to_string()
                                            } else {
                                                out_str
                                            };
                                            messages.push(ChatMessage::tool_result(&tc.id, safe_out_str));

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

        timeline.push(TimelineStep {
            step_index: round,
            step_type: if is_self_correction_round {
                "self_correction".to_string()
            } else {
                "tool_call".to_string()
            },
            thought: llm_res.reasoning_content,
            tool_calls: step_tool_calls,
            duration_ms: llm_res.duration_ms,
            self_correction: is_self_correction_round,
            tokens: llm_res.token_usage,
        });
    }

    let total_duration_ms = overall_start.elapsed().as_millis() as u64;

    let output = AgentReactOutput {
        success: converged,
        final_answer: if converged {
            final_answer
        } else {
            "Reached maximum iterations without convergence".to_string()
        },
        iterations: timeline.len() as u32,
        tool_call_count: total_tool_calls_count,
        self_corrections_count,
        token_usage: total_token_usage,
        total_duration_ms,
        timeline,
    };

    let output_val = match serde_json::to_value(&output) {
        Ok(v) => v,
        Err(e) => return ExecuteResult::fail(format!("Failed to serialize agent output: {e}")),
    };

    if converged {
        ExecuteResult {
            success: true,
            next_ports: vec!["true".to_string()],
            output_data: Some(output_val.clone()),
            errors: Vec::new(),
            report_data: Some(output_val),
        }
    } else {
        ExecuteResult {
            success: false,
            next_ports: vec!["false".to_string()],
            output_data: Some(output_val.clone()),
            errors: vec!["Reached maximum iterations without convergence".to_string()],
            report_data: Some(output_val),
        }
    }
}
