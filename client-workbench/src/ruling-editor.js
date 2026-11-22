// ruling-editor.js — 单个待处理请求的裁定表单（主持人）。
// 常显回应与处理方式，附加说明按需展开；检定仍须玩家确认后由服务端掷骰。
// 草稿跨路由保留在内存，已确认提交后清除；未确认请求由共享传输层恢复。
import {h} from './dom.js';
import {draftKey,readDraft,writeDraft,clearDraft} from './drafts.js';
import {abilityLabels,skillLabel} from './rule-labels.js';

export const skillsByAbility={strength:['Athletics'],dexterity:['Acrobatics','Sleight of Hand','Stealth'],constitution:[],intelligence:['Arcana','History','Investigation','Nature','Religion'],wisdom:['Animal Handling','Insight','Medicine','Perception','Survival'],charisma:['Deception','Intimidation','Performance','Persuasion']};
const field=(label,input)=>{if(!input.hasAttribute('aria-label'))input.setAttribute('aria-label',label);return h('label.f',{},h('span',{},label),input);};
const choice=pairs=>h('select',{},...pairs.map(([value,text])=>h('option',{value},text)));
const plain=value=>String(value||'').replace(/[\r\n\t]/g,' ').trim();
async function guarded(ctx,operation){try{await operation();}catch(error){ctx.report(error);}}

export function rulingEditor(ctx,ruling,{isDisposed=()=>false,content=null}={}){
  const archived=!!ctx.snapshot?.archived,version=ctx.snapshot?.version;
  let saving=false,submitted=false;
  const outcomeOptions=[['narrative','直接回应，不掷骰'],['check','要求玩家投掷'],['reject','说明为什么做不到']];
  if(ruling.boardMoveId)outcomeOptions.unshift(['board_move','结算原棋盘移动（限制已解除）']);
  const outcome=choice(outcomeOptions);
  const source=h('input',{type:'text',maxLength:240,placeholder:'可选，例如剧本条件或本场约定'});
  const checkType=choice([['ability','属性 / 技能检定'],['save','豁免检定']]);
  const ability=choice(Object.entries(abilityLabels));
  const skill=choice([['','不指定技能']]);
  const dc=h('input',{type:'number',value:'',placeholder:'由情境与规则决定',min:5,max:30});
  const mode=choice([['normal','正常'],['advantage','优势'],['disadvantage','劣势']]);
  const rationale=h('textarea',{maxLength:1000,rows:3,placeholder:'告诉玩家如何处理，以及为什么'});
  const privateText=h('textarea',{maxLength:1000,rows:3,placeholder:'可选。只有行动的玩家（和你）能看到，队友收不到'});
  const key=draftKey(ctx.scope||ctx.snapshot?.id,ruling.id);
  let saved={};try{saved=JSON.parse(readDraft(key)||'{}');}catch{saved={rationale:readDraft(key)};}
  rationale.value=saved.rationale||'';privateText.value=saved.privateText||'';source.value=saved.source||'';dc.value=saved.dc||'';
  if(outcomeOptions.some(([value])=>value===saved.outcome))outcome.value=saved.outcome;
  if(Object.hasOwn(abilityLabels,saved.ability))ability.value=saved.ability;
  if(['ability','save'].includes(saved.checkType))checkType.value=saved.checkType;
  if(['normal','advantage','disadvantage'].includes(saved.mode))mode.value=saved.mode;
  function updateSkills(){skill.replaceChildren(h('option',{value:''},'不指定技能'),...skillsByAbility[ability.value].map(k=>h('option',{value:k},skillLabel(k))));}
  updateSkills();if((skillsByAbility[ability.value]||[]).includes(saved.skill))skill.value=saved.skill;ability.onchange=updateSkills;
  checkType.onchange=()=>{skill.disabled=checkType.value==='save';if(skill.disabled)skill.value='';};
  const checkBox=h('fieldset',{hidden:outcome.value!=='check'},h('legend',{},'检定条件，骰点和加值由服务端决定'),
    h('div.grid-2',{},field('检定类型',checkType),field('属性',ability),field('对应技能',skill),field('DC（5 至 30）',dc),field('掷骰方式',mode)));
  const notice=h('p.small.muted');
  function showOutcome(){
    checkBox.hidden=outcome.value!=='check';
    notice.textContent=outcome.value==='check'?'玩家确认后才掷骰；这里只设定检定条件，不自动结算伤害或剧情后果。':
      outcome.value==='board_move'?'只结算原移动位置；当前仍有移动限制时会拒绝，不修改 HP、状态或资源。':
      '发送文字回应，不改变生命、物品或剧情标记。';
    submit.textContent=outcome.value==='check'?'发送投掷要求':outcome.value==='board_move'?'确认原棋盘移动':'发送回应';
  }
  outcome.onchange=showOutcome;
  const authored=(content?.adventure?.scenes||[]).find(s=>s.id===ruling.sceneId)?.actions||[];
  const declared=authored.filter(a=>a.check&&Object.hasOwn(abilityLabels,a.check.ability));
  const guidance=declared.length?h('div.authored-guidance',{},h('p.small',{},'如果这次意图对应剧本里的行动，可采用它已写明的条件。选择不会掷骰，也不表示已产生后果。'),
    ...declared.map(a=>h('button.btn.btn-ghost',{type:'button',onclick:()=>{
      outcome.value='check';showOutcome();checkType.value='ability';ability.value=a.check.ability;updateSkills();skill.disabled=false;skill.value=a.check.skill||'';dc.value=String(a.check.dc);mode.value='normal';
      if(!source.value)source.value='本战役剧本 · '+a.label;save();
    }},'采用「'+a.label+'」的检定条件'))):null;
  function save(){if(submitted||saving||isDisposed())return;writeDraft(key,JSON.stringify({rationale:rationale.value,privateText:privateText.value,source:source.value,outcome:outcome.value,ability:ability.value,skill:skill.value,dc:dc.value,mode:mode.value,checkType:checkType.value}));}
  [rationale,privateText,source,outcome,ability,skill,dc,mode,checkType].forEach(el=>{el.addEventListener('input',save);el.addEventListener('change',save);});
  skill.disabled=checkType.value==='save';
  const submit=h('button.btn.btn-primary',{type:'submit','data-write':'true','data-disabled-base':String(archived),disabled:archived});
  const extra=h('details',{},h('summary',{},'补充说明（可选）'),
    field('裁定依据',source),h('p.small.muted',{},'未填写时记为“主持根据当前情境裁定”。'),field('仅该玩家与你可见',privateText));
  extra.open=!!(source.value||privateText.value);
  const fields=h('fieldset.ruling-fields', {disabled:archived},field('处理方式',outcome),field('给玩家的回应',rationale),checkBox,
    guidance?h('details',{},h('summary',{},'参考剧本中的检定条件'),guidance):null,extra,notice,submit);
  const form=h('form',{},fields);
  showOutcome();
  form.onsubmit=event=>{event.preventDefault();if(saving||submitted||archived||isDisposed()||ctx.hasPending?.())return;guarded(ctx,async()=>{
    if(ctx.snapshot?.version!==version)throw new Error('战役状态已更新，请重新打开这条裁定；未发送的草稿会保留。');
    const isCheck=outcome.value==='check';
    const payload={rulingId:ruling.id,outcome:outcome.value,rationale:plain(rationale.value),ruleSource:plain(source.value)||'主持根据当前情境裁定',
      ability:isCheck?ability.value:'',skill:isCheck&&checkType.value==='ability'?skill.value:'',dc:isCheck?Number(dc.value):0,
      mode:isCheck?mode.value:'normal',checkType:isCheck?checkType.value:'ability'};
    if(privateText.value.trim())payload.privateText=privateText.value.trim();
    if(!payload.rationale)throw new Error('请填写给玩家的回应。');
    if(isCheck&&(!Number.isInteger(payload.dc)||payload.dc<5||payload.dc>30))throw new Error('DC 应为 5 至 30 的整数。');
    const submittedDraft=readDraft(key);
    saving=true;fields.disabled=true;
    try{
      await ctx.submit('rulings/respond',payload);
      submitted=true;if(readDraft(key)===submittedDraft)clearDraft(key);
      if(isDisposed())return;
      submit.textContent='已发送';submit.disabled=true;submit.dataset.disabledBase='true';
      await ctx.refresh();
    }finally{saving=false;fields.disabled=submitted||archived;}
  });};
  return form;
}
