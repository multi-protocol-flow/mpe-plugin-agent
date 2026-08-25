import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initBridge, postResize } from './bridge';
import { t } from './i18n';
import {
  IconBarChart,
  IconBrain,
  IconCheck,
  IconCheckCircle,
  IconClock,
  IconCopy,
  IconLayers,
  IconRotateCcw,
  IconSparkles,
  IconWrench,
  IconXCircle,
} from './icons';
import './styles.css';
import type { AgentReactOutput } from './types';

function ViewerApp() {
  const [output, setOutput] = useState<AgentReactOutput | null>(null);
  const [copiedAnswer, setCopiedAnswer] = useState(false);
  const [copiedRaw, setCopiedRaw] = useState(false);
  const [showRawJson, setShowRawJson] = useState(false);

  useEffect(() => {
    const unbind = initBridge({
      onInit: (config, _nodes, initPayload) => {
        const payload = initPayload || (config as unknown as Record<string, unknown>);
        const nodeReport = (payload?.node_report || {}) as Record<string, unknown>;
        const candidate = payload?.reportData
          || payload?.outputData
          || nodeReport?.plugin_data
          || nodeReport?.output_data
          || config;

        if (candidate && typeof candidate === 'object' && Object.keys(candidate).length > 0) {
          setOutput(candidate as unknown as AgentReactOutput);
        }
      },
      onExecutionUpdate: (data) => {
        if (data && typeof data === 'object') {
          setOutput(data as AgentReactOutput);
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
  }, [output, showRawJson]);
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

  if (!output) {
    return (
      <div className="panel" style={{ textAlign: 'center', padding: '40px 20px' }}>
        <div style={{ color: 'var(--fg-soft)', fontSize: '13px' }}>
          {t('等待 Agent 执行产物或加载中...', 'Waiting for Agent execution output...')}
        </div>
      </div>
    );
  }

  const {
    success,
    final_answer,
    iterations,
    tool_call_count,
    self_corrections_count,
    token_usage,
    total_duration_ms,
    timeline = [],
  } = output;

  return (
    <div className="panel">
      {/* 1. KPI Metric Dashboard */}
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="row" style={{ gap: '8px' }}>
            <span
              className={`badge ${success ? 'badge-ok' : 'badge-danger'}`}
              style={{ fontSize: '12px', padding: '3px 10px' }}
            >
              {success ? <IconCheckCircle size={14} /> : <IconXCircle size={14} />}
              {success ? t('目标收敛达成', 'Goal Converged') : t('执行失败 / 未收敛', 'Failed / Diverged')}
            </span>
            {self_corrections_count > 0 && (
              <span className="badge badge-warn" style={{ fontSize: '12px', padding: '3px 10px' }}>
                <IconRotateCcw size={14} />
                {t(`自我修复: ${self_corrections_count} 次`, `Self-Corrections: ${self_corrections_count}`)}
              </span>
            )}
          </div>
          <div className="row" style={{ gap: '6px' }}>
            <button type="button" className="btn btn-sm" onClick={handleCopyRaw}>
              <IconCopy size={12} />
              {copiedRaw ? t('已复制', 'Copied') : t('复制 Raw JSON', 'Copy Raw JSON')}
            </button>
          </div>
        </div>

        <div className="row" style={{ gap: '16px', marginTop: '4px', flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: '6px', color: 'var(--fg-muted)', fontSize: '12px' }}>
            <IconClock size={14} />
            <span>
              {t('总耗时:', 'Duration:')}{' '}
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

      {/* 2. Final Answer Card */}
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

      {/* 3. Thinking Timeline Detail */}
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
                  step.self_correction
                    ? 'correction'
                    : step.step_type === 'error'
                    ? 'error'
                    : 'ok'
                }`}
              >
                {step.step_index || idx + 1}
              </div>

              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="row" style={{ gap: '6px' }}>
                  <span style={{ fontWeight: 600, fontSize: '13px' }}>
                    {t(`Round ${step.step_index || idx + 1}`, `Round ${step.step_index || idx + 1}`)}
                  </span>
                  {step.self_correction && (
                    <span className="badge badge-warn">
                      <IconRotateCcw size={10} />
                      {t('自我修复', 'Self-Correction')}
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

              {/* Thought / Reasoning content */}
              {step.thought && (
                <div className="reasoning-box">
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: '11px',
                      color: 'var(--accent-strong)',
                      marginBottom: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px',
                    }}
                  >
                    <IconBrain size={12} />
                    {t('思维链 (Chain-of-Thought / Reasoning):', 'Reasoning / Thought:')}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{step.thought}</div>
                </div>
              )}

              {/* Tool Calls in this step */}
              {step.tool_calls && step.tool_calls.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '8px' }}>
                  {step.tool_calls.map((tc, tcIdx) => (
                    <div key={tc.call_id || tcIdx} className="tool-call-card">
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <div className="row" style={{ gap: '6px' }}>
                          <IconWrench size={14} />
                          <strong style={{ fontSize: '12px' }}>{tc.tool_name || tc.tool_id}</strong>
                          <span className="badge badge-accent">{tc.node_type}</span>
                        </div>
                        <span
                          className={`badge ${tc.success ? 'badge-ok' : 'badge-danger'}`}
                        >
                          {tc.success ? t('执行成功', 'Success') : t('执行失败', 'Failed')}
                          {' '}({tc.duration_ms}ms)
                        </span>
                      </div>

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

                      {/* Tool Response or Error */}
                      {tc.error_message ? (
                        <div>
                          <div style={{ fontSize: '11px', color: 'var(--danger)', marginBottom: '2px' }}>
                            {t('底层报错 (Error Context):', 'Error Context:')}
                          </div>
                          <div
                            className="code-block"
                            style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}
                          >
                            {tc.error_message}
                          </div>
                        </div>
                      ) : (
                        <div>
                          <div style={{ fontSize: '11px', color: 'var(--fg-muted)', marginBottom: '2px' }}>
                            {t('协议原始响应 (Raw Response):', 'Raw Response:')}
                          </div>
                          <div className="code-block">
                            {tc.output_data
                              ? JSON.stringify(tc.output_data, null, 2)
                              : tc.raw_response}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 4. Raw JSON Toggle */}
      <div className="card">
        <button
          type="button"
          className="btn"
          style={{ width: '100%', justifyContent: 'space-between' }}
          onClick={() => setShowRawJson((prev) => !prev)}
        >
          <span>{t('查看完整 Raw JSON 链路数据', 'View Full Raw JSON Trace Data')}</span>
          <span style={{ fontSize: '11px', color: 'var(--fg-soft)' }}>
            {showRawJson ? t('折叠 ▲', 'Collapse ▲') : t('展开 ▼', 'Expand ▼')}
          </span>
        </button>
        {showRawJson && (
          <div className="code-block" style={{ marginTop: '8px', maxHeight: '400px', overflowY: 'auto' }}>
            {JSON.stringify(output, null, 2)}
          </div>
        )}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<ViewerApp />);
