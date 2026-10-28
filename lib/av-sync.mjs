import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {check} from './core.mjs';
import {assemble, binaries, outputSize, probe, run} from './media.mjs';

export async function verifyAvSync(file, song, project, env = process.env) {
  const info = await probe(file, env), video = info.streams.filter(s => s.codec_type === 'video'), audio = info.streams.filter(s => s.codec_type === 'audio');
  const tolerance = 1 / 30 + .001, expected = project.audio.duration, [width, height] = outputSize(project.resolution, project.aspect_ratio);
  check(video.length === 1 && audio.length === 1 && info.streams.length === 2, '成片必须只有一个视频轨和一个原曲音频轨', 422);
  check(video[0].codec_name === 'h264' && audio[0].codec_name === 'aac' && video[0].width === width && video[0].height === height, '成片编码或分辨率不匹配', 422);
  const starts = [Number(video[0].start_time), Number(audio[0].start_time)], durations = [Number(video[0].duration), Number(audio[0].duration)];
  check(starts.every(x => Number.isFinite(x) && Math.abs(x) <= tolerance) && durations.every(x => Number.isFinite(x) && Math.abs(x - expected) <= tolerance) && Math.abs(durations[0] - durations[1]) <= tolerance && Math.abs(Number(info.format.duration) - expected) <= tolerance, '音画起点或尾部误差超过一帧', 422);
  const decode = target => run(binaries(env).ffmpeg, ['-nostdin', '-v', 'error', '-i', target, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], {maxBytes: 24 * 1024 * 1024});
  const original = await decode(song), rendered = await decode(file), originalSamples = original.length / 4, renderedSamples = rendered.length / 4;
  check(Math.abs(originalSamples - renderedSamples) / 8000 <= tolerance, '原曲与成片解码音频时长不一致', 422);
  const count = Math.min(originalSamples, renderedSamples), window = Math.min(80000, Math.floor(count / 3));
  check(window > 0, '原曲或成片音轨为空', 422);
  const windows = [0, Math.floor((count - window) / 2), count - window], correlations = [];
  for (const start of windows) {
    let dot = 0, originalEnergy = 0, renderedEnergy = 0;
    for (let i = start; i < start + window; i++) { const a = original.readFloatLE(i * 4), b = rendered.readFloatLE(i * 4); dot += a * b; originalEnergy += a * a; renderedEnergy += b * b; }
    const silent = originalEnergy / window < 1e-10;
    const correlation = silent ? null : dot / Math.sqrt(originalEnergy * renderedEnergy);
    check(silent ? renderedEnergy / window < 1e-8 : Number.isFinite(correlation) && correlation >= .97, '原曲与成片音轨在零偏移处不匹配，请检查音轨来源或同步', 422);
    correlations.push({startSeconds: start / 8000, correlation, silent});
  }
  return {duration: Number(info.format.duration), width, height, videoStart: starts[0], audioStart: starts[1], videoDuration: durations[0], audioDuration: durations[1], originalDecodedDuration: originalSamples / 8000, audioVideoEndDifference: Math.abs(durations[0] - durations[1]), toleranceSeconds: tolerance, originalSongMatched: true, correlations};
}

export async function finalizeMv(dataDir, jobId, env = process.env) {
  check(/^[a-f0-9-]{36}$/.test(jobId), '任务 ID 无效');
  const database = JSON.parse(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8')), job = database.jobs[jobId];
  check(job?.status === 'succeeded' && job.output && job.shots.length === job.snapshot.plan.storyboards.length && job.shots.every(s => s.state === 'succeeded' && s.output), '分镜尚未全部完成，不能导出缺镜 MV', 409);
  const mediaPath = name => { check(/^[a-f0-9-]{36}\.(mp4|mp3|wav|m4a|flac|ogg)$/.test(name), '媒体路径无效'); return path.resolve(dataDir, 'media', name); };
  const song = mediaPath(job.snapshot.audio.file), source = mediaPath(job.output), clips = job.shots.map(s => mediaPath(s.output));
  await Promise.all([song, source, ...clips].map(file => fs.access(file)));
  const work = path.resolve(dataDir, 'work', jobId), receiptFile = path.join(work, 'av-aligned.json'), lockFile = path.join(work, 'av-aligned.lock');
  const snapshotHash = createHash('sha256').update(JSON.stringify(job.snapshot)).digest('hex');
  await fs.mkdir(work, {recursive: true});
  let lock;
  try { lock = await fs.open(lockFile, 'wx'); } catch (error) { if (error.code === 'EEXIST') check(false, '已有音画校准在运行；请稍后读取结果，不重复启动', 409); throw error; }
  try {
    let previous;
    try { previous = JSON.parse(await fs.readFile(receiptFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      check(previous.jobId === jobId && previous.sourceOutput === job.output && previous.snapshotHash === snapshotHash, '已有校准记录与本次任务不一致，需人工核查', 409);
      const verification = await verifyAvSync(mediaPath(previous.file), song, job.snapshot, env);
      return {...previous, path: mediaPath(previous.file), verification, reused: true};
    }
    let file = job.output, verification, realigned = false;
    try { verification = await verifyAvSync(source, song, job.snapshot, env); }
    catch {
      // Current running jobs may still hold the previous assembler in memory. Preserve that output.
      file = randomUUID() + '.mp4';
      await assemble(clips, song, mediaPath(file), job.snapshot, work, undefined, env);
      verification = await verifyAvSync(mediaPath(file), song, job.snapshot, env); realigned = true;
    }
    const receipt = {jobId, sourceOutput: job.output, snapshotHash, file, path: mediaPath(file), video_url: `/media/${file}`, realigned, verifiedAt: new Date().toISOString(), verification};
    await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2), {flag: 'wx', mode: 0o600});
    return receipt;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
