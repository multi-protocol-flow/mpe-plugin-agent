# MPE Agent 智能体插件

> **定位**：本仓库是 MPE 的**官方协议插件之一**——它不依赖宿主仓库的任何代码，只依赖公开的 `mpe-plugin-sdk`（sidecar 进程 + stdio 上的 JSON-RPC，git tag `v0.2.2`）。宿主在启动时扫描插件目录，执行 `describe` 握手，注册节点类型，再通过 `execute` RPC 调用本插件进程。
>
> 本仓库与宿主相互独立（宿主仓库的 `.gitignore` 忽略了 `/plugins/`，且宿主从不构建它）。它由本仓库自己的 CI（GitHub Actions → Release artifacts）完成构建与发布。

---

## 0. 概要与工作原理

**Agent 智能体插件（`agent:react`）** 为 MPE 流程编排引入了由大语言模型（LLM）驱动的自主决策中枢。与传统的确定性单步协议节点（如 HTTP、Redis、Database、gRPC 等）不同，ReAct 智能体扮演动态调度与分析大脑角色：

- **ReAct (Reasoning + Acting) 闭环**：基于目标指令、前序节点数据与工具实时反馈，自主规划多步行动路径。
- **全协议工具动态调度 (`host.call_tool` 双向 RPC)**：将 MPE 中的任意协议节点（HTTP、DB、Redis、gRPC、Kafka、Mongo、MCP、Script、Subflow 等）转换为大模型可调用的 Tool。
- **自我修复机制（Self-Correction）**：当底层工具执行发生异常（如表不存在、字段名偏差、入参缺失或网络超时）时，将结构化错误信息反馈给模型，触发反思与参数重试。
- **安全护栏（Guardrails）**：支持只读操作审计、危险命令黑名单、禁止请求端点拦截及最大错误次数限制。
- **思考链时间线与执行追踪**：完整捕获模型思考过程（Reasoning/Thinking）、各轮工具调用参数与返回结果，通过内置可视化面板呈现。

### 通信拓扑结构

```
MPE 宿主进程 (mpe / mpe-cli)                     Agent 插件进程 (mpe_plugin_agent)
   │                                                    │
   │  ── describe ────────────────────────────────────► │  返回节点描述与 Schema 定义
   │  ◄─────────── node list ────────────────────────── │
   │                                                    │
   │  ── execute(config, execution_id) ───────────────► │  启动 ReAct 思考与行动循环
   │                                                    │    │ 组装 Prompt 与 Tools 调用 LLM
   │                                                    │    ▼ LLM 生成 ToolCall 请求
   │  ◄── host.call_tool(node_type, config) ─────────── │  向宿主发起反向 RPC 调度
   │  ┌──────────────────────────────────────────────┐  │
   │  │ 宿主调度执行对应协议节点 (DB/Redis/gRPC...)  │  │
   │  └──────────────────────────────────────────────┘  │
   │  ── host.call_tool 响应 (结果/错误) ─────────────► │  接收工具输出，注入上下文
   │                                                    │    ▼ 继续迭代或输出最终结论
   │  ◄─────────── execute 响应 (AgentOutput) ───────── │  返回最终结论与完整执行追踪
   │                                                    │
   │  ── flowEnded(execution_id) ─────────────────────► │  释放该次执行的连接池资源
```

## 1. 项目结构

```
mpe-plugin-agent/
├── Cargo.toml                # 独立包定义，不依赖宿主 workspace
├── plugin.json               # 宿主扫描的清单文件（启动命令、常驻能力）
├── .github/workflows/ci.yml  # 3 平台构建 + 测试 + Release 打包 CI
├── src/
│   ├── main.rs               # 二进制入口（安装 rustls + SDK 事件循环）
│   ├── lib.rs                # AgentPlugin：Plugin trait 实现 + 节点注册
│   ├── i18n.rs               # 基于 MPE_LOCALE 的中/英文案切换
│   ├── client.rs             # OpenAI 兼容 HTTP 客户端 + SSE 流式解析
│   ├── types.rs              # Agent 领域模型（ReAct 配置、Tool、安全护栏、输出）
│   ├── ui.rs                 # 设计期 UI 交互支持
│   └── nodes/
│       ├── mod.rs
│       └── react.rs          # agent:react 节点运行时与自我修复引擎
├── frontend/
│   ├── package.json
│   ├── vite.config.ts        # 配置面板 Vite 打包配置
│   ├── vite.config.viewer.ts # 查看器 Vite 打包配置
│   ├── src/
│   │   ├── panel.tsx         # Agent 节点配置面板组件
│   │   ├── viewer.tsx        # 执行时间线与思考轨迹查看器
│   │   ├── bridge.ts         # 与 MPE 宿主 iframe postMessage 通信桥
│   │   ├── styles.css        # Tailwind 与主题样式
│   │   ├── types.ts          # 前端数据类型
│   │   └── i18n.ts           # 前端国际化词典
│   ├── panel.html
│   ├── viewer.html
│   └── scripts/inline.mjs    # 单文件 HTML 内联打包脚本
└── tests/
    └── mock_react_e2e.rs     # 基于 wiremock 的端到端测试（ReAct 循环、工具调度、安全拦截）
```

## 2. 节点类型

| type_id | 端口 | 说明 |
|---------|------|------|
| `agent:react` | in / true / false | ReAct 自主决策智能体节点，支持多协议工具动态调度、错误自我修复、安全护栏与思考时间线 |

### 支持的工具来源形态

1. **`linked_node`（画布节点引用）**：直接引用画布上已存在的节点（如已配置连接池与鉴权的 `db:query` 或 `redis:command` 节点）。
2. **`standalone_action`（独立协议动作）**：在 Agent 内部声明式配置协议动作，无需在画布上放置多余的图形节点。
3. **`subflow`（复合子流程）**：将独立的 `.mpf` 流程文件作为高阶复合工具供智能体调度。

## 3. 配置参数说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `provider` | `object` | `{}` | LLM 服务商凭据配置（`base_url`、`api_key`、`model`、`timeout_ms`、`custom_headers`） |
| `provider_uuid` | `string` | `null` | 引用前序 `llm:provider` 节点声明的全局连接池 |
| `override_model` | `string` | `null` | 覆盖目标大模型名称 |
| `instruction` | `string` | `""` | 智能体需执行的核心任务指令 / 目标 |
| `system_prompt` | `string` | `""` | 自定义系统提示词规则 |
| `tools` | `array` | `[]` | 智能体可调用的工具列表定义 |
| `max_iterations` | `number` | `10` | 最大 ReAct 思考与行动迭代轮数 |
| `timeout_ms` | `number` | `300000` | 整体执行超时时间（毫秒） |
| `enable_thinking` | `boolean` | `true` | 是否捕获并流式展示思考链（Chain-of-Thought） |
| `guardrails` | `object` | `{}` | 安全护栏（`read_only`、`forbidden_commands`、`blocked_endpoints`、`max_consecutive_errors`） |

## 4. 构建与测试

```bash
# 1. 构建前端（配置面板 + 运行查看器）
cd frontend && npm install && npm run build
cd ..

# 2. 编译 Release 二进制文件
cargo build --release

# 3. 运行单元测试与 Mock E2E 端到端测试
cargo test
```

## 5. 开源协议

Apache-2.0 or MIT.
