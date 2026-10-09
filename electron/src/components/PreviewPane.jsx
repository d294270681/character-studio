import { useState } from 'react';
import Icon from './Icon.jsx';
import SpriteCanvas from './SpriteCanvas.jsx';
import { NEXT_LABELS, baseName, mediaUrl, shortTime } from '../lib/studio.js';

const PREVIEW_ICONS = { original: 'image', style: 'palette', video: 'film', sprites: 'grid' };

function Empty({ text }) {
  return (
    <div className="preview-empty">
      <Icon name="image" size={26} />
      <span>{text}</span>
    </div>
  );
}

function MetaLine({ record }) {
  if (!record) return null;
  const parts = [record.model, record.style, record.steps ? `${record.steps} 步` : null,
    record.seed ? `种子 ${record.seed}` : null,
    record.background_cleaned ? '白底已净化' : null,
    record.frames ? `${record.frames} 帧` : null,
    record.animation_fps ? `${Number(Number(record.animation_fps).toFixed(2))} fps` : null,
    shortTime(record.created_at)].filter(Boolean);
  return <span className="meta-line">{parts.join(' · ')}</span>;
}

export default function PreviewPane({
  stage, record, reference, spriteMetadata, spriteMetadataError, disabled,
  onSave, onShow, onUse, onImport, onDropPaths,
}) {
  const [compare, setCompare] = useState(false);
  const [spriteMode, setSpriteMode] = useState('anim');
  const [playing, setPlaying] = useState(true);
  const [dragging, setDragging] = useState(false);

  const dropProps = {
    onDragOver: event => { event.preventDefault(); setDragging(true); },
    onDragLeave: () => setDragging(false),
    onDrop: event => {
      event.preventDefault();
      setDragging(false);
      const paths = Array.from(event.dataTransfer.files || [])
        .map(file => window.studio.filePath(file))
        .filter(Boolean);
      if (paths.length) onDropPaths(paths);
    },
  };

  let body = <Empty text="还没有结果，先在左侧生成或导入一个文件" />;
  if (record) {
    if (stage === 'video') {
      body = (
        <video
          className="video-player"
          src={mediaUrl(record.path)}
          poster={record.poster ? mediaUrl(record.poster) : undefined}
          controls
          playsInline
        />
      );
    } else if (stage === 'sprites') {
      body = spriteMetadata ? (
        <div className="sprite-stage">
          <SpriteCanvas
            sheetPath={spriteMetadata.sprite_sheet}
            metadata={spriteMetadata}
            mode={spriteMode}
            playing={playing}
          />
          {spriteMode === 'anim' && (
            <button type="button" className="play-float" onClick={() => setPlaying(value => !value)}>
              <Icon name={playing ? 'pause' : 'play'} size={15} />
              <span>{playing ? '暂停' : '播放'}</span>
            </button>
          )}
        </div>
      ) : (
        <Empty text={spriteMetadataError || '正在读取精灵图动画信息…'} />
      );
    } else if (stage === 'style' && compare && reference) {
      body = (
        <div className="compare-row">
          <figure className="compare-cell">
            <img src={mediaUrl(reference.path)} alt="" />
            <figcaption>原始图</figcaption>
          </figure>
          <figure className="compare-cell">
            <img src={mediaUrl(record.path)} alt="" />
            <figcaption>风格图</figcaption>
          </figure>
        </div>
      );
    } else {
      body = <img className="image-preview" src={mediaUrl(record.path)} alt="" />;
    }
  }

  return (
    <section className="panel preview">
      <div className="preview-bar">
        <div className="preview-title">
          <div className="preview-file-title">
            <Icon name={PREVIEW_ICONS[stage]} size={16} className="preview-icon" />
            <span className="preview-name" title={record ? baseName(record.path) : undefined}>
              {record ? baseName(record.path) : '预览'}
            </span>
          </div>
          <MetaLine record={record} />
        </div>
        <div className="preview-tools">
          {stage === 'style' && (
            <button
              type="button"
              className={`chip${compare ? ' is-active' : ''}`}
              onClick={() => setCompare(value => !value)}
              disabled={!reference}
              title="与已选原始图并排对比"
              aria-label="对比原图"
            >
              <Icon name="compare" size={14} />
              <span>对比原图</span>
            </button>
          )}
          {stage === 'sprites' && (
            <div className="segmented slim">
              <button
                type="button"
                className={`segment${spriteMode === 'anim' ? ' is-active' : ''}`}
                onClick={() => setSpriteMode('anim')}
              >
                循环动画
              </button>
              <button
                type="button"
                className={`segment${spriteMode === 'sheet' ? ' is-active' : ''}`}
                onClick={() => setSpriteMode('sheet')}
              >
                精灵图网格
              </button>
            </div>
          )}
          <button type="button" className="btn ghost small" aria-label="保存文件" title="保存文件" disabled={!record} onClick={() => onSave(record)}>
            <Icon name="save" size={15} />
            <span>保存文件</span>
          </button>
          <button type="button" className="btn ghost small" aria-label="查看记录" title="查看记录" disabled={!record} onClick={() => onShow(record)}>
            <Icon name="folder" size={15} />
            <span>查看记录</span>
          </button>
        </div>
      </div>

      <div className={`preview-body${dragging ? ' is-dragging' : ''}`} {...dropProps}>
        {body}
        {dragging && (
          <div className="drop-hint">
            <Icon name="download" size={22} />
            <span>松开即导入到本步输入</span>
          </div>
        )}
      </div>

      <div className="preview-foot">
        <button type="button" className="btn ghost small" aria-label="导入文件" title="导入文件" disabled={disabled} onClick={onImport}>
          <Icon name="folderOpen" size={15} />
          <span>导入文件</span>
        </button>
        <button type="button" className="btn accent" disabled={!record || disabled} onClick={() => onUse(record)}>
          <span>{NEXT_LABELS[stage]}</span>
          <Icon name="arrowRight" size={16} />
        </button>
      </div>
    </section>
  );
}
