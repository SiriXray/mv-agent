import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {defaults} from '../lib/core.mjs';
import {ProviderError} from '../lib/providers.mjs';
import {createApp} from '../server.mjs';

const env = {ENABLE_LIVE_GENERATION: 'true', VIDU_API_KEY: 'isolated-test-only'};
async function settled(engine) {
  for (let i = 0; i < 600 && engine.active; i++) await sleep(5);
  assert.equal(engine.active, null, 'isolated engine must settle');
}
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-recreate-test-'));
  const store = new Store(root), calls = [], file = `${store.id()}.png`;
  await fs.writeFile(store.mediaPath(file), 'fixture-image');
  const p = {...defaults({resolution: '2K', aspect_ratio: '9:16', audio: {file: `${store.id()}.mp3`, duration: 16}, assets: [{asset_id: 'actor', asset_name: '人物', asset_description: '白衣青年', file, mime: 'image/png'}], routing: {concurrency: 1}}), id: store.id(), revision: 1};
  p.plan = {storyboards: Array.from({length: 4}, (_, id) => ({id, start: id * 4, duration: 4, prompt: `${p.style} 白衣青年`, lyric_text: '', assets: ['actor']}))};
  store.state.projects[p.id] = p;
  const providers = {
    async create(model, input) { calls.push({model, input}); return options.create ? options.create(calls.length) : {id: `new-${calls.length}`}; },
    async poll() { return options.poll ? options.poll() : {state: 'succeeded', url: 'https://example.invalid/test.mp4'}; },
  };
  const media = {
    async downloadVideo() {},
    async normalizeClip(_, output) { await fs.writeFile(output, 'clip'); },
    async assemble(_, __, output) { await fs.writeFile(output, 'final'); return {duration: 16}; },
  };
  const engine = new Engine(store, {env, providers, media, pollMs: 0, pollLimit: 1});
  const job = {id: store.id(), projectId: p.id, execution: 'live', status: 'needs_attention', snapshot: structuredClone(p), routes: engine.routes(p, 'live'), events: [], shots: p.plan.storyboards.map(s => ({id: s.id, state: 'needs_attention', attempts: 1, candidateIndex: 0, model: 'vidu-q4', remoteId: null, output: null, submitted: true, uncertainCreate: true, error: 'old timeout', history: [{model: 'vidu-q4', attempt: 1, state: 'submitting', error: 'old timeout'}]}))};
  Object.assign(job.shots[0], {state: 'succeeded', remoteId: 'keep-id', output: `${store.id()}.mp4`, uncertainCreate: false, error: null, history: [{model: 'vidu-q4', attempt: 1, state: 'succeeded', remoteId: 'keep-id'}]});
  await fs.writeFile(store.mediaPath(job.shots[0].output), 'keep');
  store.state.jobs[job.id] = job; store.save();
  t.after(async () => {
    for (const run of engine.runs.values()) run.controller.abort();
    await settled(engine);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('mv-recreate-test-'));
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, store, p, engine, job, calls};
}
function request(shotIds = [1, 2, 3]) {
  return {confirmPaid: true, acceptDuplicateBilling: true, idempotencyKey: 'explicit-uncertain-once', shotIds, expectedAttempts: Object.fromEntries(shotIds.map(id => [id, 1])), revision: 1, authorizationNote: '用户明确接受可能重复计费，授权重建所选镜头。'};
}

test('explicit recreation preserves unknown history and successful media, then assembles only after all shots succeed', async t => {
  const f = await fixture(t), before = structuredClone(f.job), input = request();
  f.engine.recreateUncertain(f.job, input);
  assert.equal(f.engine.recreateUncertain(f.job, {...input, shotIds: [3, 1, 2]}), f.job);
  await settled(f.engine);
  assert.equal(f.calls.length, 3); assert.equal(f.job.status, 'succeeded');
  assert.deepEqual(f.job.shots[0], before.shots[0]);
  assert.deepEqual(f.job.snapshot, before.snapshot); assert.deepEqual(f.job.routes, before.routes);
  assert.deepEqual(f.job.batchShotIds, [1, 2, 3]);
  for (const id of [1, 2, 3]) {
    assert.equal(f.job.shots[id].attempts, 2);
    assert.deepEqual(f.job.shots[id].history[0], before.shots[id].history[0]);
    assert.equal(f.job.shots[id].history[1].refillKey, input.idempotencyKey);
  }
  assert.ok(f.calls.every(c => c.model === 'vidu-q4' && c.input.duration === 15 && c.input.resolution === '2K'));
  const audit = f.job.refills[0];
  assert.equal(audit.kind, 'uncertain-recreation'); assert.equal(audit.acceptDuplicateBilling, true);
  assert.equal(audit.maxNewCreatesPerShot, 1); assert.equal(audit.authorizationNote, input.authorizationNote);
  assert.deepEqual(audit.unresolvedRequests, [1, 2, 3].map(id => ({shotId: id, outcome: 'unknown', previousState: before.shots[id]})));
  const disk = JSON.parse(await fs.readFile(f.store.file, 'utf8')).jobs[f.job.id];
  assert.deepEqual(disk.refills, f.job.refills);
  const restarted = new Engine(new Store(f.root), {env, providers: {create() { assert.fail('no replay creation'); }}});
  restarted.recreateUncertain(restarted.store.getJob(f.job.id), input);
  assert.equal(restarted.active, null); assert.equal(f.calls.length, 3);
});

test('selective recreation leaves every unselected unknown shot untouched', async t => {
  const f = await fixture(t), before = structuredClone(f.job.shots);
  f.engine.recreateUncertain(f.job, request([1])); await settled(f.engine);
  assert.equal(f.calls.length, 1); assert.equal(f.job.status, 'needs_attention');
  for (const id of [0, 2, 3]) assert.deepEqual(f.job.shots[id], before[id]);
});

test('recreation rejects missing consent, malformed selection and stale attempts without any state or disk mutation', async t => {
  const f = await fixture(t), input = request(), before = structuredClone(f.job), disk = await fs.readFile(f.store.file, 'utf8');
  const invalid = [
    {confirmPaid: false}, {acceptDuplicateBilling: false}, {acceptDuplicateBilling: 'true'},
    {authorizationNote: ''}, {authorizationNote: 'x'.repeat(501)}, {idempotencyKey: ''},
    {shotIds: []}, {shotIds: [1, 1]}, {shotIds: [0, 1]}, {shotIds: [99]}, {shotIds: ['1']},
    {expectedAttempts: {1: 1}}, {expectedAttempts: {1: 1, 2: 1, 3: 2}},
    {expectedAttempts: {1: 1, 2: 1, 3: 1, 4: 1}}, {expectedAttempts: [1, 1, 1]}, {revision: 0},
  ];
  for (const change of invalid) assert.throws(() => f.engine.recreateUncertain(f.job, {...input, ...change}));
  assert.deepEqual(f.job, before); assert.equal(await fs.readFile(f.store.file, 'utf8'), disk); assert.equal(f.calls.length, 0);
});

test('accepted IDs, successful outputs, changed history, old project versions and active jobs cannot be recreated', async t => {
  const f = await fixture(t), input = request([1]), original = structuredClone(f.job.shots[1]);
  for (const change of [{remoteId: 'already-accepted'}, {output: 'already-created.mp4'}, {uncertainCreate: false}, {state: 'succeeded'}, {history: []}, {history: [{state: 'failed'}]}]) {
    Object.assign(f.job.shots[1], structuredClone(original), change);
    const before = structuredClone(f.job); assert.throws(() => f.engine.recreateUncertain(f.job, input)); assert.deepEqual(f.job, before);
  }
  Object.assign(f.job.shots[1], original);
  f.p.revision = 2; assert.throws(() => f.engine.recreateUncertain(f.job, input), /版本/); f.p.revision = 1;
  for (const status of ['running', 'queued', 'assembling', 'succeeded']) { f.job.status = status; assert.throws(() => f.engine.recreateUncertain(f.job, input)); }
  assert.equal(f.calls.length, 0); assert.equal(f.job.refills, undefined);
});

test('ordinary refill cannot bypass unknown-state protection or reuse a recreation key', async t => {
  const f = await fixture(t), input = request([1]);
  assert.throws(() => f.engine.refill(f.job, input), /状态不明/);
  f.engine.recreateUncertain(f.job, input); await settled(f.engine);
  assert.throws(() => f.engine.refill(f.job, input), /幂等键/);
  for (const change of [{authorizationNote: 'different approval'}, {expectedAttempts: {1: 2}}, {shotIds: [2], expectedAttempts: {2: 1}}]) assert.throws(() => f.engine.recreateUncertain(f.job, {...input, ...change}), /幂等键/);
  assert.equal(f.calls.length, 1);
});

test('a new creation timeout stops dispatch, preserves the new uncertainty and cannot reuse the old consent', async t => {
  const f = await fixture(t, {create(n) { if (n === 2) throw new ProviderError('new timeout', {uncertain: true}); return {id: 'accepted-new'}; }});
  const input = request(); f.engine.recreateUncertain(f.job, input); await settled(f.engine);
  assert.equal(f.calls.length, 2); assert.equal(f.job.batchSubmission.status, 'needs_attention');
  assert.equal(f.job.shots[1].state, 'succeeded'); assert.equal(f.job.shots[2].uncertainCreate, true);
  assert.equal(f.job.shots[2].attempts, 2); assert.equal(f.job.shots[3].attempts, 1);
  assert.equal(f.job.shots[3].history.length, 1);
  f.engine.recreateUncertain(f.job, input); assert.equal(f.engine.active, null); assert.equal(f.calls.length, 2);
  assert.throws(() => f.engine.recreateUncertain(f.job, {...request([2]), idempotencyKey: 'stale-consent-new-key'}), /记录已变化/);
});

test('definitive failure after recreation permits a separately authorized refill without losing the unknown-request audit', async t => {
  let ready = false;
  const f = await fixture(t, {poll() { return ready ? {state: 'succeeded', url: 'https://example.invalid/v.mp4'} : {state: 'failed'}; }});
  f.engine.recreateUncertain(f.job, request([1])); await settled(f.engine);
  assert.equal(f.calls.length, 1); assert.equal(f.job.shots[1].state, 'failed');
  const audit = structuredClone(f.job.refills[0]); ready = true;
  f.engine.refill(f.job, {confirmPaid: true, idempotencyKey: 'later-explicit-refill', shotIds: [1]}); await settled(f.engine);
  assert.equal(f.calls.length, 2); assert.equal(f.job.shots[1].attempts, 3); assert.equal(f.job.shots[1].state, 'succeeded');
  assert.deepEqual(f.job.refills[0], audit);
});

test('HTTP recreation is protected by local token, same-origin, double consent and idempotency', async t => {
  const f = await fixture(t);
  const app = createApp({dataDir: f.root, env}); let launches = 0;
  app.engine.launch = () => { launches++; };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const base = `http://127.0.0.1:${app.server.address().port}`, url = `${base}/api/jobs/${f.job.id}/recreate-uncertain`;
  const boot = await (await fetch(base + '/api/bootstrap')).json(), input = request([1]);
  const headers = {'Content-Type': 'application/json', 'X-MV-Token': boot.token, 'Idempotency-Key': input.idempotencyKey};
  const send = (body = input, extra = {}) => fetch(url, {method: 'POST', headers: {...headers, ...extra}, body: JSON.stringify(body)});
  assert.equal((await send(input, {'X-MV-Token': ''})).status, 403);
  assert.equal((await send(input, {Origin: 'https://example.invalid'})).status, 403);
  assert.equal((await send({...input, confirmPaid: false})).status, 403);
  assert.equal((await send({...input, acceptDuplicateBilling: false})).status, 403);
  assert.equal((await send(input, {'Idempotency-Key': ''})).status, 400);
  assert.equal((await send({...input, expectedAttempts: {1: 9}})).status, 409);
  assert.equal(launches, 0);
  const response = await send(); assert.equal(response.status, 202);
  const result = await response.json(); assert.equal(result.shots[1].attempts, 1); assert.equal(result.shots[1].authorizedAttemptLimit, 2);
  assert.equal(result.refills[0].unresolvedRequests[0].outcome, 'unknown');
  assert.equal((await send()).status, 202); assert.equal(launches, 1);
});
