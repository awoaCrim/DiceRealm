// The map bleed (visual-v3 §3): the current scene's published player map at 1:1 under a faint paper
// wash. Drag pans, the wheel zooms around the pointer; no resident zoom tools. In a fight the plate
// pushes in and lays the tactical grid over the battle's frozen map (docs/maps.md); when that exact
// image is not readable the grid stands alone. Cells and targets come only from combat.js's view.
import {h} from '../dom.js';
import {createPlaces} from './places.js';

const CELL=64; // pixels per cell when the grid stands alone
const DRAG=4;  // pointer travel before a press becomes a pan instead of a click

// Only the current scene's published player edition belongs here; other places' maps are elsewhere.
export function currentSceneMap(library){
  const maps=(library?.maps||[]).filter(m=>m&&m.published&&m.edition==='player'&&m.status==='ready'&&m.currentScene);
  return library?.selectedMapId?maps.find(m=>m.id===library.selectedMapId)||null:maps[0]||null;
}
// A battle keeps the image it started on; a changed or withdrawn image is never swapped for another.
export function battleMap(library,layout){
  return (library?.maps||[]).find(m=>m&&m.id===layout.mapId&&m.published&&m.edition==='player'&&m.status==='ready'
    &&m.contentHash===layout.contentHash)||null;
}
// Pins (visual-v3 §3, §5): the map's public place, person and quest markers plus the records the
// server anchors to a place. Markers on one spot share a pin, led by the place. The server already
// drops what a player may not see; a host's seat also gets GM pins, which this page never shows.
const KINDS={scene:'地点',npc:'人物',quest:'任务',memory:'记录'};
const STATES={current:'当前所在',visited:'去过',discovered:'已知',met:'见过',known:'听说过',active:'进行中',completed:'已完成',failed:'已失败'};
export function mapPins(map){
  const spots=new Map();
  for(const m of [...(map?.markers||[]),...(map?.automaticMarkers||[])]){
    if(!m||m.visibility!=='player'||m.state==='hidden'||m.state==='unavailable')continue;
    const key=m.x.toFixed(4)+','+m.y.toFixed(4);
    if(!spots.has(key))spots.set(key,[]);
    spots.get(key).push(m);
  }
  return [...spots.values()].map(list=>{
    const lead=list.find(m=>m.kind==='scene')||list[0];
    return {x:lead.x,y:lead.y,lead,others:list.filter(m=>m!==lead)};
  });
}
// Image pixels of cell (0,0) and the cell size: the frozen layout on its own map, else a plain grid.
export function gridFrame(layout,onImage){
  const g=layout?.grid;
  return onImage&&g?.cellPixels>0?{left:g.offsetX+layout.firstColumn*g.cellPixels,top:g.offsetY+layout.firstRow*g.cellPixels,cell:g.cellPixels}
    :{left:0,top:0,cell:CELL};
}

export function createMapPane(slot,{read,onMove,onTarget,onPick,onTravel}){
  const image=h('img.pl-map-img',{alt:'',draggable:'false',hidden:true});
  const wash=h('div.pl-map-wash');
  const grid=h('div.pl-grid',{hidden:true});
  const pinLayer=h('div.pl-pins');
  const layer=h('div.pl-map-layer',{},image,wash,pinLayer,grid);
  // Known places panned out of view get a chip on the edge; the pin under the pointer, its card.
  const edges=h('div.pl-edges'),pinCard=h('div.pl-pin-card',{hidden:true,'aria-hidden':'true'});
  const empty=h('p.pl-map-empty'),note=h('p.pl-map-note',{hidden:true},'战斗底图暂不可读，只显示格位。');
  const hint=h('p.pl-map-hint',{hidden:true});
  // An area spell's reach from the centre under the pointer (or keyboard focus) while picking.
  const footprint=h('div.pl-area',{hidden:true}),tokens=new Map();
  slot.append(layer,edges,pinCard,empty,note,hint);
  // Known places as a list: the pane's content without a map image, a corner button over one.
  const places=createPlaces(slot,{onTravel:option=>{if(!travelBusy)onTravel(option);}});
  // targeting: {hint, verb, targets: unit id -> choices, foes}; picking: an area spell's centres.
  let library=null,view=null,targeting=null,picking=null,busy=false,hover=null,cell=CELL;
  let pins=[],pinKey='',travel=new Map(),travelBusy=false,known=null;
  let shown=null,loading=false,url='',scale=1,x=0,y=0,press=null,moved=false,fitted='',drawn='',framing=null,whole=false;
  // Pins keep their screen size at any zoom (--inv), and the edge chips follow every pan.
  const place=()=>{layer.style.transform=`translate(${x}px,${y}px) scale(${scale})`;layer.style.setProperty('--inv',String(1/scale));placeEdges();};
  const size=(w,hgt)=>{layer.style.width=w+'px';layer.style.height=hgt+'px';};
  const onImage=()=>!!view?.layout&&!image.hidden&&shown===view.layout.mapId+':'+view.layout.contentHash;
  // Centre a box of image pixels. A fight is pushed in to at most 1.25 and shrunk to fit; the big map
  // shows all of it, up to twice its size. Exploration ('here') stays 1:1 (visual-v3 §3) around the
  // party, the image's edges kept out of view; an image that fits at 80% or more is shown whole. The
  // view follows the plate's size until the player pans or zooms it.
  function fit(left,top,w,hgt,mode){
    framing=[left,top,w,hgt,mode];
    const box=slot.getBoundingClientRect(),room=Math.min((box.width-48)/w,(box.height-48)/hgt);
    scale=mode==='fight'?Math.max(.25,Math.min(1.25,room)):mode==='whole'?Math.max(.1,Math.min(2,room)):1;
    x=Math.round(box.width/2-(left+w/2)*scale);y=Math.round(box.height/2-(top+hgt/2)*scale);
    if(mode==='here'){
      const iw=image.naturalWidth,ih=image.naturalHeight,all=Math.min((box.width-48)/iw,(box.height-48)/ih);
      // An image only a little larger than the plate is shown whole (down to 80%), not cut by a sliver.
      if(all>=.8){scale=Math.min(1,all);x=Math.round((box.width-iw*scale)/2);y=Math.round((box.height-ih*scale)/2);}
      else{
        x=iw<=box.width?Math.round((box.width-iw)/2):Math.min(0,Math.max(Math.round(box.width-iw),x));
        y=ih<=box.height?Math.round((box.height-ih)/2):Math.min(0,Math.max(Math.round(box.height-ih),y));
      }
    }
    place();
  }
  // Exploration opens on the party's place (its pin), else the middle; the big map on the whole image.
  function frameExplore(){
    size(image.naturalWidth,image.naturalHeight);
    if(whole)return fit(0,0,image.naturalWidth,image.naturalHeight,'whole');
    const here=mapPins(currentSceneMap(library)).find(pin=>pin.lead.state==='current');
    fit(here?here.x*image.naturalWidth:image.naturalWidth/2,here?here.y*image.naturalHeight:image.naturalHeight/2,0,0,'here');
  }
  function clear(text){
    if(url)URL.revokeObjectURL(url);
    url='';image.hidden=true;image.removeAttribute('src');empty.textContent=text;empty.hidden=!text;
  }
  // A battle without a frozen layout has no place on any image: its grid stands alone.
  function wanted(){
    if(view){const map=view.layout&&battleMap(library,view.layout);return map?{map,key:view.layout.mapId+':'+view.layout.contentHash}:null;}
    const map=currentSceneMap(library);return map?{map,key:map.id+':'+map.contentHash}:null;
  }
  async function load(){
    const want=wanted(),key=want?.key||'';
    if(key===shown)return;
    shown=key;
    if(!want){clear(view?'':'这里还没有公开的地图。');drawGrid();return;}
    loading=true;
    try{
      const blob=await read('map-image',{mapId:want.map.id});
      if(shown!==key)return;
      clear('');url=URL.createObjectURL(blob);image.src=url;
      await image.decode().catch(()=>{});
      if(shown!==key)return;
      loading=false;image.hidden=false;fitted='';
      if(!view)frameExplore();
      drawGrid();drawPins();
    }catch(error){if(shown===key){shown=null;loading=false;clear(view?'':'地图暂时无法读取：'+error.message);drawGrid();drawPins();}}
  }

  // Exploration only: in a fight the grid and tokens own the map. A place the party can travel to opens
  // the server's own travel choice for review; nothing here moves anyone.
  function drawPins(){
    const map=!view&&!image.hidden?currentSceneMap(library):null;
    const list=map&&shown===map.id+':'+map.contentHash?mapPins(map):[];
    const key=JSON.stringify([list,[...travel.values()].map(o=>[o.target,o.available,o.reason]),travelBusy]);
    if(key!==pinKey){
      pinKey=key;pins=list;pinCard.hidden=true;
      pinLayer.replaceChildren(...list.map(pin=>{
        const go=pin.lead.kind==='scene'?travel.get(pin.lead.targetId)||null:null;
        const node=h('button.pl-pin',{type:'button','data-kind':pin.lead.kind,'data-state':pin.lead.state,'data-go':go?String(go.available&&!travelBusy):null,
          'aria-label':pinWords(pin,go).join('，'),onpointerenter:()=>showPin(pin,go),onpointerleave:hidePin,onfocus:()=>showPin(pin,go),onblur:hidePin,
          onclick:()=>{if(go?.available&&!travelBusy)onTravel(go);}},h('i'),pin.lead.kind==='scene'?h('span',{},pin.lead.label):null);
        node.style.left=pin.x*image.naturalWidth+'px';node.style.top=pin.y*image.naturalHeight+'px';
        return node;
      }));
    }
    placeEdges();
    const listed=places.update(known,travel,travelBusy,view||loading?'none':image.hidden?'full':'overlay');
    empty.hidden=!empty.textContent||listed;
  }
  function pinWords(pin,go){
    return [KINDS[pin.lead.kind]||'',pin.lead.label,STATES[pin.lead.state]||'',...pin.others.map(m=>(KINDS[m.kind]||'')+' '+m.label),
      go?(go.available?travelBusy?'正在处理其他请求':'点击前往（先确认）':'暂不能前往：'+go.reason):''].filter(Boolean);
  }
  function showPin(pin,go){
    const lead=pin.lead;
    pinCard.replaceChildren(...[h('p.pl-pin-kind',{},[KINDS[lead.kind],STATES[lead.state]].filter(Boolean).join(' · ')),
      h('p.pl-pin-title',{},lead.label),lead.summary?h('p.pl-pin-text',{},lead.summary):null,
      pin.others.length?h('ul.pl-pin-more',{},...pin.others.map(m=>h('li',{},h('b',{},KINDS[m.kind]||''),m.label))):null,
      go?h('p.pl-pin-go',{},go.available?travelBusy?'正在处理其他请求':'点击前往（先确认）':'暂不能前往：'+go.reason):null].filter(Boolean));
    pinCard.hidden=false;
    // Above the pin when it fits, else below its label; never over the label itself.
    const box=slot.getBoundingClientRect(),px=pin.x*image.naturalWidth*scale+x,py=pin.y*image.naturalHeight*scale+y;
    const w=pinCard.offsetWidth,hgt=pinCard.offsetHeight;
    pinCard.style.left=Math.round(Math.max(8,Math.min(px-40,box.width-8-w)))+'px';
    pinCard.style.top=Math.round(py-16-hgt>=8?py-16-hgt:Math.min(py+40,box.height-8-hgt))+'px';
  }
  const hidePin=()=>{pinCard.hidden=true;};
  function placeEdges(){
    const chips=[];
    if(!view&&!image.hidden&&pins.length){
      const box=slot.getBoundingClientRect(),mx=72,my=22;
      for(const pin of pins){
        if(pin.lead.kind!=='scene')continue;
        const px=pin.x*image.naturalWidth*scale+x,py=pin.y*image.naturalHeight*scale+y;
        // A pin whose point is on the plate is in view (its label may be clipped); only one off it gets a chip.
        if(px>=0&&px<=box.width&&py>=0&&py<=box.height)continue;
        const cx=Math.min(box.width-mx,Math.max(mx,px)),cy=Math.min(box.height-my,Math.max(my,py));
        const arrow=h('i');arrow.style.transform=`rotate(${Math.atan2(py-cy,px-cx)}rad)`;
        const chip=h('button.pl-edge',{type:'button','aria-label':'画外地点 '+pin.lead.label+'，点击移到视野中',onclick:()=>centre(pin)},arrow,h('span',{},pin.lead.label));
        chip.style.left=Math.round(cx)+'px';chip.style.top=Math.round(cy)+'px';
        chips.push(chip);
      }
    }
    edges.replaceChildren(...chips);
  }
  function centre(pin){
    const box=slot.getBoundingClientRect();
    x=Math.round(box.width/2-pin.x*image.naturalWidth*scale);y=Math.round(box.height/2-pin.y*image.naturalHeight*scale);framing=null;place();
  }

  function drawGrid(){
    const combat=view?.combat;
    grid.hidden=!combat;
    note.hidden=!combat||!view.layout||onImage()||loading;
    if(!combat){drawn='';return;}
    const framed=onImage(),f=gridFrame(view.layout,framed),w=combat.width*f.cell,hgt=combat.height*f.cell;
    if(!framed)size(w,hgt);else size(image.naturalWidth,image.naturalHeight);
    // A new battle (or its map arriving) pushes in once; afterwards the player's pan and zoom stay.
    const fitKey=combat.id+':'+framed;
    if(fitted!==fitKey){fitted=fitKey;fit(f.left,f.top,w,hgt,'fight');}
    const key=JSON.stringify([f,combat.width,combat.height,combat.cells,combat.activeActorId,
      (combat.units||[]).map(u=>[u.id,u.x,u.y,u.team,u.name,u.withdrawn,u.standard?.dead,u.standard?.zeroHitPointUnconscious]),
      [...view.moves.values()].map(m=>[m.target,m.available,m.details?.cost]),
      targeting&&[targeting.hint,[...targeting.targets].map(([id,list])=>[id,list.map(o=>o.available)])],
      view.self,busy,picking?.options.map(o=>[o.target,o.available,o.area])]);
    if(key===drawn)return;
    drawn=key;
    grid.style.left=f.left+'px';grid.style.top=f.top+'px';grid.style.width=w+'px';grid.style.height=hgt+'px';
    grid.style.backgroundSize=f.cell+'px '+f.cell+'px';grid.classList.toggle('is-bare',!framed);
    const at=(node,cx,cy)=>{node.style.left=cx*f.cell+'px';node.style.top=cy*f.cell+'px';node.style.width=node.style.height=f.cell+'px';return node;};
    const nodes=[];cell=f.cell;tokens.clear();
    for(const cell of combat.cells||[])
      if(cell.terrain&&cell.terrain!=='normal'&&cell.terrain!=='open')nodes.push(at(h('div.pl-cell',{'data-terrain':cell.terrain}),cell.x,cell.y));
    if(view.mine&&!targeting&&!picking)for(const option of view.moves.values()){
      const [cx,cy]=option.target.split(',').map(Number);
      if(!Number.isInteger(cx)||!Number.isInteger(cy))continue;
      const cost=option.details?.cost||'';
      // aria-disabled, not disabled: a closed cell still shows the server's reason on hover.
      nodes.push(at(h('button.pl-cell.is-move',{type:'button','aria-disabled':busy||!option.available?'true':null,
        title:option.available?option.label+(cost?' · '+cost:''):option.reason,'aria-label':option.label+(option.available?'':'，'+option.reason),
        onclick:()=>{if(!busy&&option.available)onMove(option);}},h('span',{},cost.replace(/移动$/,'')||'移动')),cx,cy));
    }
    const unitName=id=>{const u=(combat.units||[]).find(u=>u.id===id);return !u?'':u.name+(u.id===view.self?'（你）':u.team==='enemy'?'':'（同伴）');};
    for(const option of picking?.options||[]){
      const a=option.area,open=option.available&&!busy;
      if(!a)continue;
      const reach=option.available?'波及：'+(a.targets.map(unitName).filter(Boolean).join('、')||'无人'):option.reason;
      const show=()=>{hover=a;showArea();},leave=()=>{if(hover===a){hover=null;showArea();}};
      nodes.push(at(h('button.pl-cell.is-center',{type:'button','aria-disabled':open?null:'true',title:reach,'aria-label':'中心 '+a.x+','+a.y+'，'+reach,
        onpointerenter:show,onpointerleave:leave,onfocus:show,onblur:leave,onclick:()=>{if(open)onPick(option);}}),a.x,a.y));
    }
    nodes.push(footprint);
    // Targeting rings the units it offers; an attack also rings every other enemy with its reason.
    for(const unit of combat.units||[]){
      if(unit.withdrawn)continue;
      const options=targeting?.targets.get(unit.id)||[],open=options.some(o=>o.available);
      const aim=!!targeting&&!unit.standard?.dead&&(options.length>0||targeting.foes&&unit.team==='enemy');
      const why=open?'':options[0]?.reason||'当前不能攻击这个目标';
      const token=at(h('button.pl-token',{type:'button','data-team':unit.team,
        'data-self':String(unit.id===view.self),'data-current':String(unit.id===combat.activeActorId),'data-dead':String(!!unit.standard?.dead),
        'data-down':String(!!unit.standard?.zeroHitPointUnconscious&&!unit.standard?.dead),
        'data-aim':aim?(open?'open':'closed'):null,'aria-disabled':aim&&open&&!busy?null:'true',
        title:unit.name+(aim?' · '+(open?targeting.verb:why):''),'aria-label':unit.name+(aim?(open?'，可'+targeting.verb:'，'+why):''),
        onclick:()=>{if(aim&&open&&!busy)onTarget(unit.id,options);}},h('i',{},(unit.name||'?').slice(0,1))),unit.x,unit.y);
      token.style.fontSize=Math.round(f.cell*.36)+'px';
      nodes.push(token);tokens.set(unit.id,token);
    }
    grid.replaceChildren(...nodes);
    showArea();
  }
  function showArea(){
    const a=hover,combat=view?.combat;
    footprint.hidden=!a||!combat;
    for(const [id,token] of tokens)if(a?.targets.includes(id))token.setAttribute('data-hit','true');else token.removeAttribute('data-hit');
    if(footprint.hidden)return;
    const x0=Math.max(0,a.x-a.radius),y0=Math.max(0,a.y-a.radius),x1=Math.min(combat.width-1,a.x+a.radius),y1=Math.min(combat.height-1,a.y+a.radius);
    footprint.style.left=x0*cell+'px';footprint.style.top=y0*cell+'px';
    footprint.style.width=(x1-x0+1)*cell+'px';footprint.style.height=(y1-y0+1)*cell+'px';
  }
  // The pane changed size on purpose (the big map opened or closed): frame it afresh.
  function reframe(big){
    whole=!!big;
    if(view?.combat){fitted='';drawGrid();}
    else if(!image.hidden)frameExplore();
  }
  function setLibrary(value){library=value;void load();drawPins();}
  function setTravel(options,isBusy,map){travel=options;travelBusy=!!isBusy;known=map||null;drawPins();}
  function setCombat(next,state={}){
    view=next;targeting=state.targeting||null;picking=state.picking||null;busy=!!state.busy;
    if(!picking)hover=null;
    slot.classList.toggle('is-fight',!!view);slot.classList.toggle('is-aiming',targeting||!!picking);slot.classList.toggle('is-picking',!!picking);
    hint.hidden=!view||!targeting&&!picking;
    hint.textContent=picking?'在地图上选择「'+picking.label.replace(/（[^（]*）$/,'')+'」的中心 · Esc 取消':targeting?.hint||'';
    if(!view&&fitted){fitted='';if(!image.hidden)frameExplore();}
    if(library&&(wanted()?.key||'')!==shown)void load();
    drawGrid();drawPins();
  }

  // Pan only after the pointer has travelled, so a press on a cell or token stays a click.
  slot.addEventListener('pointerdown',event=>{
    if(event.button!==0||image.hidden&&grid.hidden)return;
    press={id:event.pointerId,startX:event.clientX,startY:event.clientY,fromX:x,fromY:y,dragging:false};moved=false;
  });
  slot.addEventListener('pointermove',event=>{
    if(press?.id!==event.pointerId)return;
    const dx=event.clientX-press.startX,dy=event.clientY-press.startY;
    if(!press.dragging&&Math.hypot(dx,dy)<DRAG)return;
    if(!press.dragging){press.dragging=true;moved=true;framing=null;slot.setPointerCapture(event.pointerId);slot.classList.add('is-dragging');}
    x=press.fromX+dx;y=press.fromY+dy;place();
  });
  const release=event=>{if(press?.id===event.pointerId){press=null;slot.classList.remove('is-dragging');}};
  slot.addEventListener('pointerup',release);slot.addEventListener('pointercancel',release);
  slot.addEventListener('click',event=>{if(moved){moved=false;event.stopPropagation();event.preventDefault();}},true);
  slot.addEventListener('wheel',event=>{
    if(image.hidden&&grid.hidden)return;
    event.preventDefault();
    const box=slot.getBoundingClientRect(),px=event.clientX-box.left,py=event.clientY-box.top;
    const next=Math.min(4,Math.max(.25,scale*Math.exp(-event.deltaY/600)));
    x=px-(px-x)*next/scale;y=py-(py-y)*next/scale;scale=next;framing=null;place();
  },{passive:false});
  new ResizeObserver(()=>{if(framing)fit(...framing);}).observe(slot);
  return {update:setLibrary,combat:setCombat,travel:setTravel,reframe,dispose:()=>clear('')};
}
