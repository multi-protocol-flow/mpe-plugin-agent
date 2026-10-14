import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  browseMpeDatasource,
  getRegisteredNodes,
  initBridge,
  listMpeDatasources,
  notifyConfig,
  postResize,
  uiCall,
} from './bridge';
import { t } from './i18n';
import {
  IconBot,
  IconBraces,
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
  MpeDatasourceConnection,
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
    id: 'redis_command',
    nameZh: 'Redis 命令 (redis:command)',
    nameEn: 'Redis Command (redis:command)',
    category: 'cache',
    target_node_type: 'redis:command',
    icon: 'zap',
    descZh: '执行 Redis 查询命令，如 GET, HGET, MGET, SCAN。',
    descEn: 'Execute Redis query commands such as GET, HGET, MGET, SCAN.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Redis command name (e.g. GET)' },
        args: { type: 'string', description: 'JSON array of command arguments, e.g. ["key"]' },
      },
      required: ['command'],
    },
    defaultFixedConfig: { connection_uuid: '' },
  },
  {
    id: 'http_request',
    nameZh: 'HTTP 网络请求 (http:request)',
    nameEn: 'HTTP Request (http:request)',
    category: 'api',
    target_node_type: 'http:request',
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
    nameZh: '执行子流程 (flow:sub)',
    nameEn: 'Subflow (flow:sub)',
    category: 'subflow',
    target_node_type: 'flow:sub',
    icon: 'folder',
    descZh: '将独立的 .mpf 流程作为高阶工具执行并汇总输出。',
    descEn: 'Execute an independent .mpf subflow as a high-level tool.',
    defaultDynamicSchema: {
      type: 'object',
      properties: {
        input_vars: { type: 'object', description: 'Input variables passed to the subflow' },
      },
    },
    defaultFixedConfig: { target_flow_path: '' },
  },
];
const DATASOURCE_DEMO_PRESETS: Record<
  string,
  {
    nameZh: string;
    nameEn: string;
    type: string;
    defaultBaseUrl: string;
    items: Array<{
      id: string;
      name: string;
      method: string;
      path: string;
      summary: string;
      raw: Record<string, unknown>;
    }>;
  }
> = {
  petstore_openapi: {
    nameZh: 'Swagger Petstore (OpenAPI v3)',
    nameEn: 'Swagger Petstore (OpenAPI v3)',
    type: 'openapi',
    defaultBaseUrl: 'https://petstore.swagger.io/v2',
    items: [
      {
        id: 'get_pet_by_id',
        name: 'Find pet by ID',
        method: 'GET',
        path: '/pet/{petId}',
        summary: 'Returns a single pet by ID',
        raw: {
          path: '/pet/{petId}',
          method: 'get',
          operation_id: 'getPetById',
          summary: 'Find pet by ID',
          parameters: [
            { name: 'petId', in: 'path', required: true, description: 'ID of pet to return', schema: { type: 'integer' } },
          ],
        },
      },
      {
        id: 'add_new_pet',
        name: 'Add a new pet',
        method: 'POST',
        path: '/pet',
        summary: 'Add a new pet to the store inventory',
        raw: {
          path: '/pet',
          method: 'post',
          operation_id: 'addPet',
          summary: 'Add a new pet to the store inventory',
          request_body: {
            required: true,
            schema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Pet name' },
                status: { type: 'string', description: 'Pet status in the store', enum: ['available', 'pending', 'sold'] },
              },
              required: ['name'],
            },
          },
        },
      },
      {
        id: 'get_inventory',
        name: 'Returns pet inventories by status',
        method: 'GET',
        path: '/store/inventory',
        summary: 'Returns a map of status codes to quantities',
        raw: {
          path: '/store/inventory',
          method: 'get',
          operation_id: 'getInventory',
          summary: 'Returns a map of status codes to quantities',
          parameters: [],
        },
      },
      {
        id: 'delete_pet',
        name: 'Deletes a pet',
        method: 'DELETE',
        path: '/pet/{petId}',
        summary: 'Deletes a pet from inventory',
        raw: {
          path: '/pet/{petId}',
          method: 'delete',
          operation_id: 'deletePet',
          summary: 'Deletes a pet from inventory',
          parameters: [
            { name: 'petId', in: 'path', required: true, description: 'Pet ID to delete', schema: { type: 'integer' } },
          ],
        },
      },
    ],
  },
  order_service_openapi: {
    nameZh: '订单与支付系统 API (Order & Payment OpenAPI)',
    nameEn: 'Order & Payment Service (OpenAPI v3)',
    type: 'openapi',
    defaultBaseUrl: 'https://api.orders.example.com',
    items: [
      {
        id: 'get_order_by_id',
        name: 'Query order details',
        method: 'GET',
        path: '/orders/{order_id}',
        summary: 'Query detailed status and items for an order',
        raw: {
          path: '/orders/{order_id}',
          method: 'get',
          operation_id: 'getOrderDetails',
          summary: 'Query detailed status and items for an order',
          parameters: [
            { name: 'order_id', in: 'path', required: true, description: 'Order tracking ID', schema: { type: 'string' } },
          ],
        },
      },
      {
        id: 'create_order',
        name: 'Create a new order',
        method: 'POST',
        path: '/orders',
        summary: 'Submit a new purchase order',
        raw: {
          path: '/orders',
          method: 'post',
          operation_id: 'createOrder',
          summary: 'Submit a new purchase order',
          request_body: {
            required: true,
            schema: {
              type: 'object',
              properties: {
                user_id: { type: 'string', description: 'Customer identifier' },
                item_sku: { type: 'string', description: 'Product SKU code' },
                quantity: { type: 'integer', description: 'Number of items' },
              },
              required: ['user_id', 'item_sku', 'quantity'],
            },
          },
        },
      },
      {
        id: 'charge_payment',
        name: 'Charge payment gateway',
        method: 'POST',
        path: '/payments/charge',
        summary: 'Process payment authorization and capture',
        raw: {
          path: '/payments/charge',
          method: 'post',
          operation_id: 'chargePayment',
          summary: 'Process payment authorization and capture',
          request_body: {
            required: true,
            schema: {
              type: 'object',
              properties: {
                order_id: { type: 'string', description: 'Target order ID' },
                amount: { type: 'number', description: 'Total charge amount' },
                currency: { type: 'string', enum: ['USD', 'CNY', 'EUR'], description: 'ISO Currency code' },
              },
              required: ['order_id', 'amount'],
            },
          },
        },
      },
    ],
  },
};

const STRUCTURED_OUTPUT_PRESETS: Record<
  string,
  { labelZh: string; labelEn: string; schema: Record<string, unknown> }
> = {
  sre_diagnosis: {
    labelZh: 'SRE 故障根因诊断 (SRE Diagnosis)',
    labelEn: 'SRE Root Cause Diagnosis',
    schema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['P0', 'P1', 'P2', 'P3'],
          description: '故障严重程度等级',
        },
        root_cause: {
          type: 'string',
          description: '系统异常根因诊断分析结论',
        },
        auto_fixed: {
          type: 'boolean',
          description: '是否已通过自治工具尝试完成修复',
        },
        recommendation: {
          type: 'string',
          description: '运维工程师后续跟进与防御建议',
        },
      },
      required: ['severity', 'root_cause', 'auto_fixed', 'recommendation'],
    },
  },
  api_test_eval: {
    labelZh: 'API 自动化测试评估 (API Test Evaluation)',
    labelEn: 'API Test Evaluation',
    schema: {
      type: 'object',
      properties: {
        pass: {
          type: 'boolean',
          description: '全流程接口测试评估是否通过',
        },
        total_checked: {
          type: 'integer',
          description: '执行校验的接口/断言项总数',
        },
        failed_assertions: {
          type: 'array',
          items: { type: 'string' },
          description: '未通过的断言或错误信息列表',
        },
        summary: {
          type: 'string',
          description: '本次自动化测试执行评估总结',
        },
      },
      required: ['pass', 'total_checked', 'failed_assertions', 'summary'],
    },
  },
  metric_extract: {
    labelZh: '业务指标数据提炼 (Metric Extraction)',
    labelEn: 'Metric Extraction',
    schema: {
      type: 'object',
      properties: {
        metric_name: {
          type: 'string',
          description: '提取的业务核心度量指标标识',
        },
        value: {
          type: 'number',
          description: '当前计算或查询得到的最新指标数值',
        },
        trend: {
          type: 'string',
          enum: ['up', 'down', 'stable'],
          description: '相较历史或预期的指标趋势',
        },
        confidence: {
          type: 'number',
          description: '推断置信度评分 (0.0 到 1.0)',
        },
      },
      required: ['metric_name', 'value', 'trend', 'confidence'],
    },
  },
};

function inferToolFromCanvasNode(node: PluginIframeNodeSnapshot): AgentToolDefinition {
  const rawLabel = (node.label || node.name || '').trim();
  const nodeType = node.type || '';
  const nodeCfg = (node.config || {}) as Record<string, unknown>;
  const basePrefix = nodeType.replace(/[:\-]/g, '_').toLowerCase();
  const shortId = node.uuid.slice(-4).toLowerCase();

  const sanitizedId = `${basePrefix}_${shortId}`.replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
  const rawNameCandidate = rawLabel
    ? rawLabel.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
    : '';
  const toolName = (rawNameCandidate || sanitizedId).slice(0, 64);

  let fixedConfig: Record<string, unknown> = {};
  let dynamicSchema: Record<string, unknown> = {
    type: 'object',
    properties: {},
  };
  let description = `Call canvas node '${rawLabel || node.uuid}' (${nodeType})`;

  if (nodeType.startsWith('http:request')) {
    const url = String(nodeCfg.url || '');
    const method = String(nodeCfg.method || 'GET').toUpperCase();
    fixedConfig = {
      url: nodeCfg.url,
      method: nodeCfg.method || 'GET',
      headers: nodeCfg.headers || {},
      timeout_ms: nodeCfg.timeout_ms || 30000,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        query_params: { type: 'object', description: 'Query parameters' },
        body: { type: 'object', description: 'Dynamic request body payload' },
        headers: { type: 'object', description: 'Optional dynamic headers override' },
        path: { type: 'string', description: 'Relative path or endpoint to append' },
      },
    };
    description = `Send HTTP ${method} request to ${url || 'endpoint'}. Allows overriding dynamic body, query params or path.`;
  } else if (nodeType.startsWith('db:query') || nodeType.startsWith('db:') || nodeType === 'sql') {
    fixedConfig = {
      connection_uuid: nodeCfg.connection_uuid,
      timeout_ms: nodeCfg.timeout_ms || 30000,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'SQL query statement' },
      },
      required: ['sql'],
    };
    description = `Execute SQL query on database '${rawLabel || node.uuid}'. Parameter: sql query statement.`;
  } else if (nodeType.startsWith('redis:cmd') || nodeType.startsWith('redis:')) {
    fixedConfig = {
      connection_uuid: nodeCfg.connection_uuid,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Redis command name (e.g. GET)' },
        args: { type: 'string', description: 'JSON array of arguments, e.g. ["key"]' },
      },
      required: ['command'],
    };
    description = `Execute Redis command on cluster '${rawLabel || node.uuid}'. Parameters: command and args array.`;
  } else if (nodeType.startsWith('kafka:produce')) {
    const topic = String(nodeCfg.topic || 'default');
    const connId = nodeCfg.connection_id || nodeCfg.connection_uuid;
    fixedConfig = {
      connection_id: connId,
      connection_uuid: connId,
      topic: nodeCfg.topic,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message payload (string or object)' },
        key: { type: 'string', description: 'Optional message key' },
        topic: { type: 'string', description: 'Optional topic override' },
      },
      required: ['message'],
    };
    description = `Publish message to Kafka topic '${topic}'.`;
  } else if (nodeType.startsWith('kafka:consume')) {
    const topic = String(nodeCfg.topic || 'default');
    const connId = nodeCfg.connection_id || nodeCfg.connection_uuid;
    fixedConfig = {
      connection_id: connId,
      connection_uuid: connId,
      topic: nodeCfg.topic,
      group_id: nodeCfg.group_id,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        max_messages: { type: 'integer', description: 'Maximum messages to consume' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds' },
      },
    };
    description = `Consume messages from Kafka topic '${topic}'.`;
  } else if (nodeType.startsWith('grpc:call') || nodeType.startsWith('grpc:')) {
    const service = String(nodeCfg.service_name || nodeCfg.service || '');
    const method = String(nodeCfg.method_name || nodeCfg.method || '');
    const connId = nodeCfg.connection_id || nodeCfg.connection_uuid;
    fixedConfig = {
      connection_id: connId,
      connection_uuid: connId,
      endpoint: nodeCfg.endpoint,
      proto_file: nodeCfg.proto_file,
      service_name: service,
      method_name: method,
      service,
      method,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        payload: { type: 'object', description: 'Payload JSON object' },
      },
      required: ['payload'],
    };
    description = `Invoke gRPC method '${service}/${method}'. Parameter: payload JSON object.`;
  } else if (nodeType.startsWith('tcp:send') || nodeType.startsWith('tcp:')) {
    const connId = nodeCfg.connection_id || nodeCfg.connection_uuid;
    fixedConfig = {
      connection_id: connId,
      connection_uuid: connId,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Raw TCP payload string' },
      },
      required: ['data'],
    };
    description = `Send raw TCP payload.`;
  } else if (nodeType.startsWith('ws:send_collect') || nodeType.startsWith('ws:')) {
    const connId = nodeCfg.connection_id || nodeCfg.connection_uuid;
    fixedConfig = {
      connection_id: connId,
      connection_uuid: connId,
      timeout_ms: nodeCfg.timeout_ms || 10000,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'WebSocket message string' },
      },
      required: ['message'],
    };
    description = `Send WebSocket message and collect responses.`;
  } else if (nodeType === 'flow:sub' || nodeType === 'subflow') {
    const subflowPath = String(nodeCfg.target_flow_path || nodeCfg.subflow_path || nodeCfg.path || '');
    const targetFlowId = String(nodeCfg.target_flow_id || '');
    fixedConfig = {
      target_flow_path: subflowPath,
      subflow_path: subflowPath,
      ...(targetFlowId ? { target_flow_id: targetFlowId } : {}),
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        variables: { type: 'object', description: 'Subflow input variables object' },
      },
    };
    description = `Execute nested composite subflow '${rawLabel || subflowPath}'.`;
  } else if (nodeType.startsWith('mcp:call_tool') || nodeType.startsWith('mcp:')) {
    fixedConfig = {
      server_uuid: nodeCfg.server_uuid,
    };
    dynamicSchema = {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: 'MCP tool name' },
        arguments: { type: 'object', description: 'Arguments object' },
      },
    };
    description = `Call MCP tool via MCP server '${rawLabel || node.uuid}'.`;
  } else {
    const genericFixed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(nodeCfg)) {
      if (
        k.includes('uuid') ||
        k.includes('connection') ||
        k.includes('endpoint') ||
        k.includes('token') ||
        k.includes('key')
      ) {
        genericFixed[k] = v;
      }
    }
    fixedConfig = Object.keys(genericFixed).length > 0 ? genericFixed : { ...nodeCfg };
    dynamicSchema = {
      type: 'object',
      properties: {
        payload: { type: 'object', description: 'Execution payload' },
      },
    };
    description = `Execute ${nodeType} action on '${rawLabel || node.uuid}'.`;
  }

  return {
    id: sanitizedId,
    name: toolName,
    description,
    tool_type: 'linked_node',
    target_node_type: node.type,
    target_node_id: node.uuid,
    fixed_config: fixedConfig,
    dynamic_schema: dynamicSchema,
  };
}

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
  enable_ask_human: true,
  step_by_step: false,
  structured_output_enabled: false,
  structured_output_schema: undefined,
  export_variables: true,
};

function PanelApp() {
  const [config, setConfig] = useState<AgentReactConfig>(DEFAULT_CONFIG);
  const [availableNodes, setAvailableNodes] = useState<PluginIframeNodeSnapshot[]>([]);
  const [hostRegisteredNodes, setHostRegisteredNodes] = useState<
    Array<{
      type_id: string;
      display_name: string;
      category?: string;
      description?: string;
      default_config?: Record<string, unknown>;
      config_schema?: Record<string, unknown>;
    }>
  >([]);
  const [selectedPreset, setSelectedPreset] = useState<string>('openai');
  const [showAddToolModal, setShowAddToolModal] = useState<boolean>(false);
  const [activePaletteTab, setActivePaletteTab] = useState<'palette' | 'canvas' | 'datasource'>('palette');
  const [selectedDatasourceKey, setSelectedDatasourceKey] = useState<string>('preset:petstore_openapi');
  const [mpeConnections, setMpeConnections] = useState<MpeDatasourceConnection[]>([]);
  const [loadingMpeDatasources, setLoadingMpeDatasources] = useState<boolean>(false);
  const [convertingDatasource, setConvertingDatasource] = useState<boolean>(false);
  const [datasourceBaseUrl, setDatasourceBaseUrl] = useState<string>('https://petstore.swagger.io/v2');
  const [datasourceEndpoints, setDatasourceEndpoints] = useState<
    Array<{
      id: string;
      name: string;
      method: string;
      path: string;
      summary: string;
      selected: boolean;
      raw: Record<string, unknown>;
    }>
  >(() => {
    const preset = DATASOURCE_DEMO_PRESETS['petstore_openapi'];
    return preset ? preset.items.map((it) => ({ ...it, selected: true })) : [];
  });
  const [mountedSuccessMsg, setMountedSuccessMsg] = useState<string | null>(null);

  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldType, setNewFieldType] = useState('string');
  const [newFieldRequired, setNewFieldRequired] = useState(true);
  const handleAddSchemaField = () => {
    const field = newFieldName.trim();
    if (!field) return;

    setConfig((prev) => {
      const currentSchema = (prev.structured_output_schema && typeof prev.structured_output_schema === 'object'
        ? JSON.parse(JSON.stringify(prev.structured_output_schema))
        : { type: 'object', properties: {}, required: [] }) as {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };

      currentSchema.type = currentSchema.type || 'object';
      currentSchema.properties = currentSchema.properties || {};
      currentSchema.properties[field] = {
        type: newFieldType,
        description: `Field ${field}`,
      };

      if (newFieldRequired) {
        currentSchema.required = currentSchema.required || [];
        if (!currentSchema.required.includes(field)) {
          currentSchema.required.push(field);
        }
      }

      return {
        ...prev,
        structured_output_schema: currentSchema,
      };
    });

    setNewFieldName('');
  };
  const loadMpeDatasources = async () => {
    setLoadingMpeDatasources(true);
    try {
      const res = await listMpeDatasources();
      if (res && Array.isArray(res.connections)) {
        setMpeConnections(res.connections);
        if (res.connections.length > 0 && selectedDatasourceKey.startsWith('preset:')) {
          const first = res.connections[0];
          setSelectedDatasourceKey(`mpe:${first.id}`);
          void handleSelectDatasource(`mpe:${first.id}`);
        }
      }
    } catch (err) {
      console.warn('Failed to list MPE datasources:', err);
    } finally {
      setLoadingMpeDatasources(false);
    }
  };

  useEffect(() => {
    if (showAddToolModal && activePaletteTab === 'datasource') {
      void loadMpeDatasources();
    }
  }, [showAddToolModal, activePaletteTab]);

  const handleSelectDatasource = async (key: string) => {
    setSelectedDatasourceKey(key);
    if (key.startsWith('preset:')) {
      const presetKey = key.replace('preset:', '');
      const preset = DATASOURCE_DEMO_PRESETS[presetKey];
      if (preset) {
        setDatasourceBaseUrl(preset.defaultBaseUrl);
        setDatasourceEndpoints(preset.items.map((it) => ({ ...it, selected: true })));
      }
      return;
    }

    if (key.startsWith('mpe:')) {
      const connId = key.replace('mpe:', '');
      setLoadingMpeDatasources(true);
      try {
        const items = await browseMpeDatasource(connId, 'api');
        if (Array.isArray(items)) {
          setDatasourceEndpoints(
            items.map((it) => ({
              id: it.id,
              name: it.name,
              method: (it.method || 'GET').toUpperCase(),
              path: it.path || `/${it.id}`,
              summary: it.summary || '',
              selected: true,
              raw: (it.raw || {}) as Record<string, unknown>,
            }))
          );
        }
      } catch (err) {
        console.error('Failed to browse MPE datasource:', err);
      } finally {
        setLoadingMpeDatasources(false);
      }
    }
  };

  const handleToggleEndpoint = (index: number) => {
    setDatasourceEndpoints((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], selected: !next[index].selected };
      return next;
    });
  };

  const handleToggleAllEndpoints = (selectAll: boolean) => {
    setDatasourceEndpoints((prev) => prev.map((it) => ({ ...it, selected: selectAll })));
  };

  const handleMountDatasourceTools = async () => {
    const selectedItems = datasourceEndpoints.filter((it) => it.selected);
    if (selectedItems.length === 0) return;

    setConvertingDatasource(true);
    try {
      const res = await uiCall<{ success: boolean; tools: AgentToolDefinition[]; count: number }>(
        'convert_datasource_to_tools',
        {
          datasource_type: selectedDatasourceKey.startsWith('mpe:')
            ? mpeConnections.find((c) => c.id === selectedDatasourceKey.replace('mpe:', ''))?.datasource_id || 'http'
            : 'openapi',
          base_url: datasourceBaseUrl,
          items: selectedItems.map((it) => ({
            id: it.id,
            name: it.name,
            method: it.method,
            path: it.path,
            summary: it.summary,
            raw: it.raw,
          })),
        }
      );

      let toolsToAdd: AgentToolDefinition[] = [];
      if (res && res.tools && Array.isArray(res.tools)) {
        toolsToAdd = res.tools;
      } else {
        toolsToAdd = selectedItems.map((it) => {
          const pathClean = it.path.trim().replace(/^\//, '').replace(/[\{\}\-\:\.\s]/g, '_').replace(/\//g, '_');
          const slug = pathClean || 'root';
          const toolId = `${it.method.toLowerCase()}_${slug}`;
          return {
            id: toolId,
            name: (it.raw?.operation_id as string) || toolId,
            description: it.summary || `${it.method} ${it.path}`,
            tool_type: 'standalone_action',
            target_node_type: 'http:request',
            fixed_config: {
              url: `${datasourceBaseUrl.replace(/\/+$/, '')}${it.path}`,
              method: it.method.toLowerCase(),
            },
            dynamic_schema: {
              type: 'object',
              properties: {},
              required: [],
            },
            require_confirmation: false,
          };
        });
      }

      setConfig((prev) => {
        const existingIds = new Set(prev.tools.map((t) => t.id));
        const filteredNew = toolsToAdd.filter((t) => !existingIds.has(t.id));
        return {
          ...prev,
          tools: [...prev.tools, ...filteredNew],
        };
      });

      setMountedSuccessMsg(
        t(
          `成功挂载 ${toolsToAdd.length} 个接口至工具库！`,
          `Successfully mounted ${toolsToAdd.length} API tools!`
        )
      );
      setTimeout(() => {
        setMountedSuccessMsg(null);
        setShowAddToolModal(false);
      }, 1500);
    } catch (err) {
      console.error('Failed to convert datasource tools:', err);
    } finally {
      setConvertingDatasource(false);
    }
  };
  const [modelsList, setModelsList] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState<boolean>(false);
  const [flowVariables, setFlowVariables] = useState<Record<string, unknown>>({});
  const [testStatus, setTestStatus] = useState<{
    loading: boolean;
    success?: boolean;
    msg?: string;
  }>({ loading: false });

  const resolveTemplateVariables = (str: string): string => {
    if (!str) return '';
    return str.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key) => {
      if (key in flowVariables && flowVariables[key] !== undefined && flowVariables[key] !== null) {
        return String(flowVariables[key]);
      }
      return match;
    });
  };
  useEffect(() => {
    const unbind = initBridge({
      onInit: (initialConfig, nodes, initPayload) => {
        if (nodes) setAvailableNodes(nodes);
        if (initPayload && initPayload.variables) {
          setFlowVariables(initPayload.variables);
        }
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
    getRegisteredNodes()
      .then((data) => {
        if (Array.isArray(data)) {
          const valid = (
            data as Array<{
              type_id: string;
              display_name: string;
              category?: string;
              description?: string;
              default_config?: Record<string, unknown>;
              config_schema?: Record<string, unknown>;
            }>
          ).filter(
            (n) =>
              n &&
              n.type_id &&
              n.type_id !== 'agent:react' &&
              n.type_id !== 'llm:provider' &&
              n.type_id !== 'entry' &&
              n.type_id !== 'end' &&
              n.type_id !== 'conditional'
          );
          setHostRegisteredNodes(valid);
        }
      })
      .catch(() => {});
  }, []);

  const effectivePaletteItems = useMemo<PaletteItem[]>(() => {
    if (hostRegisteredNodes.length === 0) {
      return PROTOCOL_PALETTE;
    }
    const knownMap = new Map(PROTOCOL_PALETTE.map((p) => [p.target_node_type, p]));
    const dynamicItems: PaletteItem[] = [];
    for (const hostNode of hostRegisteredNodes) {
      const known = knownMap.get(hostNode.type_id);
      if (known) {
        dynamicItems.push(known);
        knownMap.delete(hostNode.type_id);
      } else {
        dynamicItems.push({
          id: hostNode.type_id.replace(/[:\-]/g, '_'),
          nameZh: hostNode.display_name,
          nameEn: hostNode.display_name,
          category: (hostNode.category?.toLowerCase() as PaletteItem['category']) || 'api',
          target_node_type: hostNode.type_id,
          icon: 'puzzle',
          descZh: hostNode.description || `已注册的协议节点 (${hostNode.type_id})`,
          descEn: hostNode.description || `Registered protocol node (${hostNode.type_id})`,
          defaultDynamicSchema: {
            type: 'object',
            properties: {},
          },
          defaultFixedConfig: hostNode.default_config || {},
        });
      }
    }
    for (const remaining of knownMap.values()) {
      dynamicItems.push(remaining);
    }
    return dynamicItems;
  }, [hostRegisteredNodes]);

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
    const rawProv = targetProvider || effectiveProvider;
    const resolvedBaseUrl = resolveTemplateVariables(rawProv.base_url || '').trim();
    const resolvedApiKey = resolveTemplateVariables(rawProv.api_key || '').trim();

    if (resolvedBaseUrl.includes('{{')) {
      const missingVar = resolvedBaseUrl.match(/\{\{\s*([^}]+)\s*\}\}/)?.[1] || '';
      setTestStatus({
        loading: false,
        success: false,
        msg: t(
          `Base URL 包含未定义的环境变量 {{${missingVar}}}，请先在流程初始变量中配置该变量`,
          `Base URL contains undefined variable {{${missingVar}}}; please define it in flow variables`
        ),
      });
      return;
    }

    const prov: LlmProviderConfig = {
      ...rawProv,
      base_url: resolvedBaseUrl,
      api_key: resolvedApiKey,
    };

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
    const rawProv = targetProvider || effectiveProvider;
    const resolvedBaseUrl = resolveTemplateVariables(rawProv.base_url || '').trim();
    const resolvedApiKey = resolveTemplateVariables(rawProv.api_key || '').trim();

    if (resolvedBaseUrl.includes('{{')) {
      const missingVar = resolvedBaseUrl.match(/\{\{\s*([^}]+)\s*\}\}/)?.[1] || '';
      alert(
        t(
          `Base URL 包含未定义的环境变量 {{${missingVar}}}，请先在流程初始变量中配置该变量`,
          `Base URL contains undefined variable {{${missingVar}}}; please define it in flow variables`
        )
      );
      return;
    }

    const prov: LlmProviderConfig = {
      ...rawProv,
      base_url: resolvedBaseUrl,
      api_key: resolvedApiKey,
    };

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
      tool_type:
        item.target_node_type === 'flow:sub' || item.category === 'subflow'
          ? 'subflow'
          : 'standalone_action',
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
    const newTool = inferToolFromCanvasNode(node);
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
                  {t('关联的服务商节点未填写 API Key，请在对应的 LLM Provider 节点中输入 API 密钥，或在下方输入临时密钥。', 'The linked Provider node has no API Key configured. Please configure API Key in the LLM Provider node or specify one below.')}
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
                style={{ flex: '1 1 auto', minWidth: '120px', justifyContent: 'center' }}
                onClick={() => setActivePaletteTab('palette')}
              >
                <IconZap size={12} />
                {t('标准协议动作库 (Protocol Actions)', 'Standard Actions')}
              </button>
              <button
                type="button"
                className={`btn btn-sm ${activePaletteTab === 'datasource' ? 'btn-primary' : ''}`}
                style={{ flex: '1 1 auto', minWidth: '120px', justifyContent: 'center' }}
                onClick={() => setActivePaletteTab('datasource')}
              >
                <IconGlobe size={12} />
                {t('挂载数据源 API (Datasource APIs)', 'Mount Datasource APIs')}
              </button>
              <button
                type="button"
                className={`btn btn-sm ${activePaletteTab === 'canvas' ? 'btn-primary' : ''}`}
                style={{ flex: '1 1 auto', minWidth: '120px', justifyContent: 'center' }}
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
                {effectivePaletteItems.map((item) => (
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
            ) : activePaletteTab === 'datasource' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {mpeConnections.length === 0 && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: 'var(--fg-muted)',
                      backgroundColor: 'var(--bg-subtle)',
                      padding: '8px 10px',
                      borderRadius: '4px',
                      border: '1px dashed var(--border)',
                      lineHeight: 1.4,
                    }}
                  >
                    {t(
                      '未检测到已连接的 MPE 数据源。可在 MPE 左侧栏【数据源】面板中连接 Eolink / Apifox / Swagger 插件，即可在此直接浏览企业 API 并一键挂载为 Agent 工具。',
                      'No connected MPE datasources detected. Connect real datasources (e.g. Eolink, Apifox, Swagger) in MPE Left Sidebar [Data Sources] to browse and mount enterprise APIs directly.'
                    )}
                  </div>
                )}

                <div className="row" style={{ gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                  <div className="col" style={{ flex: '1 1 220px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 600 }}>
                      {t('选择数据源服务 (Datasource):', 'Select Datasource:')}
                    </label>
                    <select
                      value={selectedDatasourceKey}
                      onChange={(e) => void handleSelectDatasource(e.target.value)}
                      style={{ fontSize: '12px' }}
                    >
                      {mpeConnections.length > 0 && (
                        <optgroup label={t('MPE 已连接数据源', 'MPE Connected Datasources')}>
                          {mpeConnections.map((c) => (
                            <option key={c.id} value={`mpe:${c.id}`}>
                              {c.name || c.display_name} ({c.datasource_id})
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label={t('内置示例规范 (Demo Presets)', 'Built-in Demo Presets')}>
                        {Object.entries(DATASOURCE_DEMO_PRESETS).map(([key, item]) => (
                          <option key={key} value={`preset:${key}`}>
                            {t(item.nameZh, item.nameEn)}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </div>

                  <div className="col" style={{ flex: '2 1 240px' }}>
                    <label style={{ fontSize: '11px', fontWeight: 600 }}>
                      {t('服务基准 Base URL (支持 {{BASE_URL}} 变量):', 'Base URL (supports variables):')}
                    </label>
                    <input
                      type="text"
                      value={datasourceBaseUrl}
                      onChange={(e) => setDatasourceBaseUrl(e.target.value)}
                      placeholder="https://api.example.com"
                      style={{ fontSize: '12px' }}
                    />
                  </div>
                </div>

                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg-muted)' }}>
                    {t('待挂载 API 接口列表 (API Endpoints):', 'API Endpoints:')} ({datasourceEndpoints.filter((e) => e.selected).length}/{datasourceEndpoints.length})
                  </div>
                  <div className="row" style={{ gap: '6px' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleToggleAllEndpoints(true)}
                    >
                      {t('全选', 'Select All')}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => handleToggleAllEndpoints(false)}
                    >
                      {t('取消全选', 'Unselect All')}
                    </button>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                    maxHeight: '200px',
                    overflowY: 'auto',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    padding: '4px',
                    background: 'var(--bg-subtle)',
                  }}
                >
                  {loadingMpeDatasources ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '12px' }}>
                      {t('正在拉取数据源接口列表...', 'Loading datasource endpoints...')}
                    </div>
                  ) : datasourceEndpoints.length === 0 ? (
                    <div style={{ padding: '20px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: '12px' }}>
                      {t('当前数据源暂无可调用的 API 接口', 'No API endpoints available')}
                    </div>
                  ) : (
                    datasourceEndpoints.map((ep, epIdx) => (
                      <div
                        key={ep.id || epIdx}
                        onClick={() => handleToggleEndpoint(epIdx)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          padding: '6px 10px',
                          borderRadius: '4px',
                          background: ep.selected ? 'var(--accent-soft)' : 'var(--bg)',
                          border: ep.selected ? '1px solid var(--accent)' : '1px solid var(--border)',
                          cursor: 'pointer',
                          fontSize: '12px',
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={ep.selected}
                          onChange={() => {}}
                          style={{ cursor: 'pointer' }}
                        />
                        <span
                          className="badge"
                          style={{
                            fontSize: '10px',
                            fontWeight: 700,
                            flexShrink: 0,
                            background:
                              ep.method === 'GET'
                                ? 'var(--ok-soft)'
                                : ep.method === 'POST'
                                ? 'var(--info-soft)'
                                : ep.method === 'DELETE'
                                ? 'var(--danger-soft)'
                                : 'var(--accent-soft)',
                            color:
                              ep.method === 'GET'
                                ? 'var(--ok)'
                                : ep.method === 'POST'
                                ? 'var(--info)'
                                : ep.method === 'DELETE'
                                ? 'var(--danger)'
                                : 'var(--accent)',
                            border: '1px solid currentColor',
                          }}
                        >
                          {ep.method}
                        </span>
                        <strong style={{ flexShrink: 0, fontFamily: 'monospace' }}>{ep.path}</strong>
                        <span style={{ color: 'var(--fg-muted)', fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {ep.summary || ep.name}
                        </span>
                      </div>
                    ))
                  )}
                </div>

                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
                  {mountedSuccessMsg ? (
                    <span style={{ color: 'var(--ok)', fontWeight: 600, fontSize: '12px' }}>
                      ✓ {mountedSuccessMsg}
                    </span>
                  ) : <span />}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={convertingDatasource || datasourceEndpoints.filter((e) => e.selected).length === 0}
                    onClick={handleMountDatasourceTools}
                    style={{ minWidth: '160px', justifyContent: 'center' }}
                  >
                    <IconGlobe size={13} />
                    {convertingDatasource
                      ? t('转换挂载中...', 'Mounting...')
                      : t(
                          `一键挂载已选 (${datasourceEndpoints.filter((e) => e.selected).length}) 至工具库`,
                          `Mount Selected (${datasourceEndpoints.filter((e) => e.selected).length}) to Tools`
                        )}
                  </button>
                </div>
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
              {/* Tool HITL Confirmation Toggle */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer', color: 'var(--fg)' }}>
                  <input
                    type="checkbox"
                    checked={!!tool.require_confirmation}
                    onChange={(e) => handleUpdateTool(idx, { require_confirmation: e.target.checked })}
                  />
                  <span style={{ fontWeight: 500 }}>
                    {t('敏感操作需人工二次审批 (HITL Confirmation)', 'Require Human Approval before Execution (HITL)')}
                  </span>
                </label>
              </div>

              {/* Subflow Flow Path Configuration */}
              {(tool.tool_type === 'subflow' ||
                tool.target_node_type === 'subflow' ||
                tool.target_node_type === 'flow:sub') && (
                <div className="col">
                  <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <IconFolder size={13} />
                    <span>{t('子流程文件路径 (.mpf)', 'Subflow File Path (.mpf)')}</span>
                  </label>
                  <input
                    type="text"
                    value={String(
                      tool.fixed_config?.target_flow_path ||
                        tool.fixed_config?.flow_path ||
                        ''
                    )}
                    onChange={(e) =>
                      handleUpdateTool(idx, {
                        fixed_config: {
                          ...(tool.fixed_config || {}),
                          target_flow_path: e.target.value,
                        },
                      })
                    }
                    placeholder="e.g. flows/order_troubleshoot.mpf"
                    style={{ fontSize: '12px' }}
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

      {/* 4. Structured Output Configuration */}
      <div className="card">
        <div className="card-title">
          <IconBraces size={16} />
          {t('结构化输出与变量导出 (Structured Output & Export)', 'Structured Output & Variables Export')}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '4px' }}>
          {/* Enable Structured Output Checkbox */}
          <div
            style={{
              padding: '10px 12px',
              borderRadius: '6px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--surface)',
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
              }}
            >
              <input
                type="checkbox"
                checked={!!config.structured_output_enabled}
                onChange={(e) => {
                  const enabled = e.target.checked;
                  setConfig((prev) => ({
                    ...prev,
                    structured_output_enabled: enabled,
                    structured_output_schema: enabled
                      ? prev.structured_output_schema || STRUCTURED_OUTPUT_PRESETS['sre_diagnosis'].schema
                      : prev.structured_output_schema,
                  }));
                }}
              />
              <IconSparkles
                size={16}
                style={{
                  color: config.structured_output_enabled ? 'var(--accent)' : 'var(--fg-muted)',
                }}
              />
              <span>{t('启用严格结构化输出 (Enable Structured Output)', 'Enable Strict Structured Output')}</span>
            </label>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginLeft: '24px', marginTop: '2px' }}>
              {t(
                '要求大模型在得出最终结论时严格返回符合指定 JSON Schema 的对象。若不符合，Agent 会拦截并在限制轮次内自我修复重试。',
                'Forces the agent to output a strictly conforming JSON object validated against JSON Schema upon convergence. Automatically self-corrects if invalid.'
              )}
            </div>
          </div>

          {config.structured_output_enabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '2px' }}>
              {/* Auto export variables checkbox */}
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: '1px solid var(--border)',
                  backgroundColor: 'var(--surface)',
                }}
              >
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 500,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={config.export_variables !== false}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, export_variables: e.target.checked }))
                    }
                  />
                  <span>
                    {t(
                      '自动将平坦顶级字段解包并注入流程变量 (Auto-export flat fields to flow variables)',
                      'Auto-export flat top-level fields to flow execution variables'
                    )}
                  </span>
                </label>
                <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginLeft: '24px' }}>
                  {t(
                    '收敛成功后，JSON 对象中的平坦字段将自动注入宿主变量，下游节点可直接使用 {{key}} 或 {{steps.node.output.data.key}}。',
                    'When converged, top-level keys are merged into flow variables, allowing downstream nodes to directly access {{key}} or {{steps.node.output.data.key}}.'
                  )}
                </div>
              </div>

              {/* Preset Selector */}
              <div className="col">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontWeight: 600, fontSize: '12px' }}>
                    {t('JSON Schema 预设模版 (Preset Templates):', 'JSON Schema Preset Templates:')}
                  </label>
                  <select
                    style={{ width: 'auto', minWidth: '220px', fontSize: '12px', padding: '3px 8px' }}
                    onChange={(e) => {
                      const presetKey = e.target.value;
                      if (presetKey && STRUCTURED_OUTPUT_PRESETS[presetKey]) {
                        setConfig((prev) => ({
                          ...prev,
                          structured_output_schema: JSON.parse(
                            JSON.stringify(STRUCTURED_OUTPUT_PRESETS[presetKey].schema)
                          ),
                        }));
                      }
                    }}
                    defaultValue=""
                  >
                    <option value="" disabled>
                      {t('选择预设模版快速填充...', 'Select preset template...')}
                    </option>
                    {Object.entries(STRUCTURED_OUTPUT_PRESETS).map(([k, p]) => (
                      <option key={k} value={k}>
                        {t(p.labelZh, p.labelEn)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Visual Field Adder & JSON Editor */}
              <div className="col">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <label style={{ fontWeight: 600, fontSize: '12px' }}>
                    {t('JSON Schema 约束定义 (JSON Schema Definition):', 'JSON Schema Definition:')}
                  </label>
                  <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>
                    {t('符合 Draft-07 / 2020-12 标准', 'Draft-07 / 2020-12 conforming')}
                  </span>
                </div>

                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px',
                    padding: '10px',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    backgroundColor: 'var(--surface)',
                  }}
                >
                  {/* Quick Field Adder row */}
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      placeholder={t('字段名 (e.g. status)', 'Field name (e.g. status)')}
                      value={newFieldName}
                      onChange={(e) => setNewFieldName(e.target.value)}
                      style={{ flex: 1, minWidth: '120px', fontSize: '12px' }}
                    />
                    <select
                      value={newFieldType}
                      onChange={(e) => setNewFieldType(e.target.value)}
                      style={{ width: 'auto', minWidth: '90px', fontSize: '12px' }}
                    >
                      <option value="string">string</option>
                      <option value="number">number</option>
                      <option value="integer">integer</option>
                      <option value="boolean">boolean</option>
                      <option value="array">array</option>
                      <option value="object">object</option>
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={newFieldRequired}
                        onChange={(e) => setNewFieldRequired(e.target.checked)}
                      />
                      <span>{t('必填 (Required)', 'Required')}</span>
                    </label>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={handleAddSchemaField}
                      style={{ fontSize: '11px', padding: '4px 8px' }}
                    >
                      <IconPlus size={12} />
                      {t('添加字段', 'Add Field')}
                    </button>
                  </div>

                  {/* Schema JSON Editor */}
                  <ToolSchemaEditor
                    schema={config.structured_output_schema || {}}
                    onChange={(newSchema) =>
                      setConfig((prev) => ({ ...prev, structured_output_schema: newSchema }))
                    }
                  />
                </div>
              </div>
            </div>
          )}
        </div>
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
          {/* Row 6: Built-in ask_human Tool */}
          <div
            style={{
              padding: '12px',
              borderRadius: '6px',
              background: config.enable_ask_human !== false ? 'var(--bg-subtle)' : 'var(--bg)',
              border: '1px solid var(--border)',
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
                checked={config.enable_ask_human !== false}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, enable_ask_human: e.target.checked }))
                }
              />
              <IconBot size={16} style={{ color: config.enable_ask_human !== false ? 'var(--accent)' : 'var(--fg-muted)' }} />
              <span>
                {t('启用内置人机提问 (ask_human 工具)', 'Enable Built-in ask_human Tool')}
              </span>
            </label>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginLeft: '24px' }}>
              {t(
                '允许 Agent 在缺少必要参数、遇到歧义或需用户确认时主动调用 ask_human 提问，前端展开交互回复卡片，提交后恢复执行。',
                'Allows Agent to autonomously invoke ask_human to request clarifications or missing input from the user.'
              )}
            </div>
            {config.enable_ask_human !== false && (
              <div style={{ marginLeft: '24px', marginTop: '6px' }}>
                <label style={{ fontSize: '11px', color: 'var(--fg-muted)', display: 'block', marginBottom: '4px' }}>
                  {t('单节点测试预设模拟回复 (避免 Test This Node 时等待超时):', 'Mock Response for Test Node (Avoids Timeout):')}
                </label>
                <input
                  type="text"
                  placeholder={t('例如：已确认，请使用默认参数继续执行', 'e.g. Confirmed, proceed with defaults')}
                  value={config.mock_human_response || ''}
                  onChange={(e) => setConfig((prev) => ({ ...prev, mock_human_response: e.target.value }))}
                  style={{ fontSize: '12px' }}
                />
              </div>
            )}
          </div>

          {/* Row 7: Step-by-Step Debug Mode */}
          <div
            style={{
              padding: '12px',
              borderRadius: '6px',
              background: config.step_by_step ? 'var(--bg-subtle)' : 'var(--bg)',
              border: `1px solid ${config.step_by_step ? 'var(--accent)' : 'var(--border)'}`,
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
                checked={!!config.step_by_step}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, step_by_step: e.target.checked }))
                }
              />
              <IconClock size={16} style={{ color: config.step_by_step ? 'var(--accent)' : 'var(--fg-muted)' }} />
              <span>
                {t('开启单步调试模式 (Step-by-Step Debug)', 'Enable Step-by-Step Debug Mode')}
              </span>
            </label>
            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginLeft: '24px' }}>
              {t(
                '每一轮工具执行完成后自动暂停挂起，等待用户在时间线面板中点击【单步推进】或【执行到底】。',
                'Pauses after every reasoning step for human inspection and manual step-by-step progression.'
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
