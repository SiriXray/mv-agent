import {AppError, check, MODEL_DEFS, validPublicUrl} from './core.mjs';
import {AIService} from './ai.mjs';

export class ProviderError extends Error {
  constructor(message, {retryable = false, uncertain = false} = {}) { super(message); this.retryable = retryable; this.uncertain = uncertain; }
}
export function buildRequest(model, {prompt, images = [], sounds = [], duration, resolution, aspect_ratio, mode = 'reference'}) {
  const definition = MODEL_DEFS.find(m => m.id === model);
  check(definition?.implemented, definition?.disabledReason || '该模型的接口协议尚未提供，不能发起调用', 422);
  check(definition.resolutions.includes(resolution), '该模型不支持所选清晰度，禁止静默降清晰度', 422);
  check(definition.modes.includes(mode), '该模型不支持当前输入模式，禁止静默改变图片语义', 422);
  check(Number.isInteger(duration) && duration >= 1 && duration <= definition.maxDuration, '镜头时长超出上游约束', 422);
  check(images.length <= definition.maxImages && sounds.length <= definition.maxSounds, '参考素材数量超出上游约束', 422);
  if (mode === 'i2v') check(images.length === 1 && validPublicUrl(images[0]), '严格首帧图生需要且仅需要一张公网 HTTPS 图片', 422);
  if (model === 'vidu-q4') return {
    url: 'https://api.vidu.cn/ent/v2/reference2video',
    body: {model: 'viduq4-preview', prompt, images, ...(sounds.length ? {sounds} : {}), duration: Math.max(3, duration), resolution, aspect_ratio, audio: false, watermark: true},
  };
  if (model === 'wan3') return {
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
    body: {model: 'wan3.0-video', input: {prompt}, parameters: {duration, resolution: resolution.toUpperCase(), ratio: aspect_ratio, watermark: true}},
  };
  if (model === 'wan21-i2v') return {
    url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
    body: {model: 'wanx2.1-i2v-plus', input: {prompt, img_url: images[0]}, parameters: {resolution: '720P', duration: 5}},
  };
  if (model === 'minimax-h3') return {
    url: 'https://api.minimaxi.com/v2/video_generation',
    body: {model: 'MiniMax-H3', content: [{type: 'text', text: prompt}, ...images.map(url => ({type: 'image_url', image_url: {url}, role: 'reference_image'})), ...sounds.map(url => ({type: 'audio_url', audio_url: {url}, role: 'reference_audio'}))], duration: Math.max(4, duration), resolution: '2K', ratio: aspect_ratio},
  };
  throw new AppError('该模型的接口协议尚未提供，不能发起调用', 422);
}
export function normalizeResponse(model, body) {
  if (model === 'vidu-q4') return {state: ({created: 'pending', queueing: 'pending', processing: 'running', success: 'succeeded', failed: 'failed'})[body.state] || 'unknown', url: body.creations?.[0]?.watermarked_url || body.creations?.[0]?.url, usage: {credits: body.credits ?? null}};
  if (['wan3', 'wan21-i2v'].includes(model)) return {state: ({PENDING: 'pending', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'failed', UNKNOWN: 'unknown'})[body.output?.task_status] || 'unknown', url: body.output?.video_url, usage: body.usage || body.output?.usage || null};
  if (model === 'minimax-h3') return {state: ({succeeded: 'succeeded', failed: 'failed', cancelled: 'failed', expired: 'failed', pending: 'pending', processing: 'running', running: 'running', queued: 'pending'})[body.task?.status] || 'unknown', url: body.task?.content?.url, usage: body.usage || null};
  throw new AppError('未实现的供应商', 422);
}
export function createProviders({env = process.env, fetchImpl = fetch, timeout = 60000, createTimeout = 180000} = {}) {
  function key(model) {
    const definition = MODEL_DEFS.find(m => m.id === model);
    check(definition?.implemented, '模型协议未完整配置，不允许请求', 422);
    return env[definition.env] || (definition.fallbackEnv && env[definition.fallbackEnv]);
  }
  function headers(model) {
    const secret = key(model); check(secret, '该供应商未配置服务端密钥', 422);
    return {'Content-Type': 'application/json', Authorization: `${model === 'vidu-q4' ? 'Token' : 'Bearer'} ${secret}`, ...(['wan3', 'wan21-i2v'].includes(model) ? {'X-DashScope-Async': 'enable'} : {})};
  }
  async function request(model, url, options, signal, creating = false) {
    let response;
    const deadline = creating ? createTimeout : timeout;
    try { response = await fetchImpl(url, {...options, headers: headers(model), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(deadline)]) : AbortSignal.timeout(deadline)}); }
    catch { throw new ProviderError(`${model} 网络中断或请求超时${creating ? '，任务可能已受理，禁止自动重复提交' : ''}`, {uncertain: creating, retryable: !creating}); }
    if (!response.ok) throw new ProviderError(`${model} 返回 HTTP ${response.status}`, {retryable: response.status === 429 || (!creating && response.status >= 500), uncertain: creating && response.status >= 500});
    let body;
    try { body = await response.json(); } catch { throw new ProviderError(`${model} 返回非 JSON 响应`, {uncertain: creating}); }
    if (body.error || (body.base_resp?.status_code && body.base_resp.status_code !== 0)) throw new ProviderError(`${model} 拒绝请求，请核查模型权限、参数或额度`);
    return body;
  }
  return {
    async create(model, input, signal) {
      const {url, body} = buildRequest(model, input);
      const encoded = JSON.stringify(body);
      check(Buffer.byteLength(encoded) < 20 * 1024 * 1024, '上游请求体超过 20MB，请缩小参考图片', 422);
      const result = await request(model, url, {method: 'POST', body: encoded}, signal, true);
      const id = ['wan3', 'wan21-i2v'].includes(model) ? result.output?.task_id : result.task_id;
      if (!id || typeof id !== 'string') throw new ProviderError('创建响应缺少 task_id，任务是否受理不确定，请人工核查', {uncertain: true});
      return {id};
    },
    async poll(model, id, signal) {
      const encoded = encodeURIComponent(id);
      const url = model === 'vidu-q4' ? `https://api.vidu.cn/ent/v2/tasks/${encoded}/creations` : ['wan3', 'wan21-i2v'].includes(model) ? `https://dashscope.aliyuncs.com/api/v1/tasks/${encoded}` : `https://api.minimaxi.com/v2/query/video_generation/${encoded}`;
      return normalizeResponse(model, await request(model, url, {method: 'GET'}, signal));
    },
  };
}
export async function llmPlan(p, env = process.env, fetchImpl = fetch) {
  const config = {url: env.PLANNER_URL || '', model: env.PLANNER_MODEL || '', protocol: env.PLANNER_PROTOCOL || 'chat', apiKey: env.PLANNER_API_KEY || ''};
  return new AIService({get: () => config}, {env, fetchImpl}).plan(p);
}
