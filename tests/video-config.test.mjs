import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

test('server-side reload uses only its configured env file, masks values, and never invokes models', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mv-config-test-'));
  const envFile=path.join(dir,'.env'), env={DASHSCOPE_API_KEY:'old'};
  await fs.writeFile(envFile,'DASHSCOPE_API_KEY=new-sentinel\nVIDU_PREVIEW_API_KEY=preview-sentinel\nENABLE_LIVE_GENERATION=true\n');
  let calls=0;
  const app=createApp({dataDir:dir,env,envFile,engineOptions:{providers:{create(){calls++;}}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{
    app.server.closeAllConnections();await new Promise(r=>app.server.close(r));
    assert.ok(path.basename(dir).startsWith('mv-config-test-'));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));
    await fs.rm(dir,{recursive:true,force:true});
  });
  assert.equal(env.DASHSCOPE_API_KEY,'new-sentinel');
  const base='http://127.0.0.1:'+app.server.address().port;
  const boot=await(await fetch(base+'/api/bootstrap')).json();
  assert.ok(!JSON.stringify(boot).includes('sentinel'));
  assert.equal((await fetch(base+'/api/config/reload',{method:'POST'})).status,403);
  await fs.writeFile(envFile,'DASHSCOPE_API_KEY=rotated-sentinel\n');
  const response=await fetch(base+'/api/config/reload',{method:'POST',headers:{'X-MV-Token':boot.token},body:JSON.stringify({path:'C:/unrelated/.env'})});
  assert.equal(response.status,200);assert.equal(env.DASHSCOPE_API_KEY,'rotated-sentinel');
  assert.ok(!(await response.text()).includes('sentinel'));assert.equal(calls,0);
});
