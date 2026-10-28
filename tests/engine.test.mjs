import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {Store} from '../lib/store.mjs';
import {Engine} from '../lib/engine.mjs';
import {defaults, templatePlan} from '../lib/core.mjs';
import {ProviderError} from '../lib/providers.mjs';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'mv-agent-test-'));
  t.after(async()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(root).startsWith('mv-agent-test-'));await fs.rm(root,{recursive:true,force:true});});
  const store = new Store(root), file=`${store.id()}.png`;
  await fs.writeFile(store.mediaPath(file),'fixture-image');
  const p={...defaults({audio:{file:`${store.id()}.wav`,duration:options.duration??4},assets:[{asset_id:'01',asset_name:'人',asset_description:'短发青年白色上衣',file,mime:'image/png',remoteUrl:'https://cdn.example.com/a.png'}],routing:{concurrency:1,...options.routing}}),id:store.id(),revision:1};
  p.plan=templatePlan(p);store.state.projects[p.id]=p;store.save();
  const calls=[];
  const providers=options.providers||{async create(model){calls.push(model);return{id:'remote-1'};},async poll(){return{state:'succeeded',url:'https://cdn.example.com/v.mp4'};}};
  const media={async demoClip(output){await fs.writeFile(output,'demo');},async downloadVideo(){},async normalizeClip(_,output){await fs.writeFile(output,'clip');},async assemble(_,__,output){await fs.writeFile(output,'final');return{duration:4,width:1280,height:720,fps:30};},...options.media};
  const engine=new Engine(store,{env:{ENABLE_LIVE_GENERATION:'true',VIDU_API_KEY:'fixture',DASHSCOPE_API_KEY:'fixture',MINIMAX_KEY:'fixture'},providers,media,pollMs:options.pollMs??10,pollLimit:options.pollLimit??2,pollErrorLimit:options.pollErrorLimit??12});
  return{store,p,engine,calls,providers,root};
}
async function settled(engine){for(let i=0;i<600&&engine.active;i++)await sleep(10);assert.equal(engine.active,null,'engine did not settle');}
const args={execution:'live',confirmPaid:true,revision:1,idempotencyKey:'test-idempotency-key'};
test('live start requires explicit paid confirmation',async t=>{const f=await fixture(t);assert.throws(()=>f.engine.start(f.p,{...args,confirmPaid:false}),/确认/);assert.equal(f.calls.length,0);});
test('duplicate idempotency key does not create a second upstream task',async t=>{const f=await fixture(t);const a=f.engine.start(f.p,args),b=f.engine.start(f.p,args);assert.equal(a.id,b.id);await settled(f.engine);assert.equal(f.calls.length,1);assert.equal(a.status,'succeeded');});
test('uncertain creation is held and never silently retried or failed over',async t=>{let count=0;const f=await fixture(t,{providers:{async create(){count++;throw new ProviderError('ambiguous',{uncertain:true});}}});const j=f.engine.start(f.p,args);await settled(f.engine);assert.equal(count,1);assert.equal(j.status,'needs_attention');assert.throws(()=>f.engine.resume(j,true),/核对/);});
test('poll timeout preserves remote task and resume only queries it',async t=>{let creates=0,ready=false;const f=await fixture(t,{pollLimit:1,providers:{async create(){creates++;return{id:'keep-id'};},async poll(){return ready?{state:'succeeded',url:'https://cdn.example.com/v.mp4'}:{state:'running'};}}});const j=f.engine.start(f.p,args);await settled(f.engine);assert.equal(j.status,'needs_attention');assert.equal(j.shots[0].remoteId,'keep-id');ready=true;f.engine.resume(j,true);await settled(f.engine);assert.equal(creates,1);assert.equal(j.status,'succeeded');});
test('definitive provider failure follows the explicit fallback order',async t=>{const calls=[];const f=await fixture(t,{routing:{maxAttempts:1},providers:{async create(model){calls.push(model);return{id:model};},async poll(model){return model==='vidu-q4'?{state:'failed'}:{state:'succeeded',url:'https://cdn.example.com/v.mp4'};}}});const j=f.engine.start(f.p,args);await settled(f.engine);assert.deepEqual(calls,['vidu-q4','minimax-h3']);assert.equal(j.status,'succeeded');assert.equal(j.shots[0].model,'minimax-h3');assert.ok(j.events.some(e=>e.message.includes('故障切换')));});
test('cancel preserves submitted IDs; resume does not resubmit them',async t=>{let creates=0,ready=false;const f=await fixture(t,{pollLimit:100,providers:{async create(){creates++;return{id:'pending-id'};},async poll(){return ready?{state:'succeeded',url:'https://cdn.example.com/v.mp4'}:{state:'running'};}}});const j=f.engine.start(f.p,args);for(let i=0;i<100&&!j.shots[0].remoteId;i++)await sleep(5);f.engine.cancel(j);await settled(f.engine);assert.equal(j.status,'cancelled');assert.equal(j.shots[0].remoteId,'pending-id');ready=true;f.engine.resume(j,true);await settled(f.engine);assert.equal(creates,1);});
test('restart does not dispatch paid requests automatically',async t=>{const f=await fixture(t);f.store.state.jobs['interrupted']={id:'interrupted',status:'running',shots:[{remoteId:'existing'}]};f.store.save();const restarted=new Store(f.root);assert.equal(restarted.state.jobs.interrupted.status,'needs_attention');assert.equal(restarted.state.jobs.interrupted.shots[0].remoteId,'existing');});
test('project revision mismatch rejects stale generation',async t=>{const f=await fixture(t);assert.throws(()=>f.engine.start(f.p,{...args,revision:0}),/更新/);});
test('production engine rejects demo and mock modes without creating tasks',async t=>{
  const f=await fixture(t);
  for(const execution of ['demo','mock'])assert.throws(()=>f.engine.start(f.p,{...args,execution}),/演示模式已移除/);
  assert.equal(f.calls.length,0);assert.equal(Object.keys(f.store.state.jobs).length,0);
});
test('rejected first shot stops the remaining queue',async t=>{
  let creates=0;
  const f=await fixture(t,{routing:{allowFallback:false,maxAttempts:1},providers:{async create(){creates++;throw new ProviderError('HTTP 401');}}});
  f.p.audio.duration=12;f.p.plan=templatePlan(f.p);
  const j=f.engine.start(f.p,args);await settled(f.engine);
  assert.equal(creates,1);assert.equal(j.shots[0].state,'failed');assert.ok(j.shots.slice(1).every(s=>s.state==='pending'));
});
test('T2V does not read or send uploaded image files',async t=>{
  const f=await fixture(t);
  f.p.generationMode='t2v';f.p.assets[0].file='missing.png';
  const input=await f.engine.inputs({snapshot:f.p},f.p.plan.storyboards[0],'wan3');
  assert.deepEqual(input.images,[]);assert.equal(input.mode,'t2v');
});

async function until(predicate) { for (let i=0;i<400&&!predicate();i++) await sleep(5); assert.ok(predicate(), 'condition did not become true'); }
test('live concurrency grows from two to five without changing snapshots or recreating accepted shots',async t=>{
  const submitted=[],finished=new Set();let ready=false;
  const f=await fixture(t,{duration:40,routing:{concurrency:2},pollLimit:Infinity,providers:{
    async create(){const id='remote-'+submitted.length;submitted.push(id);return{id};},
    async poll(_,id){if(!ready)return{state:'running'};finished.add(id);return{state:'succeeded',url:'https://cdn.example.com/v.mp4'};}
  }});
  const j=f.engine.start(f.p,args);await until(()=>submitted.length===2&&j.shots.slice(0,2).every(s=>s.remoteId));
  const snapshot=JSON.stringify(j.snapshot),routes=JSON.stringify(j.routes),ids=j.shots.slice(0,2).map(s=>s.remoteId);
  for(const value of [0,6,2.5,'5'])assert.throws(()=>f.engine.setConcurrency(j,value,true),/1–5/);
  assert.throws(()=>f.engine.setConcurrency(j,5,false),/确认/);
  f.engine.setConcurrency(j,5,true);await until(()=>submitted.length===5&&j.shots.slice(0,5).every(s=>s.remoteId));
  f.engine.setConcurrency(j,5,true);await sleep(30);assert.equal(submitted.length,5);
  assert.deepEqual(j.shots.slice(0,2).map(s=>s.remoteId),ids);assert.equal(JSON.stringify(j.snapshot),snapshot);assert.equal(JSON.stringify(j.routes),routes);
  f.engine.setConcurrency(j,1,true);assert.equal(submitted.length,5);assert.equal(j.shots.filter(s=>s.state==='running').length,5);
  ready=true;await settled(f.engine);assert.equal(j.status,'succeeded');assert.equal(submitted.length,j.shots.length);assert.equal(finished.size,j.shots.length);
  assert.ok(j.shots.every(s=>s.attempts===1&&s.history.length===1));assert.equal(JSON.parse(await fs.readFile(f.store.file,'utf8')).jobs[j.id].concurrency,1);
});
test('paused job can resume at five preserving accepted IDs, attempts and completed clips',async t=>{
  let creates=0,ready=false;
  const f=await fixture(t,{duration:30,routing:{concurrency:2},pollLimit:Infinity,providers:{async create(){return{id:'retained-'+(++creates)};},async poll(_,id){return ready||id==='retained-1'?{state:'succeeded',url:'https://cdn.example.com/v.mp4'}:{state:'running'};}}});
  const j=f.engine.start(f.p,args);await until(()=>j.shots.some(s=>s.state==='succeeded')&&j.shots.filter(s=>s.remoteId).length===3);
  f.engine.cancel(j);await settled(f.engine);
  const old=j.shots.filter(s=>s.remoteId).map(s=>({id:s.id,remoteId:s.remoteId,attempts:s.attempts,output:s.output}));
  const count=creates;f.engine.setConcurrency(j,5,true);await sleep(20);assert.equal(creates,count);assert.equal(j.status,'cancelled');
  ready=true;f.engine.resume(j,true);await settled(f.engine);
  for(const s of old){assert.equal(j.shots[s.id].remoteId,s.remoteId);assert.equal(j.shots[s.id].attempts,s.attempts);if(s.output)assert.equal(j.shots[s.id].output,s.output);}
  assert.equal(creates,j.shots.length);assert.equal(j.status,'succeeded');
});
test('five upstream tasks use at most two simultaneous local download/transcode slots',async t=>{
  let creates=0,local=0,peak=0;
  const f=await fixture(t,{duration:30,routing:{concurrency:5},providers:{async create(){return{id:'remote-'+(++creates)};},async poll(){return{state:'succeeded',url:'https://cdn.example.com/v.mp4'};}},media:{
    async downloadVideo(){local++;peak=Math.max(peak,local);await sleep(15);},
    async normalizeClip(_,output){await sleep(15);await fs.writeFile(output,'clip');local--;}
  }});
  const j=f.engine.start(f.p,args);await settled(f.engine);assert.equal(peak,2);assert.equal(local,0);assert.equal(creates,j.shots.length);assert.equal(j.status,'succeeded');
});
test('healthy long-running tasks may pass the former 360 polls without being recreated',async t=>{
  let creates=0,polls=0;
  const f=await fixture(t,{pollLimit:Infinity,pollMs:0,providers:{async create(){creates++;return{id:'long-running'};},async poll(){return ++polls<365?{state:'running'}:{state:'succeeded',url:'https://cdn.example.com/v.mp4'};}}});
  const j=f.engine.start(f.p,args);await settled(f.engine);assert.equal(j.status,'succeeded');assert.equal(polls,365);assert.equal(creates,1);
  assert.equal(new Engine(f.store).pollLimit,Infinity);
});
test('persistent query errors and unknown status hold IDs without creating another paid task',async t=>{
  for(const unknown of [false,true]){
    let creates=0,polls=0;
    const f=await fixture(t,{pollLimit:Infinity,pollErrorLimit:3,providers:{async create(){creates++;return{id:'keep-this'};},async poll(){polls++;if(unknown)return{state:'unknown'};throw new ProviderError('query 429',{retryable:true});}}});
    const j=f.engine.start(f.p,args);await settled(f.engine);assert.equal(j.status,'needs_attention');assert.equal(j.shots[0].remoteId,'keep-this');assert.equal(creates,1);assert.equal(polls,unknown?1:3);
  }
});
test('uncertain create prevents live concurrency expansion',async t=>{
  let finish;
  const f=await fixture(t,{providers:{async create(){return new Promise(r=>{finish=r;});},async poll(){return{state:'succeeded',url:'https://cdn.example.com/v.mp4'};}}});
  const j=f.engine.start(f.p,args);await until(()=>!!finish);assert.throws(()=>f.engine.setConcurrency(j,5,true),/状态不明/);finish({id:'accepted'});await settled(f.engine);
  assert.throws(()=>f.engine.setConcurrency(j,5,true),/状态/);
});

test('batch submits all remaining shots with five concurrent POSTs before generation finishes; keeps previous IDs',async t=>{
  let creates=0,posting=0,peak=0,ready=false;
  const f=await fixture(t,{duration:60,routing:{concurrency:2},pollLimit:Infinity,providers:{
    async create(){const id='batch-'+(++creates);posting++;peak=Math.max(peak,posting);await sleep(20);posting--;return{id};},
    async poll(){return ready?{state:'succeeded',url:'https://cdn.example.com/v.mp4'}:{state:'running'};}
  }});
  const j=f.engine.start(f.p,args);await until(()=>j.shots.filter(s=>s.remoteId).length===2);
  f.engine.cancel(j);await settled(f.engine);const previous=j.shots.slice(0,2).map(s=>s.remoteId),snapshot=JSON.stringify(j.snapshot);
  f.engine.setConcurrency(j,5,true);f.engine.prepareBatch(j,true);assert.equal(creates,2);
  f.engine.resume(j,true);await until(()=>j.batchSubmission?.status==='submitted');
  assert.equal(creates,j.shots.length);assert.ok(j.shots.length>5);assert.ok(peak<=5);assert.equal(peak,5);
  assert.equal(j.shots.filter(s=>s.remoteId).length,j.shots.length);assert.equal(j.shots.filter(s=>s.state==='succeeded').length,0);
  assert.deepEqual(j.shots.slice(0,2).map(s=>s.remoteId),previous);assert.equal(JSON.stringify(j.snapshot),snapshot);
  ready=true;await settled(f.engine);assert.equal(j.status,'succeeded');assert.ok(j.shots.every(s=>s.attempts===1&&s.history.length===1));
});
test('batch submission stops on 429 or ambiguous creation, collecting accepted results without retrying',async t=>{
  for(const uncertain of [false,true]){
    let creates=0,fail=false;
    const f=await fixture(t,{duration:60,routing:{concurrency:1},pollLimit:Infinity,providers:{
      async create(){const n=++creates;if(fail&&n===2)throw new ProviderError(uncertain?'ambiguous':'HTTP 429',{retryable:!uncertain,uncertain});return{id:'once-'+n};},
      async poll(){return fail?{state:'succeeded',url:'https://cdn.example.com/v.mp4'}:{state:'running'};}
    }});
    const j=f.engine.start(f.p,args);await until(()=>!!j.shots[0].remoteId);f.engine.cancel(j);await settled(f.engine);
    f.engine.prepareBatch(j,true);f.engine.setConcurrency(j,5,true);fail=true;f.engine.resume(j,true);await settled(f.engine);
    assert.equal(j.status,'needs_attention');assert.equal(j.batchSubmission.status,'needs_attention');assert.ok(creates<j.shots.length);
    assert.ok(j.shots.every(s=>s.attempts<=1));assert.equal(j.shots[0].state,'succeeded');assert.equal(!!j.shots.find(s=>s.error)?.uncertainCreate,uncertain);
    if(uncertain)assert.throws(()=>f.engine.resume(j,true),/核对/);
  }
});

function pausedRefillJob(f) {
  const j={id:f.store.id(),projectId:f.p.id,execution:'live',snapshot:structuredClone(f.p),routes:f.engine.routes(f.p,'live'),status:'needs_attention',events:[],shots:f.p.plan.storyboards.map(s=>({id:s.id,state:'pending',attempts:0,candidateIndex:0,remoteId:null,submitted:false,output:null,history:[]}))};
  Object.assign(j.shots[0],{state:'succeeded',attempts:1,remoteId:'keep-success',output:'keep-success.mp4',history:[{remoteId:'keep-success',state:'succeeded'}]});
  Object.assign(j.shots[1],{state:'failed',attempts:2,submitted:true,model:'vidu-q4',history:[{remoteId:'old-fail-1',state:'failed',failed:true},{remoteId:'old-fail-2',state:'failed',failed:true}]});
  Object.assign(j.shots[2],{state:'needs_attention',attempts:1,submitted:true,uncertainCreate:true,error:'ambiguous',history:[{state:'submitting',error:'ambiguous'}]});
  f.store.state.jobs[j.id]=j;f.store.save();return j;
}

test('selective refill preserves successes, unknown creates and old attempts; exactly one new create per selected shot',async t=>{
  let creates=0;
  const f=await fixture(t,{duration:60,providers:{async create(){return{id:'refill-'+(++creates)};},async poll(){return{state:'succeeded',url:'https://cdn.example.com/v.mp4'};}}});
  const j=pausedRefillJob(f),before={success:JSON.stringify(j.shots[0]),unknown:JSON.stringify(j.shots[2]),snapshot:JSON.stringify(j.snapshot),routes:JSON.stringify(j.routes)};
  const input={confirmPaid:true,idempotencyKey:'refill-once-key',shotIds:[1,3]};
  f.engine.refill(j,input);assert.equal(f.engine.refill(j,{...input,shotIds:[3,1]}),j);await settled(f.engine);
  assert.equal(creates,2);assert.equal(j.status,'needs_attention');assert.equal(j.shots[1].attempts,3);assert.equal(j.shots[3].attempts,1);
  assert.equal(JSON.stringify(j.shots[0]),before.success);assert.equal(JSON.stringify(j.shots[2]),before.unknown);
  assert.equal(JSON.stringify(j.snapshot),before.snapshot);assert.equal(JSON.stringify(j.routes),before.routes);
  assert.deepEqual(j.shots[1].history.slice(0,2).map(h=>h.remoteId),['old-fail-1','old-fail-2']);
  assert.ok(j.shots.slice(4).every(s=>s.state==='pending'&&s.attempts===0));
  assert.throws(()=>f.engine.refill(j,{...input,shotIds:[4]}),/幂等键/);
  const saved=new Store(f.root),fresh=new Engine(saved,{env:{ENABLE_LIVE_GENERATION:'true'},providers:f.providers});
  fresh.refill(saved.getJob(j.id),input);assert.equal(creates,2);assert.equal(fresh.active,null);
});

test('refill rejects unconfirmed, successful, accepted or uncertain shots atomically',async t=>{
  const f=await fixture(t,{duration:60});const j=pausedRefillJob(f);
  Object.assign(j.shots[4],{state:'needs_attention',remoteId:'accepted-running',attempts:1,history:[{remoteId:'accepted-running'}]});
  const input={confirmPaid:true,idempotencyKey:'refill-reject-key',shotIds:[1,3]};const before=JSON.stringify(j);
  assert.throws(()=>f.engine.refill(j,{...input,confirmPaid:false}),/确认/);
  for(const shotIds of [[0],[2],[4],[1,2],[1,1],[-1],[],[999]])assert.throws(()=>f.engine.refill(j,{...input,shotIds}));
  assert.equal(JSON.stringify(j),before);assert.equal(f.calls.length,0);
});

test('refill stops on new ambiguous creation and does not retry it or another selected failure',async t=>{
  let creates=0;
  const f=await fixture(t,{duration:60,routing:{concurrency:1},providers:{async create(){creates++;throw new ProviderError('new unknown',{uncertain:true});}}});
  const j=pausedRefillJob(f);f.engine.refill(j,{confirmPaid:true,idempotencyKey:'refill-unknown-key',shotIds:[1,3]});await settled(f.engine);
  assert.equal(creates,1);assert.equal(j.shots[1].attempts,3);assert.equal(j.shots[1].uncertainCreate,true);assert.equal(j.shots[3].attempts,0);
  assert.equal(j.batchSubmission.status,'needs_attention');assert.throws(()=>f.engine.resume(j,true),/核对/);
});

test('two explicitly parallel batch jobs share five upstream requests and two local media slots',async t=>{
  let creates=0,inflight=0,peak=0,ready=false,local=0,localPeak=0;
  const work=async fn=>{inflight++;peak=Math.max(peak,inflight);try{await sleep(15);return fn();}finally{inflight--;}};
  const f=await fixture(t,{duration:60,routing:{concurrency:5},pollLimit:Infinity,providers:{
    async create(){return work(()=>({id:'parallel-'+(++creates)}));},async poll(){return work(()=>ready?{state:'succeeded',url:'https://cdn.example.com/v.mp4'}:{state:'running'});}
  },media:{async downloadVideo(){local++;localPeak=Math.max(localPeak,local);await sleep(10);},async normalizeClip(_,output){await fs.writeFile(output,'clip');local--;}}});
  const p2={...structuredClone(f.p),id:f.store.id()},p3={...structuredClone(f.p),id:f.store.id()};
  f.store.state.projects[p2.id]=p2;f.store.state.projects[p3.id]=p3;
  const a=f.engine.start(f.p,{...args,submissionMode:'batch'});
  assert.throws(()=>f.engine.start(p2,{...args,idempotencyKey:'parallel-job-two'}),/已有项目/);
  assert.throws(()=>f.engine.start(f.p,{...args,idempotencyKey:'parallel-same-project',allowParallel:true}),/该项目/);
  const b=f.engine.start(p2,{...args,idempotencyKey:'parallel-job-two',submissionMode:'batch',allowParallel:true});
  assert.throws(()=>f.engine.start(p3,{...args,idempotencyKey:'parallel-job-three',allowParallel:true}),/最多允许两部/);
  await until(()=>a.batchSubmission?.status==='submitted'&&b.batchSubmission?.status==='submitted');
  assert.equal(creates,a.shots.length+b.shots.length);assert.equal(peak,5);assert.equal(f.engine.runs.size,2);
  ready=true;await settled(f.engine);assert.equal(a.status,'succeeded');assert.equal(b.status,'succeeded');assert.equal(localPeak,2);
  assert.ok([...a.shots,...b.shots].every(s=>s.attempts===1));assert.equal(f.engine.referenceCaches.size,0);
});

test('cancelling one parallel job leaves the other controller and accepted IDs intact',async t=>{
  let creates=0,ready=false;
  const f=await fixture(t,{pollLimit:Infinity,providers:{async create(){return{id:'cancel-parallel-'+(++creates)};},async poll(){return ready?{state:'succeeded',url:'https://cdn.example.com/v.mp4'}:{state:'running'};}}});
  const p2={...structuredClone(f.p),id:f.store.id()};f.store.state.projects[p2.id]=p2;
  const a=f.engine.start(f.p,args),b=f.engine.start(p2,{...args,idempotencyKey:'cancel-second-key',allowParallel:true});
  await until(()=>a.shots[0].remoteId&&b.shots[0].remoteId);const bId=b.shots[0].remoteId;f.engine.cancel(a);
  await until(()=>!f.engine.runs.has(a.id));assert.equal(a.status,'cancelled');assert.equal(f.engine.active.id,b.id);assert.equal(f.engine.runs.get(b.id).controller.signal.aborted,false);
  ready=true;await settled(f.engine);assert.equal(b.status,'succeeded');assert.equal(b.shots[0].remoteId,bId);assert.equal(creates,2);
});
