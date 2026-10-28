import {loadPlaywright} from './playwright-runtime.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {createApp,ROOT} from '../server.mjs';
import {fixture,env,settled} from '../tests/helpers/shot-fixture.mjs';

const {chromium}=loadPlaywright();
await fs.mkdir(path.join(ROOT,'artifacts'),{recursive:true});
let ready=false;
const f=await fixture({poll:()=>ready?{state:'succeeded',url:'https://example.invalid/clip.mp4'}:{state:'running'}});
f.p.revision=2;f.store.save();
const receiptDir=path.join(f.store.work,f.job.id,'gap-draft','b'.repeat(64));await fs.mkdir(receiptDir,{recursive:true});
await fs.writeFile(path.join(receiptDir,'receipt.json'),JSON.stringify({jobId:f.job.id,file:f.job.shots[0].output,successfulShots:1,totalShots:4,verification:{originalSongMatched:true},gaps:[{shot:2,start:4,end:8,duration:4}]}));
const app=createApp({dataDir:f.root,env,engineOptions:{providers:f.providers,media:f.media,pollMs:20}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}`,browser=await chromium.launch({headless:true});
const errors=[],checks=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  let dialogs=[];page.on('dialog',d=>(dialogs.shift()?d.accept():d.dismiss()));
  const idle=()=>page.waitForFunction(()=>!document.body.classList.contains('busy'));
  const click=async selector=>{await page.locator(selector).click();await idle();};
  await page.goto(base);await page.locator('.hero').waitFor();
  assert.match(await page.locator('.card-generation').textContent(),/成功 1 \/ 4 镜/);
  assert.match(await page.locator('.card-generation').textContent(),/历史确认受理 2/);
  assert.match(await page.locator('.card-generation').textContent(),/非当前项目版本/);
  await click('[data-view="projects"]');assert.equal(await page.locator('[data-job-project]').count(),1);
  await click('[data-job-project]');await click('[data-shot-filter="missing"]');assert.equal(await page.locator('.shot-record').count(),3);
  assert.match(await page.locator('.managed-exports').textContent(),/留黑版 · 1 \/ 4 镜成功/);assert.equal(await page.locator('.managed-exports a').getAttribute('href'),'/media/'+f.job.shots[0].output);
  await click('[data-inspect-shot="1"]');
  const prompt=f.job.snapshot.plan.storyboards[1].prompt+'新的镜头调度 </textarea><img src=x onerror=alert(1)>';
  await page.locator('[data-revision-prompt="1"]').fill(prompt);await click('[data-action="refresh-shots"]');
  assert.equal(await page.locator('[data-revision-prompt="1"]').inputValue(),prompt);assert.equal(await page.locator('.shot-detail-body img').count(),0);
  dialogs=[false];await click('[data-retry-shot="1"]');assert.equal(f.calls.length,0);
  dialogs=[true];await click('[data-retry-shot="1"]');
  for(let i=0;i<100&&!f.calls.length;i++)await sleep(5);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].input.prompt,prompt);
  const draft=prompt+'保留中的草稿';await page.locator('[data-revision-prompt="1"]').fill(draft);await page.waitForTimeout(1800);
  assert.equal(await page.locator('[data-revision-prompt="1"]').inputValue(),draft);assert.equal(await page.locator('[data-revision-prompt="1"]').evaluate(el=>el===document.activeElement),true);
  ready=true;await settled(app.engine);await click('[data-action="refresh-shots"]');
  checks.push('Both project surfaces show actual counts and snapshot mismatch; editable prompts are escaped; confirmation cancellation sends nothing; one edited prompt reaches the fake provider; polling/refresh preserve draft and focus');
  await page.locator('#job-version').selectOption(f.job.id);await idle();await click('[data-inspect-shot="1"]');assert.equal(await page.locator('[data-retry-shot="1"]').isDisabled(),true);
  const childId=Object.values(app.store.state.jobs).at(-1).id;
  await page.locator('#job-version').selectOption(childId);await idle();await click('[data-inspect-shot="2"]');
  dialogs=[true,false];await click('[data-retry-shot="2"]');assert.equal(f.calls.length,1);
  dialogs=[true,true];await click('[data-retry-shot="2"]');await settled(app.engine);assert.equal(f.calls.length,2);
  assert.equal(app.store.getJob(f.job.id).shots[2].uncertainCreate,true);
  await click('[data-action="refresh-shots"]');
  await click('[data-inspect-shot="3"]');
  await page.route('**/revise-shot',async route=>{await route.fetch();await route.abort('failed');});
  dialogs=[true];await click('[data-retry-shot="3"]');await settled(app.engine);assert.equal(f.calls.length,3);
  assert.equal(await page.locator('[data-retry-shot="3"]').isDisabled(),true);
  await click('[data-action="refresh-shots"]');assert.equal(f.calls.length,3);
  assert.equal(await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('mv-revision/')).length),0);
  checks.push('Old versions cannot resubmit; unknown requests require separate duplicate-billing consent; lost POST response is reconciled by GET with the same recorded key and never resubmitted');
  await click('[data-shot-filter="all"]');
  for(const width of [1440,768,390,320]){
    await page.setViewportSize({width,height:1000});
    for(const theme of ['light','dark']){
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${width}/${theme} overflow`);
      const small=await page.locator('button,select,summary').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().height>0&&n.getBoundingClientRect().height<43).map(n=>n.outerHTML.slice(0,100)));assert.deepEqual(small,[]);
    }
  }
  assert.deepEqual(errors,[]);checks.push('1440/768/390/320px and two themes have no overflow; visible controls have 44px targets; no script errors');
  const result={status:'passed',checks,realProviderRequests:0,fakeCreates:f.calls.length};
  await fs.writeFile(path.join(ROOT,'artifacts/shot-workbench-browser-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{
  for(const run of app.engine.runs.values())run.controller.abort();await settled(app.engine);
  await browser.close();app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await f.cleanup();
}
