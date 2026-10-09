import { useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import SpriteCanvas from './SpriteCanvas.jsx';

function PathRow({ label, value, onCopy }) {
  if (!value) return null;
  return (
    <div className="path-row">
      <span className="path-label">{label}</span>
      <code className="path-value" title={value}>{value}</code>
      <button type="button" className="icon-btn" title="复制路径" onClick={() => onCopy(value)}>
        <Icon name="copy" size={15} />
      </button>
    </div>
  );
}

export default function ExportDialog({ open, onClose, metadata, result, onShow, onSave, onCopy, record }) {
  const [mode, setMode] = useState('anim');
  const [playing, setPlaying] = useState(true);

  useEffect(() => {
    if (open) setPlaying(true);
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal-head">
          <span className="modal-title">
            <Icon name="layers" size={17} />
            Godot 导出预览
          </span>
          <button type="button" className="icon-btn" onClick={onClose} title="关闭">
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="modal-preview">
            {metadata ? (
              <SpriteCanvas
                sheetPath={metadata.sprite_sheet}
                metadata={metadata}
                mode={mode}
                playing={playing}
                className="modal-canvas"
              />
            ) : (
              <div className="preview-empty"><span>还没有可预览的精灵图</span></div>
            )}
          </div>

          <div className="modal-side">
            <div className="segmented slim">
              <button type="button" className={`segment${mode === 'anim' ? ' is-active' : ''}`} onClick={() => setMode('anim')}>
                循环动画
              </button>
              <button type="button" className={`segment${mode === 'sheet' ? ' is-active' : ''}`} onClick={() => setMode('sheet')}>
                精灵图网格
              </button>
            </div>
            {mode === 'anim' && (
              <button type="button" className="btn ghost small block" onClick={() => setPlaying(value => !value)}>
                <Icon name={playing ? 'pause' : 'play'} size={15} />
                <span>{playing ? '暂停' : '播放'}</span>
              </button>
            )}

            <div className="meta-box">
              <div className="meta-row"><span>动画名</span><strong>{metadata?.animation_name || '暂无'}</strong></div>
              <div className="meta-row"><span>帧数</span><strong>{metadata?.selected_frames?.length ?? '暂无'}</strong></div>
              <div className="meta-row"><span>单帧尺寸</span><strong>{metadata ? `${metadata.cell_size[0]} × ${metadata.cell_size[1]}` : '暂无'}</strong></div>
              <div className="meta-row"><span>播放帧率</span><strong>{metadata ? `${Number(metadata.animation_fps).toFixed(2)} fps` : '暂无'}</strong></div>
            </div>

            {result ? (
              <div className="path-list">
                <PathRow label="Godot 场景" value={result.scene_resource} onCopy={onCopy} />
                <PathRow label="精灵图" value={result.sprite_sheet} onCopy={onCopy} />
                <PathRow label="SpriteFrames" value={result.resource} onCopy={onCopy} />
              </div>
            ) : (
              <p className="modal-hint">还没有导出到 Godot。点击“导出到 Godot”后，这里会显示生成的场景与资源路径。</p>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn ghost small" disabled={!record} onClick={() => onShow(record)}>
            <Icon name="folder" size={15} />
            <span>在文件夹中显示</span>
          </button>
          <button type="button" className="btn ghost small" disabled={!record} onClick={() => onSave(record)}>
            <Icon name="save" size={15} />
            <span>保存精灵包</span>
          </button>
          <button type="button" className="btn accent" onClick={onClose}>
            <Icon name="check" size={16} />
            <span>完成</span>
          </button>
        </div>
      </div>
    </div>
  );
}
