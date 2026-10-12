// Frontend types for Agent plugin

export interface PluginIframeNodeSnapshot {
  uuid: string;
  label: string;
  type: string;
  config: Record<string, unknown>;
  id?: string;
  name?: string;
}

export interface PluginIframeInitPayload {
  config: unknown;
  variables: Record<string, unknown>;
  host_api: Record<string, unknown>;
  nodeType: string;
  locale: string;
  /** 宿主已解析主题；旧宿主不携带 → 回退 prefers-color-scheme */
  theme?: 'light' | 'dark';
  nodes?: PluginIframeNodeSnapshot[];
  node_report?: Record<string, unknown>;
  outputData?: unknown;
  reportData?: unknown;
}

export interface LlmProviderConfig {
  base_url: string;
  api_key?: string;
  model: string;
  timeout_ms: number;
  custom_headers?: Record<string, string>;
}

export interface AgentToolDefinition {
  id: string;
  name: string;
  description: string;
  tool_type: 'linked_node' | 'standalone_action' | 'subflow' | string;
  target_node_type: string;
  target_node_id?: string;
  fixed_config: Record<string, unknown>;
  dynamic_schema: Record<string, unknown>;
  require_confirmation?: boolean;
}

export interface AgentReactConfig {
  provider_uuid?: string;
  override_model?: string;
  override_timeout_ms?: number;
  provider: LlmProviderConfig;
  system_prompt: string;
  user_prompt: string;
  tools: AgentToolDefinition[];
  max_iterations: number;
  max_tool_calls_per_round: number;
  temperature: number;
  timeout_secs: number;
  read_only_mode: boolean;
  stream: boolean;
  enable_ask_human?: boolean;
  step_by_step?: boolean;
  interaction_timeout_secs?: number;
  mock_human_response?: string;
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface TimelineToolCall {
  call_id: string;
  tool_id: string;
  tool_name: string;
  node_type: string;
  input_args: Record<string, unknown>;
  merged_config: Record<string, unknown>;
  success: boolean;
  output_data?: unknown;
  error_message?: string;
  raw_response: string;
  duration_ms: number;
}

export interface PendingInteraction {
  interaction_id: string;
  execution_id: string;
  interaction_type: 'ask_human' | 'confirmation' | 'step_pause' | string;
  prompt: string;
  tool_id?: string;
  tool_name?: string;
  input_args?: Record<string, unknown>;
  step_index?: number;
  created_at_ms: number;
}

export interface HumanResponse {
  text?: string;
  approved?: boolean;
  reason?: string;
  action?: 'next_step' | 'run_to_end' | 'cancel' | string;
}

export interface TimelineStep {
  step_index: number;
  step_type: 'thought' | 'tool_call' | 'self_correction' | 'final_answer' | 'error' | 'waiting_human' | 'human_response' | 'interrupted' | 'step_pause' | string;
  thought?: string;
  tool_calls: TimelineToolCall[];
  duration_ms: number;
  self_correction: boolean;
  tokens?: TokenUsage;
  human_interaction?: PendingInteraction;
  human_response?: HumanResponse;
}

export interface StreamMessagePayload {
  kind?: 'reasoning' | 'content';
  delta_reasoning?: string;
  delta_content?: string;
  text?: string;
  fullContent?: string;
  fullReasoning?: string;
  timestamp?: string;
  type?: 'tool_start' | 'tool_end' | 'waiting_human' | 'human_resumed' | 'interrupted' | 'step_completed' | 'converged' | string;
  interaction?: PendingInteraction;
  interaction_id?: string;
  response?: HumanResponse;
  step?: TimelineStep;
  tool_id?: string;
  tool_name?: string;
  input_args?: unknown;
  success?: boolean;
  output?: unknown;
  error?: string;
  duration_ms?: number;
  final_answer?: string;
  iterations?: number;
  step_index?: number;
}

export interface AgentReactOutput {
  success: boolean;
  final_answer: string;
  iterations: number;
  tool_call_count: number;
  self_corrections_count: number;
  token_usage: TokenUsage;
  total_duration_ms: number;
  timeline: TimelineStep[];
}
