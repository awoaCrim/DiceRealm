// The V3 main adventure stage (spec/frontend/visual-v3.md §3): left rail, the story with its input,
// and the map bleed. Built once and updated in place so typing, focus and scroll survive every poll.
import {h} from '../dom.js';

// A host turn can take from half a minute to several (provider speed varies). Past ten seconds the
// waiting line says how long it has been, so a slow answer does not look like a stuck page.
function waitClock(line){
  const clock=h('small.pl-wait');line.append(clock);
  let since=0,timer=0;
  const tick=()=>{
    const s=Math.floor((Date.now()-since)/1000);
    clock.textContent=s<10?'':'已等 '+(s<60?s+' 秒':Math.floor(s/60)+' 分 '+String(s%60).padStart(2,'0')+' 秒');
  };
  return shown=>{
    if(shown&&!since){since=Date.now();tick();timer=setInterval(tick,1000);}
    else if(!shown&&since){since=0;clearInterval(timer);clock.textContent='';}
  };
}

export function createScreen({feed,combat,onSend,onDraft,onNotice,onCharacter,onJournal,onMap,onResubmit,onQuick,onDisconnect}){
  const seal=h('i'),title=h('h1.pl-book-title'),sub=h('p.pl-book-sub');
  const partyHead=h('h2.pl-sec',{},'队伍'),party=h('ul.pl-party',{'aria-label':'队伍'});
  // The goal opens the journal; hovering or focusing it shows the quest's objectives (visual-v3 §3).
  const goalHead=h('h2.pl-sec',{},'目标'),goalTitle=h('span.pl-goal-title'),goalSub=h('span.pl-goal-sub');
  const goal=h('button.pl-goal',{type:'button',onclick:()=>onJournal(),onpointerenter:()=>showGoal(),onpointerleave:()=>hideCard(),onfocus:()=>showGoal(),onblur:()=>hideCard()},goalTitle,goalSub);
  let goalCard=null;
  const rail=h('aside.pl-rail',{},
    h('div.pl-brand',{},h('span.pl-book-seal',{'aria-hidden':'true'},seal),title),sub,h('div.pl-rule'),
    partyHead,party,goalHead,goal,h('div.pl-grow'),
    h('nav.pl-menu',{'aria-label':'入口'},
      h('button.pl-entry',{type:'button',onclick:()=>onCharacter()},h('span',{},'角色'),h('kbd',{},'C')),
      h('button.pl-entry',{type:'button',onclick:onJournal},h('span',{},'冒险手记'),h('kbd',{},'J')),
      h('button.pl-entry',{type:'button',onclick:()=>onMap()},h('span',{},'地图'),h('kbd',{},'M')),
      h('button.pl-entry',{type:'button',onclick:onDisconnect},h('span',{},'返回入口'))));

  const place=h('h2.pl-place'),state=h('span.pl-state'),situation=h('p.pl-situation');
  const thinking=h('p.pl-thinking',{hidden:true},h('i'),h('i'),h('i'),h('span',{},'主持正在构思…'));
  const othersText=h('span'),others=h('p.pl-others',{hidden:true,role:'status'},h('i'),h('i'),h('i'),othersText);
  const thinkingClock=waitClock(thinking),othersClock=waitClock(others);
  // The host's question, whole, where the story ends: the notice bar only says to answer below.
  const askText=h('span'),ask=h('p.pl-ask',{hidden:true},h('span.pl-ask-tag',{},'主持提问'),askText);
  const status=h('p.pl-status',{role:'status'});
  const noticeLabel=h('span.pl-notice-label'),noticeDot=h('span.pl-notice-dot',{'aria-hidden':'true'},'·'),noticeText=h('span.pl-notice-text');
  const noticeButton=h('button.pl-notice-btn',{type:'button',onclick:()=>onNotice()});
  const notice=h('div.pl-notice',{hidden:true},h('i.pl-notice-mark',{'aria-hidden':'true'}),noticeLabel,noticeDot,noticeText,noticeButton);
  const input=h('input.pl-input',{type:'text',maxlength:'1000',autocomplete:'off',spellcheck:'false'});
  const sendWord=h('span.pl-send-word',{},'发送');
  const send=h('button.pl-send',{type:'submit'},h('span.pl-send-in',{},sendWord,h('span.pl-send-key',{},'Enter')));
  const form=h('form.pl-compose',{onsubmit:event=>{event.preventDefault();onSend(input.value);}},
    h('label.pl-compose-col',{},h('span.pl-compose-label',{},'你的行动'),input),send);
  // Why the seat cannot act; a character the host returned can be sent back from here.
  const lifecycleText=h('p'),resubmit=h('button.btn.pl-lifecycle-act',{type:'button',hidden:true,onclick:()=>onResubmit()},'重新提交审核');
  const lifecycle=h('div.pl-lifecycle',{hidden:true},lifecycleText,resubmit);
  // Out of a fight: the recovery the server offers right now (hit dice and Arcane Recovery after a
  // short rest, standing up), each opening the usual review card. Absent otherwise.
  const quick=h('div.pl-quick',{hidden:true});let quickKey='';
  const composer=h('section.pl-composer',{},notice,combat,quick,form,lifecycle);
  input.addEventListener('input',()=>{onDraft(input.value);send.classList.toggle('is-empty',!input.value.trim());});
  input.addEventListener('focus',()=>composer.classList.add('is-focus'));
  input.addEventListener('blur',()=>composer.classList.remove('is-focus'));
  const centre=h('main.pl-centre',{},
    h('header.pl-chapter',{},h('div.pl-chapter-line',{},place,state),situation,h('div.pl-rule')),
    h('div.pl-feed-wrap',{},feed,thinking,others,ask),status,composer);

  const mapSlot=h('div.pl-plate-in');
  // M opens the map over the whole window (visual-v3 §3); M, Esc or this button puts it back.
  const mapClose=h('button.pl-map-close',{type:'button',hidden:true,onclick:()=>onMap(false)},'收起地图',h('kbd',{},'M'));
  const map=h('section.pl-map',{'aria-label':'地图'},h('div.pl-plate',{},mapSlot),mapClose);
  // One hover card for the rail (visual-v3 §5): beside the entry under the pointer or keyboard focus.
  const hovercard=h('div.pl-hovercard',{hidden:true,'aria-hidden':'true'});
  const element=h('div.pl-stage',{},rail,h('div.pl-gutter',{},h('i')),centre,h('div.pl-gutter'),map,hovercard);
  function showCard(m,entry){
    hovercard.replaceChildren(...[h('p.pl-hc-name',{},m.name,m.self?h('span.pl-m-you',{},'你'):null),
      m.card.sub?h('p.pl-hc-sub',{},m.card.sub):null,
      h('dl.pl-hc-rows',{},...m.card.rows.flatMap(([label,value])=>[h('dt',{},label),h('dd',{},value)])),
      m.tags.length?h('p.pl-tags',{},...m.tags.map(t=>h('span.pl-tag',{},t))):null,
      m.card.hint?h('p.pl-hc-hint',{},m.card.hint):null].filter(Boolean));
    placeCard(entry);
  }
  function placeCard(entry){
    hovercard.hidden=false;
    const box=entry.getBoundingClientRect();
    hovercard.style.left=Math.round(box.right+8)+'px';
    hovercard.style.top=Math.round(Math.max(8,Math.min(box.top,window.innerHeight-8-hovercard.offsetHeight)))+'px';
  }
  const hideCard=()=>{hovercard.hidden=true;};
  function showGoal(){
    const g=goalCard;if(!g)return;
    hovercard.replaceChildren(...[h('p.pl-hc-name',{},g.title),g.sub?h('p.pl-hc-sub',{},g.sub):null,
      g.summary?h('p.pl-hc-text',{},g.summary):null,
      g.objectives.length?h('ul.pl-hc-goals',{},...g.objectives.map(o=>h('li'+(o.done?'.is-done':''),{},h('i',{'aria-hidden':'true'},o.done?'✓':'○'),o.text))):null,
      h('p.pl-hc-hint',{},'点击打开冒险手记（J）：人物、地点与线索')].filter(Boolean));
    placeCard(goal);
  }

  let partyKey='';
  function drawParty(members){
    const key=JSON.stringify(members);if(key===partyKey)return;partyKey=key;
    hideCard();
    party.replaceChildren(...members.map(m=>{
      // Others show a wound word beside their class, so a full party fits the rail; only you see numbers.
      const wound=m.self?null:h('span.pl-wound',{'data-level':['完好','轻伤'].includes(m.health)?'light':['倒地','死亡','伤势未明','已离场'].includes(m.health)?'out':'hurt'},m.health);
      const entry=h('li.pl-member'+(m.self?'.is-me':'')+(m.foe?'.is-foe':'')+(m.current?'.is-current':''),
        {tabindex:'0','aria-label':m.name+(m.self?'（你）':'')+(m.current?'，正在行动':'')+' · '+(m.self?'生命 '+m.hp+'/'+m.maxHp:m.health)+
          (m.card.rows.length?'；'+m.card.rows.map(([label,value])=>label+' '+value).join('，'):''),
          onpointerenter:()=>showCard(m,entry),onpointerleave:hideCard,onfocus:()=>showCard(m,entry),onblur:hideCard},
        h('span.pl-seal',{'aria-hidden':'true'},h('i',{},m.name.slice(0,1)||'?')),
        h('div.pl-m-body',{},
          h('p.pl-m-line1',{},h('span.pl-m-name',{},m.name),m.self?h('span.pl-m-you',{},'你'):null,m.current?h('span.pl-m-now',{},'行动中'):null),
          m.detail||wound?h('p.pl-m-class',{},h('span',{},m.detail||''),wound):null,
          m.self?h('p.pl-m-line2',{},h('span.pl-hp',{'aria-hidden':'true'},hpFill(m)),h('span.pl-hp-n',{},m.hp+'/'+m.maxHp)):null,
          m.tags.length?h('p.pl-tags',{},...m.tags.map(t=>h('span.pl-tag',{},t))):null));
      return entry;
    }));
  }
  function hpFill(m){
    const fill=h('i');
    // CSSOM width is allowed by the page CSP; markup style attributes are not.
    fill.style.width=(m.maxHp>0?Math.max(0,Math.min(1,m.hp/m.maxHp))*100:0)+'%';
    if(m.maxHp>0&&m.hp*4<=m.maxHp)fill.classList.add('is-low');
    return fill;
  }
  function update(m){
    seal.textContent=m.book.title.slice(0,1);title.textContent=m.book.title;title.title=m.book.title;
    sub.textContent=m.book.sub;sub.hidden=!m.book.sub;
    place.textContent=m.chapter.place;state.textContent=m.chapter.state;state.hidden=!m.chapter.state;
    state.classList.toggle('is-fight',m.chapter.fight);situation.textContent=m.chapter.situation;situation.hidden=!m.chapter.situation;
    partyHead.textContent=m.chapter.fight?'先攻':'队伍';party.setAttribute('aria-label',m.chapter.fight?'先攻顺序':'队伍');
    drawParty(m.party);
    goalHead.hidden=goal.hidden=!m.goal;
    goalTitle.textContent=m.goal?.title||'';goalSub.textContent=m.goal?.sub||'';goalSub.hidden=!m.goal?.sub;
    goal.setAttribute('aria-label','目标：'+(m.goal?.title||'')+(m.goal?.sub?'，'+m.goal.sub:'')+'。打开冒险手记');
    goalCard=m.goal||null;if(!goalCard&&!hovercard.hidden)hideCard();
    thinking.hidden=!m.thinking;thinkingClock(!!m.thinking);
    // A teammate's action the host is on; not shown while this seat's own is.
    others.hidden=!m.others||m.thinking;othersText.textContent=m.others||'';othersClock(!others.hidden);
    ask.hidden=!m.ask;askText.textContent=m.ask||'';
    status.textContent=m.status;
    const n=m.notice;notice.hidden=!n;
    if(n){
      notice.dataset.tone=n.tone;noticeLabel.textContent=n.label;noticeText.textContent=n.text;noticeText.title=n.text;
      noticeDot.hidden=!n.text;noticeButton.textContent=n.action;noticeButton.hidden=!n.action;noticeButton.disabled=!!m.busy;
      // A way out (giving up the action) is offered quietly, never as the bar's main act.
      noticeButton.classList.toggle('is-quiet',!!n.quiet);
    }
    const c=m.composer,offers=c.closed?[]:c.quick||[],key=JSON.stringify([offers,!!m.busy]);
    if(key!==quickKey){
      quickKey=key;quick.hidden=!offers.length;
      quick.replaceChildren(h('span.pl-quick-label',{},'现在可以'),...offers.map(o=>h('button.pl-quick-act',{type:'button',
        'aria-disabled':m.busy||!o.available?'true':null,title:o.available?'':o.reason,onclick:()=>{if(!m.busy&&o.available)onQuick(o);}},o.label)));
    }
    form.hidden=!!c.closed;lifecycle.hidden=!c.closed;lifecycleText.textContent=c.closed||'';resubmit.hidden=!c.resubmit;
    input.disabled=!c.editable;input.placeholder=c.placeholder;
    send.disabled=!c.canSend;sendWord.textContent=c.word;sendWord.classList.toggle('is-long',c.word.length>2);
    send.classList.toggle('is-empty',c.needsText&&!input.value.trim());
  }
  function openMap(open){element.classList.toggle('is-map-open',open);mapClose.hidden=!open;}
  return {element,map,mapSlot,input,update,openMap,get mapOpen(){return element.classList.contains('is-map-open');}};
}
