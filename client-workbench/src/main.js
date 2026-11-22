import {confirmInitialAdventure} from './initial-adventure.js';
import {createApi,newUuid,versioned,mapMutations,seatMutations,saveMutations,ApiError,isCurrentRequestError,latestSharedStory,privateSourceKey} from './api.js';
import {timelineOf,pendingExpired,canRetryPending,actionBlockReason,abandoningCommand} from './campaign-state.js';
import {renderSaves} from './game-saves.js';
import {normalizeSession} from './session.js';
import {createAccountApi,loadAccount,saveAccount,clearAccount,selectedCampaignKey} from './accounts.js';
import {renderLogin,renderUsers,renderAccountPassword} from './account-view.js';
import {createPendingStore} from './pending.js';
import {h,errorBox,pageHead,initial} from './dom.js';
import {hostTaskCount} from './tasking.js';
import {clearCampaignDrafts} from './drafts.js';
import {renderCampaigns} from './views.js';
import {resolveRoute,navigationGroups,defaultRoute} from './navigation.js';
import {renderStory} from './story.js';
import {renderWorld} from './world.js';
import {renderCampaignPage,renderMapsPage,renderPromptsPage} from './content-page.js';
import {renderRoomSettings} from './room-settings.js';
import {renderRequestLog} from './request-log.js';
import {renderAiPage} from './ai-settings.js';
import {confirmCharacterReview} from './character-review.js';
import {confirmWorldMemoryDraft} from './world-memory.js';
import {confirmMapGridDraft} from './map-reader.js';
import {confirmAdventureCorrection} from './activity.js';
import {setupReadability} from './readability.js';
import {setupTopbarPanels} from './topbar.js';
setupReadability();
setupTopbarPanels();

const api=createApi(),storage=sessionStorage,origin=location.origin;
const main=document.querySelector('#main'),notice=document.querySelector('#notice'),banner=document.querySelector('#pending-banner');
const views={story:renderStory,world:renderWorld,saves:renderSaves,campaign:renderCampaignPage,maps:renderMapsPage,prompts:renderPromptsPage,room:renderRoomSettings,content:renderCampaignPage};
let account=null,session=null,snapshot=null,pending=null,room=null,busy=false,loading=0,renderGeneration=0,campaignEpoch=0,focusTimeline=false,connectionStatus='idle',adventureAvailable=null,campaignOwnerFilter='';
const sharedAcknowledgements=new Set();
const accountPage=()=>['#/campaigns','#/users','#/account','#/requests','#/ai'].includes(location.hash);
const accountApi=()=>{if(!account)throw new Error('请先登录。');return createAccountApi({accessToken:account.accessToken});};
const routeContext=()=>({snapshot,adventureAvailable});
// A modal makes the page notice inert behind its backdrop, so the top open dialog gets its own copy.
function clearNotice(){
  notice.replaceChildren();
  document.querySelectorAll('dialog .dialog-error').forEach(box=>box.remove());
  document.querySelectorAll('.pane-alerts .pane-error').forEach(box=>box.remove());
}
function report(error){if(!isCurrentRequestError(error,account?.accessToken))return;let message=String(error?.message||error);if(session)message=message.split(session.accessToken).join('[凭证已隐藏]');clearNotice();notice.append(errorBox(message));
  const dialogs=document.querySelectorAll('dialog[open]'),top=dialogs[dialogs.length-1];
  if(top){
    const box=errorBox(message);box.classList.add('dialog-error');
    // The retry banner is behind the backdrop too.
    if(canRetryPending(pending?.read(),snapshot))box.append(h('div.btn-row',{},h('button.btn',{type:'button',onclick:()=>retry().catch(report)},'重试原请求')));
    const head=top.querySelector(':scope>.modal-head');if(head)head.after(box);else top.prepend(box);
  }else{
    const drawerAlert=document.querySelector('.task-pane:not([hidden]) .pane-alerts');
    if(drawerAlert){
      const box=errorBox(message);box.classList.add('pane-error');
      if(canRetryPending(pending?.read(),snapshot))box.append(h('div.btn-row',{},h('button.btn',{type:'button',onclick:()=>retry().catch(report)},'重试原请求')));
      drawerAlert.replaceChildren(box);
    }
  }
  if(error?.status===401&&account){expireAccount();void render();}
  // Local form validation is not a connection failure.
  if(error instanceof ApiError)connectionStatus='error';
  chrome();}
function hasPending(){return !!pending?.read();}
// Players with an admitted character; the server has no presence data, so this is not "online".
function admittedPlayers(value){return (value?.party?.members||[]).filter(m=>!m.revoked&&m.character&&!['pending','returned'].includes(m.review?.status)).length;}
function campaignStatus(value){
  if(!value)return '';
  const mode=value.archived?'已归档':value.lifecycle?.status==='game_over'?'游戏结束':value.combat?.status==='active'?'战斗中':'探索中';
  return admittedPlayers(value)+' 名玩家 · '+mode;
}
function chrome(){
  const connected=!!session,blocked=hasPending();
  document.getElementById('topbar').hidden=!account;
  document.getElementById('account-controls').hidden=!account;
  if(!account)document.getElementById('account-controls').open=false;
  const accountName=document.getElementById('account-name');
  accountName.textContent=account?.user.username||'';
  accountName.title=accountName.textContent;
  document.getElementById('account-initial').textContent=account?initial(account.user.username,'').toUpperCase():'';
  document.getElementById('account-role').textContent=connected?(snapshot?.party?.isHost?'主持':'队员'):account?.user.isAdmin?'管理员':'';
  document.getElementById('btn-users').hidden=!account?.user.isAdmin;
  document.getElementById('btn-logout').disabled=busy;
  document.getElementById('btn-campaigns').disabled=busy;
  document.getElementById('sidenav').hidden=!account;
  const name=connected?snapshot?.name||'':'主持工作台';
  document.getElementById('campaign-name').textContent=name;
  document.getElementById('campaign-name').title=name;
  document.getElementById('campaign-seal').textContent=connected?initial(name,'卷'):'卷';
  const showRoom=connected&&!!snapshot?.party?.isHost&&room?.campaignId===session.campaignId;
  document.getElementById('room-info').hidden=!showRoom;
  if(showRoom){
    document.getElementById('room-number').textContent=room.number?room.number.replace(/^(\d{4})(\d{4})$/,'$1 $2'):'未开启加入';
    document.getElementById('btn-copy-room').hidden=!room.number;
  }
  document.getElementById('campaign-status').textContent=connected?'· '+campaignStatus(snapshot):'';
  const route=resolveRoute(location.hash,routeContext()),nav=document.getElementById('primary-navigation');
  // Rebuild links only when the host role changes; switching sections keeps the focused link.
  const admin=!!account?.user.isAdmin,navKey=[connected,!!snapshot?.party?.isHost,admin].join();
  if(nav.dataset.key!==navKey){
    nav.dataset.key=navKey;
    const groups=navigationGroups(connected?snapshot:null,{admin});
    nav.replaceChildren(...groups.map(g=>h('div.nav-group',{},
      h('div.nav-h',{},h('em',{},g.numeral),g.label),
      h('ul',{},...g.items.map(item=>h('li',{},
        h('a.nav-i',{href:'#/'+item.id,'data-route':item.id},h('span',{},item.label),item.id==='story'?h('span.badge',{hidden:true}):null)))))));
  }
  const tasks=connected?hostTaskCount(snapshot):0;
  for(const link of nav.querySelectorAll('a')){
    const active=accountPage()?location.hash==='#/'+link.dataset.route:link.dataset.route===route.section;link.classList.toggle('on',active);
    if(active)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');
    const badge=link.querySelector('.badge');
    if(badge){badge.hidden=!tasks;badge.textContent=String(tasks);badge.setAttribute('aria-label',tasks+' 项主持事项');}
  }
  const net=document.getElementById('net-indicator');
  net.dataset.state=busy||loading&&!blocked?'busy':blocked?'unconfirmed':connectionStatus;
  net.textContent=busy?'正在提交…':blocked?'结果未确认':!connected?'未进入战役':loading?'正在读取…':connectionStatus==='error'?'请求失败，可重试':'已连接';
  // Signed in but not inside a campaign is not a lost connection.
  net.hidden=!connected&&!busy&&!blocked&&!loading;
  if(loading)main.setAttribute('aria-busy','true');else main.removeAttribute('aria-busy');
  // The one refresh entry for every signed-in page; a failed global read always exposes recovery.
  document.getElementById('btn-refresh').hidden=!account;
  document.getElementById('btn-refresh').disabled=busy;
  main.querySelectorAll('[data-write]').forEach(el=>{el.disabled=busy||blocked||el.dataset.disabledBase==='true';});
  banner.hidden=!blocked;banner.replaceChildren();
  if(blocked){
    const record=pending.read(),expired=pendingExpired(record,snapshot);
    const message=busy?'原请求正在发送，请勿关闭标签页。':expired
      ?'全队进度已读档或重开。此请求属于旧进度，不会按新进度补发。'+(saveMutations.has(record.endpoint)?'可查询原存档操作的回执，或放弃此待处理记录。':'请放弃此过期请求后继续；已发生的效果不会被撤销。')
      :'上一次操作尚未确认。请重试原请求，暂不发送其他变更。';
    banner.append(h('span.pb-text',{},message));
    if(canRetryPending(record,snapshot))banner.append(h('button.btn',{type:'button',disabled:busy,onclick:()=>retry().catch(report)},'重试原请求'));
    if(expired)banner.append(h('button.btn',{type:'button',disabled:busy,onclick:()=>discardExpired().catch(report)},'放弃过期请求'));
  }
}
// The room number sits in the top bar for the host; one read per campaign and after room changes.
async function loadRoom(){
  const original=session;
  if(!original||!snapshot?.party?.isHost){room=null;return;}
  try{const value=await read('room');if(session===original)room={campaignId:original.campaignId,number:value.roomNumber,enabled:value.enabled};}
  catch{if(session===original)room=null;}
  if(session===original)chrome();
}
function draftScope(){
  const scope=pending?.scope,timeline=timelineOf(snapshot);
  return scope&&timeline?scope+':timeline:'+timeline:scope;
}
function obsoleteView(){return new ApiError('全队进度或连接已改变，请从当前页面重新操作。',409,'campaign_view_changed');}
async function read(endpoint,payload={}){
  if(!session)throw new Error('请先连接战役。');
  const original=session,epoch=campaignEpoch;
  try{
    const value=await api.request(endpoint,original,payload,{timelineId:timelineOf(snapshot)});
    if(session!==original||epoch!==campaignEpoch)throw obsoleteView();
    return value;
  }catch(error){
    if(error.code==='campaign_timeline_changed')try{await reconcileSnapshot(original,epoch);}catch{/* Keep the original rejection visible. */}
    throw error;
  }
}
function resetTimeline(){
  const scope=draftScope();
  clearCampaignDrafts(scope);
  try{if(scope)storage.removeItem('dicerealm.workbench.prompt-draft.v1.'+scope);}catch{/* The new scope cannot reuse the old record. */}
  sharedAcknowledgements.clear();campaignEpoch++;adventureAvailable=null;
  if(!accountPage()){
    focusTimeline=main.contains(document.activeElement)||!!document.querySelector('dialog[open]');
    renderGeneration++;
    for(const old of main.children)old.dispatchEvent(new Event('dispose'));
    main.replaceChildren(h('div.view',{},pageHead('正在读取当前进度'),h('p',{role:'status'},'全队进度已改变，正在重新读取…')));
  }
}
function apply(value){
  const changed=!!snapshot&&snapshot.id===value.id&&timelineOf(snapshot)!==timelineOf(value);
  if(changed)resetTimeline();
  if(!changed&&snapshot?.id===value.id&&snapshot.party?.selfActorId===value.party?.selfActorId&&latestSharedStory(snapshot)>latestSharedStory(value))value.sharedStories=snapshot.sharedStories;
  if(!snapshot||snapshot.id!==value.id||changed||value.version>=snapshot.version)snapshot=value;
  connectionStatus='ok';return changed;
}
async function reconcileSnapshot(original,epoch){
  if(session!==original||epoch!==campaignEpoch)return;
  const value=await api.request('snapshot',original);
  if(session===original&&epoch===campaignEpoch&&apply(value))await render();
}
async function refresh({navigation=false}={}){
  if(!session)return;
  const original=session,hash=location.hash,generation=++renderGeneration,epoch=campaignEpoch;
  const current=()=>session===original&&location.hash===hash&&generation===renderGeneration&&epoch===campaignEpoch;
  const label=resolveRoute(hash,routeContext()).label;
  if(navigation){
    for(const old of main.children)old.dispatchEvent(new Event('dispose'));
    main.replaceChildren(h('div.view',{},pageHead(label),h('p',{role:'status'},'正在读取…')));
    document.title=label+' · '+snapshot.name+' · DiceRealm';
  }
  loading++;chrome();
  try{
    const value=await api.request('snapshot',original);if(!current())return;
    apply(value);clearNotice();await render();return true;
  }catch(error){
    if(!current())return;
    if(navigation)main.replaceChildren(h('div.view',{},pageHead(label),
      h('p',{},'此页暂时未能载入，请检查连接后重试。'),
      h('button.btn',{type:'button',onclick:()=>refresh({navigation:true}).catch(report)},'重新读取此页')));
    report(error);return false;
  }finally{loading--;chrome();}
}
async function attach(value){
  if(busy||hasPending())throw new Error('先确认原请求，再切换战役。');
  const candidate=normalizeSession(value,origin),owner=account,original=session,epoch=campaignEpoch;
  if(!owner||candidate.accountId!==owner.user.id||candidate.accessToken!==owner.accessToken)throw new Error('账户已变化，请重新选择战役。');
  const verified=await api.request('snapshot',candidate);
  const store=await createPendingStore({storage,session:candidate});store.read(); // Fail closed on corrupt pending state.
  if(account!==owner||session!==original||epoch!==campaignEpoch)return;
  storage.setItem(selectedCampaignKey(owner.user.id),candidate.campaignId);
  campaignEpoch++;sharedAcknowledgements.clear();session=candidate;snapshot=verified;pending=store;connectionStatus='ok';adventureAvailable=null;
  // Read-only capability discovery: never infer an engine from model names or content IDs.
  try{await api.request('adventure',candidate);if(account===owner&&session===candidate)adventureAvailable=true;}
  catch(error){if(account===owner&&session===candidate&&error.code==='harness_campaign_required')adventureAvailable=false;}
  if(account!==owner)return;
  void loadRoom();
  clearNotice();
  if(!location.hash.startsWith('#/')||accountPage())history.replaceState(null,'','#/'+defaultRoute(snapshot,adventureAvailable));
  await render();
}
async function sendOriginal(){
  const originalPending=pending,originalSession=session;
  const record=originalPending.read();if(!record)return;
  if(!canRetryPending(record,snapshot))throw new Error('此请求属于已替换的旧进度，不能补发。请放弃过期请求后继续。');
  const scope=record.draftScope??originalPending.scope,payload=JSON.parse(record.payloadJson),epoch=campaignEpoch;
  const stillCurrent=()=>session===originalSession&&pending===originalPending;
  try{
    const data=await api.request(record.endpoint,originalSession,payload,{timelineId:record.timelineId??''});
    if(record.endpoint==='invitations')storage.setItem('dicerealm.workbench.invite.'+scope,JSON.stringify({id:payload.requestId,token:payload.inviteToken}));
    // Settle only the original account's request, even if its session expires during a read.
    if(record.endpoint==='characters/review')confirmCharacterReview(scope,payload);
    if(record.endpoint==='world/correct')confirmWorldMemoryDraft(scope,payload);
    if(record.endpoint==='maps-grid')confirmMapGridDraft(scope,payload);
    if(record.endpoint==='adventure/correct')confirmAdventureCorrection(scope,payload);
    confirmInitialAdventure(scope,record.endpoint,payload);
    originalPending.complete();
    if(stillCurrent()){
      // 只有旧全文公开的回执算“已公开”；新转述不封锁原私人消息入口。
      if(epoch===campaignEpoch&&record.endpoint==='story-share'&&!data.sharedStory.publication)sharedAcknowledgements.add(privateSourceKey(data.sharedStory.source));
      // Control replays may return a receipt from before a later load. Only a fresh GET
      // can establish the current timeline; confirming that receipt must not roll it back.
      if(data.snapshot&&epoch===campaignEpoch&&!(saveMutations.has(record.endpoint)&&data.replayed)){
        if(apply(data.snapshot)){
          await render();
          if(stillCurrent())notice.append(h('p',{role:'status'},record.endpoint==='adventure-restart'?'游戏已重开。':record.endpoint==='adventure-save-load'?'全队进度已读档。':'全队进度已改变，已重新读取。'));
        }
      }
      if(epoch===campaignEpoch&&['initial-adventure','content/library/activate'].includes(record.endpoint))adventureAvailable=true;
      if(record.endpoint==='room-config')void loadRoom();
    }
    return data;
  }catch(error){
    // Expired authentication cannot establish whether a previously sent request committed.
    // Keep it for the same account after login rather than silently losing its receipt.
    if(error.unconfirmed===false&&error.status!==401){
      if(error.code!=='campaign_timeline_changed')originalPending.complete();
      try{await reconcileSnapshot(originalSession,epoch);}
      catch{/* The original rejection remains definitive; the request is never rebased. */}
    }
    throw error;
  }
}
async function submit(endpoint,payload){
  if(busy||hasPending())throw new Error('请先确认上一请求。');
  // Only explicit seat commands may bypass the host gate; everything else stays host-only.
  if(!seatMutations.has(endpoint)&&!snapshot?.party?.isHost)throw new Error('需要队长席位。');
  const abandoning=abandoningCommand(endpoint,payload);
  const blockedAction=actionBlockReason(snapshot);
  if(seatMutations.has(endpoint)&&!abandoning&&blockedAction)throw new Error(blockedAction);
  if(snapshot.archived&&!abandoning&&!saveMutations.has(endpoint)&&!(endpoint==='room-config'&&payload.enabled===false)&&!['archive','seats/revoke','invitations/revoke'].includes(endpoint))throw new Error('战役已归档，请先恢复。');
  busy=true;clearNotice();
  try{
    if(saveMutations.has(endpoint)&&(!payload.requestId||endpoint!=='adventure-save-delete'&&payload.expectedVersion!==snapshot.version))throw new Error('全队进度已更新，请重新读取存档后操作。');
    if(['room-config','initial-adventure','content/library/activate'].includes(endpoint)&&(payload.expectedVersion!==snapshot.version||!payload.requestId))throw new Error('房间状态已变化，请重新读取后设置。');
    if(endpoint==='party/rest'&&(payload.expectedVersion!==snapshot.version||!payload.requestId))throw new Error('休整依据已变化，请重新读取。');
    if(endpoint==='character-command'&&(payload.expectedVersion!==snapshot.version||!payload.requestId||payload.characterId!==snapshot.character.id))throw new Error('本人角色或休息窗口已变化，请重新读取。');
    if(endpoint==='characters/review'&&payload.expectedVersion!==snapshot.version)throw new Error('角色资料已更新，请刷新后重新审核。');
    if(['world/correct','adventure/correct'].includes(endpoint)&&payload.expectedVersion!==snapshot.version)throw new Error('更正依据的战役版本已变化，请重新读取后再更正。');
    if(['character/advancement/apply','characters/advancement/award'].includes(endpoint)&&(payload.expectedVersion!==snapshot.version||!payload.requestId))throw new Error('成长依据已变化，请重新预览或填写奖励。');
    if(endpoint==='characters/adjust'&&(payload.expectedVersion!==snapshot.version||!payload.requestId))throw new Error('角色状态已更新，请重新预览调整。');
    if(endpoint==='rulings/story'&&(payload.expectedVersion!==snapshot.version||!payload.requestId))throw new Error('战役状态已更新，请重新预览剧情后果。');
    // Aggregated and story commands settle an exact previewed payload; never re-mint ids or versions.
    // Harness cancel stays bodyless and identity-free; seat consent and run writes keep their exact id.
    const exact=saveMutations.has(endpoint)||endpoint==='initial-adventure'||endpoint==='room-config'||endpoint==='party/rest'||endpoint==='characters/advancement/award'||endpoint==='characters/adjust'||endpoint==='rulings/story'||seatMutations.has(endpoint)?payload
      :versioned.has(endpoint)?{...payload,requestId:newUuid(),expectedVersion:snapshot.version}
      :mapMutations.has(endpoint)?{...payload,requestId:newUuid()}:payload;
    pending.capture(endpoint,exact,{timelineId:timelineOf(snapshot),draftScope:draftScope()});chrome();return await sendOriginal();
  }finally{busy=false;chrome();}
}
async function retry(){
  if(busy||!hasPending())return;
  busy=true;chrome();clearNotice();
  const endpoint=pending.read().endpoint;
  try{
    await sendOriginal();const synced=await refresh();
    if(saveMutations.has(endpoint))notice.append(h('p',{role:'status'},synced?'原存档操作已确认，已读取当前进度。':'原存档操作已确认；当前进度尚未重新读取，请刷新。'));
  }finally{busy=false;chrome();}
}
async function discardExpired(){
  if(busy||!pendingExpired(pending?.read(),snapshot))return;
  pending.complete();clearNotice();chrome();await refresh();
}
async function create(payload){return createCampaign(payload.name);}
// 内容准备 · 冒险设定有自己的设定记录版本与持久原请求日志：不复用游戏 pending、expectedVersion 或 submit 管线。
// 连接在任何 await 之前冻结，晚到的视图不能把草稿发到新连接的战役。
// workspace-* 方法只用于升级前已捕获的 pending 原样重放，新请求一律走 settings-*。
function contentSettingsConnection(){
  if(!session)throw new Error('请先连接战役。');
  const original=session,epoch=campaignEpoch,timelineId=timelineOf(snapshot);
  const current=()=>session===original&&epoch===campaignEpoch;
  async function request(endpoint,payload){
    if(!current())throw obsoleteView();
    try{
      const result=await api.request(endpoint,original,payload,{timelineId});
      if(!current())throw obsoleteView();
      return result;
    }catch(error){
      if(current()&&error.code==='campaign_timeline_changed'){
        try{await reconcileSnapshot(original,epoch);}catch{/* Retain the original rejection. */}
      }
      throw error;
    }
  }
  return {
    confirmed:()=>{if(current()){clearNotice();connectionStatus='ok';chrome();}},
    settings:()=>request('settings'),
    settingsDraft:payload=>request('settings-draft',payload),
    settingsPublish:payload=>request('settings-publish',payload),
    settingsActivate:payload=>request('settings-activate',payload)
  };
}
// 大厅只读同步不重建表单，仍冻结连接，命令在途时不与其回执争用快照。
function liveConnection(){
  if(!session)throw new Error('请先连接战役。');
  const original=session,epoch=campaignEpoch;
  const stillCurrent=()=>session===original&&epoch===campaignEpoch;
  return {snapshot:async()=>{
    if(!stillCurrent())throw obsoleteView();
    if(busy)return null;
    const value=await api.request('snapshot',original);
    if(!stillCurrent())throw obsoleteView();
    if(busy)return null;
    const changed=apply(value);chrome();
    if(changed)await render();
    return snapshot;
  }};
}
// New campaigns persist their owner with the game; an uncertain create is recovered from the user's list.
async function createCampaign(name){
  if(busy||hasPending())throw new Error('请先确认当前操作。');
  const owner=account,transport=accountApi();busy=true;chrome();
  let accepted=false;
  try{
    const result=await transport.createCampaign(name);accepted=true;
    if(account!==owner)return;
    busy=false;await openCampaign(result.campaignId);
  }catch(error){
    if(error.status===401)throw error;
    if(accepted||error.unconfirmed!==false)throw new Error('战役可能已创建，连接尚未完成。请刷新战役列表后继续，不要重复创建。');
    throw error;
  }finally{busy=false;chrome();}
}
function detachCampaign(){
  clearCampaignDrafts(draftScope()||snapshot?.id);campaignEpoch++;
  session=snapshot=pending=room=null;adventureAvailable=null;connectionStatus='idle';
}
function expireAccount(){
  clearAccount(storage);account=null;detachCampaign();renderGeneration++;
  for(const old of main.children)old.dispatchEvent(new Event('dispose'));
}
async function login(username,password){
  const value=await createAccountApi().login(username,password);
  // Never store the password. Failed browser persistence does not pretend to be a saved login.
  account=saveAccount(storage,value);campaignOwnerFilter='';clearNotice();
  history.replaceState(null,'','#/campaigns');await render();
}
async function openCampaign(campaignId){
  if(!account)throw new Error('请先登录。');
  await attach({baseUrl:origin,campaignId,accessToken:account.accessToken,accountId:account.user.id});
}
async function logout(){
  if(busy||!account)return;
  const owner=account,transport=accountApi();busy=true;chrome();
  try{await transport.logout();}
  catch(error){if(error.status!==401){report(error);return;}}
  finally{busy=false;chrome();}
  if(account!==owner)return;
  expireAccount();clearNotice();history.replaceState(null,'','#/campaigns');await render();
}
async function passwordChanged(){expireAccount();clearNotice();history.replaceState(null,'','#/campaigns');await render();notice.append(h('p',{role:'status'},'密码已更新，请重新登录。'));}
function showUserCampaigns(userId){campaignOwnerFilter=userId;location.hash='#/campaigns';}
// A status line that outlives the re-render of the page that caused it.
function notify(text){notice.append(h('p',{role:'status'},text));}
const ctx={origin,report,notify,read,submit,refresh,sharedAcknowledgements,attach,create,login,openCampaign,accountApi,passwordChanged,showUserCampaigns,get account(){return account;},get campaignOwnerFilter(){return campaignOwnerFilter;},liveConnection,hasPending,contentSettingsConnection,sessionStorage:storage,connection:()=>normalizeSession(session,origin),get scope(){return draftScope();},get snapshot(){return snapshot;},get adventureAvailable(){return adventureAvailable;}};
// A mounted campaign page belongs to one connection and one timeline. A late callback
// cannot pick up today's snapshot and accidentally submit yesterday's form on it.
function campaignContext(){
  const original=session,epoch=campaignEpoch,scope=draftScope();
  const guard=()=>{if(session!==original||epoch!==campaignEpoch)throw obsoleteView();};
  const value=Object.create(ctx);
  Object.defineProperty(value,'scope',{value:scope});
  value.read=(...args)=>{guard();return read(...args);};
  value.submit=(...args)=>{guard();return submit(...args);};
  value.refresh=(...args)=>{guard();return refresh(...args);};
  value.liveConnection=()=>{guard();return liveConnection();};
  value.contentSettingsConnection=()=>{guard();return contentSettingsConnection();};
  return value;
}
async function render({navigation=false}={}){
  const generation=++renderGeneration;const mount=h('div');
  const route=resolveRoute(location.hash,routeContext());
  const label=({'#/users':'用户管理','#/account':'修改密码','#/requests':'请求日志','#/ai':'AI 设置','#/campaigns':'你的战役'})[location.hash]||route.label;
  if(navigation){
    for(const old of main.children)old.dispatchEvent(new Event('dispose'));
    main.replaceChildren(h('div.view',{},pageHead(label),h('p',{role:'status'},'正在读取…')));
    loading++;chrome();
  }
  try{
    if(!account){document.title='登录 · DiceRealm';renderLogin(mount,ctx);}
    else if(location.hash==='#/users'){document.title='用户管理 · DiceRealm';await renderUsers(mount,ctx);}
    else if(location.hash==='#/account'){document.title='修改密码 · DiceRealm';renderAccountPassword(mount,ctx);}
    else if(location.hash==='#/requests'){document.title='请求日志 · DiceRealm';await renderRequestLog(mount,ctx);}
    else if(location.hash==='#/ai'){document.title='AI 设置 · DiceRealm';renderAiPage(mount,ctx);}
    else if(!session||location.hash==='#/campaigns'){document.title='你的战役 · DiceRealm';renderCampaigns(mount,ctx);}
    else{
      if(location.hash!=='#/'+route.path)history.replaceState(null,'','#/'+route.path);
      document.title=(route.denied?'需要主持权限':route.label)+' · '+snapshot.name+' · DiceRealm';
      if(route.denied)mount.append(h('div.view',{},h('h1',{},'此页需要主持席位'),h('p',{},'此页面仅供主持管理，请返回可访问的剧情页。'),h('a.btn',{href:'#/story'},'返回剧情')));
      else{
        if(adventureAvailable===null){
          try{await read('adventure');if(generation!==renderGeneration)return;adventureAvailable=true;}
          catch(error){if(generation!==renderGeneration)return;if(error.code==='harness_campaign_required')adventureAvailable=false;else throw error;}
        }
        await views[route.view](mount,campaignContext());
      }
    }
    if(generation!==renderGeneration){mount.dispatchEvent(new Event('dispose'));return;}
    const focused=document.activeElement,hadFocus=main.contains(focused);
    const focusedHref=hadFocus&&focused.closest('nav')?focused.getAttribute('href'):null;
    for(const old of main.children)old.dispatchEvent(new Event('dispose'));
    main.replaceChildren(mount);
    chrome();
    if(hadFocus||focusTimeline){restoreFocus(focusedHref);focusTimeline=false;}
    mount.dispatchEvent(new Event('mounted'));
  }catch(error){mount.dispatchEvent(new Event('dispose'));if(generation===renderGeneration){connectionStatus='error';report(error);if(generation!==renderGeneration)return;for(const old of main.children)old.dispatchEvent(new Event('dispose'));main.replaceChildren(h('div.view',{},pageHead(label),h('p',{},'此页暂时未能载入。'),h('button.btn',{type:'button',onclick:()=>render({navigation:true})},'重新读取此页')));chrome();}}
  finally{if(navigation){loading--;chrome();}}
}
// Replacing the page drops keyboard focus: keep it on the same local tab, else on the page heading.
function restoreFocus(href){
  if(document.activeElement&&document.activeElement!==document.body&&main.contains(document.activeElement))return;
  const link=href&&[...main.querySelectorAll('nav a')].find(a=>a.getAttribute('href')===href);
  if(link){link.focus({preventScroll:true});return;}
  const heading=main.querySelector('h1');
  if(heading){heading.setAttribute('tabindex','-1');heading.focus({preventScroll:true});}
}
document.getElementById('btn-refresh').onclick=()=>(session&&!accountPage()?refresh():render()).catch(report);
document.getElementById('btn-copy-room').onclick=async event=>{
  const button=event.currentTarget;if(!room?.number)return;
  try{await navigator.clipboard.writeText(room.number);button.textContent='已复制';}
  catch{button.textContent='复制失败';}
  setTimeout(()=>{button.textContent='复制';},1600);
};
document.getElementById('btn-campaigns').onclick=()=>{campaignOwnerFilter='';location.hash='#/campaigns';};
document.getElementById('btn-users').onclick=()=>{location.hash='#/users';};
document.getElementById('btn-account').onclick=()=>{location.hash='#/account';};
document.getElementById('btn-logout').onclick=()=>logout().catch(report);
window.addEventListener('beforeunload',event=>{if(busy||hasPending()){event.preventDefault();event.returnValue='';}});
window.addEventListener('hashchange',()=>{if(account&&session&&!busy&&!accountPage())refresh({navigation:true}).catch(report);else void render({navigation:true});});
try{
  const saved=loadAccount(storage);
  if(saved){
    const user=await createAccountApi({accessToken:saved.accessToken}).me();
    account=saveAccount(storage,{...saved,user});
    const campaignId=storage.getItem(selectedCampaignKey(user.id));
    if(campaignId&&!accountPage())await openCampaign(campaignId);else await render();
  }else await render();
}catch(error){
  if(error.status===401||!account)clearAccount(storage);
  await render();report(error);
}
