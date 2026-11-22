// The full level-one character builder (docs/full-character-creation.md): eight steps over the server
// catalog. Every edit is re-checked by the server; only the answer for the current input can be adopted.
import {h} from '../dom.js';
import {buildName,ruleText,ruleName,optionName,abilityName,sizeName} from '../rule-labels.js';
import * as draft from './build-draft.js';

const SCHOOLS={A:'防护',C:'咒法',D:'预言',E:'惑控',V:'塑能',I:'幻术',N:'死灵',T:'变化'};
const TRAINING={light:'轻甲',medium:'中甲',heavy:'重甲',shield:'盾牌',simple:'简易武器',martial:'军用武器',improvised:'临时武器'};
const LEADS=['职业决定生命骰、豁免与起始装备。','物种和背景各自带来能力、技能与专长。','27 点购买基础属性，再分配背景加值。',
  '每组按来源选择，已满的多选组要先取消一项。','职业与来源各自的法术；法术书里删去的法术也会取消准备。','选择起始方案、包内物品、穿戴准备，可另行购置。',
  '只有姓名必填；人物文字不改变数值，也不交给模型。','服务端核对后的角色卡。全部完成后可以采用。'];
const signed=n=>Number.isFinite(n)?(n>=0?'+':'−')+Math.abs(n):'—';
const modifier=score=>Math.floor((score-10)/2);

export function openBuilder(host,{catalog,saved,evaluate,onSave,onAdopt,onClose}){
  let build=saved?.build||draft.emptyBuild(catalog),step=saved?.step||0;
  let groups=[],evaluation=null,evaluating=false,failed='',notice='',serial=0,timer=0,closed=false,shopCategory='all',shopQuery='';
  let threeBonuses=build.backgroundBonuses.filter(v=>v===1).length===3;

  const stepNav=h('nav.bd-steps',{'aria-label':'建卡步骤'});
  const title=h('h2.bd-title'),lead=h('p.bd-lead'),content=h('div.bd-content'),issues=h('div.bd-issues');
  const main=h('main.bd-main',{},title,lead,content,issues);
  const side=h('aside.bd-side',{'aria-label':'角色摘要'});
  const status=h('p.bd-status',{role:'status'});
  const retry=h('button.btn',{type:'button',hidden:true,onclick:()=>evaluateNow()},'重试检查');
  const back=h('button.btn',{type:'button',onclick:()=>move(-1)},'上一步');
  const forward=h('button.btn.btn-primary',{type:'button',onclick:()=>step===7?adopt():move(1)});
  const element=h('div.bd',{role:'dialog','aria-modal':'true','aria-label':'建卡'},
    h('header.bd-head',{},h('h1',{},'建卡'),h('p',{},'一级角色 · 每一项都可以改，草稿随时保存'),
      h('button.btn.bd-close',{type:'button',onclick:close},'返回')),
    stepNav,main,side,h('footer.bd-foot',{},status,retry,back,forward));
  element.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
  host.append(element);

  const save=()=>onSave({build,step});
  function change(next,{redraw=true}={}){
    if(!next||closed)return;
    build=next;evaluation=null;notice='';save();
    clearTimeout(timer);timer=setTimeout(evaluateNow,220);
    if(redraw)renderMain();
    renderChrome();
  }
  const editKey=(key,fn,options)=>change(draft.edit(build,groups,key,fn),options);
  function choose(group,id){
    if(!evaluation)return;
    const next=draft.toggle(build,groups,group,id);
    if(next===null){notice='此组已选满 '+group.count+' 项，先取消一项再选。';renderChrome();return;}
    if(next!==build)change(next);
  }
  async function evaluateNow(){
    clearTimeout(timer);
    const mine=++serial,sent=build;
    evaluating=true;failed='';renderChrome();
    try{
      const value=await evaluate(sent);
      if(closed||mine!==serial||sent!==build)return;
      evaluation=value;groups=value.groups;
      if(!draft.applicable(step,groups,evaluation))step=neighbour(1)??neighbour(-1)??0;
    }catch(error){if(!closed&&mine===serial)failed=error.message;}
    finally{
      if(!closed&&mine===serial){
        evaluating=false;
        // Typing on the details page keeps its fields; only the surrounding state updates.
        if(step!==6)renderMain();
        renderChrome();
      }
    }
  }
  function neighbour(direction){
    for(let i=step+direction;i>=0&&i<8;i+=direction)if(draft.applicable(i,groups,evaluation))return i;
    return null;
  }
  function visit(index){
    if(index==null||!draft.applicable(index,groups,evaluation))return;
    step=index;save();
    if(step===2){
      // First visit: start from the class suggestion; every value stays editable.
      const suggested=draft.recommended(build,catalog);
      if(JSON.stringify(suggested)!==JSON.stringify(build)){threeBonuses=false;change(suggested,{redraw:false});}
    }
    renderMain();renderChrome();main.scrollTop=0;
  }
  const move=direction=>visit(neighbour(direction));
  function adopt(){
    if(evaluating||!evaluation?.canCreate||!evaluation.character)return;
    save();closed=true;clearTimeout(timer);element.remove();onAdopt(structuredClone(build),evaluation.character);
  }
  function close(){
    if(closed)return;
    save();closed=true;clearTimeout(timer);element.remove();onClose();
  }

  // ── pages ──
  function card(on,onclick,name,facts,note=''){
    return h('button.bd-card'+(on?'.is-on':''),{type:'button','aria-pressed':String(on),onclick},
      h('b',{},name),...facts.filter(Boolean).map(f=>h('span',{},f)),note?h('small',{},note):null);
  }
  function section(text,note=''){return h('h3.bd-sec',{},h('span',{},text),note?h('small',{},note):null);}
  function classes(){
    return [h('div.bd-cards',{},...catalog.classes.map(c=>card(c.id===build.classId,()=>{if(c.id!==build.classId)editKey('$class',b=>{b.classId=c.id;});},
      buildName('class',c.id,c.name),['生命骰 d'+c.hitDie,'豁免 '+c.saves.map(abilityName).join('、'),'技能 '+c.skillCount+' 项'+(c.spellAbility?' · 施法 '+abilityName(c.spellAbility):'')],
      c.features.map(ruleText).join('、'))))];
  }
  function origin(){
    return [section('物种',catalog.species.length+' 种'),
      h('div.bd-cards',{},...catalog.species.map(s=>card(s.id===build.speciesId,()=>{if(s.id!==build.speciesId)editKey('$species',b=>{b.speciesId=s.id;});},
        buildName('species',s.id,s.name),['速度 '+s.speed+' 尺','体型 '+s.sizes.map(sizeName).join(' / ')],s.features.map(ruleText).join('、')))),
      section('背景',catalog.backgrounds.length+' 种'),
      h('div.bd-cards',{},...catalog.backgrounds.map(b=>card(b.id===build.backgroundId,()=>{if(b.id!==build.backgroundId){threeBonuses=false;editKey('$background',x=>{x.backgroundId=b.id;});}},
        buildName('background',b.id,b.name),['属性 '+b.abilities.map(abilityName).join('、'),'技能 '+b.skills.map(id=>buildName('skill',id)).join('、'),
          b.feat?'专长 '+buildName('feat',b.feat):'',b.tools.fixed.length?'工具 '+b.tools.fixed.map(id=>buildName('equipment',id)).join('、'):''])))];
  }
  function abilities(){
    if(!build.classId)return [h('p.bd-empty',{},'先选择职业，这里会给出可修改的推荐分配。')];
    const background=catalog.backgrounds.find(b=>b.id===build.backgroundId);
    const candidates=background?background.abilities.map(id=>catalog.abilities.indexOf(id)):[];
    const spent=draft.pointSpent(build,catalog),scores=build.baseScores,bonuses=build.backgroundBonuses;
    const setBonus=(index,amount)=>editKey('$bonuses',b=>{
      if(b.backgroundBonuses.length!==6)b.backgroundBonuses=[0,0,0,0,0,0];
      const remove=b.backgroundBonuses[index]===amount;
      for(let i=0;i<6;i++)if(b.backgroundBonuses[i]===amount)b.backgroundBonuses[i]=0;
      b.backgroundBonuses[index]=remove?0:amount;
    });
    const mode=three=>{
      if(threeBonuses===three||candidates.length!==3)return;
      threeBonuses=three;
      editKey('$bonuses',b=>{b.backgroundBonuses=[0,0,0,0,0,0];if(three)for(const i of candidates)b.backgroundBonuses[i]=1;});
    };
    const tick=(on,disabled,onclick,label)=>h('button.bd-tick'+(on?'.is-on':''),{type:'button','aria-pressed':String(on),'aria-label':label,disabled,onclick});
    return [h('div.bd-ability-top',{},
        h('p.bd-points',{},'剩余点数 ',h('b',{},String(catalog.pointBudget-spent)),' / '+catalog.pointBudget),
        h('div.bd-seg',{},
          h('button'+(threeBonuses?'':'.is-on'),{type:'button',disabled:candidates.length!==3,onclick:()=>mode(false)},'+2 / +1'),
          h('button'+(threeBonuses?'.is-on':''),{type:'button',disabled:candidates.length!==3,onclick:()=>mode(true)},'三项各 +1')),
        h('button.btn.btn-sm',{type:'button',onclick:()=>{threeBonuses=false;editKey('$abilities',b=>{b.abilityMethod='point-buy';b.baseScores=[8,8,8,8,8,8];b.backgroundBonuses=[0,0,0,0,0,0];});}},'清除'),
        h('button.btn.btn-sm',{type:'button',onclick:()=>{threeBonuses=false;change(draft.recommended({...build,baseScores:[],backgroundBonuses:[]},catalog));}},'使用推荐')),
      h('table.bd-abilities',{},
        h('thead',{},h('tr',{},...['属性','基础值','花费','背景 +2','背景 +1','最终','修正'].map(t=>h('th',{},t)))),
        h('tbody',{},...catalog.abilities.map((id,i)=>{
          const base=scores[i]||0,bonus=bonuses[i]||0,candidate=candidates.includes(i);
          return h('tr',{},
            h('th',{},abilityName(id),draft.primaryAbility(build.classId)===id?h('small',{},'主属性'):null),
            h('td.bd-stepper',{},h('button',{type:'button','aria-label':abilityName(id)+' 减一',disabled:!draft.canAdjust(build,catalog,i,-1),onclick:()=>editKey('$abilities',b=>{b.baseScores[i]--;})},'−'),
              h('b',{},base?String(base):'—'),
              h('button',{type:'button','aria-label':abilityName(id)+' 加一',disabled:!draft.canAdjust(build,catalog,i,1),onclick:()=>editKey('$abilities',b=>{b.baseScores[i]++;})},'+')),
            h('td.bd-muted',{},base>=8&&base<=15?String(catalog.pointCosts[base-8]):''),
            h('td',{},candidate?tick(bonus===2,threeBonuses,()=>setBonus(i,2),abilityName(id)+' +2'):'—'),
            h('td',{},candidate?tick(bonus===1,threeBonuses,()=>threeBonuses||setBonus(i,1),abilityName(id)+' +1'):'—'),
            h('td.bd-final',{},base?String(base+bonus):'—'),
            h('td',{},base?signed(modifier(base+bonus)):'—'));
        })))];
  }
  function optionLabel(group,option){
    const name=optionName(group.key,option.id);
    return name===option.id?ruleText(option.label):name;
  }
  // A skill already granted elsewhere is marked, so the same proficiency is not taken twice.
  function knownSkills(group){
    const known=new Set(catalog.backgrounds.find(b=>b.id===build.backgroundId)?.skills||[]);
    if(group.key!=='$classSkills')build.classSkills.forEach(id=>known.add(id));
    for(const other of build.selections)if(other.key!==group.key)other.values.forEach(id=>known.add(id));
    return known;
  }
  function groupView(group){
    const chosen=draft.selected(build,group.key),known=knownSkills(group);
    return h('section.bd-group',{'data-key':group.key,'data-count':String(group.count)},
      h('h3.bd-sec',{},h('span',{},ruleText(group.label)),h('small',{},'选择 '+group.count+' 项 · 已选 '+chosen.length)),
      h('div.bd-options',{},...group.options.map(option=>{
        const on=chosen.includes(option.id),spell=catalog.spells.find(s=>s.id===option.id&&group.step==='spells');
        const skill=catalog.skills.find(s=>s.id===option.id);
        const note=spell?(spell.level?spell.level+' 环':'戏法')+(SCHOOLS[spell.school]?' · '+SCHOOLS[spell.school]:'')
          :skill?abilityName(skill.ability)+(known.has(option.id)&&!on?' · 已熟练':''):ruleText(option.description);
        return h('button.bd-option'+(on?'.is-on':'')+(skill&&known.has(option.id)&&!on?'.is-known':''),
          {type:'button','aria-pressed':String(on),disabled:!evaluation,onclick:()=>choose(group,option.id)},
          h('b',{},optionLabel(group,option)),note?h('span',{},note):null);
      })));
  }
  const groupsOf=name=>groups.filter(g=>g.step===name).map(groupView);
  function plan(source,option,chosenId){
    const on=option.id===chosenId,key=source==='class'?'$classEquipment':'$backgroundEquipment';
    return card(on,()=>{if(!on)editKey(key,b=>{if(source==='class')b.classEquipment=option.id;else b.backgroundEquipment=option.id;});},
      '方案 '+option.id,[option.items.length?option.items.map(i=>buildName('equipment',i.id)+' ×'+i.quantity).join('、'):'不领装备，自行购置','金币 '+draft.money(option.copper),
        option.choices.length?'包内另选 '+option.choices.reduce((n,c)=>n+c.count,0)+' 项':'']);
  }
  function equipment(){
    const cls=catalog.classes.find(c=>c.id===build.classId),bg=catalog.backgrounds.find(b=>b.id===build.backgroundId);
    const {items,remaining}=draft.owned(build,catalog);
    const shopList=h('div.bd-shop-list');
    function drawShop(){
      const query=shopQuery.trim().toLowerCase();
      const rows=catalog.equipment.filter(item=>item.hasPrice&&draft.inCategory(item,shopCategory)
        &&(!query||item.id.includes(query)||buildName('equipment',item.id,item.name).toLowerCase().includes(query)));
      shopList.replaceChildren(...(rows.length?rows.map(item=>{
        const quantity=build.purchases.find(p=>p.id===item.id)?.quantity||0;
        return h('div.bd-shop-row',{},h('span',{},buildName('equipment',item.id,item.name)),h('span.bd-muted',{},draft.money(item.price)),
          h('span.bd-stepper',{},
            h('button',{type:'button','aria-label':'少买一件',disabled:!quantity,onclick:()=>change(draft.purchase(build,groups,catalog,item.id,-1))},'−'),
            h('b',{},String(quantity)),
            h('button',{type:'button','aria-label':'多买一件',disabled:!(item.price<=remaining),onclick:()=>change(draft.purchase(build,groups,catalog,item.id,1))},'+')));
      }):[h('p.bd-empty',{},'没有匹配的物品，可更换分类或清空筛选。')]));
    }
    drawShop();
    const filter=h('input.bd-filter',{type:'search',placeholder:'按名称筛选',value:shopQuery,'aria-label':'按名称筛选商品'});
    filter.addEventListener('input',()=>{shopQuery=filter.value;drawShop();});
    const ownedRows=[...items].map(([id,quantity])=>{
      const item=catalog.equipment.find(e=>e.id===id),name=buildName('equipment',id,item?.name)+' ×'+quantity;
      if(!item||!draft.wearable(item))return h('p.bd-owned',{},name,h('small',{},'在背包'));
      const on=build.equipped.includes(id);
      return h('button.bd-option'+(on?'.is-on':''),{type:'button','aria-pressed':String(on),
        onclick:()=>editKey('$equipped',b=>{b.equipped=on?b.equipped.filter(v=>v!==id):[...b.equipped,id];})},h('b',{},name),h('span',{},on?'已准备':'在背包'));
    });
    return [section('职业起始装备',cls?buildName('class',cls.id,cls.name):''),
      cls?h('div.bd-cards.bd-plans',{},...cls.equipment.map(p=>plan('class',p,build.classEquipment))):h('p.bd-empty',{},'先选择职业。'),
      section('背景起始装备',bg?buildName('background',bg.id,bg.name):''),
      bg?h('div.bd-cards.bd-plans',{},...bg.equipment.map(p=>plan('background',p,build.backgroundEquipment))):h('p.bd-empty',{},'先选择背景。'),
      ...groupsOf('equipment'),
      section('穿戴准备','持有护甲不等于穿戴；未准备时按无甲计算'),
      ownedRows.length?h('div.bd-options',{},...ownedRows):h('p.bd-empty',{},'选择起始方案后，这里列出持有的物品。'),
      h('details.bd-shop',{open:build.purchases.length>0},h('summary',{},'额外购置（可选） · 可用 '+draft.money(remaining)),
        h('div.bd-shop-tools',{},h('div.bd-seg',{},...draft.SHOP.map(([id,label])=>h('button'+(shopCategory===id?'.is-on':''),{type:'button',onclick:()=>{shopCategory=id;renderMain();}},label))),filter),
        shopList)];
  }
  function details(){
    const identity=build.identity;
    const field=(key,label,required,max,multiline)=>{
      const input=h(multiline?'textarea':'input',{maxlength:String(max),'aria-label':label,...(multiline?{rows:'4'}:{type:'text'})});
      input.value=identity[key];
      input.addEventListener('input',()=>editKey('$'+key,b=>{b.identity[key]=input.value;},{redraw:false}));
      return h('label.bd-field',{},h('span',{},label,h('small',{},required?'必填':'可选')),input);
    };
    return [h('div.bd-details',{},field('name','姓名',true,40,false),field('pronouns','称谓 / 代词',false,40,false)),
      section('阵营','可选'),
      h('div.bd-align',{},...catalog.alignments.map(a=>h('button'+(identity.alignment===a.id?'.is-on':''),{type:'button','aria-pressed':String(identity.alignment===a.id),
        onclick:()=>editKey('$alignment',b=>{b.identity.alignment=a.id;})},buildName('alignment',a.id,a.label)))),
      h('div.bd-details.bd-details-three',{},field('appearance','外貌',false,1000,true),field('personality','性格',false,1000,true),field('backstory','经历',false,4000,true))];
  }
  function facts(label,text){return text?h('div.bd-fact',{},h('dt',{},label),h('dd',{},text)):null;}
  const spellNames=list=>list.map(s=>buildName('spell',s.id,s.name)).join('、');
  function review(){
    if(!evaluation)return [h('p.bd-empty',{},failed?'检查未完成，可以重试检查。':'正在检查当前输入…')];
    const list=evaluation.issues;
    // Fixed reminders shown on every build are left out; limits that change how this character plays stay.
    const notes=[...new Set(evaluation.notices)].filter(n=>!n.startsWith('仅创建一级单职业角色；')&&!n.startsWith('改变职业、物种、背景或来源分支后'));
    const c=evaluation.character,m=c?.buildMechanics;
    return [section(list.length?'待完成 '+list.length+' 项':'全部完成',list.length?'点一项直接前往':'可以采用此角色'),
      list.length?h('div.bd-fixes',{},...list.map(issue=>h('button',{type:'button',onclick:()=>visit(draft.STEPS.indexOf(issue.step))},
        h('small',{},draft.STEP_NAMES[draft.STEPS.indexOf(issue.step)]),ruleText(issue.message)))):null,
      notes.length?h('div.bd-notes',{},...notes.map(n=>h('p',{},ruleText(n)))):null,
      c?h('dl.bd-sheet',{},
        facts('角色',[c.name,buildName('species',build.speciesId),buildName('class',build.classId)+' 1 级',buildName('background',build.backgroundId)].join(' · ')),
        facts('生命值',String(c.maxHitPoints)),facts('护甲等级',String(c.armorClass)),facts('熟练加值',signed(c.proficiencyBonus)),
        m?facts('先攻',signed(m.initiativeBonus)):null,m?facts('速度',m.speed+' 尺'):null,m?facts('被动察觉',String(m.passivePerception)):null,
        facts('属性',(c.abilities||[]).map(a=>abilityName(a.name)+' '+a.score+'（'+signed(a.modifier)+'）').join('　')),
        m?facts('豁免',m.savingThrows.map(s=>abilityName(s.ability)+' '+signed(s.modifier)+(s.proficient?' ★':'')).join('　')):null,
        m?facts('技能',m.skills.map(s=>ruleName(s.name)+' '+signed(s.modifier)+(s.expertise?' ★★':s.proficient?' ★':'')).join('　')):null,
        m?facts('护甲与武器',[...m.armorTraining,...m.weaponTraining].map(id=>TRAINING[id]||ruleName(id)).join('、')):null,
        m?facts('工具',m.tools.map(id=>buildName('equipment',id)).join('、')):null,
        m?facts('语言',m.languages.map(id=>buildName('language',id)).join('、')):null,
        m?facts('专长',m.feats.map(id=>buildName('feat',id)).join('、')):null,
        m?facts('抗性',m.resistances.map(ruleName).join('、')):null,
        c.spellcasting?facts('职业施法',abilityName(c.spellcasting.ability)+' · 攻击 '+signed(c.spellcasting.attackBonus)+' · 难度 '+c.spellcasting.saveDc):null,
        c.spellcasting?facts('戏法',spellNames(c.spellcasting.spells.filter(s=>!s.level))):null,
        c.spellcasting?facts('已准备法术',spellNames(c.spellcasting.spells.filter(s=>s.level&&s.prepared))):null,
        build.spellbook.length?facts('法术书',build.spellbook.map(id=>buildName('spell',id)).join('、')):null,
        m?.spellGrants?.length?facts('法术来源',m.spellGrants.map(g=>buildName('spell',g.id)+'（'+abilityName(g.ability)+(g.saveDc?' · 难度 '+g.saveDc:'')+'）').join('、')):null,
        facts('背包',(c.inventory||[]).map(i=>buildName('equipment',i.id,i.name)+' ×'+i.quantity+(i.equipped?'（穿戴）':'')).join('、'))):null];
  }

  // ── frame ──
  function renderMain(){
    title.textContent=draft.STEP_NAMES[step];lead.textContent=LEADS[step];
    const pages=[classes,origin,abilities,()=>groupsOf('choices'),()=>groupsOf('spells'),equipment,details,review];
    content.replaceChildren(...pages[step]().filter(Boolean));
  }
  function renderChrome(){
    const states=new Map((evaluation?.steps||[]).map(s=>[s.id,s]));
    stepNav.replaceChildren(...draft.STEPS.map((id,i)=>{
      const state=states.get(id),usable=draft.applicable(i,groups,evaluation);
      const mark=!evaluation||id==='review'?'':state?.complete?'完成':state?.issueCount?'待完成 '+state.issueCount:'';
      return h('button'+(i===step?'.is-on':'')+(state?.complete?'.is-done':''),{type:'button',disabled:!usable,'aria-current':i===step?'step':null,onclick:()=>visit(i)},
        h('i',{},String(i+1)),h('span',{},draft.STEP_NAMES[i]),mark?h('small',{},mark):null);
    }));
    const stepIssues=evaluation?.issues.filter(i=>i.step===draft.STEPS[step])||[];
    issues.replaceChildren(...(step===7?[]:stepIssues.map(i=>h('p',{},ruleText(i.message)))));
    status.textContent=failed?'检查未完成，没有沿用旧结果；输入已保留。'+failed
      :evaluating||!evaluation?'正在检查…':notice||(evaluation.canCreate?(step===7?'检查通过，可以采用。':'检查通过，可以在复核页采用。'):'还有 '+evaluation.issues.length+' 项待完成。');
    retry.hidden=!failed;
    back.disabled=neighbour(-1)==null;
    forward.textContent=step===7?'采用此角色':'下一步';
    forward.disabled=step===7?evaluating||!evaluation?.canCreate||!evaluation.character:neighbour(1)==null;
    renderSide();
  }
  function renderSide(){
    const c=evaluation?.character,b=build;
    const names=[b.speciesId&&buildName('species',b.speciesId),b.classId&&buildName('class',b.classId)+' 1 级',b.backgroundId&&buildName('background',b.backgroundId)].filter(Boolean);
    side.replaceChildren(...[h('h2',{},b.identity.name.trim()||'未命名角色'),h('p',{},names.join(' · ')||'尚未选择职业、物种与背景'),
      b.baseScores.length===6?h('dl.bd-side-abilities',{},...catalog.abilities.map((id,i)=>{
        const score=b.baseScores[i]+(b.backgroundBonuses[i]||0);
        return h('div',{},h('dt',{},abilityName(id)),h('dd',{},String(score),h('small',{},signed(modifier(score)))));
      })):null,
      c?h('dl.bd-side-facts',{},facts('生命值',String(c.maxHitPoints)),facts('护甲等级',String(c.armorClass)),
        c.buildMechanics?facts('速度',c.buildMechanics.speed+' 尺'):null):h('p.bd-muted',{},'全部选择有效后显示生命值与护甲等级。')].filter(Boolean));
  }

  renderMain();renderChrome();void evaluateNow();
  return {close};
}
