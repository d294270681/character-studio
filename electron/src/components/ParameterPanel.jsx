import Icon from './Icon.jsx';
import AdaptiveTextarea from './AdaptiveTextarea.jsx';
import { Field, NumberField, Segmented, SelectField, SeedField, Toggle } from './Controls.jsx';
import {
  IMPORT_LABELS, PRIMARY_LABELS, baseName, mediaUrl, sizeLabel, videoLengthLabel,
} from '../lib/studio.js';

function ReferenceCard({ title, record }) {
  return (
    <div className={`reference${record ? '' : ' is-empty'}`}>
      <div className="reference-thumb">
        {record
          ? <img src={mediaUrl(record.poster || record.path)} alt="" />
          : <Icon name="image" size={18} />}
      </div>
      <div className="reference-text">
        <span className="reference-title">{title}</span>
        <span className="reference-name">{record ? baseName(record.path) : '尚未选定'}</span>
      </div>
    </div>
  );
}

export default function ParameterPanel({
  stage, form, presets, missing, selected, disabled, onPatch, onGenerate, onImport,
  primaryOverride, supportsPrompt, workflowNotice,
}) {
  const qualities = presets.qualities.map((mode, index) => ({
    value: index, label: mode.label, title: `${mode.steps} 步 · ${mode.acceleration === 'none' ? '原模型' : mode.acceleration}`,
  }));
  const imageSizes = presets.image_sizes.map(size => ({ value: sizeLabel(size), label: sizeLabel(size), size }));
  const videoSizes = presets.video_sizes.map(size => ({ value: sizeLabel(size), label: sizeLabel(size), size }));
  const cellSizes = presets.cell_sizes.map(size => ({ value: sizeLabel(size), label: sizeLabel(size), size }));
  const pickSize = (list, fallbackWidth, fallbackHeight) => {
    const match = list.find(option => option.size[0] === form.width && option.size[1] === form.height);
    return match ? match.value : sizeLabel([fallbackWidth, fallbackHeight]);
  };
  const applySize = (list, key) => {
    const option = list.find(item => item.value === key);
    if (!option) return;
    onPatch('width', option.size[0]);
    onPatch('height', option.size[1]);
  };
  const qualityIndex = Number.isInteger(form.quality) ? form.quality : 1;
  const blocked = missing.length > 0;
  const primaryLabel = primaryOverride?.label || PRIMARY_LABELS[stage];
  const primaryBusy = !!primaryOverride?.busy;
  const primaryDisabled = disabled || blocked || !!primaryOverride?.disabled;

  return (
    <section className="panel params">
      <div className="panel-heading">
        <h2>生成参数</h2>
        <span className="panel-heading-hint">按需调整</span>
      </div>
      <div className="panel-scroll">
        {workflowNotice && (
          <div className="notice info" data-testid="param-workflow-notice">
            <span className="wf-spinner tiny" />
            <span>{workflowNotice}</span>
          </div>
        )}
        {stage !== 'original' && (
          <ReferenceCard
            title={{ style: '输入：已选原始图', video: '输入：已选风格图', sprites: '输入：已选视频' }[stage]}
            record={stage === 'style' ? selected.original : stage === 'video' ? selected.style : selected.video}
          />
        )}

        {stage === 'original' && (
          <Field label="人物描述">
            <AdaptiveTextarea
              className="text-area tall"
              minHeight={150}
              data-testid="param-original-prompt"
              value={form.prompt || ''}
              disabled={disabled}
              onChange={event => onPatch('prompt', event.target.value)}
            />
          </Field>
        )}

        {stage === 'style' && (
          <>
            <Field label="画风">
              <Segmented
                columns={3}
                disabled={disabled}
                value={form.style}
                onChange={value => onPatch('style', value)}
                options={presets.styles.map(style => ({ value: style, label: style }))}
              />
            </Field>
            <Field label="视角">
              <Segmented
                columns={2}
                disabled={disabled}
                value={form.view}
                onChange={value => onPatch('view', value)}
                options={presets.views.map(view => ({ value: view, label: view }))}
              />
            </Field>
            <Toggle
              checked={!!form.white}
              disabled={disabled}
              onChange={value => onPatch('white', value)}
              label="纯白背景"
              hint="去掉地面阴影与场景，方便转精灵图"
            />
            <Field label="额外要求（可选）">
              <AdaptiveTextarea
                className="text-area"
                minHeight={80}
                data-testid="param-style-extra"
                value={form.extra || ''}
                disabled={disabled}
                placeholder="例如：保留绿色长裙，双手自然下垂"
                onChange={event => onPatch('extra', event.target.value)}
              />
            </Field>
            {supportsPrompt && (
              <Field label="风格提示词" hint="留空则按画风、视角与白底自动生成；改动上面的选项会清空它。">
                <AdaptiveTextarea
                  className="text-area prompt-area"
                  data-testid="param-style-prompt"
                  value={form.prompt || ''}
                  disabled={disabled}
                  placeholder="直接写给 Qwen-Image-Edit 的完整提示词"
                  onChange={event => onPatch('prompt', event.target.value)}
                />
              </Field>
            )}
          </>
        )}

        {stage === 'video' && (
          <>
            <Toggle
              checked={form.clean_background !== false}
              disabled={disabled}
              onChange={value => onPatch('clean_background', value)}
              label="白底净化"
              hint="生成后抑制白底灰影，同时保留模型原视频"
            />
            <Field label="动作">
              <SelectField
                disabled={disabled}
                value={form.motion}
                onChange={value => onPatch('motion', value)}
                options={presets.motions.map(motion => ({ value: motion, label: motion }))}
              />
            </Field>
            <Field label="视频长度">
              <SelectField
                disabled={disabled}
                value={String(form.length)}
                onChange={value => onPatch('length', Number(value))}
                options={[76, 124, 196].map(frames => ({ value: String(frames), label: videoLengthLabel(frames) }))}
              />
            </Field>
            <Field label="画面尺寸">
              <SelectField
                disabled={disabled}
                value={pickSize(videoSizes, 512, 768)}
                onChange={value => applySize(videoSizes, value)}
                options={videoSizes}
              />
            </Field>
            <Field label="额外要求（可选）">
              <AdaptiveTextarea
                className="text-area"
                minHeight={80}
                data-testid="param-video-extra"
                value={form.extra || ''}
                disabled={disabled}
                placeholder="例如：步伐放慢，手臂摆动小一些"
                onChange={event => onPatch('extra', event.target.value)}
              />
            </Field>
            {supportsPrompt && (
              <Field label="动作提示词" hint="留空则按动作与额外要求自动生成；改动上面的选项会清空它。">
                <AdaptiveTextarea
                  className="text-area prompt-area"
                  data-testid="param-video-prompt"
                  value={form.prompt || ''}
                  disabled={disabled}
                  placeholder="直接写给 MiniMax H3 的完整动作提示词"
                  onChange={event => onPatch('prompt', event.target.value)}
                />
              </Field>
            )}
          </>
        )}

        {stage === 'sprites' && (
          <>
            <Field label="抽帧方式" hint={form.sampling === 'source' ? '保留所选区间的每一帧和原帧率，最多 256 帧。' : '按下面的帧数均匀抽样，帧数较少时动作会更跳跃。'}>
              <SelectField
                disabled={disabled}
                value={form.sampling || 'uniform'}
                onChange={value => onPatch('sampling', value)}
                options={[{ value: 'uniform', label: '指定帧数' }, { value: 'source', label: '保留每一帧（高还原）' }]}
              />
            </Field>
            <div className="param-grid">
              <Field label="精灵帧数">
                <NumberField
                  value={form.frames}
                  min={2}
                  max={64}
                  disabled={disabled || form.sampling === 'source'}
                  onChange={value => onPatch('frames', value)}
                />
              </Field>
              <Field label="每行列数">
                <NumberField
                  value={form.columns}
                  min={1}
                  max={16}
                  disabled={disabled}
                  onChange={value => onPatch('columns', value)}
                />
              </Field>
            </div>
            <Field label="单帧尺寸">
              <SelectField
                disabled={disabled}
                value={sizeLabel(form.cell_size || [384, 512])}
                onChange={value => {
                  const option = cellSizes.find(item => item.value === value);
                  if (option) onPatch('cell_size', option.size);
                }}
                options={cellSizes}
              />
            </Field>
            <Field label="像素网格" hint={`1× 保留细节；当前有效分辨率 ${Math.floor((form.cell_size?.[0] || 384) / (form.pixel_grid || 1))} × ${Math.floor((form.cell_size?.[1] || 512) / (form.pixel_grid || 1))}，更大的网格会减少细节。`}>
              <Segmented
                columns={4}
                disabled={disabled}
                value={form.pixel_grid}
                onChange={value => onPatch('pixel_grid', value)}
                options={[1, 2, 4, 8].map(grid => ({ value: grid, label: `${grid}×` }))}
              />
            </Field>
            <Field label="画面对齐" hint="保留原始运动可保留身体起伏；对齐脚底会稳定人物位置。">
              <SelectField
                disabled={disabled}
                value={form.alignment || 'source'}
                onChange={value => onPatch('alignment', value)}
                options={[{ value: 'source', label: '保留原始运动' }, { value: 'feet', label: '对齐脚底' }]}
              />
            </Field>
            <Toggle
              checked={form.remove_shadows !== false}
              disabled={disabled}
              onChange={value => onPatch('remove_shadows', value)}
              label="抑制白底灰影"
              hint="参考开头画面去除中性灰影；浅灰服装附近可能仍有残留"
            />
            <Toggle
              checked={!!form.transparent}
              disabled={disabled}
              onChange={value => onPatch('transparent', value)}
              label="透明背景"
              hint="关闭后输出白底精灵图"
            />
            <Toggle
              checked={!!form.auto_cycle}
              disabled={disabled}
              onChange={value => onPatch('auto_cycle', value)}
              label="自动挑选循环"
              hint="关闭后手动填写起止时间"
            />
            {!form.auto_cycle && (
              <div className="param-grid">
                <Field label="起始秒">
                  <NumberField
                    value={Math.round(Number(form.start_seconds) * 100) / 100}
                    min={0}
                    max={60}
                    step={0.1}
                    disabled={disabled}
                    onChange={value => onPatch('start_seconds', value)}
                  />
                </Field>
                <Field label="结束秒">
                  <NumberField
                    value={Math.round(Number(form.end_seconds) * 100) / 100}
                    min={0}
                    max={60}
                    step={0.1}
                    disabled={disabled}
                    onChange={value => onPatch('end_seconds', value)}
                  />
                </Field>
              </div>
            )}
            <Field label="动画名称" hint="写入 Godot SpriteFrames 的动画名">
              <input
                className="text-input"
                value={form.animation_name || ''}
                disabled={disabled}
                onChange={event => onPatch('animation_name', event.target.value)}
              />
            </Field>
          </>
        )}

        {stage === 'original' || stage === 'style' ? (
          <>
            <Field label="画面尺寸">
              <SelectField
                disabled={disabled}
                value={pickSize(imageSizes, 768, 1152)}
                onChange={value => applySize(imageSizes, value)}
                options={imageSizes}
              />
            </Field>
            <Field label="生成质量">
              <SelectField
                disabled={disabled}
                value={qualityIndex}
                onChange={value => onPatch('quality', Number(value))}
                options={qualities}
              />
            </Field>
            <Field label="候选数量">
              <NumberField
                value={form.count}
                min={1}
                max={4}
                disabled={disabled}
                onChange={value => onPatch('count', value)}
              />
            </Field>
          </>
        ) : null}

        {stage !== 'sprites' && (
          <Field label="随机种子">
            <SeedField
              value={form.seed ?? ''}
              disabled={disabled}
              onChange={value => onPatch('seed', value)}
            />
          </Field>
        )}

        {blocked && (
          <div className="notice warn">
            <Icon name="alert" size={15} />
            <span>缺少模型文件：{missing.map(baseName).join('、')}</span>
          </div>
        )}
      </div>

      <div className="panel-actions">
        <button
          type="button"
          className="btn primary block"
          data-testid="generate-button"
          data-stage={stage}
          data-busy={primaryBusy ? 'true' : 'false'}
          disabled={primaryDisabled}
          onClick={onGenerate}
        >
          {primaryBusy ? <span className="wf-spinner" /> : <Icon name="sparkle" size={17} />}
          <span>{primaryLabel}</span>
        </button>
        <button type="button" className="btn ghost block" data-testid="import-action" disabled={disabled} onClick={onImport}>
          <Icon name="folderOpen" size={16} />
          <span>{IMPORT_LABELS[stage]}</span>
        </button>
        <p className="panel-note">
          {stage === 'sprites' ? '输入阶段：' : '本步输入：'}
          {stage === 'original' ? '文字描述' : stage === 'style' ? '已选原始图' : stage === 'video' ? '已选风格图' : '已选视频'}
        </p>
      </div>
    </section>
  );
}
