const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

// Import the dependency-free ES module without changing Electron's CJS package.
const moduleReady = fs.readFile(path.join(__dirname, '../src/lib/workbench-layout.js'), 'utf8')
  .then(source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));

test('broken and hostile stored values recover valid bounded preferences', async () => {
  const { parseLayout, normalizeLayout, DEFAULT_LAYOUT } = await moduleReady;
  for (const raw of ['{broken', '', null, 'null', '[]', '"oops"']) assert.deepEqual(parseLayout(raw), DEFAULT_LAYOUT);
  assert.deepEqual(normalizeLayout({ sidebar: NaN, parameters: Infinity, assistant: '600', candidates: null, composer: {} }), DEFAULT_LAYOUT);
  assert.deepEqual(parseLayout('{"sidebar":9999,"parameters":-20,"assistant":301,"candidates":500,"composer":0,"unknown":12}'), {
    sidebar: 320, parameters: 240, assistant: 301, candidates: 360, composer: 136, console: 192,
  });
});

test('all default sizes remain intact when the workbench has sufficient space', async () => {
  const { fitLayout, DEFAULT_LAYOUT } = await moduleReady;
  assert.deepEqual(fitLayout(DEFAULT_LAYOUT, { rootWidth: 1600, assistantOpen: true, previewHeight: 720, assistantHeight: 720 }), DEFAULT_LAYOUT);
});

test('minimum 1100px window shares shrinkage and preserves a 280px preview with stage padding', async () => {
  const { fitLayout, DEFAULT_LAYOUT, LIMITS } = await moduleReady;
  const preferences = { ...DEFAULT_LAYOUT };
  const live = fitLayout(preferences, { rootWidth: 1100, horizontalOverhead: 32, assistantOpen: true });
  for (const name of ['sidebar', 'parameters', 'assistant']) {
    assert.ok(live[name] >= LIMITS[name].min, `${name} respects its minimum`);
    assert.ok(live[name] < DEFAULT_LAYOUT[name], `${name} shares the contraction`);
  }
  assert.ok(Math.abs(1100 - 32 - 24 - live.sidebar - live.parameters - live.assistant - 280) < 0.001);
  assert.deepEqual(preferences, DEFAULT_LAYOUT, 'temporary fit does not mutate preferences');
});

test('a dragged pane can grow while its neighbours shrink to their own minima', async () => {
  const { fitLayout, handleRange, DEFAULT_LAYOUT } = await moduleReady;
  const metrics = { rootWidth: 1100, horizontalOverhead: 32, assistantOpen: true };
  const initial = fitLayout(DEFAULT_LAYOUT, metrics);
  const { max } = handleRange('assistant', initial, metrics);
  assert.equal(max, 340);
  const live = fitLayout({ ...DEFAULT_LAYOUT, assistant: max }, metrics, 'assistant');
  assert.equal(live.assistant, 340);
  assert.equal(live.sidebar, 184);
  assert.equal(live.parameters, 240);
});

test('closing the assistant and expanding the window recovers desired widths', async () => {
  const { fitLayout, DEFAULT_LAYOUT } = await moduleReady;
  const desired = { ...DEFAULT_LAYOUT, sidebar: 310, parameters: 540, assistant: 660 };
  const small = fitLayout(desired, { rootWidth: 1100, assistantOpen: true });
  assert.ok(small.assistant < desired.assistant);
  const closed = fitLayout(desired, { rootWidth: 1300, assistantOpen: false });
  assert.equal(closed.sidebar, 310);
  assert.equal(closed.parameters, 540);
  assert.equal(closed.assistant, 660, 'hidden assistant retains its preference');
  assert.deepEqual(fitLayout(desired, { rootWidth: 2200, assistantOpen: true }), desired);
});

test('candidate and composer limits reserve readable space in their measured containers', async () => {
  const { fitLayout, handleRange, DEFAULT_LAYOUT } = await moduleReady;
  const metrics = { rootWidth: 1600, previewHeight: 390, assistantHeight: 340, assistantOpen: true };
  const live = fitLayout({ ...DEFAULT_LAYOUT, candidates: 360, composer: 360 }, metrics);
  assert.equal(live.candidates, 162);
  assert.equal(live.composer, 172);
  assert.deepEqual(handleRange('candidates', live, metrics), { min: 104, max: 162, value: 162 });
  assert.deepEqual(handleRange('composer', live, metrics), { min: 136, max: 172, value: 172 });
});

test('ranges expose current live values and safe limits for keyboard Home and End', async () => {
  const { fitLayout, handleRange, DEFAULT_LAYOUT } = await moduleReady;
  const metrics = { rootWidth: 1100, horizontalOverhead: 32, assistantOpen: true };
  const live = fitLayout(DEFAULT_LAYOUT, metrics);
  for (const name of Object.keys(DEFAULT_LAYOUT)) {
    const range = handleRange(name, live, metrics);
    assert.equal(range.value, live[name]);
    assert.ok(range.min <= range.value && range.value <= range.max);
  }
  assert.throws(() => handleRange('unknown', live, metrics), /Unknown workbench separator/);
});

test('console height yields to the preview on small windows without erasing the preference', async () => {
  const { fitLayout, handleRange, DEFAULT_LAYOUT } = await moduleReady;
  const desired = { ...DEFAULT_LAYOUT, console: 500 };
  const metrics = { workspaceHeight: 520 };
  const fitted = fitLayout(desired, metrics);
  assert.equal(fitted.console, 182);
  assert.equal(handleRange('console', fitted, metrics).max, 182);
  assert.equal(desired.console, 500);
  assert.equal(fitLayout(desired, { workspaceHeight: 1000 }).console, 500);
});

test('zero measurements before mount fall back safely and slightly smaller surfaces use 260px preview', async () => {
  const { fitLayout, DEFAULT_LAYOUT } = await moduleReady;
  assert.deepEqual(fitLayout(DEFAULT_LAYOUT, { rootWidth: 0, previewHeight: 0, assistantHeight: 0 }), DEFAULT_LAYOUT);
  const live = fitLayout(DEFAULT_LAYOUT, { rootWidth: 1040, horizontalOverhead: 32, assistantOpen: true });
  assert.equal(live.sidebar, 184);
  assert.equal(live.parameters, 240);
  assert.equal(live.assistant, 300);
  assert.equal(1040 - 32 - 24 - live.sidebar - live.parameters - live.assistant, 260);
});
