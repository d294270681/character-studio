import Icon from './Icon.jsx';
import { mediaUrl, shortTime } from '../lib/studio.js';

export default function CandidateRail({ stage, assets, viewId, selectedId, onView, tip }) {
  const items = assets || [];
  return (
    <section className="rail">
      <div className="rail-head">
        <span className="rail-title">候选</span>
        <span className="rail-count">{items.length}</span>
        <span className="rail-tip" data-testid="rail-tip">
          {tip || '点击查看不会改变已选结果，只有“选用”才会进入下一步'}
        </span>
      </div>
      <div className="rail-strip">
        {items.length === 0 && (
          <div className="rail-empty">本步还没有结果，生成后候选会出现在这里</div>
        )}
        {items.map((item, index) => {
          const isView = item.id === viewId;
          const isSelected = item.id === selectedId;
          return (
            <button
              key={item.id}
              type="button"
              className={`candidate${isView ? ' is-view' : ''}${isSelected ? ' is-selected' : ''}`}
              onClick={() => onView(item.id)}
              title={`${item.model || '结果'} · ${shortTime(item.created_at)}`}
            >
              <span className="candidate-thumb">
                {stage === 'video' && !item.poster
                  ? <Icon name="film" size={22} />
                  : <img src={mediaUrl(item.poster || item.path)} alt="" />}
              </span>
              <span className="candidate-index">{String(index + 1).padStart(2, '0')}</span>
              {isSelected && (
                <span className="candidate-badge">
                  <Icon name="check" size={12} />
                  已选用
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
