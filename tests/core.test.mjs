import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults, allocateDurations, templatePlan, validatePlan, parseLyrics, routeShot, catalog, MODEL_DEFS, priceDisclosure, validPublicUrl} from '../lib/core.mjs';
import {outputSize, privateAddress} from '../lib/media.mjs';
const env = {VIDU_API_KEY:'fixture',DASHSCOPE_API_KEY:'fixture',MINIMAX_KEY:'fixture'};
export function project(overrides = {}) {
  return {...defaults({title: '测试 MV', resolution:'720p', generationDuration:2, audio: {file: 'audio.wav', duration: 8, beats: [1,2,3,4,5,6,7]}, assets: [{asset_id:'01',asset_name:'人物',asset_description:'白色上衣黑色短发青年',file:'image.png',remoteUrl:'https://cdn.example.com/a.png'}], lyrics:'[00:02.00]走向远方\n[00:05.00]看见光', prompt:'主角走向灯光', ...overrides}), id:'project-1',revision:1};
}
test('legacy omitted quality defaults to standard; removed models are not registered', () => {
  assert.equal(defaults().quality,'standard'); assert.deepEqual(MODEL_DEFS.map(m=>m.id),['vidu-q4','wan3','wan21-i2v','minimax-h3','vidu-q4-standard','vidu-q31-ad','seedance-mini']);
  assert.equal(priceDisclosure(project({quality:'high'})).quotedCredits,null);
  assert.throws(()=>defaults({routing:{model:'mix'}}));
});
test('duration allocation satisfies integer and total constraints for 6000 fractional durations', () => {
  for(let d=1;d<=600;d+=.1){const result=allocateDurations(d);const total=result.reduce((a,b)=>a+b,0);assert.ok(result.every(x=>Number.isInteger(x)&&x>=2&&x<=8));assert.ok(total>=d&&total<=d+2);}
});
test('duration allocation rejects invalid or unbounded input',()=>{for(const n of [0,-1,NaN,Infinity,601])assert.throws(()=>allocateDurations(n));});
test('LRC preserves timing and handles multiple timestamps; plain text explicitly estimated',()=>{
  assert.deepEqual(parseLyrics('[00:01.00][00:05.20] hello',10).lines,[{start:1,text:'hello'},{start:5.2,text:'hello'}]);
  assert.equal(parseLyrics('hello\nworld',10).mode,'estimated');assert.equal(parseLyrics('',10).mode,'instrumental');
});
test('planner covers intro and expands asset descriptions with varied shots',()=>{const p=project();const plan=validatePlan(templatePlan(p),p);assert.equal(plan.storyboards[0].start,0);assert.notEqual(plan.storyboards[0].prompt,plan.storyboards[1].prompt);assert.ok(plan.storyboards.every(s=>s.prompt.includes(p.assets[0].asset_description)));});
test('validator rejects fractional duration, invalid IDs, empty assets, missing descriptions and excessive total',()=>{
  const p=project();for(const mutate of [s=>s.duration=2.5,s=>s.id=8,s=>s.assets=[],s=>s.assets=['bad'],s=>s.assets=['01','01'],s=>s.prompt=p.style+' 主角',s=>s.duration=8]){const plan=templatePlan(p);mutate(plan.storyboards[0]);assert.throws(()=>validatePlan(plan,p));}
});
test('standard and high compatibility fields never route to removed MIX',()=>{for(const quality of ['standard','high']){const p=project({quality});const r=routeShot(p,templatePlan(p).storyboards[0],catalog(env),'live');assert.equal(r.chosen.model,'vidu-q4');assert.equal(r.effectiveQuality,'model-selected');}});
test('live catalog rejects unconfigured credentials',()=>{const p=project();assert.equal(routeShot(p,templatePlan(p).storyboards[0],catalog({}),'live').chosen,null);assert.ok(catalog({}).every(m=>!m.configured));});
test('manual mode never replaces an unavailable selected model during preflight',()=>{const p=project({routing:{strategy:'manual',model:'wan3',allowFallback:true}});const r=routeShot(p,{id:0,duration:4,assets:['01']},catalog({VIDU_API_KEY:'fixture'}),'live');assert.equal(r.chosen,null);assert.ok(r.notes.some(x=>x.includes('手动')));});
test('feasible LRC boundaries are preferred without breaking duration constraints',()=>{assert.deepEqual(allocateDurations(8,[],[0,4]),[4,4]);});
test('provider minimum is padded without changing editorial shot duration',()=>{for(const [id,min] of [['vidu-q4',3],['wan3',2],['minimax-h3',4],['wan21-i2v',5]]){const p=project({generationMode:id==='wan3'?'t2v':id==='wan21-i2v'?'i2v':'reference',routing:{strategy:'manual',model:id,allowFallback:false}});const r=routeShot(p,{id:0,duration:2,assets:['01']},catalog(env),'live');assert.equal(r.chosen.generationDuration,min);assert.equal(r.chosen.trimDuration,2);}});
test('capability filter rejects too many reference images before ranking',()=>{const p=project({routing:{model:'minimax-h3',allowFallback:true}});const r=routeShot(p,{id:0,duration:4,assets:Array(10).fill('01')},catalog(env),'live');assert.equal(r.chosen.model,'vidu-q4');});
test('Wan I2V requires public reference URL in live mode',()=>{const p=project({generationMode:'i2v',routing:{model:'wan21-i2v',allowFallback:false}});p.assets[0].remoteUrl='';const r=routeShot(p,{id:0,duration:4,assets:['01']},catalog({DASHSCOPE_API_KEY:'test'}),'live');assert.equal(r.chosen,null);assert.ok(r.rejected.find(x=>x.model==='wan21-i2v').reason.includes('HTTPS'));});
test('no fabricated cost ranking; zero is a valid configured cost',()=>{const p=project({routing:{strategy:'cost'}}),s={id:0,duration:2,assets:['01']};assert.equal(routeShot(p,s,catalog(env),'live').chosen,null);const ms=catalog(env,{'vidu-q4':{costPerSecond:1},'minimax-h3':{costPerSecond:0}});assert.equal(routeShot(p,s,ms,'live').chosen.model,'minimax-h3');});
test('latency order uses explicit metrics and filters missing values',()=>{const p=project({routing:{strategy:'latency',allowFallback:false}});const models=catalog(env,{'vidu-q4':{latencySeconds:100},'minimax-h3':{latencySeconds:30}});const r=routeShot(p,{id:0,duration:4,assets:['01']},models,'live');assert.equal(r.chosen.model,'minimax-h3');assert.equal(r.candidates.length,1);});
test('resolution and aspect ratio are independent of model and quality',()=>{assert.deepEqual(outputSize('720p','16:9'),[1280,720]);assert.deepEqual(outputSize('1080p','9:16'),[1080,1920]);assert.deepEqual(outputSize('720p','1:1'),[720,720]);});
test('private network and unsafe URL guards',()=>{for(const ip of ['127.0.0.1','10.1.2.3','192.168.1.2','172.16.1.1','169.254.169.254','::1','::ffff:127.0.0.1','fd00::1','fe80::1'])assert.ok(privateAddress(ip));assert.equal(privateAddress('8.8.8.8'),false);for(const u of ['http://example.com','https://127.0.0.1/a','https://user:pass@example.com','javascript:alert(1)'])assert.equal(validPublicUrl(u),false);});
test('mode constraints prevent reference fallback into T2V and I2V duration drift',()=>{
  const shot={id:0,duration:6,assets:['01']};
  assert.equal(routeShot(project(),shot,catalog({DASHSCOPE_API_KEY:'fixture'})).chosen,null);
  const p=project({generationMode:'i2v',routing:{model:'wan21-i2v'}});
  assert.equal(routeShot(p,shot,catalog(env)).chosen,null);
  assert.equal(routeShot(p,{...shot,duration:5,assets:['01','01']},catalog(env)).chosen,null);
  assert.equal(routeShot(p,{...shot,duration:5},catalog(env)).chosen.model,'wan21-i2v');
  assert.throws(()=>routeShot(p,shot,catalog(env),'demo'),/演示模式已移除/);
});
test('incomplete models never route even with configured credentials',()=>{
  const models=catalog({VIDU_API_KEY:'fixture',SEEDANCE_API_KEY:'fixture'});
  for(const m of models.filter(x=>!x.implemented)){assert.equal(m.credentialConfigured,true);assert.equal(m.configured,false);}
});
test('latency without measurements reports a strategy issue despite a usable configured model',()=>{
  const p=project({routing:{strategy:'latency'}});
  const r=routeShot(p,{id:0,duration:5,assets:['01']},catalog(env));
  assert.equal(r.chosen,null);assert.match(r.notes.join(''),/首选模型/);
});
test('new project defaults to 15 second tasks and 2K while editing remains song-aligned',()=>{
  const p=project({generationDuration:15,resolution:'2K'});
  assert.equal(defaults().generationDuration,15);assert.equal(defaults().resolution,'2K');
  const shot={id:0,duration:5,assets:['01']};
  const route=routeShot(p,shot,catalog(env));
  assert.equal(route.chosen.generationDuration,15);assert.equal(route.chosen.trimDuration,5);
  assert.deepEqual(route.candidates.map(c=>c.model),['vidu-q4','minimax-h3']);
  assert.deepEqual(outputSize('2K','16:9'),[2560,1440]);assert.deepEqual(outputSize('2K','9:16'),[1440,2560]);assert.deepEqual(outputSize('2K','1:1'),[1440,1440]);
  const wan=routeShot({...p,generationMode:'t2v',routing:{...p.routing,model:'wan3'}},shot,catalog(env));
  assert.equal(wan.chosen,null);assert.match(wan.rejected.find(r=>r.model==='wan3').reason,/清晰度/);
});
