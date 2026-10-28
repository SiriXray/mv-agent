import {check, validPublicUrl} from './core.mjs';
import {ProviderError} from './providers.mjs';

export const PRODUCTION_SERVICES = [
  {id: 'short-play', name: 'Vidu 短剧成片', endpoint: '/ent/v1/short-play/tasks', rates: {standard: 28, high: 58}, note: '1080p · 自行规划剧情时长 · 非 MV 卡点链路'},
  {id: 'explain-comic', name: 'Vidu 解说剧成片', endpoint: '/ent/v1/explain-comic/tasks', rates: {standard: 20, high: 25}, note: '720p / 1080p · 旁白与可选字幕 · 非 MV 卡点链路'},
];
export function buildProductionRequest(input, assets) {
  check(['short-play', 'explain-comic'].includes(input.service), '未知成片服务');
  check(['cn', 'global'].includes(input.region), '请选择国内或海外');
  const drama = input.service === 'short-play', global = input.region === 'global';
  check(typeof input.script_name === 'string' && input.script_name.length > 0 && input.script_name.length <= 20, '剧名需为 1–20 字');
  const script = input.script_content;
  check(typeof script === 'string' && script.length >= (drama ? 20 : 50) && script.length <= (drama ? (/\p{Script=Han}/u.test(script) ? 2000 : 5000) : global ? 2000 : 20000), '剧本字数超出该接口范围');
  check(['standard', 'high'].includes(input.quality), '请选择 standard 或 high');
  check(!global || drama || input.quality === 'standard', '海外解说文档未给出 high 参数，不进行推断');
  check(['720p', '1080p'].includes(input.resolution) && (!drama || input.resolution === '1080p'), '短剧成片仅支持 1080p');
  check((drama ? ['16:9', '9:16'] : ['16:9', '9:16', '4:3', '3:4']).includes(input.aspect_ratio), '成片服务不支持该画幅');
  check(typeof input.style === 'string' && input.style.length > 0 && input.style.length <= (global && !drama ? 10 : 30) && !/[\p{P}\p{S}]/u.test(input.style), '成片风格不得含标点，国内最多 30 字');
  check(assets.length <= (global && !drama ? 20 : 14) && (!drama || assets.length > 0), '成片资产数量不符合接口要求');
  const body = {script_name: input.script_name, script_content: script, assets: assets.map((a, i) => {
    check(a.asset_name.length <= (global && !drama ? 10 : 30), '资产名称过长');
    check(a.width >= 128 && a.height >= 128 && a.width / a.height <= 4 && a.height / a.width <= 4, '成片资产至少 128×128，宽高比须在 1:4 到 4:1');
    return {id: String(i + 1).padStart(2, '0'), type: a.type || 'character', name: a.asset_name, image_uri: a.imageUri, description: a.asset_description};
  }), resolution: input.resolution, aspect_ratio: input.aspect_ratio, style: input.style};
  if (!global || drama) body.quality = input.quality;
  if (drama) {
    const duration = Number(input.duration ?? 0);
    check(Number.isInteger(duration) && (duration === 0 || (duration >= (global ? 8 : 2) && duration <= (global ? 12 : 30))), '短剧时长：国内 0 或 2–30 秒；海外 0 或 8–12 秒');
    check(['upload', 'panorama', 'step'].includes(input.placement || 'upload'), '站位模式无效');
    body.duration = duration; body.placement = input.placement || 'upload';
  } else {
    check(['zh', 'en'].includes(input.language || 'zh'), '语言应为 zh 或 en');
    const speed = Number(input.tts_speed ?? 1.1); check(speed >= 1 && speed <= 1.5, '语速须为 1–1.5');
    body.language = input.language || 'zh'; body.tts_speed = speed; body.enable_lipsync = input.enable_lipsync === true;
    if (!global) body.add_subtitle = input.add_subtitle === true;
  }
  const url = `https://api.vidu.${global ? 'com' : 'cn'}/ent/v1/${input.service}/tasks`;
  check(Buffer.byteLength(JSON.stringify(body)) < 20 * 1024 * 1024, '成片请求体超出 20MB');
  return {url, body};
}
export function productionQuery(service, id) {
  const encoded = encodeURIComponent(id);
  return service === 'short-play' ? {url: `https://api.vidu.cn/ent/v1/short-play/tasks/${encoded}`, method: 'GET'} : {url: `https://api.vidu.cn/ent/v1/explain-comic/tasks/custom/${encoded}`, method: 'POST', body: JSON.stringify({id})};
}
export function normalizeProduction(service, body) {
  const state = service === 'short-play' ? body.task?.meta?.state : body.state;
  const result = service === 'short-play' ? body.task?.derived_data : body;
  const url = service === 'short-play' ? result?.signed_final_watermarked_video_url || result?.signed_final_video_url : result?.video_url;
  return {state: ['success', 'succeeded'].includes(state) ? 'succeeded' : state === 'failed' ? 'failed' : 'running', providerState: state || 'unknown', video_url: validPublicUrl(url) ? url : null, credits: body.credits ?? result?.deducted_credits ?? null};
}
export async function callProduction(request, env, signal, creating = false) {
  check(env.VIDU_API_KEY, '请在服务端配置 VIDU_API_KEY', 422);
  let response;
  try { response = await fetch(request.url, {method: request.method || 'POST', headers: {'Content-Type': 'application/json', Authorization: `Token ${env.VIDU_API_KEY}`}, body: request.body && (typeof request.body === 'string' ? request.body : JSON.stringify(request.body)), redirect: 'error', signal: signal || AbortSignal.timeout(60000)}); }
  catch { throw new ProviderError('成片服务请求中断，请先核对上游任务；不自动重试创建', {uncertain: creating}); }
  if (!response.ok) throw new ProviderError(`成片服务返回 HTTP ${response.status}`, {uncertain: creating && response.status >= 500});
  try { return await response.json(); } catch { throw new ProviderError('成片服务返回非 JSON 数据', {uncertain: creating}); }
}
