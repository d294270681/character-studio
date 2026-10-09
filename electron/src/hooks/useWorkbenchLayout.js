import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { CSS_VARIABLES, DEFAULT_LAYOUT, STORAGE_KEY, fitLayout, handleRange, normalizeLayout, parseLayout } from '../lib/workbench-layout.js';

const readPreferences = () => {
  try { return parseLayout(window.localStorage.getItem(STORAGE_KEY)); } catch { return { ...DEFAULT_LAYOUT }; }
};
const padding = (element, axis) => {
  if (!element) return 0;
  const style = getComputedStyle(element);
  return axis === 'x'
    ? (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0)
    : (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
};

export default function useWorkbenchLayout({ assistantOpen = false } = {}) {
  const rootRef = useRef(null);
  const stageRef = useRef(null);
  const previewRef = useRef(null);
  const assistantBodyRef = useRef(null);
  const workspaceRef = useRef(null);
  const preferences = useRef(null);
  if (!preferences.current) preferences.current = readPreferences();
  const live = useRef({ ...preferences.current });
  const metrics = useRef({ assistantOpen });
  const open = useRef(assistantOpen);
  open.current = assistantOpen;
  const transaction = useRef(null);
  const priority = useRef(null);
  const refreshObservers = useRef(null);
  const listeners = useRef(new Set());
  const frame = useRef(null);
  const mounted = useRef(false);

  const measure = useCallback(() => {
    const root = rootRef.current;
    const preview = previewRef.current;
    const assistant = assistantBodyRef.current;
    metrics.current = {
      assistantOpen: open.current,
      rootWidth: root?.clientWidth,
      horizontalOverhead: padding(root, 'x') + padding(stageRef.current, 'x'),
      previewHeight: preview ? preview.clientHeight - padding(preview, 'y') : undefined,
      assistantHeight: assistant ? assistant.clientHeight - padding(assistant, 'y') : root?.clientHeight,
      workspaceHeight: workspaceRef.current?.clientHeight,
    };
  }, []);
  const apply = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (!mounted.current) return;
    measure();
    const active = transaction.current;
    const widthPriority = ['sidebar', 'parameters', 'assistant'].includes(active?.name) ? active.name : priority.current;
    live.current = fitLayout(active?.draft || preferences.current, metrics.current, widthPriority);
    const root = rootRef.current;
    if (root) for (const [name, variable] of Object.entries(CSS_VARIABLES)) {
      const value = `${live.current[name]}px`;
      if (root.style.getPropertyValue(variable) !== value) root.style.setProperty(variable, value);
    }
    for (const listener of listeners.current) listener();
  }, [measure]);
  const schedule = useCallback(() => {
    if (frame.current == null && mounted.current) frame.current = requestAnimationFrame(apply);
  }, [apply]);
  const persist = useCallback(() => {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences.current)); } catch { /* Restricted storage still allows resizing. */ }
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    apply();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const observed = new Set();
    let observedRoot = null;
    const mutation = typeof MutationObserver === 'function'
      ? new MutationObserver(() => { observeRefs(); schedule(); }) : null;
    const observeRefs = () => {
      const current = new Set([rootRef.current, stageRef.current, previewRef.current, assistantBodyRef.current, workspaceRef.current].filter(Boolean));
      for (const node of observed) if (!current.has(node)) { observer?.unobserve(node); observed.delete(node); }
      for (const node of current) if (!observed.has(node)) { observer?.observe(node); observed.add(node); }
      if (observedRoot !== rootRef.current) {
        mutation?.disconnect();
        observedRoot = rootRef.current;
        if (observedRoot) mutation?.observe(observedRoot, { childList: true, subtree: true });
      }
    };
    refreshObservers.current = observeRefs;
    observeRefs();
    window.addEventListener('resize', schedule);
    return () => {
      mounted.current = false;
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null;
      transaction.current = null;
      refreshObservers.current = null;
      observer?.disconnect();
      mutation?.disconnect();
      window.removeEventListener('resize', schedule);
    };
  }, [apply, schedule]);

  useLayoutEffect(() => {
    // Also discover refs after a loading screen or stage switch mounts new DOM.
    refreshObservers.current?.();
    apply();
  });

  useLayoutEffect(() => {
    // Closing the assistant during a drag restores preferences before fitting.
    transaction.current = null;
    priority.current = null;
    apply();
  }, [assistantOpen, apply]);

  const resetLayout = useCallback(() => {
    transaction.current = null;
    priority.current = null;
    preferences.current = { ...DEFAULT_LAYOUT };
    apply();
    persist();
  }, [apply, persist]);

  const props = useMemo(() => Object.fromEntries(Object.keys(DEFAULT_LAYOUT).map(name => [name, {
    name,
    orientation: ['candidates', 'composer', 'console'].includes(name) ? 'horizontal' : 'vertical',
    sign: ['assistant', 'candidates', 'composer', 'console'].includes(name) ? -1 : 1,
    getRange: () => handleRange(name, live.current, metrics.current),
    subscribe: listener => { listeners.current.add(listener); return () => listeners.current.delete(listener); },
    onStart: () => {
      measure();
      transaction.current = { name, draft: { ...preferences.current } };
    },
    onChange: (value, { commit = false, cancel = false } = {}) => {
      if (cancel) { transaction.current = null; apply(); return; }
      measure();
      const range = handleRange(name, live.current, metrics.current);
      const safeValue = Math.max(range.min, Math.min(range.max, value));
      if (!transaction.current || transaction.current.name !== name) transaction.current = { name, draft: { ...preferences.current } };
      transaction.current.draft[name] = safeValue;
      if (commit) {
        // Save only the edited preference, preserving other temporarily clamped panes.
        preferences.current = normalizeLayout({ ...preferences.current, [name]: safeValue });
        if (['sidebar', 'parameters', 'assistant'].includes(name)) priority.current = name;
        apply();
        transaction.current = null;
        persist();
      } else schedule();
    },
    onReset: () => {
      preferences.current = { ...preferences.current, [name]: DEFAULT_LAYOUT[name] };
      transaction.current = null;
      priority.current = null;
      apply();
      persist();
    },
  }])), [apply, measure, persist, schedule]);
  const handleProps = useCallback(name => {
    if (!props[name]) throw new Error(`Unknown workbench separator: ${name}`);
    return props[name];
  }, [props]);
  return { rootRef, stageRef, previewRef, assistantBodyRef, workspaceRef, handleProps, resetLayout };
}

export { useWorkbenchLayout };
