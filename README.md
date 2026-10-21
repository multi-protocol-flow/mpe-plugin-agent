# MPE Agent Plugin

> **Positioning**: this plugin is one of MPE's **official protocol plugins** — it
> depends on none of the host repository's code, only the public
> `mpe-plugin-sdk` (sidecar process + JSON-RPC over stdio, git tag `v0.2.2`).
> The host scans its plugin directory at startup, runs the `describe` handshake,
> registers the node types, and calls this plugin process via the `execute` RPC.
>
> This repository is independent of the host (the host repository's `.gitignore`
> ignores `/plugins/` and the host never builds it). It is built and released by
> this repository's own CI (GitHub Actions → Release artifacts).

---

## 0. Overview & How It Works

The **Agent Plugin (`agent:react`)** provides an autonomous LLM-driven decision engine inside MPE workflows. Unlike deterministic single-step protocol nodes (e.g. HTTP, Redis, Database, gRPC), the ReAct Agent acts as a dynamic orchestration center:

- **ReAct (Reasoning + Acting) Loop**: Autonomously plans multi-step actions based on prompt instructions, previous step outputs, and real-time tool feedback.
- **Dynamic Tool Dispatch via Bidirectional RPC (`host.call_tool`)**: Converts any MPE protocol node (HTTP, DB, Redis, gRPC, Kafka, Mongo, MCP, Script, Subflow) into a callable tool for the LLM.
- **Self-Correction Engine**: When a tool fails (e.g., table not found, bad parameter, timeout), the error detail is injected back into the reasoning context, allowing the LLM to inspect the error, adjust parameters, and retry.
- **Safety Guardrails**: Enforces read-only operations, command blacklists, target endpoint restrictions, and max iteration limits.
- **Thinking Timeline & Execution Trace**: Captures chain-of-thought thoughts, step-by-step tool calls, arguments, and execution outputs in real-time.

### Communication Topology

```
Host (mpe / mpe-cli)                            Plugin process (mpe_plugin_agent)
   │                                                    │
   │  ── describe ────────────────────────────────────► │  returns node description & config schema
   │  ◄─────────── node list ────────────────────────── │
   │                                                    │
   │  ── execute(config, execution_id) ───────────────► │  starts ReAct iteration loop
   │                                                    │    │ calls LLM with Tools Schema
   │                                                    │    ▼ LLM decides to call a tool
   │  ◄── host.call_tool(node_type, config) ─────────── │  sends reverse RPC to host
   │  ┌──────────────────────────────────────────────┐  │
   │  │ Host executes target protocol node (DB/Redis)│  │
   │  └──────────────────────────────────────────────┘  │
   │  ── host.call_tool response (output / error) ───► │  feeds tool result back into LLM
   │                                                    │    ▼ repeats loop or produces final answer
   │  ◄─────────── execute result (AgentOutput) ─────── │  returns final conclusion & trace timeline
   │                                                    │
   │  ── flowEnded(execution_id) ─────────────────────► │  releases pooled connections
```

## 1. Project Structure

```
mpe-plugin-agent/
├── Cargo.toml                # standalone package, no host workspace dependency
├── plugin.json               # manifest scanned by the host (launch description, capabilities)
├── .github/workflows/ci.yml  # 3-platform build + tests + Release packaging
├── src/
│   ├── main.rs               # binary entry point (rustls provider + SDK event loop)
│   ├── lib.rs                # AgentPlugin: Plugin trait impl + node descriptions
│   ├── i18n.rs               # MPE_LOCALE-driven zh-CN / en-US localization
│   ├── client.rs             # OpenAI-compatible HTTP client + SSE parser
│   ├── types.rs              # Agent domain types (ReAct config, tools, guardrails, output)
│   ├── ui.rs                 # design-time UI call handlers
│   └── nodes/
│       ├── mod.rs
│       └── react.rs          # agent:react node execution engine & self-correction loop
├── frontend/
│   ├── package.json
│   ├── vite.config.ts        # Vite config for config panel
│   ├── vite.config.viewer.ts # Vite config for execution viewer
│   ├── src/
│   │   ├── panel.tsx         # Agent configuration panel UI
│   │   ├── viewer.tsx        # Execution timeline & thinking trace viewer UI
│   │   ├── bridge.ts         # PostMessage bridge with MPE host iframe
│   │   ├── styles.css        # Tailwind & theme styles
│   │   ├── types.ts          # Frontend data models
│   │   └── i18n.ts           # Frontend i18n dictionary
│   ├── panel.html
│   ├── viewer.html
│   └── scripts/inline.mjs    # Single-file HTML inlining script
└── tests/
    └── mock_react_e2e.rs     # wiremock-based end-to-end tests (ReAct loop, tool calls, guardrails)
```

## 2. Node Types

| type_id | ports | description |
|---------|-------|-------------|
| `agent:react` | in / true / false | ReAct autonomous decision engine with dynamic multi-protocol tool calling, self-correction, guardrails, and thinking timeline |

### Tool Types Supported

1. **`linked_node` (Canvas Node)**: References an existing node on the canvas (e.g. pre-configured `db:query` or `redis:command`), inheriting its connection pool and auth parameters.
2. **`standalone_action` (Independent Action)**: Declaratively configures a protocol action inside the Agent configuration without placing a dedicated node on the canvas.
3. **`subflow` (Subflow)**: Invokes a nested `.mpf` workflow file as a high-level composite tool.

## 3. Configuration Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `object` | `{}` | LLM provider config (`base_url`, `api_key`, `model`, `timeout_ms`, `custom_headers`) |
| `provider_uuid` | `string` | `null` | References a shared provider configured by `llm:provider` |
| `override_model` | `string` | `null` | Override model identifier for this agent node |
| `instruction` | `string` | `""` | User task instruction / goal to solve |
| `system_prompt` | `string` | `""` | Custom system prompt guidelines for LLM behavior |
| `tools` | `array` | `[]` | List of tool definitions available to the agent |
| `max_iterations` | `number` | `10` | Maximum ReAct thinking and acting cycles |
| `timeout_ms` | `number` | `300000` | Overall execution timeout (ms) |
| `enable_thinking` | `boolean` | `true` | Stream reasoning tokens and capture chain-of-thought |
| `guardrails` | `object` | `{}` | Safety rules (`read_only`, `forbidden_commands`, `blocked_endpoints`, `max_consecutive_errors`) |

## 4. Build and Test

```bash
# 1. Build frontend (config panel + timeline viewer)
cd frontend && npm install && npm run build
cd ..

# 2. Build release binary
cargo build --release

# 3. Run unit tests and Mock E2E tests
cargo test
```

## 5. License

MIT — see [LICENSE](./LICENSE).
