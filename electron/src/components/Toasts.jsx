import Icon from './Icon.jsx';

export default function Toasts({ items, onDismiss }) {
  if (!items.length) return null;
  return (
    <div className="toasts">
      {items.map(item => (
        <div key={item.id} className={`toast ${item.kind || 'info'}`}>
          <Icon name={item.kind === 'error' ? 'alert' : item.kind === 'success' ? 'check' : 'sparkle'} size={16} />
          <div className="toast-text">
            {item.title && <strong>{item.title}</strong>}
            <span>{item.text}</span>
          </div>
          <button type="button" className="icon-btn" onClick={() => onDismiss(item.id)} title="关闭">
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
