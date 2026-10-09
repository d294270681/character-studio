import Icon from './Icon.jsx';
import { STAGE_LABELS, STAGES } from '../lib/studio.js';
import {
  assistantActive, assistantStatusKind, assistantStatusLabel, stepProgress, stepStatusKind, stepStatusLabel,
} from '../lib/workflow.js';

export default function WorkflowCard({ assistant, jobs, onCancel, onOpenStage }) {
  if (!assistant) return null;
  const running = assistantActive(assistant);
  const message = assistant.message || '';
  const progress = stepProgress(assistant, jobs);
  const maximum = progress?.maximum || 0;
  const value = progress?.value || 0;
  const percent = maximum > 0 ? Math.min(100, Math.round((value / maximum) * 100)) : 0;

  return (
    <section className={`workflow-card${running ? ' is-running' : ''}`} data-testid="assistant-workflow">
      <div className="wf-head">
        <span className="wf-title">
          <Icon name="robot" size={15} />
          Kimi 工作流
        </span>
        <span className={`wf-status ${assistantStatusKind(assistant.status)}`}>
          {assistantStatusLabel(assistant.status) || '待执行'}
        </span>
        {message && <span className="wf-message" title={message}>{message}</span>}
        {running && (
          <button type="button" className="btn ghost small" data-testid="workflow-cancel" onClick={onCancel}>
            <Icon name="close" size={15} />
            <span>停止工作流</span>
          </button>
        )}
      </div>

      <div className="wf-steps">
        {assistant.stages.map(stage => {
          const step = assistant.steps.find(item => item.stage === stage);
          const status = step?.status || 'pending';
          const kind = stepStatusKind(status);
          const isCurrent = assistant.currentStage === stage;
          return (
            <button
              key={stage}
              type="button"
              className={`wf-step ${kind}${isCurrent ? ' is-current' : ''}`}
              data-testid={`workflow-step-${stage}`}
              data-stage={stage}
              data-status={status}
              onClick={() => onOpenStage(STAGES.indexOf(stage))}
              title={`${STAGE_LABELS[stage]} · ${stepStatusLabel(status)}`}
            >
              <span className="wf-step-index">{String(STAGES.indexOf(stage) + 1).padStart(2, '0')}</span>
              <span className="wf-step-label">{STAGE_LABELS[stage]}</span>
              <span className="wf-step-state">{stepStatusLabel(status)}</span>
              {(kind === 'busy') && <span className="wf-spinner" />}
            </button>
          );
        })}
      </div>

      {running && maximum > 0 && (
        <div className="wf-progress">
          <div className="wf-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
    </section>
  );
}
