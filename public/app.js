import {AIUI} from './ai-ui.js';
const $ = s => document.querySelector(s);
const state = {bootstrap: null, project: null, view: 'home', step: 0, projectCards: {}, projectQuery: '', dirty: false, dirtyPlan: false, job: null, routes: null, execution: 'live', busy: false, productionPreview: null, autoDescribe: true, jobConcurrencyDraft: null};
Object.assign(state, {cardJobs:{}, jobVersions:[], jobExports:[], shotFilter:'all', openShot:null, promptDrafts:{}, managementError:''});
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {music:'M9 18V5l12-2v13M9 8l12-2M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6', grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z', sliders:'M4 21v-7m0-4V3m8 18V10m0-4V3m8 18v-5m0-4V3M1 14h6M9 6h6m2 10h6', film:'M3 3h18v18H3zM7 3v18M17 3v18M3 8h4m-4 8h4m10-8h4m-4 8h4', plus:'M12 5v14M5 12h14', upload:'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6', arrow:'M5 12h14m-6-6 6 6-6 6', check:'m5 12 4 4L19 6', play:'m8 4 12 8-12 8z', download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', close:'m6 6 12 12M6 18 18 6', refresh:'M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3', spark:'m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z'};
icons.moon='M20.5 13.3A8.5 8.5 0 0 1 10.7 3.5 8.5 8.5 0 1 0 20.5 13.3Z';
icons.sun='M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5';
const icon = name => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.grid}"/></svg>`;
const button = (label, action, cls = 'btn', extra = '') => `<button class="${cls}" data-action="${action}" ${extra}>${label}</button>`;
const seconds = n => `${Math.floor((n || 0) / 60).toString().padStart(2,'0')}:${Math.floor((n || 0) % 60).toString().padStart(2,'0')}`;
const statusText = s => ({submitting:'提交中',queued:'已提交 / 排队',running:'生成中',assembling:'正在组装',succeeded:'已完成',failed:'失败',needs_attention:'待处理',cancelled:'已停止',cancelling:'正在停止',pending:'等待中'}[s] || s);
async function api(path, {method = 'GET', data, headers = {}, raw} = {}) {
  const response = await fetch(path, {method, headers: {...(method !== 'GET' ? {'X-MV-Token': state.bootstrap?.token || ''} : {}), ...(data ? {'Content-Type':'application/json'} : {}), ...headers}, body: raw || (data ? JSON.stringify(data) : undefined)});
  const result = await response.json(); if (!response.ok) { const error = new Error(result.error || `请求失败 ${response.status}`); error.status=response.status; throw error; } return result;
}
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.className = `visible ${error ? 'error' : ''}`; clearTimeout(toast.timer); toast.timer = setTimeout(() => el.className = '', error ? 8500 : 4000); }
async function task(fn) { if (state.busy) return; state.busy = true; $('#app').inert = true; document.body.classList.add('busy'); try { await fn(); } catch (e) { toast(e.message, true); } finally { state.busy = false; $('#app').inert = false; document.body.classList.remove('busy'); } }
async function refreshBootstrap() { state.bootstrap = await api('/api/bootstrap'); }
async function selectProject(id) { state.project = await api(`/api/projects/${id}`); state.dirty = state.dirtyPlan = false; state.routes = null; state.jobConcurrencyDraft = null; state.job = state.project.activeJob ? await api(`/api/jobs/${state.project.activeJob}`) : null; }
async function save() {
  if (state.dirty) { state.project = await api(`/api/projects/${state.project.id}`, {method:'PATCH', data: state.project}); state.dirty = false; state.routes = null; }
  if (state.dirtyPlan) { state.project = await api(`/api/projects/${state.project.id}/plan`, {method:'PUT', data:{revision: state.project.revision, plan: state.project.plan}}); state.dirtyPlan = false; state.routes = null; }
  if (!state.project.plan && state.step > 0) state.step = 0;
  return state.project;
}
function label(text, body, help = '') { return `<label class="field"><span>${text}</span>${body}${help ? `<small>${help}</small>` : ''}</label>`; }
function select(name, options, current, attrs = '') { return `<select data-field="${name}" ${attrs}>${options.map(([v,t])=>`<option value="${v}" ${v===current?'selected':''}>${t}</option>`).join('')}</select>`; }
const aiUI = new AIUI({state, api, save, render, refreshBootstrap, toast, esc, label, icon, button});
function wave(audio, compact = false) {
  const values = audio?.waveform || Array.from({length:160}, (_,i)=>.12 + .3 * Math.abs(Math.sin(i * .7)) * Math.abs(Math.cos(i * .12)));
  return `<svg class="wave ${compact?'compact':''}" viewBox="0 0 800 64" preserveAspectRatio="none" role="img" aria-label="${audio?'音轨能量波形':'波形占位，上传后显示真实波形'}">${values.map((v,i)=>`<rect x="${i*5}" y="${32-Math.max(2,v*27)}" width="2.5" height="${Math.max(4,v*54)}" rx="1.25"/>`).join('')}</svg>`;
}
function shell(content) {
  const nav = [['home','music','创作工作台'],['projects','grid','我的项目'],['studio','film','分镜与剪辑'],['models','sliders','模型与路由'],['ai','spark','配置'],['production','play','成片服务']];
  const dark = document.documentElement.dataset.theme === 'dark';
  if(state.view==='shots')nav.push(['shots','film','分镜明细']);
  return `<aside class="sidebar"><a class="brand" href="/" aria-label="MV Agent 首页"><span class="brand-mark">${icon('music')}</span><span>MV Agent<small>音乐影像工作台</small></span></a><div class="workspace"><span class="status-dot"></span>本地创作空间</div><nav aria-label="主要导航">${nav.map(([id,ico,title])=>`<button data-view="${id}" class="nav-item ${state.view===id?'active':''}" ${state.view===id?'aria-current="page"':''}>${icon(ico)}<span>${title}</span></button>`).join('')}</nav></aside><div class="page"><header class="topbar"><span class="breadcrumb"><span>工作空间 <b>/</b> </span>${esc(nav.find(n=>n[0]===state.view)?.[2])}</span><div class="top-actions"><span class="safe-label"><span class="status-dot"></span>${state.bootstrap.capabilities.liveEnabled?'真实调用需确认':'真实调用未启用'}</span>${button(icon('plus')+' 新建项目','new','btn btn-small')}${button(icon(dark?'sun':'moon'),'theme','btn theme-button',`aria-label="切换到${dark?'浅色':'深色'}主题"`)}</div></header><main id="main" tabindex="-1">${content}</main></div>`;
}
async function loadProjectCards() {
  // Local GETs only. Fetch a bounded number at a time; never substitute historical snapshots.
  const pending = [...state.bootstrap.projects];
  async function worker() {
    while (pending.length) {
      const p = pending.shift();
      try {
        const detail = await api('/api/projects/'+p.id);
        state.projectCards[p.id] = detail;
        state.cardJobs[p.id] = detail.activeJob ? await api('/api/jobs/'+detail.activeJob) : null;
      } catch { state.cardJobs[p.id] = undefined; }
    }
  }
  await Promise.all(Array.from({length:Math.min(3,pending.length)},()=>worker()));
}
function projectCard(p) {
  const detail = p.id === state.project?.id ? state.project : state.projectCards[p.id];
  const cover = detail?.assets?.find(asset=>asset.url)?.url;
  const j=state.cardJobs[p.id];
  return `<article class="project-card panel"><button class="project-open" data-project="${esc(p.id)}" aria-label="编辑项目 ${esc(detail?.title||p.title)}"><div class="project-cover"><span class="cover-placeholder">${icon('film')}</span>${cover?`<img src="${esc(cover)}" alt="" loading="lazy" width="960" height="540"><span class="cover-label">参考资产</span>`:''}</div><div class="project-card-heading"><h3>${esc(detail?.title || p.title)}</h3>${detail?`<span class="subtle-tag">项目 r${detail.revision}</span>`:''}</div></button><div class="project-card-meta">${detail?`<span>${detail.audio?seconds(detail.audio.duration):'待上传原曲'}</span><span>当前计划 ${detail.plan?.storyboards.length || 0} 镜</span><span>${esc(detail.resolution)} · ${esc(detail.aspect_ratio)}</span>`:'<span>项目详情暂不可用</span>'}</div><div class="card-generation">${j?`<p>最近生成 · 快照 r${j.snapshot.revision}${j.snapshot.revision!==detail?.revision?' · 非当前项目版本':''}</p>${shotSummary(j)}<button class="btn btn-wide" data-job-project="${esc(p.id)}">分镜明细 · 修改提示词 / 重提 ${icon('arrow')}</button>`:j===null?'<p>尚未提交生成</p>':`<p>进度读取失败</p>${button('刷新进度','refresh-cards','btn btn-small')}`}</div></article>`;
}
function home() {
  return `<section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><h1 id="hero-title">让音乐，<br>长出<span>画面。</span></h1>${button('继续创作 '+icon('arrow'),'open-studio','btn primary')}</div>${$('#studio-art').innerHTML}</section><div class="section-heading"><h2>我的项目</h2>${button('查看全部 '+icon('arrow'),'open-projects','btn text-button')}</div><div class="project-grid">${state.bootstrap.projects.slice(0,4).map(projectCard).join('')}</div>`;
}
function steps() { return `<div class="steps">${['音轨与灵感','分镜脚本','模型生成','成片导出'].map((name,i)=>`<button data-step="${i}" class="step ${i===state.step?'current':''} ${i<state.step?'past':''}" ${i>0&&!state.project.plan?'disabled':''}><span>${i<state.step?icon('check'):String(i+1).padStart(2,'0')}</span>${name}<i></i></button>`).join('')}</div>`; }
function timeline() {
  const p = state.project, shots=p.plan?.storyboards || [], duration=p.audio?.duration || 0;
  return `<section class="timeline panel"><div class="panel-heading"><div><h3>原曲与镜头</h3></div><span class="mono muted">${seconds(0)} — ${seconds(duration)} / ${shots.length} 镜</span></div><div class="track"><span class="track-label">${icon('music')} 原曲</span><div class="track-body">${wave(p.audio,true)}</div></div><div class="track"><span class="track-label">${icon('film')} 镜头</span><div class="shot-track">${shots.length?shots.map((s,i)=>`<button data-focus-shot="${i}" style="flex:${s.duration}" title="镜头 ${i+1} · ${s.duration} 秒"><span>${String(i+1).padStart(2,'0')}</span><small>${s.duration}s</small></button>`).join(''):'<span class="empty-track">完成分镜规划后，镜头会按时长排列在这里</span>'}</div></div><div class="timeline-note">${p.audio?'镜头按歌词与叙事长短变化；上游生成时长与成片剪辑时长分开计算。节拍为能量估计，请试听审核。':'上传歌曲后读取真实时长与波形。最终导出保留原曲，不混入模型生成音轨。'}</div></section>`;
}
function settingsCompact() {
  const p=state.project, r=p.routing;
  return `<div class="settings-grid">${label('导出清晰度',select('resolution',[['720p','720p'],['1080p','1080p'],['2K','2K · 默认']],p.resolution))}${label('画面比例',select('aspect_ratio',[['16:9','16:9 横屏'],['9:16','9:16 竖屏'],['1:1','1:1 方形'],['4:3','4:3'],['3:4','3:4']],p.aspect_ratio))}</div>${label('每镜生成时长（秒）',`<input type="number" min="2" max="30" data-field="generationDuration" value="${p.generationDuration??15}">`,'默认申请 15 秒；按歌曲分镜时长裁切。支持范围由模型校验。')}<div class="rule"></div>${label('生成方式',select('generationMode',[['reference','多图参考 · 保持主体'],['i2v','严格首帧图生 · 单图'],['t2v','文生视频 · 不使用图片']],p.generationMode||'reference'))}${label('路由策略',select('routing.strategy',[['priority','首选模型 + 故障切换'],['manual','手动指定模型'],['cost','成本优先'],['latency','时延优先']],r.strategy))}${label('首选视频模型',select('routing.model',state.bootstrap.models.filter(m=>m.implemented&&m.modes.includes(p.generationMode||'reference')).map(m=>[m.id,m.name]),r.model))}<label class="toggle-line"><input type="checkbox" data-field="routing.allowFallback" ${r.allowFallback?'checked':''}><span>允许切换到其他合格模型<small>记录实际供应商；状态不明时不重复提交</small></span></label>`;
}
function compose() {
  const p=state.project;
  return `<div class="studio-grid"><div class="creative-col"><section class="panel"><div class="panel-heading"><h3><span class="section-mark">A</span>歌曲与歌词</h3><span class="subtle-tag">原曲保留</span></div>${label('项目名称',`<input data-field="title" maxlength="100" value="${esc(p.title)}" placeholder="为这支 MV 起个名字">`)}<label class="upload-zone ${p.audio?'has-file':''}"><input type="file" data-upload="audio" accept="audio/*" class="file-input"><span class="upload-icon">${icon(p.audio?'music':'upload')}</span><span><strong>${p.audio?esc(p.audio.name):'上传一首歌曲'}</strong><small>${p.audio?`${p.audio.duration.toFixed(2)} 秒 · 点击替换`:'MP3、WAV、M4A、FLAC、OGG · 最长 10 分钟'}</small></span><span class="upload-plus">${icon('plus')}</span></label>${p.audio?`<audio controls preload="metadata" src="${p.audio.url}" aria-label="播放原曲"></audio>`:''}${label('歌词时间轴',`<textarea data-field="lyrics" rows="4" placeholder="粘贴 LRC / SRT / VTT 时间歌词，或先用纯文本规划&#10;[00:00.00] 前奏&#10;[00:04.00] 第一行歌词">${esc(p.lyrics)}</textarea>`,'支持 LRC 时间点和 SRT / VTT 起止时间；保留前奏、间奏空白。纯文本仅均分估时。')}</section><section class="panel"><div class="panel-heading"><h3><span class="section-mark">B</span>视觉方向</h3></div>${label('统一画面风格',`<input data-field="style" value="${esc(p.style)}" placeholder="真实世界画面，电影感，暖色胶片">`)}<div class="style-chips">${['真实世界画面，电影感','2D 动画画面，手绘质感','3D 建模画面，蓝紫色夜景'].map(v=>`<button data-style="${v}" class="chip ${p.style===v?'selected':''}">${v.split('，')[0]}</button>`).join('')}</div>${label('你想讲一个什么故事？',`<textarea data-field="prompt" rows="4" placeholder="主角是谁？发生在哪里？随着歌曲，情绪和画面如何变化？">${esc(p.prompt)}</textarea>`)}<div class="settings-grid">${label('分镜规划',select('planner',[['llm',`LLM 创作 · ${state.bootstrap.capabilities.plannerConfigured?'已配置':'先配置 AI'}`],...(p.planner==='template'?[['template','已有旧模板（只读保留）']]:[])],p.planner))}<div class="planner-hint">${icon('spark')}<span>先审核脚本<br>再生成画面</span></div></div></section>${aiUI.plannerHint()}<section class="panel"><div class="panel-heading"><h3><span class="section-mark">C</span>角色与资产</h3><label class="btn btn-small file-button">${icon('plus')} 添加图片<input type="file" data-upload="image" accept="image/png,image/jpeg,image/webp" multiple class="file-input"></label></div><p class="helper">上传人物、场景或道具图片，AI 自动提取视觉细节，你只需检查结果。</p>${aiUI.assetControls()}<div class="assets-list">${p.assets.length?p.assets.map((a,i)=>aiUI.assetCard(a,i)).join(''):'<div class="empty-assets">'+icon('grid')+'<span>上传第一张参考图，建立整片的一致性。</span></div>'}</div><details class="sound-details"><summary>可选参考音频 <span>${p.sounds.length} / 3</span></summary><p class="helper">与原曲不同：用于 Q4 / H3 声音参考，每条 3–12 秒 MP3；最终成片仍使用原曲。</p>${p.sounds.map((a,i)=>`<div class="sound-item"><span>${esc(a.name)} · ${a.duration.toFixed(1)}s</span><input data-sound="${i}" value="${esc(a.remoteUrl||'')}" placeholder="H3 公网音频地址" aria-label="参考音频公网地址"><button class="icon-btn" data-remove-sound="${i}" aria-label="移除参考音频">${icon('close')}</button></div>`).join('')}<label class="btn btn-small">添加参考音频<input type="file" data-upload="sound" accept="audio/mpeg" class="file-input"></label></details></section></div><aside class="preview-col"><section class="preview-panel"><div class="preview-heading"><span>画面预览</span><span class="mono">${p.aspect_ratio} / ${p.resolution.toUpperCase()}</span></div><div class="preview-art"><div class="frame-corner tl"></div><div class="frame-corner tr"></div><div class="frame-corner bl"></div><div class="frame-corner br"></div><span class="preview-time mono">${seconds(p.audio?.duration)}</span><div class="vinyl"><div class="vinyl-core">${icon('music')}</div></div><div class="preview-caption"><h2>${esc(p.title==='未命名 MV'?'画面，从音乐开始。':p.title)}</h2><p>分镜确认后生成 · 此处不是模型成片</p></div></div><div class="preview-bottom">${wave(p.audio,true)}<span>音轨 → 叙事 → 画面</span></div></section><section class="panel routing-panel"><div class="panel-heading"><h3>生成设置</h3>${icon('sliders')}</div>${settingsCompact()}<div class="info-line">${icon('check')}<span>Q4 最短 3s / H3 最短 4s<br>短镜头生成后自动裁切对齐。</span></div></section><div class="quiet-note"><span class="tiny">先把故事讲清楚</span><p>镜头随歌词与叙事长短变化。<br>每镜生成 ${p.generationDuration??15}s，不等于固定切点。</p></div></aside></div>`;
}
function storyboards() {
  const p=state.project, plan=p.plan;
  if(!plan) return '<div class="empty">请先完成音轨、资产与分镜规划。</div>';
  return `<div class="section-toolbar"><div><h2>分镜脚本</h2><p>${plan.storyboards.length} 个镜头 · ${plan.storyboards.reduce((n,s)=>n+s.duration,0)} 秒剪辑时间 · 原曲 ${p.audio.duration.toFixed(2)} 秒</p></div><div class="toolbar-actions"><a class="btn" href="/api/projects/${p.id}/storyboards">${icon('download')} 导出 JSON</a>${button(icon('refresh')+' 重新规划','plan')}</div></div>${plan.warnings?.map(x=>`<p class="notice">${esc(x)}</p>`).join('')||''}<details class="outline panel" open><summary>创作概要 <span>兼容字段 COT · 仅展示故事方案</span></summary><p>${esc(plan.COT).replace(/\n/g,'<br>')}</p></details><div class="storyboard-list">${plan.storyboards.map((s,i)=>`<article class="storyboard panel" id="shot-${i}"><div class="shot-thumbnail"><img src="${p.assets.find(a=>a.asset_id===s.assets[0])?.url || ''}" alt="镜头 ${i+1} 的参考资产"><span>参考图 · 非生成画面</span><b class="shot-number">${String(i+1).padStart(2,'0')}</b></div><div class="shot-editor"><div class="shot-top"><h3>镜头 ${String(i+1).padStart(2,'0')}</h3><span class="mono muted">${seconds(s.start)} — ${seconds(s.start+s.duration)}</span><label class="duration">剪辑 <input data-shot="${i}" data-key="duration" type="number" min="2" max="${plan.timingVersion===2?Math.min(15,p.generationDuration??15):8}" step="1" value="${s.duration}" aria-label="镜头 ${i+1} 时长"> s</label></div><label class="lyric-line"><span>歌词</span><input data-shot="${i}" data-key="lyric_text" aria-label="镜头 ${i+1} 歌词" value="${esc(s.lyric_text)}"></label><textarea data-shot="${i}" data-key="prompt" rows="4" aria-label="镜头 ${i+1} 提示词">${esc(s.prompt)}</textarea><div class="asset-bindings"><span class="muted">参考资产</span>${p.assets.map(a=>`<label><input type="checkbox" data-shot-asset="${i}" value="${esc(a.asset_id)}" ${s.assets.includes(a.asset_id)?'checked':''}>${esc(a.asset_name)}</label>`).join('')}</div></div></article>`).join('')}</div>`;
}
function generation() {
  const p=state.project,j=state.job;
  return `<div class="generation-grid"><section class="panel"><div class="panel-heading"><h3>模型与路由</h3><span class="subtle-tag">${state.bootstrap.models.filter(m=>m.implemented).length} 个适配器</span></div>${settingsCompact()}<div class="settings-grid">${label('每供应商最多提交次数',`<input type="number" min="1" max="3" data-field="routing.maxAttempts" value="${p.routing.maxAttempts}">`)}${label('新任务默认并发',`<input type="number" min="1" max="5" data-field="routing.concurrency" value="${p.routing.concurrency}">`)}</div><p class="notice">仅真实模型生成 · 每次提交需确认费用。失败会停止后续镜头，不会生成本地替代片。</p>${button('检查路由','route','btn btn-wide')}</section><section class="panel route-results"><div class="panel-heading"><h3>逐镜路由预览</h3></div>${state.routes?state.routes.map(r=>`<div class="route-row"><span class="mono">${String(r.shotId+1).padStart(2,'0')}</span><div><strong>${esc(r.chosen?.name || '无可用模型')}</strong>${r.chosen?`<small>任务生成 ${r.chosen.generationDuration}s · 剪辑使用 ${r.chosen.trimDuration}s · ${esc(p.resolution)}</small>`:''}<p>${r.notes.map(esc).join(' · ') || '按当前设置选择'}</p>${!r.chosen?r.rejected.map(x=>`<small>${esc(x.model)}：${esc(x.reason)}</small>`).join(''):''}<small>后备：${r.candidates.slice(1).map(x=>esc(x.name)).join(' → ')||'无'}${r.chosen?.estimatedCost!=null?' · 估算 ¥'+r.chosen.estimatedCost.toFixed(2):''}</small></div><span class="badge ${r.chosen?'ok':'warn'}">${r.chosen?'可路由':'需配置'}</span></div>`).join(''):'<div class="empty-route">'+icon('sliders')+'<h3>先检查，再生成。</h3><p>查看每镜选择、约束过滤和故障后备顺序。</p></div>'}</section></div>${j?jobPanel(j):''}`;
}
function jobPanel(j) { return `<section class="panel job-panel"><div class="panel-heading"><h3>${esc(statusText(j.status))}</h3><div class="toolbar-actions">${button('逐镜进度 / 提示词 / 重提','shot-manager')}${['queued','running','assembling'].includes(j.status)?button('停止本地任务','cancel'):''}</div></div>${shotSummary(j)}<p>${esc(j.message)}</p><p class="helper">当前任务并发 ${j.concurrency??j.snapshot.routing.concurrency} · 本地下载 / 转码最多 2 路</p>${['queued','running','cancelled','failed','needs_attention'].includes(j.status)?`<div class="toolbar-actions"><label class="duration">调整当前任务并发 <input id="job-concurrency" type="number" min="1" max="5" step="1" value="${state.jobConcurrencyDraft??j.concurrency??j.snapshot.routing.concurrency}" aria-label="当前任务并发"></label>${button('应用并发','job-concurrency','btn btn-small')}</div>`:''}<details><summary>任务记录</summary><ol class="events">${(j.events||[]).slice(-12).map(e=>`<li><time>${new Date(e.at).toLocaleTimeString('zh-CN')}</time>${esc(e.message)}</li>`).join('')}</ol></details></section>`; }
function exportsView() {
  const j=state.job;
  if(j?.exports?.length)return managedExports(j.exports)+jobPanel(j);
  if(!j?.output)return `<section class="panel"><h2>尚无任务组装文件</h2><p>留黑版由独立导出生成；新版服务会读取已验证回执，不会把缺镜标为成功。</p>${!state.bootstrap.capabilities.shotManagement?'<p class="notice">手动重启工作台后，可在此查看已交付的留黑版。</p>':''}</section>${j?jobPanel(j):''}`;
  return `<section class="panel managed-exports"><h2>${esc(j.snapshot.title)} · 任务组装文件</h2><video controls preload="none" src="${esc(j.video_url||'/media/'+j.output)}" aria-label="任务组装文件"></video><p class="notice">旧组装文件尚未读取到独立原曲对齐验收回执，不代表音画已通过验收。</p><a class="btn" download href="${esc(j.video_url||'/media/'+j.output)}">下载任务文件</a></section>${jobPanel(j)}`;
}
function actionbar() {
  const actions=[['生成分镜脚本','plan'],['保存并检查路由','to-generation'],['确认并开始真实生成','generate'],['返回分镜编辑','back-storyboard']];
  const [title,action]=actions[state.step];
  return `<div class="actionbar"><span><i class="save-dot ${state.dirty||state.dirtyPlan?'unsaved':''}"></i>${state.dirty||state.dirtyPlan?'有未保存的修改':'项目已保存在本机'}<small>${state.step===0?'下一步：检查故事与镜头':'不修改原始上传文件'}</small></span><div>${button('保存项目','save')}${button(title+' '+icon('arrow'),action,'btn primary')}</div></div>`;
}
function studio() { return `<div class="page-heading"><div><h1>${esc(state.project.title)}</h1><p>${state.project.audio?seconds(state.project.audio.duration)+' · ':''}${esc(state.project.resolution)} · r${state.project.revision}</p></div></div>${steps()}${state.step===0?compose():state.step===1?storyboards():state.step===2?generation():exportsView()}${timeline()}${actionbar()}`; }
function models() { return `<div class="page-heading"><h1>模型与路由</h1></div><section class="model-grid">${state.bootstrap.models.map((m,i)=>`<article class="panel model-card"><div class="model-card-top"><span class="model-mark mark-${i}">${m.id.startsWith('wan')?'W':m.id.startsWith('vidu')?'V':m.id.startsWith('minimax')?'M':'S'}</span><span class="badge ${m.configured?'ok':'warn'}">${m.credentialConfigured?(m.implemented?'密钥已配置':'密钥已存 · 流程禁用'):'待配置密钥'}</span></div><h2>${m.name}</h2><code>${m.model}</code><p>${m.note}</p>${m.disabledReason?`<p class="notice">${esc(m.disabledReason)}</p>`:''}<div class="model-specs"><span><strong>${m.maxDuration==null?'待确认':m.minDuration+'–'+m.maxDuration+'s'}</strong>上游时长</span><span><strong>${m.maxImages==null?'待确认':'≤ '+m.maxImages+' 张'}</strong>参考图</span></div><small class="env-label">服务端变量 <code>${m.credentialEnv}</code></small><div class="rule"></div>${label('综合成本 元 / 生成秒',`<input type="number" min="0" step="0.001" data-metric="${m.id}" data-key="costPerSecond" value="${m.metrics.costPerSecond??''}" placeholder="未知，留空">`)}${label('同类镜头实测时延 秒',`<input type="number" min="0" step="0.1" data-metric="${m.id}" data-key="latencySeconds" value="${m.metrics.latencySeconds??''}" placeholder="未知，留空">`)}</article>`).join('')}</section><section class="panel metric-note"><h3>只比较同一口径的数据</h3><p>成本应按相同画质和参考资产复杂度校准，包含参考输入及重试的分摊；时延使用同类镜头实测值。未填写的模型不参与对应排名，0 是有效值，不代表未知。</p>${button('保存路由基准','save-metrics','btn primary')}</section>${aiUI.plannerHint()}<section class="panel config-note"><h3>视频调用与图片地址</h3>${button('重新读取服务端配置','reload-video','btn btn-small')}<p>视频模型仍使用服务端密钥和真实调用开关，每次生成都需确认。Q4 直接使用本地图片；Wan / H3 需要对应的公网地址，未配置对象存储时不会自动发布图片。</p></section>`; }
function projectResults() {
  const matches=state.bootstrap.projects.filter(p=>p.title.toLocaleLowerCase().includes(state.projectQuery.toLocaleLowerCase().trim()));
  return matches.length?matches.map(projectCard).join(''):'<div class="empty panel"><h2>没有匹配的项目</h2><p>换个名称搜索，或新建项目。</p></div>';
}
function projects() { return `<div class="page-heading"><h1>我的项目</h1><label class="project-search"><span class="sr-only">查找项目</span><input id="project-search" type="search" placeholder="搜索项目…" value="${esc(state.projectQuery)}" autocomplete="off"></label></div><div class="project-grid" id="project-grid">${projectResults()}</div>`; }
function production() { return `<div class="page-heading"><div><h1>成片服务</h1><p>短剧与解说剧 · 独立于 MV 逐镜生成</p></div></div><div class="production-grid"><form id="production-form" class="panel"><div class="panel-heading"><h3>成片请求</h3><span class="subtle-tag">资产来自当前项目</span></div><div class="settings-grid">${label('服务',`<select name="service"><option value="short-play">短剧成片</option><option value="explain-comic">解说剧成片</option></select>`)}${label('区域',`<select name="region"><option value="cn">国内 · 支持执行</option><option value="global">海外 · 仅请求预览</option></select>`)}</div>${label('剧名',`<input name="script_name" maxlength="20" required placeholder="20 字以内">`)}${label('剧本',`<textarea name="script_content" rows="6" required placeholder="填写剧情。请勿把整曲歌词作为口播剧本提交。"></textarea>`)}<div class="settings-grid">${label('档位',`<select name="quality"><option value="standard">standard</option><option value="high">high</option></select>`)}${label('分辨率',`<select name="resolution"><option value="1080p">1080p</option><option value="720p">720p · 仅解说剧</option></select>`)}${label('画幅',`<select name="aspect_ratio"><option value="16:9">16:9</option><option value="9:16">9:16</option></select>`)}${label('无标点风格',`<input name="style" value="真人写实" maxlength="30">`)}</div><div class="settings-grid">${label('短剧规划时长',`<input name="duration" type="number" min="0" max="30" value="0">`,'0 表示自动；国内 2–30s；海外 8–12s。')}${label('解说语速',`<input name="tts_speed" type="number" min="1" max="1.5" step="0.1" value="1.1">`)}</div><p class="helper">国内短剧：standard 28 / high 58 积分每秒；国内解说：20 / 25 积分每秒。最终时长可能浮动，以供应商账单为准。</p><div class="toolbar-actions">${button('预览请求','production-preview')}${button('确认并调用国内服务','production-create','btn primary')}</div></form><div><section class="panel"><h3>接口预览</h3><p class="helper">只展示结构，不展示密钥或图片 Base64。海外查询文档有缺口，暂不发起海外付费任务。</p><pre id="production-preview">${esc(state.productionPreview?JSON.stringify(state.productionPreview,null,2):'选择服务并填写剧本，预览参数映射。')}</pre></section><section class="panel"><h3>成片任务</h3><div id="production-tasks">${productionTasks()}</div></section></div></div>`; }
function productionTasks() { return state.bootstrap.productions.length?state.bootstrap.productions.map(p=>`<div class="production-task"><strong>${esc(p.title)}</strong><span class="badge">${statusText(p.state)}</span><p>${esc(p.service)} ${esc(p.remoteId||'创建状态待核对')}</p>${p.remoteId?`<button class="btn btn-small" data-refresh-production="${p.id}">查询最新状态</button>`:''}${p.video_url?`<a class="btn btn-small" href="${esc(p.video_url)}" target="_blank" rel="noopener noreferrer">打开成片 ↗</a>`:''}${p.error?`<p class="notice">${esc(p.error)}</p>`:''}</div>`).join(''):'<p class="helper">尚未提交成片服务任务。</p>'; }
function shotCounts(j) {
  return {total:j.shots.length, accepted:j.shots.filter(s=>s.history?.some(h=>h.remoteId)).length,
    success:j.shots.filter(s=>s.state==='succeeded'&&s.output).length,
    unknown:j.shots.filter(s=>s.uncertainCreate).length, failed:j.shots.filter(s=>s.state==='failed'&&!s.uncertainCreate).length,
    pending:j.shots.filter(s=>s.state==='pending'&&!s.attempts&&!s.history?.length).length};
}
function shotSummary(j) {
  const c=shotCounts(j);
  return `<div class="shot-counts"><strong>成功 ${c.success} / ${c.total} 镜</strong><span>计划 ${c.total} · 历史确认受理 ${c.accepted}</span><span>失败 ${c.failed} · 创建不明 ${c.unknown} · 未提交 ${c.pending}</span><span>任务组装文件 ${j.output?1:0}${j.exports?` · 校准版 ${j.exports.filter(e=>e.kind==='aligned').length} · 留黑版 ${j.exports.filter(e=>e.kind==='gap-draft').length}`:' · 独立导出需新版服务读取'}</span></div><div class="shot-ribbon" aria-label="逐镜状态：${c.success} 镜成功，${c.total-c.success} 镜未完成">${j.shots.map(s=>`<span class="${s.state==='succeeded'?'ready':s.uncertainCreate?'unknown':'missing'}" style="flex:${j.snapshot.plan.storyboards[s.id]?.duration||1}" title="第 ${s.id+1} 镜 · ${s.uncertainCreate?'创建不明':statusText(s.state)}"></span>`).join('')}</div>`;
}
async function loadJobManagement(jobId=state.job?.id) {
  state.managementError='';
  if(state.bootstrap.capabilities.shotManagement){
    const result=await api(`/api/projects/${state.project.id}/jobs`);state.jobVersions=result.jobs;
  }else state.jobVersions=state.job?[{id:state.job.id,revision:state.job.snapshot.revision,status:state.job.status}]:[];
  if(jobId){state.job=await api('/api/jobs/'+jobId);state.jobExports=state.job.exports||[];}
  else {state.job=null;state.jobExports=[];}
}
const draftKey=(j,id)=>`${j.id}/${id}`;
function pendingRevision(j,id) { try { return JSON.parse(sessionStorage.getItem('mv-revision/'+draftKey(j,id))||'null'); } catch { return {unreadable:true}; } }
function retryBlock(j,s) {
  if(!state.bootstrap.capabilities.shotManagement)return '服务尚未加载单镜版本功能；手动重启工作台后刷新即可使用。';
  if(!['failed','needs_attention','succeeded'].includes(j.status))return '任务执行中或已作废，不能重提。';
  if(state.jobVersions[0]?.id!==j.id)return '这是历史版本，请先切换到最新生成版本。';
  if(j.shots.some(x=>x.remoteId&&x.state!=='succeeded'))return '有已受理结果尚未收回，需先核对上游，不新建请求。';
  if(pendingRevision(j,s.id))return '上次提交结果待核对。点击刷新；未查清前不会发起第二笔请求。';
  if(s.uncertainCreate)return '';
  if(s.state==='succeeded'&&s.output)return '';
  if(!s.output&&!s.remoteId&&(s.state==='pending'&&!s.attempts&&!s.history?.length||s.state==='failed'&&s.history?.at(-1)?.remoteId&&s.history.at(-1).state==='failed'))return '';
  return '不是上游明确失败或从未提交的镜头，请先核对创建记录。';
}
function shotDetails(j,s) {
  const shot=j.snapshot.plan.storyboards[s.id], draft=state.promptDrafts[draftKey(j,s.id)]??shot.prompt, block=retryBlock(j,s);
  return `<div class="shot-detail-body">${s.output?`<video controls preload="none" src="/media/${esc(s.output)}" aria-label="第 ${s.id+1} 镜生成素材"></video>`:'<div class="shot-no-media">此镜尚无成功素材 · 留黑版在此保留原时长</div>'}<dl class="shot-facts"><dt>模型 / 规格</dt><dd>${esc(s.model||j.routes?.[s.id]?.chosen?.model||'待提交')} · ${esc(j.snapshot.resolution)} · ${esc(j.snapshot.aspect_ratio)}</dd><dt>生成 / 剪辑</dt><dd>${s.generationDuration??j.routes?.[s.id]?.chosen?.generationDuration??'—'}s / ${shot.duration}s</dd><dt>累计创建次数</dt><dd>${s.attempts}</dd><dt>当前上游 ID</dt><dd>${esc(s.remoteId||'无；历史 ID 见下方记录')}</dd></dl>${s.error?`<p class="notice">${esc(s.error)}</p>`:''}<details class="actual-prompt"><summary>查看本版本实际使用的提示词</summary><p>${esc(shot.prompt)}</p></details><label class="field"><span>修改提示词 · 用于下一次单镜重提</span><textarea data-revision-prompt="${s.id}" rows="6" maxlength="20000" aria-label="第 ${s.id+1} 镜重提提示词">${esc(draft)}</textarea><small>草稿仅保留在本页；确认重提后另建生成版本，不修改当前项目脚本。请保留统一风格开头和参考资产的完整描述。</small></label>${s.uncertainCreate?'<p class="notice">旧请求超时，可能已计费；重提必须另行确认重复计费风险。</p>':''}${block?`<p class="helper">${esc(block)}</p>`:''}<button class="btn primary" data-retry-shot="${s.id}" ${block?'disabled':''}>确认费用并重提此镜</button><details class="shot-history"><summary>请求历史 · ${(s.history||[]).length} 条</summary>${(s.history||[]).map(h=>`<div><strong>第 ${h.attempt??'—'} 次 · ${esc(statusText(h.state))}</strong><p>${esc(h.at||'')} · ${esc(h.model||'')} · ID ${esc(h.remoteId||'未取得')}</p>${h.error?`<p>${esc(h.error)}</p>`:''}${h.prompt?`<details><summary>本次请求提示词</summary><p>${esc(h.prompt)}</p></details>`:''}</div>`).join('')||'<p>从未提交，无请求记录。</p>'}</details></div>`;
}
function managedExports(exports=state.jobExports) {
  return exports.length?`<section class="panel managed-exports"><h2>本版本成片</h2>${exports.map(e=>`<details><summary>${e.kind==='gap-draft'?'留黑版':'原曲时间轴校准版'} · ${e.successfulShots} / ${e.totalShots} 镜成功 · ${e.verifiedAt?esc(new Date(e.verifiedAt).toLocaleString('zh-CN')):'验收回执'}</summary><p>${Number(e.duration).toFixed(3)} 秒 · ${esc(e.resolution)} ${esc(e.aspect_ratio)}</p><video controls preload="none" src="${esc(e.video_url)}" aria-label="${e.kind==='gap-draft'?'留黑版':'校准版'}成片"></video><p>${e.gaps.length?'留黑：'+e.gaps.map(g=>`第 ${g.shot} 镜 ${seconds(g.start)}–${seconds(g.end)}`).join('；'):'全部分镜均有成功素材'}</p><a class="btn" download href="${esc(e.video_url)}">下载 MP4</a></details>`).join('')}</section>`:'';
}
function shotManager() {
  const j=state.job;
  if(!j)return '<section class="panel empty"><h1>尚未提交生成</h1></section>';
  const c=shotCounts(j), shots=j.shots.filter(s=>state.shotFilter==='all'||(state.shotFilter==='missing'?s.state!=='succeeded':s.state==='succeeded'));
  return `<div class="page-heading"><div><h1>${esc(j.snapshot.title)} · 分镜明细</h1><p>生成快照 r${j.snapshot.revision} · 当前项目 r${state.project.revision} · ${esc(statusText(j.status))}</p></div><div class="toolbar-actions">${button('返回我的项目','open-projects')}${button(icon('refresh')+' 刷新进度','refresh-shots')}</div></div>${!state.bootstrap.capabilities.shotManagement?'<p class="notice">当前服务为旧版：进度与请求历史可查看，提示词可编辑为本页草稿。单镜重提、历史版本和留黑版列表需手动重启工作台，再点击刷新。不会自动发起付费请求。</p>':''}${state.managementError?`<p class="notice">${esc(state.managementError)}</p>`:''}<section class="panel"><label class="field"><span>生成版本（不改当前项目）</span><select id="job-version">${state.jobVersions.map(v=>`<option value="${esc(v.id)}" ${j.id===v.id?'selected':''}>${v.parentJobId?'单镜修订':'原始任务'} · r${v.revision} · ${v.id.slice(0,8)} · ${statusText(v.status)}</option>`).join('')}</select></label><p class="helper">任务 ${esc(j.id)}${j.parentJobId?' · 基于 '+esc(j.parentJobId):''}</p>${shotSummary(j)}<p class="helper">受理数按历史上游 ID 去重到镜头统计，不代表本轮全部受理。缺口 ${c.total-c.success} 镜不会被计为成功。</p></section>${managedExports()}<div class="section-toolbar"><h2>逐镜记录</h2><div class="toolbar-actions" aria-label="分镜筛选">${[['all','全部'],['missing','未完成'],['success','成功']].map(([value,title])=>`<button class="btn ${state.shotFilter===value?'primary':''}" data-shot-filter="${value}" aria-pressed="${state.shotFilter===value}">${title}</button>`).join('')}</div></div><div class="shot-records">${shots.map(s=>{const b=j.snapshot.plan.storyboards[s.id];return `<article class="panel shot-record" id="record-${s.id}"><button class="shot-record-toggle" data-inspect-shot="${s.id}" aria-expanded="${state.openShot===s.id}"><strong>第 ${String(s.id+1).padStart(2,'0')} 镜</strong><span>${seconds(b.start)}–${seconds(Math.min(b.start+b.duration,j.snapshot.audio.duration))}</span><span class="badge ${s.state==='succeeded'?'ok':'warn'}">${s.uncertainCreate?'创建不明':statusText(s.state)}</span><span>${state.openShot===s.id?'收起':'提示词 / 历史 / 重提'}</span></button>${state.openShot===s.id?shotDetails(j,s):''}</article>`;}).join('')||'<p class="panel">此筛选下没有镜头。</p>'}</div>`;
}
async function retryOneShot(id) {
  const j=state.job, s=j.shots.find(s=>s.id===id), block=retryBlock(j,s);
  if(block)throw Error(block);
  const prompt=state.promptDrafts[draftKey(j,id)]??j.snapshot.plan.storyboards[id].prompt;
  if(!prompt.trim())throw Error('提示词不能为空');
  if(!confirm(`只重提第 ${id+1} 镜，将发送当前编辑框中的提示词并产生费用。新建一个生成版本，每镜本轮最多创建一次，其他成功素材和原版本保留。确认？`))return;
  const acceptDuplicateBilling=s.uncertainCreate?confirm(`第 ${id+1} 镜旧请求可能已成功并计费。接受可能重复计费，并仅授权重新创建这一个镜头？`):false;
  if(s.uncertainCreate&&!acceptDuplicateBilling)return;
  const key=crypto.randomUUID(), data={shotId:id,prompt,confirmPaid:true,acceptDuplicateBilling,expectedAttempts:s.attempts,expectedUpdatedAt:j.updatedAt,projectRevision:state.project.revision};
  const storageKey='mv-revision/'+draftKey(j,id);
  sessionStorage.setItem(storageKey,JSON.stringify({key,data}));
  try {
    const child=await api(`/api/jobs/${j.id}/revise-shot`,{method:'POST',headers:{'Idempotency-Key':key},data});
    sessionStorage.removeItem(storageKey);state.openShot=id;await loadJobManagement(child.id);render();toast('单镜重提已登记；是否受理由新上游 ID 确认。');
  }catch(e){if(e.status>=400&&e.status<500)sessionStorage.removeItem(storageKey);render();throw e;}
}
function render() { if(!state.project||!state.bootstrap)return; $('#app').innerHTML=shell(state.view==='shots'?shotManager():state.view==='home'?home():state.view==='studio'?studio():state.view==='models'?models():state.view==='projects'?projects():state.view==='ai'?aiUI.config():production()); }
async function upload(files, kind) { return aiUI.upload(files, kind); }

document.addEventListener('input', e=>{
  const el=e.target;
  if(el.dataset.revisionPrompt!==undefined){state.promptDrafts[draftKey(state.job,Number(el.dataset.revisionPrompt))]=el.value;return;}
  if(el.id==='project-search'){state.projectQuery=el.value;$('#project-grid').innerHTML=projectResults();return;}
  aiUI.input(el);
  if(el.dataset.field){ const keys=el.dataset.field.split('.'); let target=state.project; for(const k of keys.slice(0,-1))target=target[k]; target[keys.at(-1)]=el.type==='checkbox'?el.checked:el.type==='number'?Number(el.value):el.value; state.dirty=true; }
  if(el.dataset.asset!==undefined){state.project.assets[Number(el.dataset.asset)][el.dataset.key]=el.value;state.dirty=true;}
  if(el.dataset.sound!==undefined){state.project.sounds[Number(el.dataset.sound)].remoteUrl=el.value;state.dirty=true;}
  if(el.id==='job-concurrency'){state.jobConcurrencyDraft=Number(el.value);}
  if(el.dataset.shot!==undefined){state.project.plan.storyboards[Number(el.dataset.shot)][el.dataset.key]=el.type==='number'?Number(el.value):el.value;state.dirtyPlan=true;}
  if(el.dataset.shotAsset!==undefined){const shot=state.project.plan.storyboards[Number(el.dataset.shotAsset)];shot.assets=el.checked?[...shot.assets,el.value]:shot.assets.filter(id=>id!==el.value);state.dirtyPlan=true;}
  if(el.dataset.field==='generationMode'){const m=state.bootstrap.models.find(m=>m.implemented&&m.modes.includes(el.value));if(m)state.project.routing.model=m.id;state.routes=null;render();}
  const dot=$('.save-dot');if(dot&&(state.dirty||state.dirtyPlan))dot.classList.add('unsaved');
});
document.addEventListener('change',e=>{if(e.target.id==='job-version'){task(async()=>{state.openShot=null;await loadJobManagement(e.target.value);render();});return;}aiUI.change(e.target);if(e.target.dataset.upload)task(()=>upload([...e.target.files],e.target.dataset.upload));});
document.addEventListener('submit',e=>e.preventDefault());
document.addEventListener('click',event=>{
  const el=event.target.closest('button,[data-action]');if(!el)return;
  if(el.dataset.action==='theme'){
    const dark=document.documentElement.dataset.theme!=='dark';
    document.documentElement.dataset.theme=dark?'dark':'light';
    document.querySelector('meta[name="theme-color"]').content=dark?'#251e23':'#f5e9ed';
    el.innerHTML=icon(dark?'sun':'moon');el.setAttribute('aria-label',`切换到${dark?'浅色':'深色'}主题`);
    return;
  }
  if(el.dataset.style){state.project.style=el.dataset.style;state.dirty=true;render();return;}
  if(el.dataset.removeAsset!==undefined){state.project.assets.splice(Number(el.dataset.removeAsset),1);state.dirty=true;render();return;}
  if(el.dataset.removeSound!==undefined){state.project.sounds.splice(Number(el.dataset.removeSound),1);state.dirty=true;render();return;}
  task(async()=>{
    if(el.dataset.jobProject){await save();await selectProject(el.dataset.jobProject);await loadJobManagement();state.openShot=null;state.shotFilter='all';state.view='shots';render();window.scrollTo(0,0);return;}
    if(el.dataset.inspectShot!==undefined){const id=Number(el.dataset.inspectShot);state.openShot=state.openShot===id?null:id;render();$(`[data-inspect-shot="${id}"]`)?.focus({preventScroll:true});return;}
    if(el.dataset.shotFilter){state.shotFilter=el.dataset.shotFilter;render();return;}
    if(el.dataset.retryShot!==undefined){await retryOneShot(Number(el.dataset.retryShot));return;}
    if(el.dataset.view||['open-studio','open-projects'].includes(el.dataset.action)){await save();state.view=el.dataset.view||(el.dataset.action==='open-studio'?'studio':'projects');await refreshBootstrap();if(['home','projects'].includes(state.view))await loadProjectCards();render();const heading=$('main h1');heading?.setAttribute('tabindex','-1');heading?.focus({preventScroll:true});window.scrollTo(0,0);return;}
    if(el.dataset.project){await save();await selectProject(el.dataset.project);state.view='studio';state.step=0;render();return;}
    if(el.dataset.step!==undefined){await save();state.step=Number(el.dataset.step);render();return;}
    if(el.dataset.focusShot!==undefined){await save();state.step=1;render();$(`#shot-${el.dataset.focusShot}`)?.scrollIntoView({behavior:'smooth',block:'center'});return;}
    if(el.dataset.refreshProduction){const p=await api(`/api/productions/${el.dataset.refreshProduction}/refresh`,{method:'POST',data:{}});state.bootstrap.productions=state.bootstrap.productions.map(x=>x.id===p.id?p:x);$('#production-tasks').innerHTML=productionTasks();return;}
    const action=el.dataset.action;
    if(action==='refresh-cards'){await refreshBootstrap();await loadProjectCards();render();return;}
    if(action==='shot-manager'){await save();await loadJobManagement();state.view='shots';render();return;}
    if(action==='refresh-shots'){
      const parent=state.job;await refreshBootstrap();state.project=await api('/api/projects/'+state.project.id);await loadJobManagement(parent.id);
      for(const s of parent.shots){const pending=pendingRevision(parent,s.id);if(!pending)continue;const found=state.jobVersions.find(v=>v.idempotencyKey===pending.key);if(found){sessionStorage.removeItem('mv-revision/'+draftKey(parent,s.id));await loadJobManagement(found.id);toast('已核对到上次提交的新版本，未重复发送。');break;}}
      render();return;
    }
    if(await aiUI.action(action,el))return;
    if(action==='new'){await save();const p=await api('/api/projects',{method:'POST',data:{}});await selectProject(p.id);await refreshBootstrap();state.view='studio';state.step=0;render();}
    if(action==='save'){await save();render();toast('项目已保存');}
    if(action==='plan'){await save();if(state.project.planner==='llm'&&!state.bootstrap.capabilities.plannerConfigured){state.view='ai';render();toast('请先保存远程 LLM 连接，配置不会自动调用。',true);return;}const missing=state.project.assets.filter(a=>!a.asset_description?.trim()).map(a=>a.asset_id);if(missing.length&&!await aiUI.describe(missing))return;const confirmed=state.project.planner!=='llm'||confirm('LLM 规划将发送提示词与资产描述到配置的服务，可能产生费用。是否继续？');if(!confirmed)return;state.project=await api(`/api/projects/${state.project.id}/plan`,{method:'POST',data:{revision:state.project.revision,confirmPaid:state.project.planner==='llm'}});state.step=1;render();toast('分镜已生成，请逐镜审核。');}
    if(action==='to-generation'||action==='route'){await save();if(!state.project.plan)throw Error('输入发生变化，请重新规划分镜');state.routes=(await api(`/api/projects/${state.project.id}/route`,{method:'POST',data:{execution:state.execution}})).routes;state.step=2;render();}
    if(action==='generate'){await save();const live=state.execution==='live';if(live&&!confirm('即将向所选模型供应商发送参考资产与提示词，并产生实际费用。重试和故障切换可能额外计费。确认开始？'))return;state.job=await api('/api/jobs',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},data:{projectId:state.project.id,revision:state.project.revision,execution:state.execution,confirmPaid:live}});render();}
    if(action==='job-concurrency'){const concurrency=Number($('#job-concurrency').value);if(!Number.isInteger(concurrency)||concurrency<1||concurrency>5)throw Error('并发应为 1–5');if(!confirm('调整并发会改变未完成镜头的提交速度，可能更快产生费用；已受理任务不会重新创建。继续？'))return;state.job=await api(`/api/jobs/${state.job.id}/concurrency`,{method:'POST',data:{concurrency,confirmPaid:true}});state.jobConcurrencyDraft=null;render();toast('当前任务并发已更新，已有镜头与任务 ID 保留。');}
    if(action==='cancel'){await api(`/api/jobs/${state.job.id}/cancel`,{method:'POST',data:{}});toast('正在停止本地任务。上游已提交任务可能继续计费。');}
    if(action==='back-storyboard'){state.step=1;render();}
    if(action==='reload-video'){await api('/api/config/reload',{method:'POST',data:{}});await refreshBootstrap();state.routes=null;render();toast('服务端配置已重新读取，未调用模型');}
    if(action==='save-metrics'){const metrics={};document.querySelectorAll('[data-metric]').forEach(input=>{metrics[input.dataset.metric]||={};metrics[input.dataset.metric][input.dataset.key]=input.value===''?null:Number(input.value);});const result=await api('/api/metrics',{method:'PUT',data:metrics});state.bootstrap.models=result.models;render();toast('路由基准已保存');}
    if(action==='production-preview'||action==='production-create'){const form=$('#production-form');if(!form.reportValidity())return;const input={...Object.fromEntries(new FormData(form)),projectId:state.project.id};if(action==='production-preview'){state.productionPreview=await api('/api/productions/preview',{method:'POST',data:input});$('#production-preview').textContent=JSON.stringify(state.productionPreview,null,2);}else{if(!confirm('这是独立成片服务，会自行规划时长并按实际生成秒数计费。确认向 Vidu 提交剧本和当前项目资产？'))return;const item=await api('/api/productions',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},data:{...input,confirmPaid:true}});state.bootstrap.productions.push(item);$('#production-tasks').innerHTML=productionTasks();toast('成片任务已提交');}}
  });
});
setInterval(async()=>{if(!state.job||!['queued','running','assembling','cancelling'].includes(state.job.status))return;try{state.job=await api(`/api/jobs/${state.job.id}`);if(state.view==='studio'&&state.step>=2&&!state.dirty&&!state.dirtyPlan&&!state.busy){if(state.job.status==='succeeded')state.step=3;render();}}catch(e){toast(e.message,true);}},1500);
async function init(){try{await refreshBootstrap();if(!state.bootstrap.capabilities.executionModes){$('#app').innerHTML='<main><h1>请重启 MV Agent 服务</h1><p>新版已移除演示模式，并新增每镜 15 秒与 2K 设置。请在原终端停止旧服务，再在 mv-agent 目录运行 npm start，最后刷新此页。</p><p>已有分镜、已完成视频和上游任务 ID 都已保留。重启不会自动提交付费任务。</p></main>';return;}if(state.bootstrap.projects.length)await selectProject(state.bootstrap.projects[0].id);else{const p=await api('/api/projects',{method:'POST',data:{}});await selectProject(p.id);await refreshBootstrap();}await loadProjectCards();render();}catch(e){$('#app').textContent='工作台无法连接：'+e.message;}}
document.addEventListener('error',event=>{if(event.target.matches?.('.project-cover img'))event.target.hidden=true;},true);
init();
