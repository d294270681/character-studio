import { useEffect, useRef, useState } from 'react';

export default function ResizeHandle({ name, label, orientation = 'vertical', sign = 1, getRange, subscribe, onStart, onChange, onReset }) {
  const [range, setRange] = useState(getRange);
  const [dragging, setDragging] = useState(false);
  const active = useRef(null);
  const nodeRef = useRef(null);
  const callbacks = useRef({ getRange, onStart, onChange });
  callbacks.current = { getRange, onStart, onChange };

  useEffect(() => {
    const refresh = () => {
      const next = getRange();
      setRange(previous => previous.min === next.min && previous.max === next.max && previous.value === next.value ? previous : next);
    };
    refresh();
    return subscribe?.(refresh);
  }, [getRange, subscribe]);

  const finish = (cancel, updateState = true) => {
    const drag = active.current;
    if (!drag) return;
    active.current = null;
    drag.cleanup();
    try { if (drag.node.hasPointerCapture(drag.pointerId)) drag.node.releasePointerCapture(drag.pointerId); } catch { /* The browser may already have released capture. */ }
    const restore = cancel || !drag.moved;
    callbacks.current.onChange(drag.value, { commit: !restore, cancel: restore });
    if (updateState) setDragging(false);
  };

  useEffect(() => () => finish(true, false), []);

  const pointerDown = event => {
    if (event.button !== 0 || active.current) return;
    event.preventDefault();
    const node = event.currentTarget;
    node.focus();
    const vertical = orientation === 'vertical';
    const start = vertical ? event.clientX : event.clientY;
    const initial = callbacks.current.getRange().value;
    const body = node.ownerDocument.body;
    const root = node.ownerDocument.documentElement;
    const oldCursor = body.style.cursor;
    const oldSelect = body.style.userSelect;
    const oldRootCursor = root.style.cursor;
    const hadClass = body.classList.contains('workbench-resizing');
    body.style.cursor = root.style.cursor = vertical ? 'col-resize' : 'row-resize';
    body.style.userSelect = 'none';
    body.classList.add('workbench-resizing');
    const move = nativeEvent => {
      const drag = active.current;
      if (!drag || nativeEvent.pointerId !== drag.pointerId) return;
      nativeEvent.preventDefault();
      const current = vertical ? nativeEvent.clientX : nativeEvent.clientY;
      if (current === start && !drag.moved) return;
      drag.moved = true;
      const limits = callbacks.current.getRange();
      drag.value = Math.max(limits.min, Math.min(limits.max, initial + sign * (current - start)));
      callbacks.current.onChange(drag.value);
    };
    const up = nativeEvent => {
      if (nativeEvent.pointerId !== active.current?.pointerId) return;
      move(nativeEvent);
      finish(false);
    };
    const cancel = nativeEvent => { if (nativeEvent.pointerId === active.current?.pointerId) finish(true); };
    const escape = nativeEvent => { if (nativeEvent.key === 'Escape') { nativeEvent.preventDefault(); nativeEvent.stopPropagation(); finish(true); } };
    const blur = () => finish(true);
    const lost = nativeEvent => { if (nativeEvent.pointerId === active.current?.pointerId) finish(true); };
    const view = node.ownerDocument.defaultView;
    const cleanup = () => {
      view.removeEventListener('pointermove', move);
      view.removeEventListener('pointerup', up);
      view.removeEventListener('pointercancel', cancel);
      view.removeEventListener('keydown', escape, true);
      view.removeEventListener('blur', blur);
      node.removeEventListener('lostpointercapture', lost);
      body.style.cursor = oldCursor;
      body.style.userSelect = oldSelect;
      root.style.cursor = oldRootCursor;
      if (!hadClass) body.classList.remove('workbench-resizing');
    };
    active.current = { node, pointerId: event.pointerId, value: initial, moved: false, cleanup };
    callbacks.current.onStart?.();
    view.addEventListener('pointermove', move, { passive: false });
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', cancel);
    view.addEventListener('keydown', escape, true);
    view.addEventListener('blur', blur);
    node.addEventListener('lostpointercapture', lost);
    try { node.setPointerCapture(event.pointerId); } catch { /* Window listeners support browsers without capture. */ }
    setDragging(true);
  };

  const keyDown = event => {
    if (active.current) return;
    const limits = getRange();
    let value;
    if (event.key === 'Home') value = limits.min;
    else if (event.key === 'End') value = limits.max;
    else {
      const decrease = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';
      const increase = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
      if (event.key !== decrease && event.key !== increase) return;
      value = limits.value + (event.key === increase ? 1 : -1) * sign * (event.shiftKey ? 30 : 10);
    }
    event.preventDefault();
    onChange(value, { commit: true });
  };

  return <div
    ref={nodeRef}
    role="separator"
    tabIndex={0}
    aria-label={label}
    aria-orientation={orientation}
    aria-valuemin={Math.round(range.min)}
    aria-valuemax={Math.round(range.max)}
    aria-valuenow={Math.round(range.value)}
    aria-valuetext={`${Math.round(range.value)} px`}
    data-testid={`resize-${name}`}
    data-orientation={orientation}
    className={`split-handle split-handle-${orientation}${dragging ? ' is-dragging' : ''}`}
    onPointerDown={pointerDown}
    onKeyDown={keyDown}
    onDoubleClick={() => { finish(true); onReset?.(); }}
    title={`${label} · 拖动或方向键调整，双击恢复默认`}
    style={{ touchAction: 'none' }}
  ><span className="split-value" aria-hidden="true">{Math.round(range.value)} px</span></div>;
}
