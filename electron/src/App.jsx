import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import ParameterPanel from './components/ParameterPanel.jsx';
import PreviewPane from './components/PreviewPane.jsx';
import CandidateRail from './components/CandidateRail.jsx';
import KimiDrawer from './components/KimiDrawer.jsx';
import ProviderManager from './components/ProviderManager.jsx';
import { effortLabel, modelBlocksTools, normalizeSelection, resolveEffectiveModel } from './components/ModelSelector.jsx';
import WorkflowCard from './components/WorkflowCard.jsx';
import ExportDialog from './components/ExportDialog.jsx';
import StatusBar from './components/StatusBar.jsx';
import Toasts from './components/Toasts.jsx';
import Icon from './components/Icon.jsx';
import ResizeHandle from './components/ResizeHandle.jsx';
import useWorkbenchLayout from './hooks/useWorkbenchLayout.js';
import useExecutionConsole from './hooks/useExecutionConsole.js';
import ExecutionConsole from './components/ExecutionConsole.jsx';
import {
  INPUT_STAGE, MODEL_BADGES, STAGES, STAGE_LABELS, STAGE_TITLES, animationNameFor, call, clone,
  errorText, sameValue,
} from './lib/studio.js';
import {
  assistantActive, normalizeAssistant, stagesFromValue, stepFor, stepMessage,
} from './lib/workflow.js';

const POLL_MS = 1000;
const SAVE_DEBOUNCE_MS = 600;

// Changing any of these invalidates a hand-written prompt override, so the
// stored prompt is cleared and the service rebuilds it from the presets.
const PROMPT_RESET_KEYS = {
  style: ['style', 'view', 'white', 'extra'],
  video: ['motion', 'extra'],
};

function describeKimiUse(rawSelection, catalog) {
  if (!rawSelection) return '';
  const selection = {
    provider: rawSelection.provider ?? rawSelection.provider_id ?? '',
    model: rawSelection.model ?? rawSelection.model_id ?? '',
    thinking: rawSelection.thinking ?? 'default',
    effort: rawSelection.effort ?? 'default',
  };
  const model = resolveEffectiveModel(catalog, selection);
  const parts = [];
  const name = model ? (model.label || model.model || model.id) : selection.model;
  if (name) parts.push(name);
  if (selection.thinking === 'on') parts.push('思考开启');
  if (selection.thinking === 'off') parts.push('思考关闭');
  if (selection.effort && selection.effort !== 'default') parts.push(`等级 ${effortLabel(selection.effort)}`);
  return parts.join(' · ');
}

function mergeForms(forms, saved, settings, forceStages) {
  if (!forms) return forms;
  const next = { ...forms };
  for (const stage of STAGES) {
    const server = settings?.[stage] || {};
    const current = forms[stage] || {};
    const persisted = saved?.[stage] || {};
    const merged = { ...current };
    for (const key of Object.keys(server)) {
      if (forceStages?.has(stage) || sameValue(persisted[key], current[key])) merged[key] = server[key];
    }
    next[stage] = merged;
  }
  return next;
}

export default function App() {
  const [serverState, setServerState] = useState(null);
  const [forms, setForms] = useState(null);
  const [saved, setSaved] = useState(null);
  const [stageIndex, setStageIndex] = useState(0);
  const [viewIds, setViewIds] = useState({});
  const [status, setStatus] = useState('就绪 · 先生成或导入人物原始图');
  const [toasts, setToasts] = useState([]);
  const [log, setLog] = useState([]);
  const [logOpen, setLogOpen] = useState(() => {
    try { return localStorage.getItem('character-studio.console-open.v1') !== 'false'; } catch { return true; }
  });
  const [submitting, setSubmitting] = useState(false);
  const [kimiOpen, setKimiOpen] = useState(false);
  const [kimiStatus, setKimiStatus] = useState(null);
  const [kimiRunning, setKimiRunning] = useState(false);
  const [kimiProgress, setKimiProgress] = useState(null);
  const [kimiMessages, setKimiMessages] = useState([]);
  const [kimiHistory, setKimiHistory] = useState([]);
  const [kimiCatalog, setKimiCatalog] = useState(null);
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const [kimiCatalogError, setKimiCatalogError] = useState('');
  const [kimiCatalogLoading, setKimiCatalogLoading] = useState(false);
  const [kimiSelectSaving, setKimiSelectSaving] = useState(false);
  const [kimiSelection, setKimiSelection] = useState({ provider: '', model: '', thinking: 'default', effort: 'default' });
  const [spriteMetadata, setSpriteMetadata] = useState(null);
  const [spriteMetadataError, setSpriteMetadataError] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [exportResult, setExportResult] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const layout = useWorkbenchLayout({ assistantOpen: kimiOpen });
  const execution = useExecutionConsole(serverState, log);

  const formsRef = useRef({});
  const savedRef = useRef({});
  const timersRef = useRef({});
  const genRef = useRef(0);
  const projectPathRef = useRef('');
  const lastMessageRef = useRef('');
  const previousJobRef = useRef(null);
  const saveErrorRef = useRef({});
  const pendingPathRef = useRef({});
  const seenAssetRef = useRef({});
  const assistantStageRef = useRef('');
  const workflowStagesRef = useRef(new Set());
  // Guards the window between "user pressed 执行任务" and "runner owns the run":
  // a stop click during the pre-send flush must abort the submission instead of
  // racing the runner, which has no run to cancel yet.
  const submissionRef = useRef({ pending: false, cancelled: false, launched: false });
  const kimiTextRef = useRef('');
  const kimiHistoryRef = useRef([]);
  const kimiSelectionRef = useRef({ provider: '', model: '', thinking: 'default', effort: 'default' });
  const kimiCatalogRef = useRef(null);
  const toastSeq = useRef(0);
  const logSeq = useRef(0);

  useEffect(() => { formsRef.current = forms || {}; }, [forms]);
  useEffect(() => { savedRef.current = saved || {}; }, [saved]);
  useEffect(() => { kimiCatalogRef.current = kimiCatalog; }, [kimiCatalog]);
  useEffect(() => { kimiHistoryRef.current = kimiHistory; }, [kimiHistory]);

  const pushToast = useCallback((kind, title, text) => {
    const id = ++toastSeq.current;
    setToasts(prev => [...prev, { id, kind, title, text }].slice(-4));
    setTimeout(() => setToasts(prev => prev.filter(item => item.id !== id)), kind === 'error' ? 9000 : 5000);
  }, []);

  const pushLog = useCallback((text, kind = '') => {
    if (!text) return;
    const time = new Date().toTimeString().slice(0, 8);
    const entry = { id: `system-${Date.now()}-${++logSeq.current}`, timestamp: new Date().toISOString(),
      time, text, kind, project_path: projectPathRef.current };
    setLog(prev => [...prev, entry].slice(-200));
  }, []);

  useEffect(() => {
    try { localStorage.setItem('character-studio.console-open.v1', String(logOpen)); } catch { /* Optional preference. */ }
  }, [logOpen]);
  useEffect(() => {
    const shortcut = event => {
      if (event.ctrlKey && event.key.toLowerCase() === 'j') { event.preventDefault(); setLogOpen(value => !value); }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);

  const refresh = useCallback(async () => {
    const generation = genRef.current;
    try {
      const next = await call('GET', '/api/state');
      if (generation !== genRef.current) return;
      setServerState(next);
      const path = next.project?.path || '';
      if (path !== projectPathRef.current) {
        projectPathRef.current = path;
        const settings = clone(next.settings) || {};
        Object.values(timersRef.current).forEach(clearTimeout);
        timersRef.current = {};
        pendingPathRef.current = {};
        formsRef.current = clone(settings);
        savedRef.current = clone(settings);
        setForms(clone(settings));
        setSaved(clone(settings));
        const last = Number(next.project?.last_stage);
        const resolved = Number.isInteger(last) && last >= 0 && last <= 3 ? last : 0;
        setStageIndex(resolved);
        setViewIds({ ...(next.project?.selected || {}) });
        seenAssetRef.current = Object.fromEntries(STAGES.map(targetStage => {
          const list = next.project?.assets?.[targetStage] || [];
          return [targetStage, list.length ? list[list.length - 1].id : ''];
        }));
        assistantStageRef.current = '';
        workflowStagesRef.current = new Set();
        setLog([]);
        lastMessageRef.current = '';
        previousJobRef.current = null;
        setStatus(`就绪 · ${STAGE_LABELS[STAGES[resolved]]}`);
        return;
      }
      const assistantNow = normalizeAssistant(next.assistant);
      const force = assistantActive(assistantNow) ? new Set(assistantNow.stages) : null;
      workflowStagesRef.current = force || new Set();
      if (force?.size) {
        // Kimi writes parameters through the service while the workflow runs, so
        // adopt them into the live form and keep savedRef in sync; otherwise a
        // later debounce flush would push stale values back over Kimi's edits.
        const nextSaved = { ...savedRef.current };
        for (const targetStage of force) {
          if (timersRef.current[targetStage]) {
            clearTimeout(timersRef.current[targetStage]);
            timersRef.current[targetStage] = null;
          }
          pendingPathRef.current[targetStage] = '';
          nextSaved[targetStage] = clone(next.settings?.[targetStage]) || nextSaved[targetStage];
        }
        savedRef.current = nextSaved;
        setSaved(nextSaved);
      }
      setForms(prev => mergeForms(prev, savedRef.current, next.settings, force));
    } catch (error) {
      if (generation === genRef.current) pushLog(`读取状态失败：${errorText(error)}`, 'error');
    }
  }, [pushLog]);

  useEffect(() => {
    if (!window.studio) return undefined;
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const flushStage = useCallback(async targetStage => {
    if (timersRef.current[targetStage]) {
      clearTimeout(timersRef.current[targetStage]);
      timersRef.current[targetStage] = null;
    }
    const origin = pendingPathRef.current[targetStage];
    if (origin && origin !== projectPathRef.current) {
      // The edit belonged to a different project; never write it into the new one.
      pendingPathRef.current[targetStage] = '';
      return true;
    }
    const values = formsRef.current[targetStage];
    if (!values) return true;
    try {
      const result = await call('POST', '/api/settings', { stage: targetStage, values });
      savedRef.current = { ...savedRef.current, [targetStage]: result };
      setSaved(prev => ({ ...(prev || {}), [targetStage]: result }));
      setForms(prev => {
        const current = (prev || {})[targetStage] || {};
        const merged = { ...current };
        for (const key of Object.keys(result)) {
          if (sameValue(current[key], values[key])) merged[key] = result[key];
        }
        const next = { ...prev, [targetStage]: merged };
        formsRef.current = next;
        return next;
      });
      saveErrorRef.current[targetStage] = '';
      return true;
    } catch (error) {
      const message = errorText(error);
      if (saveErrorRef.current[targetStage] !== message) {
        saveErrorRef.current[targetStage] = message;
        pushToast('error', '参数未能保存', message);
      }
      pushLog(`参数保存失败：${message}`, 'error');
      return false;
    }
  }, [pushLog, pushToast]);

  const flushAll = useCallback(async () => {
    const pending = Object.entries(timersRef.current)
      .filter(([, timer]) => timer)
      .map(([targetStage]) => flushStage(targetStage));
    if (pending.length) await Promise.all(pending);
  }, [flushStage]);

  // Handing work to Kimi must never start from unsaved drafts: write every
  // stage and abort the run when any write fails.
  const flushAllStrict = useCallback(async () => {
    const results = await Promise.all(STAGES.map(targetStage => flushStage(targetStage)));
    return results.every(Boolean);
  }, [flushStage]);

  const stageDirty = useCallback(targetStage => {
    if (timersRef.current[targetStage]) return true;
    const current = formsRef.current[targetStage] || {};
    const persisted = savedRef.current[targetStage] || {};
    return Object.keys(current).some(key => !sameValue(current[key], persisted[key]));
  }, []);

  useEffect(() => window.studio?.onBeforeClose(async () => {
    try {
      // Save real drafts, but never write back stages a running workflow has
      // already synced from the server.
      const skip = workflowStagesRef.current;
      const targets = STAGES.filter(key => !skip.has(key) && stageDirty(key));
      await Promise.all(targets.map(key => flushStage(key)));
    } finally {
      await window.studio.flushComplete();
    }
  }), [flushStage, stageDirty]);

  const patchValue = useCallback((targetStage, key, value) => {
    setForms(prev => {
      const current = (prev || {})[targetStage] || {};
      const next = { ...prev, [targetStage]: { ...current, [key]: value } };
      formsRef.current = next;
      return next;
    });
    clearTimeout(timersRef.current[targetStage]);
    pendingPathRef.current[targetStage] = projectPathRef.current;
    timersRef.current[targetStage] = setTimeout(() => flushStage(targetStage), SAVE_DEBOUNCE_MS);
  }, [flushStage]);

  const patchField = useCallback((targetStage, key, value) => {
    patchValue(targetStage, key, value);
    if ((PROMPT_RESET_KEYS[targetStage] || []).includes(key)
      && (formsRef.current[targetStage] || {}).prompt) {
      patchValue(targetStage, 'prompt', '');
    }
  }, [patchValue]);

  const stage = STAGES[stageIndex];
  const presets = serverState?.presets || {
    styles: [], views: [], motions: [], qualities: [], image_sizes: [], video_sizes: [], cell_sizes: [],
  };
  const project = serverState?.project;
  const assetsByStage = project?.assets || {};
  const assets = assetsByStage[stage] || [];
  const form = forms?.[stage] || serverState?.settings?.[stage] || {};

  const selectedRecords = useMemo(() => {
    const selected = project?.selected || {};
    const pick = targetStage => (assetsByStage[targetStage] || [])
      .find(item => item.id === selected[targetStage]) || null;
    return {
      original: pick('original'), style: pick('style'), video: pick('video'), sprites: pick('sprites'),
    };
  }, [project, assetsByStage]);

  const viewId = viewIds[stage];
  const viewRecord = assets.find(item => item.id === viewId) || assets[assets.length - 1] || null;
  const selectedId = project?.selected?.[stage];
  const activeJob = useMemo(() => {
    if (!serverState?.active_job) return null;
    return (serverState.jobs || []).find(job => job.id === serverState.active_job) || null;
  }, [serverState]);
  const assistant = useMemo(() => normalizeAssistant(serverState?.assistant), [serverState]);
  const workflowBusy = assistantActive(assistant);
  // kimiRunning covers the window before the service reports a workflow, so the
  // whole UI locks as soon as the user hands work to the assistant.
  const busy = !!serverState?.active_job || submitting || workflowBusy || kimiRunning;

  useEffect(() => {
    if (!project?.assets) return;
    setViewIds(prev => {
      let changed = false;
      const next = { ...prev };
      for (const targetStage of STAGES) {
        const list = project.assets[targetStage] || [];
        if (!list.length) continue;
        const newest = list[list.length - 1].id;
        const fresh = seenAssetRef.current[targetStage] !== newest;
        if (fresh) {
          // A newly arrived candidate takes over the preview, while the rail
          // keeps every earlier candidate for comparison.
          seenAssetRef.current[targetStage] = newest;
          if (next[targetStage] !== newest) { next[targetStage] = newest; changed = true; }
        } else if (!list.some(item => item.id === next[targetStage])) {
          next[targetStage] = newest;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [project]);

  useEffect(() => {
    if (stage !== 'sprites' || !viewRecord?.metadata) {
      setSpriteMetadata(null);
      setSpriteMetadataError('');
      return undefined;
    }
    let cancelled = false;
    window.studio.metadata(viewRecord.id)
      .then(data => { if (!cancelled) { setSpriteMetadata(data); setSpriteMetadataError(''); } })
      .catch(error => {
        if (!cancelled) { setSpriteMetadata(null); setSpriteMetadataError(errorText(error)); }
      });
    return () => { cancelled = true; };
  }, [stage, viewRecord?.id, viewRecord?.metadata]);

  const handleFinished = useCallback(finished => {
    const label = STAGE_LABELS[finished.stage] || '任务';
    if (finished.status === 'complete') {
      pushLog(`${label} 已完成`, 'success');
      setStatus(`${label} · 已完成，请查看结果并选用`);
      if (finished.stage === 'export' && finished.result) {
        setExportResult(finished.result);
        setExportOpen(true);
      }
    } else if (finished.status === 'cancelled') {
      pushLog(`${label} 已取消`, 'warn');
      setStatus(`${label} · 已取消，已完成的结果仍然保留`);
    } else if (finished.status === 'error' || finished.status === 'interrupted') {
      pushLog(`${label} 失败：${finished.message || ''}`, 'error');
      setStatus(`${label} · 未完成`);
      pushToast('error', `${label}未完成`, finished.message || '请查看运行记录');
    }
    refresh();
  }, [pushLog, pushToast, refresh]);

  useEffect(() => {
    if (activeJob) {
      previousJobRef.current = activeJob.id;
      if (activeJob.message && activeJob.message !== lastMessageRef.current) {
        lastMessageRef.current = activeJob.message;
        pushLog(activeJob.message);
      }
      setStatus(`${STAGE_LABELS[activeJob.stage] || '任务'} · ${activeJob.message || '处理中'}`);
      return;
    }
    const finishedId = previousJobRef.current;
    if (!finishedId) return;
    previousJobRef.current = null;
    const finished = (serverState?.jobs || []).find(job => job.id === finishedId);
    if (finished) handleFinished(finished);
  }, [activeJob, serverState, handleFinished, pushLog]);

  const goStage = useCallback(index => {
    setStageIndex(index);
    if (serverState?.project?.last_stage !== index) {
      call('POST', '/api/view', { stage: index }).catch(() => {});
    }
  }, [serverState]);

  const openWorkflowStage = useCallback(stageKey => {
    const index = STAGES.indexOf(stageKey);
    if (index >= 0) goStage(index);
  }, [goStage]);

  // Follow the workflow's real current stage, but only when it actually moves:
  // a plain poll must never yank the user away from a page they opened.
  useEffect(() => {
    if (!workflowBusy) { assistantStageRef.current = ''; return; }
    const current = assistant?.currentStage || '';
    if (!current || current === assistantStageRef.current) return;
    assistantStageRef.current = current;
    const index = STAGES.indexOf(current);
    if (index >= 0) goStage(index);
  }, [assistant?.currentStage, workflowBusy, goStage]);

  const runJob = useCallback(async (payload, label) => {
    setSubmitting(true);
    try {
      const job = await call('POST', '/api/jobs', payload);
      previousJobRef.current = job.id;
      lastMessageRef.current = '';
      pushLog(`已提交${label}任务`);
      setStatus(`${label} · 已提交，正在准备…`);
      await refresh();
      return job;
    } catch (error) {
      const message = errorText(error);
      pushToast('error', `${label}还无法开始`, message);
      pushLog(`${label}未启动：${message}`, 'error');
      return null;
    } finally {
      setSubmitting(false);
    }
  }, [pushLog, pushToast, refresh]);

  const generate = useCallback(async () => {
    if (busy) return;
    await flushStage(stage);
    await runJob({ stage, parameters: clone(formsRef.current[stage]) || {} }, STAGE_LABELS[stage]);
  }, [busy, flushStage, runJob, stage]);

  const releaseModels = useCallback(async () => {
    if (busy) return;
    await flushAll();
    await runJob({ stage: 'release' }, '释放显存');
  }, [busy, flushAll, runJob]);

  const importAsset = useCallback(async () => {
    if (busy) return;
    const targetStage = INPUT_STAGE[stage];
    try {
      const record = await window.studio.importAsset(targetStage);
      if (!record) return;
      setViewIds(prev => ({ ...prev, [targetStage]: record.id }));
      pushLog(`已导入文件：${record.path}`);
      setStatus('已导入文件，可以继续当前步骤');
      await refresh();
    } catch (error) {
      pushToast('error', '导入失败', errorText(error));
    }
  }, [busy, pushLog, pushToast, refresh, stage]);

  const importPaths = useCallback(async paths => {
    if (busy || !paths?.length) return;
    const targetStage = INPUT_STAGE[stage];
    try {
      const record = await window.studio.importPaths(targetStage, [paths[0]]);
      if (!record) return;
      setViewIds(prev => ({ ...prev, [targetStage]: record.id }));
      pushLog(`已导入文件：${record.path}`);
      await refresh();
    } catch (error) {
      pushToast('error', '导入失败', errorText(error));
    }
  }, [busy, pushLog, pushToast, refresh, stage]);

  const useAsset = useCallback(async record => {
    if (!record || busy) return;
    await flushAll();
    try {
      await call('POST', '/api/assets/select', { stage, asset_id: record.id });
      pushLog(`已选用${STAGE_LABELS[stage]}结果`);
      await refresh();
    } catch (error) {
      pushToast('error', '无法选用这个结果', errorText(error));
      return;
    }
    if (stage === 'sprites') {
      setExportResult(null);
      await runJob({ stage: 'export', parameters: { asset_id: record.id, preview: true } }, 'Godot 导出');
      return;
    }
    if (stage === 'video') {
      const name = animationNameFor(record.motion || form.motion || '');
      if (name && name !== (formsRef.current.sprites || {}).animation_name) {
        patchValue('sprites', 'animation_name', name);
      }
    }
    setStatus('已选定当前结果，可以开始下一步');
    goStage(stageIndex + 1);
  }, [busy, flushAll, form.motion, goStage, patchValue, pushLog, pushToast, refresh, runJob, stage, stageIndex]);

  const saveAsset = useCallback(async record => {
    if (!record) return;
    try {
      const result = await window.studio.saveAsset(stage, record.id);
      if (result?.path) {
        pushToast('success', '已保存', result.path);
        pushLog(`已保存到 ${result.path}`);
      }
    } catch (error) {
      pushToast('error', '保存失败', errorText(error));
    }
  }, [pushLog, pushToast, stage]);

  const showAsset = useCallback(async record => {
    if (!record) return;
    try {
      await window.studio.showAsset(stage, record.id);
    } catch (error) {
      pushToast('error', '无法打开位置', errorText(error));
    }
  }, [pushToast, stage]);

  const renameProject = useCallback(async name => {
    if (busy) return;
    try {
      await call('POST', '/api/projects/rename', { name });
      await refresh();
    } catch (error) {
      pushToast('error', '重命名失败', errorText(error));
    }
  }, [busy, pushToast, refresh]);

  const newProject = useCallback(async name => {
    if (busy) return;
    await flushAll();
    genRef.current += 1;
    try {
      const next = await call('POST', '/api/projects', { name });
      projectPathRef.current = '';
      setServerState(next);
      setExportResult(null);
      pushLog(`已新建角色：${next?.project?.name || name}`, 'success');
      setStatus('已新建角色 · 先生成或导入人物原始图');
      setStageIndex(0);
      await refresh();
    } catch (error) {
      pushToast('error', '无法新建角色', errorText(error));
    }
  }, [busy, flushAll, pushLog, pushToast, refresh]);

  const openProject = useCallback(async () => {
    if (busy) return;
    await flushAll();
    genRef.current += 1;
    try {
      const next = await window.studio.openProject();
      if (!next) return;
      projectPathRef.current = '';
      setServerState(next);
      setExportResult(null);
      pushLog(`已打开项目：${next?.project?.name || ''}`, 'success');
      setStatus('已打开项目');
      await refresh();
    } catch (error) {
      pushToast('error', '无法打开项目', errorText(error));
    }
  }, [busy, flushAll, pushLog, pushToast, refresh]);

  const cancelJob = useCallback(async () => {
    if (!activeJob) return;
    // A job owned by the assistant must be stopped through the Kimi runner:
    // killing only the GPU job would leave Kimi running and end with an error.
    if (assistant?.id && activeJob.workflow_id === assistant.id) {
      try {
        await window.studio.kimiCancel();
        pushLog('已请求停止 Kimi 工作流及其生成任务', 'warn');
      } catch (error) {
        pushToast('error', '停止工作流失败', errorText(error));
      }
      return;
    }
    try {
      await call('POST', `/api/jobs/${activeJob.id}/cancel`, {});
      pushLog('已请求取消当前任务', 'warn');
    } catch (error) {
      pushToast('error', '取消失败', errorText(error));
    }
  }, [activeJob, assistant?.id, pushLog, pushToast]);

  const refreshKimiStatus = useCallback(async () => {
    try {
      setKimiStatus(await window.studio.kimiStatus());
    } catch (error) {
      setKimiStatus({ installed: false });
    }
  }, []);

  const loadKimiCatalog = useCallback(async () => {
    if (!window.studio?.kimiCatalog) {
      setKimiCatalog(null);
      setKimiCatalogError('当前版本的后端还没有提供模型列表接口。');
      return;
    }
    setKimiCatalogLoading(true);
    try {
      const next = await window.studio.kimiCatalog();
      setKimiCatalog(next || null);
      const selection = normalizeSelection(next?.selection);
      kimiSelectionRef.current = selection;
      setKimiSelection(selection);
      setKimiCatalogError('');
    } catch (error) {
      setKimiCatalog(null);
      setKimiCatalogError(errorText(error) || '读取 Kimi 配置失败。');
    } finally {
      setKimiCatalogLoading(false);
    }
  }, []);

  const changeKimiSelection = useCallback(async selection => {
    const next = normalizeSelection(selection);
    setKimiSelection(next);
    kimiSelectionRef.current = next;
    if (!window.studio?.kimiSetSelection) {
      pushToast('error', '模型设置未能保存', '当前版本的后端还没有提供设置接口。');
      return;
    }
    setKimiSelectSaving(true);
    try {
      const updated = await window.studio.kimiSetSelection(next);
      if (updated) {
        setKimiCatalog(updated);
        const savedSelection = normalizeSelection(updated.selection);
        kimiSelectionRef.current = savedSelection;
        setKimiSelection(savedSelection);
      }
      setKimiCatalogError('');
    } catch (error) {
      pushToast('error', '模型设置未能保存', errorText(error));
      await loadKimiCatalog();
    } finally {
      setKimiSelectSaving(false);
    }
  }, [loadKimiCatalog, pushToast]);

  useEffect(() => { if (kimiOpen) loadKimiCatalog(); }, [kimiOpen, loadKimiCatalog]);

  useEffect(() => {
    if (!window.studio?.onKimi) return undefined;
    const unsubscribe = window.studio.onKimi(packet => {
      if (packet.type === 'progress') {
        setKimiProgress(packet);
        return;
      }
      if (packet.type === 'started') {
        setKimiRunning(true);
        setKimiStatus(previous => ({ ...previous, running: true }));
        const used = describeKimiUse(packet.resolved || packet.selection, kimiCatalogRef.current);
        const scope = stagesFromValue(packet.stages || packet.selection?.stages || '');
        const scopeText = scope.length ? scope.map(key => STAGE_LABELS[key]).join(' → ') : '';
        setKimiMessages(prev => [...prev, {
          role: 'assistant', kind: 'status',
          text: `开始执行${scopeText ? `：${scopeText}` : ''}${used ? ` · ${used}` : ''}，正在读取项目状态…`,
        }]);
        pushLog(`Kimi 开始执行${scopeText ? `：${scopeText}` : ''}`);
        refresh();
        return;
      }
      if (packet.type === 'workflow') {
        refresh();
        return;
      }
      if (packet.type === 'message') {
        if (packet.role === 'assistant' && packet.text) kimiTextRef.current += packet.text;
        setKimiMessages(prev => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (packet.role === 'assistant' && last?.role === 'assistant' && !last.tools?.length && !last.kind) {
            next[next.length - 1] = { ...last, text: `${last.text}${packet.text || ''}` };
          } else {
            next.push({ role: packet.role, text: packet.text, tools: packet.tools });
          }
          return next.slice(-60);
        });
        return;
      }
      if (packet.type === 'done') {
        setKimiProgress(null);
        setKimiRunning(false);
        setKimiStatus(previous => ({ ...previous, running: false }));
        if (kimiTextRef.current.trim()) {
          setKimiHistory(prev => [...prev, { role: 'assistant', text: kimiTextRef.current.slice(0, 4000) }].slice(-8));
        }
        kimiTextRef.current = '';
        if (packet.error && !packet.cancelled) {
          pushToast('error', 'Kimi 未完成任务', packet.error);
          pushLog(`Kimi 未完成：${packet.error}`, 'error');
        } else if (packet.cancelled) {
          pushLog('Kimi 任务已停止', 'warn');
        } else {
          pushLog('Kimi 已完成本轮任务', 'success');
        }
        refresh();
      }
    });
    return unsubscribe;
  }, [pushLog, pushToast, refresh]);

  useEffect(() => { refreshKimiStatus(); }, [refreshKimiStatus]);

  const sendKimi = useCallback(async (prompt, stages) => {
    if (busy) return false;
    const selection = stagesFromValue(stages);
    if (!selection.length) {
      pushToast('error', '还没有选择执行步骤', '请在“执行步骤”里选择要跑的步骤。');
      return false;
    }
    // Reserve the busy state before any await: flushing and the runner's own
    // service.ensure() can take seconds, and the window must already look busy
    // (stop button visible, editors locked) during that time.
    setKimiRunning(true);
    setKimiProgress({ phase: 'connecting', label: '正在连接 Kimi' });
    const submission = { pending: true, cancelled: false, launched: false };
    submissionRef.current = submission;
    // Never hand a half-saved draft to Kimi: every stage must be persisted first.
    let persisted = false;
    try {
      persisted = await flushAllStrict();
    } catch {
      persisted = false;
    }
    // A previous IPC rejection may settle after its done event unlocked the
    // drawer. Only this submission is allowed to clear its own busy state.
    if (submissionRef.current !== submission) return false;
    if (submission.cancelled) {
      submissionRef.current = { pending: false, cancelled: false, launched: false };
      setKimiRunning(false);
      pushLog('已取消本次提交，未启动生成任务', 'warn');
      return false;
    }
    if (!persisted) {
      submissionRef.current = { pending: false, cancelled: false, launched: false };
      setKimiRunning(false);
      pushToast('error', '参数未能保存', '请先修正界面上的参数，再交给 Kimi 执行。');
      return false;
    }
    setKimiMessages(prev => [...prev, { role: 'user', text: prompt }]);
    setKimiHistory(prev => [...prev, { role: 'user', text: prompt }].slice(-8));
    kimiTextRef.current = '';
    // From here the runner owns cancellation, so a stop click goes to kimiCancel.
    submission.pending = false;
    submission.launched = true;
    try {
      const result = await window.studio.kimiStart({
        prompt,
        mode: 'execute',
        stages: selection,
        history: kimiHistoryRef.current,
        selection: kimiSelectionRef.current,
      });
      // started/done packets can land before this promise resolves, so only a
      // refusal is acted on here; success leaves the event stream in charge.
      if (result && result.started === false) {
        if (submissionRef.current === submission) {
          submissionRef.current = { pending: false, cancelled: false, launched: false };
          setKimiRunning(false);
          if (!result.cancelled) pushToast('error', 'Kimi 未能启动', '请检查 Kimi 登录状态或模型配置。');
        }
        return false;
      }
      return true;
    } catch (error) {
      if (submissionRef.current === submission) {
        submissionRef.current = { pending: false, cancelled: false, launched: false };
        pushToast('error', 'Kimi 未能启动', errorText(error));
        setKimiRunning(false);
      }
      return false;
    }
  }, [busy, flushAllStrict, pushToast]);

  const cancelKimi = useCallback(async () => {
    if (submissionRef.current.pending) {
      // The run does not exist yet; flag the submission so the pending flush
      // aborts instead of starting a task the user already stopped.
      submissionRef.current.cancelled = true;
      // Keep submission locked until its outstanding saves settle. A second
      // send must not replace the cancellation flag of the first submission.
      pushLog('已取消本次提交', 'warn');
      return;
    }
    try {
      await window.studio.kimiCancel();
      pushLog('已请求停止 Kimi 助手', 'warn');
    } catch (error) {
      pushToast('error', '无法停止 Kimi', errorText(error));
    }
  }, [pushLog, pushToast]);

  const copyText = useCallback(async text => {
    try {
      await window.studio.copyText(text);
      pushToast('success', '已复制', String(text).slice(0, 80));
    } catch (error) {
      pushToast('error', '复制失败', errorText(error));
    }
  }, [pushToast]);

  if (!window.studio) {
    return (
      <div className="app">
        <div className="fatal">
          <Icon name="alert" size={22} />
          <p>请在角色工坊桌面应用中打开这个界面。</p>
        </div>
      </div>
    );
  }

  const progress = activeJob?.progress || null;
  const missing = serverState?.missing_models?.[stage] || [];
  const kimiBusy = kimiRunning || workflowBusy || !!kimiStatus?.running;
  const kimiToolBlocked = modelBlocksTools(kimiCatalog, kimiSelection);
  const supportsPrompt = !!(serverState?.settings?.[stage]
    && Object.prototype.hasOwnProperty.call(serverState.settings[stage], 'prompt'));
  const workflowStep = stepFor(assistant, stage);
  const stepStatus = workflowStep?.status || '';
  let primaryOverride = null;
  if (workflowBusy && workflowStep) {
    if (stepStatus === 'running') {
      primaryOverride = { label: stage === 'sprites' ? '正在转换精灵图…' : '正在生成…', busy: true };
    } else if (stepStatus === 'preparing' || (stepStatus === 'pending' && assistant.currentStage === stage)) {
      primaryOverride = { label: kimiProgress?.label || 'Kimi 正在准备…', busy: true };
    }
  }
  const railTip = workflowBusy
    ? (assistant.stages.length > 1
      ? '助手会选用中间结果继续，全部候选保留'
      : '助手正在执行，候选结果会实时出现在这里')
    : '点击查看不会改变已选结果，只有“选用”才会进入下一步';
  const workflowNotice = workflowBusy && stepStatus === 'preparing'
    ? `${kimiProgress?.label || 'Kimi 正在准备这一步'}，界面暂时锁定。`
    : '';
  const statusText = workflowBusy
    ? `Kimi 工作流 · ${stepMessage(assistant, serverState?.jobs || []) || '执行中'}`
    : status;

  return (
    <div ref={layout.rootRef} className={`app${kimiOpen ? ' kimi-open' : ''}`}>
      <Sidebar
        stageIndex={stageIndex}
        onStage={goStage}
        projectName={project?.name || ''}
        onRename={renameProject}
        onNew={newProject}
        onOpen={openProject}
        onRelease={releaseModels}
        onHelp={() => setHelpOpen(true)}
        busy={busy}
        comfyOnline={!!serverState?.comfy_online}
        kimiRunning={kimiBusy}
        kimiInstalled={!!kimiStatus?.installed}
        project={project}
        activeJob={activeJob}
        assistant={assistant}
      />
      <ResizeHandle {...layout.handleProps('sidebar')} label="调整导航栏宽度" />

      <main className="main">
        <header className="topbar">
          <div className="topbar-titles">
            <h1>
              <span className="stage-number">{String(stageIndex + 1).padStart(2, '0')}</span>
              <span className="stage-title-text">{STAGE_LABELS[stage]}</span>
            </h1>
            <p>{STAGE_TITLES[stage]}</p>
          </div>
          <span className="badge">{MODEL_BADGES[stage]}</span>
          <div className="topbar-actions">
            <button type="button" className="icon-btn layout-reset" title="恢复默认布局" aria-label="恢复默认布局" onClick={layout.resetLayout}>
              <Icon name="refresh" size={16} />
            </button>
            <button
              type="button"
              className={`btn ghost${kimiOpen ? ' is-active' : ''}`}
              onClick={() => setKimiOpen(value => !value)}
            >
              <Icon name="robot" size={16} />
              <span>Kimi 助手</span>
              {kimiBusy && <span className="pulse" />}
            </button>
          </div>
        </header>

        <div className="workflow-strip">
          <WorkflowCard
            assistant={assistant}
            jobs={serverState?.jobs || []}
            onCancel={cancelKimi}
            onOpenStage={openWorkflowStage}
          />
        </div>

        <div className={`workbench-body${logOpen ? ' console-open' : ''}`} ref={layout.workspaceRef}>
        <div className="stage-body" ref={layout.stageRef}>
          <ParameterPanel
            stage={stage}
            form={form}
            presets={presets}
            missing={missing}
            selected={selectedRecords}
            disabled={busy}
            primaryOverride={primaryOverride}
            supportsPrompt={supportsPrompt}
            workflowNotice={workflowNotice}
            onPatch={(key, value) => patchField(stage, key, value)}
            onGenerate={generate}
            onImport={importAsset}
          />
          <ResizeHandle {...layout.handleProps('parameters')} label="调整参数与预览区域宽度" />
          <div className="preview-column" ref={layout.previewRef}>
            <PreviewPane
              stage={stage}
              record={viewRecord}
              reference={stage === 'style' ? selectedRecords.original : null}
              spriteMetadata={spriteMetadata}
              spriteMetadataError={spriteMetadataError}
              disabled={busy}
              onSave={saveAsset}
              onShow={showAsset}
              onUse={useAsset}
              onImport={importAsset}
              onDropPaths={importPaths}
            />
            <ResizeHandle {...layout.handleProps('candidates')} label="调整预览与候选区高度" />
            <CandidateRail
              stage={stage}
              assets={assets}
              viewId={viewRecord?.id}
              selectedId={selectedId}
              tip={railTip}
              onView={id => setViewIds(prev => ({ ...prev, [stage]: id }))}
            />
          </div>
        </div>
        {logOpen && <>
          <ResizeHandle {...layout.handleProps('console')} label="调整工作区与执行控制台高度" />
          <ExecutionConsole entries={execution.entries} projectPath={project?.path} busy={busy}
            onClose={() => setLogOpen(false)} onClear={execution.clear} onCopy={copyText} />
        </>}
        </div>

        <StatusBar
          status={statusText}
          progress={progress}
          busy={busy}
          onCancel={cancelJob}
          logOpen={logOpen}
          onToggleLog={() => setLogOpen(value => !value)}
          comfyOnline={!!serverState?.comfy_online}
        />
      </main>

      {kimiOpen && <ResizeHandle {...layout.handleProps('assistant')} label="调整助手面板宽度" />}
      <KimiDrawer
        open={kimiOpen}
        onClose={() => setKimiOpen(false)}
        status={kimiStatus}
        running={kimiBusy}
        progress={kimiProgress}
        busy={busy}
        messages={kimiMessages}
        history={kimiHistory}
        onSend={sendKimi}
        onCancel={cancelKimi}
        onTerminal={async () => {
          try { await window.studio.kimiTerminal(); }
          catch (error) { pushToast('error', '无法打开 Kimi 终端', error.message); }
        }}
        onCopy={copyText}
        onRefreshStatus={refreshKimiStatus}
        catalog={kimiCatalog}
        catalogError={kimiCatalogError}
        catalogLoading={kimiCatalogLoading}
        selection={kimiSelection}
        saving={kimiSelectSaving}
        toolBlocked={kimiToolBlocked}
        onChangeSelection={changeKimiSelection}
        onRefreshCatalog={loadKimiCatalog}
        onManageModels={() => setModelManagerOpen(true)}
        defaultStage={stage}
        workflow={assistant}
        onOpenWorkflowStage={openWorkflowStage}
        layout={layout}
      />

      {modelManagerOpen && <ProviderManager open={modelManagerOpen} onClose={() => { setModelManagerOpen(false); loadKimiCatalog(); }}
        onApplied={loadKimiCatalog} busy={kimiBusy} disabled={kimiBusy} />}

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        metadata={spriteMetadata}
        result={exportResult}
        record={selectedRecords.sprites || viewRecord}
        onShow={showAsset}
        onSave={saveAsset}
        onCopy={copyText}
      />

      {helpOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal narrow">
            <div className="modal-head">
              <span className="modal-title"><Icon name="help" size={17} />使用说明</span>
              <button type="button" className="icon-btn" onClick={() => setHelpOpen(false)} title="关闭">
                <Icon name="close" size={16} />
              </button>
            </div>
            <div className="modal-body column">
              <ol className="help-list">
                <li>第一步：描述人物，生成或导入一张完整的原始图，然后“选用”。</li>
                <li>第二步：挑画风与视角，把已选的原始图转成像素或动漫等风格，再“选用”。</li>
                <li>第三步：选动作与长度，用已选的风格图生成一段视频，再“选用”。</li>
                <li>第四步：设置帧数、单帧尺寸与像素网格，转换出透明精灵图，导出到 Godot 预览。</li>
              </ol>
              <p className="help-note">候选图只是预览，点击缩略图不会改变已选结果；只有“选用”才会把结果传给下一步，并清除后面阶段的已选项。</p>
              <p className="help-note">右侧 Kimi 助手会直接执行你选择的步骤：它读取项目、填写参数并启动生成。选择多步时，中间的候选由助手自动选用并全部保留，最后一步的候选留给你确认。</p>
              <p className="help-note">工作流进行中时界面会锁定编辑，停止执行会同时结束助手和它启动的生成任务。</p>
            </div>
            <div className="modal-foot">
              <button type="button" className="btn ghost small" onClick={() => window.studio.help()}>
                <Icon name="folderOpen" size={15} />
                <span>打开详细文档</span>
              </button>
              <button type="button" className="btn accent" onClick={() => setHelpOpen(false)}>
                <Icon name="check" size={16} />
                <span>知道了</span>
              </button>
            </div>
          </div>
        </div>
      )}

      <Toasts items={toasts} onDismiss={id => setToasts(prev => prev.filter(item => item.id !== id))} />
    </div>
  );
}
