import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {check, AppError} from './core.mjs';

export function run(binary, args, {signal, maxBytes = 12 * 1024 * 1024, timeout = 180000} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let size = 0, stderr = '', ended = false; const chunks = [];
    const stop = () => { child.kill(); finish(new AppError('媒体处理已停止或超时', 499)); };
    const timer = setTimeout(stop, timeout);
    function finish(error, value) { if (ended) return; ended = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); error ? reject(error) : resolve(value); }
    signal?.addEventListener('abort', stop, {once: true}); if (signal?.aborted) return stop();
    child.stdout.on('data', data => { size += data.length; if (size > maxBytes) stop(); else chunks.push(data); });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-3000); });
    child.on('error', () => finish(new AppError(`无法启动 ${path.basename(binary)}，请检查 FFmpeg 安装配置`, 500)));
    child.on('close', code => finish(code === 0 ? null : new AppError(`媒体处理失败：${stderr.slice(-500)}`, 422), Buffer.concat(chunks)));
  });
}
export const binaries = (env = process.env) => ({ffmpeg: env.FFMPEG_PATH || 'ffmpeg', ffprobe: env.FFPROBE_PATH || 'ffprobe'});
export async function probe(file, env = process.env) {
  const raw = await run(binaries(env).ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file]);
  return JSON.parse(raw.toString());
}
export async function analyzeAudio(file, env = process.env) {
  const metadata = await probe(file, env), duration = Number(metadata.format.duration);
  check(metadata.streams.some(s => s.codec_type === 'audio') && duration >= 1 && duration <= 600, '音频须包含有效音轨且为 1–600 秒');
  const pcm = await run(binaries(env).ffmpeg, ['-nostdin', '-v', 'error', '-i', file, '-t', '600', '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], {maxBytes: 20 * 1024 * 1024});
  const samples = pcm.length / 4, energy = [];
  for (let i = 0; i < samples; i += 400) { let sum = 0, count = 0; for (let j = i; j < Math.min(i + 400, samples); j++) { const x = pcm.readFloatLE(j * 4); sum += x * x; count++; } energy.push(Math.sqrt(sum / count)); }
  const max = Math.max(.0001, ...energy), waveform = [];
  for (let i = 0; i < 160; i++) { const from = Math.floor(i * energy.length / 160), to = Math.max(from + 1, Math.floor((i + 1) * energy.length / 160)); waveform.push(Math.max(0, ...energy.slice(from, to)) / max); }
  const beats = [];
  for (let i = 2; i < energy.length - 2; i++) if (energy[i] > max * .25 && energy[i] > energy[i - 1] * 1.15 && energy[i] >= energy[i + 1] && (!beats.length || i * .05 - beats.at(-1) > .3)) beats.push(+(i * .05).toFixed(2));
  return {duration, waveform, beats, beatMethod: '能量峰值估计，不是人工校准节拍或歌词识别'};
}
export function outputSize(resolution, ratio) {
  const base = {'720p':720, '1080p':1080, '2K':1440}[resolution];
  check(base, '不支持的导出清晰度', 422);
  const [w, h] = ratio.split(':').map(Number);
  return w >= h ? [Math.round(base * w / h / 2) * 2, base] : [base, Math.round(base * h / w / 2) * 2];
}
export async function normalizeClip(input, output, shot, p, signal, env = process.env, expected = {}) {
  const info = await probe(input, env);
  check(info.streams.some(s => s.codec_type === 'video'), '供应商返回文件不含视频轨', 422);
  check(Number(info.format.duration) >= (expected.duration || shot.duration) - .12, '上游返回视频短于申请生成时长，已保留任务 ID，不能静默补帧或重新计费生成', 422);
  const [w, h] = outputSize(p.resolution, p.aspect_ratio);
  await run(binaries(env).ffmpeg, ['-nostdin', '-y', '-v', 'error', '-i', input, '-t', String(shot.duration), '-an', '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', p.resolution === '2K' ? '18M' : p.resolution === '1080p' ? '10M' : '6M', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output], {signal});
  const source = info.streams.find(s => s.codec_type === 'video');
  return {duration: Number(info.format.duration), width: source.width, height: source.height, upscaled: source.width < w || source.height < h};
}
export async function assemble(clips, audio, output, p, workDir, signal, env = process.env) {
  const list = path.join(workDir, 'concat.txt');
  // All clip paths are generated IDs inside this application's data directory.
  await fs.writeFile(list, clips.map(file => `file '${file.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'));
  // Re-encode the final cut: stream-copy can retain reordered frames beyond a fractional song end.
  await run(binaries(env).ffmpeg, ['-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-vf', 'setpts=PTS-STARTPTS,fps=30', '-af', 'asetpts=PTS-STARTPTS', '-t', String(p.audio.duration), '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', p.resolution === '2K' ? '18M' : p.resolution === '1080p' ? '10M' : '6M', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output], {signal, timeout: 1800000});
  const info = await probe(output, env), [w, h] = outputSize(p.resolution, p.aspect_ratio), video = info.streams.find(s => s.codec_type === 'video');
  const audioStream = info.streams.find(s => s.codec_type === 'audio'), frame = 1 / 30 + .001;
  check(video?.codec_name === 'h264' && video.width === w && video.height === h && audioStream?.codec_name === 'aac' && info.streams.length === 2 && [video, audioStream].every(s => Math.abs(Number(s.start_time)) <= frame && Math.abs(Number(s.duration) - p.audio.duration) <= frame) && Math.abs(Number(video.duration) - Number(audioStream.duration)) <= frame && Math.abs(Number(info.format.duration) - p.audio.duration) <= frame, '导出验收失败：分辨率、双轨起点或总时长不匹配', 500);
  return {duration: Number(info.format.duration), width: w, height: h, videoCodec: 'h264', audioCodec: 'aac', fps: 30};
}
export function privateAddress(ip) {
  const s = ip.toLowerCase();
  if (s.includes(':')) return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || /^fe[89ab]/.test(s) || s.startsWith('ff') || s.startsWith('::ffff:');
  const p = s.split('.').map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 198 && [18, 19].includes(p[1]));
}
export async function downloadVideo(url, output, signal, redirects = 0) {
  const target = new URL(url);
  check(target.protocol === 'https:' && !target.username && !target.password && redirects <= 3 && (!target.port || target.port === '443'), '供应商产物地址不安全', 422);
  const response = await new Promise((resolve, reject) => {
    const request = https.get(target, {signal, timeout: 120000, lookup(host, options, callback) {
      dns.lookup(host, {...options, all: true}, (error, records) => {
        if (error) return callback(error);
        if (!records.length || records.some(r => privateAddress(r.address))) return callback(new Error('Blocked private address'));
        if (options.all) callback(null, records); else callback(null, records[0].address, records[0].family);
      });
    }}, resolve);
    request.on('timeout', () => request.destroy(new Error('Download timeout'))); request.on('error', () => reject(new AppError('产物下载失败或地址不可访问', 502)));
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) { response.resume(); return downloadVideo(new URL(response.headers.location, target).href, output, signal, redirects + 1); }
  check(response.statusCode === 200, `产物下载返回 HTTP ${response.statusCode}`, 502);
  let bytes = 0;
  const limit = new Transform({transform(chunk, _, callback) { bytes += chunk.length; callback(bytes > 300 * 1024 * 1024 ? new Error('Video exceeds 300MB') : null, chunk); }});
  await pipeline(response, limit, createWriteStream(output), {signal});
}
