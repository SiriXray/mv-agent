import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {loadPlaywright} from './playwright-runtime.mjs';

// Read-only against the running workbench: all mutations and external requests are blocked.
const root=fileURLToPath(new URL('../',import.meta.url));
const base='http://127.0.0.1:5410';
const {chromium}=loadPlaywright();
await fs.mkdir(path.join(root,'artifacts'),{recursive:true});
const hash=async()=>createHash('sha256').update(await fs.readFile(path.join(root,'data/store.json'))).digest('hex');
const before=await hash();
const health=await (await fetch(base+'/api/health')).json();
const boot=await (await fetch(base+'/api/bootstrap')).json();
assert.ok(boot.projects.length,'This read-only test requires an existing project; do not auto-create one');
const browser=await chromium.launch({headless:true});
const checks=[],errors=[],blocked=[];
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('dialog',d=>d.dismiss());
  await page.route('**/*',route=>{
    const r=route.request(),url=new URL(r.url());
    if(url.origin===base&&['GET','HEAD'].includes(r.method()))return route.continue();
    if(['data:','blob:'].includes(url.protocol))return route.continue();
    blocked.push({method:r.method(),path:url.pathname});return route.abort();
  });
  const idle=()=>page.waitForFunction(()=>!document.body.classList.contains('busy'));
  const go=async view=>{await page.locator(`[data-view="${view}"]`).click();await idle();};
  await page.goto(base);await page.locator('.hero').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  assert.equal(await page.locator('.project-card').count(),Math.min(4,boot.projects.length));
  assert.equal(await page.locator('.frost-orb').count(),2);
  assert.equal(await page.locator('footer,.sidebar-note').count(),0);
  const assets=await page.locator('.hero img,.hero image').evaluateAll(async images=>Promise.all(images.map(async el=>{const image=new Image();image.src=el.getAttribute('src')||el.getAttribute('href');await image.decode();return image.naturalWidth>0;})));
  assert.ok(assets.every(Boolean));
  const material=await page.locator('.project-card').first().evaluate(el=>{const s=getComputedStyle(el);return {background:s.backgroundColor,blur:s.backdropFilter,shadow:s.boxShadow,font:s.fontFamily};});
  assert.match(material.background,/0\.54\)/);assert.match(material.blur,/blur\(18px\)/);assert.match(material.shadow,/inset/);assert.match(material.font,/Microsoft YaHei/);
  await page.screenshot({path:path.join(root,'artifacts/live-glass-home.png'),fullPage:true});
  checks.push('Real project cards, approved tree portal and two translucent matte spheres; 54% glass surfaces with 18px backdrop blur');
  await go('projects');
  await page.locator('#project-search').fill('<no matching project>');assert.equal(await page.locator('.project-card').count(),0);
  assert.match(await page.locator('.empty').textContent(),/没有匹配/);
  await page.locator('#project-search').fill('');assert.equal(await page.locator('.project-card').count(),boot.projects.length);
  await go('studio');
  await page.locator('[data-field="title"]').focus();await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.upload),'audio');
  const chooser=page.waitForEvent('filechooser');await page.keyboard.press('Enter');await chooser;
  checks.push('Upload input is reachable by keyboard and Enter opens the native chooser without submitting a file');
  const title=page.locator('[data-field="title"]');await title.fill('仅测试主题切换，不保存');
  await page.locator('[data-action="theme"]').click();
  assert.equal(await title.inputValue(),'仅测试主题切换，不保存');
  assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
  await page.reload();await page.locator('.hero').waitFor();
  checks.push('Search and empty state; theme toggle preserves unsaved inputs without saving, submitting or re-rendering forms');
  const contrast=await page.evaluate(()=>{
    const canvas=document.createElement('canvas').getContext('2d');
    const rgb=color=>{canvas.fillStyle=color;canvas.fillRect(0,0,1,1);return [...canvas.getImageData(0,0,1,1).data].slice(0,3);};
    const lum=v=>v.reduce((sum,c,i)=>{c/=255;return sum+[.2126,.7152,.0722][i]*(c<=.04045?c/12.92:((c+.055)/1.055)**2.4);},0);
    const pairs=[];
    for(const theme of ['light','dark']) {
      document.documentElement.dataset.theme=theme;
      const s=getComputedStyle(document.documentElement),get=key=>s.getPropertyValue(key).trim();
      const backgrounds=['--canvas-rose','--canvas-mist','--canvas-pearl','--canvas-blush','--surface-raised','--surface-deep'];
      for(const fg of ['--text','--muted','--accent','--good'])for(const bg of backgrounds){const a=lum(rgb(get(fg))),b=lum(rgb(get(bg)));pairs.push({theme,fg,bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});}
    }
    return pairs;
  });
  assert.ok(contrast.every(p=>p.ratio>=4.5),JSON.stringify(contrast.filter(p=>p.ratio<4.5)));
  checks.push('48 text/color endpoint combinations exceed 4.5:1; glass mixes light surfaces on light canvas or dark surfaces on dark canvas');
  for(const width of [1440,1024,768,390,320]) {
    await page.setViewportSize({width,height:1000});
    for(const theme of ['light','dark']) {
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      for(const view of ['home','projects','studio','models','ai','production']) {
        await go(view);
        const overflow=await page.evaluate(()=>({actual:document.documentElement.scrollWidth,width:innerWidth}));
        assert.ok(overflow.actual<=overflow.width+1,JSON.stringify({width,theme,view,...overflow}));
        const fonts=await page.locator('body,h1,h2,h3,input,select,textarea,button').evaluateAll(nodes=>nodes.filter(n=>!getComputedStyle(n).fontFamily.includes('Microsoft YaHei')).map(n=>n.tagName));
        assert.deepEqual(fonts,[],`${view} font stack`);
        const small=await page.locator('button,input:not([type="checkbox"]):not([type="file"]),select,summary').evaluateAll(nodes=>nodes.filter(n=>n.getBoundingClientRect().width&&n.getBoundingClientRect().height&&n.getBoundingClientRect().height<43).map(n=>n.outerHTML.slice(0,100)));
        assert.deepEqual(small,[],JSON.stringify({width,theme,view}));
        if(view==='ai')assert.equal(await page.locator('h1').textContent(),'配置');
        if(view==='home'&&width===390&&theme==='light')await page.screenshot({path:path.join(root,'artifacts/live-glass-mobile.png'),fullPage:true});
        if(view==='home'&&width===1440&&theme==='dark')await page.screenshot({path:path.join(root,'artifacts/live-glass-dark.png'),fullPage:true});
      }
    }
  }
  checks.push('6 real views × 5 widths × 2 themes; YaHei, 44px controls and no page overflow');
  await page.setViewportSize({width:1440,height:1000});
  await page.evaluate(()=>document.documentElement.dataset.theme='light');await go('studio');
  await page.screenshot({path:path.join(root,'artifacts/live-glass-studio.png')});
  // Select an existing planned project through the UI; do not create a plan to enable stage checks.
  for(const summary of boot.projects) {
    const project=await (await fetch(base+'/api/projects/'+summary.id)).json();
    if(project.plan){await go('projects');await page.locator(`[data-project="${project.id}"]`).click();await idle();break;}
  }
  for(const step of [1,2,3])if(await page.locator(`[data-step="${step}"]`).isEnabled()){
    await page.locator(`[data-step="${step}"]`).click();await idle();
    for(const width of [1440,390,320]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`Stage ${step}, width ${width}`);}
  }
  // Current production jobs are read-only: never click a paid action even on a new service.
  await go('projects');
  const managerButton=page.locator('[data-job-project]').first();
  if(await managerButton.count()){
    const projectId=await managerButton.getAttribute('data-job-project');
    const project=await (await fetch(base+'/api/projects/'+projectId)).json();
    const job=await (await fetch(base+'/api/jobs/'+project.activeJob)).json();
    await managerButton.click();await idle();
    assert.equal(await page.locator('.shot-record').count(),job.shots.length);
    await page.locator('[data-shot-filter="missing"]').click();await idle();
    assert.equal(await page.locator('.shot-record').count(),job.shots.filter(s=>s.state!=='succeeded').length);
    const inspect=page.locator('[data-inspect-shot]').first();
    if(await inspect.count()){
      await inspect.click();await idle();
      const textarea=page.locator('[data-revision-prompt]'),original=await textarea.inputValue();
      await textarea.fill(original+'（只读验收草稿，不提交）');
      await page.locator('[data-action="refresh-shots"]').click();await idle();
      assert.equal(await textarea.inputValue(),original+'（只读验收草稿，不提交）');
      if(!boot.capabilities.shotManagement)assert.equal(await page.locator('[data-retry-shot]').isDisabled(),true);
      for(const width of [1440,390,320]){
        await page.setViewportSize({width,height:1000});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'shot manager '+width);
        if(width!==320)await page.screenshot({path:path.join(root,`artifacts/live-shot-manager-${width}.png`),fullPage:true});
      }
    }
    checks.push('Real job counts, missing-shot filter and request history; prompt draft survives refresh; old-service paid actions disabled; 1440/390/320px manager without writes');
  }
  await go('home');
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  assert.equal(await page.locator('.project-card').first().evaluate(el=>getComputedStyle(el).backdropFilter),'none');
  assert.equal(await page.locator('.page').evaluate(el=>getComputedStyle(el,'::before').display),'none');
  await page.locator('[data-action="open-studio"]').click();await idle();
  await cdp.send('Emulation.setEmulatedMedia',{features:[]});await cdp.detach();
  await page.emulateMedia({forcedColors:'active'});assert.equal(await page.locator('.page').evaluate(el=>getComputedStyle(el).backgroundImage),'none');
  await page.emulateMedia({forcedColors:'none'});await go('home');
  await page.evaluate(()=>{const nodes=[...document.querySelectorAll('body *')].filter(n=>!(n instanceof SVGElement));const sizes=nodes.map(n=>parseFloat(getComputedStyle(n).fontSize)*2);nodes.forEach((n,i)=>n.style.fontSize=sizes[i]+'px');});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'320px / 200% text overflow');
  checks.push('Available real stages, reduced-transparency and forced-colors fallbacks; 200% text at 320px');
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.equal(await hash(),before);
  assert.equal((await (await fetch(base+'/api/health')).json()).pid,health.pid);
  checks.push('No runtime errors, non-GET requests, external requests, database change or server restart');
  const result={status:'passed',at:new Date().toISOString(),checks,material,contrast,storeUnchanged:true,servicePid:health.pid};
  await fs.writeFile(path.join(root,'artifacts/live-frontend-results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({status:result.status,checks},null,2));
} finally {await browser.close();}
