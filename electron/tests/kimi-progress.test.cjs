const test = require('node:test');
const assert = require('node:assert/strict');
const { KimiProgress } = require('../kimi-progress.cjs');
const { KimiRunner } = require('../kimi.cjs');
const state = () => ({ assistant: { id: 'ours', status: 'running', current_stage: 'original', stages: ['original'],
  steps: [{ stage: 'original', status: 'preparing', job_ids: [] }] }, settings: { original: { prompt: 'character' } }, jobs: [], active_job: null });

test('model silence becomes a visible wait, then a bounded failure', () => {
  const progress = new KimiProgress(0);
  progress.snapshot(state(), 'ours', 0);
  assert.equal(progress.snapshot(state(), 'ours', 35000).phase, 'waiting');
  assert.match(progress.snapshot(state(), 'ours', 120000).error, /没有返回消息/);
});
test('configuration notifications do not disguise a stalled model', () => {
  const progress = new KimiProgress(0);
  progress.activity({ sessionUpdate: 'config_option_update' }, 119000);
  assert.ok(progress.snapshot(null, null, 120000).error);
});
test('thought streaming is visible without exposing its text', () => {
  const progress = new KimiProgress(0);
  progress.activity({ sessionUpdate: 'agent_thought_chunk', content: { text: 'private reasoning' } }, 110000);
  const status = progress.snapshot(null, null, 111000);
  assert.equal(status.phase, 'thinking');
  assert.equal(status.thought_chunks, 1);
  assert.equal(status.error, null);
  assert.ok(!JSON.stringify(status).includes('private reasoning'));
});
test('continuous thinking past five minutes warns but remains alive', () => {
  const progress = new KimiProgress(0), current = state();
  progress.snapshot(current, 'ours', 0);
  progress.activity({ sessionUpdate: 'agent_thought_chunk' }, 299000);
  const thinking = progress.snapshot(current, 'ours', 300000);
  assert.equal(thinking.error, null);
  assert.equal(thinking.phase, 'thinking');
  assert.match(thinking.warning, /5 分钟.*仍有响应/);
  progress.activity({ sessionUpdate: 'agent_thought_chunk' }, 3599000);
  assert.equal(progress.snapshot(current, 'ours', 3600000).error, null);
  assert.match(progress.snapshot(current, 'ours', 3719000).error, /没有返回消息/);
});
test('actual parameter changes refresh progress, repeated reads do not', () => {
  const progress = new KimiProgress(0), current = state();
  progress.snapshot(current, 'ours', 0);
  current.settings.original.prompt = 'new character';
  progress.activity({ sessionUpdate: 'tool_call' }, 299000);
  assert.equal(progress.snapshot(current, 'ours', 300000).error, null);
  progress.activity({ sessionUpdate: 'tool_call' }, 601000);
  const repeated = progress.snapshot(current, 'ours', 601000);
  assert.equal(repeated.error, null);
  assert.match(repeated.warning, /分钟未变化/);
});
test('a long owned generation is exempt and gets a fresh reply window on completion', () => {
  const progress = new KimiProgress(0), current = state();
  current.active_job = 'job'; current.jobs = [{ id: 'job', workflow_id: 'ours', status: 'running' }];
  const running = progress.snapshot(current, 'ours', 3600000);
  assert.equal(running.error, null);
  assert.equal(running.phase, 'generating');
  current.active_job = null; current.jobs[0].status = 'complete';
  assert.equal(progress.snapshot(current, 'ours', 3601000).error, null);
});
test('an unrelated generation cannot keep our stalled workflow alive', () => {
  const progress = new KimiProgress(0), current = state();
  current.active_job = 'job'; current.jobs = [{ id: 'job', workflow_id: 'other', status: 'running' }];
  assert.ok(progress.snapshot(current, 'ours', 3600000).error);
});

test('preparation, queueing, weight loading, encoding and conversion are distinguished beyond five minutes', () => {
  for (const phase of ['preparing', 'queued', 'loading', 'encoding', 'generating', 'decoding', 'processing', 'cancelling']) {
    const progress = new KimiProgress(0), current = state();
    current.active_job = 'owned';
    current.jobs = [{ id: 'owned', stage: 'original', workflow_id: 'ours', status: 'running',
      execution: { phase, prompt_id: 'our-prompt', node_type: 'UNETLoader', label: '真实节点状态' } }];
    const status = progress.snapshot(current, 'ours', 1800000);
    assert.equal(status.phase, phase);
    assert.equal(status.label, '真实节点状态');
    assert.equal(status.error, null);
    assert.equal(status.warning, null);
    assert.equal(status.prompt_id, 'our-prompt');
    assert.equal(status.job_id, 'owned');
  }
});

test('active workflow jobs do not depend on a transient active_job pointer', () => {
  const progress = new KimiProgress(0), current = state();
  current.jobs = [{ id: 'owned', workflow_id: 'ours', status: 'loading' }];
  assert.equal(progress.snapshot(current, 'ours', 3600000).phase, 'loading');
  assert.equal(progress.snapshot(current, 'ours', 3600000).error, null);
});

test('authoritative execution protects an owned job absent from the recent list', () => {
  const progress = new KimiProgress(0), current = state();
  current.active_job = 'owned';
  current.execution = { job_id: 'owned', workflow_id: 'ours', status: 'running', phase: 'loading', label: '加载 H3 权重…' };
  const status = progress.snapshot(current, 'ours', 3600000);
  assert.equal(status.error, null);
  assert.equal(status.label, '加载 H3 权重…');
  assert.equal(status.phase, 'loading');
});

test('workflow job IDs recover legacy missing ownership but cannot override a foreign owner', () => {
  const progress = new KimiProgress(0), current = state();
  current.assistant.steps[0].job_ids = ['job'];
  current.jobs = [{ id: 'job', status: 'running' }];
  assert.equal(progress.snapshot(current, 'ours', 3600000).error, null);
  current.jobs[0].workflow_id = 'other';
  progress.snapshot(current, 'ours', 3601000);
  assert.ok(progress.snapshot(current, 'ours', 3721000).error);
});

test('missing execution information is rechecked without killing a possible live generator', () => {
  const progress = new KimiProgress(0), current = state();
  current.active_job = 'not-listed-yet';
  const missing = progress.snapshot(current, 'ours', 3600000);
  assert.equal(missing.phase, 'checking_execution');
  assert.equal(missing.error, null);
  assert.equal(progress.snapshot(null, 'ours', 7200000).error, null);
  current.active_job = null;
  current.execution = null;
  assert.equal(progress.snapshot(current, 'ours', 7300000).error, null);
  assert.ok(progress.snapshot(current, 'ours', 7420000).error);
});

test('a long gap between running and completion polls still grants a fresh response window', () => {
  const progress = new KimiProgress(0), current = state();
  current.jobs = [{ id: 'job', workflow_id: 'ours', status: 'running' }];
  progress.snapshot(current, 'ours', 0);
  current.jobs[0].status = 'complete';
  assert.equal(progress.snapshot(current, 'ours', 3600000).error, null);
  assert.ok(progress.snapshot(current, 'ours', 3720000).error);
});
test('watchdog failure ends the actual runner and persists an error on its owned workflow', async () => {
  const calls = [], packets = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const runner = new KimiRunner({ root: 'F:/godot', request: async (method, route, body) => {
    calls.push({ route, body });
    return method === 'GET' ? state() : { ...state().assistant, status: body.status, message: body.message };
  } }, packet => { packets.push(packet); if (packet.type === 'done') resolveDone(packet); });
  let disposed = false;
  const run = { workflow: { id: 'ours' }, progress: new KimiProgress(Date.now() - 130000),
    client: { dispose: () => { disposed = true; } }, child: { kill: () => {} } };
  runner.run = run;
  runner.startProgressMonitor(run);
  const result = await done;
  assert.equal(result.code, 1);
  assert.equal(disposed, true);
  assert.equal(runner.run, null);
  assert.equal(calls.at(-1).route, '/api/assistant/finish');
  assert.equal(calls.at(-1).body.workflow_id, 'ours');
  assert.equal(calls.at(-1).body.status, 'error');
  assert.ok(packets.some(packet => packet.type === 'progress' && packet.error));
});
