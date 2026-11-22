// The player's own character window (docs/character-play.md): the shared character reader plus the
// operations the server lists for this seat right now. A button sends one exact command through the
// page's durable request; the server checks it again. Nothing here changes a number by itself.
import {h} from '../dom.js';
import {characterSheet} from '../character-sheet.js';
import {buildName,ruleText,optionName} from '../rule-labels.js';
import * as growthDraft from './growth.js';

const seconds=s=>s>0?'（'+(s>=60?Math.round(s/60)+' 分钟':s+' 秒')+'）':'';
const itemName=(id,name)=>id?buildName('equipment',id,name||id):'';

// Which section shows an effect: spells by their source, items by their item, the rest under status.
export const effectSection=effect=>effect.spellSource?'spells':effect.itemId?'inventory':'status';
// Classes that keep a preparation list; a class without one says nothing rather than "not available".
export function preparations(view){
  const list=view.classPreparations?.length?view.classPreparations:[view.preparation];
  return list.filter(p=>p&&(p.available||p.count>0||p.options.length>0));
}
// A full selection of exactly `count` listed ids, sorted so a retry is byte-identical.
export function choiceRequest(operation,key,count,options,values){
  const ids=new Set(options.map(o=>o.id)),chosen=[...new Set(values)].filter(id=>ids.has(id));
  return chosen.length===count?{operation,key,value:1,choices:chosen.sort()}:null;
}

export function createCharacterWindow({dialogs,read,snapshot,busy,status,send}){
  let open=null,view=null,loading=false,error='',rules=null,rulesKey='',rulesStatus='',drafts=new Map(),growth=null;

  function show(section='overview'){
    dialogs.open({title:'角色',wide:true,render:state=>{
      open={...state,section,signature:''};
      state.body.addEventListener('dispose',()=>{open=null;},{once:true});
      update();
    }});
  }
  // Called after every page render: re-read the operations when the campaign moved on, redraw on change.
  function update(){
    if(!open||open.isDisposed())return;
    const s=snapshot();
    if(!s.character)return;
    if(view?.version!==s.version&&!loading&&!error)void readView();
    const key=JSON.stringify([s.party?.selfActorId,s.character.id,s.character.features,s.character.advancement,s.character.build?.selections]);
    if(key!==rulesKey){rulesKey=key;rules=null;rulesStatus='正在读取能力规则…';void readRules(key);}
    const signature=JSON.stringify([s.character,s.version,s.elapsedSeconds,view,loading,error,rulesStatus,busy(),status(),[...drafts],
      growth&&[growth.view,growth.error,growth.draft,growth.preview,growth.previewed]]);
    if(signature===open.signature)return;
    open.signature=signature;draw();
  }
  async function readView(){
    loading=true;
    try{view=await read('character/sheet');error='';}
    catch(e){error='可做的操作读取失败：'+e.message;}
    finally{loading=false;update();}
  }
  async function readRules(key){
    const s=snapshot();
    try{
      const value=await read('character-references',{actorId:s.party.selfActorId});
      if(key!==rulesKey)return;
      rules=value;rulesStatus='';
    }catch(e){if(key===rulesKey)rulesStatus='能力规则读取失败：'+e.message;}
    finally{if(key===rulesKey){if(open)open.signature='';update();}}
  }
  function draw(){
    const body=open.body,old=body.querySelector('.sheet-body');
    const section=old?.dataset.section||open.section,selection=old?.dataset.entry||'';
    const scrolled=['.sheet-page','.sheet-reader','.sheet-entry-list','.sheet-operations'];
    const tops=scrolled.map(s=>body.querySelector(s)?.scrollTop||0),top=body.scrollTop;
    const s=snapshot(),tabs=[...(view?.restChoices?.length?[['recovery','恢复']]:[]),['growth','成长']];
    const review=s.party?.members?.find(m=>m.id===s.party.selfActorId)?.review||null;
    body.replaceChildren(characterSheet(s.character,{elapsedSeconds:s.elapsedSeconds,review,section,selection,rules,rulesStatus,
      retryRules:rulesStatus.includes('失败')?()=>{rulesKey='';update();}:null,operations:{tabs,render:panel}}));
    scrolled.forEach((sel,i)=>{const n=body.querySelector(sel);if(n)n.scrollTop=tops[i];});
    body.scrollTop=top;
  }

  // ── operations ──
  function ready(){
    const s=snapshot();
    return view&&view.enabled&&!view.actionBlock&&view.version===s.version&&!busy()&&!loading;
  }
  const act=(label,payload,disabled=false)=>h('button.btn.btn-sm',{type:'button',disabled:disabled||!payload||!ready(),onclick:()=>{if(payload&&ready())send('character-command',payload);}},label);
  const row=(name,note,...controls)=>h('div.pco-row',{},h('div.pco-row-text',{},h('b',{},name),note?h('span',{},note):null),...controls);
  const group=(title,...children)=>{const items=children.flat().filter(Boolean);return items.length?h('section.pco-group',{},h('h4',{},title),...items):null;};

  function panel(section){
    if(section==='overview'||section==='features')return null;
    if(section==='growth')return growthPanel();
    const head=[status()?h('p.pco-status',{role:'status'},status()):null];
    if(!view)return h('div.pco',{},...head,h('p.pco-note',{},error||'正在读取当前可做的操作…'),
      error?h('button.btn.btn-sm',{type:'button',onclick:()=>{error='';update();}},'重新读取'):null);
    const s=snapshot(),stale=view.version!==s.version;
    head.push(!view.enabled?h('p.pco-note',{},view.reason||'当前不能操作角色。'):view.actionBlock?h('p.pco-note',{},view.actionBlock):null,
      stale?h('p.pco-note',{},'角色已有新变化，正在重新读取可做的操作…'):null,
      error?h('p.pco-note',{},error,' ',h('button.btn.btn-sm',{type:'button',onclick:()=>{error='';update();}},'重新读取')):null);
    const content=({inventory,spells,status:statusPanel,recovery})[section]?.()||[];
    const parts=[...head,...content].filter(Boolean);
    return parts.length?h('div.pco',{},...parts):null;
  }
  function effects(section){
    return (view.effects||[]).filter(e=>effectSection(e)===section).map(e=>row(ruleText(e.label),
      [e.details?.cost,e.details?.range,e.details?.targetLabel,e.details?.note].filter(Boolean).map(ruleText).join(' · '),
      act('使用 · 按所列成本结算',{operation:'execute',key:e.key})));
  }
  function inventory(){
    const slots=[...(view.loadout?.slots||[]),...(view.wearables?.slots||[])];
    // Runtime item ids ("scholars-pack") are named by the character's own inventory entries.
    const names=new Map([...(snapshot().character.inventory||[]).map(i=>[i.id,i.name]),...(view.equipment||[]).map(e=>[e.id,e.name])]);
    const band=slots.length?h('div.pco-slots',{},...slots.map(slot=>h('div.pco-slot'+(slot.itemId||slot.occupiedBy?'.is-full':''),{},
      h('small',{},slot.label),h('span',{},slot.itemId?itemName(slot.itemId,names.get(slot.itemId)):slot.occupiedBy?'双手 · '+itemName(slot.occupiedBy,names.get(slot.occupiedBy)):'—')))):null;
    const options=[...(view.loadout?.options||[]).map(o=>['loadout',o]),...(view.wearables?.options||[]).map(o=>['wear',o])].filter(([,o])=>o.available);
    const wear=view.wearables;
    return [
      group('装备栏',band,options.length?h('div.pco-actions',{},...options.map(([operation,o])=>act(ruleText(o.label)+seconds(o.seconds),{operation,key:o.key}))):null),
      group('装备与卸下',(view.equipment||[]).map(item=>row(itemName(item.id,item.name),item.available?(item.equipped?'已装备':'在背包')+seconds(item.seconds):item.reason,
        item.available?act(item.equipped?'卸下':'装备',{operation:'equip',key:item.id,value:item.equipped?0:1}):null))),
      wear?.attunementOptions?.length?group('同调 · 已用 '+wear.attunementUsed+' / '+wear.attunementLimit,
        wear.attunementOptions.map(o=>row(ruleText(o.label),o.available?'本人专注短休 1 小时':o.reason,o.available?act('确认',{operation:'attunement',key:o.key}):null))):null,
      group('套装',(view.packs||[]).map(p=>row(itemName(p.itemId,names.get(p.itemId)),p.available?p.contents.map(c=>itemName(c.id,c.name)+' ×'+c.quantity).join('、'):p.reason,
        p.available?act('取出内容',{operation:'unpack',key:p.key}):null))),
      group('物品效果',effects('inventory')),
      view.weight?h('p.pco-note',{},'负重 '+view.weight.totalPounds+' / '+(view.weight.hasCapacity?view.weight.capacityPounds:'—')+' 磅'
        +(view.weight.unknownCount?' · '+view.weight.unknownCount+' 件重量未知':'')+(view.weight.capacityNotice?' · '+view.weight.capacityNotice:'')):null];
  }
  function chooser(kind,key,count,options,selected,available,reason,submitLabel,note=''){
    const draftKey=kind+':'+key,chosen=drafts.get(draftKey)??selected,request=choiceRequest(kind,key,count,options,chosen);
    const toggle=id=>{
      const next=chosen.includes(id)?chosen.filter(v=>v!==id):count===1?[id]:chosen.length<count?[...chosen,id]:chosen;
      drafts.set(draftKey,next);open.signature='';update();
    };
    return [h('p.pco-note',{},available?(note?note+' · ':'')+'选择 '+count+' 项 · 已选 '+chosen.length:reason),
      available?h('div.pco-options',{},...options.map(o=>h('button.pco-option'+(chosen.includes(o.id)?'.is-on':''),
        {type:'button','aria-pressed':String(chosen.includes(o.id)),onclick:()=>toggle(o.id)},ruleText(o.label)))):null,
      available?h('div.pco-actions',{},act(submitLabel,request,!request||JSON.stringify(request.choices)===JSON.stringify([...selected].sort())),
        drafts.has(draftKey)?h('button.btn.btn-sm.btn-ghost',{type:'button',onclick:()=>{drafts.delete(draftKey);open.signature='';update();}},'恢复已生效的选择'):null):null];
  }
  function spells(){
    return [...preparations(view).map(p=>group('准备法术'+(p.classId?' · '+buildName('class',p.classId):''),
        chooser('prepare',p.classId,p.count,p.options,p.selected,p.available,p.reason,'确认准备清单',p.maxChanges?'本次最多更换 '+p.maxChanges+' 个':''))),
      group('快捷施法',effects('spells'))];
  }
  function statusPanel(){return [group('可直接执行',effects('status'))];}
  function recovery(){
    return (view.restChoices||[]).map(c=>group(ruleText(c.label),chooser('rest-choice',c.key,c.count,c.options,c.selected,c.available,c.reason,'确认选择')));
  }

  // ── growth (升级与成长) ──
  // One draft bound to the campaign version it was read at; a newer version never rebases it.
  function readGrowth(){
    const s=snapshot();
    growth={view:null,error:'',draft:growthDraft.newDraft(s.character),groups:[],preview:null,previewed:'',serial:0,timer:0,version:0};
    const mine=growth;
    read('character/advancement').then(value=>{
      if(growth!==mine)return;
      mine.view=value;mine.version=value.version;
      if(value.available)schedulePreview();
    }).catch(e=>{if(growth===mine)mine.error='成长机会读取失败：'+e.message;}).finally(()=>{if(growth===mine)redraw();});
  }
  function redraw(){if(open){open.signature='';update();}}
  function editGrowth(draft,groups){
    Object.assign(growth,{draft,groups,preview:null,previewed:''});redraw();schedulePreview();
  }
  function schedulePreview(){
    const mine=growth;clearTimeout(mine.timer);
    mine.timer=setTimeout(async()=>{
      const serial=++mine.serial,sent=JSON.stringify(mine.draft);
      try{
        const value=await read('character/advancement/preview',{expectedVersion:mine.version,draft:mine.draft});
        if(growth!==mine||serial!==mine.serial||sent!==JSON.stringify(mine.draft))return;
        if(value.version!==mine.version)throw new Error('角色状态已变化，请放弃草稿后重新读取。');
        Object.assign(mine,{view:value,preview:value.preview,groups:value.preview.groups,previewed:sent,error:''});
      }catch(e){if(growth===mine&&serial===mine.serial)mine.error='预览未完成，尚未升级：'+e.message;}
      finally{if(growth===mine&&serial===mine.serial)redraw();}
    },220);
  }
  function optionLabel(group,option){
    const name=optionName(group.key,option.id);
    return name===option.id?ruleText(option.label):name;
  }
  function growthPanel(){
    const s=snapshot(),head=status()?[h('p.pco-status',{role:'status'},status())]:[];
    if(!growth)readGrowth();
    const g=growth,again=h('button.btn.btn-sm',{type:'button',onclick:()=>{clearTimeout(g.timer);growth=null;redraw();}},'放弃草稿并重新读取');
    if(!g.view)return h('div.pco',{},...head,h('p.pco-note',{},g.error||'正在读取成长机会…'),g.error?again:null);
    const v=g.view,stale=g.version!==s.version,p=g.preview,current=!!p&&g.previewed===JSON.stringify(g.draft);
    const parts=[...head,h('p.pco-note',{},'当前 '+v.level+' 级 · 经验 '+v.experience+' · 已有资格升至 '+v.maximumLevel+' 级'),
      !v.available?h('p.pco-note',{},v.reason||'暂时不能升级。'):null,
      stale?h('p.pco-note',{},'角色状态已变化，这份草稿不会自动改版。 ',again):null,
      g.error&&!stale?h('p.pco-note',{},g.error):null];
    if(v.available){
      parts.push(group('本级提升的职业',h('div.pco-options',{},...v.classes.map(c=>h('button.pco-option'+(g.draft.classId===c.id?'.is-on':''),
        {type:'button','aria-pressed':String(g.draft.classId===c.id),disabled:!c.eligible||stale,
          onclick:()=>{if(g.draft.classId!==c.id)editGrowth(growthDraft.chooseClass(g.draft,c.id),[]);}},
        buildName('class',c.id,c.name)+' · 现 '+c.level+' 级'))),
        // Ineligible classes usually share one reason (multiclass requirements); say each reason once.
        ...[...new Set(v.classes.filter(c=>!c.eligible).map(c=>c.reason))].map(reason=>h('p.pco-note',{},
          v.classes.filter(c=>!c.eligible&&c.reason===reason).map(c=>buildName('class',c.id,c.name)).join('、')+'：'+reason))));
      for(const grp of g.groups){
        const chosen=growthDraft.selectedIn(g.draft,grp);
        parts.push(group(ruleText(grp.label)+' · 选择 '+grp.count+' 项',h('div.pco-options',{},...grp.options.map(o=>h('button.pco-option'+(chosen.includes(o.id)?'.is-on':''),
          {type:'button','aria-pressed':String(chosen.includes(o.id)),disabled:stale,onclick:()=>{
            const next=growthDraft.select(g.draft,g.groups,grp,o.id);
            if(next)editGrowth(next.draft,next.groups);
          }},optionLabel(grp,o))))));
      }
      if(current){
        parts.push(p.issues.length?group('待完成',p.issues.map(i=>h('p.pco-note',{},ruleText(i.message)))):null,
          ...[...new Set(p.notices)].map(n=>h('p.pco-note',{},ruleText(n))),
          p.character?h('p.pco-note',{},'升到 '+p.toLevel+' 级后：生命上限 '+s.character.maxHitPoints+' → '+p.character.maxHitPoints):null);
      }else parts.push(h('p.pco-note',{},'正在预览…'));
      parts.push(h('div.pco-actions',{},h('button.btn.btn-primary.btn-sm',{type:'button',
        disabled:stale||!current||!p.canApply||busy(),onclick:()=>{if(!stale&&current&&p.canApply&&!busy())send('character/advancement/apply',{draft:g.draft});}},
        '确认升到 '+(p?.toLevel||v.level+1)+' 级')));
    }
    return h('div.pco',{},...parts.filter(Boolean));
  }

  return {show,update,get isOpen(){return !!open;},
    // After a command the operations are read again; choices waiting to be sent survive only a refusal.
    settled(accepted){if(accepted){drafts.clear();if(growth)clearTimeout(growth.timer);growth=null;}error='';if(open&&!loading)void readView();}};
}
