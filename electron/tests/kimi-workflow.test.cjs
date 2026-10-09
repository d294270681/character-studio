const test = require('node:test');
const assert = require('node:assert/strict');
const { executionStages, executionInstructions, STAGES } = require('../kimi-workflow.cjs');
const { KimiRunner, kimiExecutable } = require('../kimi.cjs');
const { StudioKimiRunner } = require('../studio-kimi.cjs');

test('execution supports exactly the seven requested scopes and copies the input', () => {
  for (const stage of STAGES) assert.deepEqual(executionStages([stage]), [stage]);
  for (const length of [2, 3, 4]) {
    const raw = STAGES.slice(0, length);
    const stages = executionStages(raw);
    assert.deepEqual(stages, raw);
    assert.notEqual(stages, raw);
  }
  for (const raw of [undefined, null, [], 'original', ['export'], ['style', 'video'], ['original', 'video'],
    ['original', 'original'], [...STAGES, 'sprites'], ['style', 'original']]) assert.throws(() => executionStages(raw));
});

test('scope instructions authorize intermediate selection only for a chain', () => {
  const single = executionInstructions(['video'], { id: 'workflow-1' });
  assert.match(single, /3 动作视频/);
  assert.match(single, /studio_set_parameters/);
  assert.match(single, /单步执行/);
  const chain = executionInstructions(STAGES, { id: 'workflow-2' });
  assert.match(chain, /workflow-2/);
  assert.match(chain, /studio_select_asset/);
  assert.match(chain, /最后一步的候选留给用户确认/);
});

test('studio rejects suggestion mode and invalid scopes before touching a service', async () => {
  const runner = new StudioKimiRunner({}, () => {});
  await assert.rejects(runner.start({ prompt: '生成', mode: 'plan', stages: ['original'] }), /只执行生成/);
  await assert.rejects(runner.start({ prompt: '生成', stages: ['style', 'video'] }), /执行范围/);
});

function makeRunner(result) {
  const calls = [], packets = [];
  const runner = new KimiRunner({ root: 'F:/godot', request: async (...args) => { calls.push(args); return { id: 'ours', ...result }; } }, packet => packets.push(packet));
  const run = { cancelled: false, workflow: { id: 'ours' }, child: { kill: () => {} }, client: { dispose: () => {} } };
  runner.run = run; runner.process = run.child; runner.client = run.client;
  return { runner, run, calls, packets };
}

test('assistant chat completion cannot report success when selected stages were not done', async () => {
  const { runner, run, calls, packets } = makeRunner({ status: 'error', message: '风格步骤没有执行。' });
  const done = await runner.finishRun(run, 0, null);
  assert.equal(done.code, 1);
  assert.equal(done.error, '风格步骤没有执行。');
  assert.equal(calls[0][2].workflow_id, 'ours');
  assert.equal(runner.status().running, false);
  assert.equal(packets.filter(packet => packet.type === 'done').length, 1);
  await runner.finishRun(run, 0, null);
  assert.equal(packets.filter(packet => packet.type === 'done').length, 1);
});

test('stop cancels only the owned workflow before ending the assistant and preserves its terminal status', async () => {
  const { runner, run, calls, packets } = makeRunner({ status: 'cancelled' });
  await runner.cancel();
  assert.equal(calls[0][1], '/api/assistant/cancel');
  assert.deepEqual(calls[0][2], { workflow_id: 'ours' });
  const done = await runner.finishRun(run, 1, '进程已退出');
  assert.equal(done.cancelled, true);
  assert.equal(done.error, null);
  assert.equal(done.workflow.status, 'cancelled');
  assert.equal(calls[1][2].status, 'cancelled');
  assert.equal(packets.filter(packet => packet.type === 'done').length, 1);
});

test('a successful run requires the service to confirm workflow completion', async () => {
  const { runner, run } = makeRunner({ status: 'complete' });
  const done = await runner.finishRun(run, 0, null);
  assert.equal(done.code, 0);
  assert.equal(done.error, null);
  assert.equal(done.workflow.status, 'complete');
});

test('stop during completion cannot turn a completed workflow into a cancelled UI result', async () => {
  let release;
  const completing = new Promise(resolve => { release = resolve; });
  const { runner, run, calls } = makeRunner({ status: 'complete' });
  runner.bridge.request = async (...args) => { calls.push(args); return completing; };
  const finishing = runner.finishRun(run, 0, null);
  const stopping = runner.cancel();
  release({ id: 'ours', status: 'complete' });
  assert.equal((await finishing).cancelled, false);
  assert.equal((await stopping).cancelled, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/api/assistant/finish');
});

test('a pending start reserves the runner even before its child exists', async () => {
  const runner = new KimiRunner({ root: 'F:/godot' }, () => {});
  runner.run = { cancelled: false, workflow: null };
  assert.equal(runner.status().running, true);
  await assert.rejects(runner.start({ prompt: '生成', mode: 'execute' }), /上一条任务/);
});

test('stop during workflow acceptance waits for setup and cannot leave a running orphan', { skip: !kimiExecutable(), timeout: 5000 }, async () => {
  let accepted, release;
  const arrived = new Promise(resolve => { accepted = resolve; });
  const acceptance = new Promise(resolve => { release = resolve; });
  const calls = [], packets = [];
  const bridge = { root: 'F:/godot', data: 'unused', ensure: async () => {}, request: async (method, route, body) => {
    calls.push({ route, body });
    if (route === '/api/assistant/start') { accepted(); return acceptance; }
    return { id: 'late-workflow', status: 'cancelled' };
  } };
  const runner = new KimiRunner(bridge, packet => packets.push(packet));
  runner.resolveForRun = () => ({ requested: {}, resolved: {}, thinking: {} });
  const startup = runner.start({ mode: 'execute', stages: ['original'], prompt: '生成角色' });
  await arrived;
  let cancellationSettled = false;
  const stopping = runner.cancel().then(result => { cancellationSettled = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancellationSettled, false, 'Closing must wait for the workflow acceptance transaction');
  release({ id: 'late-workflow', status: 'running' });
  assert.equal((await startup).started, false);
  assert.equal((await stopping).workflow.status, 'cancelled');
  assert.equal(runner.process, null);
  assert.equal(runner.status().running, false);
  assert.ok(calls.some(call => call.route === '/api/assistant/finish' && call.body.status === 'cancelled'));
  assert.equal(packets.filter(packet => packet.type === 'done').length, 1);
  assert.equal(packets.find(packet => packet.type === 'done').cancelled, true);
});

test('a malformed workflow response is rejected before launching an unrestricted assistant', { skip: !kimiExecutable() }, async () => {
  const packets = [];
  const runner = new KimiRunner({ root: 'F:/godot', data: 'unused', ensure: async () => {},
    request: async () => ({ status: 'running' }) }, packet => packets.push(packet));
  runner.resolveForRun = () => ({ requested: {}, resolved: {}, thinking: {} });
  await assert.rejects(runner.start({ mode: 'execute', stages: ['original'], prompt: '生成角色' }), /有效的工作流 ID/);
  assert.equal(runner.process, null);
  assert.equal(runner.status().running, false);
  assert.equal(packets.find(packet => packet.type === 'done').code, 1);
});
