import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';

/**
 * grow: fits wrapped text up to a limit based on the visible parameter panel.
 * fill: occupies its parent's allocated height (for the resizable chat composer).
 * All native textarea props and the forwarded ref refer to the textarea itself.
 */
const AdaptiveTextarea = forwardRef(function AdaptiveTextarea({
  mode = 'grow', minHeight = 110, maxHeight = 320, heightRatio = 0.45,
  showCount = mode === 'grow', className = '', style, value, defaultValue,
  onInput, ...props
}, forwardedRef) {
  const textareaRef = useRef(null);
  const wrapperRef = useRef(null);
  const refreshRef = useRef(null);
  const [scrollable, setScrollable] = useState(false);
  const [characterCount, setCharacterCount] = useState(Array.from(String(value ?? defaultValue ?? '')).length);
  useImperativeHandle(forwardedRef, () => textareaRef.current, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const wrapper = wrapperRef.current;
    const panel = textarea.closest('.panel-scroll');
    let frame = 0;
    let previousWidth = -1;
    let previousPanelHeight = -1;
    let previousFillHeight = -1;

    const measure = () => {
      frame = 0;
      if (!textarea.isConnected || wrapper.clientWidth === 0) return;
      const scrollTop = textarea.scrollTop;
      if (mode === 'grow') {
        const visibleHeight = panel?.clientHeight || window.innerHeight;
        const limit = Math.max(minHeight, Math.min(maxHeight, Math.max(220, visibleHeight * heightRatio)));
        const computed = getComputedStyle(textarea);
        const borders = parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);
        textarea.style.overflowY = 'hidden';
        textarea.style.maxHeight = `${limit}px`;
        textarea.style.height = '0px';
        const naturalHeight = textarea.scrollHeight + borders;
        textarea.style.height = `${Math.min(limit, Math.max(minHeight, naturalHeight))}px`;
      }
      const hasOverflow = textarea.scrollHeight > textarea.clientHeight + 1;
      textarea.style.overflowY = hasOverflow ? 'auto' : 'hidden';
      textarea.scrollTop = scrollTop;
      setScrollable(hasOverflow);
      setCharacterCount(Array.from(textarea.value).length);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    refreshRef.current = schedule;
    const observer = new ResizeObserver(() => {
      const width = wrapper.clientWidth;
      const panelHeight = panel?.clientHeight || window.innerHeight;
      const fillHeight = mode === 'fill' ? textarea.clientHeight : 0;
      // Ignore our own height changes so measurement cannot form a resize loop.
      if (width !== previousWidth || panelHeight !== previousPanelHeight || fillHeight !== previousFillHeight) {
        previousWidth = width;
        previousPanelHeight = panelHeight;
        previousFillHeight = fillHeight;
        schedule();
      }
    });
    observer.observe(wrapper);
    if (panel) observer.observe(panel);
    window.addEventListener('resize', schedule);
    document.fonts?.addEventListener('loadingdone', schedule);
    measure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      document.fonts?.removeEventListener('loadingdone', schedule);
      refreshRef.current = null;
    };
  }, [mode, minHeight, maxHeight, heightRatio]);

  // Covers assistant writes and workflow synchronization as well as normal typing.
  useLayoutEffect(() => {
    refreshRef.current?.();
  }, [value, defaultValue]);

  return (
    <div
      ref={wrapperRef}
      className={`adaptive-textarea-field is-${mode}`}
      style={{ minWidth: 0, width: '100%', ...(mode === 'fill' ? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } : {}) }}
    >
      <textarea
        {...props}
        ref={textareaRef}
        value={value}
        defaultValue={defaultValue}
        className={`adaptive-textarea ${className}`.trim()}
        style={{
          ...style, boxSizing: 'border-box', width: '100%', maxWidth: '100%', minWidth: 0,
          resize: 'none',
          ...(mode === 'fill'
            ? { flex: '1 1 0', height: '100%', minHeight: 0, maxHeight: 'none' }
            : { minHeight, maxHeight }),
        }}
        onInput={event => {
          onInput?.(event);
          refreshRef.current?.();
        }}
      />
      {showCount && (
        <div className="prompt-meta">
          <span>{characterCount.toLocaleString()} 字</span>
          {scrollable && <span className="prompt-scroll-hint">可滚动</span>}
        </div>
      )}
    </div>
  );
});

export default AdaptiveTextarea;
