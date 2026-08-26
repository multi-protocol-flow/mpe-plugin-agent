//! Agent sidecar plugin for MPE (Multi-Protocol Flow Executor).
//!
//! Provides the ReAct autonomous decision agent:
//! - `agent:react`: Multi-step reasoning loop with dynamic tool calling, self-correction, guardrails, and thinking timeline.

use mpe_plugin_sdk::pool::ConnectionPool;
use mpe_plugin_sdk::prelude::*;
use std::future::Future;
use std::sync::Arc;

pub mod client;
pub mod i18n;
pub mod nodes;
pub mod types;
pub mod ui;

/// Agent Plugin instance.
pub struct AgentPlugin {
    pool: Arc<ConnectionPool>,
}

impl Default for AgentPlugin {
    fn default() -> Self {
        Self {
            pool: Arc::new(ConnectionPool::new()),
        }
    }
}

fn operation_ports() -> Vec<PortDescription> {
    vec![
        PortDescription::new("in", i18n::t("输入", "Input"), PORT_KIND_IN),
        PortDescription::new("true", i18n::t("成功", "Success"), PORT_KIND_OUT),
        PortDescription::new("false", i18n::t("失败", "Failure"), PORT_KIND_OUT),
    ]
}

fn agent_react_node() -> NodeDescription {
    let mut node = NodeDescription::new(
        "agent:react",
        i18n::t("ReAct 智能体", "ReAct Agent"),
    );
    node.category = Some("ai".to_string());
    node.icon = Some("puzzle".to_string());
    node.color = Some("#8B5CF6".to_string());
    node.ports = operation_ports();
    node.default_config = serde_json::json!({
        "provider_uuid": "",
        "override_model": "",
        "provider": {
            "base_url": "https://api.openai.com/v1",
            "api_key": "",
            "model": "gpt-4o",
            "timeout_ms": 60000
        },
        "system_prompt": "You are an autonomous ReAct agent. Reason step by step, call available tools when necessary, observe results, self-correct if errors occur, and provide a clear final answer when done.",
        "user_prompt": "",
        "tools": [],
        "max_iterations": 10,
        "max_tool_calls_per_round": 5,
        "temperature": 0.2,
        "timeout_secs": 120,
        "read_only_mode": false,
        "stream": true
    });
    node.capabilities = PluginCapabilities {
        streaming: true,
        single_node: true,
    };
    node.config_schema = Some(serde_json::json!({
        "type": "object",
        "properties": {
            "provider_uuid": { "type": "string", "title": i18n::t("服务商节点", "Provider Node") },
            "override_model": { "type": "string", "title": i18n::t("覆盖模型", "Override Model") },
            "override_timeout_ms": { "type": "integer", "title": i18n::t("覆盖超时(毫秒)", "Override Timeout (ms)") },
            "provider": { "type": "object", "title": i18n::t("服务商配置", "Provider Config") },
            "system_prompt": { "type": "string", "title": i18n::t("系统提示词", "System Prompt") },
            "user_prompt": { "type": "string", "title": i18n::t("目标提示词", "User Prompt") },
            "tools": { "type": "array", "title": i18n::t("注册工具", "Registered Tools") },
            "max_iterations": { "type": "integer", "title": i18n::t("最大迭代轮次", "Max Iterations") },
            "temperature": { "type": "number", "title": i18n::t("采样温度", "Temperature") },
            "timeout_secs": { "type": "integer", "title": i18n::t("超时(秒)", "Timeout (s)") },
            "read_only_mode": { "type": "boolean", "title": i18n::t("只读安全模式", "Read-Only Mode") },
            "stream": { "type": "boolean", "title": i18n::t("流式推理", "Streaming") }
        },
        "required": ["user_prompt"]
    }));
    node.frontend = Some(FrontendDescription {
        kind: "inline".into(),
        content: Some(include_str!("../frontend/dist/panel.html").to_string()),
        url: None,
    });
    node.viewer = Some(FrontendDescription {
        kind: "inline".into(),
        content: Some(include_str!("../frontend/dist/viewer.html").to_string()),
        url: None,
    });
    node
}

impl Plugin for AgentPlugin {
    fn describe(&self) -> Vec<NodeDescription> {
        vec![agent_react_node()]
    }

    fn execute(&self, ctx: &mut ExecuteContext) -> impl Future<Output = ExecuteResult> + Send {
        let pool = self.pool.clone();
        async move {
            nodes::execute_react(ctx, &pool).await
        }
    }

    fn ui_call(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> impl Future<Output = Result<serde_json::Value, String>> + Send {
        let method = method.to_string();
        async move { ui::handle_ui_call(&method, params).await }
    }
}
