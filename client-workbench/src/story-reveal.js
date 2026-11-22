// New narration on the player page appears character by character (visual-v3 §5): the whole message
// is laid out first and the unrevealed rest is invisible, not absent, so nothing below it moves; the
// reveal pauses at punctuation; finish() shows everything at once (a click on the story, Space, a
// scroll). The feed redraws by building new nodes, so a reveal is kept by message key and the next
// node of the same message continues where the last one stopped.
import {h} from './dom.js';

const STEP=24;
const PAUSE={'。':260,'！':260,'？':260,'…':160,'，':110,'、':90,'；':140,'：':110,'」':120};

export function createReveal({onPaint=()=>{},onDone=()=>{},schedule=setTimeout,cancel=clearTimeout}={}){
  const states=new Map();let timer=null;
  // The narration's text lives in flat spans (story-dialogue.js); each keeps its own text. A label
  // ("仅你可见") is a classed span and stays as it is.
  const leaves=node=>[...(node.querySelector('.msg-c')?.querySelectorAll('span')||[])]
    .filter(el=>!el.children.length&&el.textContent&&(!el.className||el.classList.contains('story-dialogue')))
    .map(el=>({el,text:el.textContent}));
  function paint(state){
    let left=state.shown,rest=null;
    for(const {el,text} of state.leaves){
      const k=Math.max(0,Math.min(text.length,left));left-=text.length;
      if(k===text.length)el.replaceChildren(text);
      else{const hidden=h('span.reveal-rest',{'aria-hidden':'true'},text.slice(k));el.replaceChildren(text.slice(0,k),hidden);rest??=hidden;}
    }
    if(rest)onPaint(rest);
  }
  function tick(){
    timer=null;
    if(globalThis.document?.hidden){finish();return;}
    const [key,state]=states.entries().next().value||[];
    if(!state)return;
    state.shown++;paint(state);
    const total=state.leaves.reduce((n,l)=>n+l.text.length,0);
    if(state.shown>=total){states.delete(key);if(!states.size){onDone();return;}}
    const last=state.leaves.map(l=>l.text).join('')[state.shown-1];
    timer=schedule(tick,PAUSE[last]??STEP);
  }
  return {
    // A new message starts hidden behind any reveal already running.
    add(key){if(!states.has(key))states.set(key,{shown:0,leaves:[]});},
    // Bind the message's current node (a redraw makes a new one) and show it at its progress.
    attach(key,node){
      const state=states.get(key);if(!state)return;
      state.leaves=leaves(node);paint(state);
      timer??=schedule(tick,STEP);
    },
    active:()=>states.size>0,
    finish(){
      if(!states.size)return false;
      if(timer!==null){cancel(timer);timer=null;}
      for(const state of states.values()){state.shown=Infinity;paint(state);}
      states.clear();onDone();return true;
    },
    stop(){if(timer!==null){cancel(timer);timer=null;}states.clear();}
  };
}
