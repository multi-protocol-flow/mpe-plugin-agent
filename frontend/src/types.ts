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
}

export interface AgentReactConfig {
  provider_uuid?: string;
  override_model?: string;
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

export interface TimelineStep {
  step_index: number;
  step_type: 'thought' | 'tool_call' | 'self_correction' | 'final_answer' | 'error' | string;
  thought?: string;
  tool_calls: TimelineToolCall[];
  duration_ms: number;
  self_correction: boolean;
  tokens?: TokenUsage;
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
