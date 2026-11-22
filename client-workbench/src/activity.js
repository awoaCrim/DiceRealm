// activity.js — 行动溯源与剧情后果（只读读取 + 队长显式落实）。
// 服务端权威：此模块不掷骰、不计算规则、不自动确认。所有写入都必须先由服务端预览。
import {h,card,kv,fmtTime,errorBox,confirmDialog} from './dom.js';
import {newUuid,prepare,maximumStoryFacts} from './api.js';
import {draftKey,readDraft,writeDraft,clearDraft} from './drafts.js';
import {recordedCheckText} from './combat-log.js';

export const activityStatusLabels={completed:'已处理',awaiting_clarification:'等待补充说明',awaiting_confirmation:'等待确认行动',awaiting_roll:'等待玩家投掷',cancelled:'已放弃',awaiting_ruling:'等待裁定',awaiting_consequence:'等待确认后果',rejected:'已驳回'};
export const costOperations=new Set(['hp','temporary-hp','resource','inventory','exhaustion']);
const plain=value=>String(value||'').replace(/[\r\n\t]/g,' ').trim();
const field=(label,input)=>{input.setAttribute('aria-label',label);return h('label.f',{},h('span',{},label),input);};
const choice=pairs=>h('select',{},...pairs.map(([value,text])=>h('option',{value},text)));

// A number that got worse for the actor: HP/resource/inventory decreased, Exhaustion increased.
export function paidChange(operation,before,after){
  if(!costOperations.has(operation))return false;
  const a=Number(before),b=Number(after);
  if(!Number.isFinite(a)||!Number.isFinite(b))return false;
  return operation==='exhaustion'?b>a:b<a;
}
// Recorded costs of the original action plus costs already settled through the ruling record.
export function paidCosts(entry,ruling){
  const costs=[];
  const seen=new Set();
  const push=(operation,key,label,before,after,source)=>{
    if(!paidChange(operation,before,after))return;
    const identity=[operation,key,before,after].join('|');
    if(seen.has(identity))return;
    seen.add(identity);
    costs.push({operation,key,label,before,after,source});
  };
  for(const change of entry?.origin?.changes||[])push(change.operation,change.key,change.label,change.before,change.after,'原行动');
  for(const effect of ruling?.effects||[])push(effect.operation,effect.key,effect.label,effect.before,effect.after,'裁定记录');
  return costs;
}
// Authoritative elapsed seconds recorded by the server around the action. A missing or
// unchanged pair is never turned into an invented time cost.
export function timeCost(origin){
  const before=origin?.elapsedSecondsBefore,after=origin?.elapsedSecondsAfter;
  return Number.isInteger(before)&&Number.isInteger(after)&&after>before?{before,after,seconds:after-before}:null;
}
export function rulingContextModel(entry,ruling){
  const origin=entry?.origin??null;
  return {sequence:entry?.sequence??ruling?.originSequence??0,legacy:origin===null,input:origin?.input||'',label:origin?.label||'',
    requestedKind:origin?.requestedKind||'',target:origin?.target||'',actorName:origin?.actorName||ruling?.actorId||'',
    sceneTitle:origin?.sceneTitle||'',sceneId:origin?.sceneId||ruling?.sceneId||'',clarifications:origin?.clarifications||[],
    check:entry?.initialResult?.check??ruling?.check??null,changes:origin?.changes||[],costs:paidCosts(entry,ruling),timeCost:timeCost(origin)};
}
// Facts mode submits only the differences from the currently declared facts, at most 16.
export function factChanges(facts,selected){
  const chosen=selected instanceof Set?selected:new Set(selected||[]);
  return (facts||[]).filter(f=>(f.present===true)!==chosen.has(f.key)).map(f=>({key:f.key,present:chosen.has(f.key)}));
}
export function formatSeconds(value){
  const total=Math.max(0,Math.floor(Number(value)||0));
  const hours=Math.floor(total/3600),minutes=Math.floor(total%3600/60),seconds=total%60;
  if(hours)return `${hours} 小时 ${minutes} 分`;
  if(minutes&&seconds)return `${minutes} 分 ${seconds} 秒`;
  if(minutes)return `${minutes} 分`;
  return `${seconds} 秒`;
}

// A failed, stale or superseded preview never licenses a different story request.
export class StoryReview {
  revision=0; approved=null;
  invalidate(){this.revision++;this.approved=null;}
  accept(revision,payload,result){
    if(revision!==this.revision||!result)return false;
    if(result.version!==payload.expectedVersion||result.rulingId!==payload.rulingId||result.mode!==payload.mode)return false;
    this.approved=JSON.parse(JSON.stringify(payload));return true;
  }
  payload(version,rulingId){
    if(!this.approved||this.approved.expectedVersion!==version)throw new Error('请重新预览当前版本的剧情后果。');
    if(rulingId!=null&&this.approved.rulingId!==rulingId)throw new Error('请重新载入该行动的剧情选项。');
    return JSON.parse(JSON.stringify(this.approved));
  }
}

// Paging over immutable event sequences: one read at a time, cursor from the server only.
const parseDraft=raw=>{try{const value=JSON.parse(raw);return value&&typeof value==='object'?value:null;}catch{return null;}};

// 共享传输层在回执确认后调用；只清理同一次修订的草稿。
export function confirmAdventureCorrection(scope,payload){
  if(!payload?.originSequence||!payload.adventureDraftRevision)return;
  const key=draftKey(scope,'adventure-correction:'+payload.originSequence);
  const state=parseDraft(readDraft(key));
  if(state&&state.revision===payload.adventureDraftRevision&&state.version===payload.expectedVersion)clearDraft(key);
}

// 只读展示最新一次更正；原输入与原叙事仍由调用方保留在记录里。
export function correctionNotice(correction){
  if(!correction)return null;
  return h('div.narrative-correction-note',{},h('h4',{},'最新更正'),
    h('p',{},correction.text||''),
    h('p.small.muted',{},`理由：${correction.reason||'—'} · ${correction.correctedBy||''}${correction.correctedAt?' · '+fmtTime(correction.correctedAt):''}${Number.isInteger(correction.sequence)?' · 更正序号 #'+correction.sequence:''}`));
}

function clarificationList(clarifications){
  if(!clarifications?.length)return null;
  return h('div.intent-clarifications',{},h('h4',{},'行动补充'),...clarifications.map(item=>h('div',{},
    h('p.small.muted',{},item.question||''),h('p.small',{},item.answer||''))));
}
function effectsList(ruling){
  const effects=ruling?.effects||[];
  return effects.length?h('div',{},h('h4',{},'已落地的角色变化'),...effects.map(x=>h('p.small',{},`${x.label}：${x.before} → ${x.after}`))):null;
}
function storyList(story){
  if(!story)return null;
  return h('div',{},h('h4',{},'已落实的剧情后果'),h('p',{},story.resultText),
    ...(story.changes||[]).map(x=>h('p.small',{},`${x.label}：${x.before} → ${x.after}`)),
    h('p.small.muted',{},`${story.rationale||''} · ${story.ruleSource||''} · ${story.resolvedBy?story.resolvedBy+' · ':''}${fmtTime(story.resolvedAt)}`));
}
function contextBody(entry,ruling,compact=false){
  const model=rulingContextModel(entry,ruling);
  const check=entry?.initialResult?.check??null;
  const body=h('div');
  if(compact){
    body.append(h('div.ruling-intent',{},h('p.ruling-intent-text',{},model.input||model.label||ruling.text||'旧记录未保存行动原文。')));
  }else body.append(kv([['原始输入',model.input||(model.legacy?'（旧记录未保存）':'（按钮行动，无自然语言输入）')],['行动',model.label||model.target||model.requestedKind||'—'],
    ['行动席位',model.actorName||'—'],['场景',model.sceneTitle||model.sceneId||'—'],['记录类型',model.requestedKind||'—']]));
  const question=ruling.reason||entry?.initialResult?.summary;
  if(question)body.append(h('h4',{},'需要 DM 判断的问题'),h('p',{},question));
  const clarification=clarificationList(model.clarifications);
  if(clarification)body.append(clarification);
  if(model.legacy)body.append(h('p.small.muted',{},'此记录早于行动溯源：没有服务端记录的原始输入与已付消耗。'));
  if(model.timeCost)body.append(h('p.small',{},`冒险时间成本：${formatSeconds(model.timeCost.before)} → ${formatSeconds(model.timeCost.after)}（本次 ${formatSeconds(model.timeCost.seconds)}）`));
  if(model.costs.length||!compact)body.append(h('h4',{},'已付出的消耗'),
    model.costs.length?h('ul.cost-list',{},...model.costs.map(c=>h('li',{},`${c.label}：${c.before} → ${c.after}（${c.source}）`))):h('p.small.muted',{},'没有记录到已付出的角色消耗。'));
  if(check)body.append(h('p',{},recordedCheckText(check)));
  const correction=correctionNotice(entry?.correction);if(correction)body.append(correction);
  return body;
}

// Original action context for one ruling. Pending decisions load immediately; settled ones on demand.
// The ruling's own effects and settled story come from the snapshot, so both seats read them without a request.
export function renderRulingContext(ctx,ruling,{auto=false,compact=false,inline=false,isDisposed=()=>false}={}){
  const sequence=Number(ruling?.originSequence||0);
  const box=h('div.ruling-origin',{class:compact?'ruling-origin-compact':''});
  if(!Number.isInteger(sequence)||sequence<1){
    if(compact&&ruling.text)box.append(h('section.ruling-intent',{},h('p.eyebrow',{},'待裁定行动'),h('p.ruling-intent-text',{},ruling.text)));
    if(ruling.reason)box.append(h('h4',{},'需要 DM 判断的问题'),h('p',{},ruling.reason));
    box.append(...[h('p.small.muted',{},'此记录早于行动溯源：没有原始输入或已付消耗可读。'),effectsList(ruling),storyList(ruling?.story)].filter(Boolean));
    return box;
  }
  const caption=compact?'玩家原话':`原始行动与已付消耗 · #${sequence}`;
  const summary=h(inline?'h4':'summary',{},caption);
  const details=h(inline?'section.ruling-origin-detail':'details.ruling-origin-detail',{},summary);
  let loading=false,done=false;
  async function load(){
    if(loading||done||isDisposed())return;
    loading=true;
    summary.textContent=caption+'（载入中…）';
    try{
      const entry=await ctx.read('activity-entry',{sequence});
      if(isDisposed())return;
      done=true;summary.textContent=caption;
      details.replaceChildren(summary,contextBody(entry,ruling,compact));
    }catch(error){
      if(!isDisposed()){
        const retry=h('button.btn',{type:'button'},'重新读取行动');
        retry.addEventListener('click',load);
        summary.textContent=caption;details.replaceChildren(summary,errorBox(error.message),retry);
      }
    } finally {loading=false;}
  }
  details.addEventListener('toggle',()=>{if(details.open&&!done)load();});
  box.append(...[details,effectsList(ruling),storyList(ruling?.story)].filter(Boolean));
  if(auto){details.open=!compact;load();}
  return box;
}

// Host-only settlement form. Server preview is mandatory and the exact payload is confirmed once.
export function renderStoryFollowup(ctx,ruling,{isDisposed=()=>false,auto=false,inline=false}={}){
  if(!ctx.snapshot?.party?.isHost||!ruling||ruling.story||ruling.outcome==='reject')return null;
  const review=new StoryReview();
  const draft=draftKey(ctx.scope||ctx.snapshot.id,'story:'+ruling.id);
  let saved={};try{saved=JSON.parse(readDraft(draft)||'{}');}catch{/* Ignore invalid in-memory draft. */}
  const summary=h(inline?'h4':'summary',{},'追加剧情变化');
  const details=h(inline?'section.story-followup':'details.story-followup',{},summary);
  let options=null,loading=false,busy=false;
  async function loadOptions(){
    if(loading||isDisposed())return;
    loading=true;summary.textContent='剧情后续（载入选项中…）';
    try{
      const result=await ctx.read('rulings/story-options',{rulingId:ruling.id});
      if(isDisposed())return;
      if(result.rulingId!==ruling.id)throw new Error('服务端返回的裁定记录不一致，已忽略。');
      options=result;summary.textContent='追加剧情变化';draw();
    }catch(error){
      if(!isDisposed()){
        const retry=h('button.btn',{type:'button'},'重新读取剧情选项');
        retry.addEventListener('click',loadOptions);
        summary.textContent='让故事继续';details.replaceChildren(summary,errorBox(error.message),retry);
      }
    } finally {loading=false;}
  }
  function draw(){
    review.invalidate();
    const current=ctx.snapshot.version;
    const versionNotice=options.version===current?null:
      h('p.warning-text',{},`选项基于 v${options.version}，当前战役为 v${current}。请刷新页面后重新展开此表单。`);
    const facts=options.facts||[],actions=options.actions||[];
    const selectedFacts=new Set(facts.filter(f=>f.present).map(f=>f.key));
    const factBox=h('fieldset',{},h('legend',{},`已声明事实（最多改动 ${maximumStoryFacts} 项）`),
      facts.length?h('div',{},...facts.map(f=>{const box=h('input',{type:'checkbox',checked:f.present});box.addEventListener('change',()=>{box.checked?selectedFacts.add(f.key):selectedFacts.delete(f.key);invalidate();});
        return h('label.check',{},box,h('span',{},`${f.key} · 当前${f.present?'已确认':'未确认'}`));})):h('p.small.muted',{},'导入内容没有声明可确认的事实。'));
    const availableActions=actions.filter(a=>a.available);
    let selectedAction='';
    const actionBox=h('fieldset',{},h('legend',{},'选择与这次意图对应的行动后果'),
      actions.length?h('div',{},...actions.map(a=>{const box=h('input',{type:'radio',name:'story-action-'+ruling.id,value:a.id,checked:a.id===selectedAction,disabled:!a.available});
        if(a.available)box.addEventListener('change',()=>{selectedAction=a.id;invalidate();});
        return h('label.check',{},box,h('span',{},`${a.label} · 服务端结果：${a.outcome==='success'?'成功':a.outcome==='failure'?'未通过':'待确认'}${a.available?'':' · 不可用：'+(a.reason||'条件不满足')}`));})):h('p.small.muted',{},'当前场景没有可落实的行动后果。'));
    const mode=choice([['action','采用剧本里的行动后果'],['none','只回应，不追加剧情变化'],['facts','高级：调整剧情标记']]);
    mode.value=availableActions.length?'action':'none';
    if(!facts.length)mode.options[2].disabled=true;
    if(!availableActions.length)mode.options[0].disabled=true;
    const rationale=h('textarea',{rows:3,maxLength:1000,placeholder:'写下这次落实的理由'});
    const source=h('input',{type:'text',maxLength:240,placeholder:'规则出处或本场约定'});
    rationale.value=saved.rationale||'';source.value=saved.source||'';
    if(saved.version===current){
      if(['none','facts','action'].includes(saved.mode)&&!(saved.mode==='facts'&&!facts.length)&&!(saved.mode==='action'&&!availableActions.length))mode.value=saved.mode;
      if(availableActions.some(a=>a.id===saved.action))selectedAction=saved.action;
      actionBox.querySelectorAll('input').forEach(el=>{el.checked=el.value===selectedAction;});
      if(Array.isArray(saved.facts)){selectedFacts.clear();for(const key of saved.facts)if(facts.some(f=>f.key===key))selectedFacts.add(key);factBox.querySelectorAll('input').forEach((el,i)=>{el.checked=selectedFacts.has(facts[i].key);});}
    }
    const resultBox=h('div',{'aria-live':'polite'});
    const preview=h('button.btn.btn-primary',{type:'button','data-write':'true'},'预览实际变化');
    const commit=h('button.btn',{type:'button',disabled:true},'确认并落实剧情后果');
    function invalidate(){review.invalidate();commit.disabled=true;resultBox.replaceChildren();writeDraft(draft,JSON.stringify({version:current,mode:mode.value,action:selectedAction,facts:[...selectedFacts],rationale:rationale.value,source:source.value}));}
    function showMode(){factBox.hidden=mode.value!=='facts';actionBox.hidden=mode.value!=='action';}
    mode.addEventListener('change',()=>{showMode();invalidate();});showMode();
    [mode,rationale,source].forEach(el=>el.addEventListener('input',invalidate));
    function build(){
      if(!['facts','action','none'].includes(mode.value))throw new Error('请选择一种剧情处理方式。');
      const rationaleText=plain(rationale.value),sourceText=plain(source.value);
      if(!rationaleText||!sourceText)throw new Error('请填写裁定理由与依据。');
      if(mode.value==='facts'){
        const changes=factChanges(facts,selectedFacts);
        if(changes.length===0)throw new Error('请至少改动一个事实；若要结束行动请选择“不追加剧情变化”。');
        return prepare('rulings/story',{requestId:newUuid(),expectedVersion:ctx.snapshot.version,rulingId:ruling.id,mode:'facts',rationale:rationaleText,ruleSource:sourceText,facts:changes});
      }
      if(mode.value==='action'){
        const chosen=actions.find(a=>a.id===selectedAction&&a.available);
        if(!chosen)throw new Error('请选择一个可用的行动后果。');
        return prepare('rulings/story',{requestId:newUuid(),expectedVersion:ctx.snapshot.version,rulingId:ruling.id,mode:'action',rationale:rationaleText,ruleSource:sourceText,contentActionId:chosen.id,outcome:chosen.outcome});
      }
      return prepare('rulings/story',{requestId:newUuid(),expectedVersion:ctx.snapshot.version,rulingId:ruling.id,mode:'none',rationale:rationaleText,ruleSource:sourceText});
    }
    preview.addEventListener('click',async()=>{
      if(busy||isDisposed()||ctx.hasPending())return;
      busy=true;review.invalidate();commit.disabled=true;resultBox.replaceChildren();preview.disabled=true;
      const revision=review.revision;
      try{
        if(ctx.snapshot.version!==options.version)throw new Error('战役状态已更新，请刷新页面后重新载入剧情选项。');
        const request=build();
        const result=await ctx.read('rulings/story-preview',request);
        if(isDisposed()||!review.accept(revision,request,result))return;
        const changes=result.changes||[],technical=changes.filter(c=>c.kind==='fact'),visible=changes.filter(c=>c.kind!=='fact');
        resultBox.replaceChildren(...[
          h('h4',{},'确认后，故事会这样继续'),h('p',{},result.resultText),
          ...visible.map(c=>h('p',{},`${c.label}：${c.before} → ${c.after}`)),
          technical.length?h(inline?'section.advanced':'details.advanced',{},h(inline?'h4':'summary',{},`同时保存 ${technical.length} 项剧情标记`),...technical.map(c=>h('p.small',{},`${c.label}：${c.before} → ${c.after}`))):null,
          ...(result.warnings||[]).map(w=>h('p.small.muted',{},w))].filter(Boolean));
        commit.disabled=false;
      }catch(error){if(!isDisposed()&&revision===review.revision){review.invalidate();resultBox.replaceChildren(errorBox(error.message));}}
      finally{busy=false;if(!isDisposed())preview.disabled=false;}
    });
    commit.addEventListener('click',async()=>{
      if(busy||isDisposed()||ctx.hasPending())return;
      try{
        const revision=review.revision,request=review.payload(ctx.snapshot.version,ruling.id);
        if(!await confirmDialog({title:'确认落实剧情后果？',lines:[plain(ruling.text),'只保存本次预览的变化；不会重掷检定、不会自动退款，也不能与其他模式混用。'],confirmText:'确认落实'}))return;
        if(isDisposed()||revision!==review.revision||ctx.snapshot.version!==request.expectedVersion)throw new Error('状态已更新，请重新预览剧情后果。');
        review.payload(ctx.snapshot.version,ruling.id);
        busy=true;commit.disabled=true;
        await ctx.submit('rulings/story',request);
        clearDraft(draft);await ctx.refresh();
      }catch(error){if(!isDisposed()){review.invalidate();commit.disabled=true;ctx.report(error);}}
      finally{busy=false;}
    });
    details.replaceChildren(...[summary,versionNotice,h('p.small.muted',{},options.notice||''),mode,factBox,actionBox,
      h('div.grid-2',{},field('裁定理由',rationale),field('规则依据',source)),preview,resultBox,commit].filter(Boolean));
  }
  details.addEventListener('toggle',()=>{if(details.open&&!options)loadOptions();});
  if(auto){details.open=true;loadOptions();}
  return details;
}
