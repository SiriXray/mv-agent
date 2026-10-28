import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {Store} from '../../lib/store.mjs';
import {Engine} from '../../lib/engine.mjs';
import {defaults} from '../../lib/core.mjs';

export const env = {ENABLE_LIVE_GENERATION:'true', VIDU_API_KEY:'isolated-test-only'};
export async function settled(engine) {
  for(let i=0;i<600&&engine.active;i++)await sleep(5);
  assert.equal(engine.active,null);
}
export async function fixture(options={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mv-shot-revision-'));
  const store=new Store(root), calls=[], image=store.id()+'.png', audio=store.id()+'.mp3';
  await fs.writeFile(store.mediaPath(image),'fixture');
  const p={...defaults({title:'镜头版本测试',resolution:'2K',aspect_ratio:'9:16',audio:{file:audio,duration:16},assets:[{file:image,mime:'image/png',asset_id:'actor',asset_name:'青年',asset_description:'白衣青年'}]}),id:store.id(),revision:1};
  p.plan={COT:'四镜测试',storyboards:Array.from({length:4},(_,id)=>({id,start:id*4,duration:4,lyric_text:'',assets:['actor'],prompt:`${p.style}。白衣青年，第${id+1}镜。`}))};
  store.state.projects[p.id]=p;
  const providers={async create(model,input){calls.push({model,input});return options.create?options.create(calls.length):{id:'new-'+calls.length};},async poll(){return options.poll?options.poll():{state:'succeeded',url:'https://example.invalid/clip.mp4'};}};
  const media={async downloadVideo(){},async normalizeClip(_,out){await fs.writeFile(out,'fixture');},async assemble(_,__,out){await fs.writeFile(out,'fixture');return {duration:16};}};
  const engine=new Engine(store,{env,providers,media,pollMs:0,pollLimit:1});
  const job={id:store.id(),projectId:p.id,snapshot:structuredClone(p),execution:'live',status:'needs_attention',updatedAt:'2026-10-28T00:00:00.000Z',createdAt:'2026-10-28T00:00:00.000Z',concurrency:2,routes:engine.routes(p,'live'),events:[],shots:p.plan.storyboards.map(s=>({id:s.id,state:'pending',attempts:0,candidateIndex:0,output:null,remoteId:null,history:[]}))};
  Object.assign(job.shots[0],{state:'succeeded',attempts:1,model:'vidu-q4',output:store.id()+'.mp4',remoteId:'old-success',history:[{attempt:1,remoteId:'old-success',state:'succeeded'}]});
  Object.assign(job.shots[1],{state:'failed',attempts:6,model:'vidu-q4',history:[{attempt:6,remoteId:'old-failed',state:'failed'}]});
  Object.assign(job.shots[2],{state:'needs_attention',attempts:1,uncertainCreate:true,error:'请求超时',history:[{attempt:1,state:'submitting',error:'请求超时'}]});
  await fs.writeFile(store.mediaPath(job.shots[0].output),'old-material');
  store.state.jobs[job.id]=job;store.save();
  async function cleanup(){for(const run of engine.runs.values())run.controller.abort();await settled(engine);assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(root).startsWith('mv-shot-revision-'));await fs.rm(root,{recursive:true,force:true});}
  return {root,store,p,job,engine,calls,providers,media,cleanup};
}
export const request=(f,id=1)=>({shotId:id,prompt:f.job.snapshot.plan.storyboards[id].prompt+'缓缓推近。',confirmPaid:true,expectedAttempts:f.job.shots[id].attempts,expectedUpdatedAt:f.job.updatedAt,projectRevision:f.p.revision,idempotencyKey:'shot-revision-test-key'});
