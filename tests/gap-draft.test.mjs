import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildGapTimeline, exportGapDraft} from '../lib/gap-draft.mjs';
import {binaries, run} from '../lib/media.mjs';

const fixture = () => ({id: randomUUID(), status: 'needs_attention', snapshot: {title: 'Test', resolution: '720p', aspect_ratio: '16:9', audio: {file: randomUUID()+'.wav', duration: 5.375}, plan: {storyboards: [0,1,2].map(id=>({id,start:id*2,duration:2,prompt:'shot '+id}))}}, shots: [{id:0,state:'succeeded',output:randomUUID()+'.mp4'}, {id:1,state:'needs_attention',output:null}, {id:2,state:'succeeded',output:randomUUID()+'.mp4'}]});

test('gap timeline preserves every slot and the fractional song end, rejecting malformed or running jobs', () => {
  const job = fixture(), timeline = buildGapTimeline(job);
  assert.deepEqual(timeline.map(s=>[s.start,s.end,s.blank]),[[0,2,false],[2,4,true],[4,5.375,false]]);
  job.status='running';assert.throws(()=>buildGapTimeline(job),/仍在运行/);
  job.status='needs_attention';job.snapshot.plan.storyboards[1].start=2.5;assert.throws(()=>buildGapTimeline(job),/不连续/);
  job.snapshot.plan.storyboards[1].start=2;job.shots[0].output=null;assert.throws(()=>buildGapTimeline(job),/产物记录/);
});

for (const colorRange of ['tv', 'pc']) test(`opt-in ${colorRange} gap export keeps black slots and original audio, without changing the job or sources; reruns reuse output`, async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mv-gap-draft-test-'));
  t.after(async()=>{assert.ok(path.basename(dir).startsWith('mv-gap-draft-test-'));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const media=path.join(dir,'media');await fs.mkdir(media);
  const job=fixture(),ffmpeg=binaries().ffmpeg,song=path.join(media,job.snapshot.audio.file),source=path.join(media,job.shots[0].output);
  await run(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=1280x720:r=30','-t','2','-vf',colorRange==='pc'?'scale=out_range=full':'null','-c:v','libx264','-pix_fmt',colorRange==='pc'?'yuvj420p':'yuv420p','-color_range',colorRange,'-colorspace','bt709',source]);
  await fs.copyFile(source,path.join(media,job.shots[2].output));
  await run(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i',`aevalsrc=0.2*sin(2*PI*(330*t+100*t*t)):s=48000:d=${job.snapshot.audio.duration}`,'-c:a','pcm_s16le',song]);
  const dbFile=path.join(dir,'store.json'),before=JSON.stringify({jobs:{[job.id]:job}});await fs.writeFile(dbFile,before);
  const sourceBefore=await fs.readFile(source);
  await assert.rejects(exportGapDraft(dir,job.id),/allow-gaps/);
  const result=await exportGapDraft(dir,job.id,{allowGaps:true});
  assert.equal(result.complete,false);assert.equal(result.kind,'gap-draft');assert.equal(result.successfulShots,2);
  assert.equal(result.gaps.length,1);assert.equal(result.gaps[0].start,2);assert.equal(result.verification.originalSongMatched,true);
  const pixel=async time=>run(ffmpeg,['-nostdin','-v','error','-ss',String(time),'-i',result.path,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  assert.ok((await pixel(1))[2]>180);assert.ok((await pixel(3)).every(v=>v<5));assert.ok((await pixel(4.5))[2]>180);
  assert.equal(await fs.readFile(dbFile,'utf8'),before);assert.deepEqual(await fs.readFile(source),sourceBefore);
  const files=await fs.readdir(media),second=await exportGapDraft(dir,job.id,{allowGaps:true});assert.equal(second.file,result.file);assert.equal(second.reused,true);assert.deepEqual(await fs.readdir(media),files);
  assert.match(await fs.readFile(result.gapList,'utf8'),/00:02.000/);
});
