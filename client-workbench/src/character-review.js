import {h,kv,initial} from './dom.js';
import {draftKey,readDraft,writeDraft,clearDraft} from './drafts.js';
import {ruleName,buildName,abilityName,featureText,selectionRow,abilityBonuses} from './rule-labels.js';

const keyFor=(scope,actorId,revision)=>draftKey(scope,`character-review:${actorId}:${revision}`);
export function confirmCharacterReview(scope,payload){
  const key=keyFor(scope,payload.actorId,payload.revision);
  if(readDraft(key)===payload.reason)clearDraft(key);
}

const signed=n=>(n>=0?'+':'−')+Math.abs(n);
const METHODS={'point-buy':'购点','standard':'标准数组'};

// Display only: names are translated for the host, the build itself is never rewritten.
export function buildDetails(build){
  const spells=[['戏法',build.cantrips],['准备法术',build.preparedSpells],['法术书',build.spellbook]]
    .filter(([,ids])=>ids?.length).map(([label,ids])=>[label,ids.map(id=>buildName('spell',id)).join('、')]);
  const equipment=[['职业起始装备',build.classEquipment],['背景起始装备',build.backgroundEquipment]]
    .filter(([,choice])=>choice).map(([label,choice])=>[label,'选项 '+choice]);
  return kv([['属性生成',METHODS[build.abilityMethod]||build.abilityMethod||'未记录'],
    abilityBonuses(build.backgroundBonuses)?['背景属性加值',abilityBonuses(build.backgroundBonuses)]:null,
    build.classSkills?.length?['职业技能',build.classSkills.map(id=>buildName('skill',id)).join('、')]:null,
    build.expertise?.length?['专精',build.expertise.map(id=>buildName('skill',id)).join('、')]:null,
    ...(build.selections||[]).map(selectionRow),...spells,...equipment,
    build.purchases?.length?['额外购买',build.purchases.map(p=>`${buildName('equipment',p.id)} ×${p.quantity}`).join('、')]:null]);
}

// Everything beyond the identity band, read-only and in Chinese. No source-book provenance.
function characterSections(character){
  const ch=character||{},build=ch.build,identity=build?.identity||{};
  const features=(ch.features||[]).map(featureText);
  const special=features.filter(f=>/^(语言|体型|豁免熟练)：/.test(f)),others=features.filter(f=>!special.includes(f));
  const expertise=new Set((build?.expertise||[]).map(id=>buildName('skill',id)));
  const skills=(ch.skills||[]).map(ruleName).map(s=>expertise.has(s)?s+'（专精）':s);
  const story=[['外貌',identity.appearance],['性格',identity.personality],['背景故事',identity.backstory]].filter(([,text])=>text);
  const facts=[identity.alignment?['阵营',buildName('alignment',identity.alignment)]:null,
    ...special.map(f=>[f.slice(0,f.indexOf('：')),f.slice(f.indexOf('：')+1)]),skills.length?['技能熟练',skills.join('、')]:null].filter(Boolean);
  const section=(title,...body)=>h('section.review-sec',{},h('h4.sec-h',{},title),...body);
  return [facts.length?section('熟练与特征',kv(facts)):null,
    section('特性与专长',h('p',{},others.join('、')||'无记录')),
    section('物品',h('p',{},(ch.inventory||[]).map(i=>`${buildName('equipment',i.id,i.name)} ×${i.quantity}`).join('、')||'无记录')),
    story.length?section('角色设定',kv(story)):null,
    build?section('建卡选择',buildDetails(build)):null].filter(Boolean);
}
function identityBand(member,review){
  const ch=member.character||{},m=ch.buildMechanics;
  const cls=['物种 '+(ruleName(ch.species)||'未记录'),`${ruleName(ch.className)||'未记录'} ${ch.level||1} 级`,ruleName(ch.background)?'背景 '+ruleName(ch.background):''].filter(Boolean).join(' · ');
  const abilities=(ch.abilities||[]).map(a=>{const mod=signed(a.modifier??Math.floor((a.score-10)/2));
    return h('div.ab',{'aria-label':`${abilityName(a.name)} ${a.score}（${mod}）`},h('small',{},abilityName(a.name)),h('b',{},String(a.score)),h('span',{},mod));});
  const vitals=[['生命',`${ch.hitPoints}/${ch.maxHitPoints}`],['护甲等级',String(ch.armorClass??'未记录')],
    m?.speed?['速度',m.speed+' 尺']:null,Number.isFinite(ch.proficiencyBonus)?['熟练',signed(ch.proficiencyBonus)]:null].filter(Boolean);
  return [h('div.review-who',{},h('span.who-seal',{'aria-hidden':'true'},h('i',{},initial(ch.name))),
      h('div',{},h('div.who-name',{},ch.name),h('div.who-cls',{},cls),h('div.who-meta',{},`第 ${review.revision} 次提交`))),
    abilities.length?h('div.review-abil',{},...abilities):null,
    h('div.review-vitals',{},...vitals.map(([label,value])=>h('div.vt',{},h('small',{},label),h('b',{},value)))),
    review.submission?h('div.review-bio',{},h('small',{},'玩家自述'),h('p',{},review.submission)):null].filter(Boolean);
}

/** The review task: read-only character body plus a foot with the note and the two decisions. */
export function characterReview(ctx,member,isDisposed){
  let review=member.review,version=ctx.snapshot.version;
  const scope=ctx.scope||ctx.snapshot.id;
  let key=keyFor(scope,member.id,review.revision);
  const note=h('textarea',{rows:2,maxlength:1000,'aria-label':`审核意见：${member.character.name}`,placeholder:'例如：背景故事请补充与队伍的关系'});
  note.value=readDraft(key);
  note.addEventListener('input',()=>writeDraft(key,note.value));
  const feedback=h('p.small.review-feedback',{'aria-live':'polite'});
  const approve=h('button.btn.btn-primary',{type:'button','data-write':''},'批准加入');
  const sendBack=h('button.btn',{type:'button','data-write':''},'退回修改');
  const reload=h('button.linkish',{type:'button'},'重新读取当前资料');
  const admission=h('p.small.muted',{});
  const closing=h('p.review-note',{},'是否让这名角色加入，由你决定。');
  const details=h('div.review-body',{},...identityBand(member,review),...characterSections(member.character),closing);
  let sending=false,loading=false,finished=false;
  function updateButtons(){
    const blocked=!!ctx.snapshot.archived||finished||sending||loading;
    const combat=ctx.snapshot.combat?.status==='active',roll=!!ctx.snapshot.pendingRoll;
    admission.textContent=combat?'战斗尚未结束，暂不能批准角色；仍可退回修改。':roll?'有待投掷请求，结束后才能批准角色；仍可退回修改。':'批准需在安全地点，且没有战斗或待投掷请求。';
    approve.dataset.disabledBase=String(blocked||combat||roll);sendBack.dataset.disabledBase=String(blocked);
    approve.disabled=blocked||combat||roll||ctx.hasPending();sendBack.disabled=blocked||ctx.hasPending();
    reload.disabled=sending||loading||ctx.hasPending();
  }
  reload.addEventListener('click',async()=>{
    if(isDisposed()||sending||loading||ctx.hasPending())return;
    loading=true;updateButtons();feedback.textContent='正在重新读取；审核意见会保留。';
    try{
      const snapshot=await ctx.liveConnection().snapshot();
      if(isDisposed())return;
      if(!snapshot)throw new Error('当前操作尚未确认，请先恢复原请求。');
      const current=snapshot.party?.members?.find(m=>m.id===member.id&&!m.revoked);
      if(!snapshot.party?.isHost||current?.review?.status!=='pending'){
        finished=true;feedback.textContent='该角色已不在待审核状态，未提交任何审核。';return;
      }
      member=current;review=current.review;version=snapshot.version;key=keyFor(scope,member.id,review.revision);
      writeDraft(key,note.value);
      details.replaceChildren(...identityBand(member,review),...characterSections(member.character),closing);
      feedback.textContent='已读取当前资料，审核意见已保留。请阅读后再选择批准或退回。';
    }catch(error){if(!isDisposed())feedback.textContent=error.message;}
    finally{loading=false;if(!isDisposed())updateButtons();}
  });
  updateButtons();
  async function decide(decision){
    if(isDisposed()||sending||loading||finished||ctx.hasPending()||ctx.snapshot.archived)return;
    if(decision==='approve'&&(ctx.snapshot.combat?.status==='active'||ctx.snapshot.pendingRoll)){updateButtons();return;}
    const current=ctx.snapshot.party?.members?.find(m=>m.id===member.id);
    if(ctx.snapshot.version!==version||current?.review?.revision!==review.revision||current?.review?.status!=='pending'){
      feedback.textContent='资料已更新，请点击“重新读取当前资料”，阅读后再审核。审核意见会保留。';return;
    }
    const reason=note.value.trim();
    if(decision==='return'&&!reason){feedback.textContent='退回前请说明玩家需要补充或修改什么。';return;}
    sending=true;approve.disabled=sendBack.disabled=true;
    // Normalize the retained draft to the exact sent body; clear only this matching revision on success.
    writeDraft(key,reason);
    try{
      await ctx.submit('characters/review',{expectedVersion:version,actorId:member.id,revision:review.revision,decision,reason});
      confirmCharacterReview(scope,{actorId:member.id,revision:review.revision,reason});
      if(!isDisposed())await ctx.refresh();
    }catch(error){if(!isDisposed())ctx.report(error);}
    finally{sending=false;if(!isDisposed())updateButtons();}
  }
  approve.addEventListener('click',()=>decide('approve'));
  sendBack.addEventListener('click',()=>decide('return'));
  const foot=h('div.review-foot',{},h('label.review-field',{},h('span',{},'审核意见 · 玩家可见，退回时必填'),note),
    admission,feedback,h('div.review-acts',{},sendBack,approve),h('div.review-reload',{},reload));
  return {body:details,foot};
}

export function openCharacterReview(ctx,memberId,host,isDisposed=()=>false,{key=''}={}){
  const current=ctx.snapshot.party?.members?.find(value=>value.id===memberId&&!value.revoked&&value.review?.status==='pending');
  if(!current||!ctx.snapshot.party?.isHost)return false;
  host.open({key,title:'角色审核',flag:'等待你的决定',
    render:({body,foot,isDisposed:closed})=>{
      const view=characterReview(ctx,current,()=>isDisposed()||closed());
      body.append(view.body);foot.append(view.foot);
    }});
  return true;
}
