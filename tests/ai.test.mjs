import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createApp} from '../server.mjs';
import {AISettings, buildAIRequest, readAIJson} from '../lib/ai.mjs';
import {run, binaries} from '../lib/media.mjs';
import {templatePlan} from '../lib/core.mjs';

const key = 'fixture-ai-key-never-real';
const env = {PLANNER_URL: 'https://gateway.example.com/v1/responses', PLANNER_MODEL: 'fixture-gpt', PLANNER_PROTOCOL: 'responses', PLANNER_API_KEY: key};
const caption = {asset_name: '测试几何主体', asset_description: '深蓝色背景中，浅紫色方形头部位于青绿色方形身体上方，主体居中，光线均匀。', type: 'character'};
const response = value => Response.json({status: 'completed', output: [{type: 'message', content: [{type: 'output_text', text: JSON.stringify(value)}]}], usage: {input_tokens: 10, output_tokens: 20}});
function planned(body) {
  const input = JSON.parse(body.input[1].content[0].text);
  return {COT: '测试故事从海边出发，最终到达灯塔。', shots: [3, 5].map((duration, i) => ({duration, scene: i ? '近景侧向跟随，主角抬头望见灯塔并缓缓停下脚步。' : '远景从海面推进，主角沿着堤岸朝远处灯塔前行。', assets: [input.assets[0].asset_id]}))};
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mv-ai-test-')), calls = [];
  const app = createApp({dataDir: dir, env: options.env || env, aiOptions: {fetchImpl: async (url, request) => {
    const body = JSON.parse(request.body); calls.push({url, request, body});
    if (options.respond) return options.respond(body, calls.length);
    return body.input?.[1].content.some(c => c.type === 'input_image') ? response(caption) : response(planned(body));
  }}});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`, boot = await (await fetch(base + '/api/bootstrap')).json();
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(dir).startsWith('mv-ai-test-')); await fs.rm(dir, {recursive: true, force: true}); });
  const req = (url, method = 'GET', data) => fetch(base + url, {method, headers: {'X-MV-Token': boot.token, 'Content-Type': 'application/json'}, body: data === undefined ? undefined : JSON.stringify(data)});
  async function project(withDescription = true) {
    const file = `${app.store.id()}.png`;
    await run(binaries().ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x30486c:s=64x96', '-frames:v', '1', app.store.mediaPath(file)]);
    const upload = {file, name: 'reference.png', kind: 'image', mime: 'image/png', width: 64, height: 96, url: `/media/${file}`};
    app.store.state.uploads[file] = upload;
    const audioFile = `${app.store.id()}.wav`;
    app.store.state.uploads[audioFile] = {file: audioFile, name: 'test.wav', kind: 'audio', duration: 8};
    app.store.save();
    return (await req('/api/projects', 'POST', {audio: app.store.state.uploads[audioFile], prompt: '一个沿海岸走向灯塔的故事', assets: [{...upload, asset_id: 'asset-1', asset_name: '测试主体', asset_description: withDescription ? caption.asset_description : '', type: 'character'}]})).json();
  }
  return {app, dir, base, boot, req, calls, project};
}

test('AI settings save is hot, persists without requests and never returns keys', async t => {
  const f = await fixture(t);
  assert.equal(f.boot.capabilities.plannerConfigured, true); assert.equal(f.boot.capabilities.visionConfigured, true);
  assert.ok(!JSON.stringify(f.boot).includes(key));
  const settings = (await f.req('/api/ai/settings')).ok && f.boot.ai;
  const saved = await (await f.req('/api/ai/settings', 'PUT', {...settings, planner: {...settings.planner, model: 'replacement', apiKey: 'new-fixture-key'}})).json();
  assert.equal(saved.planner.model, 'replacement'); assert.equal(f.calls.length, 0); assert.ok(!JSON.stringify(saved).includes('new-fixture-key'));
  assert.equal(new AISettings(f.dir, {}).get('planner').apiKey, 'new-fixture-key');
  const boot = await (await f.req('/api/bootstrap')).json(); assert.equal(boot.ai.planner.model, 'replacement');
  for (const url of ['/data/ai-settings.json', '/.env', '/lib/ai.mjs']) assert.equal((await f.req(url)).status, 404);
  assert.equal((await fetch(f.base + '/api/ai/settings', {method: 'PUT', body: '{}'})).status, 403);
});
test('switching to DeepSeek clears the planner credential and preserves separate GPT vision', async t => {
  const f = await fixture(t), old = f.boot.ai;
  const saved = await (await f.req('/api/ai/settings', 'PUT', {revision: old.revision, planner: {url: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat', protocol: 'chat'}, vision: {...old.vision, sameAsPlanner: false}})).json();
  assert.equal(saved.planner.keyConfigured, false); assert.equal(saved.vision.configured, true);
  assert.equal(f.app.aiSettings.get('vision').apiKey, key); assert.equal(f.app.aiSettings.get('planner').apiKey, '');
  assert.equal(f.calls.length, 0);
});
test('AI configuration rejects unsafe URLs, stale edits and invalid protocol without changes', async t => {
  const f = await fixture(t), previous = f.boot.ai;
  for (const url of ['http://example.com/v1/responses', 'https://127.0.0.1/api', 'https://user:pass@example.com/v1', 'https://api.example.com/v1?key=secret']) {
    assert.equal((await f.req('/api/ai/settings', 'PUT', {...previous, planner: {...previous.planner, url}})).status, 400);
  }
  assert.equal((await f.req('/api/ai/settings', 'PUT', {...previous, revision: -1})).status, 409);
  assert.equal(f.app.aiSettings.status().revision, previous.revision); assert.equal(f.calls.length, 0);
});
test('Responses and Chat image payloads and JSON outputs follow separate protocols', () => {
  const input = {system: 'Return JSON', text: 'Describe', images: ['data:image/png;base64,fixture']};
  const config = {url: env.PLANNER_URL, model: env.PLANNER_MODEL, apiKey: key, protocol: 'responses'};
  const a = buildAIRequest(config, input), b = buildAIRequest({...config, protocol: 'chat'}, input);
  assert.equal(a.input[1].content[1].type, 'input_image'); assert.equal(a.store, false); assert.equal(a.text.format.type, 'json_object');
  assert.equal(b.messages[1].content[1].image_url.url, input.images[0]); assert.equal(b.response_format.type, 'json_object'); assert.equal(b.max_tokens, 16000);
  assert.deepEqual(readAIJson({choices: [{message: {content: '{"ok":true}'}}]}, 'chat').result, {ok: true});
  assert.throws(() => readAIJson({status: 'incomplete'}, 'responses'), /截断/);
  assert.throws(() => readAIJson({choices: [{finish_reason: 'length'}]}, 'chat'), /截断/);
});
test('image description requires confirmation, fills visual metadata and caches completed recognition', async t => {
  const f = await fixture(t), p = await f.project(false), url = `/api/projects/${p.id}/describe`;
  assert.equal((await f.req(url, 'POST', {revision: p.revision, assetIds: ['asset-1']})).status, 403); assert.equal(f.calls.length, 0);
  const a = await (await f.req(url, 'POST', {revision: p.revision, assetIds: ['asset-1'], confirmPaid: true})).json();
  assert.equal(a.completed, 1); assert.equal(a.project.assets[0].asset_description, caption.asset_description); assert.equal(a.project.assets[0].descriptionSource, 'ai');
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].body.input[1].content[1].image_url.startsWith('data:image/png;base64,'));
  assert.equal(f.calls[0].request.redirect, 'error');
  await f.app.ai.describe(f.app.store, a.project.assets[0], {confirmPaid: true}); assert.equal(f.calls.length, 1);
  const saved = await (await f.req(`/api/projects/${p.id}`, 'PATCH', a.project)).json(); assert.equal(saved.assets[0].descriptionSource, 'ai');
  const unchanged = await (await f.req(url, 'POST', {revision: saved.revision, assetIds: ['asset-1'], confirmPaid: true})).json();
  assert.equal(unchanged.completed, 0); assert.equal(f.calls.length, 1);
});
test('failed recognition keeps uploads and does not retry or fabricate a description', async t => {
  const f = await fixture(t, {respond: async () => new Response('secret-from-upstream', {status: 401})}), p = await f.project(false);
  const result = await (await f.req(`/api/projects/${p.id}/describe`, 'POST', {revision: p.revision, assetIds: ['asset-1'], confirmPaid: true})).json();
  assert.equal(result.errors.length, 1); assert.equal(result.completed, 0); assert.equal(result.project.assets[0].asset_description, ''); assert.equal(result.project.revision, p.revision);
  assert.equal(f.calls.length, 1); assert.ok(!JSON.stringify(result).includes('secret-from-upstream')); assert.ok(await fs.stat(f.app.store.mediaPath(p.assets[0].file)));
});
test('LLM planning chooses variable scene lengths with expanded references', async t => {
  const f = await fixture(t), p = await f.project(); assert.equal(p.planner, 'llm');
  assert.equal((await f.req(`/api/projects/${p.id}/plan`, 'POST', {revision: p.revision})).status, 403); assert.equal(f.calls.length, 0);
  const plannedProject = await (await f.req(`/api/projects/${p.id}/plan`, 'POST', {revision: p.revision, confirmPaid: true})).json();
  assert.equal(plannedProject.plan.planner, 'llm'); assert.equal(plannedProject.plan.model, env.PLANNER_MODEL);
  assert.equal(plannedProject.plan.storyboards.reduce((sum, s) => sum + s.duration, 0), 8);
  assert.ok(plannedProject.plan.storyboards[0].prompt.includes(caption.asset_description));
  assert.ok(plannedProject.plan.storyboards[0].prompt.includes('海面推进')); assert.notEqual(plannedProject.plan.storyboards[0].prompt, plannedProject.plan.storyboards[1].prompt);
});
test('invalid LLM results preserve the old plan with no local-template fallback', async t => {
  const f = await fixture(t, {respond: async () => response({COT: 'bad', shots: []})}), p = await f.project();
  const previous = templatePlan(p); f.app.store.state.projects[p.id].plan = previous; f.app.store.save();
  assert.equal((await f.req(`/api/projects/${p.id}/plan`, 'POST', {revision: p.revision, confirmPaid: true})).status, 502);
  const current = await (await f.req(`/api/projects/${p.id}`)).json(); assert.deepEqual(current.plan, previous); assert.equal(current.revision, p.revision); assert.equal(f.calls.length, 1);
});
test('concurrent duplicate planning requests share one upstream call', async t => {
  const f = await fixture(t, {respond: async body => { await sleep(60); return response(planned(body)); }}), p = await f.project();
  const requests = await Promise.all([1, 2].map(() => f.req(`/api/projects/${p.id}/plan`, 'POST', {revision: p.revision, confirmPaid: true})));
  assert.ok(requests.every(r => r.status === 200)); assert.equal(f.calls.length, 1); assert.equal(f.app.store.state.projects[p.id].revision, p.revision + 1);
});
test('editing a project during LLM planning prevents stale result overwrite', async t => {
  const f = await fixture(t, {respond: async body => { await sleep(100); return response(planned(body)); }}), p = await f.project();
  const pending = f.req(`/api/projects/${p.id}/plan`, 'POST', {revision: p.revision, confirmPaid: true});
  while (!f.calls.length) await sleep(5);
  const saved = await (await f.req(`/api/projects/${p.id}`, 'PATCH', {...p, title: 'updated during planning'})).json();
  assert.equal((await pending).status, 409); assert.equal(f.app.store.state.projects[p.id].title, saved.title); assert.equal(f.app.store.state.projects[p.id].plan, null);
});
test('concurrent image recognition shares one request and a completed caption', async t => {
  const f = await fixture(t, {respond: async () => { await sleep(40); return response(caption); }}), p = await f.project(false);
  const results = await Promise.all([1, 2].map(() => f.app.ai.describe(f.app.store, p.assets[0], {confirmPaid: true})));
  assert.equal(f.calls.length, 1); assert.deepEqual(results[0], results[1]);
});
test('a batch stops on the first image failure, preserving completed and unprocessed assets', async t => {
  const f = await fixture(t, {respond: async (_, count) => count === 1 ? response(caption) : new Response('', {status: 429})}), p = await f.project(false);
  const stored = f.app.store.state.projects[p.id];
  for (let i = 2; i <= 3; i++) {
    const file = `${f.app.store.id()}.png`;
    await fs.copyFile(f.app.store.mediaPath(p.assets[0].file), f.app.store.mediaPath(file));
    f.app.store.state.uploads[file] = {...f.app.store.state.uploads[p.assets[0].file], file, url: `/media/${file}`};
    stored.assets.push({...p.assets[0], file, asset_id: `asset-${i}`});
  }
  f.app.store.save();
  const result = await (await f.req(`/api/projects/${p.id}/describe`, 'POST', {revision: p.revision, assetIds: ['asset-1', 'asset-2', 'asset-3'], confirmPaid: true})).json();
  assert.equal(result.completed, 1); assert.equal(result.errors.length, 1); assert.equal(f.calls.length, 2);
  assert.equal(result.project.assets[0].asset_description, caption.asset_description);
  assert.equal(result.project.assets[1].asset_description, ''); assert.equal(result.project.assets[2].asset_description, '');
});
test('switching a legacy template project to LLM keeps its previous plan until replacement', async t => {
  const f = await fixture(t), p = await f.project(), previous = templatePlan(p);
  f.app.store.state.projects[p.id].planner = 'template'; f.app.store.state.projects[p.id].plan = previous; f.app.store.save();
  const result = await (await f.req(`/api/projects/${p.id}`, 'PATCH', {...p, planner: 'llm'})).json();
  assert.equal(result.planner, 'llm'); assert.deepEqual(result.plan, previous); assert.equal(f.calls.length, 0);
});

test('invalid durations, unknown images and truncated output preserve the old plan and revision', async t => {
  for (const kind of ['duration', 'asset', 'truncated']) {
    const f = await fixture(t, {respond: async body => {
      const value = planned(body);
      if (kind === 'duration') value.shots[0].duration = 20;
      if (kind === 'asset') value.shots[0].assets = ['missing'];
      return kind === 'truncated' ? Response.json({status: 'incomplete'}) : response(value);
    }}), p = await f.project();
    const previous = templatePlan(p); f.app.store.state.projects[p.id].plan = previous; f.app.store.save();
    assert.equal((await f.req(`/api/projects/${p.id}/plan`, 'POST', {revision: p.revision, confirmPaid: true})).status, 502);
    const current = await (await f.req(`/api/projects/${p.id}`)).json();
    assert.deepEqual(current.plan, previous); assert.equal(current.revision, p.revision); assert.equal(f.calls.length, 1);
  }
});
test('invalid subtitle timestamps are rejected before any paid LLM request', async t => {
  const f = await fixture(t), p = await f.project();
  f.app.store.state.projects[p.id].lyrics = '00:06.000 --> 00:02.000\n倒序'; f.app.store.save();
  const result = await f.req(`/api/projects/${p.id}/plan`, 'POST', {revision: p.revision, confirmPaid: true});
  assert.equal(result.status, 400); assert.match((await result.json()).error, /字幕时间/); assert.equal(f.calls.length, 0);
});
