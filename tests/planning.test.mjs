import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults, parseLyrics, validatePlan, templatePlan, routeShot, catalog} from '../lib/core.mjs';
import {planningContext, alignSceneDurations, lyricsForInterval} from '../lib/planning.mjs';
import {AIService} from '../lib/ai.mjs';

const project = (duration = 60, overrides = {}) => defaults({audio: {duration, beats: []}, assets: [
  {asset_id: 'a', asset_name: '人物', asset_description: '白衣长发人物站在梨树下', file: 'image.png'},
  {asset_id: 'b', asset_name: '梨树', asset_description: '挂着细雪的古老梨树枝条', file: 'tree.png'},
], ...overrides});
const subtitle = '00:00:26,133 --> 00:00:46,766\n青鲤来时遥闻春溪声声碎，嗅得手植棠梨初发轻黄蕊。\n\n00:00:49,900 --> 00:01:09,400\n旧岁采得枝头细雪，今朝飘落胭脂梨叶。';

test('SRT pasted without sequence numbers preserves real cue starts, ends and instrumental gaps', () => {
  const context = planningContext(project(245.76, {lyrics: subtitle}));
  assert.equal(context.lyricMode, 'srt');
  assert.deepEqual(context.cues.map(c => [c.start, c.end]), [[26.133, 46.766], [49.9, 69.4]]);
  for (const [start, end] of [[0, 26], [47, 49], [70, 80]]) assert.match(lyricsForInterval(context, start, end), /无歌词标注/);
  assert.match(lyricsForInterval(context, 27, 33), /青鲤/);
  assert.equal(context.minShots, 17); assert.equal(context.maxShots, 123);
});
test('numbered multiline SRT and WebVTT cues are parsed without identifiers becoming lyrics', () => {
  const srt = parseLyrics('1\n00:00:01,500 --> 00:00:03,000\n第一行\n第二行\n\n2\n00:00:05,000 --> 00:00:09,000\n第三行', 8);
  assert.deepEqual(srt.lines, [{start: 1.5, end: 3, text: '第一行 第二行'}, {start: 5, end: 8, text: '第三行'}]);
  const vtt = parseLyrics('WEBVTT\n\nverse-1\n00:01.250 --> 00:03.500 align:start\n春溪\n\nverse-2\n00:05.000 --> 00:07.000\n梨花', 8);
  assert.equal(vtt.mode, 'vtt'); assert.deepEqual(vtt.lines.map(c => c.text), ['春溪', '梨花']);
  assert.equal(parseLyrics('00:01.000 --> 00:03.000\n123\n\n00:04.000 --> 00:06.000\n456', 8).lines[0].text, '123');
  assert.equal(parseLyrics('WEBVTT\n\n00:01.000 --> 00:03.000\n春溪\n\nNOTE a comment\nnot lyrics\n\n00:04.000 --> 00:06.000\n梨花', 8).lines[0].text, '春溪');
});
test('malformed, reversed and entirely out-of-range subtitles fail explicitly instead of uniform estimation', () => {
  for (const lyrics of ['00:61:00,000 --> 00:62:00,000\n错误', '00:04.000 --> 00:03.000\n错误', 'bad --> bad\n错误', '00:09.000 --> 00:10.000\n超出', '00:04.000 --> 00:05.000\n甲\n\n00:02.000 --> 00:03.000\n乙']) assert.throws(() => parseLyrics(lyrics, 8), /字幕/);
});
test('LRC duplicate timestamps merge, plain lyrics stay estimated and silence is explicit', () => {
  assert.deepEqual(parseLyrics('[00:02.0]甲\n[00:02.0]乙', 8).lines, [{start: 2, text: '甲 / 乙'}]);
  assert.equal(planningContext(project(8, {lyrics: '甲\n乙'})).lyricMode, 'estimated');
  const c = planningContext(project(8)); assert.equal(c.lyricMode, 'instrumental'); assert.match(lyricsForInterval(c, 0, 8), /无歌词/);
});
test('different feasible scene counts survive without insertion, deletion or fixed slots', () => {
  const c = planningContext(project(60));
  for (const n of [4, 7, 11, 20, 30]) {
    const aligned = alignSceneDurations(Array.from({length: n}, (_, i) => 3 + i % 10), c);
    assert.equal(aligned.length, n); assert.equal(aligned.reduce((a, b) => a + b), 60);
    assert.ok(aligned.every(d => Number.isInteger(d) && d >= 2 && d <= 15));
  }
});
test('fractional suggestions are calibrated with varied lengths and feasible lyric cut preference', () => {
  const c = planningContext(project(20, {lyrics: '[00:00.00]甲\n[00:07.00]乙\n[00:12.00]丙'}));
  assert.deepEqual(alignSceneDurations([6.5, 5.5, 8], c), [7, 5, 8]);
  assert.throws(() => alignSceneDurations([15], c), /可行范围/);
  for (const values of [[0, 10], [NaN, 10], [16, 4], ['8', 12]]) assert.throws(() => alignSceneDurations(values, c), /建议镜长/);
});
test('bounded calibration covers fractional songs up to ten minutes including 2 second upstream limits', () => {
  for (const limit of [2, 5, 15]) for (let d = 1; d <= 600; d += 7.17) {
    const c = planningContext(project(d, {generationDuration: limit}));
    const n = Math.min(c.maxShots, c.minShots + 3);
    const aligned = alignSceneDurations(Array.from({length: n}, (_, i) => Math.min(limit, 2 + i % 7)), c);
    assert.equal(aligned.length, n); const total = aligned.reduce((a, b) => a + b);
    assert.ok(total >= d && total <= d + 2); assert.ok(aligned.every(x => x >= 2 && x <= limit && Number.isInteger(x)));
  }
  const c = planningContext(project(600)); assert.equal(alignSceneDurations(Array(300).fill(2), c).length, 300);
});
test('new plans accept 15 second edits while legacy 2–8 second plans retain their validation', () => {
  const p = project(15), shot = {id: 0, duration: 15, assets: ['a'], lyric_text: '', prompt: p.style + p.assets[0].asset_description};
  const plan = {COT: '剧情', timingVersion: 2, storyboards: [shot]};
  assert.equal(validatePlan(plan, p).storyboards[0].duration, 15);
  assert.throws(() => validatePlan({...plan, timingVersion: undefined}, p), /2–8/);
  assert.throws(() => validatePlan(plan, {...p, generationDuration: 5}), /2–5/);
  assert.throws(() => validatePlan({...plan, timingVersion: 3}, p), /版本/);
  assert.doesNotThrow(() => validatePlan(templatePlan(p), p));
});

function service(output) {
  const ai = new AIService({});
  const calls = [];
  ai.request = async (_, input) => { calls.push(JSON.parse(input.text)); return {result: output, model: 'offline-fixture', usage: {output_tokens: 20}}; };
  return {ai, calls};
}
const scenes = durations => ({COT: '前奏建立梨树空间，随后角色采梨，最后收束。', shots: durations.map((duration, i) => ({id: 99, duration, scene: `镜头${i}，主角在梨树下缓慢移动，镜头侧向跟随动作。`, assets: ['a']}))});
test('planner gives LLM lyrics and duration constraints, not fixed slots; returns contiguous timing', async () => {
  const p = project(69.4, {lyrics: subtitle}), {ai, calls} = service(scenes([12, 14, 7, 8, 6, 3, 11, 9]));
  const plan = await ai.plan(p);
  assert.equal(calls.length, 1); assert.equal(calls[0].slots, undefined); assert.equal(calls[0].upstreamDuration, 15);
  assert.equal(calls[0].cues[0].start, 26.133); assert.equal(plan.timingVersion, 2); assert.equal(plan.storyboards.length, 8);
  let end = 0;
  for (const [i, s] of plan.storyboards.entries()) {
    assert.equal(s.id, i); assert.equal(s.start, end); end += s.duration;
    assert.ok(s.prompt.includes(`镜头${i}`)); assert.ok(s.prompt.includes(p.assets[0].asset_description));
    const route = routeShot(p, s, catalog({VIDU_API_KEY: 'fixture'}));
    assert.equal(route.chosen.generationDuration, 15); assert.equal(route.chosen.trimDuration, s.duration);
  }
  assert.equal(end, 70); assert.match(plan.storyboards[0].lyric_text, /无歌词/);
});
test('planner rejects invalid scenes/assets and impossible counts without extra model requests', async () => {
  for (const bad of [{...scenes([8]), shots: [null]}, scenes([8]), {...scenes([10, 10]), shots: [{duration: 10, scene: '短', assets: ['a']}, scenes([10]).shots[0]]}, {...scenes([10, 10]), shots: scenes([10, 10]).shots.map(s => ({...s, assets: ['missing']}))}]) {
    const {ai, calls} = service(bad); await assert.rejects(ai.plan(project(20))); assert.equal(calls.length, 1);
  }
});
test('strict first-frame planning asks for one image and rejects multiple references', async () => {
  const output = scenes([8]); output.shots[0].assets = ['a', 'b'];
  const {ai, calls} = service(output);
  await assert.rejects(ai.plan(project(8, {generationMode: 'i2v'})), /1–1/);
  assert.equal(calls[0].maxAssetsPerShot, 1);
});
