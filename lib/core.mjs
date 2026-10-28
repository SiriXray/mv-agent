export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}
export function check(condition, message, status = 400) { if (!condition) throw new AppError(message, status); }
export const MODEL_DEFS = [
  {id: 'vidu-q4', name: 'Vidu Q4 Preview（旧参考生）', model: 'viduq4-preview', modes: ['reference'], resolutions: ['720p','1080p','2K'], minDuration: 3, maxDuration: 16, maxImages: 15, maxSounds: 3, localImages: true, source: '附件2，独立旧版本', env: 'VIDU_PREVIEW_API_KEY', fallbackEnv: 'VIDU_API_KEY', implemented: true, note: '保留旧协议和旧密钥；与新 viduq4 的 T2V / I2V 区分'},
  {id: 'wan3', name: 'Wan 3.0 · 文生视频', model: 'wan3.0-video', modes: ['t2v'], resolutions: ['720p','1080p'], minDuration: 2, maxDuration: 30, maxImages: 0, maxSounds: 0, source: '用户更新协议', env: 'DASHSCOPE_API_KEY', fallbackEnv: 'WAN_API_KEY', implemented: true, note: '仅 T2V，不接收参考图；不会将 I2V / Ref 静默降为文生视频'},
  {id: 'wan21-i2v', name: 'Wan 2.1 Plus · 首帧图生', model: 'wanx2.1-i2v-plus', modes: ['i2v'], resolutions: ['720p','1080p'], minDuration: 5, maxDuration: 5, maxImages: 1, maxSounds: 0, upstreamResolution: '720P', source: '用户接口与阿里云官方参数约束', env: 'DASHSCOPE_API_KEY', fallbackEnv: 'WAN_API_KEY', implemented: true, note: '严格单首帧 · 固定 5 秒 / 720P · 公网 HTTPS 图片；不使用 15 秒和 size 参数'},
  {id: 'minimax-h3', name: 'MiniMax H3', model: 'MiniMax-H3', modes: ['reference'], resolutions: ['720p','1080p','2K'], minDuration: 4, maxDuration: 15, maxImages: 9, maxSounds: 3, source: '附件3', env: 'MINIMAX_KEY', implemented: true, note: '上游固定 2K；可选导出 720p / 1080p / 2K'},
  {id: 'vidu-q4-standard', name: 'Vidu Q4', model: 'viduq4', modes: ['t2v', 'i2v'], minDuration: null, maxDuration: null, maxImages: 1, maxSounds: 0, source: '用户更新协议', env: 'VIDU_API_KEY', implemented: false, disabledReason: '密钥单独保存；完整时长 / 分辨率范围待确认，不进入生成流程', note: 'T2V / 严格首帧 I2V；不支持 Ref / V2V；不是 viduq4-preview'},
  {id: 'vidu-q31-ad', name: 'Vidu Q3.1 AD', model: 'viduq3.1-ad', modes: ['t2v', 'i2v', 'reference', 'v2v'], minDuration: null, maxDuration: null, maxImages: null, maxSounds: 0, source: '用户更新协议', env: 'VIDU_API_KEY', implemented: false, disabledReason: '完整时长 / 分辨率 / 参考数量限制待确认，不进入生成流程', note: '协议待补；共用新 Vidu 密钥'},
  {id: 'seedance-mini', name: 'Seedance 2.0 Mini · 自建代理', model: 'doubao-seedance-2-0-mini-260615', modes: ['i2v', 'reference', 'v2v'], minDuration: null, maxDuration: null, maxImages: null, maxSounds: 0, source: '用户自建代理协议', env: 'SEEDANCE_API_KEY', implemented: false, disabledReason: '代理为公网 HTTP，且缺少返回字段协议；仅保存配置，不发送密钥或生成请求', note: 'POST /v1/videos · GET /v1/videos/{task_id}；不属于 Wan'},
];
export const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4'];
export const STRATEGIES = ['priority', 'manual', 'cost', 'latency'];
export function catalog(env = process.env, metrics = {}) {
  return MODEL_DEFS.map(({env: key, fallbackEnv, ...m}) => {
    const credentialConfigured = !!(env[key] || (fallbackEnv && env[fallbackEnv]));
    return {...m, credentialConfigured, configured: m.implemented && credentialConfigured, credentialEnv: key, metrics: metrics[m.id] || {costPerSecond: null, latencySeconds: null}};
  });
}
export function validPublicUrl(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(u.hostname) && u.hostname.includes('.'); }
  catch { return false; }
}
export function defaults(input = {}) {
  const result = {
    title: input.title || '未命名 MV', lyrics: input.lyrics || '', style: input.style || '真实世界画面，电影感', prompt: input.prompt || '',
    quality: input.quality ?? 'standard', resolution: input.resolution || '2K', generationDuration: input.generationDuration ?? 15, aspect_ratio: input.aspect_ratio || '16:9',
    planner: input.planner || 'template', generationMode: input.generationMode || 'reference', audio: input.audio || null, assets: input.assets || [], sounds: input.sounds || [],
    routing: {strategy: 'priority', model: 'vidu-q4', allowFallback: true, maxAttempts: 2, concurrency: 2, ...(input.routing || {})},
  };
  check(['standard', 'high'].includes(result.quality), 'quality 只能为 standard 或 high');
  check(['720p', '1080p', '2K'].includes(result.resolution), '导出分辨率仅支持 720p / 1080p / 2K');
  check(Number.isInteger(result.generationDuration) && result.generationDuration >= 2 && result.generationDuration <= 30, '每镜生成时长必须为 2–30 秒整数');
  check(RATIOS.includes(result.aspect_ratio), '不支持的画幅');
  check(['template', 'llm'].includes(result.planner), '请选择模板规划或已配置的 LLM 规划');
  check(['reference', 'i2v', 't2v'].includes(result.generationMode), 'MV 模式仅支持多图参考、严格首帧图生或文生视频');
  check(STRATEGIES.includes(result.routing.strategy), '未知路由策略');
  check(MODEL_DEFS.some(m => m.id === result.routing.model), '未知模型');
  check(typeof result.routing.allowFallback === 'boolean', '降级开关必须是布尔值');
  check(Number.isInteger(result.routing.maxAttempts) && result.routing.maxAttempts >= 1 && result.routing.maxAttempts <= 3, '重试总次数应为 1–3');
  check(Number.isInteger(result.routing.concurrency) && result.routing.concurrency >= 1 && result.routing.concurrency <= 5, '并发应为 1–5');
  for (const key of ['title', 'lyrics', 'style', 'prompt']) check(typeof result[key] === 'string' && result[key].length <= (key === 'lyrics' ? 30000 : key === 'prompt' ? 12000 : 500), `${key} 类型或长度不正确`);
  check(Array.isArray(result.assets) && result.assets.length <= 15, '资产最多 15 个');
  check(Array.isArray(result.sounds) && result.sounds.length <= 3, '参考音频最多 3 个');
  return result;
}
export function validateInputs(p) {
  defaults(p);
  check(p.audio && Number.isFinite(p.audio.duration) && p.audio.duration >= 1 && p.audio.duration <= 600, '请上传 1–600 秒歌曲音频');
  check(p.assets.length > 0, '至少上传一个参考资产');
  const ids = new Set();
  for (const a of p.assets) {
    check(typeof a.asset_id === 'string' && !ids.has(a.asset_id), '资产 ID 缺失或重复'); ids.add(a.asset_id);
    check(typeof a.asset_name === 'string' && a.asset_name.trim() && a.asset_name.length <= 100, '请填写资产名称');
    check(typeof a.asset_description === 'string' && a.asset_description.trim().length >= 4 && a.asset_description.length <= 1500, '请先完成图片自动识别；视觉描述需为 4–1500 字，可在高级选项中调整');
    check(a.file, '资产缺少图片');
    if (a.remoteUrl) check(validPublicUrl(a.remoteUrl), '参考图公网地址必须是有效 HTTPS URL');
  }
}
export function parseLyrics(text, duration) {
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (text.includes('-->')) {
    const stamp = '(?:(\\d{1,3}):)?(\\d{2}):(\\d{2})[,.](\\d{1,3})';
    const range = new RegExp(`^\\s*${stamp}\\s*-->\\s*${stamp}(?:\\s+.*)?$`);
    const cues = [];
    const seconds = parts => Number(parts[0] || 0) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) + Number(parts[3].padEnd(3, '0')) / 1000;
    for (let i = 0; i < rows.length; i++) if (rows[i].includes('-->')) {
      const m = rows[i].match(range);
      check(m && [m[2], m[3], m[6], m[7]].every(v => Number(v) < 60), `歌词第 ${i + 1} 行字幕时间格式无效，请使用 SRT / VTT 时间区间`);
      const start = seconds(m.slice(1, 5)), end = seconds(m.slice(5, 9));
      check(end > start && (!cues.length || start >= cues.at(-1).start), `歌词第 ${i + 1} 行字幕时间倒序或结束不晚于开始`);
      cues.push({start, end, row: i});
    }
    const lines = cues.map((cue, i) => {
      let content = rows.slice(cue.row + 1, cues[i + 1]?.row ?? rows.length);
      // SRT / VTT cue text ends at the blank separator, before the next identifier or NOTE block.
      const separator = content.findIndex(s => !s.trim());
      if (separator >= 0) content = content.slice(0, separator);
      else if (i + 1 < cues.length && /^\d+$/.test(rows[cues[0].row - 1]?.trim() || '') && /^\d+$/.test(content.at(-1)?.trim() || '')) content.pop();
      return {start: cue.start, end: Math.min(duration, cue.end), text: content.map(s => s.trim()).filter(Boolean).join(' ')};
    }).filter(cue => cue.start < duration && cue.text);
    check(lines.length, '字幕没有落在歌曲时长内的有效歌词，请检查时间轴');
    return {mode: /^WEBVTT\b/m.test(text.trim()) ? 'vtt' : 'srt', lines};
  }
  const timed = [];
  for (const line of rows) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const tag of tags) {
      const start = Number(tag[1]) * 60 + Number(tag[2]);
      if (start >= 0 && start < duration && content) timed.push({start, text: content});
    }
  }
  if (timed.length) {
    const lines = [];
    for (const line of timed.sort((a, b) => a.start - b.start)) {
      if (lines.at(-1)?.start === line.start) lines.at(-1).text += ' / ' + line.text;
      else lines.push(line);
    }
    return {mode: 'lrc', lines};
  }
  const plain = rows.filter(x => x.trim() && !/^\[[a-z]+:/i.test(x));
  return {mode: plain.length ? 'estimated' : 'instrumental', lines: plain.map((text, i) => ({start: i * duration / plain.length, text: text.trim()}))};
}
export function allocateDurations(duration, beats = [], lyricBoundaries = []) {
  check(Number.isFinite(duration) && duration >= 1 && duration <= 600, '音频时长超出范围');
  const total = Math.max(2, Math.ceil(duration));
  const scores = new Array(total + 1).fill(Infinity), previous = new Array(total + 1);
  scores[0] = 0;
  for (let end = 2; end <= total; end++) for (let len = 2; len <= 8 && len <= end; len++) {
    const beatDistance = beats.length && end < total ? Math.min(1, ...beats.map(b => Math.abs(b - end))) : 0;
    const lyricDistance = lyricBoundaries.length && end < total ? Math.min(1, ...lyricBoundaries.map(b => Math.abs(b - end))) : 0;
    const value = scores[end - len] + .25 + Math.abs(len - 5) * .3 + beatDistance * .4 + lyricDistance * .5;
    if (value < scores[end]) { scores[end] = value; previous[end] = len; }
  }
  const durations = []; let end = total;
  while (end > 0) { const n = previous[end]; check(n, '无法分配分镜时长'); durations.unshift(n); end -= n; }
  return durations;
}
export function templatePlan(p) {
  validateInputs(p);
  const lyrics = parseLyrics(p.lyrics, p.audio.duration);
  const shots = allocateDurations(p.audio.duration, p.audio.beats || [], ['lrc', 'srt', 'vtt'].includes(lyrics.mode) ? lyrics.lines.flatMap(l => [l.start, l.end].filter(Number.isFinite)) : []);
  const visual = p.assets.map(a => `${a.asset_name}（${a.asset_description}）`).join('；');
  const moves = ['远景，缓慢推进，侧逆光建立环境与主体关系', '中景，横向跟拍，主体沿场景前行，延续上一镜动作', '近景，轻微环绕，目光与手部动作呼应歌词', '全景，低机位移动，光影变化推进叙事', '特写，缓慢拉远，让动作自然收束'];
  let start = 0;
  const storyboards = shots.map((duration, id) => {
    const end = start + duration;
    const current = lyrics.lines.filter((line, i) => line.start < end && (line.end ?? lyrics.lines[i + 1]?.start ?? p.audio.duration) > start);
    const lyric = current.map(x => x.text).join(' / ') || (start === 0 ? '前奏' : '间奏');
    const shot = {id, duration, start, lyric_text: lyric, assets: p.assets.map(a => a.asset_id), prompt: `${p.style}。${moves[id % moves.length]}。${visual}。故事设定：${p.prompt || '跟随音乐展现主体的情绪变化'}。本镜歌词意象：${lyric}。保持人物服装、面貌和环境色调一致。`};
    start = end; return shot;
  });
  const d = p.audio.duration;
  return {COT: `【故事主线】${p.prompt || '在音乐中跟随主角，从环境建立到情绪展开，最后收束。'}\n【叙事阶段】开篇(0s-${(d * .2).toFixed(1)}s) / 发展(${(d * .2).toFixed(1)}s-${(d * .55).toFixed(1)}s) / 高潮(${(d * .55).toFixed(1)}s-${(d * .8).toFixed(1)}s) / 收束(${(d * .8).toFixed(1)}s-${d.toFixed(1)}s)\n【场景规划】围绕已上传资产描述建立连续空间；需创作者审核。\n【分镜衔接预设】${storyboards.slice(1).map((_, i) => `镜头${i}→${i + 1}：延续动作，调整景别`).join(' / ')}`, storyboards, planner: 'template', lyricMode: lyrics.mode, warnings: ['当前是规则模板草案，不是 LLM 创作结果。', ...(lyrics.mode === 'estimated' ? ['纯文本歌词采用均分估时，不是语音识别；请上传 LRC 或人工检查。'] : [])]};
}
export function validatePlan(plan, p) {
  check(plan && typeof plan.COT === 'string' && plan.COT.length <= 30000, '缺少创作概要 COT');
  check(Array.isArray(plan.storyboards) && plan.storyboards.length > 0 && plan.storyboards.length <= 300, '分镜列表不能为空，最多 300 镜');
  let total = 0;
  check(plan.timingVersion == null || [1, 2].includes(plan.timingVersion), '不支持的分镜时间版本');
  const maxDuration = plan.timingVersion === 2 ? Math.min(15, p.generationDuration ?? 15) : 8;
  const ids = new Set(p.assets.map(a => a.asset_id));
  const storyboards = plan.storyboards.map((s, i) => {
    check(s.id === i, '分镜编号必须从 0 顺序排列');
    check(Number.isInteger(s.duration) && s.duration >= 2 && s.duration <= maxDuration, `镜头 ${i + 1} 时长必须为 2–${maxDuration} 秒整数`);
    check(typeof s.prompt === 'string' && s.prompt.startsWith(p.style) && s.prompt.length <= 20000, `镜头 ${i + 1} 提示词必须以统一风格开头，且不超过 20000 字符`);
    check(typeof s.lyric_text === 'string' && s.lyric_text.length <= 10000, '歌词字段无效');
    check(Array.isArray(s.assets) && s.assets.length >= 1 && new Set(s.assets).size === s.assets.length && s.assets.every(id => ids.has(id)), `镜头 ${i + 1} 引用了无效或重复资产`);
    for (const id of s.assets) check(s.prompt.includes(p.assets.find(a => a.asset_id === id).asset_description), `镜头 ${i + 1} 必须展开引用资产的完整视觉描述`);
    const result = {id: i, start: total, duration: s.duration, prompt: s.prompt, lyric_text: s.lyric_text, assets: [...s.assets]}; total += s.duration; return result;
  });
  check(total >= p.audio.duration && total <= p.audio.duration + 2, `分镜总时长 ${total}s 应在 ${p.audio.duration.toFixed(2)}–${(p.audio.duration + 2).toFixed(2)}s`);
  return {...plan, storyboards};
}
export function routeShot(p, shot, models, execution = 'live') {
  check(execution === 'live', '仅支持真实模型路由，演示模式已移除', 422);
  const requested = p.routing.model;
  const notes = [], rejected = [], mode = p.generationMode || 'reference';
  const imageCount = mode === 't2v' ? 0 : shot.assets.length;
  const requestedDuration = Math.max(shot.duration, p.generationDuration ?? 15);
  if (mode === 't2v') notes.push('已明确选择文生视频：不发送参考图片，不提供视觉主体一致性保证');
  const pool = models.filter(m => {
    let why = !m.implemented ? (m.disabledReason || '接口未提供') : !m.modes.includes(mode) ? `不支持当前 ${mode} 模式，禁止更改输入语义降级` : mode === 'i2v' && imageCount !== 1 ? '严格首帧 I2V 每镜必须且只能选择 1 张图片' : execution === 'live' && !m.configured ? '未配置服务端密钥' : imageCount > m.maxImages ? `最多 ${m.maxImages} 张参考图` : !m.resolutions.includes(p.resolution) ? `不支持所选 ${p.resolution} 清晰度，禁止静默降清晰度` : requestedDuration > m.maxDuration ? `上游最多 ${m.maxDuration} 秒，不支持每镜生成 ${requestedDuration} 秒` : p.sounds.length > m.maxSounds ? '该适配器不支持当前参考音频数量' : null;
    if (!why && m.id === 'minimax-h3' && p.sounds.reduce((n, a) => n + a.duration, 0) > 15) why = 'H3 参考音频总长不能超过 15 秒';
    if (!why && mode !== 't2v' && execution === 'live' && !m.localImages && shot.assets.some(id => !validPublicUrl(p.assets.find(a => a.asset_id === id)?.remoteUrl))) why = '需要每张参考图的公网 HTTPS 地址';
    if (!why && execution === 'live' && m.id === 'minimax-h3' && p.sounds.some(a => !validPublicUrl(a.remoteUrl))) why = 'H3 参考音频需要公网 HTTPS 地址';
    if (why) rejected.push({model: m.id, reason: why});
    return !why;
  });
  let order;
  if (['priority', 'manual'].includes(p.routing.strategy)) {
    order = [requested, ...(p.routing.allowFallback ? MODEL_DEFS.filter(m => m.implemented && m.id !== requested).map(m => m.id) : [])];
    if (p.routing.strategy === 'manual' && !pool.some(m => m.id === requested)) { order = []; notes.push('手动指定模型未就绪，不在提交前自动替换'); }
  }
  else {
    const field = p.routing.strategy === 'cost' ? 'costPerSecond' : 'latencySeconds';
    order = pool.filter(m => Number.isFinite(m.metrics?.[field])).sort((a, b) => {
      const av = a.metrics[field] * (field === 'costPerSecond' ? Math.max(requestedDuration, a.minDuration) : 1);
      const bv = b.metrics[field] * (field === 'costPerSecond' ? Math.max(requestedDuration, b.minDuration) : 1);
      return av - bv || a.id.localeCompare(b.id);
    }).map(m => m.id);
    if (!order.length) notes.push(`未配置${field === 'costPerSecond' ? '同口径成本' : '实测时延'}，不做虚构排名；请选择“首选模型”策略或填写实测数据`);
    if (!p.routing.allowFallback) order = order.slice(0, 1);
  }
  const candidates = order.map(id => pool.find(m => m.id === id)).filter(Boolean).map(m => ({model: m.id, name: m.name, mode, generationDuration: Math.max(requestedDuration, m.minDuration), trimDuration: shot.duration, ...(m.upstreamResolution ? {upstreamResolution: m.upstreamResolution} : {}), estimatedCost: Number.isFinite(m.metrics?.costPerSecond) ? +(Math.max(requestedDuration, m.minDuration) * m.metrics.costPerSecond).toFixed(4) : null}));
  const chosen = candidates[0];
  if (chosen && chosen.model !== requested && ['priority', 'manual'].includes(p.routing.strategy)) notes.push(`首选 ${requested} 不满足条件，改用 ${chosen.name}`);
  if (chosen && chosen.generationDuration > shot.duration) notes.push(`上游生成 ${chosen.generationDuration}s，组装时裁切至 ${shot.duration}s`);
  if (chosen?.upstreamResolution === '720P' && p.resolution === '1080p') notes.push('上游只有原生 720P；1080p 导出是本地放大，不是模型原生 1080P');
  return {shotId: shot.id, requested, candidates, rejected, notes, chosen: chosen || null, effectiveQuality: 'model-selected'};
}
export function priceDisclosure(p) {
  return {quotedCredits: null, chargedCredits: 0, billingEnabled: false, note: '已按最新要求移除旧 MIX 档位和 24/29 积分规则。MV 按实际所选模型调用；不做本地积分扣费。供应商实调用可能产生费用。'};
}
