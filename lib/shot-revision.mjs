import fs from 'node:fs';
import {check, validatePlan} from './core.mjs';

// Fork one paid attempt. The source job, its snapshot and every existing media file stay intact.
export function reviseShot(engine, parent, input) {
  const {confirmPaid, acceptDuplicateBilling = false, idempotencyKey, shotId, prompt,
    expectedAttempts, expectedUpdatedAt, projectRevision} = input;
  engine.authorize(parent.execution, confirmPaid);
  check(typeof idempotencyKey === 'string' && /^[a-zA-Z0-9-]{8,100}$/.test(idempotencyKey), '缺少有效幂等键');
  check(Number.isInteger(shotId) && typeof prompt === 'string' && prompt.trim().length > 0 && prompt.length <= 20000, '镜号或提示词无效');
  check(typeof acceptDuplicateBilling === 'boolean', '重复计费确认必须为布尔值');
  const request = {parentJobId: parent.id, shotId, prompt, expectedAttempts, expectedUpdatedAt, projectRevision, acceptDuplicateBilling};
  const jobs = Object.values(engine.store.state.jobs);
  const prior = jobs.find(j => j.idempotencyKey === idempotencyKey);
  if (prior) { check(JSON.stringify(prior.revisionRequest) === JSON.stringify(request), '幂等键已用于其他请求', 409); return prior; }
  check(!jobs.some(j => j.refills?.some(r => r.idempotencyKey === idempotencyKey)), '幂等键已用于补交操作', 409);
  engine.checkLaunch(parent.projectId, false);
  check(!engine.store.locked(parent.projectId), '项目仍有执行中的任务', 409);
  check(['failed', 'needs_attention', 'succeeded'].includes(parent.status), '只能从已停止或已完成的任务重提，作废任务不能恢复', 409);
  check(jobs.filter(j => j.projectId === parent.projectId).at(-1)?.id === parent.id, '已有更新的生成版本，请先查看最新版本', 409);
  check(Number.isInteger(projectRevision) && typeof expectedUpdatedAt === 'string' && engine.store.getProject(parent.projectId).revision === projectRevision && parent.updatedAt === expectedUpdatedAt, '项目或任务状态已变化，请刷新后重新确认', 409);
  const selected = parent.shots.find(s => s.id === shotId);
  check(selected && Number.isInteger(expectedAttempts) && selected.attempts === expectedAttempts, '镜头尝试次数已变化', 409);
  check(!parent.shots.some(s => s.remoteId && s.state !== 'succeeded'), '存在已受理但未收回的任务，先核对上游结果，不重新创建', 409);
  const unknown = selected.uncertainCreate === true;
  if (unknown) {
    check(acceptDuplicateBilling === true, '本镜旧请求可能已经计费，必须另行接受重复计费风险', 403);
    check(['needs_attention','cancelled'].includes(selected.state) && selected.attempts > 0 && !selected.output && !selected.remoteId && selected.history?.at(-1)?.state === 'submitting' && !selected.history.at(-1).remoteId, '未知请求记录不一致，请先核对', 409);
  } else {
    const succeeded = selected.state === 'succeeded' && selected.output;
    const failed = selected.state === 'failed' && selected.history?.at(-1)?.remoteId && selected.history.at(-1).state === 'failed';
    const untouched = selected.state === 'pending' && !selected.attempts && !selected.history?.length;
    check(succeeded || (!selected.output && !selected.remoteId && (failed || untouched)), '只允许重提成功镜头、上游明确失败或从未提交的镜头；创建异常需先核对', 409);
  }
  const snapshot = structuredClone(parent.snapshot);
  check(snapshot.plan?.storyboards[shotId]?.id === shotId, '分镜 ID 与快照不一致', 409);
  snapshot.plan.storyboards[shotId].prompt = prompt;
  validatePlan(snapshot.plan, snapshot);
  check(parent.routes?.[shotId]?.candidates?.[selected.candidateIndex ?? 0], '原模型路由记录缺失', 409);
  for (const shot of parent.shots.filter(s => s.state === 'succeeded')) {
    check(shot.output && fs.existsSync(engine.store.mediaPath(shot.output)), `第 ${shot.id + 1} 镜成功素材不存在`, 409);
  }
  const now = new Date().toISOString(), shots = structuredClone(parent.shots);
  const oldPrompt = parent.snapshot.plan.storyboards[shotId].prompt;
  shots[shotId] = {id: shotId, state: 'pending', attempts: selected.attempts, candidateIndex: selected.candidateIndex ?? 0,
    model: selected.model, remoteId: null, submitted: false, uncertainCreate: false, output: null,
    history: (selected.history || []).map(h => ({...h, prompt: h.prompt ?? oldPrompt, sourceJobId: h.sourceJobId ?? parent.id})),
    authorizedAttemptLimit: selected.attempts + 1, refillKey: idempotencyKey};
  const child = {id: engine.store.id(), projectId: parent.projectId, parentJobId: parent.id, revisionRequest: request,
    snapshot, execution: parent.execution, idempotencyKey, createdAt: now, updatedAt: now, status: 'queued',
    message: '单镜重提等待执行', billing: structuredClone(parent.billing || {}), routes: structuredClone(parent.routes),
    concurrency: engine.concurrency(parent), submissionMode: 'batch', batchShotIds: [shotId], shots, events: [],
    refills: [{kind: 'shot-revision', idempotencyKey, shotIds: [shotId], at: now, maxNewCreatesPerShot: 1,
      acceptDuplicateBilling, previousState: structuredClone(selected), previousPrompt: oldPrompt}]};
  engine.store.state.jobs[child.id] = child;
  engine.save(child, 'queued', `基于任务 ${parent.id} 重提第 ${shotId + 1} 镜，本轮最多创建一次；其他成功镜头复用，原任务和提示词保留。`);
  engine.launch(child);
  return child;
}
