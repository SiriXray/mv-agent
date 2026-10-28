import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest, normalizeResponse, createProviders} from '../lib/providers.mjs';
import {buildProductionRequest, normalizeProduction, productionQuery} from '../lib/production.mjs';
const input={prompt:'人物前行',images:['https://cdn.example.com/a.png'],sounds:[],duration:2,resolution:'720p',aspect_ratio:'16:9'};
test('Q4 uses reference2video with exact documented model, Token auth and silent output',async()=>{
  const r=buildRequest('vidu-q4',input);assert.equal(r.url,'https://api.vidu.cn/ent/v2/reference2video');assert.equal(r.body.model,'viduq4-preview');assert.equal(r.body.duration,3);assert.equal(r.body.audio,false);assert.equal(r.body.watermark,true);
  let seen;const adapter=createProviders({env:{VIDU_API_KEY:'fixture-only'},fetchImpl:async(url,opts)=>{seen={url,opts};return Response.json({task_id:'q4-1'});}});
  assert.equal((await adapter.create('vidu-q4',input)).id,'q4-1');assert.equal(seen.opts.headers.Authorization,'Token fixture-only');
});
test('Wan3 T2V sends prompt without media; cannot degrade I2V into T2V',()=>{
  const r=buildRequest('wan3',{...input,mode:'t2v',images:[]});
  assert.equal(r.body.input.prompt,input.prompt);assert.equal(r.body.input.media,undefined);
  assert.throws(()=>buildRequest('wan3',input),/输入模式/);
  assert.throws(()=>buildRequest('wan3',{...input,mode:'t2v'}),/数量/);
});
test('Wan21 I2V strictly uses one HTTPS first frame, fixed 5s and 720P',()=>{
  const r=buildRequest('wan21-i2v',{...input,mode:'i2v'});
  assert.deepEqual(r.body,{model:'wanx2.1-i2v-plus',input:{prompt:input.prompt,img_url:input.images[0]},parameters:{resolution:'720P',duration:5}});
  assert.throws(()=>buildRequest('wan21-i2v',{...input,mode:'i2v',duration:15}));
  assert.throws(()=>buildRequest('wan21-i2v',{...input,mode:'i2v',images:[]}));
});
test('H3 uses v2 content roles, 2K upstream and minimum 4 seconds',()=>{const r=buildRequest('minimax-h3',{...input,sounds:['https://cdn.example.com/v.mp3']});assert.equal(r.url,'https://api.minimaxi.com/v2/video_generation');assert.equal(r.body.duration,4);assert.equal(r.body.resolution,'2K');assert.equal(r.body.content[1].role,'reference_image');assert.equal(r.body.content[2].role,'reference_audio');});
test('documented result shapes normalize without file_id guesses',()=>{
  assert.equal(normalizeResponse('vidu-q4',{state:'success',creations:[{url:'https://cdn.example.com/q.mp4'}]}).state,'succeeded');
  assert.equal(normalizeResponse('wan3',{output:{task_status:'SUCCEEDED',video_url:'https://cdn.example.com/w.mp4'}}).url,'https://cdn.example.com/w.mp4');
  assert.equal(normalizeResponse('minimax-h3',{task:{status:'succeeded',content:{url:'https://cdn.example.com/h.mp4'}}}).url,'https://cdn.example.com/h.mp4');
  assert.equal(normalizeResponse('minimax-h3',{task:{status:'expired'}}).state,'failed');
});
test('H3 queries documented v2 path',async()=>{let seen;const p=createProviders({env:{MINIMAX_KEY:'fixture'},fetchImpl:async(url)=>{seen=url;return Response.json({task:{status:'processing'}});}});await p.poll('minimax-h3','id/1');assert.equal(seen,'https://api.minimaxi.com/v2/query/video_generation/id%2F1');});
test('application-level errors are rejected without leaking upstream secrets',async()=>{for(const response of [{error:{message:'secret-server-key'}},{base_resp:{status_code:1001,status_msg:'secret-server-key'}}]){const p=createProviders({env:{MINIMAX_KEY:'fixture'},fetchImpl:async()=>Response.json(response)});await assert.rejects(p.create('minimax-h3',input),e=>!e.message.includes('secret-server-key'));}});
test('ambiguous create network failures and 5xx are not safe to retry',async()=>{for(const fetchImpl of [async()=>{throw Error('offline');},async()=>new Response('',{status:503})]){const p=createProviders({env:{VIDU_API_KEY:'fixture'},fetchImpl});await assert.rejects(p.create('vidu-q4',input),e=>e.uncertain===true);}});
test('429 allows bounded retry; missing task id is ambiguous',async()=>{const p=createProviders({env:{VIDU_API_KEY:'fixture'},fetchImpl:async()=>new Response('',{status:429})});await assert.rejects(p.create('vidu-q4',input),e=>e.retryable&&!e.uncertain);const q=createProviders({env:{VIDU_API_KEY:'fixture'},fetchImpl:async()=>Response.json({state:'created'})});await assert.rejects(q.create('vidu-q4',input),e=>e.uncertain);});

test('create upload deadline is separate from read-only polling, with no automatic resubmission',async t=>{
  const deadlines=[];let requests=0;
  t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return new AbortController().signal;});
  const p=createProviders({env:{VIDU_API_KEY:'fixture'},fetchImpl:async()=>{requests++;return Response.json({task_id:'accepted',state:'processing'});}});
  await p.create('vidu-q4',input);await p.poll('vidu-q4','accepted');
  assert.deepEqual(deadlines,[180000,60000]);assert.equal(requests,2);
});
const production={service:'short-play',region:'cn',script_name:'夜航',script_content:'青年沿着灯光走向海边，看见远处的灯塔，最后平静地停下脚步。',quality:'high',resolution:'1080p',aspect_ratio:'16:9',style:'真人写实',duration:2};
const assets=[{asset_name:'青年',asset_description:'白衣青年',width:512,height:512,imageUri:'data:image/png;base64,fixture'}];
test('short drama maps image_uri and quality; never copies misspelled qulity',()=>{const r=buildProductionRequest(production,assets);assert.equal(r.body.assets[0].image_uri,assets[0].imageUri);assert.equal(r.body.quality,'high');assert.equal('qulity' in r.body,false);assert.equal(r.body.duration,2);});
test('international short drama preserves stricter documented duration range',()=>{assert.throws(()=>buildProductionRequest({...production,region:'global'},assets));assert.ok(buildProductionRequest({...production,region:'global',duration:8},assets).url.startsWith('https://api.vidu.com/'));});
test('narration uses POST custom query, not guessed GET',()=>{assert.deepEqual(productionQuery('explain-comic','123'),{url:'https://api.vidu.cn/ent/v1/explain-comic/tasks/custom/123',method:'POST',body:'{"id":"123"}'});});
test('finished-video normalization preserves watermark link and drops unsafe link',()=>{const r=normalizeProduction('short-play',{task:{meta:{state:'success'},derived_data:{signed_final_watermarked_video_url:'https://cdn.example.com/out.mp4',deducted_credits:100}}});assert.equal(r.state,'succeeded');assert.equal(r.credits,100);assert.equal(normalizeProduction('explain-comic',{state:'succeeded',video_url:'javascript:alert(1)'}).video_url,null);});
test('preview uses its own key; incomplete models never fetch; Wan uses alias but not foreign backup',async()=>{
  const seen=[];
  const p=createProviders({env:{VIDU_PREVIEW_API_KEY:'old',VIDU_API_KEY:'new',WAN_API_KEY:'wan',DASHSCOPE_BACKUP_API_KEY:'foreign',SEEDANCE_API_KEY:'proxy'},fetchImpl:async(u,o)=>{seen.push(o.headers);return Response.json(u.includes('dashscope')?{output:{task_id:'id'}}:{task_id:'id'});}});
  await p.create('vidu-q4',input);assert.equal(seen[0].Authorization,'Token old');
  await p.create('wan21-i2v',{...input,mode:'i2v'});assert.equal(seen[1].Authorization,'Bearer wan');assert.equal(seen[1]['X-DashScope-Async'],'enable');
  for(const id of ['vidu-q4-standard','vidu-q31-ad','seedance-mini'])await assert.rejects(p.create(id,input));
  assert.equal(seen.length,2);
  const q=createProviders({env:{DASHSCOPE_BACKUP_API_KEY:'foreign'},fetchImpl:async()=>{throw Error('must not fetch');}});
  await assert.rejects(q.create('wan3',{...input,mode:'t2v',images:[]}));
});
test('Q4 sends 15 seconds and uppercase 2K exactly; Wan cannot silently accept 2K',()=>{
  const request=buildRequest('vidu-q4',{...input,duration:15,resolution:'2K'});
  assert.equal(request.body.duration,15);assert.equal(request.body.resolution,'2K');
  assert.throws(()=>buildRequest('wan3',{...input,images:[],mode:'t2v',duration:15,resolution:'2K'}),/清晰度/);
});
