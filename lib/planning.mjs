import {check, parseLyrics} from './core.mjs';

export function planningContext(project) {
  const duration = project.audio.duration;
  check(Number.isFinite(duration) && duration >= 1 && duration <= 600, '音频时长超出范围');
  const maxDuration = Math.min(15, project.generationDuration ?? 15);
  check(Number.isInteger(maxDuration) && maxDuration >= 2, '每镜生成时长无效');
  const total = maxDuration === 2 ? Math.max(2, Math.ceil(duration / 2) * 2) : Math.max(2, Math.ceil(duration));
  const lyrics = parseLyrics(project.lyrics, duration);
  const cues = lyrics.lines.map((line, i) => ({
    index: i, start: line.start, end: line.end ?? lyrics.lines[i + 1]?.start ?? duration, text: line.text,
  }));
  return {duration, total, maxDuration, minShots: Math.ceil(total / maxDuration), maxShots: Math.min(300, Math.floor(total / 2)),
    lyricMode: lyrics.mode, cues, beats: (project.audio.beats || []).filter(b => Number.isFinite(b) && b >= 0 && b <= duration)};
}

export function lyricsForInterval(context, start, end) {
  return context.cues.filter(c => c.start < end && c.end > start).map(c => c.text).join(' / ') || '无歌词标注（前奏 / 间奏 / 尾奏）';
}

// Preserve the director's scene count/order. Adjust only cut lengths, not narrative content.
// At most 300 * 601 * 14 transitions for a ten-minute song; no network retry is involved.
export function alignSceneDurations(suggestions, context) {
  const {total, maxDuration, minShots, maxShots} = context;
  check(Array.isArray(suggestions) && suggestions.length >= minShots && suggestions.length <= maxShots,
    `LLM 返回 ${suggestions?.length ?? 0} 镜，无法以每镜 2–${maxDuration} 秒覆盖 ${context.duration} 秒歌曲；可行范围为 ${minShots}–${maxShots} 镜，原分镜已保留`, 502);
  check(suggestions.every(n => Number.isFinite(n) && n > 0 && n <= maxDuration), `LLM 建议镜长必须大于 0 且不超过 ${maxDuration} 秒，原分镜已保留`, 502);
  const count = suggestions.length, sum = suggestions.reduce((a, b) => a + b, 0);
  const desired = suggestions.map(n => n * total / sum);
  const boundaries = context.lyricMode === 'estimated' ? [] : context.cues.flatMap(c => [c.start, c.end]);
  const distance = (points, end, cap) => points.reduce((best, p) => Math.min(best, Math.abs(p - end)), cap);
  const cutCost = Array.from({length: total + 1}, (_, end) => end === total ? 0
    : (boundaries.length ? .7 * distance(boundaries, end, 2) : 0) + (context.beats.length ? .15 * distance(context.beats, end, 1) : 0));
  let scores = new Float64Array(total + 1).fill(Infinity), targetEnd = 0;
  scores[0] = 0;
  const previous = [];
  for (let i = 0; i < count; i++) {
    targetEnd += desired[i];
    const next = new Float64Array(total + 1).fill(Infinity), lengths = new Uint8Array(total + 1);
    const remaining = count - i - 1;
    const low = Math.max(2 * (i + 1), total - remaining * maxDuration);
    const high = Math.min(maxDuration * (i + 1), total - remaining * 2);
    for (let end = low; end <= high; end++) for (let len = 2; len <= maxDuration && len <= end; len++) {
      const score = scores[end - len] + .4 * (len - desired[i]) ** 2 + .12 * (end - targetEnd) ** 2 + cutCost[end];
      if (score < next[end]) { next[end] = score; lengths[end] = len; }
    }
    previous.push(lengths); scores = next;
  }
  check(Number.isFinite(scores[total]), '无法将 LLM 场景校准到歌曲，请检查分镜时长，原分镜已保留', 502);
  const durations = new Array(count);
  let end = total;
  for (let i = count - 1; i >= 0; i--) { durations[i] = previous[i][end]; end -= durations[i]; }
  return durations;
}
