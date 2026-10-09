export const STORAGE_KEY = 'character-studio.workbench-layout.v1';
export const GUTTER = 8;
export const DEFAULT_LAYOUT = Object.freeze({ sidebar: 208, parameters: 320, assistant: 384, candidates: 156, composer: 164, console: 192 });
export const LIMITS = Object.freeze({
  sidebar: { min: 184, max: 320 }, parameters: { min: 240, max: 560 },
  assistant: { min: 300, max: 680 }, candidates: { min: 104, max: 360 }, composer: { min: 136, max: 360 },
  console: { min: 140, max: 500 },
});
export const CSS_VARIABLES = Object.freeze({ sidebar: '--sidebar-width', parameters: '--parameter-width', assistant: '--assistant-width', candidates: '--candidate-height', composer: '--composer-height', console: '--console-height' });
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeLayout(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(Object.keys(DEFAULT_LAYOUT).map(name => [name,
    typeof source[name] === 'number' && Number.isFinite(source[name])
      ? clamp(source[name], LIMITS[name].min, LIMITS[name].max) : DEFAULT_LAYOUT[name],
  ]));
}

export function parseLayout(serialized) {
  try { return normalizeLayout(JSON.parse(serialized)); } catch { return { ...DEFAULT_LAYOUT }; }
}

const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

export function layoutMetrics(metrics = {}) {
  const assistantOpen = !!metrics.assistantOpen;
  return {
    assistantOpen,
    width: Math.max(0, positive(metrics.rootWidth, 1600) - Math.max(0, metrics.horizontalOverhead || 0) - GUTTER * (assistantOpen ? 3 : 2)),
    previewMin: positive(metrics.previewMin, 280),
    previewHeight: positive(metrics.previewHeight, 600),
    assistantHeight: positive(metrics.assistantHeight, 600),
    workspaceHeight: positive(metrics.workspaceHeight, 800),
  };
}

// Keep preferences separate from this temporary fit, so a smaller window never
// erases the sizes the user chose in a larger one.
export function fitLayout(preferences, metrics = {}, priority) {
  const result = normalizeLayout(preferences);
  const space = layoutMetrics(metrics);
  const names = ['sidebar', 'parameters', ...(space.assistantOpen ? ['assistant'] : [])];
  const minima = names.reduce((sum, name) => sum + LIMITS[name].min, 0);
  // At the supported minimum width all panel minima and a 280px preview fit.
  // A smaller embedded surface may use a 260px preview before overflowing.
  const previewMin = Math.min(space.previewMin, Math.max(260, space.width - minima));
  let deficit = Math.max(0, names.reduce((sum, name) => sum + result[name], 0) + previewMin - space.width);
  const shrink = group => {
    const surplus = group.reduce((sum, name) => sum + result[name] - LIMITS[name].min, 0);
    if (!surplus || !deficit) return;
    const amount = Math.min(deficit, surplus);
    for (const name of group) result[name] -= amount * (result[name] - LIMITS[name].min) / surplus;
    deficit -= amount;
  };
  shrink(names.filter(name => name !== priority));
  if (names.includes(priority)) shrink([priority]);
  const candidateMax = Math.max(LIMITS.candidates.min, Math.min(LIMITS.candidates.max, space.previewHeight - GUTTER - 220));
  const composerMax = Math.max(LIMITS.composer.min, Math.min(LIMITS.composer.max, space.assistantHeight - GUTTER - 160));
  result.candidates = clamp(result.candidates, LIMITS.candidates.min, candidateMax);
  result.composer = clamp(result.composer, LIMITS.composer.min, composerMax);
  result.console = clamp(result.console, LIMITS.console.min, Math.max(LIMITS.console.min,
    Math.min(LIMITS.console.max, space.workspaceHeight - GUTTER - 330)));
  return result;
}

export function handleRange(name, liveLayout, metrics = {}) {
  if (!LIMITS[name]) throw new Error(`Unknown workbench separator: ${name}`);
  const space = layoutMetrics(metrics);
  const { min, max: hardMax } = LIMITS[name];
  let max = hardMax;
  if (name === 'candidates') max = Math.min(max, space.previewHeight - GUTTER - 220);
  else if (name === 'composer') max = Math.min(max, space.assistantHeight - GUTTER - 160);
  else if (name === 'console') max = Math.min(max, space.workspaceHeight - GUTTER - 330);
  else {
    const others = ['sidebar', 'parameters', ...(space.assistantOpen ? ['assistant'] : [])].filter(key => key !== name);
    const minimumOthers = others.reduce((sum, key) => sum + LIMITS[key].min, 0);
    const previewMin = Math.min(space.previewMin, Math.max(260, space.width - minimumOthers - min));
    max = Math.min(max, space.width - minimumOthers - previewMin);
  }
  max = Math.max(min, max);
  return { min, max, value: clamp(liveLayout[name], min, max) };
}
