export class AIUI {
  constructor(context) { Object.assign(this, context); }
  get status() { return this.state.bootstrap.ai; }
  connectionFields(role, c) {
    const {esc, label} = this;
    return `${label('完整 API 地址', `<input name="${role}.url" type="url" value="${esc(c?.url || '')}" placeholder="https://你的网关/v1/responses" autocomplete="off">`)}
      <div class="settings-grid">${label('接口协议', `<select name="${role}.protocol"><option value="responses" ${c?.protocol === 'responses' ? 'selected' : ''}>OpenAI Responses</option><option value="chat" ${c?.protocol === 'chat' ? 'selected' : ''}>Chat Completions</option></select>`)}${label('模型 ID', `<input name="${role}.model" value="${esc(c?.model || '')}" placeholder="填写该账户可用的模型 ID" autocomplete="off">`)}</div>
      ${label('服务端 API Key', `<input name="${role}.apiKey" type="password" value="" autocomplete="new-password" spellcheck="false" placeholder="${c?.keyConfigured ? '已保存 · 留空保持原密钥' : '填写密钥，仅发送到本机服务端'}">`, '更换 API 域名必须填写对应密钥；原密钥不会发送给新域名。')}
      <label class="toggle-line"><input name="${role}.clearKey" type="checkbox"><span>清除这条连接保存的密钥</span></label>`;
  }
  config() {
    const {button, icon} = this, s = this.status;
    if (!s) return '<section class="panel"><h2>需要重启新版服务</h2><p>当前运行的旧服务尚不支持页面内 AI 配置。重启 MV Agent 后刷新本页。</p></section>';
    return `<div class="page-heading"><h1>配置</h1></div>
      <form id="ai-config-form" class="ai-config-grid">
        <section class="panel"><div class="panel-heading"><h3>分镜创作连接</h3><span class="badge ${s.planner.configured ? 'ok' : 'warn'}">${s.planner.configured ? '已配置 · 未代表已联调' : '待配置'}</span></div>
          <label class="field"><span>快速填写</span><select id="ai-preset"><option value="current">当前连接 / 自定义网关</option><option value="gpt">GPT · Responses</option><option value="deepseek">DeepSeek · Chat Completions</option></select></label>
          ${this.connectionFields('planner', s.planner)}
          <p class="helper">使用当前 GPT 网关时保持其地址、模型和协议。DeepSeek 可用于备用文本规划；切换供应商不会自动调用，也不会自动沿用另一家的密钥。</p>
        </section>
        <section class="panel"><div class="panel-heading"><h3>图片识别连接</h3><span class="badge ${s.vision.configured ? 'ok' : 'warn'}">${s.vision.configured ? '已配置' : '待配置'}</span></div>
          <label class="toggle-line"><input id="vision-reuse" type="checkbox" ${s.vision.sameAsPlanner ? 'checked' : ''}><span>复用上面的 GPT 连接<small>所选模型必须支持图片输入；文本模型不能替代识图模型</small></span></label>
          <div id="vision-fields" ${s.vision.sameAsPlanner ? 'hidden' : ''}>${this.connectionFields('vision', s.vision)}</div>
          <div class="ai-flow"><div>${icon('upload')}<span>上传原图<small>原文件保留在本机</small></span></div><div>${icon('spark')}<span>AI 自动识图<small>返回名称、人物 / 场景 / 道具和可编辑描述</small></span></div><div>${icon('film')}<span>LLM 创作分镜<small>只引用该镜头需要的图片，不重复整段故事</small></span></div></div>
          <p class="helper">识图只发经过缩放的分析副本；视频仍使用原始资产链路。修改自动描述是可选项，不是上传必填步骤。</p>
        </section>
        <section class="panel ai-save"><p>密钥仅存储在本机服务端，不回显、不写入浏览器存储。保存后立即生效，无需再次重启；识图、分镜和视频调用各自确认。</p>${button('保存 AI 配置', 'save-ai', 'btn primary')}</section>
      </form>`;
  }
  plannerHint() {
    const {button, esc} = this, p = this.state.project, configured = this.state.bootstrap.capabilities.plannerConfigured;
    return `<div class="ai-readiness"><span>${configured ? `远程规划：${esc(this.status?.planner.model || '已配置')}` : '先配置 GPT / DeepSeek，才能创作分镜'}${p.planner === 'template' ? '<small>当前保留旧模板方案，可切换为 LLM 后重新创作。</small>' : '<small>服务出错会保留旧分镜，不会自动回退本地模板。</small>'}</span>${button('AI 配置', 'open-ai', 'btn btn-small')}${p.planner === 'template' ? button('改用 LLM 创作', 'use-llm', 'btn btn-small') : ''}</div>`;
  }
  assetControls() {
    const p = this.state.project, missing = p.assets.filter(a => !a.asset_description?.trim()).length;
    return `<div class="asset-ai-controls"><label class="toggle-line"><input id="auto-describe" type="checkbox" ${this.state.autoDescribe ? 'checked' : ''}><span>添加图片后自动识别<small>每批确认后调用，不需要手填视觉描述</small></span></label>${p.assets.length ? this.button(missing ? `识别 ${missing} 张待描述图片` : '重新识别全部图片', missing ? 'describe-missing' : 'describe-all', 'btn btn-small') : ''}</div>`;
  }
  assetCard(a, i) {
    const {esc, button, icon} = this;
    return `<article class="asset-card"><img src="${a.url}" alt="${esc(a.asset_name)}参考图"><div class="asset-fields"><div class="asset-name"><strong>${esc(a.asset_name)}</strong><button class="icon-btn" data-remove-asset="${i}" aria-label="移除资产">${icon('close')}</button></div>
      <p class="asset-description ${a.asset_description ? '' : 'muted'}">${esc(a.asset_description || '待 AI 识别，无需手动填写描述。')}</p>
      <div class="asset-ai-status"><small>${a.descriptionSource === 'ai' ? `AI 描述 · ${esc(a.descriptionModel)}` : a.asset_description ? '已有描述 · 原样保留' : '图片已上传'}</small>${button(a.asset_description ? '重新识别' : '识别图片', 'describe-one', 'btn btn-small', `data-asset-id="${esc(a.asset_id)}"`)}</div>
      <details class="asset-edit"><summary>调整描述与高级选项（可选）</summary><label class="field"><span>名称</span><input data-asset="${i}" data-key="asset_name" aria-label="资产 ${i + 1} 名称" value="${esc(a.asset_name)}"></label><label class="field"><span>视觉描述</span><textarea data-asset="${i}" data-key="asset_description" rows="3" aria-label="资产 ${i + 1} 视觉描述">${esc(a.asset_description)}</textarea></label>
      <label class="field"><span>资产类型</span><select data-asset="${i}" data-key="type" aria-label="资产类型">${[['character','人物'],['scene','场景'],['tool','道具']].map(([v,t]) => `<option value="${v}" ${a.type === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="field"><span>Wan / H3 公网图片地址</span><input data-asset="${i}" data-key="remoteUrl" type="url" aria-label="资产 ${i + 1} 公网地址" value="${esc(a.remoteUrl || '')}" placeholder="仅 Wan / H3 需要；Q4 无需填写"><small>识图不等于发布到公网；尚未配置对象存储时，Q4 直接使用本地图。</small></label></details></div></article>`;
  }
  async describe(ids, overwrite = false) {
    if (!ids.length) return true;
    await this.save();
    if (!this.state.bootstrap.capabilities.visionConfigured) { this.state.view = 'ai'; this.render(); this.toast('图片已保存。请先配置识图模型，再一键识别；无需手填描述。', true); return false; }
    if (!confirm(`将发送 ${ids.length} 张图片到 ${this.status.vision.model} 识别，可能产生费用。${overwrite ? '将覆盖所选图片的已有描述，并使旧分镜失效。' : ''}是否继续？`)) return false;
    this.toast(`正在识别 ${ids.length} 张图片…`);
    const result = await this.api(`/api/projects/${this.state.project.id}/describe`, {method: 'POST', data: {revision: this.state.project.revision, assetIds: ids, overwrite, confirmPaid: true}});
    this.state.project = result.project; this.state.routes = null; this.state.step = 0; this.render();
    if (result.errors.length) { this.toast(`${result.completed} 张已完成。${result.errors[0].error}；剩余图片保留，可确认后重试。`, true); return false; }
    this.toast(`${result.completed} 张图片已自动生成描述，可直接规划分镜。`); return true;
  }
  async upload(files, kind) {
    const p = this.state.project, ids = [];
    if (kind === 'image' && p.assets.length + files.length > 15) throw Error('每个项目最多 15 张参考图，请先移除不需要的图片。');
    if (kind === 'sound' && p.sounds.length + files.length > 3) throw Error('参考音频最多 3 条。');
    try {
      for (const file of files) {
        const record = await this.api(`/api/uploads?kind=${kind}`, {method: 'POST', raw: file, headers: {'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name)}});
        if (kind === 'audio') p.audio = record;
        else if (kind === 'sound') p.sounds.push(record);
        else { const id = crypto.randomUUID(); ids.push(id); p.assets.push({...record, asset_id: id, asset_name: file.name.replace(/\.[^.]+$/, '').slice(0, 100), asset_description: '', type: 'character'}); }
        this.state.dirty = true;
      }
      await this.save();
    } finally { this.render(); }
    this.toast('文件已上传并保存。');
    if (kind === 'image' && this.state.autoDescribe) await this.describe(ids);
  }
  input(el) { if (el.id === 'auto-describe') this.state.autoDescribe = el.checked; }
  change(el) {
    if (el.id === 'vision-reuse') document.querySelector('#vision-fields').hidden = el.checked;
    if (el.id !== 'ai-preset' || el.value === 'current') return;
    const form = document.querySelector('#ai-config-form'), set = (name, value) => { form.elements.namedItem(name).value = value; };
    if (el.value === 'deepseek') {
      // Vision fields already contain the previously effective GPT connection.
      document.querySelector('#vision-reuse').checked = false; document.querySelector('#vision-fields').hidden = false;
      set('planner.url', 'https://api.deepseek.com/chat/completions'); set('planner.model', 'deepseek-chat'); set('planner.protocol', 'chat');
    } else {
      const previousGPT = [this.status.planner, this.status.vision].find(c => c.model.startsWith('gpt-'));
      set('planner.url', previousGPT?.url || 'https://api.openai.com/v1/responses'); set('planner.model', previousGPT?.model || ''); set('planner.protocol', previousGPT?.protocol || 'responses');
    }
    set('planner.apiKey', '');
  }
  async action(action, el) {
    if (action === 'open-ai') { await this.save(); this.state.view = 'ai'; this.render(); return true; }
    if (action === 'use-llm') { this.state.project.planner = 'llm'; this.state.dirty = true; this.render(); this.toast('已选择 LLM；重新规划前会单独确认费用。'); return true; }
    if (action === 'save-ai') {
      const form = document.querySelector('#ai-config-form'); if (!form.reportValidity()) return true;
      const fields = new FormData(form), part = role => ({url: fields.get(`${role}.url`), model: fields.get(`${role}.model`), protocol: fields.get(`${role}.protocol`), apiKey: fields.get(`${role}.apiKey`), clearKey: fields.has(`${role}.clearKey`)});
      await this.api('/api/ai/settings', {method: 'PUT', data: {revision: this.status.revision, planner: part('planner'), vision: {...part('vision'), sameAsPlanner: document.querySelector('#vision-reuse').checked}}});
      form.querySelectorAll('input[type="password"]').forEach(input => input.value = '');
      await this.refreshBootstrap(); this.render(); this.toast('AI 配置已保存并生效，未发起模型调用。'); return true;
    }
    if (['describe-one', 'describe-missing', 'describe-all'].includes(action)) {
      const assets = this.state.project.assets.filter(a => action === 'describe-one' ? a.asset_id === el.dataset.assetId : action === 'describe-missing' ? !a.asset_description?.trim() : true);
      await this.describe(assets.map(a => a.asset_id), action !== 'describe-missing' && assets.some(a => a.asset_description?.trim())); return true;
    }
    return false;
  }
}
