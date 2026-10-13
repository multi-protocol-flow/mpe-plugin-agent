import type {
  HumanResponse,
  PluginIframeInitPayload,
  PluginIframeNodeSnapshot,
  StreamMessagePayload,
} from './types';
import { setLocale } from './i18n';

export interface BridgeOptions {
  onInit?: (config: Record<string, unknown>, nodes?: PluginIframeNodeSnapshot[], initPayload?: PluginIframeInitPayload) => void;
  onConfigUpdated?: (config: unknown) => void;
  onExecutionUpdate?: (output: unknown) => void;
  onStreamMessage?: (payload: StreamMessagePayload) => void;
}

interface PendingAction {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: number;
}

const ACTION_TIMEOUT_MS = 30000;
let locale = 'en-US';
let nodeType = 'agent:react';
let nodes: PluginIframeNodeSnapshot[] | undefined = undefined;
let initConfig: Record<string, unknown> = {};

const pendingActions = new Map<string, PendingAction>();

// --- theme ----------------------------------------------------------------

/**
 * Apply the host-resolved theme to the document root.
 *
 * `data-theme` drives the plugin stylesheet (`:root[data-theme="dark"]`);
 * `color-scheme` makes UA-native widgets (select popup / options, checkbox,
 * range, scrollbars) follow, which is what fixes white-on-white controls.
 * When the host never sends `theme`, the stylesheet's
 * `@media (prefers-color-scheme: dark)` fallback keeps working — we simply
 * never set the attribute.
 */
function applyTheme(theme: 'light' | 'dark'): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(isDark ? 'dark' : 'light');
}

function isTheme(value: unknown): value is 'light' | 'dark' {
  return value === 'light' || value === 'dark';
}

function post(type: string, payload: Record<string, unknown> = {}): void {
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.parent.postMessage({ type, payload }, '*');
    }
  } catch (err) {
    console.error('[agent] failed to post message', type, err);
  }
}

export function postReady(): void {
  post('ready', {});
}

export function postResize(height: number): void {
  post('resize', { height });
}

export function postError(message: string): void {
  post('error', { message });
}

export function requestAction(action: string, params: unknown = {}): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const requestId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : String(Date.now()) + '-' + Math.random().toString(36).slice(2);

    const timer = window.setTimeout(() => {
      pendingActions.delete(requestId);
      reject(new Error(`Action '${action}' timed out after ${ACTION_TIMEOUT_MS}ms`));
    }, ACTION_TIMEOUT_MS);

    pendingActions.set(requestId, { resolve, reject, timer });
    post('requestAction', { requestId, action, params });
  });
}

export function getRegisteredNodes(): Promise<unknown> {
  return requestAction('getRegisteredNodes', {});
}
export function uiCall<T = unknown>(method: string, payload: unknown): Promise<T> {
  return requestAction('uiCall', { nodeType, method, payload }) as Promise<T>;
}

export function submitHumanResponse(interactionId: string, response: HumanResponse): Promise<unknown> {
  return uiCall('submit_human_response', { interaction_id: interactionId, response });
}

export function interruptAgent(executionId: string, text: string): Promise<unknown> {
  return uiCall('interrupt_agent', { execution_id: executionId, text });
}

let configTimer: number | null = null;
let lastReportedJson = '';

export function notifyConfig(config: unknown): void {
  if (configTimer !== null) {
    window.clearTimeout(configTimer);
  }
  configTimer = window.setTimeout(() => {
    configTimer = null;
    const json = JSON.stringify(config);
    if (json === lastReportedJson) return;
    lastReportedJson = json;
    post('configChanged', { config });
  }, 100);
}

export function flushConfig(): void {
  if (configTimer !== null) {
    window.clearTimeout(configTimer);
    configTimer = null;
  }
}

export function initBridge(options: BridgeOptions): () => void {
  const handleMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      return;
    }
    const payload = (data.payload && typeof data.payload === 'object' ? data.payload : {}) as Record<string, unknown>;

    switch (data.type) {
      case 'init': {
        const initPayload = payload as unknown as PluginIframeInitPayload;
        if (typeof initPayload.locale === 'string') {
          locale = initPayload.locale;
          setLocale(initPayload.locale);
        }
        if (isTheme(initPayload.theme)) {
          applyTheme(initPayload.theme);
        }
        if (typeof initPayload.nodeType === 'string') {
          nodeType = initPayload.nodeType;
        }
        if (Array.isArray(initPayload.nodes)) {
          nodes = initPayload.nodes;
        }
        if (initPayload.config && typeof initPayload.config === 'object') {
          initConfig = initPayload.config as Record<string, unknown>;
          lastReportedJson = JSON.stringify(initPayload.config);
        }
        options.onInit?.(initConfig, nodes, initPayload);
        postReady();
        break;
      }
      case 'configUpdated': {
        const nextJson = JSON.stringify(payload.config);
        if (nextJson === lastReportedJson) {
          break;
        }
        lastReportedJson = nextJson;
        options.onConfigUpdated?.(payload.config);
        break;
      }
      case 'actionResult': {
        const requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
        const pending = pendingActions.get(requestId);
        if (!pending) return;
        pendingActions.delete(requestId);
        window.clearTimeout(pending.timer);
        if (typeof payload.error === 'string' && payload.error.length > 0) {
          pending.reject(new Error(payload.error));
        } else {
          pending.resolve(payload.result);
        }
        break;
      }
      case 'themeChanged': {
        // Host switched light/dark while the panel is open → re-skin in place.
        if (isTheme(payload.theme)) {
          applyTheme(payload.theme);
        }
        break;
      }
      case 'executionUpdate': {
        options.onExecutionUpdate?.(payload.output || payload.result || payload);
        break;
      }
      case 'stream': {
        options.onStreamMessage?.(payload as unknown as StreamMessagePayload);
        break;
      }
    }
  };

  window.addEventListener('message', handleMessage);
  post('requestInit', {});

  let lastReportedHeight = -1;
  const updateHeight = () => {
    const root = document.getElementById('root');
    if (root) {
      const height = Math.ceil(Math.max(root.scrollHeight, root.offsetHeight));
      if (Number.isFinite(height) && height > 0 && Math.abs(height - lastReportedHeight) >= 1) {
        lastReportedHeight = height;
        postResize(height);
      }
    }
  };

  window.addEventListener('resize', updateHeight);

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(updateHeight);
    const root = document.getElementById('root');
    if (root) {
      resizeObserver.observe(root);
    } else if (document.body) {
      resizeObserver.observe(document.body);
    }
  }

  setTimeout(updateHeight, 0);
  setTimeout(updateHeight, 50);
  setTimeout(updateHeight, 150);

  return () => {
    window.removeEventListener('message', handleMessage);
    window.removeEventListener('resize', updateHeight);
    if (resizeObserver) {
      resizeObserver.disconnect();
    }
  };
}

export function getLocale(): string {
  return locale;
}

export function getNodeType(): string {
  return nodeType;
}

export function getNodes(): PluginIframeNodeSnapshot[] | undefined {
  return nodes;
}

export function getInitConfig(): Record<string, unknown> {
  return initConfig;
}
