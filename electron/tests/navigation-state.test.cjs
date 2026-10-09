const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const moduleReady = fs.readFile(path.join(__dirname, '../src/lib/navigation-state.js'), 'utf8')
  .then(source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));

function fixture() {
  return {
    project: { path: 'F:\\godot\\projects\\a\\project.json',
      assets: { original: [{ id: 'o1' }], style: [{ id: 's1' }], video: [{ id: 'v1' }], sprites: [] },
      selected: { original: 'o1', style: 's1' } },
    assistant: { projectPath: 'F:\\godot\\projects\\a\\project.json', status: 'complete',
      steps: [{ stage: 'original', status: 'complete' }] },
  };
}

test('one-step Kimi history does not hide manually produced results in other stages', async () => {
  const { navigationState } = await moduleReady;
  const input = fixture();
  assert.equal(navigationState('original', input).label, '已选用');
  assert.equal(navigationState('style', input).label, '已选用');
  assert.equal(navigationState('video', input).label, '待选用');
  assert.equal(navigationState('sprites', input).label, '未生成');
});

test('candidate generation or import does not imply user selection', async () => {
  const { navigationState } = await moduleReady;
  const input = fixture();
  delete input.project.selected.style;
  assert.equal(navigationState('style', input).status, 'candidates');
  input.project.selected.style = 's1';
  assert.equal(navigationState('style', input).status, 'selected');
});

test('clearing downstream selections after an upstream change preserves candidates and removes selected badges', async () => {
  const { navigationState } = await moduleReady;
  const input = fixture();
  input.project.selected = { original: 'o1' };
  const before = JSON.stringify(input);
  assert.equal(navigationState('style', input).status, 'candidates');
  assert.equal(navigationState('video', input).status, 'candidates');
  assert.equal(JSON.stringify(input), before);
});

test('manual starting, running and cancelling jobs take priority over previously selected results', async () => {
  const { navigationState } = await moduleReady;
  const input = fixture();
  for (const status of ['starting', 'running', 'cancelling']) {
    input.activeJob = { stage: 'style', status, project_path: input.project.path, message: 'live update' };
    const display = navigationState('style', input);
    assert.equal(display.status, status);
    assert.equal(display.kind, 'busy');
    assert.equal(display.source, 'job');
  }
  input.activeJob = { stage: 'sprites', status: 'running' };
  assert.equal(navigationState('sprites', input).label, '转换中');
});

test('a running Kimi chain shows preparation and waiting before returning to project state', async () => {
  const { navigationState } = await moduleReady;
  const input = fixture();
  input.assistant.status = 'running';
  input.assistant.steps = [{ stage: 'original', status: 'preparing' }, { stage: 'style', status: 'pending' }];
  assert.equal(navigationState('original', input).label, '准备中');
  assert.equal(navigationState('style', input).label, '待执行');
  input.assistant.steps[0].status = 'complete';
  assert.equal(navigationState('original', input).status, 'selected');
  input.assistant.status = 'complete';
  assert.equal(navigationState('style', input).status, 'selected');
});

test('another project cannot contribute live task or workflow badges', async () => {
  const { navigationState } = await moduleReady;
  const input = fixture();
  input.assistant = { status: 'running', projectPath: 'F:/godot/projects/other/project.json', steps: [{ stage: 'style', status: 'pending' }] };
  input.activeJob = { stage: 'style', status: 'running', project_path: 'F:/godot/projects/other/project.json' };
  assert.equal(navigationState('style', input).source, 'project');
  assert.equal(navigationState('style', input).status, 'selected');
  input.activeJob.project_path = 'f:/GODOT/projects/A/project.json';
  assert.equal(navigationState('style', input).status, 'running');
});

test('failure or cancellation without results remains visible, and success without a file is never selected', async () => {
  const { navigationState } = await moduleReady;
  const input = fixture();
  for (const status of ['error', 'cancelled']) {
    input.assistant.steps = [{ stage: 'sprites', status }];
    input.assistant.status = status;
    assert.equal(navigationState('sprites', input).status, status);
  }
  input.assistant.steps[0].status = 'complete';
  input.assistant.status = 'complete';
  assert.equal(navigationState('sprites', input).status, 'empty');
  input.project.selected.sprites = 'missing-file';
  assert.equal(navigationState('sprites', input).status, 'empty');
});

test('missing or malformed project asset lists recover to an empty stage', async () => {
  const { navigationState } = await moduleReady;
  assert.equal(navigationState('original').status, 'empty');
  assert.equal(navigationState('style', { project: { assets: { style: {} } } }).status, 'empty');
});
