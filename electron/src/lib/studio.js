export const STAGES = ['original', 'style', 'video', 'sprites'];

export const STAGE_LABELS = {
  original: '人物原始图',
  style: '人物风格化',
  video: '生成视频',
  sprites: '转换精灵图',
};

export const STAGE_TITLES = {
  original: '描述人物，生成完整的原始图',
  style: '保留人物特征，转换成你想要的画风',
  video: '选定风格图，生成一段人物动作',
  sprites: '挑选动作循环，输出可用的精灵图',
};

export const MODEL_BADGES = {
  original: 'Qwen-Image 2512',
  style: 'Qwen-Image-Edit 2511',
  video: 'MiniMax H3',
  sprites: '透明 PNG / Godot',
};

export const PRIMARY_LABELS = {
  original: '生成原始图',
  style: '生成风格图',
  video: '生成视频',
  sprites: '转换精灵图',
};

export const INPUT_STAGE = {
  original: 'original',
  style: 'original',
  video: 'style',
  sprites: 'video',
};

export const IMPORT_LABELS = {
  original: '导入原始图',
  style: '导入原始图',
  video: '导入风格图',
  sprites: '导入视频',
};

export const NEXT_LABELS = {
  original: '用这张原图去风格化',
  style: '用这张风格图生成视频',
  video: '用这段视频转换精灵图',
  sprites: '导出到 Godot 并预览',
};

export const call = (method, route, body) => window.studio.api(method, route, body);

export const mediaUrl = filePath =>
  `studio-media://asset/?path=${encodeURIComponent(filePath || '')}`;

export const sameValue = (left, right) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const clone = value => JSON.parse(JSON.stringify(value ?? null));

export const sizeLabel = size => `${size[0]} × ${size[1]}`;

export function videoLengthLabel(frames) {
  return `${frames} 帧 · 约 ${(frames / 24).toFixed(1)} 秒`;
}

export function animationNameFor(motion) {
  if (motion === '原地待机') return 'idle';
  if (motion === '向右行走') return 'walk_right';
  if (motion === '向左行走（侧面）') return 'walk_left';
  return 'walk_left_front';
}

export function shortTime(value) {
  if (!value) return '';
  const text = String(value).replace('T', ' ');
  return text.length >= 16 ? text.slice(5, 16) : text;
}

export function baseName(filePath) {
  if (!filePath) return '';
  const parts = String(filePath).split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

export function errorText(error) {
  if (!error) return '';
  const message = error.message || String(error);
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}
