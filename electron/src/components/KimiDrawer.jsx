import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import ModelSelector from './ModelSelector.jsx';
import AdaptiveTextarea from './AdaptiveTextarea.jsx';
import ResizeHandle from './ResizeHandle.jsx';
import { STAGE_LABELS } from '../lib/studio.js';
import { WORKFLOW_CHOICES, isChain, stagesFromValue, stepStatusLabel } from '../lib/workflow.js';

const EXAMPLES = [
  { label: '生成人物候选', text: '整理一段完整人物提示词并生成 1 张候选：成年中国女性，长黑发，翡翠绿无袖长裙，金色鞋子，正面站立，完整露出头手脚，纯白背景，四周留白，清晰动漫插画。' },
  { label: '调整这一步的参数', text: '读取当前项目状态，把这一步的参数调到更合适的值，然后生成。' },
  { label: '优化行走动作', text: '我要生成向左行走的精灵图，请把动作提示词和视频参数调整好，再依次执行。' },
  { label: '跑完整流程', text: '按现在的人物设定，从原始图开始一路做到精灵图，中间的候选你替我挑最好的那个。' },
];

const TOOL_LABELS = {
  studio_get_state: '读取项目', studio_list_projects: '查看项目列表', studio_open_project: '打开项目',
  studio_create_project: '新建角色', studio_set_parameters: '调整参数', studio_prepare_generation: '准备生成方案',
  studio_generate: '启动生成', studio_job_status: '查看生成进度', studio_inspect_asset: '检查结果',
  studio_select_asset: '选定候选', studio_import_asset: '导入参考', studio_cancel_job: '取消任务',
  studio_export_godot: '导出到 Godot', ReadMediaFile: '查看图像或视频', Read: '读取记录',
};
const toolLabel = tool => TOOL_LABELS[String(tool).split('__').at(-1)] || '处理任务';

export default function KimiDrawer({
  open, onClose, status, running, progress, busy, messages, history, onSend, onCancel, onTerminal, onCopy, onRefreshStatus,
  catalog, catalogError, catalogLoading, selection, saving, toolBlocked, onChangeSelection, onRefreshCatalog,
  defaultStage, workflow, onOpenWorkflowStage, layout, onManageModels,
}) {
  const [choice, setChoice] = useState(defaultStage || 'original');
  const [prompt, setPrompt] = useState('');
  const scrollRef = useRef(null);
  const followMessagesRef = useRef(true);
  const touchedRef = useRef(false);

  useEffect(() => {
    if (!touchedRef.current && defaultStage) setChoice(defaultStage);
  }, [defaultStage]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && followMessagesRef.current) node.scrollTop = messages.length ? node.scrollHeight : 0;
  }, [messages, open]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (followMessagesRef.current && messages.length) node.scrollTop = node.scrollHeight;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [messages.length]);

  useEffect(() => {
    if (open) onRefreshStatus();
  }, [open, onRefreshStatus]);

  const stages = useMemo(() => stagesFromValue(choice), [choice]);
  const chain = isChain(choice);
  const sendDisabled = !prompt.trim() || busy || saving || toolBlocked || !status?.installed;

  const submit = async () => {
    const text = prompt.trim();
    if (!text || sendDisabled) return;
    const accepted = await onSend(text, stages);
    if (accepted === true) setPrompt(current => current.trim() === text ? '' : current);
  };

  const workflowSteps = workflow?.stages?.length
    ? workflow.stages.map(stage => ({
      stage,
      status: (workflow.steps.find(item => item.stage === stage) || {}).status || 'pending',
    }))
    : [];

  return (
    <div className={`drawer${open ? ' is-open' : ''}`} aria-hidden={!open} data-testid="kimi-drawer">
      <div className="drawer-head">
        <span className="drawer-title">
          <Icon name="robot" size={17} />
          Kimi 执行助手
        </span>
        <div className="drawer-head-actions">
          <span className={`pill${status?.installed ? (running ? ' busy' : ' ok') : ' bad'}`}>
            {status?.installed ? (running ? '执行中' : '已就绪') : '未安装'}
          </span>
          <button type="button" className="icon-btn" title={`打开 ${catalog?.models?.find(item => item.id === selection?.model)?.label || 'Kimi'} 交互终端`} onClick={onTerminal}>
            <Icon name="terminal" size={16} />
          </button>
          <button type="button" className="icon-btn" title="关闭" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      <div className="drawer-config">
      <div className="drawer-modes">
        <label className="ms-row wf-row">
          <span className="ms-label">执行步骤</span>
          <span className="selectfield">
            <select
              aria-label="执行步骤"
              data-testid="kimi-steps"
              value={choice}
              disabled={running}
              onChange={event => { touchedRef.current = true; setChoice(event.target.value); }}
            >
              {WORKFLOW_CHOICES.map(item => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
            <Icon name="chevronDown" size={14} className="select-caret" />
          </span>
        </label>
        <p className="drawer-note">
          {chain
            ? '中间候选由助手选用并全部保留，最终结果由你确认。'
            : '助手填写参数并执行本步，候选结果由你选用。'}
        </p>
      </div>

      {workflowSteps.length > 0 && (
        <div className="drawer-workflow" data-testid="kimi-workflow-summary">
          {workflowSteps.map(step => (
            <button
              key={step.stage}
              type="button"
              className={`wf-step ${step.status === 'complete' ? 'ok' : step.status === 'error' ? 'bad' : step.status === 'running' || step.status === 'preparing' ? 'busy' : 'pending'}`}
              onClick={() => onOpenWorkflowStage(step.stage)}
              title={`${STAGE_LABELS[step.stage]} · ${stepStatusLabel(step.status)}`}
            >
              <span className="wf-step-label">{STAGE_LABELS[step.stage]}</span>
              <span className="wf-step-state">{stepStatusLabel(step.status)}</span>
            </button>
          ))}
        </div>
      )}

      <ModelSelector
        catalog={catalog}
        error={catalogError}
        loading={catalogLoading}
        saving={saving}
        disabled={running}
        selection={selection}
        onChange={onChangeSelection}
        onRefresh={onRefreshCatalog}
        onManage={onManageModels}
      />
      </div>

      {running && progress && <div className="drawer-note drawer-status" role="status" data-testid="kimi-progress">
        {progress.label}{Number.isFinite(progress.elapsed_seconds) ? ` · 已用时 ${progress.elapsed_seconds} 秒` : ''}
        {progress.warning && <span className="drawer-progress-warning" data-testid="kimi-progress-warning">{progress.warning}</span>}
      </div>}
      <div className="drawer-body" ref={layout?.assistantBodyRef}>
      <div className="drawer-scroll" ref={scrollRef} onScroll={event => {
        const node = event.currentTarget;
        followMessagesRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      }}>
        {messages.length === 0 && (
          <div className="drawer-empty">
            <p>告诉 Kimi 你想要什么：它会读取项目、填写参数并直接执行你选中的步骤。</p>
            <div className="example-list">
              {EXAMPLES.map(example => (
                <div key={example.label} className="example">
                  <div className="example-text">
                    <strong>{example.label}</strong>
                    <span>{example.text}</span>
                  </div>
                  <button type="button" className="icon-btn" title="复制这段示例" onClick={() => onCopy(example.text)}>
                    <Icon name="copy" size={15} />
                  </button>
                  <button type="button" className="icon-btn" title="填入输入框" onClick={() => setPrompt(example.text)}>
                    <Icon name="arrowRight" size={15} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => (
          <div key={index} className={`bubble ${message.role === 'user' ? 'user' : 'assistant'}${message.kind ? ` ${message.kind}` : ''}`}>
            <div className="bubble-role">{message.role === 'user' ? '你' : 'Kimi'}</div>
            {message.tools?.length > 0 && (
              <div className="bubble-tools">
                {message.tools.map((tool, toolIndex) => <span key={`${tool}-${toolIndex}`} className="tool-chip">{toolLabel(tool)}</span>)}
              </div>
            )}
            {message.text && <div className="bubble-text">{message.text}</div>}
          </div>
        ))}
      </div>

      {layout && <ResizeHandle {...layout.handleProps('composer')} label="调整助手对话与输入区高度" />}
      <div className="drawer-compose">
        <label className="compose-label" htmlFor="kimi-task-input">任务描述</label>
        <AdaptiveTextarea
          id="kimi-task-input"
          mode="fill"
          className="text-area"
          data-testid="kimi-prompt"
          value={prompt}
          placeholder="描述你要生成的角色或要做的事情…"
          disabled={running}
          onChange={event => setPrompt(event.target.value)}
          onKeyDown={event => {
            if (!event.nativeEvent.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="compose-row">
          <span className="compose-hint">Ctrl + Enter 发送</span>
          {running ? (
            <button type="button" className="btn danger small" data-testid="kimi-cancel" onClick={onCancel}>
              <Icon name="close" size={15} />
              <span>停止助手</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn primary small"
              data-testid="kimi-send"
              disabled={sendDisabled}
              onClick={submit}
            >
              <Icon name="sparkle" size={15} />
              <span>执行任务</span>
            </button>
          )}
        </div>
        {toolBlocked && !running && <p className="compose-hint warn">当前模型不支持工具调用，暂时不能执行任务。</p>}
        {running && (
          <p className="compose-hint">
            <span className="wf-spinner inline" />
            停止助手会同时结束 Kimi 和它启动的生成任务。
          </p>
        )}
      </div>
      </div>
    </div>
  );
}
