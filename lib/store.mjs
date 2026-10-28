import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {check} from './core.mjs';
export class Store {
  constructor(root) {
    this.root = root; this.media = path.join(root, 'media'); this.work = path.join(root, 'work');
    fs.mkdirSync(this.media, {recursive: true}); fs.mkdirSync(this.work, {recursive: true});
    this.file = path.join(root, 'store.json');
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {projects: {}, jobs: {}, uploads: {}, metrics: {}, productions: {}};
    this.state.productions ||= {};
    for (const job of Object.values(this.state.jobs)) if (['queued', 'running', 'assembling', 'cancelling'].includes(job.status)) { job.status = 'needs_attention'; job.message = '服务重启，任务已暂停。确认后继续轮询已有上游任务，不自动重复提交。'; }
    this.save();
  }
  save() { const temp = this.file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(this.state), {mode: 0o600}); fs.renameSync(temp, this.file); }
  id() { return randomUUID(); }
  getProject(id) { const p = this.state.projects[id]; check(p, '项目不存在', 404); return p; }
  getJob(id) { const j = this.state.jobs[id]; check(j, '任务不存在', 404); return j; }
  mediaPath(file) { check(/^[a-f0-9-]{36}\.(mp3|wav|m4a|flac|ogg|png|jpg|jpeg|webp|mp4)$/.test(file), '非法媒体路径', 400); return path.join(this.media, file); }
  locked(id) { return Object.values(this.state.jobs).some(j => j.projectId === id && ['queued', 'running', 'assembling', 'cancelling'].includes(j.status)); }
  canonical(input) {
    function fileItem(item, kind, state) {
      const record = state.uploads[item?.file]; check(record && record.kind === kind, '上传文件不存在或类型错误');
      return {...record, ...(item.remoteUrl ? {remoteUrl: item.remoteUrl} : {})};
    }
    const audio = input.audio ? fileItem(input.audio, 'audio', this.state) : null;
    const assets = (input.assets || []).map(a => {
      const record = fileItem(a, 'image', this.state);
      const aiUnchanged = record.aiDescription?.asset_description === a.asset_description && record.aiDescription?.asset_name === a.asset_name && record.aiDescription?.type === a.type;
      return {...record, asset_id: a.asset_id, asset_name: a.asset_name, asset_description: a.asset_description, type: ['character', 'scene', 'tool'].includes(a.type) ? a.type : 'character', ...(aiUnchanged ? {descriptionSource: 'ai', descriptionModel: record.aiDescription.model} : {})};
    });
    const sounds = (input.sounds || []).map(a => fileItem(a, 'sound', this.state));
    return {...input, audio, assets, sounds};
  }
}
