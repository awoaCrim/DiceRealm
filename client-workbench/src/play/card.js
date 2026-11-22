// The card over the map plate (visual-v3 §3, §5): roll consent and its recorded result, the action
// choice, and picking one of several own actions. It dims only the map; the story stays readable.
// Closing is never cancelling: the notice bar reopens it. Every decision goes back to main.js.
import {h} from '../dom.js';
import {dieMark} from '../story.js';
import {recordedCheckParts} from '../combat-log.js';
import {cardLines} from './combat.js';
import {actionLabel} from '../rule-labels.js';
import {detailLines,rollWhy} from './wording.js';

const signed=value=>Number.isFinite(value)?(value>=0?'+':'−')+Math.abs(value):'—';
const modes={advantage:'优势',disadvantage:'劣势'};
const phases={working:'进行中',needsAnswer:'需要回答',needsConfirmation:'等待确认',ready:'可继续',stopping:'正在停止',delegated:'已交给战斗',blocked:'受阻'};
const reduced=()=>globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const row=(label,value)=>h('div.pl-card-row',{},h('dt',{},label),h('dd',{},value));

export function createCard(host,{onRoll,onCancelRoll,onChoose,onRuling,onCancelIntent,onSelect,onAction}){
  let view=null,finish=null;
  const body=h('div.pl-card-in');
  const card=h('div.pl-card',{role:'dialog','aria-label':'待处理事项'},
    h('button.pl-card-close',{type:'button','aria-label':'关闭（不会取消）',title:'关闭不会取消，可从提示条继续',onclick:()=>hide()}),body);
  const modal=h('div.pl-modal',{hidden:true},h('div.pl-dim',{onclick:()=>hide()}),card);
  host.append(modal);

  function rollView({roll,ready,note,busy}){
    const preview=roll.preview,parts=preview?recordedCheckParts(preview):null;
    return [h('p.pl-kicker',{},'需要投掷'),h('h3.pl-card-title',{},actionLabel(roll.label)||'投掷'),
      // The server's description is written for the host; the rows below say the same for the player,
      // so its target and cost stand in only when there is no preview.
      !parts&&roll.description?h('p.pl-card-why',{},rollWhy(roll.description)):null,
      h('div.pl-die',{},dieMark(),h('span.pl-die-label',{},'d20')),
      parts&&parts.dc!=='—'?h('p.pl-card-dc',{},h('span',{},'难度'),h('b',{},parts.dc)):null,
      parts?h('dl.pl-card-rows',{},row('检定',parts.label),row('加值',signed(preview.modifier)),modes[preview.mode]?row('方式',modes[preview.mode]):null):null,
      note?h('p.pl-card-note',{},note):null,
      h('div.pl-card-actions',{},
        h('div.pl-later',{},h('p',{},'关闭不会取消这次投掷，稍后可从提示条继续。'),
          h('button.pl-card-link',{type:'button',disabled:busy,onclick:()=>onCancelRoll()},'放弃这次投掷')),
        h('button.pl-roll-btn',{type:'button',disabled:!ready||busy,onclick:()=>onRoll()},h('span',{},'投掷')))];
  }
  function resultView({check,live}){
    const parts=recordedCheckParts(check),outcome=parts.verdict==='成功'?'ok':parts.verdict==='失败'?'bad':'ink';
    const face=Number.isFinite(check.selected)?check.selected:check.rolls?.[0];
    const dieNumber=h('span.pl-die-num',{},parts.automatic?'—':String(face??'—'));
    const total=h('b',{},String(check.total??'—'));
    const stamp=h('div.pl-stamp',{'data-outcome':outcome,'aria-hidden':'true'},h('div',{},h('b',{},parts.verdict||'完成'),h('span',{},parts.dc!=='—'?'DC '+parts.dc:'')));
    const nodes=[h('p.pl-kicker',{'data-outcome':outcome},parts.verdict||'已记录'),h('h3.pl-card-title',{},parts.label),
      h('div.pl-die',{},dieMark(),dieNumber),stamp,
      parts.automatic?h('p.pl-card-why',{},'自动失败，未掷骰'):h('p.pl-eq',{},h('span',{},'骰面 '+(face??'—')),h('i',{},'+'),h('span',{},signed(check.modifier)),h('i',{},'='),total),
      h('p.pl-vs',{},parts.math+(parts.dc!=='—'?' · 对抗 DC '+parts.dc:'')),
      h('div.pl-card-actions',{},h('span.pl-skip',{},'空格 继续'),h('button.pl-continue',{type:'button',onclick:()=>hide()},'继续'))];
    if(live&&!parts.automatic&&Number.isFinite(face)&&!reduced()){
      // About a second: the die tumbles, the total counts up, the stamp falls. Any key or click skips.
      const start=performance.now();let timer=0;
      const settle=()=>{clearInterval(timer);finish=null;dieNumber.textContent=String(face);total.textContent=String(check.total);stamp.classList.add('is-on');card.classList.remove('is-rolling');};
      card.classList.add('is-rolling');total.textContent='…';
      timer=setInterval(()=>{
        const t=performance.now()-start;
        if(t<650)dieNumber.textContent=String(1+Math.floor(Math.random()*20));
        else if(t<950){dieNumber.textContent=String(face);total.textContent=String(Math.round(check.total*(t-650)/300));}
        else settle();
      },45);
      finish=settle;
    }else stamp.classList.add('is-on');
    return nodes;
  }
  // The option itself is the button; this says so (a lone option reads as the card's 确定).
  const go=count=>h('span.pl-option-go',{'aria-hidden':'true'},count>1?'选择':'确定');
  function intentView({intent,canChoose,note,busy}){
    return [h('p.pl-kicker',{},'确认行动'),h('h3.pl-card-title',{},intent.question||'要这样做吗？'),
      intent.text?h('p.pl-card-why',{},'你的行动：'+intent.text):null,
      h('div.pl-options',{},...(intent.options||[]).map(option=>{
        const reason=option.details?.unavailableReason||'',label=actionLabel(option.label);
        return h('button.pl-option',{type:'button',disabled:!canChoose||busy||!!reason,title:reason,onclick:()=>onChoose(option.id)},
          h('span.pl-option-text',{},h('b',{},label),...[...detailLines(label,option.details),...(reason?[reason]:[])].map(text=>h('span',{},text))),
          go(intent.options.length));
      })),
      note?h('p.pl-card-note',{},note):null,
      h('div.pl-card-actions',{},h('button.pl-card-link',{type:'button',disabled:busy,onclick:()=>onCancelIntent()},'放弃这次意图'),
        h('button.pl-card-link',{type:'button',disabled:!canChoose||busy,onclick:()=>onRuling()},'交给主持裁定'))];
  }
  // A combat choice with a price: the server's target, cost, reach and note; choosing one sends it.
  function actionsView({title,why,options,busy}){
    const lines=cardLines(options,why);
    return [h('p.pl-kicker',{},why?'需要你回应':'确认行动'),h('h3.pl-card-title',{},title),why?h('p.pl-card-why',{},why):null,
      lines.shared.length?h('p.pl-card-shared',{},lines.shared.join(' · ')):null,
      h('div.pl-options',{},...options.map((option,i)=>h('button.pl-option',{type:'button','aria-disabled':busy||!option.available?'true':null,
        title:option.available?lines.each[i].join('\n'):option.reason,onclick:()=>{if(!busy&&option.available)onAction(option);}},
        h('span.pl-option-text',{},h('b',{},option.label),...lines.each[i].map(text=>h('span',{},text))),go(options.length)))),
      h('div.pl-card-actions',{},h('span.pl-skip',{},'Esc 关闭'),h('button.pl-card-link',{type:'button',onclick:()=>hide()},'不做了'))];
  }
  function sessionsView({sessions}){
    return [h('p.pl-kicker',{},'本人行动'),h('h3.pl-card-title',{},'选择要查看的一条'),
      h('div.pl-options',{},...sessions.map(s=>h('button.pl-option',{type:'button',onclick:()=>onSelect(s.sessionId)},
        h('b',{},s.actionText||(s.opening?'入场开场':'行动')),h('span',{},phases[s.phase]||s.phase))))];
  }
  function draw(){
    finish?.();
    // replaceChildren would print a null as text; h() children skip it, this list must too.
    body.replaceChildren(...({roll:rollView,result:resultView,intent:intentView,actions:actionsView,sessions:sessionsView})[view.kind](view).filter(Boolean));
  }
  function show(next){view=next;modal.hidden=false;draw();}
  function hide(){finish?.();view=null;modal.hidden=true;}
  // Space: skip the roll presentation, close a result, or roll when consent is open (visual-v3 §5).
  function space(){
    if(!view)return false;
    if(finish){finish();return true;}
    if(view.kind==='result'){hide();return true;}
    if(view.kind==='roll'&&view.ready&&!view.busy){onRoll();return true;}
    return false;
  }
  return {show,hide,space,get view(){return view;}};
}
