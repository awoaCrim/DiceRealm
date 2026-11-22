// Brief presentation effects. No timers, gameplay state, or layout measurements.
export function createPresentationMotion(owner){
  const active=new Map();let disposed=false;
  const events=owner.ownerDocument?.addEventListener?owner.ownerDocument:owner;
  const reduced=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  function stop(){for(const finish of [...active.values()])finish();}
  events.addEventListener('pointerdown',stop,{capture:true});
  events.addEventListener('keydown',stop,{capture:true});
  reduced?.addEventListener('change',stop);
  owner.addEventListener('dispose',()=>{disposed=true;stop();events.removeEventListener('pointerdown',stop,{capture:true});events.removeEventListener('keydown',stop,{capture:true});reduced?.removeEventListener('change',stop);},{once:true});
  const play=(node,effect='arrive')=>{
    if(disposed||document.documentElement?.dataset.reduceMotion==='true'||reduced?.matches)return;
    active.get(node)?.();
    const name='presentation-'+effect;
    const finish=()=>{node.classList.remove(name);node.removeEventListener('animationend',finish);active.delete(node);};
    active.set(node,finish);node.classList.add(name);node.addEventListener('animationend',finish);
  };
  play.stop=stop;return play;
}
