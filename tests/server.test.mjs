import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

async function setup(t){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mv-agent-http-test-'));
  const app=createApp({dataDir:dir,env:{VIDU_API_KEY:'server-only-sentinel',MINIMAX_KEY:'server-only-sentinel'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));assert.ok(path.basename(dir).startsWith('mv-agent-http-test-'));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const boot=await (await fetch(base+'/api/bootstrap')).json();
  const req=(url,method='GET',data,extra={})=>fetch(base+url,{method,headers:{'X-MV-Token':boot.token,'Content-Type':'application/json',...extra},body:data?JSON.stringify(data):undefined});
  return{app,base,boot,req};
}
test('bootstrap exposes configuration state, not credentials',async t=>{const f=await setup(t);assert.equal(f.boot.models[0].configured,true);assert.equal(f.boot.capabilities.liveEnabled,false);assert.ok(!JSON.stringify(f.boot).includes('server-only-sentinel'));});
test('local state mutations require CSRF token and same origin',async t=>{const f=await setup(t);assert.equal((await fetch(f.base+'/api/projects',{method:'POST',body:'{}'})).status,403);assert.equal((await f.req('/api/projects','POST',{}, {Origin:'https://evil.example'})).status,403);});
test('server never exposes .env, source documents, source notes or arbitrary files',async t=>{const f=await setup(t);for(const file of ['/.env','/source-notes/providers.txt','/lib/providers.mjs','/server.mjs','/media/..%2f..%2f.env'])assert.ok([400,404].includes((await f.req(file)).status));});
test('project fields validate and updates require current revision',async t=>{const f=await setup(t);assert.equal((await f.req('/api/projects','POST',{quality:'bogus'})).status,400);assert.equal((await f.req('/api/projects','POST',{assets:{}})).status,400);const p=await(await f.req('/api/projects','POST',{})).json();assert.equal(p.quality,'standard');assert.equal((await f.req(`/api/projects/${p.id}`,'PATCH',{...p,revision:0})).status,409);const p2=await(await f.req(`/api/projects/${p.id}`,'PATCH',{...p,title:'更新后'})).json();assert.equal(p2.revision,2);assert.equal(p2.title,'更新后');});
test('metric values cannot silently become negative or unknown-as-zero',async t=>{const f=await setup(t);assert.equal((await f.req('/api/metrics','PUT',{wan3:{costPerSecond:-1}})).status,400);const x=await(await f.req('/api/metrics','PUT',{wan3:{costPerSecond:0}})).json();assert.equal(x.models.find(m=>m.id==='wan3').metrics.costPerSecond,0);assert.equal(x.models[0].metrics.costPerSecond,null);});
test('fake media extension is rejected before ffprobe parsing',async t=>{const f=await setup(t);const response=await fetch(f.base+'/api/uploads?kind=audio',{method:'POST',headers:{'X-MV-Token':f.boot.token,'X-File-Name':'unsafe.mp3','Content-Type':'application/octet-stream'},body:'#EXTM3U\nhttp://127.0.0.1/secrets'});assert.equal(response.status,400);assert.equal(Object.keys(f.app.store.state.uploads).length,0);assert.equal((await fs.readdir(f.app.store.media)).length,0);});
test('public service has no demo fixture endpoint or mock execution mode',async t=>{
  const f=await setup(t);assert.deepEqual(f.boot.capabilities.executionModes,['live']);
  assert.equal((await f.req('/api/demo','POST',{})).status,404);
  const p=await(await f.req('/api/projects','POST',{})).json();
  const r=await f.req('/api/jobs','POST',{projectId:p.id,revision:p.revision,execution:'demo',confirmPaid:true},{'Idempotency-Key':'rejected-demo-id'});
  assert.equal(r.status,422);
});
test('browser tab title and cache-busted SVG favicon use the requested music notes',async t=>{
  const f=await setup(t);
  const html=await(await f.req('/')).text();assert.match(html,/<title>🎶 MV Agent · 音乐影像工作台<\/title>/);assert.match(html,/rel="icon"[^>]+href="\/favicon.svg\?v=music-2"/);
  const response=await f.req('/favicon.svg?v=music-2');
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/image\/svg\+xml/);assert.match(await response.text(),/🎶/);
});

test('job concurrency endpoint validates confirmation and bounds without replacing snapshots or starting paused jobs',async t=>{
  const f=await setup(t);f.app.engine.env.ENABLE_LIVE_GENERATION='true';
  const id=f.app.store.id(),job={id,status:'cancelled',execution:'live',snapshot:{routing:{concurrency:2}},shots:[],events:[]};
  f.app.store.state.jobs[id]=job;f.app.store.save();const url=`/api/jobs/${id}/concurrency`;
  assert.equal((await fetch(f.base+url,{method:'POST',body:'{}'})).status,403);
  assert.equal((await f.req(url,'POST',{concurrency:5})).status,403);
  assert.equal((await f.req(url,'POST',{concurrency:6,confirmPaid:true})).status,400);
  const result=await(await f.req(url,'POST',{concurrency:5,confirmPaid:true})).json();
  assert.equal(result.concurrency,5);assert.equal(result.snapshot.routing.concurrency,2);assert.equal(result.status,'cancelled');assert.equal(f.app.engine.active,null);
  assert.equal((await f.req(`/api/jobs/${id}/batch-submit`,'POST',{})).status,403);
  const batch=await(await f.req(`/api/jobs/${id}/batch-submit`,'POST',{confirmPaid:true})).json();assert.equal(batch.submissionMode,'batch');assert.equal(f.app.engine.active,null);
});

test('refill endpoint requires token, paid confirmation and stable idempotency key',async t=>{
  const f=await setup(t);f.app.engine.env.ENABLE_LIVE_GENERATION='true';let launches=0;f.app.engine.launch=()=>{launches++;};
  const id=f.app.store.id(),job={id,projectId:f.app.store.id(),status:'needs_attention',execution:'live',snapshot:{routing:{concurrency:5,maxAttempts:2}},shots:[{id:0,state:'failed',attempts:2,remoteId:null,history:[{remoteId:'old-id',failed:true}]},{id:1,state:'needs_attention',uncertainCreate:true,attempts:1,history:[{state:'submitting'}]}],events:[]};
  f.app.store.state.jobs[id]=job;f.app.store.save();const url=`/api/jobs/${id}/refill`,input={confirmPaid:true,shotIds:[0],allowParallel:true},headers={'Idempotency-Key':'http-refill-once'};
  assert.equal((await fetch(f.base+url,{method:'POST',body:'{}'})).status,403);
  assert.equal((await f.req(url,'POST',{...input,confirmPaid:false},headers)).status,403);
  assert.equal((await f.req(url,'POST',input)).status,400);
  assert.equal((await f.req(url,'POST',{...input,shotIds:[1]},headers)).status,409);
  const first=await f.req(url,'POST',input,headers);assert.equal(first.status,202);
  const result=await first.json();assert.equal(result.shots[0].attempts,2);assert.equal(result.shots[0].authorizedAttemptLimit,3);assert.equal(result.shots[1].uncertainCreate,true);
  assert.equal((await f.req(url,'POST',input,headers)).status,202);assert.equal(launches,1);assert.equal(job.refills.length,1);
});
