import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {check} from './core.mjs';
import {assemble, binaries, outputSize, probe, run} from './media.mjs';
import {verifyAvSync} from './av-sync.mjs';

const tolerance = 1 / 30 + .001;
const mediaPath = (dataDir, file) => {
  check(/^[a-f0-9-]{36}\.(mp4|mp3|wav|m4a|flac|ogg)$/.test(file), '媒体路径无效');
  return path.resolve(dataDir, 'media', file);
};
const timestamp = seconds => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};

export function buildGapTimeline(job) {
  check(job && ['needs_attention', 'failed', 'paused', 'succeeded'].includes(job.status), '任务仍在运行或已取消，不能导出留空版', 409);
  const plan = job.snapshot?.plan?.storyboards, songDuration = job.snapshot?.audio?.duration;
  check(Array.isArray(plan) && plan.length && Array.isArray(job.shots) && job.shots.length === plan.length, '分镜记录不完整');
  check(Number.isFinite(songDuration) && songDuration >= 1 && songDuration <= 600, '原曲时长无效');
  const shots = new Map(job.shots.map(s => [s.id, s]));
  check(shots.size === plan.length && new Set(plan.map(s => s.id)).size === plan.length, '镜头 ID 重复');
  let cursor = 0;
  const timeline = plan.map((storyboard, index) => {
    const shot = shots.get(storyboard.id), duration = storyboard.duration;
    check(shot && Number.isFinite(duration) && duration > 0 && duration <= 15 && Number.isFinite(storyboard.start) && Math.abs(storyboard.start - cursor) < .001, '分镜时间轴不连续或镜长无效');
    check(Math.abs(duration * 30 - Math.round(duration * 30)) < .001, '镜长必须对齐 30 fps 帧边界');
    check(cursor < songDuration, '存在整镜超出原曲范围');
    const entry = {shot: index + 1, id: storyboard.id, start: cursor, end: Math.min(cursor + duration, songDuration), duration: Math.min(duration, songDuration - cursor), materialDuration: duration,
      blank: shot.state !== 'succeeded', state: shot.state, file: shot.state === 'succeeded' ? shot.output : null,
      reason: shot.error || '', prompt: storyboard.prompt || '', lyrics: storyboard.lyrics || ''};
    check(entry.blank || entry.file, '成功镜头缺少产物记录，不能静默留空');
    cursor += duration;
    return entry;
  });
  check(cursor >= songDuration && cursor - songDuration <= 2, '分镜总长不能覆盖原曲或超出过多');
  return timeline;
}

// Opt-in draft export only: never marks an incomplete generation job as succeeded.
export async function exportGapDraft(dataDir, jobId, {allowGaps = false, env = process.env} = {}) {
  check(allowGaps === true, '留空版导出需要显式 --allow-gaps，不是完整成片', 409);
  check(/^[a-f0-9-]{36}$/.test(jobId), '任务 ID 无效');
  const db = JSON.parse(await fs.readFile(path.join(dataDir, 'store.json'), 'utf8')), job = db.jobs[jobId];
  const timeline = buildGapTimeline(job), project = job.snapshot, song = mediaPath(dataDir, project.audio.file);
  const fingerprint = createHash('sha256').update(JSON.stringify({exportVersion: 2, snapshot: project, timeline})).digest('hex');
  const work = path.resolve(dataDir, 'work', jobId, 'gap-draft', fingerprint), receiptFile = path.join(work, 'receipt.json'), lockFile = path.join(work, 'export.lock');
  await fs.mkdir(work, {recursive: true});
  let lock;
  try { lock = await fs.open(lockFile, 'wx'); } catch (error) { if (error.code === 'EEXIST') check(false, '留空版导出已在运行，不能重复启动', 409); throw error; }
  try {
    let previous;
    try { previous = JSON.parse(await fs.readFile(receiptFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      check(previous.fingerprint === fingerprint, '素材已变化，请先核对已有留空版，不覆盖旧导出', 409);
      const verification = await verifyAvSync(mediaPath(dataDir, previous.file), song, project, env);
      await fs.access(previous.gapList);
      return {...previous, verification, reused: true};
    }
    await fs.access(song);
    const [width, height] = outputSize(project.resolution, project.aspect_ratio), clips = [], blankFiles = new Map();
    const firstMaterial = timeline.find(s => !s.blank);
    const referenceVideo = firstMaterial ? (await probe(mediaPath(dataDir, firstMaterial.file), env)).streams.find(s => s.codec_type === 'video') : undefined;
    const fullRange = referenceVideo?.color_range === 'pc', colorArgs = ['-color_range', fullRange ? 'pc' : 'tv'];
    for (const [field, flag] of [['color_space', '-colorspace'], ['color_transfer', '-color_trc'], ['color_primaries', '-color_primaries']]) {
      if (referenceVideo?.[field] && referenceVideo[field] !== 'unknown') colorArgs.push(flag, referenceVideo[field]);
    }
    for (const entry of timeline) {
      if (entry.blank) {
        if (!blankFiles.has(entry.materialDuration)) {
          const file = path.join(work, `blank-${entry.materialDuration}.mp4`);
          // The concat decoder inherits range metadata: limited-range black becomes gray in a full-range stream.
          await run(binaries(env).ffmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=30`, '-t', String(entry.materialDuration), '-an', '-vf', fullRange ? 'scale=out_range=full,setsar=1' : 'setsar=1', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', fullRange ? 'yuvj420p' : 'yuv420p', ...colorArgs, file]);
          blankFiles.set(entry.materialDuration, file);
        }
        clips.push(blankFiles.get(entry.materialDuration));
      } else {
        const file = mediaPath(dataDir, entry.file), info = await probe(file, env), video = info.streams.find(s => s.codec_type === 'video');
        check(video?.width === width && video.height === height && Math.abs(Number(video.duration) - entry.materialDuration) <= tolerance && Math.abs(Number(video.start_time)) <= tolerance && info.streams.length === 1 && video.codec_name === 'h264', `第 ${entry.shot} 镜素材规格或时长不匹配，停止导出`);
        check((video.color_range === 'pc') === fullRange, `第 ${entry.shot} 镜色彩范围不一致，不能直接拼接`);
        clips.push(file);
      }
    }
    const file = randomUUID() + '.mp4', output = mediaPath(dataDir, file);
    await assemble(clips, song, output, project, work, undefined, env);
    const verification = await verifyAvSync(output, song, project, env), gaps = timeline.filter(s => s.blank);
    const gapList = path.join(work, 'missing-shots.csv');
    const csvCell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [['镜号', '入点（含）', '出点（不含）', '需补秒数', '状态', '原分镜提示词'], ...gaps.map(g => [g.shot, timestamp(g.start), timestamp(g.end), g.duration, g.state, g.prompt])];
    await fs.writeFile(gapList, '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'), {flag: 'wx'});
    const manifest = path.join(work, 'timeline.json');
    await fs.writeFile(manifest, JSON.stringify({kind: 'gap-draft', complete: false, title: project.title, jobId, fps: 30, audio: song, duration: project.audio.duration, timeline}, null, 2), {flag: 'wx'});
    const receipt = {kind: 'gap-draft', complete: false, jobId, fingerprint, file, path: output, video_url: `/media/${file}`, gapList, manifest, originalAudio: song,
      successfulShots: timeline.length - gaps.length, totalShots: timeline.length, gaps, verifiedAt: new Date().toISOString(), verification};
    await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2), {flag: 'wx', mode: 0o600});
    return receipt;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
