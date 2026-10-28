import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {reviseShot} from '../lib/shot-revision.mjs';
import {listJobExports} from '../lib/job-exports.mjs';
import {ProviderError} from '../lib/providers.mjs';
import {createApp} from '../server.mjs';
import {fixture,request,settled,env} from './helpers/shot-fixture.mjs';

test('one paid revision uses edited prompt, keeps every other shot and immutable source, replay never launches',async t=>{
  const f=await fixture();t.after(f.cleanup);const before=structuredClone(f.job),p=structuredClone(f.p),input=request(f);
  const child=reviseShot(f.engine,f.job,input);assert.equal(reviseShot(f.engine,f.job,input),child);await settled(f.engine);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].input.prompt,input.prompt);assert.equal(f.calls[0].input.duration,15);assert.equal(f.calls[0].input.resolution,'2K');assert.equal(f.calls[0].input.aspect_ratio,'9:16');
  assert.equal(child.shots[1].attempts,7);assert.equal(child.shots[1].history.at(-1).prompt,input.prompt);assert.equal(child.shots[1].history[0].remoteId,'old-failed');
  for(const id of [0,2,3])assert.deepEqual(child.shots[id],before.shots[id]);
  assert.deepEqual(f.job,before);assert.deepEqual(f.p,p);assert.equal(child.parentJobId,f.job.id);assert.equal(child.status,'needs_attention');
  assert.equal(await fs.readFile(f.store.mediaPath(f.job.shots[0].output),'utf8'),'old-material');
  assert.equal(reviseShot(f.engine,f.job,input),child);assert.equal(f.engine.active,null);
  assert.throws(()=>reviseShot(f.engine,f.job,{...input,prompt:input.prompt+'changed'}),/幂等键/);
});
test('regenerating a successful shot keeps its old output and never changes its source record',async t=>{
  const f=await fixture();t.after(f.cleanup);const before=structuredClone(f.job),child=reviseShot(f.engine,f.job,request(f,0));await settled(f.engine);
  assert.equal(f.calls.length,1);assert.notEqual(child.shots[0].output,before.shots[0].output);assert.deepEqual(f.job,before);assert.equal(child.shots[0].attempts,2);
});
test('unknown requests require separate consent and a fresh unknown result stays blocked without it',async t=>{
  const f=await fixture({create(){throw new ProviderError('new timeout',{uncertain:true});}});t.after(f.cleanup);const input=request(f,2),before=structuredClone(f.job);
  assert.throws(()=>reviseShot(f.engine,f.job,input),/重复计费/);assert.deepEqual(f.job,before);
  const child=reviseShot(f.engine,f.job,{...input,acceptDuplicateBilling:true});await settled(f.engine);
  assert.equal(f.calls.length,1);assert.equal(child.shots[2].uncertainCreate,true);assert.deepEqual(child.refills[0].previousState,before.shots[2]);
  assert.throws(()=>reviseShot(f.engine,child,{...input,idempotencyKey:'second-request-unknown',expectedAttempts:2,expectedUpdatedAt:child.updatedAt}),/重复计费/);
});
test('validation rejects stale revisions, altered attempts, empty/invalid prompts and missing authorization without writes',async t=>{
  const f=await fixture();t.after(f.cleanup);const input=request(f),before=await fs.readFile(f.store.file,'utf8');
  for(const change of [{confirmPaid:false},{idempotencyKey:''},{shotId:99},{shotId:'1'},{prompt:''},{prompt:'x'.repeat(20001)},{prompt:'missing style and asset'},{projectRevision:2},{expectedUpdatedAt:'stale'},{expectedUpdatedAt:undefined},{expectedAttempts:7},{acceptDuplicateBilling:'yes'}])assert.throws(()=>reviseShot(f.engine,f.job,{...input,...change}));
  assert.equal(await fs.readFile(f.store.file,'utf8'),before);assert.equal(f.calls.length,0);
});
test('accepted unfinished IDs, creation errors, obsolete versions, cancelled jobs and missing material are never recreated',async t=>{
  const f=await fixture();t.after(f.cleanup);const input=request(f),shot=structuredClone(f.job.shots[1]);
  f.job.shots[1].remoteId='already-accepted';assert.throws(()=>reviseShot(f.engine,f.job,input),/受理/);f.job.shots[1]=structuredClone(shot);
  f.job.shots[1].history=[{state:'submitting',error:'429'}];assert.throws(()=>reviseShot(f.engine,f.job,input),/明确失败/);f.job.shots[1]=structuredClone(shot);
  f.job.status='cancelled';assert.throws(()=>reviseShot(f.engine,f.job,input),/作废/);f.job.status='needs_attention';
  const other={...f.job,id:f.store.id()};f.store.state.jobs[other.id]=other;assert.throws(()=>reviseShot(f.engine,f.job,input),/更新的生成版本/);delete f.store.state.jobs[other.id];
  f.job.shots[0].output=f.store.id()+'.mp4';assert.throws(()=>reviseShot(f.engine,f.job,input),/素材不存在/);assert.equal(f.calls.length,0);
});
test('generation failure does not auto retry, a fresh confirmed child adds exactly one attempt',async t=>{
  const f=await fixture({poll(){return{state:'failed'};}});t.after(f.cleanup);const child=reviseShot(f.engine,f.job,request(f));await settled(f.engine);
  assert.equal(f.calls.length,1);assert.equal(child.shots[1].state,'failed');
  const next=reviseShot(f.engine,child,{...request(f),idempotencyKey:'second-explicit-round',expectedAttempts:7,expectedUpdatedAt:child.updatedAt});await settled(f.engine);
  assert.equal(f.calls.length,2);assert.equal(next.shots[1].attempts,8);assert.equal(child.shots[1].attempts,7);
});
test('HTTP feature detection, version history, local token, idempotency and exports use isolated data',async t=>{
  const f=await fixture();t.after(f.cleanup);const app=createApp({dataDir:f.root,env});let launched=0;app.engine.launch=()=>launched++;
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const base=`http://127.0.0.1:${app.server.address().port}`,boot=await(await fetch(base+'/api/bootstrap')).json();assert.equal(boot.capabilities.shotManagement,true);
  const input=request(f),url=base+'/api/jobs/'+f.job.id+'/revise-shot';
  const send=(extra={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-MV-Token':boot.token,'Idempotency-Key':input.idempotencyKey,...extra},body:JSON.stringify(input)});
  assert.equal((await send({'X-MV-Token':''})).status,403);assert.equal((await send({Origin:'https://example.invalid'})).status,403);
  const r=await send();assert.equal(r.status,202);const child=await r.json();assert.equal((await send()).status,202);assert.equal(launched,1);
  const versions=await(await fetch(base+'/api/projects/'+f.p.id+'/jobs')).json();assert.equal(versions.jobs[0].id,child.id);assert.equal(versions.jobs.length,2);
  const j=await(await fetch(base+'/api/jobs/'+f.job.id)).json();assert.deepEqual(j.exports,[]);assert.equal(j.shots[1].attempts,6);
});
test('receipt discovery exposes only existing verified media, never trusts arbitrary receipt paths',async t=>{
  const f=await fixture();t.after(f.cleanup);const dir=path.join(f.store.work,f.job.id,'gap-draft','a'.repeat(64));await fs.mkdir(dir,{recursive:true});
  const receipt={jobId:f.job.id,file:f.job.shots[0].output,path:'C:/arbitrary.mp4',successfulShots:1,totalShots:4,gaps:[{shot:2,start:4,end:8,duration:4,prompt:'not exposed'}],verification:{originalSongMatched:true}};
  const file=path.join(dir,'receipt.json');await fs.writeFile(file,JSON.stringify(receipt));const result=await listJobExports(f.store,f.job);
  assert.equal(result.length,1);assert.equal(result[0].kind,'gap-draft');assert.equal(result[0].gaps[0].prompt,undefined);assert.equal(result[0].video_url,'/media/'+receipt.file);
  for(const change of [{file:'../../escape.mp4'},{jobId:'another-job'},{verification:{}},{file:f.store.id()+'.mp4'}]){await fs.writeFile(file,JSON.stringify({...receipt,...change}));assert.deepEqual(await listJobExports(f.store,f.job),[]);}
});
