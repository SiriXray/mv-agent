import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {run, binaries, normalizeClip, probe, assemble} from '../lib/media.mjs';

test('2K export has 2560x1440 pixels; shorter-than-requested upstream media is rejected', async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mv-2k-test-'));
  t.after(async()=>{assert.ok(path.basename(dir).startsWith('mv-2k-test-'));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const source=path.join(dir,'source.mp4'),output=path.join(dir,'out.mp4');
  await run(binaries().ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=1280x720:r=30','-t','2','-c:v','libx264','-pix_fmt','yuv420p',source]);
  const project={resolution:'2K',aspect_ratio:'16:9'},shot={duration:2};
  await assert.rejects(normalizeClip(source,output,shot,project,undefined,{}, {duration:15}),/短于申请生成时长/);
  const actual=await normalizeClip(source,output,shot,project,undefined,{}, {duration:2});
  assert.equal(actual.upscaled,true);assert.equal(actual.width,1280);
  const info=await probe(output),video=info.streams.find(s=>s.codec_type==='video');
  assert.equal(video.width,2560);assert.equal(video.height,1440);assert.equal(video.codec_name,'h264');
  assert.ok(Math.abs(Number(info.format.duration)-2)<.12);
});

test('MV strips generated audio and aligns separate video/song streams to the original fractional timeline', async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mv-av-sync-test-'));
  t.after(async()=>{assert.ok(path.basename(dir).startsWith('mv-av-sync-test-'));assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(dir,{recursive:true,force:true});});
  const ffmpeg=binaries().ffmpeg,source=path.join(dir,'generated-with-audio.mp4'),song=path.join(dir,'original-song.wav'),output=path.join(dir,'final.mp4');
  const clips=[path.join(dir,'shot-1.mp4'),path.join(dir,'shot-2.mp4')],duration=5.375;
  await run(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=320x180:r=30','-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','4','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);
  await run(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i',`aevalsrc=0.2*sin(2*PI*(330*t+100*t*t)):s=48000:d=${duration}`,'-c:a','pcm_s16le',song]);
  const project={resolution:'720p',aspect_ratio:'16:9',audio:{duration}};
  for(let i=0;i<clips.length;i++){
    await normalizeClip(source,clips[i],{duration:i===0?2:4},project,undefined,{}, {duration:4});
    const info=await probe(clips[i]);assert.equal(info.streams.filter(s=>s.codec_type==='audio').length,0);
  }
  await assemble(clips,song,output,project,dir);
  const info=await probe(output),video=info.streams.filter(s=>s.codec_type==='video'),audio=info.streams.filter(s=>s.codec_type==='audio');
  assert.equal(video.length,1);assert.equal(audio.length,1);assert.equal(video[0].codec_name,'h264');assert.equal(audio[0].codec_name,'aac');
  const frame=1/30;
  assert.ok(Math.abs(Number(video[0].start_time)-Number(audio[0].start_time))<=frame);
  for(const stream of [video[0],audio[0]]){assert.ok(Math.abs(Number(stream.start_time))<=frame);assert.ok(Math.abs(Number(stream.duration)-duration)<=frame,`${stream.codec_type}: duration=${stream.duration}, song=${duration}, start=${stream.start_time}`);}
  assert.ok(Math.abs(Number(video[0].duration)-Number(audio[0].duration))<=frame);
  const decode=file=>run(ffmpeg,['-nostdin','-v','error','-i',file,'-map','0:a:0','-t',String(duration),'-ac','1','-ar','8000','-f','f32le','pipe:1']);
  const [original,rendered]=await Promise.all([decode(song),decode(output)]);
  const samples=Math.floor(duration*8000);assert.ok(original.length>=samples*4);assert.ok(rendered.length>=samples*4);
  let dot=0,energyOriginal=0,energyRendered=0;
  for(let n=800;n<samples-800;n++){const a=original.readFloatLE(n*4),b=rendered.readFloatLE(n*4);dot+=a*b;energyOriginal+=a*a;energyRendered+=b*b;}
  const alignedCorrelation=dot/Math.sqrt(energyOriginal*energyRendered);
  assert.ok(alignedCorrelation>.98,`Original song must match at zero offset; correlation=${alignedCorrelation}`);
});
