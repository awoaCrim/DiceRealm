const root='/api/v1';
// Keep request identity outside error serialization/logging. A late 401 from an old
// login must never invalidate the account that is currently using the page.
const requestCredentials=new WeakMap();
export function bindRequestError(error,credential){if(credential)requestCredentials.set(error,credential);return error;}
export function isCurrentRequestError(error,credential){return !requestCredentials.has(error)||requestCredentials.get(error)===credential;}
export class ApiError extends Error {
  constructor(message,status=0,code='transport') { super(message); this.status=status; this.code=code; this.unconfirmed=status===0 || status>=500; }
}
// 已知内核专用错误码 → 中性业务指引。
// 只按错误码匹配这一组已知命名：绝不按正则删改服务器原文或用户自己的文字，
// 也不触碰 code/status/unconfirmed 与重试、终态语义。
const neutralKernelMessages={
  harness_input_required:'这个战役不走旧的自然语言入口。请在「我的行动」提交行动；需要在「冒险设定」里确认内容已启用时，请到该页处理。',
  harness_disabled:'服务端当前没有启用由系统推进的行动，请让管理员检查配置。',
  harness_transport_limit:'后续回应已暂停：本次资料超过服务端传输容量，未发送这一次模型请求。已保存的行动与骰点保留；请检查上下文处理，不要重复已执行的步骤。',
  harness_context_budget_unknown:'后续回应已暂停：无法确认当前模型的输入容量。已保存的行动与骰点保留；请检查模型配置与计数支持，不要重复已执行的步骤。',
  harness_context_preparation_failed:'后续回应已暂停：历史与当前行动资料暂时无法完整装入请求。需要先完成上下文整理，已保存的结果保留，不会自动重做行动。',
  harness_context_limit:'后续回应已暂停：当前行动资料超过可用上下文容量。已保存的行动与骰点保留；请检查上下文处理，不要重复已执行的步骤。',
  harness_busy:'主持正在回应其他行动（通常是队友的），这次请求没有执行。',
  harness_campaign_required:'这个战役没有可推进的行动或可编辑的设定。创建战役时提供自己的剧本与提示词才会启用。',
  // 用户自己的提示词 / 工作方法说明不合法，只提示重新检查，不暴露预设、Skill 等内核概念。
  invalid_harness_profile:'你的提示词或工作方法说明不符合要求，请检查后重新保存。'
};
// 其余 harness_* / workspace_* / invalid_harness_* 是执行内核与内核工作区的专用命名空间，
// 普通业务请求也可能收到；统一给出不含运行器/工作区概念的中性指引。
const kernelErrorCodePattern=/^(?:harness_|invalid_harness_|workspace_)/;
const neutralKernelFallback='这次操作没有完成，已提交的效果仍然保留。请查看当前页面状态；结果未确认时不要再发送新的行动。';
/** 已知内核专用错误码的中性显示文案；未知错误码返回空串，由调用方保留服务器原文。 */
export function neutralErrorMessage(code) {
  // 只查自有键，避免 code='constructor'/'toString' 等原型键命中继承属性。
  if(typeof code==='string'&&Object.hasOwn(neutralKernelMessages,code))return neutralKernelMessages[code];
  return typeof code==='string'&&kernelErrorCodePattern.test(code)?neutralKernelFallback:'';
}
export function randomHex(bytes=32, cryptoObj=globalThis.crypto) {
  if (!cryptoObj?.getRandomValues) throw new Error('浏览器不支持安全随机数，不能生成邀请。');
  return Array.from(cryptoObj.getRandomValues(new Uint8Array(bytes)),b=>b.toString(16).padStart(2,'0')).join('');
}
export function newUuid(cryptoObj=globalThis.crypto) {
  if (!cryptoObj?.randomUUID) throw new Error('浏览器不支持安全请求编号。');
  return cryptoObj.randomUUID();
}
export const versioned = new Set(['actions/propose','character/resubmit','content/library/activate','initial-adventure','room-config','party/rest','character-command','character/advancement/apply','characters/advancement/award','characters/review','invitations','seats/revoke','invitations/revoke','rulings/resolve','rulings/respond','rulings/story','characters/adjust','archive','content/adventure','content/prompts','content/activate','content/prompts-bind','content/trial','trial-actions','world/correct','adventure/correct','intents/respond','rolls/respond']);
export const mapMutations = new Set(['maps-create','maps-generate','maps-publish','maps-grid','maps-select','maps-scenes','maps-markers']);
// Control receipts survive a load/restart; retry them with the original timeline, never a new id.
export const saveMutations = new Set(['adventure-save','adventure-save-load','adventure-save-delete','adventure-restart']);
// P2 host workspace: own workspace.version, never the game expectedVersion, never a game snapshot.
export const workspaceMutations = new Set(['workspace-draft','workspace-publish','workspace-activate']);
// Harness run lifecycle. `harness-campaign` is a non-versioned create; runs carry the game version.
// `harness-cancel` is deliberately bodyless and never takes a requestId.
export const harnessMutations = new Set(['harness-campaign','harness-run','harness-resume','harness-cancel']);
// 正常产品边界：中立业务端点，不出现执行内核或工作区概念。
export const adventureMutations = new Set(['campaign-from-content','adventure-act','adventure-opening','adventure-continue','adventure-stop','settings-draft','settings-publish','settings-activate']);
// Writes an authorized seat may perform without host rights. Everything else stays host-only.
export const seatMutations = new Set(['story-share','actions/propose','character/resubmit','character-command','character/advancement/apply','intents/respond','rolls/respond','adventure-act','adventure-opening','adventure-continue','adventure-stop',
  // 旧 key 只用于旧 pending 原样重放，不用于新请求。
  'harness-run','harness-resume','harness-cancel']);
const workspaceReads = new Set(['workspace','workspace-revisions','workspace-revision','workspace-export','memory']);
const readonlyPosts=new Set(['build-evaluate','character/advancement/preview','preparation-inspect','content/preflight','characters/adjust-preview','rulings/story-preview','workspace-preview','settings-preview']);
const harnessReads = new Set(['harness-runs-active','harness-run-status']);
const adventureReads = new Set(['adventure','adventure-progress','adventure-step','adventure-session','adventure-memory','settings','settings-history','settings-revision','settings-export']);
const reads=new Set(['build-catalog','dm-overview','portrait-image','combat-overview','board-token','adventure-saves','content/library','room','model-requests','model-request','party-rest-options','character/sheet','character-references','world/memory','character/advancement','preparation-status','preparation-result','character-play/catalog','content/prompt-history','snapshot','resources','references','journal','recap','export','asset','content','maps','map','map-image','activity','activity-entry','rulings/story-options',...workspaceReads,...harnessReads,...adventureReads]);
/** Facts the server accepts for a story settlement. Only authored/declared keys, never invented. */
export const maximumStoryFacts = 16;
export const storyModes = new Set(['facts','action','none']);
export function storyFacts(facts) {
  const list=(facts||[]).map(f=>({key:String(f?.key??''),present:!!f?.present}));
  if(list.length>maximumStoryFacts)throw new Error('每次最多选择 '+maximumStoryFacts+' 个事实。');
  return list;
}
// Retired scene commands remain here only so a pre-upgrade pending request can receive HTTP 410.
const mutations=new Set([...saveMutations,...versioned,...mapMutations,...workspaceMutations,...harnessMutations,...adventureMutations,'story-share','preparation-generate','create','room-join','scene-asset','asset-retry','asset-reference','pregenerate']);
// Raw preset/Skill text is preserved byte-for-byte; local bookkeeping fields are never sent.
const sendPreset=p=>({id:String(p?.id??''),version:Number(p?.version),systemPrompt:String(p?.systemPrompt??''),
  ...(p?.combatSystemPrompt!=null?{combatSystemPrompt:String(p.combatSystemPrompt)}:{})});
const combatPrompt=p=>p.combatPrompt!=null?{combatPrompt:String(p.combatPrompt)}:{};
const sendSkills=list=>(Array.isArray(list)?list:[]).map(s=>({id:String(s?.id??''),description:String(s?.description??''),content:String(s?.content??'')}));
const sendMethods=list=>(Array.isArray(list)?list:[]).map(m=>({id:String(m?.id??''),description:String(m?.description??''),content:String(m?.content??'')}));
// 来源可带可选 partId：同一事件/裁定下的多个精确私人片段各自独立；旧记录缺省视为同一片段。
export const validPrivateSource=s=>['event','ruling'].includes(s?.kind)&&typeof s.id==='string'&&s.id.length>0&&s.id.length<=80&&Number.isInteger(s.sequence)&&s.sequence>=(s.kind==='event'?1:0)&&/^[a-f0-9]{64}$/i.test(s.revision)&&(s.partId==null||typeof s.partId==='string'&&s.partId.length<=80);
export const samePrivateSource=(a,b)=>validPrivateSource(a)&&validPrivateSource(b)&&['kind','id','sequence','revision'].every(k=>a[k]===b[k])&&(a.partId??'')===(b.partId??'');
export const privateSourceKey=s=>validPrivateSource(s)?JSON.stringify([s.kind,s.id,s.sequence,s.revision,s.partId??'']):'';
export const latestSharedStory=s=>Math.max(0,...(s?.sharedStories||[]).map(s=>s.sequence));
export function prepare(endpoint,p={}) {
  const common={requestId:p.requestId,expectedVersion:p.expectedVersion};
  switch(endpoint) {
    case 'story-share': {
      if(!validPrivateSource(p.source))throw new Error('私人消息来源无效。');
      const source={kind:p.source.kind,id:p.source.id,sequence:p.source.sequence,revision:p.source.revision,
        ...(p.source.partId?{partId:p.source.partId}:{})};
      if(p.quick===true){
        if(p.text!=null)throw new Error('快速转述不同时提交手写正文。');
        return {requestId:p.requestId,source,quick:true};
      }
      // 旧 pending 没有 text：保持原全文语义原样重放，绝不补写正文。
      if(p.text==null)return {requestId:p.requestId,source};
      const text=String(p.text).trim();
      if(!text||text.length>1024)throw new Error('请填写要转述的内容，最多 1024 字。');
      return {requestId:p.requestId,source,text};
    }
    case 'adventure-save': return {...common,name:String(p.name??''),...(p.saveId!=null?{saveId:p.saveId,expectedSaveRevision:p.expectedSaveRevision}:{})};
    case 'adventure-save-load': return {...common,expectedSaveRevision:p.expectedSaveRevision};
    case 'adventure-save-delete': return {requestId:p.requestId,expectedSaveRevision:p.expectedSaveRevision};
    case 'adventure-restart': return common;
    case 'content/library/activate': return {...common,libraryId:p.libraryId,hash:p.hash};
    case 'initial-adventure': return {...common,adventure:p.adventure,prompt:String(p.prompt??''),methods:sendMethods(p.methods)};
    case 'room-config': return {...common,enabled:p.enabled===true,password:String(p.password??'')};
    case 'party/rest': return {...common,kind:p.kind};
    // The seat's own character operations (docs/character-play.md): equip, loadout, wear, attunement, unpack, execute, prepare, rest-choice.
    case 'character-command': return {...common,operation:p.operation,key:p.key,value:p.value??1,mode:'normal',choices:[...(p.choices||[])]};
    case 'character/advancement/preview': case 'character/advancement/apply': {
      const draft={revision:p.draft.revision,classId:p.draft.classId,subclassId:p.draft.subclassId||'',
        selections:p.draft.selections.map(s=>({key:s.key,values:[...s.values]}))};
      return endpoint.endsWith('/preview')?{expectedVersion:p.expectedVersion,draft}:{...common,draft};
    }
    case 'characters/advancement/award': return {...common,actorId:p.actorId,kind:p.kind,value:p.value,rationale:p.rationale};
    // A returned character goes back for review with a note; a rebuilt one carries its full build and name.
    case 'character/resubmit': return {...common,revision:p.revision,submission:String(p.submission??''),
      characterName:p.build?String(p.build.identity?.name??''):'',templateId:'',...(p.build?{build:p.build}:{})};
    case 'preparation-generate': return {requestId:p.requestId,input:p.input,prompt:p.prompt,confirmProviderUse:p.confirmProviderUse===true};
    case 'workspace-preview': return {preset:sendPreset(p.preset),skills:sendSkills(p.skills)};
    case 'workspace-draft': return {requestId:p.requestId,expectedWorkspaceVersion:p.expectedWorkspaceVersion,preset:sendPreset(p.preset),skills:sendSkills(p.skills)};
    case 'workspace-publish': return {requestId:p.requestId,expectedWorkspaceVersion:p.expectedWorkspaceVersion};
    case 'workspace-activate': return {requestId:p.requestId,expectedWorkspaceVersion:p.expectedWorkspaceVersion,revision:p.revision};
    case 'preparation-inspect': return {input:p.input,proposal:p.proposal};
    case 'create': return {name:p.name};
    // A full level-one build is checked by the server; joining keeps the exact build, seat token and identity.
    case 'build-evaluate': return {build:p.build};
    case 'room-join': return {roomNumber:p.roomNumber,password:p.password,requestId:p.requestId,accessToken:p.accessToken,build:p.build};
    // The explicit Harness creation contract: user-supplied Adventure + raw preset text, no default story.
    // 内容标识/版本是随草稿冻结并显式传输的业务元数据；保存/发布/启用是三独立命令。
    case 'settings-preview': return {contentId:String(p.contentId??''),contentVersion:Number(p.contentVersion),prompt:String(p.prompt??''),methods:sendMethods(p.methods),...combatPrompt(p)};
    case 'settings-draft': return {requestId:p.requestId,expectedSettingsVersion:p.expectedSettingsVersion,contentId:String(p.contentId??''),contentVersion:Number(p.contentVersion),prompt:String(p.prompt??''),methods:sendMethods(p.methods),...combatPrompt(p)};
    case 'settings-publish': return {requestId:p.requestId,expectedSettingsVersion:p.expectedSettingsVersion};
    case 'settings-activate': return {requestId:p.requestId,expectedSettingsVersion:p.expectedSettingsVersion,revision:Number(p.revision)};
    case 'campaign-from-content': {
      // 业务创建：用户自己的剧本与提示词原文，无默认故事、无默认系统提示词。
      const body={name:p.name,adventure:p.adventure,prompt:String(p.prompt??''),methods:sendMethods(p.methods),...combatPrompt(p)};
      return body;
    }
    case 'adventure-act': return {requestId:p.requestId,expectedVersion:p.expectedVersion,text:String(p.text??'')};
    case 'adventure-continue': return {requestId:p.requestId,expectedVersion:p.expectedVersion,text:String(p.text??'')};
    // 停止必须无 body，与旧 cancel 一致。
    case 'adventure-stop': return undefined;
    // Entering the scene has no player text: only the request identity and frozen version.
    case 'adventure-opening': return {requestId:p.requestId,expectedVersion:p.expectedVersion};
    // 旧 key 兼容：旧 pending 记录原样重放，不改 ID/body。
    case 'harness-campaign': {
      const body={name:p.name,characterName:p.characterName,adventure:p.adventure,preset:sendPreset(p.preset),skills:sendSkills(p.skills)};
      if(p.templateId)body.templateId=p.templateId;
      if(p.creation)body.creation=p.creation;
      if(p.build)body.build=p.build;
      return body;
    }
    case 'harness-run': return {requestId:p.requestId,expectedVersion:p.expectedVersion,text:String(p.text??'')};
    case 'harness-resume': return {requestId:p.requestId,expectedVersion:p.expectedVersion,text:String(p.text??'')};
    // Cancel must never carry a JSON body, not even {}. Retrying it is a bodyless replay.
    case 'harness-cancel': return undefined;
    // Seat consent reuses the original domain endpoints; never client-computed rules.
    case 'intents/respond': return {requestId:p.requestId,expectedVersion:p.expectedVersion,intentId:p.intentId,decision:p.decision,optionId:p.optionId||'',text:p.text||''};
    case 'rolls/respond': return {requestId:p.requestId,expectedVersion:p.expectedVersion,rollId:p.rollId,decision:p.decision};
    // A structured choice from the snapshot's own list: kind/target only, the server prices and resolves it.
    case 'actions/propose': return {requestId:p.requestId,expectedVersion:p.expectedVersion,kind:p.kind,target:p.target||'',text:''};
    case 'maps-create': return {requestId:p.requestId,specification:p.specification};
    case 'maps-generate': return {...common,confirmProviderUse:p.confirmProviderUse===true};
    case 'maps-publish': return {...common,published:p.published===true,confirmPlayerVisibility:p.confirmPlayerVisibility===true};
    case 'maps-grid': return {...common,grid:p.grid,...(p.purpose?{purpose:p.purpose}:{})};
    // 共享选择冻结战役版本与地图版本；空格子用途不会被这里写入。
    case 'maps-select': return {...common,expectedMapVersion:p.expectedMapVersion};
    case 'maps-scenes': return {...common,sceneIds:p.sceneIds};
    case 'maps-markers': return {...common,markers:p.markers.map(m=>({id:m.id,kind:m.kind,targetId:m.targetId,x:m.x,y:m.y,visibility:m.visibility}))};
    case 'content/adventure': case 'content/prompts': return {...common,document:p.document};
    case 'content/activate': return common;
    case 'content/prompts-bind': return {...common,hash:p.hash};
    case 'content/preflight': return {document:p.document,prompts:p.prompts};
    case 'content/trial': return {...common,accessToken:p.accessToken,document:p.document,prompts:p.prompts};
    case 'trial-actions': return {...common,kind:p.kind,target:p.target||'',text:p.text||''};
    case 'invitations': return {...common,inviteToken:p.inviteToken};
    case 'characters/review': return {...common,actorId:p.actorId,revision:p.revision,decision:p.decision,reason:p.reason||''};
    // Host corrections freeze the campaign version and the record revision they were read at.
    // Local draft bookkeeping (worldDraftRevision/adventureDraftRevision) is never sent.
    case 'world/correct': return {...common,memoryId:p.memoryId,revision:p.revision,name:p.name,summary:p.summary,status:p.status,hidden:p.hidden===true,reason:p.reason};
    case 'adventure/correct': return {...common,originSequence:p.originSequence,text:p.text,reason:p.reason};
    case 'seats/revoke': return {...common,actorId:p.actorId};
    case 'invitations/revoke': return {...common,inviteId:p.inviteId};
    case 'rulings/respond':
    case 'rulings/resolve': return {...common,rulingId:p.rulingId,outcome:p.outcome,rationale:p.rationale,ruleSource:p.ruleSource,ability:p.ability||'',skill:p.skill||'',dc:p.dc||0,mode:p.mode||'normal',...(p.checkType?{checkType:p.checkType}:{}),...(p.privateText?{privateText:p.privateText}:{})};
    // Preview and commit must serialize byte-identical bodies; modes never mix fields.
    case 'rulings/story': case 'rulings/story-preview': {
      if(!storyModes.has(p.mode))throw new Error('请选择有效的剧情后果模式。');
      const mode=p.mode;
      return {...common,rulingId:p.rulingId,mode,rationale:p.rationale,ruleSource:p.ruleSource,
        contentActionId:mode==='action'?p.contentActionId||'':'',outcome:mode==='action'?p.outcome||'':'',
        facts:mode==='facts'?storyFacts(p.facts):[]};
    }
    case 'characters/adjust': case 'characters/adjust-preview': return {...common,actorId:p.actorId,rulingId:p.rulingId||'',rationale:p.rationale,ruleSource:p.ruleSource,
      changes:p.changes.map(x=>({operation:x.operation,key:x.key||'',value:x.value,name:x.name||''}))};
    case 'archive': return {...common,archived:p.archived};
    case 'scene-asset': return {expectedAssetId:p.expectedAssetId,promptVariant:p.promptVariant||'',styleProfile:p.styleProfile||'',visualConstraints:p.visualConstraints||[],referenceImages:p.referenceImages||[]};
    case 'asset-retry': return {failureId:p.failureId};
    case 'asset-reference': return {};
    case 'pregenerate': return {sceneIds:p.sceneIds,confirmProviderUse:p.confirmProviderUse===true};
    default: throw new Error('不支持的工作台命令。');
  }
}
export function requestPath(endpoint,s,p={}) {
  if(!reads.has(endpoint)&&!mutations.has(endpoint)&&!readonlyPosts.has(endpoint)) throw new Error('不支持的工作台端点。');
  if(endpoint==='create')return root+'/rooms';
  if(endpoint==='campaign-from-content')return root+'/campaigns/from-content';
  if(endpoint==='harness-campaign')return root+'/harness/campaigns';
  if(endpoint==='character-play/catalog')return root+'/character-play/catalog';
  if(endpoint==='build-catalog')return root+'/character-build/catalog';
  if(endpoint==='build-evaluate')return root+'/character-build/evaluate';
  if(endpoint==='room-join')return root+'/rooms/join';
  if(endpoint==='activity-entry'&&(!Number.isInteger(p.sequence)||p.sequence<1))throw new Error('行动记录序号无效。');
  if(endpoint==='rulings/story-options'&&!p.rulingId)throw new Error('缺少裁定记录编号。');
  const base=root+'/campaigns/'+encodeURIComponent(s.campaignId);
  switch(endpoint) {
    case 'dm-overview': return base+'/dm/overview';
    case 'portrait-image': return base+'/characters/'+encodeURIComponent(p.actorId)+'/portrait/image?portraitId='+encodeURIComponent(p.portraitId)+'&contentHash='+encodeURIComponent(p.contentHash);
    case 'combat-overview': return base+'/combat/overview';
    case 'board-token':
      if(typeof p.entityId!=='string'||!p.entityId.trim())throw new Error('缺少战斗单位编号。');
      return base+'/board/tokens/'+encodeURIComponent(p.entityId);
    case 'character-references':
      if(typeof p.actorId!=='string'||!p.actorId.trim())throw new Error('缺少角色席位。');
      return base+'/characters/'+encodeURIComponent(p.actorId)+'/references';
    case 'adventure-saves': case 'adventure-save': return base+'/adventure/saves';
    case 'adventure-save-load': case 'adventure-save-delete':
      if(typeof p.saveId!=='string'||!p.saveId.trim())throw new Error('请先选择一个存档。');
      return base+'/adventure/saves/'+encodeURIComponent(p.saveId)+(endpoint==='adventure-save-load'?'/load':'/delete');
    case 'adventure-restart': return base+'/adventure/restart';
    case 'story-share': return base+'/adventure/story/share';
    case 'preparation-status': return base+'/content/preparation/status';
    case 'preparation-result': return base+'/content/preparation/requests/'+encodeURIComponent(p.requestId);
    case 'preparation-generate': return base+'/content/preparation';
    case 'preparation-inspect': return base+'/content/preparation/inspect';
    case 'adventure': return base+'/adventure';
    case 'adventure-progress': return base+'/adventure/progress'+(p.actionId||p.actorId?'?'+new URLSearchParams({actorId:p.actorId||'',actionId:p.actionId||''}):'');
    case 'adventure-step': return base+'/adventure/progress/steps/'+encodeURIComponent(p.number)+'?'+new URLSearchParams({actorId:p.actorId,actionId:p.actionId});
    case 'adventure-session': return base+'/adventure/sessions/'+encodeURIComponent(p.sessionId);
    case 'adventure-act': return base+'/adventure/actions';
    case 'adventure-continue': return base+'/adventure/sessions/'+encodeURIComponent(p.sessionId)+'/continue';
    case 'adventure-stop': return base+'/adventure/sessions/'+encodeURIComponent(p.sessionId)+'/stop';
    case 'adventure-opening': return base+'/adventure/opening';
    case 'adventure-memory': return base+'/adventure/memory';
    case 'initial-adventure': return base+'/adventure/setup';
    case 'settings': return base+'/adventure/settings';
    case 'settings-preview': return base+'/adventure/settings/preview';
    case 'settings-draft': return base+'/adventure/settings/draft';
    case 'settings-publish': return base+'/adventure/settings/publish';
    case 'settings-activate': return base+'/adventure/settings/activate';
    case 'settings-history': {const query=new URLSearchParams({limit:String(p.limit||20)});if(p.before!=null)query.set('before',String(p.before));return base+'/adventure/settings/history?'+query;}
    case 'settings-revision': return base+'/adventure/settings/history/'+encodeURIComponent(String(p.revision));
    case 'settings-export': {const query=new URLSearchParams();if(p.revision!=null)query.set('revision',String(p.revision));if(p.includeDraft!=null)query.set('includeDraft',String(p.includeDraft===true));return base+'/adventure/settings/export?'+query;}
    // 旧工作区路径保留，仅供应存旧 pending 重放。
    case 'workspace': return base+'/harness/workspace';
    case 'workspace-preview': return base+'/harness/workspace/preview';
    case 'workspace-draft': return base+'/harness/workspace/draft';
    case 'workspace-publish': return base+'/harness/workspace/publish';
    case 'workspace-activate': return base+'/harness/workspace/activate';
    case 'workspace-revisions': {const query=new URLSearchParams({limit:String(p.limit||20)});if(p.before!=null)query.set('before',String(p.before));return base+'/harness/workspace/revisions?'+query;}
    case 'workspace-revision': return base+'/harness/workspace/revisions/'+encodeURIComponent(String(p.revision));
    case 'workspace-export': {const query=new URLSearchParams();if(p.revision!=null)query.set('revision',String(p.revision));if(p.includeDraft!=null)query.set('includeDraft',String(p.includeDraft===true));return base+'/harness/workspace/export?'+query;}
    case 'memory': return base+'/harness/memory';
    case 'harness-runs-active': return base+'/harness/runs/active';
    case 'harness-run-status': return base+'/harness/runs/'+encodeURIComponent(p.runId);
    case 'harness-run': return base+'/harness/runs';
    case 'harness-resume': return base+'/harness/runs/'+encodeURIComponent(p.runId)+'/resume';
    case 'harness-cancel': return base+'/harness/runs/'+encodeURIComponent(p.runId)+'/cancel';
    case 'world/memory': {
      const query=new URLSearchParams({expectedVersion:String(p.expectedVersion),query:String(p.query||''),kind:String(p.kind||''),
        offset:String(p.offset??0),limit:String(p.limit??32),scope:p.scope==='host'?'host':'public'});
      return base+'/world/memory?'+query;
    }
    case 'room': case 'room-config': return base+'/room';
    case 'party-rest-options': return base+'/party/rest';
    case 'character-command': return base+'/character/commands';
    case 'snapshot': return base;
    case 'trial-actions': return base+'/actions';
    case 'maps': case 'maps-create': return base+'/maps';
    case 'map': return base+'/maps/'+encodeURIComponent(p.mapId);
    case 'map-image': return base+'/maps/'+encodeURIComponent(p.mapId)+'/image';
    case 'maps-generate': return base+'/maps/'+encodeURIComponent(p.mapId)+'/generate';
    case 'maps-publish': return base+'/maps/'+encodeURIComponent(p.mapId)+'/publish';
    case 'maps-grid': return base+'/maps/'+encodeURIComponent(p.mapId)+'/grid';
    case 'maps-select': return base+'/maps/'+encodeURIComponent(p.mapId)+'/select';
    case 'maps-scenes': return base+'/maps/'+encodeURIComponent(p.mapId)+'/scenes';
    case 'maps-markers': return base+'/maps/'+encodeURIComponent(p.mapId)+'/markers';
    case 'export': return base+'/journal/export';
    case 'pregenerate': return base+'/resources/pregenerate';
    case 'asset': return base+'/assets/'+encodeURIComponent(p.assetId);
    case 'asset-retry': return base+'/assets/'+encodeURIComponent(p.assetId)+'/retry';
    case 'asset-reference': return base+'/assets/'+encodeURIComponent(p.assetId)+'/reference';
    case 'journal': {
      const query=new URLSearchParams({after:String(p.after||0),limit:'50'});
      if(p.through!=null) query.set('through',String(p.through));
      return base+'/journal?'+query;
    }
    case 'activity': {
      const query=new URLSearchParams({after:String(p.after||0),limit:'50'});
      if(p.through!=null) query.set('through',String(p.through));
      return base+'/activity?'+query;
    }
    case 'activity-entry': return base+'/activity/'+encodeURIComponent(String(p.sequence));
    case 'model-requests': return base+'/model-requests?'+modelRequestQuery(p);
    case 'model-request': return base+'/model-requests/'+encodeURIComponent(String(p.requestId))+(p.publicOnly?'?publicOnly=true':'');
    case 'rulings/story-options': return base+'/rulings/story-options?rulingId='+encodeURIComponent(p.rulingId);
    default:return base+'/'+endpoint;
  }
}
function validProfile(value){
  return !!value&&typeof value.hash==='string'&&typeof value.preset?.id==='string'&&Number.isInteger(value.preset.version)&&typeof value.preset.systemPrompt==='string'
    &&Array.isArray(value.skills)&&value.skills.every(s=>typeof s?.id==='string'&&typeof s.description==='string'&&typeof s.content==='string');
}
function validRevision(value){
  return !!value&&Number.isInteger(value.revision)&&value.revision>0&&typeof value.hash==='string'&&typeof value.presetId==='string'&&Number.isInteger(value.presetVersion)&&typeof value.createdAt==='string';
}
function validWorkspace(value){
  return !!value&&Number.isInteger(value.version)&&value.version>0&&Number.isInteger(value.activeRevision)&&value.activeRevision>0
    &&Number.isInteger(value.latestRevision)&&value.latestRevision>0&&validProfile(value.draft)&&validProfile(value.active);
}
function validMemoryEntry(entry){
  return !!entry&&typeof entry.intentId==='string'&&Number.isInteger(entry.originSequence)&&Number.isInteger(entry.resultVersion)
    &&(entry.input==null||typeof entry.input==='string')&&(entry.narrative==null||typeof entry.narrative==='string')
    &&(entry.narrativeSource==null||typeof entry.narrativeSource==='string')&&typeof entry.corrected==='boolean'
    &&Array.isArray(entry.steps)&&entry.steps.every(s=>!!s&&Number.isInteger(s.version)&&typeof s.status==='string'&&typeof s.kind==='string'&&typeof s.summary==='string'&&(s.rollId==null||typeof s.rollId==='string'));
}
// 中立业务边界：行动阶段、确认事项与内容设定。旧服务端不提供这些端点，所以形状保持严格，
// 不完整的 2xx 绝不能被当成已确认结果。
export const adventurePhases=new Set(['working','delegated','blocked','needsAnswer','needsConfirmation','ready','unconfirmed','stopping','stopped','failed','done']);
export const confirmationKinds=new Set(['intent','roll','ruling']);
const residualConfirmationPhases=new Set(['stopping','stopped','failed','unconfirmed','done']);
function validAdventureMethodList(list){
  return Array.isArray(list)&&list.length<=16&&list.every(m=>!!m&&typeof m.id==='string'&&typeof m.description==='string'&&typeof m.content==='string');
}
export function validAdventureProgress(value){
  return Array.isArray(value?.runs)&&value.runs.length<=325&&value.runs.every(run=>
    typeof run?.id==='string'&&!!run.id&&typeof run.actorId==='string'&&typeof run.actorName==='string'
    &&harnessRunStatuses.has(run.status)&&typeof run.succeeded==='boolean'&&(!run.succeeded||run.status==='completed')
    &&(run.input==null||typeof run.input==='string')
    &&(run.recovery==null||['delegation','return','blocked'].includes(run.recovery))
    &&(run.notice==null||typeof run.notice==='string')
    &&(run.recovery==null||typeof run.notice==='string'&&!!run.notice.trim())
    &&(run.actionId==null||typeof run.actionId==='string')&&(run.version==null||Number.isInteger(run.version)&&run.version>=0)
    &&Array.isArray(run.steps)&&run.steps.every((step,index)=>
      step?.number===index+1&&harnessProgressKinds.has(step.kind)&&harnessProgressStates.has(step.status)
      &&typeof step.tool==='string'&&(step.tool===''||/^[a-z][a-z0-9_]{0,63}$/.test(step.tool))
      &&typeof step.waitKind==='string'&&(step.waitKind===''||harnessWaitKinds.has(step.waitKind))));
}
export function validAdventureSession(value){
  if(!value||typeof value.sessionId!=='string'||!value.sessionId||!adventurePhases.has(value.phase))return false;
  if(typeof value.question!=='string'||typeof value.outcome!=='string'||typeof value.notice!=='string')return false;
  if(typeof value.actionText!=='string'||typeof value.replayed!=='boolean')return false;
  if(value.actionId!=null&&typeof value.actionId!=='string')return false;
  if(value.battleSessionId!=null&&(typeof value.battleSessionId!=='string'||value.battleSessionId!==''&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.battleSessionId)))return false;
  if(value.role!=null&&!['exploration','combat'].includes(value.role))return false;
  if(value.parentSessionId!=null&&(value.role!=='combat'||typeof value.parentSessionId!=='string'||value.parentSessionId===value.sessionId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.parentSessionId)))return false;
  const confirmation=value.confirmation;
  if(confirmation==null)return value.phase!=='needsConfirmation';
  // 停止/失败/未确认/完成仍可能保留内核 DTO 里的原确认事项；这是真实的残留等待，
  // 只允许合法确认形状，业务界面据此提供单独放弃，不自动同意。
  if(value.phase!=='needsConfirmation'&&!residualConfirmationPhases.has(value.phase))return false;
  return confirmationKinds.has(confirmation.kind)
    &&typeof confirmation.waitId==='string'&&!!confirmation.waitId&&typeof confirmation.prompt==='string';
}
function validContentSettings(value){
  return !!value&&typeof value.contentId==='string'&&value.contentId.length>0&&value.contentId.length<=80
    &&Number.isInteger(value.contentVersion)&&value.contentVersion>0
    &&typeof value.prompt==='string'&&(value.combatPrompt==null||typeof value.combatPrompt==='string')&&validAdventureMethodList(value.methods)&&typeof value.fingerprint==='string'&&value.fingerprint.length>0;
}
export function validAdventureSettings(value){
  return !!value&&Number.isInteger(value.settingsVersion)&&value.settingsVersion>0&&Number.isInteger(value.activeRevision)&&value.activeRevision>0
    &&Number.isInteger(value.latestRevision)&&value.latestRevision>0&&validContentSettings(value.draft)&&validContentSettings(value.active)
    &&typeof value.matchesActive==='boolean';
}
function validSettingsDraft(value){
  return !!value&&typeof value.contentId==='string'&&value.contentId.length>0&&Number.isInteger(value.contentVersion)&&value.contentVersion>0
    &&typeof value.prompt==='string'&&(value.combatPrompt==null||typeof value.combatPrompt==='string')&&validAdventureMethodList(value.methods);
}
function validSettingsHistoryItem(value){return !!value&&Number.isInteger(value.revision)&&value.revision>0&&typeof value.savedAt==='string';}
function validAdventureMemoryEntry(value){
  return !!value&&typeof value.actionText==='string'&&typeof value.outcome==='string'&&Number.isInteger(value.originSequence)&&value.originSequence>0&&typeof value.corrected==='boolean';
}
// Harness run shape. Old servers may omit the compatible new fields (input/intentId/binding/progress);
// a malformed success body still must not be adopted as confirmation, so the core fields stay strict.
export const harnessRunStatuses=new Set(['running','delegated','waiting','completed','interrupted','failed','unknown','cancelling','cancelled']);
export const harnessWaitKinds=new Set(['player','intent','roll','ruling']);
const harnessProgressKinds=new Set(['model','tool','final']);
const harnessProgressStates=new Set(['started','done']);
export const knownHarnessTools=new Set(['context_read','actions_list','actions_propose','checks_result','world_record','ask_player','ruling_request','skills_list','skills_read','rules_scope']);
function validHarnessWait(wait){return !!wait&&harnessWaitKinds.has(wait.kind)&&typeof wait.id==='string'&&typeof wait.question==='string';}
function validHarnessBinding(binding){
  return !!binding&&typeof binding.presetId==='string'&&Number.isInteger(binding.presetVersion)&&binding.presetVersion>0
    &&typeof binding.profileHash==='string'&&Array.isArray(binding.skillIds)&&binding.skillIds.every(id=>typeof id==='string');
}
function validHarnessProgress(step){
  return !!step&&Number.isInteger(step.number)&&step.number>=1&&harnessProgressKinds.has(step.kind)&&harnessProgressStates.has(step.status)
    &&typeof step.tool==='string'&&(step.tool===''||/^[a-z][a-z0-9_]{0,63}$/.test(step.tool))
    &&(step.version==null||Number.isInteger(step.version))
    &&typeof step.waitKind==='string'&&(step.waitKind===''||harnessWaitKinds.has(step.waitKind));
}
export function validHarnessRun(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  if(typeof value.id!=='string'||!value.id)return false;
  if(!harnessRunStatuses.has(value.status))return false;
  if(!Number.isInteger(value.version)||value.version<1)return false;
  if(typeof value.text!=='string')return false;
  if(typeof value.error!=='string')return false;
  if(value.notice!=null&&typeof value.notice!=='string')return false;
  if(!Number.isSafeInteger(value.modelAttempts)||value.modelAttempts<0)return false;
  if(!Number.isSafeInteger(value.toolSteps)||value.toolSteps<0)return false;
  if(typeof value.replayed!=='boolean')return false;
  if(!Object.hasOwn(value,'wait')||value.status==='waiting'&&value.wait==null)return false;
  if(value.wait!=null&&!validHarnessWait(value.wait))return false;
  if(value.input!=null&&typeof value.input!=='string')return false;
  if(value.intentId!=null&&typeof value.intentId!=='string')return false;
  if(value.binding!=null&&!validHarnessBinding(value.binding))return false;
  if(value.role!=null&&!['exploration','combat'].includes(value.role))return false;
  if(value.parentRunId!=null&&(value.role!=='combat'||typeof value.parentRunId!=='string'||value.parentRunId===value.id||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.parentRunId)))return false;
  if(value.recovery!=null&&!['delegation','return','blocked'].includes(value.recovery))return false;
  if(value.progress!=null&&(!Array.isArray(value.progress)||!value.progress.every((step,index)=>validHarnessProgress(step)&&step.number===index+1)))return false;
  return true;
}
export function validAdvancement(data,previewRequired=false){
  if(!data||!Number.isInteger(data.version)||data.version<1||!Number.isInteger(data.level)||data.level<1||data.level>20
    ||!Number.isInteger(data.maximumLevel)||data.maximumLevel<1||data.maximumLevel>20||!Number.isInteger(data.experience)
    ||typeof data.available!=='boolean'||typeof data.reason!=='string'||!Array.isArray(data.classes)
    ||!data.classes.every(c=>typeof c?.id==='string'&&typeof c.name==='string'&&Number.isInteger(c.level)&&typeof c.eligible==='boolean'&&typeof c.reason==='string'))return false;
  const p=data.preview;if(p==null)return !previewRequired;
  return typeof p.canApply==='boolean'&&p.fromLevel===data.level&&p.toLevel===Math.min(20,data.level+1)
    &&Array.isArray(p.groups)&&p.groups.every(g=>typeof g?.key==='string'&&typeof g.label==='string'&&Number.isInteger(g.count)
      &&Array.isArray(g.selected)&&g.selected.every(v=>typeof v==='string')&&Array.isArray(g.options)&&g.options.every(o=>typeof o?.id==='string'&&typeof o.label==='string'))
    &&Array.isArray(p.issues)&&p.issues.every(i=>typeof i?.message==='string')&&Array.isArray(p.notices)
    &&(!p.canApply||p.character?.level===p.toLevel&&Array.isArray(p.character?.advancement?.classes));
}
export function validWorldMemoryPage(data){
  return Number.isInteger(data?.version)&&data.version>0&&['host','public'].includes(data.scope)
    &&Number.isInteger(data.total)&&data.total>=0&&data.total<=8192
    &&(data.nextOffset===null||Number.isInteger(data.nextOffset)&&data.nextOffset>0&&data.nextOffset<data.total)
    &&Array.isArray(data.entries)&&data.entries.length<=32&&data.entries.length<=data.total
    &&new Set(data.entries.map(e=>e?.id)).size===data.entries.length
    &&data.entries.every(e=>typeof e?.id==='string'&&e.id.length>0&&e.id.length<=64&&['npc','quest','place','clue'].includes(e.kind)
      &&typeof e.name==='string'&&e.name.length<=80&&typeof e.summary==='string'&&e.summary.length<=800
      &&Number.isInteger(e.revision)&&e.revision>0&&typeof e.hidden==='boolean'
      &&['public','host','arrival'].includes(e.visibility)&&typeof e.revealSceneId==='string'
      &&['known','active','resolved'].includes(e.status)&&typeof e.sceneId==='string');
}
export function validRestChoices(data){
  return Number.isInteger(data?.version)&&data.version>0&&typeof data.character?.id==='string'
    &&(data.restChoices==null||Array.isArray(data.restChoices)&&data.restChoices.length<=4
      &&new Set(data.restChoices.map(c=>c?.key)).size===data.restChoices.length
      &&data.restChoices.every(c=>typeof c?.key==='string'&&typeof c.label==='string'&&Number.isInteger(c.count)&&c.count>=1&&c.count<=2
        &&typeof c.available==='boolean'&&typeof c.reason==='string'&&Array.isArray(c.selected)&&c.selected.every(s=>typeof s==='string')
        &&Array.isArray(c.options)&&c.options.length<=391&&c.options.every(o=>typeof o?.id==='string'&&typeof o.label==='string')));
}
export function validPartyRest(data){
  return Number.isInteger(data?.version)&&data.version>0&&Array.isArray(data.participants)&&data.participants.length<=4
    &&data.participants.every(p=>typeof p==='string')&&Array.isArray(data.options)&&data.options.length===3
    &&new Set(data.options.map(o=>o?.kind)).size===3
    &&data.options.every(o=>['short','long','wait'].includes(o?.kind)&&typeof o.label==='string'&&Number.isSafeInteger(o.seconds)&&o.seconds>=0
      &&typeof o.available==='boolean'&&typeof o.reason==='string')
    &&(data.participants.length>0||data.options.every(o=>!o.available&&o.reason.trim().length>0));
}
export function modelRequestQuery(p={}){
  const query=new URLSearchParams({limit:String(p.limit||50)});
  if(p.before!=null)query.set('before',String(p.before));
  if(p.failed)query.set('failed','true');
  if(p.unresolved)query.set('unresolved','true');
  if(p.runId)query.set('runId',p.runId);
  return query.toString();
}
export const validModelRequestPage=data=>Array.isArray(data?.requests)&&data.requests.every(r=>Number.isInteger(r?.id)&&typeof r.client==='string')&&(data.nextBefore===null||Number.isInteger(data.nextBefore));
export const validModelRequest=data=>Number.isInteger(data?.summary?.id)&&typeof data.requestBody==='string'&&typeof data.responseBody==='string';
export function validSnapshotLifecycle(value){
  return (value?.timelineId==null||typeof value.timelineId==='string')
    &&(value?.lifecycle==null||['active','game_over'].includes(value.lifecycle.status)
      &&typeof value.lifecycle.message==='string'&&typeof value.lifecycle.canAct==='boolean');
}
export function validGameSaveList(data){
  return typeof data?.canSave==='boolean'&&typeof data.reason==='string'&&Array.isArray(data.entries)
    &&new Set(data.entries.map(entry=>entry?.id)).size===data.entries.length
    &&data.entries.every(entry=>typeof entry?.id==='string'&&!!entry.id&&typeof entry.name==='string'&&!!entry.name.trim()&&entry.name.length<=80
      &&Number.isInteger(entry.revision)&&entry.revision>0&&typeof entry.createdAt==='string'&&Number.isFinite(Date.parse(entry.createdAt))
      &&typeof entry.sceneTitle==='string'&&Number.isSafeInteger(entry.elapsedSeconds)&&entry.elapsedSeconds>=0
      &&Number.isInteger(entry.version)&&entry.version>0&&['manual','recovery'].includes(entry.kind)&&Array.isArray(entry.party)
      &&entry.party.every(member=>typeof member?.actorId==='string'&&!!member.actorId&&typeof member.name==='string'
        &&Number.isInteger(member.level)&&member.level>0&&typeof member.dead==='boolean'));
}
// These read models keep a strict, stable envelope; CombatState itself is the
// existing server projection, not a second frontend rules/schema implementation.
export function validCombatOverview(data){
  const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
  return object(data)&&typeof data.campaignId==='string'&&!!data.campaignId
    &&typeof data.timelineId==='string'&&Number.isSafeInteger(data.version)&&data.version>0
    &&Object.hasOwn(data,'combat')&&(data.combat===null||object(data.combat)
      &&typeof data.combat.id==='string'&&!!data.combat.id&&typeof data.combat.status==='string'
      &&Array.isArray(data.combat.units)&&Array.isArray(data.combat.turnOrder)&&Array.isArray(data.combat.log))
    &&Array.isArray(data.waits)&&new Set(data.waits.map(wait=>wait?.id)).size===data.waits.length
    &&data.waits.every(wait=>object(wait)&&['id','actorId','actorName','label','description','reason'].every(key=>typeof wait[key]==='string')
      &&!!wait.id&&!!wait.actorId&&['roll','intent'].includes(wait.kind)&&['pending','confirmed','stale','blocked'].includes(wait.state));
}
export function validBoardTokenDetail(data){
  return !!data&&typeof data==='object'&&!Array.isArray(data)&&Number.isSafeInteger(data.version)&&data.version>0
    &&typeof data.id==='string'&&!!data.id&&typeof data.name==='string'
    &&Object.hasOwn(data,'statistics')&&(data.statistics===null||typeof data.statistics==='object'&&!Array.isArray(data.statistics));
}
export function validDmOverview(data){
  const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
  return object(data)&&typeof data.campaignId==='string'&&!!data.campaignId
    &&typeof data.timelineId==='string'&&Number.isSafeInteger(data.version)&&data.version>0
    &&Array.isArray(data.party)&&data.party.every(m=>typeof m?.id==='string'&&object(m.character))
    &&object(data.scene)&&['id','title','summary'].every(key=>typeof data.scene[key]==='string')
    &&Array.isArray(data.scene.npcs)&&Array.isArray(data.scene.records)
    &&object(data.encounter)&&data.encounter.version===data.version
    &&Object.hasOwn(data,'board')&&(data.board===null||object(data.board)&&data.board.version===data.version
      &&object(data.board.map)&&typeof data.board.map.id==='string'&&Array.isArray(data.board.tokens));
}
function validResponse(endpoint,data) {
  if(endpoint==='dm-overview')return validDmOverview(data);
  if(endpoint==='combat-overview')return validCombatOverview(data);
  if(endpoint==='board-token')return validBoardTokenDetail(data);
  if(endpoint==='adventure-saves')return validGameSaveList(data);
  if(saveMutations.has(endpoint))return typeof data?.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version)
    &&validSnapshotLifecycle(data.snapshot)&&typeof data.replayed==='boolean'
    &&(typeof data.saveId==='string'&&!!data.saveId||endpoint==='adventure-restart'&&(data.saveId===null||data.saveId===''));
  if(endpoint==='story-share')return typeof data?.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version)&&typeof data.replayed==='boolean'&&data.resolution?.kind==='story.share'&&data.resolution.status==='resolved'
    &&Number.isInteger(data.sharedStory?.sequence)&&data.sharedStory.sequence>0&&typeof data.sharedStory.text==='string'&&data.sharedStory.text.length>0&&validPrivateSource(data.sharedStory.source)
    &&(data.sharedStory.publication==null||data.sharedStory.publication==='retelling');
  if(endpoint==='content/library')return typeof data?.canActivate==='boolean'&&typeof data.notice==='string'&&Array.isArray(data.adventures)
    &&data.adventures.every(e=>['id','name','version','summary','levels','duration','source','license','hash'].every(k=>typeof e?.[k]==='string')
      &&/^[a-f0-9]{64}$/.test(e.hash)&&Number.isInteger(e.sceneCount)&&e.sceneCount>0&&Number.isInteger(e.mapCount)&&e.mapCount>=0);
  if(endpoint==='content/library/activate')return typeof data?.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version)&&typeof data.replayed==='boolean'
    &&data.resolution?.status==='resolved'&&data.resolution.kind==='content.library';
  if(endpoint==='model-requests')return validModelRequestPage(data);
  if(endpoint==='model-request')return validModelRequest(data);
  if(endpoint==='room')return Number.isInteger(data?.version)&&data.version>0&&typeof data.enabled==='boolean'
    &&typeof data.roomNumber==='string'&&(/^[0-9]{8}$/.test(data.roomNumber)||data.roomNumber===''&&!data.enabled);
  if(endpoint==='room-config')return typeof data?.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version)&&typeof data.replayed==='boolean'
    &&data.resolution?.status==='resolved'&&data.resolution.kind==='party.room';
  if(endpoint==='party-rest-options')return validPartyRest(data);
  if(endpoint==='party/rest')return typeof data?.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version)&&typeof data.replayed==='boolean'
    &&data.resolution?.status==='resolved'&&['party.rest.short','party.rest.long','party.rest.wait'].includes(data.resolution.kind);
  if(endpoint==='character/sheet')return validRestChoices(data);
  if(endpoint==='character-references')return Number.isInteger(data?.version)&&data.version>0
    &&typeof data.actorId==='string'&&data.actorId.length>0&&typeof data.characterId==='string'&&data.characterId.length>0
    &&typeof data.notice==='string'&&Array.isArray(data.featureDetails)
    &&new Set(data.featureDetails.map(f=>f?.index)).size===data.featureDetails.length
    &&data.featureDetails.every(f=>Number.isInteger(f?.index)&&f.index>=0&&typeof f.name==='string'
      &&typeof f.text==='string'&&typeof f.notice==='string'&&(f.group==null||typeof f.group==='string'));
  if(endpoint==='character-command')return typeof data?.snapshot?.id==='string'&&typeof data.snapshot.character?.id==='string'
    &&Number.isInteger(data.snapshot.version)&&typeof data.replayed==='boolean'&&typeof data.resolution?.status==='string';
  if(endpoint==='world/memory')return validWorldMemoryPage(data);
  if(endpoint==='character/advancement'||endpoint==='character/advancement/preview')return validAdvancement(data,endpoint.endsWith('/preview'));
  if(endpoint==='character/resubmit')return typeof data?.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version)
    &&typeof data.replayed==='boolean'&&data.resolution?.kind==='character.resubmit';
  if(endpoint==='character/advancement/apply'||endpoint==='characters/advancement/award')return typeof data?.snapshot?.id==='string'
    &&Number.isInteger(data.snapshot.version)&&typeof data.replayed==='boolean'&&data.resolution?.status==='resolved'
    &&data.resolution.kind===(endpoint.endsWith('/apply')?'growth.apply':'growth.award');
  if(endpoint==='adventure-step')return typeof data?.runId==='string'&&typeof data.actionId==='string'&&typeof data.actorId==='string'
    &&Number.isSafeInteger(data.number)&&data.number>=1&&harnessProgressKinds.has(data.kind)&&harnessProgressStates.has(data.status)
    &&typeof data.tool==='string'&&(data.request===null||typeof data.request==='object'&&!Array.isArray(data.request))&&(data.response===null||typeof data.response==='object'&&!Array.isArray(data.response));
  if(endpoint==='adventure-progress')return validAdventureProgress(data);
  if(endpoint==='adventure')return Array.isArray(data?.sessions)&&data.sessions.length<=64&&data.sessions.every(validAdventureSession)
    &&(data.othersActing===undefined||Array.isArray(data.othersActing)&&data.othersActing.length<=16&&data.othersActing.every(id=>typeof id==='string'&&id.length>0&&id.length<=64));
  if(['adventure-act','adventure-opening','adventure-continue','adventure-stop','adventure-session'].includes(endpoint))return validAdventureSession(data);
  if(endpoint==='adventure-memory')return Array.isArray(data?.entries)&&data.entries.length<=12&&data.entries.every(validAdventureMemoryEntry);
  if(endpoint==='settings')return validAdventureSettings(data);
  if(endpoint==='settings-preview')return validSettingsDraft(data);
  if(['settings-draft','settings-publish','settings-activate'].includes(endpoint))return validAdventureSettings(data?.settings)&&typeof data?.replayed==='boolean';
  if(endpoint==='settings-history')return Array.isArray(data?.items)&&data.items.every(validSettingsHistoryItem)&&(data.nextBefore===null||Number.isInteger(data.nextBefore));
  if(endpoint==='settings-revision')return Number.isInteger(data?.revision)&&data.revision>0&&typeof data.savedAt==='string'&&typeof data.prompt==='string'&&(data.combatPrompt==null||typeof data.combatPrompt==='string')&&validAdventureMethodList(data.methods);
  if(endpoint==='campaign-from-content')return typeof data?.accessToken==='string'&&/^[a-f0-9]{64}$/i.test(data.accessToken)&&typeof data.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version);
  if(endpoint==='workspace')return validWorkspace(data);
  if(endpoint==='workspace-preview')return validProfile(data?.profile);
  if(workspaceMutations.has(endpoint))return validWorkspace(data?.workspace)&&typeof data?.replayed==='boolean';
  if(endpoint==='workspace-revisions')return Array.isArray(data?.items)&&data.items.every(validRevision)&&(data.nextBefore===null||Number.isInteger(data.nextBefore));
  if(endpoint==='workspace-revision')return validRevision(data?.revision)&&validProfile(data?.profile);
  if(endpoint==='memory')return Number.isInteger(data?.version)&&typeof data?.actorId==='string'&&Array.isArray(data?.entries)&&data.entries.every(validMemoryEntry);
  if(endpoint==='preparation-status')return typeof data?.enabled==='boolean'&&typeof data.model==='string'&&typeof data.notice==='string';
  if(['preparation-generate','preparation-inspect','preparation-result'].includes(endpoint))return ['ready','needs_clarification','failed','unknown'].includes(data?.status)&&typeof data.inputHash==='string'&&Array.isArray(data.issues)&&data.issues.every(i=>typeof i.message==='string'&&typeof i.path==='string'&&typeof i.severity==='string')&&(data.status!=='ready'||(data.document&&data.proposal))&&(endpoint==='preparation-inspect'||typeof data.requestId==='string');
  if(endpoint==='character-play/catalog')return data?.ruleset==='dnd2024'&&Array.isArray(data.equipment)&&Array.isArray(data.conditions);
  if(endpoint==='characters/adjust-preview')return Number.isInteger(data?.version)&&typeof data.actorId==='string'&&Array.isArray(data.changes)&&Array.isArray(data.warnings);
  if (endpoint==='create') return !!(data?.accessToken && data.snapshot?.id);
  if (endpoint==='room-join') return typeof data?.accessToken==='string'&&typeof data.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version);
  if (endpoint==='build-catalog') return data?.ruleset==='dnd2024'&&typeof data.revision==='string'&&['abilities','pointCosts','classes','species','backgrounds','spells','equipment','alignments','skills','feats','languages'].every(k=>Array.isArray(data[k]));
  if (endpoint==='build-evaluate') return typeof data?.fingerprint==='string'&&typeof data.canCreate==='boolean'&&['issues','steps','groups','notices'].every(k=>Array.isArray(data[k]));
  if (endpoint==='harness-campaign') return typeof data?.accessToken==='string'&&/^[a-f0-9]{64}$/i.test(data.accessToken)&&typeof data.snapshot?.id==='string'&&Number.isInteger(data.snapshot.version);
  if (endpoint==='harness-runs-active') return Array.isArray(data?.runs)&&data.runs.length<=64&&data.runs.every(validHarnessRun);
  if (endpoint==='harness-run'||endpoint==='harness-run-status'||endpoint==='harness-resume'||endpoint==='harness-cancel') return validHarnessRun(data);
  if (endpoint==='content') return !!data?.status?.status;
  if (endpoint==='content/prompt-history') return Array.isArray(data)&&data.every(r=>r.binding?.hash&&r.document);
  if (endpoint==='content/preflight') return typeof data?.valid==='boolean'&&Array.isArray(data.issues);
  if (endpoint==='content/trial') return !!(data?.trial?.accessToken&&data.trial.snapshot?.content?.offlineTrial===true);
  if (endpoint==='references') return Array.isArray(data);
  if (endpoint==='maps') return Array.isArray(data?.maps)&&typeof data.canManage==='boolean';
  if(endpoint==='maps-select')return Number.isInteger(data?.version)&&data.version>0&&typeof data.selectedMapId==='string'&&typeof data.replayed==='boolean';
  if (endpoint==='map'||mapMutations.has(endpoint)) return typeof data?.id==='string'&&Number.isInteger(data.version)&&typeof data.status==='string'&&(endpoint!=='maps-markers'||Array.isArray(data.markers));
  if (!data || typeof data!=='object' || Array.isArray(data)) return false;
  if (versioned.has(endpoint)) return !!(data.snapshot?.id && Number.isInteger(data.snapshot.version) && data.resolution?.status);
  if (endpoint==='snapshot') return !!(data.id && (data.character || data.character===null && data.party?.isHost===true) && data.scene && Number.isInteger(data.version));
  if(endpoint==='activity') return typeof data?.campaignId==='string'&&Number.isInteger(data.version)&&Number.isInteger(data.through)&&Number.isInteger(data.after)&&Number.isInteger(data.nextAfter)&&typeof data.hasMore==='boolean'&&Array.isArray(data.entries);
  if(endpoint==='activity-entry') return Number.isInteger(data?.sequence)&&typeof data.kind==='string'&&typeof data.status==='string'&&typeof data.legacy==='boolean'&&Array.isArray(data.initialResult?.changes||[]);
  if(endpoint==='rulings/story-options') return typeof data?.rulingId==='string'&&Number.isInteger(data.version)&&typeof data.notice==='string'&&Array.isArray(data.facts)&&Array.isArray(data.actions);
  if(endpoint==='rulings/story-preview') return typeof data?.rulingId==='string'&&Number.isInteger(data.version)&&typeof data.mode==='string'&&typeof data.resultText==='string'&&Array.isArray(data.changes)&&Array.isArray(data.warnings);
  if (endpoint==='resources'||endpoint==='pregenerate') return Array.isArray(data.usage)&&Array.isArray(data.mainScenes);
  if (endpoint==='journal') return Array.isArray(data.events)&&Number.isInteger(data.through);
  if (endpoint==='recap') return Number.isInteger(data.version);
  return typeof data.id==='string';
}
// Streams a binary body, refusing it as soon as it passes the size limit.
async function readLimitedBlob(response,maximum,type,tooLarge){
  if(Number(response.headers.get('content-length'))>maximum)throw new ApiError(tooLarge);
  const reader=response.body.getReader(),chunks=[];let length=0;
  try{
    while(true){
      const {value,done}=await reader.read();if(done)break;
      length+=value.length;if(length>maximum){await reader.cancel();throw new ApiError(tooLarge);}
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  return new Blob(chunks,{type});
}
export function createApi({fetchImpl=globalThis.fetch,timeoutMs=60000}={}) {
  return { async request(endpoint,session,payload={}, {timelineId=session?.timelineId??''}={}) {
    const mutation=mutations.has(endpoint),post=mutation||readonlyPosts.has(endpoint);
    const prepared=post?prepare(endpoint,payload):undefined;
    const campaignPost=post&&!['create','campaign-from-content','harness-campaign','room-join','build-evaluate'].includes(endpoint);
    const frozenTimeline=String(timelineId??'');
    const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try {
      const response=await fetchImpl(requestPath(endpoint,session,payload),{
        method:post?'POST':'GET',headers:{...(session?{Authorization:'Bearer '+session.accessToken}:{}),...(post?{'Content-Type':'application/json'}:{}),
          ...(campaignPost&&frozenTimeline?{'X-DiceRealm-Timeline':frozenTimeline}:{})},
        ...(post&&prepared!==undefined?{body:JSON.stringify(prepared)}:{}),signal:controller.signal,cache:'no-store',credentials:'omit',redirect:'error'
      });
      if(['map-image','portrait-image'].includes(endpoint)&&response.ok){
        if(!response.headers.get('content-type')?.startsWith('image/png'))throw new ApiError('地图响应不是 PNG。');
        return readLimitedBlob(response,32*1024*1024,'image/png','地图图片超过 32 MiB。');
      }
      if(['workspace-export','settings-export'].includes(endpoint)&&response.ok){
        if(!response.headers.get('content-type')?.startsWith('application/zip'))throw new ApiError('内容包响应不是 ZIP。');
        return readLimitedBlob(response,128*1024*1024,'application/zip','内容包超过 128 MiB，请缩小导出范围。');
      }
      const text=await response.text();
      let data=null; try {data=JSON.parse(text);} catch { /* Classified below. */ }
      if(!response.ok) {
        const code=data?.code||'http_error';
        // 已知内核专用错误在显示边界替换为中性业务指引；未知错误码原样保留服务器（及用户原文）文字。
        const neutral=neutralErrorMessage(code);
        throw new ApiError(neutral||data?.message||'服务端暂时不可用。',response.status,code);
      }
      if(endpoint==='export') {
        if(!text.trim() || !text.endsWith('\n')) throw new ApiError('导出未完整结束，请重新导出。');
        for(const line of text.trim().split('\n')) JSON.parse(line);
        return text;
      }
      if(!validResponse(endpoint,data)||!validSnapshotLifecycle(endpoint==='snapshot'?data:data?.snapshot))
        throw new ApiError(mutation?'响应不完整，结果未确认。请保留原请求重试。':'服务端响应不完整，请刷新重试。');
      if(['combat-overview','dm-overview'].includes(endpoint)&&data.campaignId!==session.campaignId)
        throw new ApiError('战况概览不属于当前战役，请重新读取。');
      // The seat exists only if the server answered this request: its token, a player (not host) seat and a character.
      if(endpoint==='room-join'&&(data.accessToken!==payload.accessToken||data.snapshot.party?.isHost!==false||!data.snapshot.party.selfActorId||!data.snapshot.character))
        throw new ApiError('加入回执与原请求不匹配，结果仍未确认。');
      if(endpoint==='board-token'&&data.id!==payload.entityId)
        throw new ApiError('单位资料与所选单位不匹配，请重新读取。');
      if(saveMutations.has(endpoint)&&(data.snapshot.id!==session.campaignId
        ||payload.saveId!=null&&data.saveId!==payload.saveId))throw new ApiError('存档回执与原请求不匹配，结果仍未确认。');
      if(endpoint==='story-share'){
        const story=data.sharedStory;
        // 新转述必须回本次提交的正文；旧无 text 的 pending 只核对原有全文语义。
        if(data.snapshot.id!==session.campaignId||story.actorId!==data.snapshot.party?.selfActorId||!samePrivateSource(story.source,payload.source)
          ||(payload.quick===true?story.publication!=='retelling'||!story.text?.trim()||story.text.length>1024
            :payload.text==null?story.publication!=null:story.publication!=='retelling'||story.text!==String(payload.text).trim()))
          throw new ApiError('转述的回执与原消息不匹配，结果仍未确认。');
      }
  if(endpoint==='character-command'&&(data.snapshot.id!==session.campaignId||data.snapshot.character.id!==payload.characterId||data.snapshot.version<=payload.expectedVersion))
        throw new ApiError('角色操作的回执与本人请求不匹配，结果仍未确认。');
      if(endpoint==='maps-grid'&&data.id!==payload.mapId)throw new ApiError('地图校准响应与请求不匹配，结果仍未确认。');
      // 重放按当时回执返回当前共享选择，可能已被后来的选择覆盖；只有新回执必须匹配本图。
      if(endpoint==='maps-select'&&!data.replayed&&data.selectedMapId!==payload.mapId)throw new ApiError('地图选择响应与请求不匹配，结果仍未确认。');
      if(endpoint==='party/rest'&&(data.snapshot.id!==session.campaignId||data.snapshot.version<=payload.expectedVersion||data.resolution.kind!=='party.rest.'+payload.kind))
        throw new ApiError('休整响应与原请求不匹配，结果仍未确认。');
      if(endpoint==='world/memory'){
        const start=payload.offset??0,end=start+data.entries.length;
        if(data.version!==payload.expectedVersion||data.scope!==(payload.scope==='host'?'host':'public')
          ||data.entries.length>(payload.limit??32)||data.entries.length>0&&end>data.total
          ||start<data.total&&data.entries.length===0||data.nextOffset!==(end<data.total?end:null))
          throw new ApiError('世界信息分页与当前查询不匹配，请重新读取。');
      }
      const expectedRun=endpoint==='harness-run'?payload.requestId:['harness-resume','harness-cancel','harness-run-status'].includes(endpoint)?payload.runId:null;
      if(expectedRun&&data.id.toLowerCase()!==String(expectedRun).toLowerCase())throw new ApiError('运行响应编号不匹配，原请求仍未确认。');
      const expectedSession=['adventure-act','adventure-opening'].includes(endpoint)?payload.requestId:['adventure-continue','adventure-stop','adventure-session'].includes(endpoint)?payload.sessionId:null;
      if(expectedSession&&data.sessionId.toLowerCase()!==String(expectedSession).toLowerCase())throw new ApiError('行动响应编号不匹配，原请求仍未确认。');
      return data;
    } catch(error) {
      if(error instanceof ApiError) throw bindRequestError(error,session?.accessToken);
      // Only a write can leave an unknown result; a failed read is simply retryable.
      throw bindRequestError(new ApiError(mutation?'连接中断或响应未完成，结果尚未确认。':'连接中断或响应未完成，读取失败，可稍后重试。'),session?.accessToken);
    } finally {clearTimeout(timer);}
  }};
}
