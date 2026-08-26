import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  initBridge,
  notifyConfig,
  postResize,
  uiCall,
} from './bridge';
import { t } from './i18n';
import {
  IconBot,
  IconBrain,
  IconClock,
  IconFolder,
  IconGlobe,
  IconKey,
  IconLayers,
  IconLink,
  IconPlus,
  IconShield,
  IconSparkles,
  IconTrash,
  IconWrench,
  IconX,
  IconZap,
} from './icons';
import './styles.css';
import type {
  AgentReactConfig,
  AgentToolDefinition,
  LlmProviderConfig,
  PluginIframeNodeSnapshot,
} from './types';

const PROVIDER_PRESETS: Record<string, { label: string; base_url: string; default_model: string }> = {
  openai: {
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    default_model: 'gpt-4o',
  },
  deepseek: {
    label: 'DeepSeek (V3)',
    base_url: 'https://api.deepseek.com/v1',
    default_model: 'deepseek-chat',
  },
  deepseek_r1: {
    label: 'DeepSeek (R1)',
    base_url: 'https://api.deepseek.com/v1',
    default_model: 'deepseek-reasoner',
  },
  siliconflow: {
    label: 'SiliconFlow',
    base_url: 'https://api.siliconflow.cn/v1',
    default_model: 'deepseek-ai/DeepSeek-V3',
  },
  qwen: {
    label: 'Qwen (DashScope)',
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    default_model: 'qwen-plus',
  },
  ollama: {
    label: 'Ollama (Local)',
    base_url: 'http://localhost:11434/v1',
    default_model: 'llama3:latest',
  },
  vllm: {
    label: 'vLLM / Local OpenAI',
    base_url: 'http://localhost:8000/v1',
    default_model: 'default',
  },
  custom: {
    label: 'Custom Provider',
    base_url: '',
    default_model: '',
  },
};

const SYSTEM_PROMPT_TEMPLATES: Record<
  string,
  {
    labelZh: string;
    labelEn: string;
    promptZh: string;
    promptEn: string;
  }
> = {
  sre: {
    labelZh: '运维排障专家 (SRE & Troubleshooting)',
    labelEn: 'SRE & Troubleshooting Expert',
    promptZh:
      '你是一名资深 SRE 运维与排障专家。请根据输入的系统告警和日志，逐步分析故障原因，主动调用数据库、缓存、网络 API 等工具进行数据比对与状态排查。遇到错误时自主修正入参并重试，最终产出结构化的故障根因与修复建议。',
    promptEn:
      'You are an expert SRE and system troubleshooting agent. Analyze system alerts and logs step-by-step. Proactively call database, cache, and HTTP API tools to inspect system state and compare metrics. Self-correct tool parameters when errors occur, and output a structured root-cause analysis with remediation steps.',
  },
  api_test: {
    labelZh: 'API 自动化测试专家 (API Test Automation)',
    labelEn: 'API Test Automation Agent',
    promptZh:
      '你是一名资深 API 自动化与集成测试智能体。请依据用户给定的测试场景与前序节点输出，动态调用 HTTP、gRPC、数据库等工具执行多步接口链路验证，校验接口返回状态与数据一致性，并在测试未达预期时给出详细定位报告。',
    promptEn:
      'You are an autonomous API test automation and integration agent. Based on test requirements and upstream outputs, dynamically call HTTP, gRPC, and database tools to verify multi-step API workflows. Validate status codes and data consistency, and provide detailed diagnostic reports when assertions fail.',
  },
  analytics: {
    labelZh: '数据分析与查询助手 (Data Analytics)',
    labelEn: 'Data Analytics & Query Specialist',
    promptZh:
      '你是一名智能数据分析专家。根据用户提出的业务指标与分析目标，自主规划 SQL 查询与缓存提取步骤，校验数据完整性，并汇总输出清晰的数据结论与统计报表。',
    promptEn:
      'You are an intelligent data analytics specialist. Based on requested business metrics and questions, plan SQL queries and cache lookups, verify data integrity, and summarize clear analytical insights and structured reports.',
  },
  general: {
    labelZh: '通用 ReAct 智能体 (General Autonomous Agent)',
    labelEn: 'General Autonomous ReAct Agent',
    promptZh:
      '你是一个通用的 ReAct 自主智能体。请按 Thought -> Action -> Observation 循环逐步拆解目标，必要时调用合适工具，遇到错误时反思修正，并在最终达成目标后输出完整清晰的结论。',
    promptEn:
      'You are an autonomous ReAct agent. Reason step by step, call available tools when necessary, observe results, self-correct if errors occur, and provide a clear final answer when done.',
  },
};

function ToolSchemaEditor({
  schema,
  onChange,
}: {
  schema: Record<string, unknown>;
  onChange: (newSchema: Record<string, unknown>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(schema || {}, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const currentParsed = JSON.parse(text);
      if (JSON.stringify(currentParsed) !== JSON.stringify(schema || {})) {
        setText(JSON.stringify(schema || {}, null, 2));
        setError(null);
      }
    } catch {
      // Keep raw user text when invalid
    }
  }, [schema]);

  const handleChange = (newVal: string) => {
    setText(newVal);
    try {
      const parsed = JSON.parse(newVal);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        setError(null);
        onChange(parsed as Record<string, unknown>);
      } else {
        setError(t('JSON 必须是对象格式', 'JSON must be an object'));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Invalid JSON format');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <textarea
        rows={6}
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        placeholder='{\n  "type": "object",\n  "properties": {}\n}'
        style={{
          fontFamily: 'monospace',
          fontSize: '11px',
          lineHeight: '1.4',
          borderColor: error ? 'var(--danger)' : undefined,
        }}
      />
      {error && (
        <div style={{ color: 'var(--danger)', fontSize: '11px', lineHeight: 1.3 }}>
          {error}
        </div>
      )}
    </div>
  );
}

interface PaletteItem {
  id: string;
  nameZh: string;
  nameEn: string;
  category: 'database' | 'cache' | 'api' | 'logic' | 'subflow';
  target_node_type: string;
  icon: string;
  descZh: string;
  descEn: string;
  defaultDynamicSchema: Record<string, unknown>;
  defaultFixedConfig: Record<string, unknown>;
}

const PROTOCOL_PALETTE: PaletteItem[] = [
  {
    id: 'db_query',
    nameZh: 'SQL 查询 (db:query)',
    nameEn: 'SQL Query (db:query)',
    category: 'database',
    target_node_type: 'db:query',
    icon: 'database',
    descZh: '执行 SQL 查询以检索数据行（支持 MySQL, PostgreSQL, SQLite）。',
    descEn: 'Execute SQL query to retrieve data rows (MySQL, PostgreSQL, SQLite).',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'Standard read-only SQL query statement' },
      },
      required: ['sql'],
    },
    defaultFixedConfig: { connection_uuid: '', timeout_ms: 5000 },
  },
  {
    id: 'mongo_find',
    nameZh: 'MongoDB 文档查询 (mongo:find)',
    nameEn: 'Mongo Find (mongo:find)',
    category: 'database',
    target_node_type: 'mongo:find',
    icon: 'database',
    descZh: '通过条件过滤与投影查询 MongoDB 集合文档。',
    descEn: 'Query MongoDB collection documents with filter criteria and projection.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        filter: { type: 'object', description: 'MongoDB query filter object' },
        limit: { type: 'number', description: 'Maximum number of documents to return' },
      },
      required: ['filter'],
    },
    defaultFixedConfig: { collection: '', connection_uuid: '' },
  },
  {
    id: 'redis_cmd',
    nameZh: 'Redis 命令 (redis:cmd)',
    nameEn: 'Redis Command (redis:cmd)',
    category: 'cache',
    target_node_type: 'redis:cmd',
    icon: 'zap',
    descZh: '执行 Redis 查询命令，如 GET, HGET, MGET, SCAN。',
    descEn: 'Execute Redis query commands such as GET, HGET, MGET, SCAN.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Redis command name (e.g. GET)' },
        key: { type: 'string', description: 'Target cache key' },
      },
      required: ['command', 'key'],
    },
    defaultFixedConfig: { connection_uuid: '' },
  },
  {
    id: 'http_request',
    nameZh: 'HTTP 网络请求 (http)',
    nameEn: 'HTTP Request (http)',
    category: 'api',
    target_node_type: 'http',
    icon: 'globe',
    descZh: '发送 HTTP/REST 请求以调用外部远程 API。',
    descEn: 'Send HTTP/REST request to invoke external remote APIs.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Target request URL' },
        query_params: { type: 'object', description: 'Query parameters object' },
      },
      required: ['url'],
    },
    defaultFixedConfig: { method: 'GET', timeout_ms: 10000 },
  },
  {
    id: 'grpc_call',
    nameZh: 'gRPC 远程调用 (grpc:call)',
    nameEn: 'gRPC Call (grpc:call)',
    category: 'api',
    target_node_type: 'grpc:call',
    icon: 'layers',
    descZh: '调用 gRPC Unary 服务方法并传入 JSON 请求报文。',
    descEn: 'Invoke gRPC Unary method with JSON request payload.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'Full method path (package.Service/Method)' },
        payload: { type: 'object', description: 'gRPC message payload object' },
      },
      required: ['method', 'payload'],
    },
    defaultFixedConfig: { connection_uuid: '' },
  },
  {
    id: 'script_exec',
    nameZh: '脚本执行 (script)',
    nameEn: 'Script (script)',
    category: 'logic',
    target_node_type: 'script',
    icon: 'code',
    descZh: '执行轻量脚本完成数据转换或复杂计算。',
    descEn: 'Execute lightweight script for data transformation or computation.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Script source code to execute' },
      },
      required: ['code'],
    },
    defaultFixedConfig: { engine: 'quickjs' },
  },
  {
    id: 'assertion_check',
    nameZh: '断言校验 (assertion)',
    nameEn: 'Assertion (assertion)',
    category: 'logic',
    target_node_type: 'assertion',
    icon: 'check',
    descZh: '基于规则表达式对前序数据进行断言与逻辑判定。',
    descEn: 'Evaluate assertion expression against runtime data.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Assertion rule expression' },
      },
      required: ['expression'],
    },
    defaultFixedConfig: {},
  },
  {
    id: 'subflow_exec',
    nameZh: '执行子流程 (subflow)',
    nameEn: 'Subflow (subflow)',
    category: 'subflow',
    target_node_type: 'subflow',
    icon: 'folder',
    descZh: '将独立的 .mpf 流程作为高阶工具执行并汇总输出。',
    descEn: 'Execute an independent .mpf subflow as a high-level tool.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        input_vars: { type: 'object', description: 'Input variables passed to the subflow' },
      },
    },
    defaultFixedConfig: { flow_path: '' },
  },
];

const DEFAULT_CONFIG: AgentReactConfig = {
  provider_uuid: '',
  provider: {
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model: 'gpt-4o',
    timeout_ms: 60000,
  },
  system_prompt:
    'You are an autonomous ReAct agent. Reason step by step, call available tools when necessary, observe results, self-correct if errors occur, and provide a clear final answer when done.',
  user_prompt: '',
  tools: [],
  max_iterations: 10,
  max_tool_calls_per_round: 5,
  temperature: 0.2,
  timeout_secs: 120,
  read_only_mode: false,
  stream: true,
};

function PanelApp() {
  const [config, setConfig] = useState<AgentReactConfig>(DEFAULT_CONFIG);
  const [availableNodes, setAvailableNodes] = useState<PluginIframeNodeSnapshot[]>([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('openai');
  const [showAddToolModal, setShowAddToolModal] = useState<boolean>(false);
  const [activePaletteTab, setActivePaletteTab] = useState<'palette' | 'canvas'>('palette');
  const [modelsList, setModelsList] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState<boolean>(false);
  const [testStatus, setTestStatus] = useState<{
    loading: boolean;
    success?: boolean;
    msg?: string;
  }>({ loading: false });

  useEffect(() => {
    const unbind = initBridge({
      onInit: (initialConfig, nodes) => {
        if (nodes) setAvailableNodes(nodes);
        if (initialConfig && Object.keys(initialConfig).length > 0) {
          const cfg = initialConfig as Partial<AgentReactConfig>;
          const provUuid = cfg.provider_uuid || '';
          let nextProv: LlmProviderConfig = {
            ...DEFAULT_CONFIG.provider,
            ...((cfg.provider as unknown as Record<string, unknown>) || {}),
          };
          if (provUuid && nodes && Array.isArray(nodes)) {
            const found = nodes.find((n) => n.uuid === provUuid && n.type === 'llm:provider');
            if (found && found.config) {
              const pConf = found.config as Record<string, unknown>;
              nextProv = {
                base_url: String(pConf.base_url || nextProv.base_url),
                api_key: String(pConf.api_key || nextProv.api_key || ''),
                model: String(pConf.model || nextProv.model),
                timeout_ms: typeof pConf.timeout_ms === 'number' ? pConf.timeout_ms : (nextProv.timeout_ms || 60000),
                custom_headers: (pConf.custom_headers as Record<string, string>) || nextProv.custom_headers,
              };
            }
          }
          setConfig((prev) => ({
            ...prev,
            ...cfg,
            provider_uuid: provUuid,
            provider: nextProv,
            tools: Array.isArray(cfg.tools)
              ? (cfg.tools as AgentToolDefinition[])
              : prev.tools,
          }));
        }
      },
      onConfigUpdated: (updatedConfig) => {
        if (updatedConfig && typeof updatedConfig === 'object') {
          setConfig((prev) => ({ ...prev, ...(updatedConfig as Partial<AgentReactConfig>) }));
        }
      },
    });
    return unbind;
  }, []);

  useEffect(() => {
    notifyConfig(config);
    postResize(document.body.scrollHeight || 750);
  }, [config, showAddToolModal]);
  const availableProviderNodes = useMemo(() => {
    return availableNodes.filter((n) => n.type === 'llm:provider');
  }, [availableNodes]);

  const canvasProtocolNodes = useMemo(() => {
    return availableNodes.filter((n) => n.type !== 'agent:react' && n.type !== 'llm:provider');
  }, [availableNodes]);

  const selectedProviderNode = useMemo(() => {
    if (!config.provider_uuid) return null;
    return availableProviderNodes.find((n) => n.uuid === config.provider_uuid) || null;
  }, [config.provider_uuid, availableProviderNodes]);

  const effectiveProvider = useMemo<LlmProviderConfig>(() => {
    if (config.provider_uuid && selectedProviderNode) {
      const pConf = (selectedProviderNode.config || {}) as Record<string, unknown>;
      const timeoutVal =
        typeof config.override_timeout_ms === 'number' && config.override_timeout_ms > 0
          ? config.override_timeout_ms
          : (typeof pConf.timeout_ms === 'number' ? pConf.timeout_ms : 60000);
      return {
        base_url: String(pConf.base_url || 'https://api.openai.com/v1'),
        api_key: pConf.api_key ? String(pConf.api_key) : '',
        model: String(config.override_model || pConf.model || 'gpt-4o'),
        timeout_ms: timeoutVal,
        custom_headers: (pConf.custom_headers as Record<string, string>) || undefined,
      };
    }
    return config.provider;
  }, [config.provider_uuid, selectedProviderNode, config.provider, config.override_model, config.override_timeout_ms]);

  const updateProvider = (field: keyof LlmProviderConfig, value: unknown) => {
    setConfig((prev) => ({
      ...prev,
      provider: {
        ...prev.provider,
        [field]: value,
      },
    }));
  };

  const handleProviderPresetChange = (presetKey: string) => {
    setSelectedPreset(presetKey);
    const preset = PROVIDER_PRESETS[presetKey];
    if (!preset) return;
    setConfig((prev) => ({
      ...prev,
      provider: {
        ...prev.provider,
        base_url: preset.base_url,
        model: preset.default_model || prev.provider.model || 'gpt-4o',
      },
    }));
  };

  const handleTestConnection = async (targetProvider?: LlmProviderConfig) => {
    const prov = targetProvider || effectiveProvider;
    setTestStatus({ loading: true });
    try {
      const res = (await uiCall('test_connection', {
        provider: prov,
      })) as { success: boolean; message?: string; error?: string; latency_ms?: number };
      if (res.success) {
        const latencyInfo = res.latency_ms ? ` (${res.latency_ms}ms)` : '';
        setTestStatus({
          loading: false,
          success: true,
          msg: res.message ? `${res.message}${latencyInfo}` : `${t('连接成功', 'Connected successfully')}${latencyInfo}`,
        });
      } else {
        setTestStatus({
          loading: false,
          success: false,
          msg: res.error || t('连接失败', 'Connection failed'),
        });
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      setTestStatus({
        loading: false,
        success: false,
        msg: errorMsg,
      });
    }
  };

  const handleFetchModels = async (targetProvider?: LlmProviderConfig) => {
    const prov = targetProvider || effectiveProvider;
    setLoadingModels(true);
    try {
      const res = (await uiCall('list_models', { provider: prov })) as {
        models: string[];
      };
      if (res && Array.isArray(res.models)) {
        setModelsList(res.models);
      }
    } catch (err: unknown) {
      alert(String(err instanceof Error ? err.message : err));
    } finally {
      setLoadingModels(false);
    }
  };

  const handleAddPaletteTool = (item: PaletteItem) => {
    const id = `${item.target_node_type.replace(/[:\-]/g, '_')}_${Date.now().toString(36).slice(-4)}`;
    const newTool: AgentToolDefinition = {
      id,
      name: id,
      description: t(item.descZh, item.descEn),
      tool_type: item.category === 'subflow' ? 'subflow' : 'standalone_action',
      target_node_type: item.target_node_type,
      fixed_config: { ...item.defaultFixedConfig },
      dynamic_schema: { ...item.defaultDynamicSchema },
    };

    setConfig((prev) => ({
      ...prev,
      tools: [...prev.tools, newTool],
    }));
    setShowAddToolModal(false);
  };

  const handleAddCanvasNodeTool = (node: PluginIframeNodeSnapshot) => {
    const rawLabel = (node.label || node.name || '').trim();
    const nodeName = rawLabel || `${node.type.replace(/[:\-]/g, '_')}_${node.uuid.slice(-4)}`;
    const sanitizedId = `${node.type.replace(/[:\-]/g, '_')}_${node.uuid.slice(-4)}`;
    const toolName = rawLabel ? rawLabel.replace(/\s+/g, '_') : sanitizedId;

    let defaultSchema: Record<string, unknown> = {
      type: 'object',
      properties: {},
    };

    if (node.type.startsWith('db:') || node.type === 'sql') {
      defaultSchema = {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL query statement' },
        },
        required: ['sql'],
      };
    } else if (node.type.startsWith('redis:')) {
      defaultSchema = {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Redis command name (e.g. GET)' },
          key: { type: 'string', description: 'Target cache key' },
        },
        required: ['command', 'key'],
      };
    } else if (node.type.startsWith('http')) {
      defaultSchema = {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path or endpoint' },
          query_params: { type: 'object', description: 'Query parameters' },
        },
      };
    } else if (node.type === 'llm:chat') {
      defaultSchema = {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'User message to send to the LLM chat node' },
        },
        required: ['message'],
      };
    }

    const newTool: AgentToolDefinition = {
      id: sanitizedId,
      name: toolName,
      description: `Call canvas node '${nodeName}' (${node.type})`,
      tool_type: 'linked_node',
      target_node_type: node.type,
      target_node_id: node.uuid,
      fixed_config: node.config ? { ...node.config } : {},
      dynamic_schema: defaultSchema,
    };

    setConfig((prev) => ({
      ...prev,
      tools: [...prev.tools, newTool],
    }));
    setShowAddToolModal(false);
  };

  const handleUpdateTool = (index: number, patch: Partial<AgentToolDefinition>) => {
    setConfig((prev) => {
      const nextTools = [...prev.tools];
      nextTools[index] = { ...nextTools[index], ...patch };
      return { ...prev, tools: nextTools };
    });
  };

  const handleDeleteTool = (index: number) => {
    setConfig((prev) => ({
      ...prev,
      tools: prev.tools.filter((_, i) => i !== index),
    }));
  };

  return (
    <div className="panel">
      {/* 1. LLM Provider Configuration */}
      <div className="card">
        <div className="card-title">
          <IconBot size={16} />
          {t('大模型服务商配置 (LLM Provider)', 'LLM Provider Configuration')}
        </div>

        {/* Provider Source Selection */}
        <div className="col">
          <label>{t('服务商来源 (Provider Source)', 'Provider Source')}</label>
          <select
            value={config.provider_uuid || '__custom__'}
            onChange={(e) => {
              const val = e.target.value;
              const isCustom = val === '__custom__' || !val;
              const newUuid = isCustom ? '' : val;
              const targetNode = availableProviderNodes.find((n) => n.uuid === newUuid);
              setTestStatus({ loading: false });
              setConfig((prev) => {
                let nextProvider = prev.provider;
                if (targetNode && targetNode.config) {
                  const pConf = targetNode.config as Record<string, unknown>;
                  nextProvider = {
                    base_url: String(pConf.base_url || 'https://api.openai.com/v1'),
                    api_key: pConf.api_key ? String(pConf.api_key) : '',
                    model: String(pConf.model || 'gpt-4o'),
                    timeout_ms: typeof pConf.timeout_ms === 'number' ? pConf.timeout_ms : 60000,
                    custom_headers: (pConf.custom_headers as Record<string, string>) || undefined,
                  };
                }
                return {
                  ...prev,
                  provider_uuid: newUuid,
                  provider: nextProvider,
                };
              });
            }}
          >
            <option value="__custom__">{t('自定义服务商配置 (Custom Provider)', 'Custom Provider Configuration')}</option>
            {availableProviderNodes.map((n) => (
              <option key={n.uuid} value={n.uuid}>
                {n.label || n.name || n.uuid} (llm:provider)
              </option>
            ))}
          </select>
        </div>

        {/* If Linked Provider is selected */}
        {config.provider_uuid ? (
          selectedProviderNode ? (
            <div
              style={{
                padding: '12px',
                borderRadius: '6px',
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="row" style={{ gap: '6px' }}>
                  <IconLink size={14} style={{ color: 'var(--accent)' }} />
                  <strong style={{ fontSize: '13px' }}>{selectedProviderNode.label || selectedProviderNode.name || selectedProviderNode.uuid}</strong>
                  <span className="badge badge-ok">{t('已关联', 'Linked')}</span>
                </div>
              </div>

              <div style={{ fontSize: '12px', color: 'var(--fg-muted)', lineHeight: 1.6 }}>
                <div>
                  <strong>{t('Base URL:', 'Base URL:')}</strong>{' '}
                  <span className="mono">{String(selectedProviderNode.config?.base_url || 'https://api.openai.com/v1')}</span>
                </div>
                <div>
                  <strong>{t('默认模型:', 'Default Model:')}</strong>{' '}
                  <span className="mono">{String(selectedProviderNode.config?.model || 'gpt-4o')}</span>
                </div>
                <div>
                  <strong>{t('继承超时时间 (ms):', 'Inherited Timeout (ms):')}</strong>{' '}
                  <span className="mono">
                    {String(selectedProviderNode.config?.timeout_ms || 60000)} ms
                  </span>
                </div>
                <div>
                  <strong>{t('API 密钥:', 'API Key:')}</strong>{' '}
                  <span className="mono">
                    {effectiveProvider.api_key && effectiveProvider.api_key.trim()
                      ? `${effectiveProvider.api_key.slice(0, 4)}••••${effectiveProvider.api_key.slice(-4)}`
                      : <span style={{ color: 'var(--danger)' }}>{t('未配置 (Missing)', 'Not configured (Missing)')}</span>}
                  </span>
                </div>
              </div>

              {(!effectiveProvider.api_key || !effectiveProvider.api_key.trim()) && (
                <div
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    background: 'var(--danger-soft)',
                    color: 'var(--danger)',
                  }}
                >
                  {t('⚠️ 关联的服务商节点未填写 API Key，请在对应的 LLM Provider 节点中输入 API 密钥，或在下方输入临时密钥。', '⚠️ The linked Provider node has no API Key configured. Please configure API Key in the LLM Provider node or specify one below.')}
                </div>
              )}
              <div className="col" style={{ marginTop: '2px' }}>
                <label className="row" style={{ gap: '4px', fontSize: '12px', margin: 0 }}>
                  <IconSparkles size={12} />
                  <span>{t('覆盖模型名称 (可选，留空则使用服务商默认模型)', 'Override Model (Optional)')}</span>
                </label>
                {modelsList.length > 0 ? (
                  <select
                    value={config.override_model || ''}
                    onChange={(e) => setConfig((prev) => ({ ...prev, override_model: e.target.value }))}
                  >
                    <option value="">{t('-- 使用服务商默认模型 --', '-- Use Provider Default Model --')} ({String(selectedProviderNode.config?.model || 'gpt-4o')})</option>
                    {modelsList.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={config.override_model || ''}
                    onChange={(e) => setConfig((prev) => ({ ...prev, override_model: e.target.value }))}
                    placeholder={String(selectedProviderNode.config?.model || 'gpt-4o')}
                  />
                )}
              </div>
              <div className="col" style={{ marginTop: '2px' }}>
                <label className="row" style={{ gap: '4px', fontSize: '12px', margin: 0 }}>
                  <IconClock size={12} />
                  <span>{t('覆盖超时时间 (可选，留空则继承服务商超时)', 'Override Timeout ms (Optional)')}</span>
                </label>
                <input
                  type="number"
                  value={typeof config.override_timeout_ms === 'number' ? config.override_timeout_ms : ''}
                  onChange={(e) => {
                    const val = e.target.value === '' ? undefined : parseInt(e.target.value, 10);
                    setConfig((prev) => ({ ...prev, override_timeout_ms: val }));
                  }}
                  placeholder={
                    selectedProviderNode.config?.timeout_ms
                      ? t(`如: ${selectedProviderNode.config.timeout_ms}`, `e.g. ${selectedProviderNode.config.timeout_ms}`)
                      : '60000'
                  }
                />
              </div>
              <div className="row" style={{ gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => handleFetchModels(effectiveProvider)}
                  disabled={loadingModels}
                >
                  {loadingModels ? t('拉取中...', 'Fetching...') : t('获取模型列表', 'Fetch Models')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => handleTestConnection(effectiveProvider)}
                  disabled={testStatus.loading}
                >
                  <IconZap size={12} />
                  {testStatus.loading ? t('测试中...', 'Testing...') : t('测试连接', 'Test Connection')}
                </button>
              </div>
              {testStatus.msg && (
                <div
                  style={{
                    padding: '6px 10px',
                    borderRadius: '4px',
                    fontSize: '12px',
                    background: testStatus.success ? 'var(--ok-soft)' : 'var(--danger-soft)',
                    color: testStatus.success ? 'var(--ok)' : 'var(--danger)',
                  }}
                >
                  {testStatus.msg}
                </div>
              )}
            </div>
          ) : (
            <div
              style={{
                padding: '10px 12px',
                borderRadius: '6px',
                background: 'var(--danger-soft)',
                color: 'var(--danger)',
                fontSize: '12px',
              }}
            >
              {t('未在当前画布找到关联的 Provider 节点，请检查节点是否存在或重新选择来源。', 'Referenced Provider node not found on canvas; please check or reselect source.')}
            </div>
          )
        ) : (
          /* Custom Inline Provider Settings (Aligned with llm:provider style) */
          <>
            {/* Presets dropdown */}
            <div className="col">
              <label>{t('服务商预设 (Provider Preset)', 'Provider Preset')}</label>
              <select
                value={selectedPreset}
                onChange={(e) => handleProviderPresetChange(e.target.value)}
              >
                {Object.entries(PROVIDER_PRESETS).map(([key, preset]) => (
                  <option key={key} value={key}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="row">
              <div className="col" style={{ flex: 1.5 }}>
                <label className="row" style={{ gap: '4px' }}>
                  <IconGlobe size={13} />
                  <span>{t('API 基础地址 (Base URL)', 'Base URL')}</span>
                </label>
                <input
                  type="text"
                  value={config.provider.base_url}
                  onChange={(e) => updateProvider('base_url', e.target.value)}
                  placeholder="https://api.openai.com/v1"
                />
              </div>

              <div className="col" style={{ flex: 1.5 }}>
                <label className="row" style={{ gap: '4px' }}>
                  <IconKey size={13} />
                  <span>{t('API 密钥 (API Key)', 'API Key')}</span>
                </label>
                <input
                  type="password"
                  value={config.provider.api_key || ''}
                  onChange={(e) => updateProvider('api_key', e.target.value)}
                  placeholder="sk-..."
                />
              </div>
            </div>

            <div className="col">
              <label className="row" style={{ gap: '4px', margin: 0 }}>
                <IconSparkles size={13} />
                <span>{t('模型名称 (Model Name)', 'Model Name')}</span>
              </label>
              {modelsList.length > 0 ? (
                <select
                  value={config.provider.model}
                  onChange={(e) => updateProvider('model', e.target.value)}
                >
                  {modelsList.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={config.provider.model}
                  onChange={(e) => updateProvider('model', e.target.value)}
                  placeholder="gpt-4o, deepseek-chat, qwen-plus..."
                />
              )}

              <div className="row" style={{ gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => handleFetchModels(config.provider)}
                  disabled={loadingModels}
                >
                  {loadingModels ? t('拉取中...', 'Fetching...') : t('获取模型列表', 'Fetch Models')}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() => handleTestConnection(config.provider)}
                  disabled={testStatus.loading}
                >
                  <IconZap size={12} />
                  {testStatus.loading ? t('测试中...', 'Testing...') : t('测试连接', 'Test Connection')}
                </button>
              </div>
            </div>

            <div className="col">
              <label className="row" style={{ gap: '4px' }}>
                <IconClock size={13} />
                <span>{t('请求超时 (Timeout ms)', 'Timeout (ms)')}</span>
              </label>
              <input
                type="number"
                value={typeof config.provider.timeout_ms === 'number' ? config.provider.timeout_ms : ''}
                placeholder="60000"
                onChange={(e) => {
                  const val = e.target.value === '' ? 60000 : parseInt(e.target.value, 10) || 60000;
                  updateProvider('timeout_ms', val);
                }}
              />
            </div>

            {testStatus.msg && (
              <div
                style={{
                  padding: '6px 10px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  background: testStatus.success ? 'var(--ok-soft)' : 'var(--danger-soft)',
                  color: testStatus.success ? 'var(--ok)' : 'var(--danger)',
                }}
              >
                {testStatus.msg}
              </div>
            )}
          </>
        )}
      </div>

      {/* 2. Prompts Configuration (System Prompt & User Goal) */}
      <div className="card">
        <div className="card-title">
          <IconBrain size={16} />
          {t('提示词设定 (Prompts Configuration)', 'Prompts Configuration')}
        </div>

        {/* System Prompt (Persona, Constraints & Principles) */}
        <div className="col">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <label style={{ fontWeight: 600, color: 'var(--fg)', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <IconBot size={14} style={{ color: 'var(--accent)' }} />
              {t('系统提示词 (System Prompt - 人设与行动准则)', 'System Prompt - Role & Principles')}
            </label>
            <select
              style={{ width: 'auto', minWidth: '180px', maxWidth: '240px', fontSize: '11px', padding: '2px 8px' }}
              value=""
              onChange={(e) => {
                const key = e.target.value;
                if (!key) return;
                const tpl = SYSTEM_PROMPT_TEMPLATES[key];
                if (tpl) {
                  setConfig((prev) => ({
                    ...prev,
                    system_prompt: t(tpl.promptZh, tpl.promptEn),
                  }));
                }
              }}
            >
              <option value="">{t('选择内置模板...', 'Select built-in template...')}</option>
              {Object.entries(SYSTEM_PROMPT_TEMPLATES).map(([key, tpl]) => (
                <option key={key} value={key}>
                  {t(tpl.labelZh, tpl.labelEn)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
            {t(
              '定义 Agent 的专业身份、决策逻辑、安全准则及何时调用工具（全局指导原则）。',
              'Defines agent persona, expertise domain, constraints, and tool usage strategy.'
            )}
          </div>
          <textarea
            rows={4}
            value={config.system_prompt}
            onChange={(e) => setConfig((prev) => ({ ...prev, system_prompt: e.target.value }))}
            placeholder="Define the persona, role, and constraints..."
          />
        </div>

        {/* User Goal Prompt (Execution Objective & Input Variables) */}
        <div className="col" style={{ marginTop: '6px' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <label style={{ fontWeight: 600, color: 'var(--fg)', margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <IconSparkles size={14} style={{ color: 'var(--accent)' }} />
              <span>{t('本次目标提示词 (User Goal Prompt - 具体执行任务)', 'User Goal Prompt - Task Objective')}</span>
              <span className="req" style={{ color: 'var(--danger)' }}>*</span>
            </label>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
            {t(
              '本次流程执行时需要 Agent 解决的具体目标，支持使用 {{steps.x.output}} 插值变量。',
              'The specific problem or task for this execution, supports {{steps.x.output}} variable interpolation.'
            )}
          </div>
          <textarea
            rows={3}
            value={config.user_prompt}
            onChange={(e) => setConfig((prev) => ({ ...prev, user_prompt: e.target.value }))}
            placeholder="e.g. Please troubleshoot order latency and deadlock: {{steps.http_ingress.output.body}}"
          />
        </div>
      </div>

      {/* 3. Tool Management & Node Palette */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="card-title">
              <IconWrench size={16} />
              {t('注册工具库 (Registered Tools)', 'Registered Tools')} ({config.tools.length})
            </div>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginTop: '2px' }}>
              {t(
                '工具是大模型与异构协议交互的桥梁，模型会根据动态 Schema 构造参数调用。',
                'Tools bridge LLM reasoning to heterogeneous protocols via dynamic parameter schemas.'
              )}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowAddToolModal(true)}
          >
            <IconPlus size={14} />
            {t('添加工具 / 协议节点', 'Add Tool / Protocol Node')}
          </button>
        </div>

        {/* Modal / Palette for Adding Tool */}
        {showAddToolModal && (
          <div
            style={{
              marginTop: '10px',
              padding: '14px',
              borderRadius: '8px',
              background: 'var(--bg)',
              border: '2px solid var(--accent)',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                <IconLayers size={16} style={{ color: 'var(--accent)' }} />
                {t('选择工具来源与协议节点', 'Select Tool Source & Protocol Node')}
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowAddToolModal(false)}
              >
                <IconX size={12} />
              </button>
            </div>

            <div className="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`btn btn-sm ${activePaletteTab === 'palette' ? 'btn-primary' : ''}`}
                style={{ flex: '1 1 auto', minWidth: '130px', justifyContent: 'center' }}
                onClick={() => setActivePaletteTab('palette')}
              >
                <IconZap size={12} />
                {t('标准协议动作库 (Protocol Actions)', 'Standard Actions')}
              </button>
              <button
                type="button"
                className={`btn btn-sm ${activePaletteTab === 'canvas' ? 'btn-primary' : ''}`}
                style={{ flex: '1 1 auto', minWidth: '130px', justifyContent: 'center' }}
                onClick={() => setActivePaletteTab('canvas')}
              >
                <IconLink size={12} />
                {t('从画布已有节点导入 (From Canvas Nodes)', 'Import From Canvas')} ({canvasProtocolNodes.length})
              </button>
            </div>

            {activePaletteTab === 'palette' ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: '8px',
                  maxHeight: '260px',
                  overflowY: 'auto',
                }}
              >
                {PROTOCOL_PALETTE.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => handleAddPaletteTool(item)}
                    style={{
                      padding: '10px',
                      borderRadius: '6px',
                      border: '1px solid var(--border)',
                      background: 'var(--bg-subtle)',
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '4px',
                      transition: 'border-color 0.15s, background 0.15s',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--accent)';
                      e.currentTarget.style.background = 'var(--accent-soft)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--border)';
                      e.currentTarget.style.background = 'var(--bg-subtle)';
                    }}
                  >
                    <div className="row" style={{ justifyContent: 'space-between' }}>
                      <strong style={{ fontSize: '12px' }}>{t(item.nameZh, item.nameEn)}</strong>
                      <span className="badge badge-accent" style={{ fontSize: '10px' }}>
                        {item.target_node_type}
                      </span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--fg-muted)', lineHeight: 1.4 }}>
                      {t(item.descZh, item.descEn)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  maxHeight: '260px',
                  overflowY: 'auto',
                }}
              >
                {canvasProtocolNodes.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '16px', color: 'var(--fg-muted)', fontSize: '12px' }}>
                    {t(
                      '画布上暂无其他业务协议节点（如 DB/Redis/HTTP/gRPC 等）。请在画布中添加相应节点后再来引用，或者直接使用上方标准协议动作。',
                      'No business protocol nodes on canvas yet. Add nodes to canvas first, or use standard protocol actions.'
                    )}
                  </div>
                ) : (
                  canvasProtocolNodes.map((node) => (
                    <div
                      key={node.uuid}
                      onClick={() => handleAddCanvasNodeTool(node)}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-subtle)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.borderColor = 'var(--accent)';
                        e.currentTarget.style.background = 'var(--accent-soft)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.borderColor = 'var(--border)';
                        e.currentTarget.style.background = 'var(--bg-subtle)';
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                        }}
                      >
                        <IconLink size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                        <strong
                          style={{
                            fontSize: '12px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {node.label || node.name || node.uuid}
                        </strong>
                        <span className="badge badge-accent" style={{ fontSize: '10px', flexShrink: 0 }}>
                          {node.type}
                        </span>
                      </div>
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        style={{ flexShrink: 0, marginLeft: 'auto', whiteSpace: 'nowrap' }}
                      >
                        + {t('导入为工具', 'Import as Tool')}
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {/* Tool Items List */}
        {config.tools.length === 0 ? (
          <div
            style={{
              padding: '24px',
              textAlign: 'center',
              color: 'var(--fg-muted)',
              fontSize: '12px',
              border: '1px dashed var(--border)',
              borderRadius: '8px',
            }}
          >
            {t(
              '尚未注册任何工具。点击右上角 "+ 添加工具 / 协议节点" 从标准协议动作库添加或直接引用画布已有节点。',
              'No tools registered yet. Click "+ Add Tool / Protocol Node" above to add tools or link canvas nodes.'
            )}
          </div>
        ) : (
          config.tools.map((tool, idx) => (
            <div
              key={tool.id || idx}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '12px',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '8px',
                  flexWrap: 'wrap',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    flex: 1,
                    minWidth: 0,
                    flexWrap: 'wrap',
                  }}
                >
                  <span className="badge badge-accent" style={{ fontSize: '11px', flexShrink: 0 }}>
                    {tool.target_node_type}
                  </span>
                  <input
                    type="text"
                    style={{ flex: 1, minWidth: '140px', maxWidth: '260px', fontWeight: 600, fontSize: '13px' }}
                    value={tool.name}
                    onChange={(e) => handleUpdateTool(idx, { name: e.target.value })}
                    placeholder="Tool Function Name"
                  />
                  <span
                    style={{
                      fontSize: '11px',
                      color: 'var(--fg-muted)',
                      background: 'var(--bg-muted)',
                      padding: '2px 6px',
                      borderRadius: '4px',
                      flexShrink: 0,
                    }}
                  >
                    {tool.tool_type === 'linked_node'
                      ? t('引用画布节点', 'Linked Node')
                      : tool.tool_type === 'subflow'
                      ? t('子流程', 'Subflow')
                      : t('独立动作', 'Standalone Action')}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  style={{ flexShrink: 0, marginLeft: 'auto' }}
                  onClick={() => handleDeleteTool(idx)}
                  title={t('删除工具', 'Delete Tool')}
                >
                  <IconTrash size={12} />
                </button>
              </div>
              <div className="col">
                <label>{t('工具描述 (供大模型推理与决策理解)', 'Tool Description for LLM')}</label>
                <textarea
                  rows={2}
                  value={tool.description}
                  onChange={(e) => handleUpdateTool(idx, { description: e.target.value })}
                  placeholder={t(
                    '详细描述该工具的功能、应用场景及大模型调用时机...',
                    'Describe what this tool does and when the model should call it...'
                  )}
                />
              </div>

              {/* Subflow Flow Path Configuration */}
              {(tool.tool_type === 'subflow' || tool.target_node_type === 'subflow') && (
                <div className="col">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <IconFolder size={13} />
                    <span>{t('子流程文件路径 (.mpf)', 'Subflow File Path (.mpf)')}</span>
                  </label>
                  <input
                    type="text"
                    value={String(tool.fixed_config?.flow_path || '')}
                    onChange={(e) =>
                      handleUpdateTool(idx, {
                        fixed_config: {
                          ...(tool.fixed_config || {}),
                          flow_path: e.target.value,
                        },
                      })
                    }
                    placeholder="e.g. flows/order_troubleshoot.mpf"
                  />
                </div>
              )}
              {/* Dynamic Parameter Schema (Raw JSON) */}
              <div
                style={{
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  padding: '10px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong style={{ fontSize: '12px' }}>
                      {t('动态入参 Schema (Dynamic Parameters)', 'Dynamic Parameters Schema')}
                    </strong>
                    <div style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                      {t(
                        '定义大模型调用该工具时需要构造并填入的入参字段 (JSON Schema)。',
                        'Defines the JSON Schema for parameters LLM must provide when calling this tool.'
                      )}
                    </div>
                  </div>
                </div>

                <ToolSchemaEditor
                  schema={tool.dynamic_schema || {}}
                  onChange={(newSchema) => handleUpdateTool(idx, { dynamic_schema: newSchema })}
                />
              </div>
            </div>
          ))
        )}
      </div>

      {/* 4. Safety Controls & Guardrails (Stacked in 5 clear rows) */}
      <div className="card">
        <div className="card-title">
          <IconShield size={16} />
          {t('安全护栏与收敛控制 (Safety Controls & Guardrails)', 'Safety Controls & Guardrails')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '4px' }}>
          {/* Row 1: Max Iterations */}
          <div className="col">
            <label style={{ fontWeight: 600, color: 'var(--fg)' }}>
              {t('最大思考迭代轮数 (Max Iterations)', 'Max Reasoning Iterations')}
            </label>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
              {t(
                '单次流程执行中 Agent 允许进行思考与工具调用的最大轮数上限（默认 10 轮），防止复杂或不可收敛任务死循环。',
                'Maximum number of reasoning rounds allowed per execution (default: 10) to prevent infinite loops.'
              )}
            </div>
            <input
              type="number"
              min={1}
              max={50}
              value={config.max_iterations}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  max_iterations: parseInt(e.target.value, 10) || 10,
                }))
              }
            />
          </div>

          {/* Row 2: Max Tool Calls Per Round */}
          <div className="col">
            <label style={{ fontWeight: 600, color: 'var(--fg)' }}>
              {t('单轮最大工具调用数 (Max Tool Calls Per Round)', 'Max Tool Calls Per Round')}
            </label>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
              {t(
                '限制大模型在单轮思考中并发调用的工具数量上限（默认 5 个）。',
                'Maximum number of parallel tool calls allowed in a single reasoning step (default: 5).'
              )}
            </div>
            <input
              type="number"
              min={1}
              max={20}
              value={config.max_tool_calls_per_round}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  max_tool_calls_per_round: parseInt(e.target.value, 10) || 5,
                }))
              }
            />
          </div>

          {/* Row 3: Temperature */}
          <div className="col">
            <label style={{ fontWeight: 600, color: 'var(--fg)' }}>
              {t('模型采样温度 (Sampling Temperature)', 'Model Sampling Temperature')}
            </label>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
              {t(
                '推理采样随机性（0.0 ~ 2.0，默认 0.2）。建议设置较低温度以保障严谨的逻辑推理与精准的工具入参格式。',
                'Sampling randomness (0.0 - 2.0, default: 0.2). Lower temperature ensures deterministic tool calling logic.'
              )}
            </div>
            <input
              type="number"
              step={0.1}
              min={0}
              max={2}
              value={config.temperature}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  temperature: parseFloat(e.target.value) || 0.2,
                }))
              }
            />
          </div>

          {/* Row 4: Timeout */}
          <div className="col">
            <label style={{ fontWeight: 600, color: 'var(--fg)' }}>
              {t('全局执行硬超时 (Timeout Seconds)', 'Hard Execution Timeout (Seconds)')}
            </label>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
              {t(
                'Agent 整个 ReAct 思考与工具调用生命周期的总硬超时保护（默认 120 秒）。',
                'Overall timeout deadline for the entire ReAct loop (default: 120s).'
              )}
            </div>
            <input
              type="number"
              min={10}
              max={3600}
              value={config.timeout_secs}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  timeout_secs: parseInt(e.target.value, 10) || 120,
                }))
              }
            />
          </div>

          {/* Row 5: Read-Only Security Guardrails Mode */}
          <div
            style={{
              padding: '12px',
              borderRadius: '6px',
              background: config.read_only_mode ? 'var(--ok-soft)' : 'var(--bg-subtle)',
              border: `1px solid ${config.read_only_mode ? 'var(--ok)' : 'var(--border)'}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
            }}
          >
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                fontWeight: 600,
                fontSize: '13px',
                color: 'var(--fg)',
              }}
            >
              <input
                type="checkbox"
                checked={config.read_only_mode}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, read_only_mode: e.target.checked }))
                }
              />
              <IconShield size={16} style={{ color: config.read_only_mode ? 'var(--ok)' : 'var(--fg-muted)' }} />
              <span>
                {t('开启只读安全保护模式 (Read-Only Security Guardrails)', 'Enable Read-Only Security Guardrails')}
              </span>
            </label>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginLeft: '24px' }}>
              {t(
                '在工具派发执行前进行静态语法与意图审计：严格拦截写 SQL (INSERT / UPDATE / DELETE / DROP / ALTER / TRUNCATE)、写 Redis 命令 (SET / DEL / HSET / FLUSHDB 等) 以及非幂等 HTTP 方法 (POST / PUT / DELETE / PATCH)。',
                'Audits tool execution before dispatch: strictly blocks mutating SQL, Redis writes, and mutating HTTP methods.'
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<PanelApp />);
