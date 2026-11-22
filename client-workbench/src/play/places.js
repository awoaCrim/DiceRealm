// Known places (snapshot.map, the server's own list): where the party is, where the routes from here
// lead, and the places found but not reachable from here, each with the server's own note. Travel
// opens the server's travel choice for review, the same as a map pin. Without a published map image
// the list is the map pane's content; over an image it opens from a corner button. Never in a fight.
import {h} from '../dom.js';

const RANKS=['current','travel','visited','discovered'];

// Here first, then the places a route reaches, then the rest; within a rank, the server's order.
export function placeRows(map,travel){
  return (map?.nodes||[]).map(n=>{
    const go=n.state==='current'?null:travel.get(n.id)||null;
    const rank=n.state==='current'?'current':go?'travel':n.state==='visited'?'visited':'discovered';
    return {id:n.id,title:n.title,note:go&&!go.available?'暂不能前往：'+go.reason:n.hint||'',rank,go};
  }).sort((a,b)=>RANKS.indexOf(a.rank)-RANKS.indexOf(b.rank));
}

export function createPlaces(slot,{onTravel}){
  let rows=[],title='',busy=false,mode='none',open=false,drawn='';
  const toggle=h('button.pl-places-toggle',{type:'button',hidden:true,onclick:()=>{open=!open;draw();}});
  const panel=h('section.pl-places',{hidden:true,'aria-label':'地点'});
  // The list scrolls and takes its own clicks; the map under it neither pans nor zooms.
  for(const node of [toggle,panel])for(const type of ['pointerdown','wheel'])node.addEventListener(type,e=>e.stopPropagation(),{passive:true});
  slot.append(toggle,panel);

  // mode: 'full' fills the pane, 'overlay' sits behind the corner button, 'none' hides both.
  // Returns whether the pane shows the list in full.
  function update(map,travel,isBusy,nextMode){
    rows=placeRows(map,travel);title=map?.title||'';busy=!!isBusy;
    if(nextMode!==mode){mode=nextMode;open=false;}
    draw();
    return mode==='full'&&rows.length>0;
  }
  function draw(){
    const key=JSON.stringify([rows,title,busy,mode,open]);
    if(key===drawn)return;
    drawn=key;
    const reachable=rows.filter(r=>r.go?.available).length;
    toggle.hidden=mode!=='overlay'||!rows.length;
    toggle.setAttribute('aria-expanded',String(open));
    toggle.textContent=open?'收起地点':'地点'+(reachable?' · 可前往 '+reachable:'');
    panel.hidden=!rows.length||!(mode==='full'||mode==='overlay'&&open);
    panel.dataset.mode=mode;
    if(panel.hidden)return;
    panel.replaceChildren(
      h('header.pl-places-head',{},h('h3',{},'地点'),title?h('p',{},title):null),
      h('p.pl-places-lead',{},reachable?'沿路线可去的地点点「前往」，确认后才会出发；其他地点要先在冒险中找到去路。'
        :'从这里暂时没有可走的路线；地点会随冒险进展出现。'),
      h('ul.pl-places-list',{},...rows.map(r=>h('li.pl-loc',{'data-rank':r.rank},
        h('div',{},h('p.pl-loc-name',{},r.title),r.note?h('p.pl-loc-note',{},r.note):null),
        r.go?.available?h('button.btn.pl-loc-go',{type:'button',disabled:busy,title:busy?'正在处理其他请求':'',
          onclick:()=>{if(busy)return;if(mode==='overlay'){open=false;draw();}onTravel(r.go);}},'前往'):null))));
  }
  return {update};
}
