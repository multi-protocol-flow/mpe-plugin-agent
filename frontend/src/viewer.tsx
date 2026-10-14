import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initBridge, interruptAgent, postResize, submitHumanResponse } from './bridge';
import { t } from './i18n';
import {
  IconActivity,
  IconBarChart,
  IconBot,
  IconBrain,
  IconCheck,
  IconCheckCircle,
  IconChevronDown,
  IconClock,
  IconCode,
  IconCopy,
  IconDatabase,
  IconFolder,
  IconGlobe,
  IconHelpCircle,
  IconLayers,
  IconPause,
  IconPlay,
  IconRotateCcw,
  IconSend,
  IconShield,
  IconSparkles,
  IconUser,
  IconWrench,
  IconX,
  IconZap,
} from './icons';
import './styles.css';
import type {
  AgentReactOutput,
  PendingInteraction,
  StreamMessagePayload,
  TimelineStep,
} from './types';
function getNodeTypeBadge(nodeType: string) {
  const norm = nodeType.toLowerCase();
  if (norm.startsWith('http')) {
    return {
      label: nodeType,
      color: '#3B82F6',
      bg: 'rgba(59, 130, 246, 0.12)',
      border: 'rgba(59, 130, 246, 0.3)',
      icon: <IconGlobe size={11} />,
    };
  }
  if (norm.startsWith('db') || norm.includes('sql') || norm.startsWith('mongo')) {
    return {
      label: nodeType,
      color: '#10B981',
      bg: 'rgba(16, 185, 129, 0.12)',
      border: 'rgba(16, 185, 129, 0.3)',
      icon: <IconDatabase size={11} />,
    };
  }
  if (norm.startsWith('redis')) {
    return {
      label: nodeType,
      color: '#EF4444',
      bg: 'rgba(239, 68, 68, 0.12)',
      border: 'rgba(239, 68, 68, 0.3)',
      icon: <IconZap size={11} />,
    };
  }
  if (norm === 'script') {
    return {
      label: nodeType,
      color: '#F59E0B',
      bg: 'rgba(245, 158, 11, 0.12)',
      border: 'rgba(245, 158, 11, 0.3)',
      icon: <IconCode size={11} />,
    };
  }
  if (norm.startsWith('flow') || norm.includes('subflow')) {
    return {
      label: nodeType,
      color: '#8B5CF6',
      bg: 'rgba(139, 92, 246, 0.12)',
      border: 'rgba(139, 92, 246, 0.3)',
      icon: <IconFolder size={11} />,
    };
  }
  return {
    label: nodeType,
    color: 'var(--accent)',
    bg: 'var(--accent-soft)',
    border: 'var(--accent-border)',
    icon: <IconWrench size={11} />,
  };
}


function ViewerApp() {
  const [output, setOutput] = useState<AgentReactOutput | null>(null);
  const [executionId, setExecutionId] = useState<string>('default');
  const [activeInteraction, setActiveInteraction] = useState<PendingInteraction | null>(null);
  const lastInteractionRef = useRef<PendingInteraction | null>(null);
  const [liveReasoning, setLiveReasoning] = useState<string>('');
  const [liveContent, setLiveContent] = useState<string>('');
  const [executingTool, setExecutingTool] = useState<{
    tool_id: string;
    tool_name: string;
    input_args?: unknown;
  } | null>(null);
  const [hasStartedExecution, setHasStartedExecution] = useState<boolean>(false);
  const [completedLiveTools, setCompletedLiveTools] = useState<Array<{
    tool_id: string;
    tool_name: string;
    success: boolean;
    output?: unknown;
    error?: string;
    duration_ms: number;
  }>>([]);
  const [recentInteractions, setRecentInteractions] = useState<Array<{
    interaction_id: string;
    interaction_type: string;
    prompt: string;
    tool_name?: string;
    user_response: string;
    approved?: boolean;
    timestamp: number;
  }>>([]);
  const [humanInputText, setHumanInputText] = useState<string>('');
  const [rejectReasonText, setRejectReasonText] = useState<string>('');
  const [interruptionText, setInterruptionText] = useState<string>('');
  const [submittingInteraction, setSubmittingInteraction] = useState<boolean>(false);
  const [interruptionNotice, setInterruptionNotice] = useState<string | null>(null);
  const [copiedAnswer, setCopiedAnswer] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);
  const [collapsedThoughts, setCollapsedThoughts] = useState<Record<number, boolean>>({});
  const [expandedResults, setExpandedResults] = useState<Record<string, boolean>>({});

  const toggleThought = (idx: number) => {
    setCollapsedThoughts((prev) => ({ ...prev, [idx]: !prev[idx] }));
  };

  const toggleResult = (callId: string) => {
    setExpandedResults((prev) => ({ ...prev, [callId]: !prev[callId] }));
  };


  const ensureDraftOutput = useCallback(() => {
    setOutput((prev) => prev || {
      success: false,
      final_answer: '',
      iterations: 1,
      tool_call_count: 0,
      self_corrections_count: 0,
      token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      total_duration_ms: 0,
      timeline: [],
    });
  }, []);

  useEffect(() => {
    const unbind = initBridge({
      onInit: (config, _nodes, initPayload) => {
        const payload = initPayload || (config as unknown as Record<string, unknown>);
        const nodeReport = (payload?.node_report || {}) as Record<string, unknown>;
        const execId = String(nodeReport?.execution_id || 'default');
        setExecutionId(execId);

        const candidate =
          payload?.reportData ||
          payload?.outputData ||
          nodeReport?.plugin_data ||
          nodeReport?.output_data ||
          config;

        if (candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0) {
          setOutput(candidate as unknown as AgentReactOutput);
          setHasStartedExecution(true);
        }
      },
      onExecutionUpdate: (data) => {
        if (data && typeof data === 'object') {
          setOutput(data as AgentReactOutput);
          setHasStartedExecution(true);
          setLiveReasoning('');
          setLiveContent('');
          setExecutingTool(null);
        }
      },
      onStreamMessage: (msg: StreamMessagePayload) => {
        setHasStartedExecution(true);
        ensureDraftOutput();

        // 1. LLM Chunk Deltas
        if (msg.kind === 'reasoning' || typeof msg.delta_reasoning === 'string') {
          if (msg.fullReasoning) {
            setLiveReasoning(msg.fullReasoning);
          } else if (msg.delta_reasoning) {
            setLiveReasoning((prev) => prev + msg.delta_reasoning);
          }
        }
        if (msg.kind === 'content' || typeof msg.delta_content === 'string') {
          if (msg.fullContent) {
            setLiveContent(msg.fullContent);
          } else if (msg.delta_content) {
            setLiveContent((prev) => prev + msg.delta_content);
          }
        }

        // 2. Tool Lifecycle
        if (msg.type === 'tool_start') {
          setExecutingTool({
            tool_id: msg.tool_id || '',
            tool_name: msg.tool_name || msg.tool_id || 'tool',
            input_args: msg.input_args,
          });
        } else if (msg.type === 'tool_end') {
          setExecutingTool(null);
          setCompletedLiveTools((prev) => [
            ...prev,
            {
              tool_id: msg.tool_id || '',
              tool_name: msg.tool_name || msg.tool_id || 'tool',
              success: msg.success ?? true,
              output: msg.output,
              error: msg.error,
              duration_ms: msg.duration_ms || 0,
            },
          ]);
        }

        // 3. Human in the Loop (HITL) Interruption / Interaction
        if (msg.type === 'waiting_human' && msg.interaction) {
          setActiveInteraction(msg.interaction);
          lastInteractionRef.current = msg.interaction;
          if (msg.interaction.execution_id) {
            setExecutionId(msg.interaction.execution_id);
          }
          setHumanInputText('');
          setRejectReasonText('');
        } else if (msg.type === 'human_resumed') {
          const interaction = activeInteraction || lastInteractionRef.current;
          const msgObj = msg as Record<string, unknown>;
          const userAns =
            msgObj.user_answer ||
            (msg.response && msg.response.text);
          const respText =
            typeof userAns === 'string' && userAns.trim()
              ? userAns
              : msg.response?.approved !== undefined
              ? msg.response.approved
                ? t('已批准操作', 'Approved')
                : t('已拒绝操作', 'Rejected')
              : msgObj.action
              ? String(msgObj.action)
              : t('已确认', 'Confirmed');

          const promptText =
            interaction?.prompt ||
            (typeof msgObj.prompt === 'string' ? msgObj.prompt : t('人机交互', 'Human Interaction'));
          const toolName =
            interaction?.tool_name ||
            (typeof msgObj.tool_name === 'string' ? msgObj.tool_name : undefined);

          setRecentInteractions((prev) => [
            ...prev,
            {
              interaction_id: msg.interaction_id || interaction?.interaction_id || 'interaction',
              interaction_type: interaction?.interaction_type || 'ask_human',
              prompt: promptText,
              tool_name: toolName,
              user_response: respText,
              approved: msg.response?.approved,
              timestamp: Date.now(),
            },
          ]);
          setActiveInteraction(null);
        }
        // 3.5 Interrupted event
        if (msg.type === 'interrupted' && typeof msg.text === 'string') {
          const interruptedText = msg.text;
          setOutput((prev) => {
            const current = prev || {
              success: false,
              final_answer: '',
              iterations: 1,
              tool_call_count: 0,
              self_corrections_count: 0,
              token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              total_duration_ms: 0,
              timeline: [],
            };
            if (current.timeline.some((s) => s.step_type === 'interrupted' && s.thought === interruptedText)) {
              return current;
            }
            const stepIdx = current.timeline.length + 1;
            const stepEntry: TimelineStep = {
              step_index: stepIdx,
              step_type: 'interrupted',
              thought: interruptedText,
              tool_calls: [],
              duration_ms: 0,
              self_correction: false,
              human_response: { text: interruptedText },
            };
            return {
              ...current,
              iterations: current.timeline.length + 1,
              timeline: [...current.timeline, stepEntry],
            };
          });
        }
        if (msg.type === 'step_completed' && msg.step) {
          const step = msg.step;
          setLiveReasoning('');
          setLiveContent('');
          setExecutingTool(null);
          setCompletedLiveTools([]);
          setRecentInteractions([]);
          setOutput((prev) => {
            const current = prev || {
              success: false,
              final_answer: '',
              iterations: 1,
              tool_call_count: 0,
              self_corrections_count: 0,
              token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              total_duration_ms: 0,
              timeline: [],
            };
            const existingIdx = current.timeline.findIndex(
              (s) => s.step_index === msg.step?.step_index
            );
            let nextTimeline: TimelineStep[];
            if (existingIdx >= 0) {
              nextTimeline = [...current.timeline];
              nextTimeline[existingIdx] = step;
            } else {
              nextTimeline = [...current.timeline, step];
            }
            return {
              ...current,
              iterations: nextTimeline.length,
              timeline: nextTimeline,
            };
          });
        }

        // 5. Converged Final Answer
        if (msg.type === 'converged') {
          setLiveReasoning('');
          setLiveContent('');
          setExecutingTool(null);
          setActiveInteraction(null);
          setCompletedLiveTools([]);
          setRecentInteractions([]);
          if (msg.final_answer) {
            setOutput((prev) => ({
              ...(prev || {
                success: true,
                final_answer: msg.final_answer || '',
                iterations: msg.iterations || 1,
                tool_call_count: 0,
                self_corrections_count: 0,
                token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                total_duration_ms: 0,
                timeline: [],
              }),
              success: true,
              final_answer: msg.final_answer || '',
              iterations: msg.iterations || prev?.iterations || 1,
            }));
          }
        }
      },
    });
    return unbind;
  }, []);

  useEffect(() => {
    let lastReportedHeight = -1;
    const updateHeight = () => {
      const root = document.getElementById('root');
      if (!root) return;
      const h = Math.ceil(Math.max(root.offsetHeight, root.scrollHeight, 320));
      if (h > 0 && Math.abs(h - lastReportedHeight) >= 4) {
        lastReportedHeight = h;
        postResize(h);
      }
    };

    updateHeight();
    const timer = setTimeout(updateHeight, 60);

    if (typeof ResizeObserver === 'undefined') {
      return () => clearTimeout(timer);
    }
    const ro = new ResizeObserver(() => updateHeight());
    const root = document.getElementById('root');
    if (root) ro.observe(root);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [output, activeInteraction, liveReasoning, executingTool, showRawJson]);

  const handleCopyAnswer = () => {
    if (!output?.final_answer) return;
    navigator.clipboard.writeText(output.final_answer);
    setCopiedAnswer(true);
    setTimeout(() => setCopiedAnswer(false), 2000);
  };

  const handleCopyRaw = () => {
    if (!output) return;
    navigator.clipboard.writeText(JSON.stringify(output, null, 2));
    setCopiedRaw(true);
    setTimeout(() => setCopiedRaw(false), 2000);
  };

  const handleSubmitAskHuman = useCallback(async () => {
    if (!activeInteraction) return;
    const userText = humanInputText.trim() || 'Confirmed';
    const curInteraction = activeInteraction;
    setSubmittingInteraction(true);
    try {
      await submitHumanResponse(curInteraction.interaction_id, {
        text: userText,
      });
      setRecentInteractions((prev) => [
        ...prev,
        {
          interaction_id: curInteraction.interaction_id,
          interaction_type: curInteraction.interaction_type || 'ask_human',
          prompt: curInteraction.prompt,
          tool_name: curInteraction.tool_name || 'ask_human',
          user_response: userText,
          timestamp: Date.now(),
        },
      ]);
      ensureDraftOutput();
      setActiveInteraction(null);
      setHumanInputText('');
    } catch (err) {
      console.error('[agent viewer] submit ask_human failed:', err);
    } finally {
      setSubmittingInteraction(false);
    }
  }, [activeInteraction, humanInputText, ensureDraftOutput]);

  const handleApproveTool = useCallback(async () => {
    if (!activeInteraction) return;
    const curInteraction = activeInteraction;
    setSubmittingInteraction(true);
    try {
      await submitHumanResponse(curInteraction.interaction_id, { approved: true });
      setRecentInteractions((prev) => [
        ...prev,
        {
          interaction_id: curInteraction.interaction_id,
          interaction_type: curInteraction.interaction_type || 'confirmation',
          prompt: curInteraction.prompt,
          tool_name: curInteraction.tool_name || 'tool',
          user_response: t('已批准操作并继续执行', 'Approved tool execution'),
          approved: true,
          timestamp: Date.now(),
        },
      ]);
      ensureDraftOutput();
      setActiveInteraction(null);
    } catch (err) {
      console.error('[agent viewer] approve tool failed:', err);
    } finally {
      setSubmittingInteraction(false);
    }
  }, [activeInteraction, ensureDraftOutput]);

  const handleRejectTool = useCallback(async () => {
    if (!activeInteraction) return;
    const curInteraction = activeInteraction;
    const reason = rejectReasonText.trim() || 'Rejected by human user';
    setSubmittingInteraction(true);
    try {
      await submitHumanResponse(curInteraction.interaction_id, {
        approved: false,
        reason,
      });
      setRecentInteractions((prev) => [
        ...prev,
        {
          interaction_id: curInteraction.interaction_id,
          interaction_type: curInteraction.interaction_type || 'confirmation',
          prompt: curInteraction.prompt,
          tool_name: curInteraction.tool_name || 'tool',
          user_response: `${t('已拒绝:', 'Rejected:')} ${reason}`,
          approved: false,
          timestamp: Date.now(),
        },
      ]);
      ensureDraftOutput();
      setActiveInteraction(null);
      setRejectReasonText('');
    } catch (err) {
      console.error('[agent viewer] reject tool failed:', err);
    } finally {
      setSubmittingInteraction(false);
    }
  }, [activeInteraction, rejectReasonText, ensureDraftOutput]);

  const handleStepDebugAction = useCallback(async (action: 'next_step' | 'run_to_end') => {
    if (!activeInteraction) return;
    const curInteraction = activeInteraction;
    setSubmittingInteraction(true);
    try {
      await submitHumanResponse(curInteraction.interaction_id, { action });
      setRecentInteractions((prev) => [
        ...prev,
        {
          interaction_id: curInteraction.interaction_id,
          interaction_type: curInteraction.interaction_type || 'step_pause',
          prompt: curInteraction.prompt,
          user_response: action === 'next_step' ? t('单步推进下一轮', 'Next Step') : t('执行到底', 'Run to End'),
          timestamp: Date.now(),
        },
      ]);
      ensureDraftOutput();
      setActiveInteraction(null);
    } catch (err) {
      console.error('[agent viewer] step debug failed:', err);
    } finally {
      setSubmittingInteraction(false);
    }
  }, [activeInteraction, ensureDraftOutput]);

  const handleSendInterruption = useCallback(async () => {
    const text = interruptionText.trim();
    if (!text) return;
    try {
      await interruptAgent(executionId, text);
      setOutput((prev) => {
        const current = prev || {
          success: false,
          final_answer: '',
          iterations: 1,
          tool_call_count: 0,
          self_corrections_count: 0,
          token_usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          total_duration_ms: 0,
          timeline: [],
        };
        const stepIdx = current.timeline.length + 1;
        const stepEntry: TimelineStep = {
          step_index: stepIdx,
          step_type: 'interrupted',
          thought: text,
          tool_calls: [],
          duration_ms: 0,
          self_correction: false,
          human_response: { text },
        };
        return {
          ...current,
          iterations: current.timeline.length + 1,
          timeline: [...current.timeline, stepEntry],
        };
      });
      setInterruptionNotice(t('中途介入指令已排入！将在当前步骤完成后注入对话上下文', 'Instruction queued! Will steer agent at next step boundary.'));
      setInterruptionText('');
      setTimeout(() => setInterruptionNotice(null), 4000);
    } catch (err) {
      console.error('[agent viewer] send interruption failed:', err);
    }
  }, [executionId, interruptionText]);

  if (
    !output &&
    !hasStartedExecution &&
    !activeInteraction &&
    !liveReasoning &&
    !executingTool &&
    recentInteractions.length === 0 &&
    completedLiveTools.length === 0
  ) {
    return (
      <div className="panel" style={{ textAlign: 'center', padding: '40px 20px' }}>
        <div style={{ color: 'var(--fg-soft)', fontSize: '13px' }}>
          {t('等待 Agent 执行产物或加载中...', 'Waiting for Agent execution output...')}
        </div>
      </div>
    );
  }

  const {
    success = false,
    final_answer = '',
    iterations = 0,
    tool_call_count = 0,
    self_corrections_count = 0,
    token_usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    total_duration_ms = 0,
    timeline = [],
  } = output || {};

  const isFinished = Boolean(
    final_answer ||
    (!liveReasoning &&
      !executingTool &&
      !activeInteraction &&
      recentInteractions.length === 0 &&
      completedLiveTools.length === 0 &&
      timeline.some((s) => s.step_type === 'final_answer' || s.step_type === 'error'))
  );

  return (
    <div className="panel">
      {/* 1. KPI Metric Dashboard */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: '8px', flexWrap: 'wrap' }}>
            <span
              className={`badge ${success ? 'badge-ok' : activeInteraction ? 'badge-warn' : 'badge-accent'}`}
              style={{ fontSize: '12px', padding: '3px 10px' }}
            >
              {success ? <IconCheckCircle size={14} /> : activeInteraction ? <IconHelpCircle size={14} /> : <IconBrain size={14} />}
              {success
                ? t('目标收敛达成', 'Goal Converged')
                : activeInteraction
                ? t('等待人类协同 (Waiting Human)', 'Waiting Human (HITL)')
                : t('执行中 / 推理中', 'Executing / Reasoning')}
            </span>
            {self_corrections_count > 0 && (
              <span className="badge badge-warn" style={{ fontSize: '12px', padding: '3px 10px' }}>
                <IconRotateCcw size={14} />
                {t(`自我修复: ${self_corrections_count} 次`, `Self-Corrections: ${self_corrections_count}`)}
              </span>
            )}
          </div>
          <div className="row" style={{ gap: '6px' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setShowRawJson((prev) => !prev)}
            >
              <IconCode size={12} />
              {showRawJson ? t('隐藏 JSON', 'Hide JSON') : t('查看 JSON', 'View JSON')}
            </button>
            <button type="button" className="btn btn-sm" onClick={handleCopyRaw}>
              <IconCopy size={12} />
              {copiedRaw ? t('已复制', 'Copied') : t('复制 Raw', 'Copy Raw')}
            </button>
          </div>
        </div>

        <div className="row" style={{ gap: '16px', marginTop: '4px', flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: '6px', color: 'var(--fg-muted)', fontSize: '12px' }}>
            <IconClock size={14} />
            <span>
              {t('耗时:', 'Duration:')}{' '}
              <strong style={{ color: 'var(--fg)' }}>
                {(total_duration_ms / 1000).toFixed(2)}s
              </strong>
            </span>
          </div>

          <div className="row" style={{ gap: '6px', color: 'var(--fg-muted)', fontSize: '12px' }}>
            <IconBarChart size={14} />
            <span>
              {t('Total Tokens:', 'Total Tokens:')}{' '}
              <strong style={{ color: 'var(--fg)' }}>
                {token_usage?.total_tokens?.toLocaleString() || 0}
              </strong>{' '}
              <span style={{ fontSize: '11px', color: 'var(--fg-soft)' }}>
                (P: {token_usage?.prompt_tokens || 0} / C: {token_usage?.completion_tokens || 0})
              </span>
            </span>
          </div>

          <div className="row" style={{ gap: '6px', color: 'var(--fg-muted)', fontSize: '12px' }}>
            <IconLayers size={14} />
            <span>
              {t('迭代轮次:', 'Iterations:')}{' '}
              <strong style={{ color: 'var(--fg)' }}>{iterations}</strong>
            </span>
          </div>

          <div className="row" style={{ gap: '6px', color: 'var(--fg-muted)', fontSize: '12px' }}>
            <IconWrench size={14} />
            <span>
              {t('工具调用:', 'Tool Calls:')}{' '}
              <strong style={{ color: 'var(--fg)' }}>{tool_call_count}</strong>
            </span>
          </div>
        </div>
      </div>

      {/* 2. Active HITL Interactive Cards */}
      {activeInteraction && (
        <div
          className={`hitl-card ${
            activeInteraction.interaction_type === 'ask_human'
              ? 'hitl-card-ask'
              : activeInteraction.interaction_type === 'confirmation'
              ? 'hitl-card-confirm'
              : 'hitl-card-pause'
          }`}
        >
          {activeInteraction.interaction_type === 'ask_human' && (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="row" style={{ gap: '6px', fontWeight: 600, color: 'var(--accent-strong)', fontSize: '14px' }}>
                  <IconBot size={18} />
                  <span>{t('AI 向您提问 / 请求输入', 'AI Requests Human Clarification')}</span>
                </div>
                <span className="badge badge-accent">
                  {t(`第 ${activeInteraction.step_index || 1} 轮`, `Step ${activeInteraction.step_index || 1}`)}
                </span>
              </div>

              <div
                style={{
                  background: 'var(--bg)',
                  padding: '12px',
                  borderRadius: '6px',
                  border: '1px solid var(--accent-border)',
                  fontSize: '13px',
                  lineHeight: 1.6,
                  color: 'var(--fg)',
                  fontWeight: 500,
                }}
              >
                {activeInteraction.prompt}
              </div>

              <div className="col" style={{ gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 600 }}>
                  {t('您的回复 / 参数输入 (Submit your response):', 'Your Reply / Input:')}
                </label>
                <textarea
                  rows={3}
                  value={humanInputText}
                  onChange={(e) => setHumanInputText(e.target.value)}
                  placeholder={t(
                    '输入补充信息、参数数值或指示内容...',
                    'Type your answer, missing parameter values, or instructions here...'
                  )}
                  style={{ background: 'var(--bg)', width: '100%' }}
                />
              </div>

              <div className="row" style={{ justifyContent: 'flex-end', gap: '8px' }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={submittingInteraction || !humanInputText.trim()}
                  onClick={handleSubmitAskHuman}
                  style={{ minWidth: '110px' }}
                >
                  <IconSend size={13} />
                  {submittingInteraction ? t('提交中...', 'Submitting...') : t('提交回复并继续', 'Submit & Continue')}
                </button>
              </div>
            </>
          )}

          {activeInteraction.interaction_type === 'confirmation' && (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="row" style={{ gap: '6px', fontWeight: 600, color: 'var(--warn)', fontSize: '14px' }}>
                  <IconShield size={18} />
                  <span>{t('敏感工具调用审批 (Approval Required)', 'Human Approval Required for Tool Call')}</span>
                </div>
                <span className="badge badge-warn">
                  {activeInteraction.tool_name || activeInteraction.tool_id}
                </span>
              </div>

              <div style={{ fontSize: '13px', color: 'var(--fg)' }}>
                {activeInteraction.prompt}
              </div>

              {activeInteraction.input_args && (
                <div className="col" style={{ gap: '4px' }}>
                  <span style={{ fontSize: '11px', color: 'var(--fg-muted)' }}>{t('即将执行的参数 Payload:', 'Pending Input Arguments:')}</span>
                  <div className="code-block" style={{ maxHeight: '160px' }}>
                    {typeof activeInteraction.input_args === 'object'
                      ? JSON.stringify(activeInteraction.input_args, null, 2)
                      : String(activeInteraction.input_args)}
                  </div>
                </div>
              )}

              <div className="col" style={{ gap: '6px' }}>
                <input
                  type="text"
                  value={rejectReasonText}
                  onChange={(e) => setRejectReasonText(e.target.value)}
                  placeholder={t('拒绝理由 / 纠偏说明 (可选，若拒绝将作为反馈传给大模型反思)', 'Rejection reason / feedback (optional if rejecting)...')}
                  style={{ background: 'var(--bg)', fontSize: '12px' }}
                />
              </div>

              <div className="row" style={{ justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  type="button"
                  className="btn btn-danger"
                  disabled={submittingInteraction}
                  onClick={handleRejectTool}
                >
                  <IconX size={13} />
                  {t('拒绝执行 (Reject)', 'Reject Call')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={submittingInteraction}
                  onClick={handleApproveTool}
                  style={{ background: 'var(--ok)', borderColor: 'var(--ok)' }}
                >
                  <IconCheck size={13} />
                  {t('批准执行 (Approve)', 'Approve & Execute')}
                </button>
              </div>
            </>
          )}

          {activeInteraction.interaction_type === 'step_pause' && (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="row" style={{ gap: '6px', fontWeight: 600, color: 'var(--info)', fontSize: '14px' }}>
                  <IconPause size={18} />
                  <span>{t('单步调试暂停 (Step-by-Step Debug Paused)', 'Step-by-Step Debug Paused')}</span>
                </div>
                <span className="badge badge-accent">
                  {t(`Step ${activeInteraction.step_index || 1}`, `Step ${activeInteraction.step_index || 1}`)}
                </span>
              </div>

              <div style={{ fontSize: '13px', color: 'var(--fg)' }}>
                {activeInteraction.prompt}
              </div>

              <div className="row" style={{ justifyContent: 'flex-end', gap: '10px', marginTop: '4px' }}>
                <button
                  type="button"
                  className="btn"
                  disabled={submittingInteraction}
                  onClick={() => handleStepDebugAction('run_to_end')}
                >
                  <IconPlay size={13} />
                  {t('执行到底 (Run to End)', 'Run to End')}
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={submittingInteraction}
                  onClick={() => handleStepDebugAction('next_step')}
                >
                  <IconActivity size={13} />
                  {t('单步推进 (Next Step)', 'Next Step')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {/* 2.5 Recently Submitted Human Interaction Card */}
      {recentInteractions.length > 0 && !activeInteraction && (
        <div className="hitl-card hitl-card-confirm" style={{ borderLeft: '3px solid var(--ok)', background: 'var(--ok-soft)' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="row" style={{ gap: '6px', fontWeight: 600, color: 'var(--ok)', fontSize: '13px' }}>
              <IconCheckCircle size={16} />
              <span>{t('人工协同决策已提交，Agent 正在继续推进...', 'Human Decision Submitted, Agent Resuming...')}</span>
            </div>
            <span className="badge badge-ok animate-pulse" style={{ fontSize: '11px' }}>
              <IconClock size={11} />
              {t('恢复执行中', 'Resumed')}
            </span>
          </div>
          {recentInteractions.map((item, idx) => (
            <div key={idx} style={{ marginTop: '8px', fontSize: '12px', background: 'var(--bg)', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--border)' }}>
              <div style={{ color: 'var(--fg-muted)', fontSize: '11px', marginBottom: '2px' }}>
                {t('提问 / 事项:', 'Prompt / Action:')}
              </div>
              <div style={{ fontWeight: 500, color: 'var(--fg)' }}>{item.prompt}</div>
              <div style={{ color: 'var(--fg-muted)', fontSize: '11px', marginTop: '6px', marginBottom: '2px' }}>
                {t('你的回复 / 决策:', 'Your Response / Decision:')}
              </div>
              <div style={{ fontWeight: 600, color: 'var(--accent-strong)' }}>{item.user_response}</div>
            </div>
          ))}
        </div>
      )}


      {/* 3. Live Streaming Reasoning & Executing Tool Card */}
      {(liveReasoning || liveContent || executingTool || completedLiveTools.length > 0) && (
        <div className="card" style={{ border: '1px dashed var(--accent)', background: 'var(--accent-soft)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="row" style={{ gap: '6px', color: 'var(--accent-strong)', fontWeight: 600 }}>
              <IconBrain size={16} className="animate-pulse" />
              <span>{t('正在实时思考与执行 (Streaming Reasoning)...', 'Agent Reasoning in Progress...')}</span>
            </div>
            {executingTool && (
              <span className="badge badge-accent animate-pulse">
                <IconWrench size={12} />
                {t(`正在调用: ${executingTool.tool_name}`, `Invoking: ${executingTool.tool_name}`)}
              </span>
            )}
          </div>

          {liveReasoning && (
            <div className="reasoning-box" style={{ marginTop: '4px', background: 'var(--bg)' }}>
              <div style={{ fontWeight: 600, fontSize: '11px', color: 'var(--accent-strong)', marginBottom: '4px' }}>
                {t('思维链 (Chain of Thought):', 'Reasoning Trace:')}
              </div>
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {liveReasoning}
                <span className="animate-pulse" style={{ color: 'var(--accent)', fontWeight: 'bold' }}>▊</span>
              </div>
            </div>
          )}

          {liveContent && (
            <div style={{ fontSize: '13px', color: 'var(--fg)', whiteSpace: 'pre-wrap', marginTop: '6px' }}>
              {liveContent}
            </div>
          )}

          {completedLiveTools.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--accent-strong)' }}>
                {t('本轮已完成工具调用 (Completed Tool Invocations):', 'Completed Tool Invocations:')}
              </div>
              {completedLiveTools.map((tool, idx) => (
                <div key={idx} className="tool-call-card" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div className="row" style={{ gap: '6px' }}>
                      <IconWrench size={13} style={{ color: tool.success ? 'var(--ok)' : 'var(--danger)' }} />
                      <strong style={{ fontSize: '12px' }}>{tool.tool_name || tool.tool_id}</strong>
                    </div>
                    <div className="row" style={{ gap: '6px' }}>
                      <span className={`badge ${tool.success ? 'badge-ok' : 'badge-danger'}`}>
                        {tool.success ? <IconCheck size={10} /> : <IconX size={10} />}
                        {tool.success ? t('执行成功', 'Success') : t('执行失败', 'Failed')}
                      </span>
                      <span style={{ fontSize: '11px', color: 'var(--fg-soft)' }}>
                        {tool.duration_ms}ms
                      </span>
                    </div>
                  </div>
                  {tool.output !== undefined && (
                    <div style={{ marginTop: '6px' }}>
                      <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
                        {t('执行结果 (Output Data):', 'Output Data:')}
                      </div>
                      <div className="code-block" style={{ maxHeight: '160px', overflowY: 'auto' }}>
                        {typeof tool.output === 'object' && tool.output !== null
                          ? JSON.stringify(tool.output, null, 2)
                          : String(tool.output)}
                      </div>
                    </div>
                  )}
                  {tool.error && (
                    <div style={{ marginTop: '6px', color: 'var(--danger)', fontSize: '11px' }}>
                      {tool.error}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 4. Final Answer Card */}
      {final_answer && (
        <div className="card" style={{ borderLeft: '3px solid var(--accent)' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="card-title" style={{ color: 'var(--accent-strong)' }}>
              <IconSparkles size={16} />
              {t('最终结论与执行结果 (Final Answer)', 'Final Answer & Summary')}
            </div>
            <button type="button" className="btn btn-sm" onClick={handleCopyAnswer}>
              <IconCopy size={12} />
              {copiedAnswer ? t('已复制', 'Copied') : t('复制结论', 'Copy Answer')}
            </button>
          </div>
          <div
            style={{
              fontSize: '13px',
              lineHeight: 1.6,
              color: 'var(--fg)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {final_answer}
          </div>
        </div>
      )}

      {/* 5. Thinking Timeline Detail */}
      <div className="card">
        <div className="card-title">
          <IconBrain size={16} />
          {t('决策时间线 (Thinking Timeline)', 'Thinking Timeline & Action Trace')} (
          {timeline.length} {t('步', 'Steps')})
        </div>

        <div style={{ marginTop: '10px' }}>
          {timeline.map((step, idx) => (
            <div key={step.step_index || idx} className="timeline-item">
              <div
                className={`timeline-node ${
                  step.step_type === 'interrupted'
                    ? 'ok'
                    : step.self_correction
                    ? 'correction'
                    : step.step_type === 'error'
                    ? 'error'
                    : 'ok'
                }`}
              >
                {step.step_index || idx + 1}
              </div>

              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="row" style={{ gap: '6px', flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 600, fontSize: '13px' }}>
                    {t(`Round ${step.step_index || idx + 1}`, `Round ${step.step_index || idx + 1}`)}
                  </span>
                  {step.step_type === 'interrupted' && (
                    <span className="badge badge-ok">
                      <IconUser size={11} />
                      {t('人类中途插话/纠偏', 'Human Interruption')}
                    </span>
                  )}
                  {step.self_correction && (
                    <span
                      className="badge badge-warn animate-pulse"
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontSize: '11px',
                        fontWeight: 600,
                        background: 'rgba(245, 158, 11, 0.18)',
                        color: '#D97706',
                        border: '1px solid rgba(245, 158, 11, 0.5)',
                        boxShadow: '0 0 6px rgba(245, 158, 11, 0.25)',
                      }}
                    >
                      <IconRotateCcw size={11} />
                      {t('自愈修复 (Self-Correction & Healed)', 'Self-Correction & Healed')}
                    </span>
                  )}
                  {step.step_type === 'final_answer' && (
                    <span className="badge badge-ok">
                      <IconCheck size={10} />
                      {t('收敛结论', 'Final Answer')}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--fg-soft)' }}>
                  {step.duration_ms}ms
                  {step.tokens?.total_tokens ? ` · ${step.tokens.total_tokens} tokens` : ''}
                </div>
              </div>

              {/* Thought / Reasoning or Human Interruption content */}
              {step.thought && step.step_type === 'interrupted' ? (
                <div className="hitl-card hitl-card-interrupted" style={{ marginTop: '6px' }}>
                  <div className="row" style={{ gap: '6px', fontWeight: 600, color: 'var(--ok)', fontSize: '12px' }}>
                    <IconUser size={14} />
                    <span>{t('人类中途插话 / 纠偏指令 (Human Directive):', 'Human Directive / Steering:')}</span>
                  </div>
                  <div style={{ fontSize: '13px', lineHeight: 1.5, color: 'var(--fg)', fontWeight: 500 }}>
                    {step.thought}
                  </div>
                </div>
              ) : step.thought ? (
                <div className="reasoning-box">
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '11px',
                      color: 'var(--accent-strong)',
                      marginBottom: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <IconBrain size={12} />
                      <span>{t('思维链 (Chain-of-Thought / Reasoning):', 'Reasoning / Thought:')}</span>
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '1px 6px',
                        fontSize: '10px',
                        height: 'auto',
                        background: 'transparent',
                        borderColor: 'var(--border)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '3px',
                      }}
                      onClick={() => toggleThought(step.step_index || idx)}
                    >
                      <IconChevronDown
                        size={11}
                        style={{
                          transform: collapsedThoughts[step.step_index || idx] ? 'rotate(-90deg)' : 'none',
                          transition: 'transform 0.15s ease',
                        }}
                      />
                      {collapsedThoughts[step.step_index || idx]
                        ? t('展开思维链', 'Expand')
                        : t('折叠思维链', 'Collapse')}
                    </button>
                  </div>
                  {!collapsedThoughts[step.step_index || idx] && (
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{step.thought}</div>
                  )}
                </div>
              ) : null}
              {/* Tool Calls in this step */}
              {step.tool_calls && step.tool_calls.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                  {step.tool_calls.map((tc, tcIdx) => (
                    <div key={tc.call_id || tcIdx} className="tool-call-card">
                      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
                        <div className="row" style={{ gap: '6px' }}>
                          {tc.tool_name === 'ask_human' ? <IconBot size={14} /> : <IconWrench size={14} />}
                          <strong style={{ fontSize: '12px' }}>{tc.tool_name || tc.tool_id}</strong>
                          {(() => {
                            const meta = getNodeTypeBadge(tc.node_type);
                            return (
                              <span
                                className="badge"
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                  fontSize: '10px',
                                  fontWeight: 600,
                                  color: meta.color,
                                  background: meta.bg,
                                  border: `1px solid ${meta.border}`,
                                }}
                              >
                                {meta.icon}
                                {meta.label}
                              </span>
                            );
                          })()}
                        </div>
                        <span
                          className={`badge ${tc.success ? 'badge-ok' : 'badge-danger'}`}
                        >
                          {tc.success ? t('执行成功', 'Success') : t('执行失败', 'Failed')}
                          {' '}({tc.duration_ms}ms)
                        </span>
                      </div>
                      {tc.tool_name === 'ask_human' ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                          {/* AI Question */}
                          <div
                            style={{
                              background: 'var(--accent-soft)',
                              border: '1px solid var(--accent-border)',
                              borderRadius: '6px',
                              padding: '8px 10px',
                            }}
                          >
                            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--accent-strong)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                              <IconBot size={13} />
                              <span>{t('AI 提问内容 (Question):', 'AI Question:')}</span>
                            </div>
                            <div style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--fg)', whiteSpace: 'pre-wrap' }}>
                              {typeof tc.input_args === 'object' && tc.input_args !== null && (tc.input_args as Record<string, unknown>).question
                                ? String((tc.input_args as Record<string, unknown>).question)
                                : typeof tc.input_args === 'string'
                                ? tc.input_args
                                : JSON.stringify(tc.input_args, null, 2)}
                            </div>
                          </div>

                          {/* User Response */}
                          <div
                            style={{
                              background: 'var(--ok-soft)',
                              border: '1px solid var(--ok)',
                              borderRadius: '6px',
                              padding: '8px 10px',
                            }}
                          >
                            <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--ok)', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}>
                              <IconUser size={13} />
                              <span>{t('您的回复内容 (Your Response):', 'Your Response:')}</span>
                            </div>
                            <div style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--fg)', fontWeight: 500, whiteSpace: 'pre-wrap' }}>
                              {typeof tc.output_data === 'object' && tc.output_data !== null && ((tc.output_data as Record<string, unknown>).user_response || (tc.output_data as Record<string, unknown>).answer)
                                ? String((tc.output_data as Record<string, unknown>).user_response || (tc.output_data as Record<string, unknown>).answer)
                                : tc.raw_response
                                ? tc.raw_response
                                : typeof tc.output_data === 'string'
                                ? tc.output_data
                                : JSON.stringify(tc.output_data, null, 2)}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                          {/* Arguments Payload */}
                          <div>
                            <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
                              {t('入参 Payload:', 'Input Arguments:')}
                            </div>
                            <div className="code-block">
                              {typeof tc.input_args === 'object'
                                ? JSON.stringify(tc.input_args, null, 2)
                                : String(tc.input_args)}
                            </div>
                          </div>

                          {/* Result Drawer */}
                          <div
                            style={{
                              borderTop: '1px solid var(--border)',
                              paddingTop: '6px',
                              marginTop: '2px',
                            }}
                          >
                            <div
                              onClick={() => toggleResult(tc.call_id)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                cursor: 'pointer',
                                padding: '4px 0',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: '11px',
                                  fontWeight: 600,
                                  color: 'var(--fg)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '4px',
                                }}
                              >
                                <IconChevronDown
                                  size={12}
                                  style={{
                                    transform: (expandedResults[tc.call_id] ?? !tc.success)
                                      ? 'none'
                                      : 'rotate(-90deg)',
                                    transition: 'transform 0.15s ease',
                                  }}
                                />
                                {t('执行结果抽屉 (Result Drawer)', 'Result Drawer')}
                              </span>
                              <span style={{ fontSize: '10px', color: 'var(--fg-soft)' }}>
                                {(expandedResults[tc.call_id] ?? !tc.success)
                                  ? t('点击收起', 'Collapse')
                                  : t('点击展开查看宿主真实输出', 'Expand Result')}
                              </span>
                            </div>

                            {(expandedResults[tc.call_id] ?? !tc.success) && (
                              <div
                                style={{
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: '6px',
                                  marginTop: '6px',
                                }}
                              >
                                {tc.output_data !== undefined && (
                                  <div>
                                    <div
                                      style={{
                                        fontSize: '10px',
                                        color: 'var(--fg-muted)',
                                        marginBottom: '2px',
                                        fontWeight: 600,
                                      }}
                                    >
                                      {t('结构化输出 (Parsed JSON):', 'Structured Output:')}
                                    </div>
                                    <div className="code-block" style={{ maxHeight: '180px' }}>
                                      {typeof tc.output_data === 'object'
                                        ? JSON.stringify(tc.output_data, null, 2)
                                        : String(tc.output_data)}
                                    </div>
                                  </div>
                                )}

                                {tc.raw_response && (
                                  <div>
                                    <div
                                      style={{
                                        fontSize: '10px',
                                        color: 'var(--fg-muted)',
                                        marginBottom: '2px',
                                        fontWeight: 600,
                                      }}
                                    >
                                      {t('宿主原生返回 (Raw Response):', 'Raw Host Response:')}
                                    </div>
                                    <div
                                      className="code-block"
                                      style={{ maxHeight: '140px', background: 'var(--bg-subtle)' }}
                                    >
                                      {tc.raw_response}
                                    </div>
                                  </div>
                                )}

                                {tc.error_message && (
                                  <div>
                                    <div
                                      style={{
                                        fontSize: '10px',
                                        color: 'var(--danger)',
                                        marginBottom: '2px',
                                        fontWeight: 600,
                                      }}
                                    >
                                      {t('错误详情 (Error Detail):', 'Error Detail:')}
                                    </div>
                                    <div
                                      className="code-block"
                                      style={{
                                        borderColor: 'var(--danger)',
                                        color: 'var(--danger)',
                                        background: 'var(--danger-soft)',
                                      }}
                                    >
                                      {tc.error_message}
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Active In-Progress Round inside Timeline */}
          {(liveReasoning || liveContent || executingTool || recentInteractions.length > 0 || completedLiveTools.length > 0) && (
            <div className="timeline-item" style={{ borderLeftStyle: 'dashed', borderLeftColor: 'var(--accent)' }}>
              <div className="timeline-node ok animate-pulse" style={{ borderColor: 'var(--accent)', background: 'var(--accent-soft)' }}>
                {timeline.length + 1}
              </div>

              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="row" style={{ gap: '6px' }}>
                  <span style={{ fontWeight: 600, fontSize: '13px', color: 'var(--accent-strong)' }}>
                    {t(`Round ${timeline.length + 1} (正在执行)`, `Round ${timeline.length + 1} (In Progress)`)}
                  </span>
                  <span className="badge badge-accent animate-pulse">
                    <IconBrain size={12} />
                    {executingTool
                      ? t(`调用工具: ${executingTool.tool_name}`, `Tool: ${executingTool.tool_name}`)
                      : recentInteractions.length > 0
                      ? t('人工决策已提交，推进中', 'Human Input Submitted, Resuming...')
                      : completedLiveTools.length > 0
                      ? t('工具执行完毕，继续推理', 'Tool Completed, Continuing...')
                      : t('大模型思考中', 'Thinking...')}
                  </span>
                </div>
              </div>

              {/* Submitted Human Interaction inside Timeline */}
              {recentInteractions.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                  {recentInteractions.map((item, idx) => (
                    <div key={idx} className="tool-call-card" style={{ border: '1px solid var(--ok)', background: 'var(--ok-soft)' }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div className="row" style={{ gap: '6px' }}>
                          <IconBot size={14} />
                          <strong style={{ fontSize: '12px' }}>{item.tool_name || 'ask_human'}</strong>
                        </div>
                        <span className="badge badge-ok">
                          <IconCheck size={10} />
                          {t('已提交回复', 'Submitted')}
                        </span>
                      </div>
                      <div style={{ marginTop: '6px', fontSize: '12px' }}>
                        <div style={{ color: 'var(--fg-muted)', fontSize: '11px', marginBottom: '2px' }}>
                          {t('提问内容:', 'Question:')}
                        </div>
                        <div style={{ fontWeight: 500, color: 'var(--fg)' }}>{item.prompt}</div>
                        <div style={{ color: 'var(--fg-muted)', fontSize: '11px', marginTop: '6px', marginBottom: '2px' }}>
                          {t('用户输入 / 决策:', 'User Response / Decision:')}
                        </div>
                        <div style={{ fontWeight: 600, color: 'var(--accent-strong)' }}>{item.user_response}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Completed Live Tools inside Timeline */}
              {completedLiveTools.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' }}>
                  {completedLiveTools.map((tool, idx) => (
                    <div key={idx} className="tool-call-card" style={{ background: 'var(--bg)', border: '1px solid var(--border)' }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div className="row" style={{ gap: '6px' }}>
                          <IconWrench size={13} style={{ color: tool.success ? 'var(--ok)' : 'var(--danger)' }} />
                          <strong style={{ fontSize: '12px' }}>{tool.tool_name || tool.tool_id}</strong>
                        </div>
                        <div className="row" style={{ gap: '6px' }}>
                          <span className={`badge ${tool.success ? 'badge-ok' : 'badge-danger'}`}>
                            {tool.success ? <IconCheck size={10} /> : <IconX size={10} />}
                            {tool.success ? t('执行成功', 'Success') : t('执行失败', 'Failed')}
                          </span>
                          <span style={{ fontSize: '11px', color: 'var(--fg-soft)' }}>
                            {tool.duration_ms}ms
                          </span>
                        </div>
                      </div>
                      {tool.output !== undefined && (
                        <div style={{ marginTop: '6px' }}>
                          <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
                            {t('执行结果 (Output Data):', 'Output Data:')}
                          </div>
                          <div className="code-block" style={{ maxHeight: '160px', overflowY: 'auto' }}>
                            {typeof tool.output === 'object' && tool.output !== null
                              ? JSON.stringify(tool.output, null, 2)
                              : String(tool.output)}
                          </div>
                        </div>
                      )}
                      {tool.error && (
                        <div style={{ marginTop: '6px', color: 'var(--danger)', fontSize: '11px' }}>
                          {tool.error}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Streaming Thought / Reasoning */}
              {liveReasoning && (
                <div className="reasoning-box" style={{ marginTop: '8px' }}>
                  <div style={{ fontWeight: 600, fontSize: '11px', color: 'var(--accent-strong)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <IconBrain size={12} />
                    {t('实时思维链 (Streaming CoT):', 'Streaming Reasoning Trace:')}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                    {liveReasoning}
                    <span className="animate-pulse" style={{ color: 'var(--accent)', fontWeight: 'bold' }}>▊</span>
                  </div>
                </div>
              )}

              {/* Streaming Content */}
              {liveContent && (
                <div style={{ fontSize: '13px', color: 'var(--fg)', whiteSpace: 'pre-wrap', marginTop: '6px' }}>
                  {liveContent}
                </div>
              )}

              {/* Executing Tool Card */}
              {executingTool && (
                <div className="tool-call-card" style={{ border: '1px solid var(--accent)', background: 'var(--accent-soft)', marginTop: '8px' }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div className="row" style={{ gap: '6px' }}>
                      <IconWrench size={14} className="animate-pulse" />
                      <strong style={{ fontSize: '12px' }}>{executingTool.tool_name || executingTool.tool_id}</strong>
                    </div>
                    <span className="badge badge-accent animate-pulse">
                      <IconClock size={11} />
                      {t('正在执行...', 'Executing...')}
                    </span>
                  </div>
                  {executingTool.input_args !== undefined && (
                    <div>
                      <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
                        {t('入参 Payload:', 'Input Arguments:')}
                      </div>
                      <div className="code-block" style={{ background: 'var(--bg)' }}>
                        {typeof executingTool.input_args === 'object'
                          ? JSON.stringify(executingTool.input_args, null, 2)
                          : String(executingTool.input_args)}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* 6. Mid-flight Smooth Interruption / Steering Bar (Only visible while agent is running) */}
      {!isFinished && (
        <div className="card" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="row" style={{ gap: '6px', fontWeight: 600, fontSize: '13px' }}>
              <IconZap size={16} style={{ color: 'var(--accent)' }} />
              <span>{t('中途补充要求 / 纠偏插话 (Steer Agent)', 'Steer Agent (Mid-flight Interruption)')}</span>
            </div>
            {interruptionNotice && (
              <span className="badge badge-ok animate-pulse" style={{ fontSize: '11px' }}>
                {interruptionNotice}
              </span>
            )}
          </div>

          <div className="row" style={{ gap: '8px', marginTop: '6px' }}>
            <input
              type="text"
              value={interruptionText}
              onChange={(e) => setInterruptionText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleSendInterruption();
                }
              }}
              placeholder={t(
                '在执行中途输入补充要求或纠偏指令（如"请优先检查最近一小时的错误日志"）...',
                'Type steering instructions to inject at the next reasoning step...'
              )}
              style={{ flex: 1, minWidth: 0, background: 'var(--bg)' }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={!interruptionText.trim()}
              onClick={handleSendInterruption}
              style={{ flexShrink: 0 }}
            >
              <IconSend size={13} />
              {t('发送指令', 'Send Directive')}
            </button>
          </div>
        </div>
      )}
      {/* 7. Raw JSON Modal / Section */}
      {showRawJson && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="card-title">
              <IconCode size={16} />
              {t('完整原始执行产物 (Raw Output JSON)', 'Complete Raw JSON Data')}
            </div>
          </div>
          <div className="code-block" style={{ maxHeight: '320px' }}>
            {JSON.stringify(output, null, 2)}
          </div>
        </div>
      )}
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<ViewerApp />);
