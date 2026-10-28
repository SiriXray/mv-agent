import fs from 'node:fs/promises';
import path from 'node:path';

// Read receipts only; never trigger exports or trust a receipt-supplied filesystem path.
export async function listJobExports(store, job) {
  const result = [], work = path.join(store.work, job.id);
  async function add(file, kind) {
    let r;
    try { r = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (r.jobId !== job.id || !/^[a-f0-9-]{36}\.mp4$/.test(r.file || '')) return;
    try { await fs.access(store.mediaPath(r.file)); } catch { return; }
    if (r.verification?.originalSongMatched !== true) return;
    result.push({kind, file: r.file, video_url: `/media/${r.file}`, verifiedAt: r.verifiedAt,
      successfulShots: r.successfulShots ?? job.shots.filter(s => s.state === 'succeeded').length,
      totalShots: r.totalShots ?? job.shots.length, gaps: (r.gaps || []).map(({shot,start,end,duration}) => ({shot,start,end,duration})),
      duration: job.snapshot.audio.duration, resolution: job.snapshot.resolution, aspect_ratio: job.snapshot.aspect_ratio});
  }
  await add(path.join(work, 'av-aligned.json'), 'aligned');
  let dirs = [];
  try { dirs = await fs.readdir(path.join(work, 'gap-draft'), {withFileTypes: true}); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const dir of dirs.filter(d => d.isDirectory() && /^[a-f0-9]{64}$/.test(d.name))) await add(path.join(work, 'gap-draft', dir.name, 'receipt.json'), 'gap-draft');
  return result.sort((a,b) => (b.verifiedAt || '').localeCompare(a.verifiedAt || ''));
}
