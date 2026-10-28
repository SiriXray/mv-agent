import {loadPlaywright} from './playwright-runtime.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createApp, ROOT} from '../server.mjs';
import {defaults, templatePlan} from '../lib/core.mjs';
import {run, binaries} from '../lib/media.mjs';

const {chromium}=loadPlaywright();
await fs.mkdir(path.join(ROOT,'artifacts'),{recursive:true});
const data=await fs.mkdtemp(path.join(os.tmpdir(),'mv-concurrency-browser-'));
let creates=0,ready=false;
const app=createApp({dataDir:data,env:{ENABLE_LIVE_GENERATION:'true',VIDU_API_KEY:'offline-fixture'},engineOptions:{pollMs:20,
  providers:{async create(){return{id:'offline-'+(++creates)};},async poll(){return ready?{state:'succeeded',url:'https://fixture.example.com/clip.mp4'}:{state:'running'};}},
  media:{async downloadVideo(){},async normalizeClip(_,output){await fs.writeFile(output,'fixture');},async assemble(_,__,output){await fs.writeFile(output,'fixture');return{duration:40,width:1280,height:720};}}
}});
const imageFile=app.store.id()+'.png',audioFile=app.store.id()+'.wav';
await run(binaries().ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','testsrc=size=128x128','-frames:v','1',app.store.mediaPath(imageFile)]);
await run(binaries().ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=40',app.store.mediaPath(audioFile)]);
const p={...defaults({title:'并发控制 · 离线验证',resolution:'720p',audio:{file:audioFile,duration:40,url:'/media/'+audioFile},assets:[{file:imageFile,mime:'image/png',url:'/media/'+imageFile,asset_id:'image',asset_name:'测试图',asset_description:'彩色几何测试图案'}]}),id:app.store.id(),revision:1};
p.plan=templatePlan(p);app.store.state.projects[p.id]=p;app.store.save();
const job=app.engine.start(p,{execution:'live',confirmPaid:true,revision:1,idempotencyKey:'offline-concurrency-browser'});
await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true});
try{
  const page=await browser.newPage({viewport:{width:1500,height:1050}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  await page.goto(`http://127.0.0.1:${app.server.address().port}/`);await page.locator('.hero').waitFor();
  await page.locator('[data-view="studio"]').click();await page.locator('[data-step="2"]').click();
  await page.locator('#job-concurrency').waitFor();assert.equal(await page.locator('#job-concurrency').inputValue(),'2');
  await page.locator('#job-concurrency').fill('5');await page.locator('[data-action="job-concurrency"]').click();
  await page.waitForFunction(()=>document.querySelector('.job-panel').textContent.includes('当前任务并发 5'));
  for(let n=0;n<100&&creates<5;n++)await sleep(10);
  assert.equal(creates,5);assert.equal(job.concurrency,5);assert.equal(job.snapshot.routing.concurrency,2);assert.ok(job.shots.filter(s=>s.remoteId).every(s=>s.attempts===1));
  await page.screenshot({path:path.join(ROOT,'artifacts/concurrency-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(ROOT,'artifacts/concurrency-mobile.png'),fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  const result={status:'passed',realModelRequests:0,checks:['live concurrency 2 to 5','unchanged task snapshot','one create per accepted shot','desktop and 390px layout','no browser errors']};
  await fs.writeFile(path.join(ROOT,'artifacts/browser-concurrency-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{
  if(app.engine.active)app.engine.cancel(job);
  for(let n=0;n<200&&app.engine.active;n++)await sleep(10);
  await browser.close();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));
  assert.equal(app.engine.active,null);assert.ok(path.resolve(data).startsWith(path.resolve(os.tmpdir())+path.sep));assert.ok(path.basename(data).startsWith('mv-concurrency-browser-'));await fs.rm(data,{recursive:true,force:true});
}
