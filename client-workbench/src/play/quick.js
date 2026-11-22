// Creating a character to join a room, the default way in: pick a class (said as what it plays like),
// optionally a species, give a name, join. Every other choice is a starting suggestion
// (quick-build.js) the server checks like any build; 「详细调整」 opens the full builder on the same build.
import {h} from '../dom.js';
import {buildName,ruleName,ruleText,abilityName,sizeName} from '../rule-labels.js';
import {ROLES,quickBuild} from './quick-build.js';

const NAMES=['林砚','周岩','沈烛','顾青','白榆','陆沉','苏芷','温衡','秦野','叶岚','江屿','闻笙','许晚','谢灵','洛川','程翊','韩霜','唐棠','孟遥','宋迟'];

export function openQuickBuild(host,{catalog,saved,evaluate,roomNumber,onSave,onAdopt,onDetailed,onClose}){
  let build=saved?.build?.classId?saved.build:null,speciesId=build?.speciesId||'human';
  let evaluation=null,building=false,checking=false,error='',serial=0,timer=0,closed=false;

  const name=h('input',{type:'text',maxlength:'40',placeholder:'给角色起个名字','aria-label':'角色名字',autocomplete:'off'});
  name.value=build?.identity?.name||'';
  name.addEventListener('input',rename);
  const classes=h('div.bd-cards.qb-classes'),species=h('div.qb-species'),sheet=h('div.qb-sheet');
  const status=h('p.bd-status',{role:'status'});
  const detail=h('button.btn',{type:'button',onclick:()=>{if(build&&!building){finish();onDetailed(structuredClone(build));}}},'详细调整…');
  const join=h('button.btn.btn-primary',{type:'button',onclick:adopt},'加入房间');
  const leave=()=>{finish();onClose();};
  const element=h('div.qb',{role:'dialog','aria-modal':'true','aria-label':'创建角色'},
    h('header.bd-head',{},h('h1',{},'创建角色'),h('p',{},'房间 '+roomNumber),h('button.btn.bd-close',{type:'button',onclick:leave},'返回')),
    h('main.qb-main',{},
      h('h2.bd-sec',{},h('span',{},'职业'),h('small',{},'决定你在队伍里做什么；其余选项会按职业配好')),classes,
      h('h2.bd-sec',{},h('span',{},'种族'),h('small',{},'影响体型、速度和少量天赋；拿不准就用人类')),species),
    h('aside.qb-side',{'aria-label':'你的角色'},
      h('label.qb-name',{},h('span',{},'名字'),h('span.qb-name-row',{},name,h('button.btn.btn-sm',{type:'button',onclick:randomName},'随机'))),sheet),
    h('footer.bd-foot',{},status,detail,join));
  element.addEventListener('keydown',event=>{if(event.key==='Escape')leave();});
  host.append(element);

  const save=()=>onSave({build,step:0});
  function finish(){closed=true;clearTimeout(timer);element.remove();}
  function randomName(){
    const free=NAMES.filter(n=>n!==name.value);
    name.value=free[Math.floor(Math.random()*free.length)];
    rename();
  }
  // A name typed while the class is still being set up is applied when that finishes.
  function rename(){
    if(!build||building)return render();
    build={...build,identity:{...build.identity,name:name.value}};save();
    checking=true;clearTimeout(timer);timer=setTimeout(recheck,300);render();
  }
  async function pick(classId,species){
    speciesId=species;
    const mine=++serial;building=true;checking=false;error='';clearTimeout(timer);render();
    try{
      const made=await quickBuild(catalog,evaluate,{classId,speciesId,name:name.value});
      if(closed||mine!==serial)return;
      build=made.build;evaluation=made.evaluation;
    }catch(e){if(!closed&&mine===serial)error=e.message;}
    finally{if(!closed&&mine===serial){building=false;render();}}
    if(!build||closed||mine!==serial)return;
    if(build.identity.name!==name.value)rename();else save();
  }
  async function recheck(){
    const mine=++serial,sent=build;checking=true;error='';render();
    try{const value=await evaluate(sent);if(!closed&&mine===serial)evaluation=value;}
    catch(e){if(!closed&&mine===serial)error=e.message;}
    finally{if(!closed&&mine===serial){checking=false;render();}}
  }
  function adopt(){
    if(!build||building||checking||!evaluation?.canCreate)return;
    finish();onAdopt(structuredClone(build));
  }

  const facts=(label,text)=>text?h('div.bd-fact',{},h('dt',{},label),h('dd',{},text)):null;
  const names=(list,kind)=>list.map(x=>buildName(kind,x.id,x.name)).join('、');
  function summary(){
    const c=evaluation.character,m=c.buildMechanics||{};
    const top=[...(c.abilities||[])].sort((a,b)=>b.score-a.score).slice(0,2).map(a=>abilityName(a.name)+' '+a.score);
    const inventory=c.inventory||[],spells=c.spellcasting?.spells||[];
    const weapons=inventory.filter(i=>catalog.equipment.find(e=>e.id===i.id)?.weaponCategory);
    return [h('p.qb-line',{},[buildName('species',build.speciesId),buildName('class',build.classId)+' 1 级',buildName('background',build.backgroundId)+'出身'].join(' · ')),
      h('dl.qb-stats',{},...[['生命值',c.maxHitPoints],['护甲等级',c.armorClass],['速度',m.speed?m.speed+' 尺':'—']]
        .map(([label,value])=>h('div',{},h('dt',{},label),h('dd',{},String(value))))),
      h('dl.bd-sheet.qb-facts',{},
        facts('擅长',top.join('、')),facts('穿戴',names(inventory.filter(i=>i.equipped),'equipment')),facts('武器',names(weapons,'equipment')),
        facts('戏法',names(spells.filter(s=>!s.level),'spell')),facts('法术',names(spells.filter(s=>s.level&&s.prepared),'spell')),
        facts('技能',(m.skills||[]).filter(s=>s.proficient).map(s=>ruleName(s.name)).join('、'))),
      h('p.qb-note',{},'属性、技能、语言、专长和装备已按职业配好，加入后就能直接玩。想自己挑，点「详细调整」。')];
  }
  function render(){
    if(closed)return;
    classes.replaceChildren(...catalog.classes.map(c=>{
      const [role,ease]=ROLES[c.id]||['',''],on=build?.classId===c.id;
      return h('button.bd-card'+(on?'.is-on':''),{type:'button','aria-pressed':String(on),disabled:building,onclick:()=>{if(!on)void pick(c.id,speciesId);}},
        h('b',{},buildName('class',c.id,c.name)),h('span',{},role),h('small',{},ease));
    }));
    species.replaceChildren(...catalog.species.map(s=>{
      const on=speciesId===s.id;
      return h('button.qb-chip'+(on?'.is-on':''),{type:'button','aria-pressed':String(on),disabled:building,
        title:['速度 '+s.speed+' 尺','体型 '+s.sizes.map(sizeName).join(' / '),s.features.map(ruleText).join('、')].join(' · '),
        onclick:()=>{if(on)return;if(build)void pick(build.classId,s.id);else{speciesId=s.id;render();}}},buildName('species',s.id,s.name));
    }));
    sheet.replaceChildren(...(building?[h('p.bd-muted',{},'正在配好角色…')]
      :error?[h('p.pl-connect-error',{},'检查没有完成：'+error),build?h('button.btn.btn-sm',{type:'button',onclick:()=>void pick(build.classId,speciesId)},'重试'):null].filter(Boolean)
      :evaluation?.character?summary()
      :[h('p.bd-muted',{},'选一个职业，这里会出现配好的角色：生命、护甲、武器和法术。')]));
    const named=!!name.value.trim(),blocking=(evaluation?.issues||[]).filter(i=>i.step!=='details');
    status.textContent=!build?'选一个职业开始。':building?'正在配好角色…':!named?'起个名字就能加入。'
      :checking||!evaluation?'正在检查…':evaluation.canCreate?'可以加入。主持批准后就能行动。'
      :blocking.length?ruleText(blocking[0].message)+' 可以在「详细调整」里修改。':'正在检查…';
    detail.disabled=!build||building;
    join.disabled=!build||building||checking||!named||!evaluation?.canCreate;
  }

  render();
  if(build)void recheck();
  return {close:finish};
}
