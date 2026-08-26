#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Mock HTTP end-to-end integration tests for Agent plugin HITL (Human-in-the-Loop),
//! streaming, ask_human, tool approval, and step-by-step debug capabilities.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
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

    fn send_request(&mut self, method: &str, params: Value) -> u64 {
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
        id
    }

    fn read_next_frame(&mut self) -> Value {
        let mut line = String::new();
        let n = self
            .stdout
            .read_line(&mut line)
            .expect("read frame from plugin");
        assert!(n > 0, "plugin stdout closed early");
        serde_json::from_str(&line).expect("frame is valid JSON")
    }

    fn shutdown(mut self) {
        drop(self.stdin.take());
        let status = self.child.wait().expect("plugin exit");
        assert!(status.success(), "plugin should exit cleanly");
    }
}

#[tokio::test]
async fn test_hitl_ask_human_flow() {
    let server = MockServer::start().await;

    // Round 1: Model calls ask_human
    let r1_sse = [
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"I need user email.\",\"tool_calls\":[{\"index\":0,\"id\":\"call_ask_1\",\"type\":\"function\",\"function\":{\"name\":\"ask_human\",\"arguments\":\"{\\\"question\\\":\\\"What is your email address?\\\"}\"}}]}}]}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n\n");

    // Round 2: Model returns final answer based on user answer
    let r2_sse = [
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Thank you! Your email is user@example.com.\"}}]}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n\n");

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(r1_sse),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(r2_sse),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();

    // Start execute
    let exec_id = "test_exec_hitl_ask";
    p.send_request(
        "execute",
        json!({
            "node_type": "agent:react",
            "execution_id": exec_id,
            "config": {
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "sk-test",
                    "model": "gpt-4o",
                    "timeout_ms": 5000
                },
                "user_prompt": "Send a notification to user.",
                "stream": true,
                "enable_ask_human": true
            }
        }),
    );

    // Read frames until we receive waiting_human stream notification
    let mut interaction_id = String::new();
    let mut execute_result: Option<Value> = None;

    for _ in 0..50 {
        let frame = p.read_next_frame();
        if let Some(method_name) = frame.get("method").and_then(|m| m.as_str()) {
            if method_name == "stream" {
                if let Some(params) = frame.get("params") {
                    if params.get("type").and_then(|t| t.as_str()) == Some("waiting_human") {
                        if let Some(interact) = params.get("interaction") {
                            if let Some(id) = interact.get("interaction_id").and_then(|i| i.as_str()) {
                                interaction_id = id.to_string();
                                break;
                            }
                        }
                    }
                }
            }
        } else if frame.get("id").is_some() {
            execute_result = Some(frame);
            break;
        }
    }

    assert!(!interaction_id.is_empty(), "Expected to receive waiting_human notification");

    // Submit human response via uiCall
    let ui_resp_id = p.send_request(
        "uiCall",
        json!({
            "method": "submit_human_response",
            "params": {
                "interaction_id": interaction_id,
                "response": {
                    "text": "user@example.com"
                }
            }
        }),
    );

    // Read until uiCall response
    while execute_result.is_none() {
        let frame = p.read_next_frame();
        if frame.get("id").and_then(|v| v.as_u64()) == Some(ui_resp_id) {
            let res = frame.get("result").expect("uiCall result");
            assert_eq!(res.get("success").and_then(|s| s.as_bool()), Some(true));
        } else if frame.get("id").and_then(|v| v.as_u64()) == Some(1) {
            execute_result = Some(frame);
            break;
        }
    }

    let final_frame = execute_result.expect("execute response received");
    let result = final_frame.get("result").expect("execute result present");
    assert_eq!(result["success"], true);
    assert_eq!(result["next_ports"], json!(["true"]));

    let report = result.get("report_data").expect("report_data present");
    assert_eq!(report["success"], true);
    assert!(report["final_answer"]
        .as_str()
        .unwrap()
        .contains("user@example.com"));

    let timeline = report["timeline"].as_array().expect("timeline array");
    assert!(timeline.len() >= 2);

    p.shutdown();
}

#[tokio::test]
async fn test_hitl_tool_confirmation_approval_flow() {
    let server = MockServer::start().await;

    // Tool execution mock endpoint
    Mock::given(method("POST"))
        .and(path("/api/delete-user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "deleted": true })))
        .mount(&server)
        .await;

    // Round 1: Model calls delete_user (which requires confirmation)
    let r1_sse = [
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Deleting user data.\",\"tool_calls\":[{\"index\":0,\"id\":\"call_del_1\",\"type\":\"function\",\"function\":{\"name\":\"delete_user\",\"arguments\":\"{\\\"user_id\\\":\\\"u123\\\"}\"}}]}}]}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n\n");

    // Round 2: Model returns final answer
    let r2_sse = [
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"User u123 has been successfully deleted.\"}}]}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n\n");

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(r1_sse),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(r2_sse),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();

    p.send_request(
        "execute",
        json!({
            "node_type": "agent:react",
            "execution_id": "test_exec_confirm",
            "config": {
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "sk-test",
                    "model": "gpt-4o",
                    "timeout_ms": 5000
                },
                "user_prompt": "Delete user u123",
                "stream": true,
                "tools": [{
                    "id": "delete_user",
                    "name": "delete_user",
                    "description": "Delete user account",
                    "tool_type": "standalone_action",
                    "target_node_type": "http:request",
                    "require_confirmation": true,
                    "fixed_config": {
                        "url": format!("{}/api/delete-user", server.uri()),
                        "method": "POST"
                    },
                    "dynamic_schema": {
                        "type": "object",
                        "properties": {
                            "user_id": { "type": "string" }
                        }
                    }
                }]
            }
        }),
    );

    // Read frames until confirmation interaction is received
    let mut interaction_id = String::new();
    for _ in 0..50 {
        let frame = p.read_next_frame();
        if let Some(params) = frame.get("params") {
            if params.get("type").and_then(|t| t.as_str()) == Some("waiting_human") {
                if let Some(interact) = params.get("interaction") {
                    if interact.get("interaction_type").and_then(|t| t.as_str()) == Some("confirmation") {
                        interaction_id = interact.get("interaction_id").unwrap().as_str().unwrap().to_string();
                        break;
                    }
                }
            }
        }
    }

    assert!(!interaction_id.is_empty(), "Expected confirmation interaction");

    // Approve the tool execution
    p.send_request(
        "uiCall",
        json!({
            "method": "submit_human_response",
            "params": {
                "interaction_id": interaction_id,
                "response": {
                    "approved": true
                }
            }
        }),
    );

    // Read remaining frames until execute completes
    let mut final_result = None;
    for _ in 0..50 {
        let frame = p.read_next_frame();
        if frame.get("id").and_then(|i| i.as_u64()) == Some(1) {
            final_result = Some(frame);
            break;
        }
    }

    let frame = final_result.expect("execute completed");
    let result = frame.get("result").expect("result object");
    assert_eq!(result["success"], true);

    let report = &result["report_data"];
    assert!(report["final_answer"].as_str().unwrap().contains("successfully deleted"));

    p.shutdown();
}

#[tokio::test]
async fn test_hitl_mid_flight_interruption() {
    let server = MockServer::start().await;

    // Send interruption via uiCall in a standalone test check
    let mut p = PluginProcess::spawn();

    let resp = p.send_request(
        "uiCall",
        json!({
            "method": "interrupt_agent",
            "params": {
                "execution_id": "exec_steer_1",
                "text": "Focus on security logs only"
            }
        }),
    );

    let mut ok = false;
    for _ in 0..10 {
        let frame = p.read_next_frame();
        if frame.get("id").and_then(|i| i.as_u64()) == Some(resp) {
            let res = frame.get("result").expect("result");
            assert_eq!(res["success"], true);
            ok = true;
            break;
        }
    }
    assert!(ok);
    p.shutdown();
}

#[tokio::test]
async fn test_hitl_tool_confirmation_rejection_flow() {
    let server = MockServer::start().await;

    // Round 1: Model calls drop_database (requires confirmation)
    let r1_sse = [
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Dropping database.\",\"tool_calls\":[{\"index\":0,\"id\":\"call_drop_1\",\"type\":\"function\",\"function\":{\"name\":\"drop_db\",\"arguments\":\"{\\\"db\\\":\\\"production\\\"}\"}}]}}]}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n\n");

    // Round 2: Model receives rejection error and self-corrects to safe alternative
    let r2_sse = [
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Operation aborted. Database was not dropped because human rejected the request.\"}}]}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n\n");

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(r1_sse),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(r2_sse),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();

    p.send_request(
        "execute",
        json!({
            "node_type": "agent:react",
            "execution_id": "test_exec_reject",
            "config": {
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "sk-test",
                    "model": "gpt-4o",
                    "timeout_ms": 5000
                },
                "user_prompt": "Clean up the database",
                "stream": true,
                "tools": [{
                    "id": "drop_db",
                    "name": "drop_db",
                    "description": "Drop production database",
                    "tool_type": "standalone_action",
                    "target_node_type": "http:request",
                    "require_confirmation": true,
                    "fixed_config": {
                        "url": format!("{}/api/drop", server.uri()),
                        "method": "POST"
                    },
                    "dynamic_schema": {
                        "type": "object",
                        "properties": {
                            "db": { "type": "string" }
                        }
                    }
                }]
            }
        }),
    );

    // Read frames until confirmation interaction is received
    let mut interaction_id = String::new();
    for _ in 0..50 {
        let frame = p.read_next_frame();
        if let Some(params) = frame.get("params") {
            if params.get("type").and_then(|t| t.as_str()) == Some("waiting_human") {
                if let Some(interact) = params.get("interaction") {
                    if interact.get("interaction_type").and_then(|t| t.as_str()) == Some("confirmation") {
                        interaction_id = interact.get("interaction_id").unwrap().as_str().unwrap().to_string();
                        break;
                    }
                }
            }
        }
    }

    assert!(!interaction_id.is_empty(), "Expected confirmation interaction");

    // Reject the tool execution with a reason
    p.send_request(
        "uiCall",
        json!({
            "method": "submit_human_response",
            "params": {
                "interaction_id": interaction_id,
                "response": {
                    "approved": false,
                    "reason": "Dropping production database is forbidden by security policy"
                }
            }
        }),
    );

    // Read remaining frames until execute completes
    let mut final_result = None;
    for _ in 0..50 {
        let frame = p.read_next_frame();
        if frame.get("id").and_then(|i| i.as_u64()) == Some(1) {
            final_result = Some(frame);
            break;
        }
    }

    let frame = final_result.expect("execute completed");
    let result = frame.get("result").expect("result object");
    assert_eq!(result["success"], true);

    let report = &result["report_data"];
    assert!(report["final_answer"].as_str().unwrap().contains("human rejected"));
    assert_eq!(report["self_corrections_count"], 1);

    p.shutdown();
}

#[tokio::test]
async fn test_hitl_step_by_step_debug_flow() {
    let server = MockServer::start().await;

    // Dummy tool endpoint
    Mock::given(method("GET"))
        .and(path("/api/ping"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "status": "pong" })))
        .mount(&server)
        .await;

    // Round 1: Model calls ping
    let r1_sse = [
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"reasoning_content\":\"Pinging service.\",\"tool_calls\":[{\"index\":0,\"id\":\"call_ping_1\",\"type\":\"function\",\"function\":{\"name\":\"ping\",\"arguments\":\"{}\"}}]}}]}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n\n");

    // Round 2: Model finishes
    let r2_sse = [
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Ping received pong response.\"}}]}",
        "",
        "data: [DONE]",
        "",
    ]
    .join("\n\n");

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(r1_sse),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(r2_sse),
        )
        .up_to_n_times(1)
        .mount(&server)
        .await;

    let mut p = PluginProcess::spawn();

    p.send_request(
        "execute",
        json!({
            "node_type": "agent:react",
            "execution_id": "test_exec_step_debug",
            "config": {
                "provider": {
                    "base_url": server.uri(),
                    "api_key": "sk-test",
                    "model": "gpt-4o",
                    "timeout_ms": 5000
                },
                "user_prompt": "Test ping connectivity",
                "stream": true,
                "step_by_step": true,
                "tools": [{
                    "id": "ping",
                    "name": "ping",
                    "description": "Ping test",
                    "tool_type": "standalone_action",
                    "target_node_type": "http:request",
                    "fixed_config": {
                        "url": format!("{}/api/ping", server.uri()),
                        "method": "GET"
                    },
                    "dynamic_schema": {
                        "type": "object",
                        "properties": {}
                    }
                }]
            }
        }),
    );

    // Read frames until step_pause interaction is received after round 1
    let mut interaction_id = String::new();
    for _ in 0..50 {
        let frame = p.read_next_frame();
        if let Some(params) = frame.get("params") {
            if params.get("type").and_then(|t| t.as_str()) == Some("waiting_human") {
                if let Some(interact) = params.get("interaction") {
                    if interact.get("interaction_type").and_then(|t| t.as_str()) == Some("step_pause") {
                        interaction_id = interact.get("interaction_id").unwrap().as_str().unwrap().to_string();
                        break;
                    }
                }
            }
        }
    }

    assert!(!interaction_id.is_empty(), "Expected step_pause interaction");

    // Advance to next step / run to end
    p.send_request(
        "uiCall",
        json!({
            "method": "submit_human_response",
            "params": {
                "interaction_id": interaction_id,
                "response": {
                    "action": "run_to_end"
                }
            }
        }),
    );

    // Read remaining frames until execute completes
    let mut final_result = None;
    for _ in 0..50 {
        let frame = p.read_next_frame();
        if frame.get("id").and_then(|i| i.as_u64()) == Some(1) {
            final_result = Some(frame);
            break;
        }
    }

    let frame = final_result.expect("execute completed");
    let result = frame.get("result").expect("result object");
    assert_eq!(result["success"], true);

    p.shutdown();
}
