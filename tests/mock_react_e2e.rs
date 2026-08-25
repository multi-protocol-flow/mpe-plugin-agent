#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Mock HTTP end-to-end integration tests for Agent plugin over JSON-RPC 2.0 stdio transport.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const PLUGIN_BIN: &str = env!("CARGO_BIN_EXE_mpe_plugin_agent");

struct PluginProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl PluginProcess {
    fn spawn() -> PluginProcess {
        let mut child = Command::new(PLUGIN_BIN)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn mpe_plugin_agent");
        let stdin = child.stdin.take().expect("plugin stdin unavailable");
        let stdout = child.stdout.take().expect("plugin stdout unavailable");
        PluginProcess {
            child,
            stdin: Some(stdin),
            stdout: BufReader::new(stdout),
            next_id: 0,
        }
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        let frame = serde_json::to_string(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .expect("request serializable");
        let stdin = self.stdin.as_mut().expect("stdin alive");
        writeln!(stdin, "{frame}").expect("request write");
        stdin.flush().expect("request flush");

        let mut line = String::new();
        loop {
            line.clear();
            let n = self
                .stdout
                .read_line(&mut line)
                .expect("read response frame");
            assert!(n > 0, "plugin stdout closed early");
            let frame: Value = serde_json::from_str(&line).expect("frame is valid JSON");
            if frame.get("id").is_some() {
                return frame;
            }
        }
    }

    fn shutdown(mut self) {
        drop(self.stdin.take());
        let status = self.child.wait().expect("plugin exit");
        assert!(status.success(), "plugin should exit cleanly");
    }
}

#[tokio::test]
async fn test_describe_agent_node() {
    let mut p = PluginProcess::spawn();
    let resp = p.request("describe", json!({}));
    let result = resp.get("result").expect("result present");
    let nodes = result.as_array().expect("array of nodes");

    assert_eq!(nodes.len(), 1);
    let agent_node = &nodes[0];
    assert_eq!(agent_node["type_id"], "agent:react");
    assert_eq!(agent_node["category"], "ai");
    assert_eq!(agent_node["icon"], "puzzle");

    let ports = agent_node["ports"].as_array().expect("ports array");
    let port_ids: Vec<&str> = ports
        .iter()
        .map(|p| p["id"].as_str().unwrap_or(""))
        .collect();
    assert_eq!(port_ids, vec!["in", "true", "false"]);
    // Verify frontend and viewer inline HTML are non-empty
    let frontend = agent_node.get("frontend").and_then(|f| f.get("content")).and_then(|c| c.as_str());
    assert!(frontend.is_some() && frontend.unwrap().contains("Agent Config Panel"));

    let viewer = agent_node.get("viewer").and_then(|v| v.get("content")).and_then(|c| c.as_str());
    assert!(viewer.is_some() && viewer.unwrap().contains("Agent Execution Viewer"));

    p.shutdown();
}

#[tokio::test]
async fn test_react_direct_final_answer() {
    let server = MockServer::start().await;

    let sse_body = "\
data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"The answer is obvious without any tools.\"}}]}\n\n\
data: {\"choices\":[{\"delta\":{\"content\":\"42 is the answer to life.\"}}],\"usage\":{\"prompt_tokens\":20,\"completion_tokens\":10,\"total_tokens\":30}}\n\n\
data: [DONE]\n\n";

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body),
        )
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();
    let resp = p.request(
        "execute",
        json!({
            "config": {
                "type": "agent:react",
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "test-key",
                    "model": "gpt-4o",
                },
                "system_prompt": "You are a helpful assistant.",
                "user_prompt": "What is the answer?",
                "tools": [],
                "max_iterations": 5
            }
        }),
    );

    let result = resp.get("result").expect("result present");
    assert_eq!(result.get("success").and_then(|s| s.as_bool()), Some(true));
    assert_eq!(
        result.get("next_ports"),
        Some(&json!(["true"]))
    );

    let output = result.get("output_data").expect("output_data present");
    assert_eq!(
        output.get("final_answer").and_then(|s| s.as_str()),
        Some("42 is the answer to life.")
    );
    assert_eq!(output.get("iterations").and_then(|i| i.as_u64()), Some(1));
    assert_eq!(output.get("tool_call_count").and_then(|t| t.as_u64()), Some(0));

    let timeline = output.get("timeline").and_then(|t| t.as_array()).expect("timeline");
    assert_eq!(timeline.len(), 1);
    assert_eq!(timeline[0]["step_type"], "final_answer");
    assert_eq!(
        timeline[0]["thought"],
        "The answer is obvious without any tools."
    );

    p.shutdown();
}

#[tokio::test]
async fn test_react_self_correction_loop() {
    let server = MockServer::start().await;

    // Round 1: Model calls db:query with wrong_table
    let r1_sse = "\
data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Querying wrong_table first.\",\"tool_calls\":[{\"index\":0,\"id\":\"call_001\",\"type\":\"function\",\"function\":{\"name\":\"query_db\",\"arguments\":\"{\\\"sql\\\": \\\"SELECT * FROM wrong_table;\\\"}\"}}]}}]}\n\n\
data: [DONE]\n\n";

    // Round 2: Model receives error, reasons and self-corrects with correct table
    let r2_sse = "\
data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Table failed, let me self-correct and query correct table.\",\"tool_calls\":[{\"index\":0,\"id\":\"call_002\",\"type\":\"function\",\"function\":{\"name\":\"query_db\",\"arguments\":\"{\\\"sql\\\": \\\"SELECT * FROM users;\\\"}\"}}]}}]}\n\n\
data: [DONE]\n\n";

    // Round 3: Model receives success and produces final answer
    let r3_sse = "\
data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Data retrieved successfully.\",\"content\":\"User table query complete. Found active records.\"}}]}\n\n\
data: [DONE]\n\n";

    // Mount sequential mock responses
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(r1_sse))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(r2_sse))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(r3_sse))
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();
    let resp = p.request(
        "execute",
        json!({
            "config": {
                "type": "agent:react",
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "test-key",
                    "model": "gpt-4o",
                },
                "system_prompt": "You are a ReAct agent.",
                "user_prompt": "Check users",
                "tools": [
                    {
                        "id": "query_db",
                        "name": "query_db",
                        "description": "Execute database query",
                        "tool_type": "standalone_action",
                        "target_node_type": "db:query",
                        "fixed_config": { "connection_uuid": "conn-1" },
                        "dynamic_schema": {
                            "type": "object",
                            "properties": {
                                "sql": { "type": "string" }
                            },
                            "required": ["sql"]
                        }
                    }
                ],
                "max_iterations": 5
            }
        }),
    );

    let result = resp.get("result").expect("result present");
    assert_eq!(result.get("success").and_then(|s| s.as_bool()), Some(true));

    let output = result.get("output_data").expect("output_data present");
    assert_eq!(output.get("iterations").and_then(|i| i.as_u64()), Some(3));
    assert_eq!(output.get("tool_call_count").and_then(|t| t.as_u64()), Some(2));
    assert_eq!(output.get("self_corrections_count").and_then(|s| s.as_u64()), Some(1));

    let timeline = output.get("timeline").and_then(|t| t.as_array()).expect("timeline");
    assert_eq!(timeline.len(), 3);

    // Round 1: tool call failed with wrong table
    assert_eq!(timeline[0]["step_type"], "tool_call");
    assert_eq!(timeline[0]["self_correction"], false);
    assert_eq!(timeline[0]["tool_calls"][0]["success"], false);

    // Round 2: self-correction step
    assert_eq!(timeline[1]["step_type"], "self_correction");
    assert_eq!(timeline[1]["self_correction"], true);
    assert_eq!(timeline[1]["tool_calls"][0]["success"], true);

    // Round 3: final answer step
    assert_eq!(timeline[2]["step_type"], "final_answer");
    assert!(output["final_answer"].as_str().unwrap().contains("User table query complete"));

    p.shutdown();
}

#[tokio::test]
async fn test_react_read_only_guardrail_block() {
    let server = MockServer::start().await;

    // Round 1: Model tries to issue DELETE statement
    let r1_sse = "\
data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Attempting to delete old orders.\",\"tool_calls\":[{\"index\":0,\"id\":\"call_del\",\"type\":\"function\",\"function\":{\"name\":\"query_db\",\"arguments\":\"{\\\"sql\\\": \\\"DELETE FROM orders WHERE id = 1;\\\"}\"}}]}}]}\n\n\
data: [DONE]\n\n";

    // Round 2: Model self-corrects after seeing security violation
    let r2_sse = "\
data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Delete was blocked by security policy, explaining to user.\",\"content\":\"Cannot delete records in read-only mode.\"}}]}\n\n\
data: [DONE]\n\n";

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(r1_sse))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).insert_header("content-type", "text/event-stream").set_body_string(r2_sse))
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();
    let resp = p.request(
        "execute",
        json!({
            "config": {
                "type": "agent:react",
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "test-key",
                    "model": "gpt-4o",
                },
                "system_prompt": "You are a ReAct agent.",
                "user_prompt": "Clean up orders",
                "read_only_mode": true,
                "tools": [
                    {
                        "id": "query_db",
                        "name": "query_db",
                        "description": "Execute database query",
                        "tool_type": "standalone_action",
                        "target_node_type": "db:query",
                        "fixed_config": {},
                        "dynamic_schema": {
                            "type": "object",
                            "properties": {
                                "sql": { "type": "string" }
                            }
                        }
                    }
                ],
                "max_iterations": 5
            }
        }),
    );

    let result = resp.get("result").expect("result present");
    assert_eq!(result.get("success").and_then(|s| s.as_bool()), Some(true));

    let output = result.get("output_data").expect("output_data present");
    assert_eq!(output.get("self_corrections_count").and_then(|s| s.as_u64()), Some(1));

    let timeline = output.get("timeline").and_then(|t| t.as_array()).expect("timeline");
    assert_eq!(timeline[0]["tool_calls"][0]["success"], false);
    assert!(timeline[0]["tool_calls"][0]["error_message"].as_str().unwrap().contains("Read-only guardrail blocked"));

    p.shutdown();
}

#[tokio::test]
async fn test_ui_calls() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/models"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(json!({
                "data": [
                    { "id": "gpt-4o" },
                    { "id": "deepseek-chat" }
                ]
            })),
        )
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();

    // 1. test_connection
    let resp1 = p.request(
        "uiCall",
        json!({
            "method": "test_connection",
            "params": {
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "k",
                    "model": "gpt-4o"
                }
            }
        }),
    );
    let res1 = resp1.get("result").expect("result");
    assert_eq!(res1["success"], true);
    assert_eq!(res1["models_count"], 2);

    // 2. list_models
    let resp2 = p.request(
        "uiCall",
        json!({
            "method": "list_models",
            "params": {
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "k",
                    "model": "gpt-4o"
                }
            }
        }),
    );
    let res2 = resp2.get("result").expect("result");
    assert_eq!(res2["models"], json!(["deepseek-chat", "gpt-4o"]));

    // 3. test_tool_safety
    let resp3 = p.request(
        "uiCall",
        json!({
            "method": "test_tool_safety",
            "params": {
                "node_type": "db:query",
                "config": { "sql": "DELETE FROM t;" },
                "read_only_mode": true
            }
        }),
    );
    let res3 = resp3.get("result").expect("result");
    assert_eq!(res3["allowed"], false);

    p.shutdown();
}

#[tokio::test]
async fn test_react_with_provider_uuid_and_override_model() {
    let server = MockServer::start().await;

    // Mock chat completion response using the overridden model
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-test",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Result from linked provider"
                },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15 }
        })))
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();

    // Execute request with provider in context providers map
    let resp = p.request(
        "execute",
        json!({
            "execution_id": "exec-provider-test",
            "config": {
                "type": "agent:react",
                "provider_uuid": "prov-node-99",
                "override_model": "deepseek-custom",
                "user_prompt": "What is the answer?",
                "stream": false
            },
            "providers": {
                "prov-node-99": {
                    "base_url": server.uri(),
                    "api_key": "test-key-99",
                    "model": "gpt-4o-default"
                }
            }
        }),
    );

    let result = resp.get("result").expect("result present");
    assert_eq!(result["success"], true);
    let output = result.get("output_data").expect("output_data");
    assert_eq!(output["final_answer"], "Result from linked provider");

    p.shutdown();
}

#[tokio::test]
async fn test_react_calling_llm_chat_tool() {
    let server = MockServer::start().await;

    // Round 1: Agent decides to call the `llm_chat_tool`
    // Tool call execution: Tool makes real chat completion
    // Round 2: Agent observes tool result and produces final answer
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-tool-test",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "I will check the LLM chat tool now.",
                    "tool_calls": [{
                        "id": "call_llm_1",
                        "type": "function",
                        "function": {
                            "name": "llm_chat_tool",
                            "arguments": "{\"message\": \"Hello LLM node\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 20, "completion_tokens": 15, "total_tokens": 35 }
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    // Tool execution (invoked by agent as llm:chat)
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-sub-llm",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "LLM Chat 3 node is active and working."
                },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 8, "completion_tokens": 10, "total_tokens": 18 }
        })))
        .up_to_n_times(1)
        .mount(&server)
        .await;

    // Round 2: Final answer
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "id": "chatcmpl-final",
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "The llm:chat node is completely executable and returned: LLM Chat 3 node is active and working."
                },
                "finish_reason": "stop"
            }],
            "usage": { "prompt_tokens": 35, "completion_tokens": 25, "total_tokens": 60 }
        })))
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();

    let resp = p.request(
        "execute",
        json!({
            "execution_id": "exec-tool-llm-chat",
            "config": {
                "type": "agent:react",
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "test-k",
                    "model": "gpt-4o"
                },
                "user_prompt": "Please check if the llm:chat node is executable.",
                "stream": false,
                "tools": [{
                    "id": "llm_chat_tool",
                    "name": "llm_chat_tool",
                    "description": "Call canvas node 'LLM Chat 3' (llm:chat)",
                    "tool_type": "linked_node",
                    "target_node_type": "llm:chat",
                    "fixed_config": {
                        "provider": {
                            "base_url": server.uri(),
                            "api_key": "test-k",
                            "model": "gpt-4o"
                        }
                    },
                    "dynamic_schema": {
                        "type": "object",
                        "properties": {
                            "message": { "type": "string" }
                        }
                    }
                }]
            }
        }),
    );

    let result = resp.get("result").expect("result present");
    assert_eq!(result["success"], true);
    let output = result.get("output_data").expect("output_data");
    assert!(output["final_answer"].as_str().unwrap().contains("LLM Chat 3 node is active"));

    p.shutdown();
}
