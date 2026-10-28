import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkGate} from '../lib/work-gate.mjs';

test('cancelled queued local work never runs and releases its abort listener',async()=>{
  const gate=new WorkGate(1),controller=new AbortController(),release=await gate.acquire();
  let ran=false;
  const waiting=gate.run(()=>{ran=true;},controller.signal);
  controller.abort();await assert.rejects(waiting,/abort/i);assert.equal(gate.queue.length,0);release();assert.equal(ran,false);assert.equal(gate.active,0);
  await gate.run(()=>{});assert.equal(gate.active,0);
});
test('failed local work releases its slot and release is idempotent',async()=>{
  const gate=new WorkGate(1);
  await assert.rejects(gate.run(()=>{throw Error('failed');}),/failed/);
  const release=await gate.acquire();release();release();assert.equal(gate.active,0);
});
