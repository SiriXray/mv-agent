import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Store} from './lib/store.mjs';
import {Engine} from './lib/engine.mjs';
import {reviseShot} from './lib/shot-revision.mjs';
import {listJobExports} from './lib/job-exports.mjs';
import {AppError, check, defaults, validateInputs, validatePlan, templatePlan, catalog, MODEL_DEFS} from './lib/core.mjs';
import {reloadVideoEnv} from './lib/video-config.mjs';
import {AISettings, AIService} from './lib/ai.mjs';
import {analyzeAudio, probe, run, binaries} from './lib/media.mjs';
import {PRODUCTION_SERVICES, buildProductionRequest, productionQuery, normalizeProduction, callProduction} from './lib/production.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml'};
async function body(req, limit = 2 * 1024 * 1024, binary = false) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > limit) throw new AppError('请求文件过大', 413); chunks.push(chunk); }
  const buffer = Buffer.concat(chunks); if (binary) return buffer;
  try { return JSON.parse(buffer.toString() || '{}'); } catch { throw new AppError('请求不是有效 JSON'); }
}
function send(res, value, status = 200) { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(value)); }
async function sendFile(req, res, file) {
  let stat; try { stat = await fsp.stat(file); } catch { throw new AppError('文件不存在', 404); }
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  const common = {'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'};
  const range = req.headers.range;
  let start = 0, end = stat.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) { res.writeHead(416, {'Content-Range': `bytes */${stat.size}`}); return res.end(); }
    if (!match[1]) start = Math.max(0, stat.size - Number(match[2])); else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (start > end || start >= stat.size) { res.writeHead(416, {'Content-Range': `bytes */${stat.size}`}); return res.end(); }
    res.writeHead(206, {...common, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${stat.size}`});
  } else res.writeHead(200, {...common, 'Content-Length': stat.size});
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, {start, end}); stream.on('error', () => res.destroy()); stream.pipe(res);
}
export function createApp({dataDir = path.join(ROOT, 'data'), env = process.env, envFile = null, engineOptions = {}, aiOptions = {}} = {}) {
  reloadVideoEnv(envFile, env);
  const store = new Store(dataDir), engine = new Engine(store, {env, ...engineOptions}), token = randomBytes(32).toString('hex');
  const aiSettings = new AISettings(dataDir, env), ai = new AIService(aiSettings, {env, ...aiOptions}), planning = new Map();
  function projectOutput(p) { return {...p, activeJob: Object.values(store.state.jobs).filter(j => j.projectId === p.id).at(-1)?.id || null}; }
  function createProject(input) { const p = {...store.canonical(defaults({planner: 'llm', ...input})), id: store.id(), revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), plan: null}; store.state.projects[p.id] = p; store.save(); return p; }
  function guardRevision(p, input) { check(input.revision === p.revision, '项目已有更新，请刷新后重试', 409); check(!store.locked(p.id), '生成中不能编辑项目，请先停止任务', 409); }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || ''; check(/^(127\.0\.0\.1|localhost):\d+$/.test(host), '仅允许本机访问', 403);
      if (req.headers.origin) check(req.headers.origin === `http://${host}`, '跨站请求已拒绝', 403);
      const url = new URL(req.url, `http://${host}`), route = url.pathname;
      if (!['GET', 'HEAD'].includes(req.method)) check(req.headers['x-mv-token'] === token, '缺少本地会话校验，请刷新页面', 403);
      if (route === '/api/health') return send(res, {status: 'ok', service: 'mv-agent', version: 'shot-workbench-7', pid: process.pid, activeJobs: [...engine.runs.keys()], upstreamLimit: engine.upstream.limit});
      if (route === '/api/bootstrap' && req.method === 'GET') return send(res, {token, ai: aiSettings.status(), models: catalog(env, store.state.metrics), productionServices: PRODUCTION_SERVICES, capabilities: {shotManagement: true, executionModes: ['live'], liveEnabled: env.ENABLE_LIVE_GENERATION === 'true', plannerConfigured: aiSettings.status().planner.configured, visionConfigured: aiSettings.status().vision.configured, billingEnabled: false}, projects: Object.values(store.state.projects).map(p => ({id: p.id, title: p.title, updatedAt: p.updatedAt})).reverse(), productions: Object.values(store.state.productions).map(({input, ...p}) => p)});
      if (route === '/api/config/reload' && req.method === 'POST') {
        check(!engine.active, '生成期间不能重新加载视频密钥', 409);
        check(reloadVideoEnv(envFile, env), '没有可重新读取的项目 .env 文件', 422);
        return send(res, {models: catalog(env, store.state.metrics), liveEnabled: env.ENABLE_LIVE_GENERATION === 'true'});
      }
      if (route === '/api/ai/settings' && req.method === 'GET') return send(res, aiSettings.status());
      if (route === '/api/ai/settings' && req.method === 'PUT') return send(res, aiSettings.save(await body(req)));
      if (route === '/api/uploads' && req.method === 'POST') {
        const name = decodeURIComponent(String(req.headers['x-file-name'] || '')), ext = path.extname(name).toLowerCase(), kind = url.searchParams.get('kind');
        check(['audio', 'image', 'sound'].includes(kind), '上传类型无效');
        check((kind === 'image' ? ['.png', '.jpg', '.jpeg', '.webp'] : kind === 'sound' ? ['.mp3'] : ['.mp3', '.wav', '.m4a', '.flac', '.ogg']).includes(ext), '不支持该文件格式');
        const bytes = await body(req, kind === 'image' ? 10 * 1024 * 1024 : 50 * 1024 * 1024, true);
        const file = `${store.id()}${ext}`, target = store.mediaPath(file);
        await fsp.writeFile(target, bytes);
        let metadata;
        try {
          if (kind === 'image') {
            const sig = bytes.subarray(0, 12); check((ext === '.png' && sig.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) || (['.jpg', '.jpeg'].includes(ext) && sig[0] === 255 && sig[1] === 216) || (ext === '.webp' && sig.toString('ascii', 0, 4) === 'RIFF' && sig.toString('ascii', 8, 12) === 'WEBP'), '图片文件签名不匹配');
            const info = await probe(target, env), stream = info.streams.find(s => s.codec_type === 'video'); check(stream?.width && stream?.height, '图片无法解码'); metadata = {width: stream.width, height: stream.height};
          } else {
            const sig = bytes.subarray(0, 12);
            check((ext === '.mp3' && (sig.toString('ascii', 0, 3) === 'ID3' || (sig[0] === 255 && (sig[1] & 224) === 224))) || (ext === '.wav' && sig.toString('ascii', 0, 4) === 'RIFF' && sig.toString('ascii', 8, 12) === 'WAVE') || (ext === '.flac' && sig.toString('ascii', 0, 4) === 'fLaC') || (ext === '.ogg' && sig.toString('ascii', 0, 4) === 'OggS') || (ext === '.m4a' && sig.toString('ascii', 4, 8) === 'ftyp'), '音频文件签名不匹配');
            metadata = await analyzeAudio(target, env);
            if (kind === 'sound') check(metadata.duration >= 3 && metadata.duration <= 12, '参考音频需为 3–12 秒 MP3');
          }
        } catch (error) { await fsp.unlink(target); throw error; }
        const record = {file, name: path.basename(name).slice(0, 150), kind, mime: MIME[ext], size: bytes.length, url: `/media/${file}`, ...metadata};
        store.state.uploads[file] = record; store.save(); return send(res, record, 201);
      }
      if (route === '/api/projects' && req.method === 'POST') return send(res, projectOutput(createProject(await body(req))), 201);
      let match = /^\/api\/projects\/([a-f0-9-]{36})(?:\/(plan|route|storyboards|describe|jobs))?$/.exec(route);
      if (match) {
        const p = store.getProject(match[1]), action = match[2];
        if (action === 'jobs' && req.method === 'GET') return send(res, {shotRevision: true, exports: true, jobs: Object.values(store.state.jobs).filter(j => j.projectId === p.id).reverse().map(j => ({id: j.id, idempotencyKey: j.idempotencyKey, parentJobId: j.parentJobId, createdAt: j.createdAt, revision: j.snapshot.revision, status: j.status, total: j.shots.length, succeeded: j.shots.filter(s => s.state === 'succeeded' && s.output).length}))});
        if (!action && req.method === 'GET') return send(res, projectOutput(p));
        if (!action && req.method === 'PATCH') {
          const input = await body(req); guardRevision(p, input);
          const next = store.canonical(defaults(input));
          const altered = ['lyrics', 'style', 'prompt', 'audio', 'assets', 'sounds'].some(k => JSON.stringify(p[k]) !== JSON.stringify(next[k]));
          Object.assign(p, next, {revision: p.revision + 1, updatedAt: new Date().toISOString()}); if (altered) p.plan = null; store.save(); return send(res, projectOutput(p));
        }
        if (action === 'describe' && req.method === 'POST') {
          const input = await body(req); guardRevision(p, input);
          check(input.confirmPaid === true, '自动识图会发送图片并可能计费，请确认本次识别', 403);
          check(Array.isArray(input.assetIds) && input.assetIds.length > 0 && input.assetIds.length <= 15 && new Set(input.assetIds).size === input.assetIds.length && input.assetIds.every(id => p.assets.some(a => a.asset_id === id)), '请选择有效且不重复的参考图片');
          check(input.overwrite === undefined || typeof input.overwrite === 'boolean', '覆盖开关必须是布尔值');
          const errors = []; let completed = 0, revision = p.revision;
          const settingsRevision = aiSettings.status().revision;
          for (const id of input.assetIds) {
            guardRevision(p, {revision});
            check(aiSettings.status().revision === settingsRevision, '识别期间 AI 配置发生变化，已完成结果保留，请重新确认剩余图片', 409);
            const asset = p.assets.find(a => a.asset_id === id);
            if (asset.asset_description?.trim() && !input.overwrite) continue;
            let description;
            try { description = await ai.describe(store, asset, {confirmPaid: true, force: input.overwrite === true}); }
            catch (error) { errors.push({assetId: id, error: error instanceof AppError ? error.message : '图片识别未完成，请检查文件或服务配置'}); break; }
            guardRevision(p, {revision});
            Object.assign(asset, {asset_name: description.asset_name, asset_description: description.asset_description, type: description.type, descriptionSource: 'ai', descriptionModel: description.model});
            p.plan = null; p.revision++; revision = p.revision; p.updatedAt = new Date().toISOString(); store.save(); completed++;
          }
          return send(res, {project: projectOutput(p), completed, errors});
        }
        if (action === 'plan' && req.method === 'POST') {
          const input = await body(req); guardRevision(p, input); validateInputs(p); const revision = p.revision;
          if (p.planner === 'llm') check(input.confirmPaid === true, 'LLM 规划会发送提示词与资产描述并可能计费，请确认', 403);
          const planningKey = `${p.id}:${revision}`;
          if (!planning.has(planningKey)) {
            const work = (async () => {
              const plan = p.planner === 'llm' ? await ai.plan(structuredClone(p)) : templatePlan(p);
              check(p.revision === revision && !store.locked(p.id), '规划期间项目发生变化，原分镜未覆盖，请重新确认', 409);
              p.plan = validatePlan(plan, p); p.revision++; p.updatedAt = new Date().toISOString(); store.save(); return projectOutput(p);
            })();
            planning.set(planningKey, work);
          }
          try { return send(res, await planning.get(planningKey)); } finally { planning.delete(planningKey); }
        }
        if (action === 'plan' && req.method === 'PUT') { const input = await body(req); guardRevision(p, input); p.plan = validatePlan(input.plan, p); p.revision++; store.save(); return send(res, projectOutput(p)); }
        if (action === 'route' && req.method === 'POST') { const input = await body(req); validatePlan(p.plan, p); check(input.execution === 'live', '仅支持真实模型生成，演示模式已移除', 422); return send(res, {routes: engine.routes(p, input.execution)}); }
        if (action === 'storyboards' && req.method === 'GET') { check(p.plan, '请先生成分镜', 404); res.setHeader('Content-Disposition', 'attachment; filename="storyboards.json"'); return send(res, p.plan); }
      }
      if (route === '/api/jobs' && req.method === 'POST') { const input = await body(req); const p = store.getProject(input.projectId); return send(res, engine.start(p, {...input, idempotencyKey: req.headers['idempotency-key']}), 202); }
      match = /^\/api\/jobs\/([a-f0-9-]{36})(?:\/(cancel|resume|concurrency|batch-submit|refill|recreate-uncertain|revise-shot|exports))?$/.exec(route);
      if (match) {
        const job = store.getJob(match[1]);
        if (req.method === 'GET' && !match[2]) return send(res, {...job, exports: await listJobExports(store, job)});
        if (req.method === 'GET' && match[2] === 'exports') return send(res, await listJobExports(store, job));
        if (req.method === 'POST' && match[2] === 'revise-shot') return send(res, reviseShot(engine, job, {...await body(req), idempotencyKey: req.headers['idempotency-key']}), 202);
        if (req.method === 'POST' && match[2] === 'cancel') { engine.cancel(job); return send(res, job); }
        if (req.method === 'POST' && match[2] === 'resume') return send(res, engine.resume(job, (await body(req)).confirmPaid));
        if (req.method === 'POST' && match[2] === 'refill') return send(res, engine.refill(job, {...await body(req), idempotencyKey: req.headers['idempotency-key']}), 202);
        if (req.method === 'POST' && match[2] === 'recreate-uncertain') return send(res, engine.recreateUncertain(job, {...await body(req), idempotencyKey: req.headers['idempotency-key']}), 202);
        if (req.method === 'POST' && match[2] === 'batch-submit') return send(res, engine.prepareBatch(job, (await body(req)).confirmPaid));
        if (req.method === 'POST' && match[2] === 'concurrency') { const input = await body(req); return send(res, engine.setConcurrency(job, input.concurrency, input.confirmPaid)); }
      }
      if (route === '/api/metrics' && req.method === 'PUT') {
        const input = await body(req); const metrics = {};
        for (const m of MODEL_DEFS) { metrics[m.id] = {}; for (const key of ['costPerSecond', 'latencySeconds']) { const v = input[m.id]?.[key] ?? null; check(v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 100000), '成本和时延必须为有效非负数，未知请留空'); metrics[m.id][key] = v; } }
        store.state.metrics = metrics; store.save(); return send(res, {models: catalog(env, metrics)});
      }
      if (route === '/api/productions/preview' || route === '/api/productions') {
        check(req.method === 'POST', '方法不支持', 405); const input = await body(req); const p = store.getProject(input.projectId);
        const assets = await Promise.all(p.assets.map(async a => ({...a, imageUri: `data:${a.mime};base64,${(await fsp.readFile(store.mediaPath(a.file))).toString('base64')}`})));
        const request = buildProductionRequest(input, assets);
        if (route.endsWith('/preview')) return send(res, {...request, body: {...request.body, assets: request.body.assets.map(a => ({...a, image_uri: '[本地图片 Base64，仅在确认调用时发送]'}))}, warning: '国内与海外字段/查询说明有差异；海外目前仅提供请求预览。短剧中文表的 qulity 与示例冲突，按中英文示例使用 quality。'});
        engine.authorize('live', input.confirmPaid); check(input.region === 'cn', '海外查询文档存在域名和方法缺口，当前仅支持请求预览，不发起无法追踪的付费任务', 422);
        const key = req.headers['idempotency-key']; check(typeof key === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(key), '缺少幂等键');
        const existing = Object.values(store.state.productions).find(x => x.idempotencyKey === key); if (existing) return send(res, existing);
        const item = {id: store.id(), projectId: p.id, service: input.service, title: input.script_name, region: 'cn', state: 'creating', idempotencyKey: key, createdAt: new Date().toISOString()}; store.state.productions[item.id] = item; store.save();
        try { const data = await callProduction(request, env, null, true); const remoteId = data.id || data.task_id || data.task?.meta?.id; check(remoteId, '创建响应无任务 ID，请人工核对供应商；禁止盲目重试', 502); item.remoteId = String(remoteId); item.state = 'running'; }
        catch (error) { item.state = 'needs_attention'; item.error = error.message; store.save(); throw error; }
        store.save(); return send(res, item, 202);
      }
      match = /^\/api\/productions\/([a-f0-9-]{36})\/refresh$/.exec(route);
      if (match && req.method === 'POST') { const item = store.state.productions[match[1]]; check(item?.remoteId, '任务不存在或没有上游 ID', 404); Object.assign(item, normalizeProduction(item.service, await callProduction(productionQuery(item.service, item.remoteId), env))); store.save(); return send(res, item); }
      if (['GET', 'HEAD'].includes(req.method)) {
        if (route.startsWith('/media/')) return await sendFile(req, res, store.mediaPath(decodeURIComponent(route.slice(7))));
        const files = {'/': 'index.html', '/favicon.svg': 'favicon.svg', '/app.js': 'app.js', '/ai-ui.js': 'ai-ui.js', '/styles.css': 'styles.css'};
        if (files[route]) return await sendFile(req, res, path.join(ROOT, 'public', files[route]));
      }
      throw new AppError('接口或文件不存在', 404);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      const known = error instanceof AppError || error.name === 'ProviderError';
      send(res, {error: known ? error.message : '操作未完成，请检查本地服务日志或输入文件', code: error.code || 'REQUEST_FAILED'}, error.status || 500);
      if (!known) console.error('[mv-agent]', error.name, String(error.message).replace(/sk-[\w-]+/g, '[REDACTED]').slice(0, 200));
    }
  });
  server.requestTimeout = 180000;
  return {server, store, engine, aiSettings, ai};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp({envFile: path.join(ROOT, '.env')}); const port = Number(process.env.PORT || 5410);
  app.server.listen(port, '127.0.0.1', () => console.log(`MV Agent is ready at http://127.0.0.1:${port} (live generation ${process.env.ENABLE_LIVE_GENERATION === 'true' ? 'enabled; confirmation required' : 'disabled'})`));
}
