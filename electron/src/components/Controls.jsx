import { Children, cloneElement, isValidElement, useEffect, useId, useState } from 'react';
import Icon from './Icon.jsx';

export function Field({ label, hint, children, action }) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const controls = Children.map(children, child => {
    if (!isValidElement(child) || child.type === 'p' || child.type === 'span') return child;
    return cloneElement(child, {
      'aria-labelledby': [child.props['aria-labelledby'], label ? labelId : null].filter(Boolean).join(' ') || undefined,
      'aria-describedby': [child.props['aria-describedby'], hint ? hintId : null].filter(Boolean).join(' ') || undefined,
    });
  });
  return (
    <div className="field">
      {(label || action) && (
        <div className="field-head">
          <span className="field-label" id={labelId}>{label}</span>
          {action}
        </div>
      )}
      {controls}
      {hint && <p className="field-hint" id={hintId}>{hint}</p>}
    </div>
  );
}

export function NumberField({ value, min = 0, max = 999, step = 1, onChange, disabled, suffix, ...inputProps }) {
  const [draft, setDraft] = useState(String(value ?? ''));

  useEffect(() => {
    setDraft(current => (Number(current) === Number(value) ? current : String(value ?? '')));
  }, [value]);

  const clamp = next => Math.max(min, Math.min(max, next));

  const commit = raw => {
    const cleaned = step < 1
      ? String(raw).replace(/[^\d.-]/g, '')
      : String(raw).replace(/[^\d-]/g, '');
    const parsed = step < 1 ? Number.parseFloat(cleaned) : Number.parseInt(cleaned, 10);
    const next = Number.isFinite(parsed) ? clamp(parsed) : clamp(min);
    const rounded = step < 1 ? Math.round(next * 100) / 100 : next;
    setDraft(String(rounded));
    if (rounded !== Number(value)) onChange(rounded);
  };

  return (
    <div className={`numfield${disabled ? ' is-disabled' : ''}`}>
      <button
        type="button"
        className="num-btn"
        aria-label="减少"
        disabled={disabled || Number(value) <= min}
        onClick={() => commit(clamp(Number(value) - step))}
      >
        <Icon name="minus" size={16} />
      </button>
      <input
        {...inputProps}
        className="num-input"
        value={draft}
        inputMode="numeric"
        disabled={disabled}
        onChange={event => setDraft(step < 1
          ? event.target.value.replace(/[^\d.-]/g, '')
          : event.target.value.replace(/[^\d-]/g, ''))}
        onBlur={event => commit(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') commit(event.currentTarget.value);
          if (event.key === 'ArrowUp') { event.preventDefault(); commit(clamp(Number(value) + step)); }
          if (event.key === 'ArrowDown') { event.preventDefault(); commit(clamp(Number(value) - step)); }
        }}
      />
      {suffix && <span className="num-suffix">{suffix}</span>}
      <button
        type="button"
        className="num-btn"
        aria-label="增加"
        disabled={disabled || Number(value) >= max}
        onClick={() => commit(clamp(Number(value) + step))}
      >
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

export function Segmented({ options, value, onChange, disabled, columns, ...groupProps }) {
  return (
    <div {...groupProps} role="group" className="segmented" style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
      {options.map(option => (
        <button
          key={String(option.value)}
          type="button"
          className={`segment${option.value === value ? ' is-active' : ''}`}
          disabled={disabled}
          title={option.title || option.label}
          onClick={() => onChange(option.value)}
        >
          {option.icon && <Icon name={option.icon} size={14} />}
          <span>{option.label}</span>
        </button>
      ))}
    </div>
  );
}

export function SelectField({ options, value, onChange, disabled, ...selectProps }) {
  return (
    <div className={`selectfield${disabled ? ' is-disabled' : ''}`}>
      <select {...selectProps} value={value ?? ''} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {options.map(option => (
          <option key={String(option.value)} value={option.value}>{option.label}</option>
        ))}
      </select>
      <Icon name="chevronDown" size={15} className="select-caret" />
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }) {
  return (
    <button
      type="button"
      className={`toggle${checked ? ' is-on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span className="toggle-track"><span className="toggle-knob" /></span>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </button>
  );
}

export function SeedField({ value, onChange, disabled, ...inputProps }) {
  return (
    <div className={`seedfield${disabled ? ' is-disabled' : ''}`}>
      <input
        {...inputProps}
        className="text-input"
        value={value ?? ''}
        placeholder="留空则随机"
        inputMode="numeric"
        disabled={disabled}
        onChange={event => onChange(event.target.value.replace(/[^\d]/g, ''))}
      />
      <button type="button" className="icon-btn" title="清空，使用随机种子" disabled={disabled} onClick={() => onChange('')}>
        <Icon name="dice" size={16} />
      </button>
    </div>
  );
}
