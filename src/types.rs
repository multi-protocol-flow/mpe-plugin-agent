//! Data models and schemas for Agent protocol plugin.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Provider connection and authentication configuration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmProviderConfig {
    /// Base URL for OpenAI compatible API.
    #[serde(default = "default_base_url")]
    pub base_url: String,

    /// API key for authentication.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,

    /// Target model identifier (e.g. `gpt-4o`, `deepseek-chat`).
    #[serde(default = "default_model")]
    pub model: String,

    /// Request timeout in milliseconds (default: 60000).
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,

    /// Optional extra custom HTTP headers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<HashMap<String, String>>,
}

fn default_base_url() -> String {
    "https://api.openai.com/v1".to_string()
}

fn default_model() -> String {
    "gpt-4o".to_string()
}

fn default_timeout_ms() -> u64 {
    60_000
}

impl Default for LlmProviderConfig {
    fn default() -> Self {
        Self {
            base_url: default_base_url(),
            api_key: None,
            model: default_model(),
            timeout_ms: default_timeout_ms(),
            custom_headers: None,
        }
    }
}

/// Agent tool definition.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentToolDefinition {
    /// Unique identifier for the tool (e.g. "query_order_db").
    pub id: String,

    /// Display or function name exposed to LLM.
    #[serde(default)]
    pub name: String,

    /// Tool description for LLM reasoning.
    #[serde(default)]
    pub description: String,

    /// Tool category / source kind: "linked_node" | "standalone_action" | "subflow".
    #[serde(default = "default_tool_type")]
    pub tool_type: String,

    /// Target node type in MPE (e.g. "db:query", "redis:command", "http:request").
    pub target_node_type: String,

    /// Referenced canvas node ID (when tool_type is "linked_node").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,

    /// Human preset configuration (fixed fields like connection_uuid, timeout_ms).
    #[serde(default)]
    pub fixed_config: serde_json::Value,

    /// Dynamic JSON Schema exposed to LLM.
    #[serde(default)]
    pub dynamic_schema: serde_json::Value,

    /// Require human confirmation/approval before invoking this tool.
    #[serde(default)]
    pub require_confirmation: bool,
}

fn default_tool_type() -> String {
    "standalone_action".to_string()
}

/// Node configuration for `agent:react`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentReactConfig {
    /// Linked LLM provider node UUID (optional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_uuid: Option<String>,

    /// Optional model override.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_model: Option<String>,

    /// Optional provider request timeout override in milliseconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub override_timeout_ms: Option<u64>,

    /// Embedded provider config.
    #[serde(default)]
    pub provider: LlmProviderConfig,
    /// System prompt defining the role, goal, and constraints.
    #[serde(default = "default_system_prompt")]
    pub system_prompt: String,

    /// User prompt / goal description for this run.
    #[serde(default)]
    pub user_prompt: String,

    /// List of registered tools.
    #[serde(default)]
    pub tools: Vec<AgentToolDefinition>,

    /// Maximum ReAct iterations before stopping (default: 10).
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,

    /// Maximum tool calls allowed per single reasoning round (default: 5).
    #[serde(default = "default_max_tool_calls_per_round")]
    pub max_tool_calls_per_round: u32,

    /// Sampling temperature (default: 0.2).
    #[serde(default = "default_temperature")]
    pub temperature: f32,

    /// Hard timeout for entire execution in seconds (default: 120).
    #[serde(default = "default_timeout_secs")]
    pub timeout_secs: u64,

    /// Read-only safety guardrail mode (default: false).
    #[serde(default)]
    pub read_only_mode: bool,
    /// Whether to stream LLM responses (default: true).
    #[serde(default = "default_true")]
    pub stream: bool,

    /// Whether to enable built-in `ask_human` tool (default: true).
    #[serde(default = "default_true")]
    pub enable_ask_human: bool,

    /// Step-by-step debug mode: pause after each tool execution for human stepping (default: false).
    #[serde(default)]
    pub step_by_step: bool,
}

fn default_system_prompt() -> String {
    "You are an autonomous ReAct agent. Reason step by step, call available tools when necessary, observe results, self-correct if errors occur, and provide a clear final answer when done.".to_string()
}

fn default_max_iterations() -> u32 {
    10
}

fn default_max_tool_calls_per_round() -> u32 {
    5
}

fn default_temperature() -> f32 {
    0.2
}

fn default_timeout_secs() -> u64 {
    120
}

fn default_true() -> bool {
    true
}

impl Default for AgentReactConfig {
    fn default() -> Self {
        Self {
            provider_uuid: None,
            override_model: None,
            override_timeout_ms: None,
            provider: LlmProviderConfig::default(),
            system_prompt: default_system_prompt(),
            user_prompt: String::new(),
            tools: Vec::new(),
            max_iterations: default_max_iterations(),
            max_tool_calls_per_round: default_max_tool_calls_per_round(),
            temperature: default_temperature(),
            timeout_secs: default_timeout_secs(),
            read_only_mode: false,
            stream: true,
            enable_ask_human: true,
            step_by_step: false,
        }
    }
}

/// Chat message used in conversation history.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".to_string(),
            content: Some(content.into()),
            reasoning_content: None,
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".to_string(),
            content: Some(content.into()),
            reasoning_content: None,
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }
    }

    pub fn assistant_text(content: impl Into<String>, reasoning: Option<String>) -> Self {
        Self {
            role: "assistant".to_string(),
            content: Some(content.into()),
            reasoning_content: reasoning,
            name: None,
            tool_call_id: None,
            tool_calls: None,
        }
    }

    pub fn assistant_tool_calls(
        content: Option<String>,
        reasoning: Option<String>,
        tool_calls: Vec<ToolCall>,
    ) -> Self {
        Self {
            role: "assistant".to_string(),
            content,
            reasoning_content: reasoning,
            name: None,
            tool_call_id: None,
            tool_calls: Some(tool_calls),
        }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".to_string(),
            content: Some(content.into()),
            reasoning_content: None,
            name: None,
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: None,
        }
    }
}

/// Tool call specification from LLM.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "default_function_type")]
    pub kind: String,
    pub function: FunctionCall,
}

fn default_function_type() -> String {
    "function".to_string()
}

/// Function call parameters.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    pub arguments: String,
}

/// Token usage tracking.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

/// Single tool call execution detail in timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineToolCall {
    pub call_id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub node_type: String,
    pub input_args: serde_json::Value,
    pub merged_config: serde_json::Value,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub raw_response: String,
    pub duration_ms: u64,
}

/// One step in the ReAct Thinking Timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineStep {
    pub step_index: u32,
    /// "thought" | "tool_call" | "self_correction" | "final_answer" | "error" | "waiting_human" | "human_response" | "interrupted" | "step_pause"
    pub step_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thought: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<TimelineToolCall>,
    pub duration_ms: u64,
    #[serde(default)]
    pub self_correction: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<TokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human_interaction: Option<PendingInteraction>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub human_response: Option<HumanResponse>,
}

/// Output data and report data returned by `agent:react`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentReactOutput {
    pub success: bool,
    pub final_answer: String,
    pub iterations: u32,
    pub tool_call_count: u32,
    pub self_corrections_count: u32,
    pub token_usage: TokenUsage,
    pub total_duration_ms: u64,
    pub timeline: Vec<TimelineStep>,
}
/// A pending interaction request waiting for human intervention.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingInteraction {
    pub interaction_id: String,
    pub execution_id: String,
    /// "ask_human" | "confirmation" | "step_pause"
    pub interaction_type: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_args: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_index: Option<u32>,
    pub created_at_ms: u64,
}

/// Response payload submitted by human in the loop.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HumanResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>, // "next_step" | "run_to_end" | "cancel"
}

/// Generates the standard OpenAI function tool schema for `ask_human`.
pub fn ask_human_tool_definition() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "ask_human",
            "description": "向人类用户提问以获取缺失的参数、背景信息或确认 (Ask human user for missing information, clarification or confirmation)",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "向用户提出的具体问题或说明 (Specific question or explanation to the human user)"
                    }
                },
                "required": ["question"]
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Thread-safe Interaction Registry & Interruption Queues
// ---------------------------------------------------------------------------

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tokio::sync::oneshot;

pub type InteractionSender = oneshot::Sender<HumanResponse>;

static INTERACTION_REGISTRY: OnceLock<Mutex<HashMap<String, InteractionSender>>> = OnceLock::new();
static INTERRUPTION_QUEUES: OnceLock<Mutex<HashMap<String, Vec<String>>>> = OnceLock::new();
static INTERACTION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Generates a globally unique interaction ID.
pub fn next_interaction_id(prefix: &str, exec_id: &str) -> String {
    let count = INTERACTION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{exec_id}_{count}")
}

/// Registers an active interaction channel waiting for human input.
pub fn register_interaction(interaction_id: &str, tx: InteractionSender) {
    let registry = INTERACTION_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = registry.lock() {
        map.insert(interaction_id.to_string(), tx);
    }
}

/// Completes an interaction by sending the human response payload into the channel.
pub fn complete_interaction(interaction_id: &str, resp: HumanResponse) -> bool {
    let registry = INTERACTION_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = registry.lock() {
        if let Some(tx) = map.remove(interaction_id) {
            return tx.send(resp).is_ok();
        }
    }
    false
}

/// Pushes an interruption/steering text message into the session queue.
pub fn push_interruption(execution_id: &str, text: String) {
    let queues = INTERRUPTION_QUEUES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = queues.lock() {
        let key = if execution_id.trim().is_empty() { "default" } else { execution_id.trim() };
        map.entry(key.to_string()).or_default().push(text);
    }
}

/// Drains and clears all pending interruptions for a session.
pub fn drain_interruptions(execution_id: &str) -> Vec<String> {
    let queues = INTERRUPTION_QUEUES.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(mut map) = queues.lock() {
        let mut list = Vec::new();
        // 1. Drain exact execution_id
        if let Some(queue) = map.get_mut(execution_id) {
            list.append(queue);
        }
        // 2. Also drain global/default queue if not already "default"
        if execution_id != "default" && !execution_id.is_empty() {
            if let Some(queue) = map.get_mut("default") {
                list.append(queue);
            }
        }
        // 3. Fallback: if list is still empty, drain any other queues
        if list.is_empty() {
            for queue in map.values_mut() {
                list.append(queue);
            }
        }
        return list;
    }
    Vec::new()
}
/// Cleans up any leftover interactions or interruptions for an execution session.
pub fn clear_execution_interactions(execution_id: &str) {
    if let Ok(mut map) = INTERACTION_REGISTRY.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        map.retain(|k, _| !k.contains(execution_id));
    }
    if let Ok(mut map) = INTERRUPTION_QUEUES.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        map.remove(execution_id);
    }
}

/// Converts an `AgentToolDefinition` into OpenAI Function Calling format.
pub fn tool_to_openai_function(tool: &AgentToolDefinition) -> serde_json::Value {
    let func_name = if tool.name.is_empty() {
        tool.id.clone()
    } else {
        tool.name.clone()
    };

    let params = if tool.dynamic_schema.is_object() && !tool.dynamic_schema.as_object().is_none_or(serde_json::Map::is_empty) {
        tool.dynamic_schema.clone()
    } else {
        serde_json::json!({
            "type": "object",
            "properties": {},
            "additionalProperties": true
        })
    };

    serde_json::json!({
        "type": "function",
        "function": {
            "name": func_name,
            "description": tool.description,
            "parameters": params
        }
    })
}

/// Merges fixed preset config with dynamic LLM arguments.
pub fn merge_tool_config(
    fixed_config: &serde_json::Value,
    dynamic_args: &serde_json::Value,
    dynamic_schema: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut merged = if fixed_config.is_object() {
        fixed_config.clone()
    } else {
        serde_json::json!({})
    };

    if let Some(dyn_obj) = dynamic_args.as_object() {
        let allowed_keys: Option<Vec<&str>> = dynamic_schema
            .get("properties")
            .and_then(|p| p.as_object())
            .map(|obj| obj.keys().map(|k| k.as_str()).collect());

        let target_obj = merged.as_object_mut().ok_or("fixed_config is not an object")?;

        for (k, v) in dyn_obj {
            if let Some(allowed) = &allowed_keys {
                if !allowed.contains(&k.as_str()) {
                    return Err(format!(
                        "Parameter '{}' is not declared in dynamic schema for this tool",
                        k
                    ));
                }
            }
            target_obj.insert(k.clone(), v.clone());
        }
    }

    Ok(merged)
}

/// Read-only safety guardrail inspection.
pub fn audit_tool_call_safety(
    node_type: &str,
    config: &serde_json::Value,
    read_only_mode: bool,
) -> Result<(), String> {
    if !read_only_mode {
        return Ok(());
    }

    // 1. SQL / Database checks
    if node_type.starts_with("db:") || node_type == "sql" {
        let sql = config
            .get("sql")
            .or_else(|| config.get("query"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let mutating_keywords = [
            r"\bINSERT\b",
            r"\bUPDATE\b",
            r"\bDELETE\b",
            r"\bDROP\b",
            r"\bALTER\b",
            r"\bTRUNCATE\b",
            r"\bCREATE\b",
            r"\bREPLACE\b",
            r"\bGRANT\b",
            r"\bREVOKE\b",
            r"\bEXEC\b",
        ];

        for kw in mutating_keywords {
            let re = Regex::new(&format!("(?i){}", kw)).map_err(|e| e.to_string())?;
            if re.is_match(sql) {
                return Err(format!(
                    "Read-only guardrail blocked mutating SQL statement matching pattern '{}'",
                    kw
                ));
            }
        }
    }

    // 2. Redis checks
    if node_type.starts_with("redis:") {
        let cmd = config
            .get("command")
            .or_else(|| config.get("cmd"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();

        let mutating_redis_cmds = [
            "SET", "DEL", "HSET", "HDEL", "LPUSH", "RPUSH", "LPOP", "RPOP", "SADD", "SREM",
            "ZADD", "ZREM", "FLUSHDB", "FLUSHALL", "EXPIRE", "PEXPIRE", "RENAME",
        ];

        let upper_cmd = cmd.to_uppercase();
        let first_word = upper_cmd.split_whitespace().next().unwrap_or("");
        if mutating_redis_cmds.contains(&first_word) {
            return Err(format!(
                "Read-only guardrail blocked mutating Redis command '{}'",
                first_word
            ));
        }
    }

    // 3. HTTP method checks
    if node_type.starts_with("http:request") {
        let method = config
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("GET")
            .to_uppercase();

        if ["POST", "PUT", "DELETE", "PATCH"].contains(&method.as_str()) {
            return Err(format!(
                "Read-only guardrail blocked non-idempotent HTTP method '{}'",
                method
            ));
        }
    }

    Ok(())
}

/// Resolves the effective provider config given a pool, execution context,
/// node instance uuid / provider_uuid, inline config, and optional model override.
pub fn resolve_effective_provider(
    pool: &mpe_plugin_sdk::pool::ConnectionPool,
    ctx_providers: Option<&std::collections::HashMap<String, serde_json::Value>>,
    exec_id: &str,
    provider_uuid: Option<&str>,
    inline_provider: &LlmProviderConfig,
    override_model: Option<&str>,
    override_timeout_ms: Option<u64>,
) -> Result<LlmProviderConfig, String> {
    let mut provider = if let Some(uuid) = provider_uuid.filter(|s| !s.trim().is_empty()) {
        let key = format!("{exec_id}:{uuid}");
        let mut p = if let Some(pooled) = pool.get::<LlmProviderConfig>(&key) {
            (*pooled).clone()
        } else if let Some(pooled) = pool.get::<LlmProviderConfig>(uuid) {
            (*pooled).clone()
        } else if let Some(prov_val) = ctx_providers.and_then(|p| p.get(uuid).or_else(|| p.get(&key))) {
            serde_json::from_value::<LlmProviderConfig>(prov_val.clone())
                .map_err(|e| format!("Invalid provider data in execution context: {e}"))?
        } else if !inline_provider.base_url.trim().is_empty()
            && (!inline_provider.model.trim().is_empty() || override_model.is_some())
        {
            inline_provider.clone()
        } else {
            return Err(crate::i18n::t(
                "未找到指定的 LLM 服务商配置，请确保在执行前添加并运行了 LLM Provider 节点，或配置服务商参数",
                "Referenced LLM Provider not found; ensure an LLM Provider node was executed or configure provider parameters",
            ).to_string());
        };

        // If pooled or context provider has empty API key, inherit from inline_provider
        if p.api_key.as_deref().unwrap_or("").trim().is_empty() {
            if let Some(k) = &inline_provider.api_key {
                if !k.trim().is_empty() {
                    p.api_key = Some(k.clone());
                }
            }
        }
        p
    } else {
        inline_provider.clone()
    };

    if let Some(m) = override_model.filter(|s| !s.trim().is_empty()) {
        provider.model = m.to_string();
    }

    if let Some(t) = override_timeout_ms.filter(|&t| t > 0) {
        provider.timeout_ms = t;
    }

    if provider.base_url.trim().is_empty() {
        return Err(crate::i18n::t("缺少服务商 Base URL", "Missing provider Base URL").to_string());
    }

    Ok(provider)
}


#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn test_merge_tool_config_valid() {
        let fixed = serde_json::json!({
            "connection_uuid": "conn-123",
            "timeout_ms": 5000
        });
        let dynamic = serde_json::json!({
            "sql": "SELECT * FROM users;"
        });
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "sql": { "type": "string" }
            },
            "required": ["sql"]
        });

        let merged = merge_tool_config(&fixed, &dynamic, &schema).expect("merge should succeed");
        assert_eq!(merged["connection_uuid"], "conn-123");
        assert_eq!(merged["timeout_ms"], 5000);
        assert_eq!(merged["sql"], "SELECT * FROM users;");
    }

    #[test]
    fn test_merge_tool_config_reject_undeclared_param() {
        let fixed = serde_json::json!({
            "connection_uuid": "conn-123"
        });
        let dynamic = serde_json::json!({
            "sql": "SELECT 1;",
            "malicious_override": "override"
        });
        let schema = serde_json::json!({
            "type": "object",
            "properties": {
                "sql": { "type": "string" }
            }
        });

        let err = merge_tool_config(&fixed, &dynamic, &schema).unwrap_err();
        assert!(err.contains("malicious_override"));
    }

    #[test]
    fn test_audit_safety_sql() {
        let config_ok = serde_json::json!({ "sql": "SELECT * FROM orders WHERE id = 1;" });
        assert!(audit_tool_call_safety("db:query", &config_ok, true).is_ok());

        let config_bad = serde_json::json!({ "sql": "DELETE FROM orders WHERE id = 1;" });
        assert!(audit_tool_call_safety("db:query", &config_bad, true).is_err());

        // When read_only is false, delete is allowed
        assert!(audit_tool_call_safety("db:query", &config_bad, false).is_ok());
    }

    #[test]
    fn test_audit_safety_redis() {
        let config_ok = serde_json::json!({ "command": "GET user:1" });
        assert!(audit_tool_call_safety("redis:cmd", &config_ok, true).is_ok());

        let config_bad = serde_json::json!({ "command": "DEL user:1" });
        assert!(audit_tool_call_safety("redis:cmd", &config_bad, true).is_err());
    }

    #[test]
    fn test_audit_safety_http() {
        let config_ok = serde_json::json!({ "method": "GET" });
        assert!(audit_tool_call_safety("http:request", &config_ok, true).is_ok());

        let config_bad = serde_json::json!({ "method": "POST" });
        assert!(audit_tool_call_safety("http:request", &config_bad, true).is_err());
    }

    #[test]
    fn test_resolve_effective_provider_from_pool() {
        let pool = mpe_plugin_sdk::pool::ConnectionPool::new();
        let pooled_provider = LlmProviderConfig {
            base_url: "https://api.openai.com/v1".to_string(),
            api_key: Some("sk-pooled-key".to_string()),
            model: "gpt-4o-mini".to_string(),
            timeout_ms: 30000,
            custom_headers: None,
        };
        pool.get_or_insert("exec-1:prov-node-1".to_string(), || pooled_provider.clone());

        let inline_provider = LlmProviderConfig::default();

        let resolved = resolve_effective_provider(
            &pool,
            None,
            "exec-1",
            Some("prov-node-1"),
            &inline_provider,
            None,
            None,
        )
        .expect("should resolve from pool");

        assert_eq!(resolved.api_key.as_deref(), Some("sk-pooled-key"));
        assert_eq!(resolved.model, "gpt-4o-mini");
    }

    #[test]
    fn test_resolve_effective_provider_from_context_providers() {
        let pool = mpe_plugin_sdk::pool::ConnectionPool::new();
        let mut providers = std::collections::HashMap::new();
        providers.insert(
            "prov-node-ctx".to_string(),
            serde_json::json!({
                "base_url": "https://api.context-provider.com/v1",
                "api_key": "sk-ctx-key",
                "model": "ctx-model"
            }),
        );

        let inline_provider = LlmProviderConfig::default();

        let resolved = resolve_effective_provider(
            &pool,
            Some(&providers),
            "exec-ctx",
            Some("prov-node-ctx"),
            &inline_provider,
            None,
            None,
        )
        .expect("should resolve from context providers map");

        assert_eq!(resolved.base_url, "https://api.context-provider.com/v1");
        assert_eq!(resolved.api_key.as_deref(), Some("sk-ctx-key"));
        assert_eq!(resolved.model, "ctx-model");
    }

    #[test]
    fn test_resolve_effective_provider_with_override_model() {
        let pool = mpe_plugin_sdk::pool::ConnectionPool::new();
        let inline_provider = LlmProviderConfig {
            base_url: "https://api.deepseek.com/v1".to_string(),
            api_key: Some("sk-custom".to_string()),
            model: "deepseek-chat".to_string(),
            timeout_ms: 60000,
            custom_headers: None,
        };

        let resolved = resolve_effective_provider(
            &pool,
            None,
            "exec-1",
            None,
            &inline_provider,
            Some("deepseek-reasoner"),
            Some(45000),
        )
        .expect("should resolve with override");

        assert_eq!(resolved.model, "deepseek-reasoner");
        assert_eq!(resolved.timeout_ms, 45000);
    }
}
