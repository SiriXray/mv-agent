import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {check, AppError, catalog, routeShot, validateInputs, validatePlan, priceDisclosure} from './core.mjs';
import {createProviders, ProviderError} from './providers.mjs';
import {normalizeClip, assemble, downloadVideo} from './media.mjs';
import {fitReferenceImages, referenceJpeg} from './reference-images.mjs';
import {WorkGate} from './work-gate.mjs';

export class Engine {
  constructor(store, {env = process.env, providers, media, pollMs = 5000, pollLimit = Infinity, pollErrorLimit = 12} = {}) {
    this.store = store; this.env = env; this.providers = providers || createProviders({env});
    this.media = media || {normalizeClip, assemble, downloadVideo};
    this.pollMs = pollMs; this.pollLimit = pollLimit; this.runs = new Map(); this.referenceCaches = new Map();
    this.pollErrorLimit = pollErrorLimit; this.localMedia = new WorkGate(2); this.upstream = new WorkGate(5);
  }
  get active() { return this.runs.values().next().value ?? null; }
  checkLaunch(projectId, allowParallel = false) {
    check(typeof allowParallel === 'boolean', '并行执行标记必须为布尔值');
    check(![...this.runs.values()].some(r => r.projectId === projectId), '该项目已有任务正在执行', 409);
    check(!this.active || allowParallel, '已有项目正在执行，请等待完成或暂停后再开始', 409);
    check(this.runs.size < 2, '最多允许两部作品同时执行，共享 5 路上游请求', 409);
  }
  models() { return catalog(this.env, this.store.state.metrics); }
  routes(p, execution) { return p.plan.storyboards.map(s => routeShot(p, s, this.models(), execution)); }
  authorize(execution, confirmed) {
    check(execution === 'live', '仅支持真实模型生成，演示模式已移除', 422);
    check(this.env.ENABLE_LIVE_GENERATION === 'true' && confirmed === true, '真实调用未启用或未确认费用，请配置服务端开关并确认', 403);
  }
  start(p, {execution, confirmPaid, revision, idempotencyKey, submissionMode, allowParallel = false}) {
    this.authorize(execution, confirmPaid);
    check(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(idempotencyKey), '缺少有效幂等键');
    const existing = Object.values(this.store.state.jobs).find(j => j.idempotencyKey === idempotencyKey);
    if (existing) { check(existing.projectId === p.id && existing.execution === execution, '幂等键已被其他请求使用', 409); return existing; }
    check(submissionMode === undefined || submissionMode === 'batch', '不支持的提交模式');
    this.checkLaunch(p.id, allowParallel);
    check(revision === p.revision, '项目已更新，请刷新后重试', 409);
    validateInputs(p); validatePlan(p.plan, p);
    const routes = this.routes(p, execution);
    check(routes.every(r => r.chosen), '有分镜找不到可用模型，请查看路由预览中的原因', 422);
    const id = this.store.id(), now = new Date().toISOString();
    const job = {id, projectId: p.id, snapshot: structuredClone(p), execution, idempotencyKey, createdAt: now, updatedAt: now, status: 'queued', message: '等待执行', billing: priceDisclosure(p), routes, shots: p.plan.storyboards.map(s => ({id: s.id, state: 'pending', attempts: 0, candidateIndex: 0, remoteId: null, submitted: false, output: null, history: []})), events: []};
    if (submissionMode === 'batch') job.submissionMode = 'batch';
    this.store.state.jobs[id] = job; this.save(job, 'queued', '已创建任务'); this.launch(job); return job;
  }
  save(job, status, message) {
    if (status) job.status = status;
    if (message) { job.message = message; job.events.push({at: new Date().toISOString(), message}); job.events = job.events.slice(-300); }
    job.updatedAt = new Date().toISOString(); this.store.save();
  }
  cancel(job) { const active = this.runs.get(job.id); check(active, '任务当前未运行', 409); active.controller.abort(); this.save(job, 'cancelling', '停止本地执行；上游已提交任务可能继续运行并计费。'); }
  concurrency(job) { return job.concurrency ?? job.snapshot.routing.concurrency; }
  setConcurrency(job, value, confirmPaid) {
    this.authorize(job.execution, confirmPaid);
    check(Number.isInteger(value) && value >= 1 && value <= 5, '并发应为 1–5');
    check(['queued', 'running', 'failed', 'cancelled', 'needs_attention'].includes(job.status), '当前状态不允许调整并发', 409);
    check(job.batchSubmission?.status !== 'submitting', '批量提交过程中请等待受理结束，再调整查询并发', 409);
    check(!job.shots.some(s => s.uncertainCreate), '存在创建状态不明的镜头，先核对上游任务，不扩大并发', 409);
    if (this.concurrency(job) === value) return job;
    // Runtime scheduling only: never rewrite the immutable request/scene snapshot.
    job.concurrency = value;
    this.save(job, null, `任务并发已设为 ${value}；已受理镜头保留，降低并发不取消在途任务。本地下载/转码最多 2 路。`);
    this.runs.get(job.id)?.wake?.();
    return job;
  }
  prepareBatch(job, confirmPaid) {
    this.authorize(job.execution, confirmPaid);
    check(!this.active && ['failed', 'cancelled', 'needs_attention'].includes(job.status), '请先安全停止任务，再切换批量提交模式', 409);
    check(!job.shots.some(s => s.uncertainCreate), '存在创建状态不明的镜头，先核对上游任务', 409);
    if (job.submissionMode === 'batch') return job;
    job.submissionMode = 'batch';
    this.save(job, null, '已准备批量提交：恢复后按并发上限提交全部未受理镜头，再持续查询；提交遇错即停止派发，不自动重试创建。');
    return job;
  }
  resume(job, confirmPaid) {
    this.authorize(job.execution, confirmPaid); check(!this.active, '已有任务正在执行', 409);
    check(['failed', 'cancelled', 'needs_attention'].includes(job.status), '该任务不可恢复', 409);
    check(!job.shots.some(s => s.uncertainCreate), '有任务创建状态不明，必须先向供应商核对，禁止自动重复付费提交', 409);
    for (const shot of job.shots) if (shot.state !== 'succeeded') { shot.state = 'pending'; shot.error = null; if (!shot.remoteId) shot.attempts = 0; }
    this.save(job, 'queued', '恢复未完成镜头，保留已完成结果及上游任务 ID'); this.launch(job); return job;
  }
  refill(job, {confirmPaid, idempotencyKey, shotIds, allowParallel = false}) {
    this.authorize(job.execution, confirmPaid);
    check(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(idempotencyKey), '缺少有效补交幂等键');
    check(Array.isArray(shotIds) && shotIds.length > 0 && new Set(shotIds).size === shotIds.length && shotIds.every(id => Number.isInteger(id) && job.shots.some(s => s.id === id)), '请选择有效且不重复的镜头');
    const ids = [...shotIds].sort((a, b) => a - b);
    const prior = job.refills?.find(r => r.idempotencyKey === idempotencyKey);
    if (prior) { check(!prior.kind && JSON.stringify(prior.shotIds) === JSON.stringify(ids), '补交幂等键已用于另一组镜头或操作', 409); return job; }
    this.checkLaunch(job.projectId, allowParallel);
    check(['failed', 'cancelled', 'needs_attention'].includes(job.status), '当前任务不可补交', 409);
    const selected = ids.map(id => job.shots.find(s => s.id === id));
    for (const shot of selected) {
      check(!shot.uncertainCreate && !shot.remoteId && !shot.output, '成功、已受理或创建状态不明的镜头不能重复提交', 409);
      check(shot.state === 'failed' || (shot.state === 'pending' && !shot.attempts && !shot.history?.length), '只允许补交明确失败或从未提交的镜头', 409);
    }
    // A new explicit authorization adds exactly one create per selected shot; history is never reset.
    job.refills ||= [];
    job.refills.push({idempotencyKey, shotIds: ids, at: new Date().toISOString(), maxNewCreatesPerShot: 1});
    job.submissionMode = 'batch'; job.batchShotIds = ids;
    for (const shot of selected) { shot.state = 'pending'; shot.error = null; shot.authorizedAttemptLimit = shot.attempts + 1; shot.refillKey = idempotencyKey; }
    this.save(job, 'queued', `已确认补交 ${ids.length} 镜，每镜本轮最多新增一次；保留成功素材、未知请求和全部历史 ID。`);
    this.launch(job); return job;
  }
  recreateUncertain(job, {confirmPaid, acceptDuplicateBilling, idempotencyKey, shotIds, expectedAttempts, revision, authorizationNote, allowParallel = false}) {
    this.authorize(job.execution, confirmPaid);
    check(acceptDuplicateBilling === true, '必须明确接受旧请求可能已计费、重建可能重复计费的风险', 403);
    check(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(idempotencyKey), '缺少有效重建幂等键');
    check(Array.isArray(shotIds) && shotIds.length > 0 && new Set(shotIds).size === shotIds.length && shotIds.every(id => Number.isInteger(id) && job.shots.some(s => s.id === id)), '请选择有效且不重复的镜头');
    const ids = [...shotIds].sort((a, b) => a - b);
    check(expectedAttempts && typeof expectedAttempts === 'object' && !Array.isArray(expectedAttempts) && Object.keys(expectedAttempts).length === ids.length && Object.keys(expectedAttempts).every(key => ids.some(id => String(id) === key)) && ids.every(id => Number.isInteger(expectedAttempts[id]) && expectedAttempts[id] > 0), '必须逐镜提供本次确认的尝试次数');
    check(Number.isInteger(revision), '必须提供确认的项目版本');
    check(typeof authorizationNote === 'string' && authorizationNote.trim().length > 0 && authorizationNote.trim().length <= 500, '请提供不超过 500 字的明确授权记录');
    const note = authorizationNote.trim(), attempts = ids.map(id => ({id, attempts: expectedAttempts[id]}));
    const prior = job.refills?.find(r => r.idempotencyKey === idempotencyKey);
    if (prior) {
      check(prior.kind === 'uncertain-recreation' && JSON.stringify(prior.shotIds) === JSON.stringify(ids) && JSON.stringify(prior.expectedAttempts) === JSON.stringify(attempts) && prior.revision === revision && prior.authorizationNote === note, '重建幂等键已用于另一组镜头或授权', 409);
      return job;
    }
    this.checkLaunch(job.projectId, allowParallel);
    check(['failed', 'cancelled', 'needs_attention'].includes(job.status), '请先等待任务安全停止，再确认重建', 409);
    check(job.snapshot.revision === revision && this.store.getProject(job.projectId).revision === revision, '项目版本已变化，禁止重建历史规格，请重新核对', 409);
    const selected = ids.map(id => job.shots.find(s => s.id === id));
    for (const shot of selected) {
      const last = shot.history?.at(-1);
      check(shot.uncertainCreate === true && ['needs_attention', 'cancelled'].includes(shot.state) && !shot.remoteId && !shot.output, '只允许重建无上游 ID、无素材的创建状态不明镜头', 409);
      check(shot.attempts === expectedAttempts[shot.id] && last && !last.remoteId && last.state === 'submitting', '镜头记录已变化，请重新核对当前未知请求', 409);
    }
    // Acceptance of duplicate billing is not evidence that the original request failed.
    // Preserve the unresolved request and its history before authorizing one new creation.
    job.refills ||= [];
    job.refills.push({idempotencyKey, kind: 'uncertain-recreation', shotIds: ids, at: new Date().toISOString(), maxNewCreatesPerShot: 1, acceptDuplicateBilling: true, revision, authorizationNote: note, expectedAttempts: attempts,
      unresolvedRequests: selected.map(shot => ({shotId: shot.id, outcome: 'unknown', previousState: structuredClone(shot)}))});
    job.submissionMode = 'batch'; job.batchShotIds = ids;
    for (const shot of selected) {
      shot.uncertainCreate = false; shot.state = 'pending'; shot.error = null;
      shot.authorizedAttemptLimit = shot.attempts + 1; shot.refillKey = idempotencyKey;
    }
    this.save(job, 'queued', `已明确接受重复计费风险，授权重建 ${ids.length} 镜，每镜仅新增一次；旧请求结果仍未知，历史记录完整保留。`);
    this.launch(job); return job;
  }
  launch(job) {
    const controller = new AbortController(); this.runs.set(job.id, {id: job.id, projectId: job.projectId, controller});
    this.referenceCaches.set(job.id, new Map());
    this.run(job, controller.signal).catch(error => { this.save(job, controller.signal.aborted ? 'cancelled' : 'failed', error.message); }).finally(() => { this.runs.delete(job.id); this.referenceCaches.delete(job.id); });
  }
  async inputs(job, shot, model, signal) {
    const p = job.snapshot;
    const mode = p.generationMode || 'reference';
    const images = await Promise.all((mode === 't2v' ? [] : shot.assets).map(async id => {
      const a = p.assets.find(x => x.asset_id === id);
      return model === 'vidu-q4' ? `data:${a.mime};base64,${(await fs.readFile(this.store.mediaPath(a.file))).toString('base64')}` : a.remoteUrl;
    }));
    const sounds = await Promise.all(p.sounds.map(async a => model === 'vidu-q4' ? `data:audio/mpeg;base64,${(await fs.readFile(this.store.mediaPath(a.file))).toString('base64')}` : a.remoteUrl));
    const input = {mode, prompt: shot.prompt, images, sounds, duration: shot.duration, resolution: p.resolution, aspect_ratio: p.aspect_ratio};
    if (model !== 'vidu-q4') return input;
    const cache = this.referenceCaches.get(job.id) || new Map();
    return fitReferenceImages(input, async index => {
      const asset = p.assets.find(a => a.asset_id === shot.assets[index]);
      if (!cache.has(asset.file)) {
        const encoding = referenceJpeg(this.store.mediaPath(asset.file), signal, this.env);
        cache.set(asset.file, encoding);
        encoding.catch(() => cache.delete(asset.file));
      }
      return cache.get(asset.file);
    });
  }
  async submitShot(job, state, signal, canSubmit) {
    check(!state.uncertainCreate, '创建状态不明的镜头禁止重新提交', 409);
    if (state.remoteId) return true;
    const p = job.snapshot, shot = p.plan.storyboards[state.id], candidate = job.routes[state.id].candidates[state.candidateIndex];
    const model = state.model || candidate.model;
    check(state.attempts < (state.authorizedAttemptLimit ?? p.routing.maxAttempts), '本镜已达到提交次数上限', 422);
    const input = await this.localMedia.run(() => this.inputs(job, shot, model, signal), signal);
    signal.throwIfAborted();
    return this.upstream.run(async () => {
      if (canSubmit && !canSubmit()) return false;
      state.model = model; state.generationDuration = candidate.generationDuration; state.requestedResolution = p.resolution; state.attempts++; state.submitted = true; state.uncertainCreate = true;
      state.history.push({model, prompt: shot.prompt, attempt: state.attempts, at: new Date().toISOString(), state: 'submitting', ...(state.refillKey ? {refillKey: state.refillKey} : {})}); this.save(job);
      try {
        const created = await this.providers.create(model, {...input, duration: candidate.generationDuration}, signal);
        state.remoteId = created.id; state.uncertainCreate = false; Object.assign(state.history.at(-1), {remoteId: created.id, state: 'submitted'}); this.save(job);
        return true;
      } catch (error) {
        if (!signal.aborted && !error.uncertain) state.uncertainCreate = false;
        state.history.at(-1).error = error.message; this.save(job); throw error;
      }
    }, signal);
  }
  async submitBatch(job, signal) {
    const pending = job.shots.filter(s => s.state !== 'succeeded' && !s.remoteId && !s.uncertainCreate && (!job.batchShotIds || job.batchShotIds.includes(s.id)));
    job.batchSubmission = {status: 'submitting', requested: pending.length, accepted: 0, startedAt: new Date().toISOString()};
    this.save(job, null, `开始批量提交 ${pending.length} 镜，最多 ${this.concurrency(job)} 个并行提交请求；已有 ID 不重建。`);
    let cursor = 0, halted = false;
    const worker = async () => {
      while (!signal.aborted && !halted && cursor < pending.length) {
        const shot = pending[cursor++]; shot.state = 'submitting'; this.save(job);
        try {
          const accepted = await this.submitShot(job, shot, signal, () => !halted);
          shot.state = accepted ? 'queued' : 'pending'; shot.error = null;
          if (accepted) job.batchSubmission.accepted++;
        } catch (error) {
          halted = true; shot.error = error.message;
          shot.state = signal.aborted ? 'cancelled' : shot.uncertainCreate || error.uncertain ? 'needs_attention' : 'failed';
          job.batchSubmission.error = error.message;
        }
        this.save(job);
      }
    };
    await Promise.all(Array.from({length: this.concurrency(job)}, worker));
    job.batchSubmission.status = signal.aborted ? 'cancelled' : halted ? 'needs_attention' : 'submitted';
    this.save(job, null, `批量提交已受理 ${job.batchSubmission.accepted}/${pending.length} 镜；${halted || signal.aborted ? '已停止后续提交，已有任务 ID 保留。' : '开始持续查询全部已受理任务。'}`);
  }
  async runShot(job, state, signal) {
    const p = job.snapshot, shot = p.plan.storyboards[state.id], route = job.routes[state.id];
    if (state.state === 'succeeded') return;
    const output = this.store.mediaPath(`${this.store.id()}.mp4`);
    try {
      state.state = 'running'; this.save(job);
      {
        let generated = false;
        while (!generated && state.candidateIndex < route.candidates.length) {
          signal.throwIfAborted(); const candidate = route.candidates[state.candidateIndex], model = state.model || candidate.model;
          try {
            if (!state.remoteId) {
              await this.submitShot(job, state, signal);
            }
            let result, pollErrors = 0;
            for (let poll = 0; poll < this.pollLimit; poll++) {
              signal.throwIfAborted();
              try { result = await this.upstream.run(() => this.providers.poll(model, state.remoteId, signal), signal); }
              catch (error) { if (!error.retryable || poll === this.pollLimit - 1 || ++pollErrors >= this.pollErrorLimit) throw new ProviderError('查询连续中断，保留任务 ID 等待恢复', {uncertain: true}); await sleep(this.pollMs, undefined, {signal}); continue; }
              pollErrors = 0;
              if (!['pending', 'running', 'succeeded', 'failed'].includes(result.state)) throw new ProviderError('上游返回未知状态，保留任务 ID 等待核对', {uncertain: true});
              state.providerState = result.state;
              if (state.history.length) { state.history.at(-1).state = result.state; if (result.usage) state.history.at(-1).usage = result.usage; }
              this.save(job);
              if (result.state === 'failed') { state.history.at(-1).failed = true; state.remoteId = null; throw new ProviderError('供应商明确返回任务失败', {retryable: true}); }
              if (result.state === 'succeeded') break;
              await sleep(this.pollMs, undefined, {signal});
            }
            if (result?.state !== 'succeeded') throw new ProviderError('轮询窗口已结束，保留上游任务 ID，请稍后恢复', {uncertain: true});
            check(result.url, '成功响应缺少视频 URL', 502);
            state.usage = result.usage;
            const raw = path.join(this.store.work, job.id, `${state.id}-raw.mp4`);
            await this.localMedia.run(async () => {
              await this.media.downloadVideo(result.url, raw, signal);
              state.sourceInfo = await this.media.normalizeClip(raw, output, shot, p, signal, this.env, {duration: candidate.generationDuration});
            }, signal);
            generated = true;
          } catch (error) {
            if (state.history.length) state.history.at(-1).error = error.message;
            if (signal.aborted) throw error;
            if (error.uncertain || (state.remoteId && !error.retryable)) throw new ProviderError(error.message, {uncertain: true});
            state.uncertainCreate = false;
            // Batch mode is one creation per pending shot, with no automatic resubmission/failover.
            if (job.submissionMode === 'batch') throw error;
            if (!error.retryable || state.attempts >= p.routing.maxAttempts) {
              if (!p.routing.allowFallback || state.candidateIndex + 1 >= route.candidates.length) throw error;
              state.candidateIndex++; state.model = null; state.remoteId = null; state.attempts = 0;
              this.save(job, null, `镜头 ${state.id + 1} 故障切换至 ${route.candidates[state.candidateIndex].name}`);
            } else { this.save(job, null, `镜头 ${state.id + 1} 在提交上限内重试`); await sleep(Math.min(4000, 1000 * 2 ** (state.attempts - 1)), undefined, {signal}); }
          }
        }
      }
      state.output = path.basename(output); state.state = 'succeeded'; state.error = null;
      this.save(job, null, `镜头 ${state.id + 1} 已完成`);
    } catch (error) {
      state.error = error.message; state.state = signal.aborted ? 'cancelled' : error.uncertain ? 'needs_attention' : 'failed'; this.save(job);
    }
  }
  async run(job, signal) {
    this.save(job, 'running', '开始真实模型任务');
    const work = path.join(this.store.work, job.id); await fs.mkdir(work, {recursive: true});
    if (job.submissionMode === 'batch') await this.submitBatch(job, signal);
    // Resume accepted tasks first, even if a prior run used a higher concurrency.
    const pending = job.shots.filter(s => s.state !== 'succeeded' && (job.submissionMode !== 'batch' || s.remoteId)).sort((a, b) => Number(!!b.remoteId) - Number(!!a.remoteId) || a.id - b.id);
    let cursor = 0, running = 0, halted = false, failure;
    await new Promise(resolve => {
      const pump = () => {
        while (!signal.aborted && !halted && running < this.concurrency(job) && cursor < pending.length) {
          const shot = pending[cursor++]; running++;
          this.runShot(job, shot, signal).catch(error => { failure = error; halted = true; }).then(() => {
            running--;
            if (shot.state !== 'succeeded' && job.submissionMode !== 'batch') halted = true;
            pump();
          });
        }
        if (!running && (signal.aborted || halted || cursor === pending.length)) resolve();
      };
      const active = this.runs.get(job.id);
      active.wake = pump;
      signal.addEventListener('abort', pump, {once: true});
      active.cleanupScheduler = () => signal.removeEventListener('abort', pump);
      pump();
    }).finally(() => { const active = this.runs.get(job.id); active?.cleanupScheduler?.(); if (active) active.wake = null; });
    if (failure) throw failure;
    if (signal.aborted) return this.save(job, 'cancelled', '本地任务已停止；已提交的上游任务状态保留。');
    if (job.shots.some(s => s.state !== 'succeeded')) return this.save(job, job.batchSubmission?.status === 'needs_attention' || job.shots.some(s => s.state === 'needs_attention') ? 'needs_attention' : 'failed', '镜头未完成，已停止提交后续镜头；已受理任务保留，恢复需再次确认费用。');
    this.save(job, 'assembling', '按分镜裁切拼接，替换为原曲并校验导出规格');
    const file = `${this.store.id()}.mp4`;
    job.outputInfo = await this.localMedia.run(() => this.media.assemble(job.shots.map(s => this.store.mediaPath(s.output)), this.store.mediaPath(job.snapshot.audio.file), this.store.mediaPath(file), job.snapshot, work, signal, this.env), signal);
    job.output = file; job.video_url = `/media/${file}`;
    this.save(job, 'succeeded', 'MV 已完成，输出 H.264 + AAC MP4。');
  }
}
